"""Hosted synthetic MPC-010 capsule regression; never accesses H4 or D:."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
import hashlib
import threading

MODULE = Path(__file__).resolve().parents[1] / "src" / "control-center" / "mpc010_stage_capsule_prototype.py"
spec = importlib.util.spec_from_file_location("mpc010_capsule_fixture", MODULE)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def members():
    data = {f"candidate/web/fixture-{i:02}.mjs": f"candidate {i}".encode() for i in range(12)}
    for i in range(4):
        b = f"existing viewer backup {i}".encode()
        data[f"backup/fixture-{i}.py"] = b
        data[f"restore-test/fixture-{i}.py"] = b
    return data


SHA = "a" * 40
PROOF = "MPC010_SYNTHETIC_CI_ONLY"


class CapsuleTests(unittest.TestCase):
    def test_source_and_sot_hold_remain_non_bypassable(self):
        self.assertRaises(fixture.CapsuleRejected, fixture.stage_for_production)
        stage = (MODULE.parents[2] / ".github" / "scripts" / "mpc010-h4-viewer-stage-only.ps1").read_text(encoding="utf8")
        sot = (MODULE.parents[2] / "SOURCE_OF_TRUTH.md").read_text(encoding="utf8")
        self.assertIn("MPC010_STAGE_NAMESPACE_SEAL_NOT_QUALIFIED", stage)
        self.assertIn("H4 field STAGE = DENIED; APPLY = DENIED; release = DENIED", sot)

    def test_exact_member_set_and_hash_revalidated(self):
        with tempfile.TemporaryDirectory(prefix="mpc010-synthetic-") as d:
            path, digest = fixture.build_synthetic_capsule(Path(d), members(), commit_sha=SHA, proof=PROOF)
            self.assertTrue(fixture.inspect_synthetic_capsule(path, digest, members(), SHA))
            with zipfile.ZipFile(path) as z:
                self.assertEqual(len(z.namelist()), 21)
                self.assertNotIn("candidate/extra.py", z.namelist())
            with path.open("r+b") as f:
                f.seek(9)
                f.write(b"changed")
            with self.assertRaisesRegex(fixture.CapsuleRejected, "CHANGED_AFTER_RELEASE"):
                fixture.inspect_synthetic_capsule(path, digest, members(), SHA)

    def test_untracked_sibling_does_not_enter_package(self):
        with tempfile.TemporaryDirectory(prefix="mpc010-synthetic-") as d:
            def attacker(path):
                fake = Path(d) / "candidate" / "extra.py"
                fake.parent.mkdir()
                fake.write_text("unreviewed", encoding="utf8")
            path, digest = fixture.build_synthetic_capsule(Path(d), members(), commit_sha=SHA, proof=PROOF, while_locked=attacker)
            self.assertTrue(fixture.inspect_synthetic_capsule(path, digest, members(), SHA))
            self.assertNotIn("candidate/extra.py", zipfile.ZipFile(path).namelist())

    def test_rejects_missing_extra_and_bad_proof(self):
        with tempfile.TemporaryDirectory(prefix="mpc010-synthetic-") as d:
            with self.assertRaises(fixture.CapsuleRejected):
                fixture.build_synthetic_capsule(Path(d), members(), commit_sha=SHA, proof="NOT_APPROVED")
            forged = members()
            forged["candidate/extra.py"] = b"extra"
            with self.assertRaises(fixture.CapsuleRejected):
                fixture.build_synthetic_capsule(Path(d), forged, commit_sha=SHA, proof=PROOF)
            unsafe = members()
            key = sorted(unsafe)[0]
            unsafe["candidate/../escape"] = unsafe.pop(key)
            with self.assertRaises(fixture.CapsuleRejected):
                fixture.build_synthetic_capsule(Path(d), unsafe, commit_sha=SHA, proof=PROOF)

    @unittest.skipUnless(sys.platform == "win32", "Windows sharing semantics require Windows")
    def test_windows_concurrent_write_and_replace_denied_while_capsule_locked(self):
        with tempfile.TemporaryDirectory(prefix="mpc010-synthetic-") as d:
            attempts = []
            def attack(path):
                replacement = Path(d) / "fake-replacement.zip"
                replacement.write_bytes(b"FAKE")
                def concurrent_writer():
                    for _ in range(12):
                        try:
                            with open(path, "ab") as f:
                                f.write(b"INJECTED")
                            attempts.append("APPEND_SUCCEEDED")
                        except OSError:
                            attempts.append("APPEND_DENIED")
                        try:
                            os.replace(replacement, path)
                            attempts.append("REPLACE_SUCCEEDED")
                        except OSError:
                            attempts.append("REPLACE_DENIED")
                th = threading.Thread(target=concurrent_writer, daemon=True)
                th.start()
                th.join(timeout=6)
                self.assertFalse(th.is_alive(), "concurrent writer must terminate")
            path, digest = fixture.build_synthetic_capsule(Path(d), members(), commit_sha=SHA, proof=PROOF, while_locked=attack)
            self.assertIn("APPEND_DENIED", attempts)
            self.assertIn("REPLACE_DENIED", attempts)
            self.assertNotIn("APPEND_SUCCEEDED", attempts)
            self.assertNotIn("REPLACE_SUCCEEDED", attempts)
            self.assertTrue(fixture.inspect_synthetic_capsule(path, digest, members(), SHA))


if __name__ == "__main__":
    unittest.main()
