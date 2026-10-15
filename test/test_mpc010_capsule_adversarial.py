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


    def test_rejects_nested_temp_parents_before_archive_creation(self):
        # Models an attacker-controlled intermediate parent under %TEMP%.
        with tempfile.TemporaryDirectory(prefix="mpc010-synthetic-") as outer:
            nested = Path(outer) / "attacker" / "mpc010-synthetic-inner"
            nested.mkdir(parents=True)
            with self.assertRaisesRegex(fixture.CapsuleRejected, "DIRECT_TEMP_CHILD_REQUIRED"):
                fixture.build_synthetic_capsule(nested, members(), commit_sha=SHA, proof=PROOF)
            self.assertFalse((nested / "capsule-synthetic.zip").exists())

    def test_rejects_root_symlink_before_archive_creation(self):
        with tempfile.TemporaryDirectory(prefix="mpc010-synthetic-") as actual:
            alias = Path(actual).with_name(Path(actual).name + "-alias")
            try:
                alias.symlink_to(actual, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symlink privilege unavailable on this host")
            try:
                with self.assertRaisesRegex(fixture.CapsuleRejected, "ROOT_LINK_DENIED"):
                    fixture.build_synthetic_capsule(alias, members(), commit_sha=SHA, proof=PROOF)
            finally:
                alias.unlink()

    @unittest.skipUnless(sys.platform == "win32", "Windows NTFS junction test only")
    def test_windows_real_junction_root_rejected(self):
        import subprocess
        with tempfile.TemporaryDirectory(prefix="mpc010-synthetic-") as actual:
            alias = Path(actual).with_name("mpc010-synthetic-junction-" + Path(actual).name)
            run = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(alias), str(actual)],
                                 capture_output=True, text=True, timeout=15)
            if run.returncode:
                self.skipTest("NTFS junction creation unavailable on this runner")
            try:
                self.assertTrue(alias.is_junction(), "fixture must be an actual NTFS junction")
                with self.assertRaisesRegex(fixture.CapsuleRejected, "ROOT_LINK_DENIED"):
                    fixture.build_synthetic_capsule(alias, members(), commit_sha=SHA, proof=PROOF)
                self.assertFalse((Path(actual) / "capsule-synthetic.zip").exists())
            finally:
                alias.rmdir()

    @unittest.skipUnless(sys.platform == "win32", "Windows relative handle path test only")
    def test_windows_leaf_junction_swap_before_open_rejected(self):
        import subprocess
        with tempfile.TemporaryDirectory(prefix="mpc010-synthetic-") as actual:
            with tempfile.TemporaryDirectory(prefix="mpc010-synthetic-") as victim:
                # An attacker already replaced the expected leaf with a junction.
                alias = Path(actual).with_name("mpc010-synthetic-substitute-" + Path(actual).name)
                run = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(alias), str(victim)],
                                     capture_output=True, text=True, timeout=15)
                if run.returncode:
                    self.skipTest("NTFS junction creation unavailable")
                try:
                    with self.assertRaises(fixture.CapsuleRejected):
                        fixture.build_synthetic_capsule(alias, members(), commit_sha=SHA, proof=PROOF)
                    self.assertFalse((Path(victim) / "capsule-synthetic.zip").exists())
                finally:
                    alias.rmdir()

    @unittest.skipUnless(sys.platform == "win32", "Windows volume-anchored test only")
    def test_windows_held_ancestor_rejects_concurrent_rename(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory(prefix="mpc010-synthetic-") as outer:
            mutable = Path(outer) / "mutable-ancestor"
            scoped_temp = mutable / "temp-scope"
            scoped_temp.mkdir(parents=True)
            scoped_root = scoped_temp / "mpc010-synthetic-held"
            scoped_root.mkdir()
            attempts = []
            def try_swap(_capsule):
                try:
                    os.rename(mutable, Path(outer) / "moved-ancestor")
                    attempts.append("ANCESTOR_RENAMED")
                except OSError:
                    attempts.append("ANCESTOR_RENAME_DENIED")
            # Only a CI-owned temporary directory; no real OS TEMP change.
            with patch.object(tempfile, "tempdir", str(scoped_temp)):
                path, digest = fixture.build_synthetic_capsule(
                    scoped_root, members(), commit_sha=SHA, proof=PROOF,
                    while_locked=try_swap)
            self.assertEqual(attempts, ["ANCESTOR_RENAME_DENIED"])
            self.assertTrue(fixture.inspect_synthetic_capsule(path, digest, members(), SHA))

    @unittest.skipUnless(sys.platform == "win32", "Windows NTFS ancestor junction only")
    def test_windows_existing_temp_ancestor_junction_is_refused(self):
        from unittest.mock import patch
        import subprocess
        with tempfile.TemporaryDirectory(prefix="mpc010-synthetic-") as outer:
            real = Path(outer) / "real"
            (real / "temp-scope" / "mpc010-synthetic-target").mkdir(parents=True)
            alias = Path(outer) / "attacker"
            proc = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J",
                                   str(alias), str(real)], capture_output=True,
                                  text=True, timeout=15)
            if proc.returncode:
                self.skipTest("NTFS junction creation unavailable")
            try:
                supplied = alias / "temp-scope" / "mpc010-synthetic-target"
                with patch.object(tempfile, "tempdir", str(alias / "temp-scope")):
                    with self.assertRaises(fixture.CapsuleRejected):
                        fixture.build_synthetic_capsule(
                            supplied, members(), commit_sha=SHA, proof=PROOF)
                self.assertFalse(
                    (real / "temp-scope" / "mpc010-synthetic-target" /
                     "capsule-synthetic.zip").exists())
            finally:
                alias.rmdir()

    def test_volume_anchor_rejects_remote_unknown_and_removable_drives(self):
        for drive_type in (0, 1, 2, 4, 5, 6):
            with self.subTest(drive_type=drive_type):
                with self.assertRaisesRegex(fixture.CapsuleRejected, "UNTRUSTED_DRIVE_TYPE"):
                    fixture._require_local_fixed_drive("Z:\\", lambda _anchor: drive_type)
        self.assertRaisesRegex(fixture.CapsuleRejected, "LOCAL_VOLUME_ROOT_REQUIRED",
                               fixture._require_local_fixed_drive,
                               "\\\\\\\\server\\\\share\\\\", lambda _: 3)
        seen = []
        fixture._require_local_fixed_drive("C:\\", lambda anchor: seen.append(anchor) or 3)
        self.assertEqual(seen, ["C:\\"])

    @unittest.skipUnless(sys.platform == "win32", "Windows native GetDriveTypeW")
    def test_windows_actual_temp_drive_must_be_fixed(self):
        import ctypes
        import ctypes.wintypes as wt
        get_drive_type = ctypes.WinDLL("kernel32", use_last_error=True).GetDriveTypeW
        get_drive_type.argtypes = [wt.LPCWSTR]
        get_drive_type.restype = wt.UINT
        root = Path(tempfile.gettempdir()).absolute().anchor
        self.assertEqual(get_drive_type(root), 3)
        fixture._require_local_fixed_drive(root, get_drive_type)

    def test_rejects_backup_restore_mismatch_and_missing_suffix(self):
        wrong_content = members()
        wrong_content["restore-test/fixture-1.py"] = b"incorrect restore"
        with tempfile.TemporaryDirectory(prefix="mpc010-synthetic-") as d:
            with self.assertRaisesRegex(fixture.CapsuleRejected, "RESTORE_MUST_EQUAL_BACKUP"):
                fixture.build_synthetic_capsule(Path(d), wrong_content, commit_sha=SHA, proof=PROOF)
            wrong_name = members()
            wrong_name["restore-test/wrong-name.py"] = wrong_name.pop("restore-test/fixture-1.py")
            with self.assertRaisesRegex(fixture.CapsuleRejected, "RESTORE_MUST_EQUAL_BACKUP"):
                fixture.build_synthetic_capsule(Path(d), wrong_name, commit_sha=SHA, proof=PROOF)

    def test_consumer_rejects_sparse_oversize_without_unbounded_read(self):
        with tempfile.TemporaryDirectory(prefix="mpc010-synthetic-") as d:
            path, digest = fixture.build_synthetic_capsule(Path(d), members(), commit_sha=SHA, proof=PROOF)
            with open(path, "wb") as f:
                f.seek(fixture.MAX_CAPSULE_BYTES)
                f.write(b"X")
            with self.assertRaisesRegex(fixture.CapsuleRejected, "CONSUMER_CAPSULE_TOO_LARGE"):
                fixture.inspect_synthetic_capsule(path, digest, members(), SHA)

    @unittest.skipUnless(sys.platform == "win32", "Windows-only root handle protection")
    def test_windows_root_rename_denied_through_success_boundary(self):
        with tempfile.TemporaryDirectory(prefix="mpc010-synthetic-") as d:
            attempts = []
            def concurrent_root_rename(_path):
                renamed = Path(d).with_name(Path(d).name + "-moved")
                try:
                    os.rename(d, renamed)
                    attempts.append("ROOT_RENAME_SUCCEEDED")
                except OSError:
                    attempts.append("ROOT_RENAME_DENIED")
            path, digest = fixture.build_synthetic_capsule(Path(d), members(), commit_sha=SHA, proof=PROOF,
                                                             while_locked=concurrent_root_rename)
            self.assertEqual(attempts, ["ROOT_RENAME_DENIED"])
            self.assertTrue(fixture.inspect_synthetic_capsule(path, digest, members(), SHA))

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
