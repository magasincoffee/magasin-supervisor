"""Source/QA-only 12-real-source capsule verification. NEVER access H4."""
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import patch
from zipfile import ZipFile, ZipInfo, ZIP_STORED
import struct
import zlib
import importlib.util

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src" / "control-center" / "mpc010_release_capsule.py"
SPEC = importlib.util.spec_from_file_location("mpc010_release_capsule", SRC)
mod = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = mod
SPEC.loader.exec_module(mod)
SHA = "a" * 40


def sha(blob):
    return hashlib.sha256(blob).hexdigest().upper()


def fixture():
    reviewed = (REPO / "src/control-center/mpc010_control_center_preflight.mjs").read_text(
        encoding="utf-8")
    block = re.search(r"REVIEWED_CANDIDATE_SHA256_20261014\s*=\s*Object\.freeze\(\{(.*?)\}\)",
                      reviewed, re.S)
    assert block, "Reviewed pin map is missing"
    pins = dict(re.findall(r'"([^"]+)"\s*:\s*"([A-F0-9]{64})"', block.group(1)))
    assert set(pins) == set(mod.SOURCES), "Source pin set changed"
    sources = {name: (REPO / name).read_bytes().replace(b"\r\n", b"\n") for name in pins}
    assert all(sha(sources[n]) == h for n, h in pins.items()), "Canonical pin drift"
    # Fake old files exercise backup/restore only. These bytes are NOT H4 backups.
    old = {name: ("SYNTHETIC_OLD_" + name).encode() for name in mod.OLD}
    old_pins = {name: sha(v) for name, v in old.items()}
    return sources, pins, old, old_pins


def build():
    sources, pins, old, old_pins = fixture()
    z = mod.build_source_capsule(reviewed_main_sha=SHA, sources=sources,
                                 reviewed_source_pins=pins, existing_viewer=old,
                                 reviewed_old_pins=old_pins)
    return z, sources, pins, old, old_pins


class ReleaseCapsuleTests(unittest.TestCase):
    def test_real_twelve_sources_and_backup_restore_rehearsal_in_memory(self):
        z, source, pins, old, oldpins = build()
        self.assertTrue(mod.verify_source_capsule(
            z.data, z.sha256, reviewed_main_sha=SHA,
            reviewed_source_pins=pins, reviewed_old_pins=oldpins))
        with ZipFile(BytesIO(z.data), "r") as archive:
            self.assertEqual(len(archive.namelist()), 21)
            for rel in mod.OLD:
                self.assertEqual(archive.read("backup/" + rel), old[rel])
                self.assertEqual(archive.read("restore-test/" + rel), old[rel])
            self.assertFalse(json.loads(archive.read("metadata/receipt.json"))
                             ["field_apply_authorized"])
        self.assertRaises(mod.ReleaseCapsuleRejected, mod.stage_or_apply)

    def test_missing_extra_and_modified_sources_fail(self):
        source, pins, old, oldpins = fixture()
        extra = dict(source)
        extra["src/unreviewed.py"] = b"unreviewed"
        with self.assertRaisesRegex(mod.ReleaseCapsuleRejected, "EXACT_FILE_SET"):
            mod.build_source_capsule(reviewed_main_sha=SHA, sources=extra,
                reviewed_source_pins=pins, existing_viewer=old,
                reviewed_old_pins=oldpins)
        missing = dict(source)
        missing.pop(next(iter(missing)))
        with self.assertRaisesRegex(mod.ReleaseCapsuleRejected, "EXACT_FILE_SET"):
            mod.build_source_capsule(reviewed_main_sha=SHA, sources=missing,
                reviewed_source_pins=pins, existing_viewer=old,
                reviewed_old_pins=oldpins)
        wrong = dict(source)
        wrong[next(iter(wrong))] += b"modified"
        with self.assertRaisesRegex(mod.ReleaseCapsuleRejected, "SHA_PIN_MISMATCH"):
            mod.build_source_capsule(reviewed_main_sha=SHA, sources=wrong,
                reviewed_source_pins=pins, existing_viewer=old,
                reviewed_old_pins=oldpins)

    def test_modified_old_file_and_pin_mismatch_fail(self):
        sources, pins, old, oldpins = fixture()
        wrong = dict(old)
        wrong["server.py"] += b"tamper"
        with self.assertRaisesRegex(mod.ReleaseCapsuleRejected, "SHA_PIN_MISMATCH"):
            mod.build_source_capsule(reviewed_main_sha=SHA, sources=sources,
                reviewed_source_pins=pins, existing_viewer=wrong,
                reviewed_old_pins=oldpins)
        with self.assertRaisesRegex(mod.ReleaseCapsuleRejected, "PINNED_MAIN"):
            mod.build_source_capsule(reviewed_main_sha="BAD", sources=sources,
                reviewed_source_pins=pins, existing_viewer=old,
                reviewed_old_pins=oldpins)

    def test_consumer_rejects_replacement_and_missing_independent_pins(self):
        z, source, pins, old, oldpins = build()
        with self.assertRaisesRegex(mod.ReleaseCapsuleRejected, "CAPSULE_DIGEST"):
            mod.verify_source_capsule(z.data + b"X", z.sha256,
                reviewed_main_sha=SHA, reviewed_source_pins=pins,
                reviewed_old_pins=oldpins)
        altered = dict(pins)
        altered.pop(next(iter(altered)))
        with self.assertRaisesRegex(mod.ReleaseCapsuleRejected, "PIN_SET_INCOMPLETE"):
            mod.verify_source_capsule(z.data, z.sha256,
                reviewed_main_sha=SHA, reviewed_source_pins=altered,
                reviewed_old_pins=oldpins)

    def test_extra_member_fails_even_with_recomputed_external_digest(self):
        z, _, pins, _, oldpins = build()
        stream = BytesIO()
        with ZipFile(BytesIO(z.data), "r") as original, ZipFile(stream, "w", compression=ZIP_STORED) as forged:
            for item in original.infolist():
                forged.writestr(item, original.read(item.filename))
            forged.writestr("candidate/extra.py", b"unreviewed")
        raw = stream.getvalue()
        with self.assertRaisesRegex(mod.ReleaseCapsuleRejected, "CENTRAL_DIRECTORY|UNREVIEWED_OR_MISSING"):
            mod.verify_source_capsule(raw, sha(raw),
                reviewed_main_sha=SHA, reviewed_source_pins=pins,
                reviewed_old_pins=oldpins)

    def test_zip_unicode_path_alias_refused_even_with_recomputed_digest(self):
        capsule, _, pins, _, oldpins = build()
        target = "candidate/server.py"
        output = BytesIO()
        with ZipFile(BytesIO(capsule.data), "r") as original, ZipFile(output, "w") as forged:
            for item in original.infolist():
                raw = original.read(item.filename)
                clone = ZipInfo(item.filename, date_time=(1980, 1, 1, 0, 0, 0))
                clone.compress_type = ZIP_STORED
                clone.create_system = 3
                clone.external_attr = 0o100600 << 16
                if item.filename == target:
                    # Info-ZIP Unicode Path alias, linked to original bytes
                    # by CRC. Other ZIP readers can interpret this differently.
                    source_name = item.filename.encode("utf-8")
                    unicode_path = b"../../pwn.py"
                    payload = (b"\x01" + struct.pack("<I", zlib.crc32(source_name))
                               + unicode_path)
                    clone.extra = struct.pack("<HH", 0x7075, len(payload)) + payload
                forged.writestr(clone, raw)
        altered = output.getvalue()
        with self.assertRaisesRegex(
                mod.ReleaseCapsuleRejected, "INVALID_EOCD|NONCANONICAL_ZIP_METADATA"):
            mod.verify_source_capsule(altered, sha(altered),
                reviewed_main_sha=SHA, reviewed_source_pins=pins,
                reviewed_old_pins=oldpins)

    def test_zip_comment_and_local_central_name_disagreement_refused(self):
        capsule, _, pins, _, oldpins = build()
        output = BytesIO()
        with ZipFile(BytesIO(capsule.data), "r") as original, ZipFile(output, "w") as forged:
            forged.comment = b"unreviewed-comment"
            for item in original.infolist():
                forged.writestr(item, original.read(item.filename))
        altered = output.getvalue()
        with self.assertRaisesRegex(mod.ReleaseCapsuleRejected, "INVALID_EOCD|NONCANONICAL_ZIP_METADATA"):
            mod.verify_source_capsule(altered, sha(altered),
                reviewed_main_sha=SHA, reviewed_source_pins=pins,
                reviewed_old_pins=oldpins)
        # Same-length alteration of the raw LOCAL filename only. Central
        # directory remains unchanged and digest is recomputed by adversary.
        raw = bytearray(capsule.data)
        self.assertEqual(raw[:4], b"PK\x03\x04")
        filename_len = struct.unpack_from("<H", raw, 26)[0]
        self.assertGreater(filename_len, 0)
        raw[30] = ord("X") if raw[30] != ord("X") else ord("Y")
        with self.assertRaises(mod.ReleaseCapsuleRejected):
            mod.verify_source_capsule(bytes(raw), sha(raw),
                reviewed_main_sha=SHA, reviewed_source_pins=pins,
                reviewed_old_pins=oldpins)

    def test_eocd_preflight_rejects_massive_directory_before_zip_open(self):
        z, _, pins, _, oldpins = build()
        # The same trusted payload, but attacker-modified EOCD counts or
        # directory size with an independently recomputed outer SHA.
        cases = []
        huge_count = bytearray(z.data)
        struct.pack_into("<H", huge_count, len(huge_count) - 22 + 10, 65000)
        cases.append(bytes(huge_count))
        huge_directory = bytearray(z.data)
        struct.pack_into("<I", huge_directory, len(huge_directory) - 22 + 12,
                         16 * 1024 + 1)
        cases.append(bytes(huge_directory))
        trailing_comment = z.data + b"EXTRA_BYTES"
        cases.append(trailing_comment)
        forged_zip64 = bytearray(z.data)
        forged_zip64[-42:-38] = b"PK\x06\x07"
        cases.append(bytes(forged_zip64))
        for hostile in cases:
            with self.subTest(size=len(hostile)):
                # Guard that ZipFile is never even instantiated for these cases.
                with patch.object(mod, "ZipFile", side_effect=AssertionError(
                        "UNBOUNDED_ZIP_OPEN")):
                    with self.assertRaisesRegex(
                            mod.ReleaseCapsuleRejected, "EOCD|CENTRAL_DIRECTORY|ZIP64"):
                        mod.verify_source_capsule(
                            hostile, sha(hostile), reviewed_main_sha=SHA,
                            reviewed_source_pins=pins, reviewed_old_pins=oldpins)

    def test_oversized_sparse_or_invalid_archive_refused(self):
        _, _, pins, _, oldpins = build()
        with self.assertRaisesRegex(mod.ReleaseCapsuleRejected, "CAPSULE_SIZE"):
            mod.verify_source_capsule(b"\0" * (mod.MAX_ARCHIVE_SIZE + 1),
                "A"*64, reviewed_main_sha=SHA,
                reviewed_source_pins=pins, reviewed_old_pins=oldpins)
        with self.assertRaisesRegex(mod.ReleaseCapsuleRejected, "INVALID_EOCD|INVALID_ZIP"):
            mod.verify_source_capsule(b"bad zip", sha(b"bad zip"),
                reviewed_main_sha=SHA, reviewed_source_pins=pins,
                reviewed_old_pins=oldpins)

    def test_field_release_has_no_cli_and_security_hold_is_canonical(self):
        stage = (REPO / ".github/scripts/mpc010-h4-viewer-stage-only.ps1").read_text(encoding="utf8")
        sot = (REPO / "SOURCE_OF_TRUTH.md").read_text(encoding="utf8")
        self.assertIn("MPC010_STAGE_NAMESPACE_SEAL_NOT_QUALIFIED", stage)
        self.assertIn("H4 field STAGE = DENIED; APPLY = DENIED; release = DENIED", sot)
        self.assertIn("MPC010_FIELD_STAGE_APPLY_NOT_AUTHORIZED", SRC.read_text(encoding="utf8"))


if __name__ == "__main__":
    unittest.main()
