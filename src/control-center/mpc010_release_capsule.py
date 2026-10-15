"""MPC-010 reviewed-asset capsule contract. SOURCE/QA only; NO H4 Stage/Apply.

This module packages already supplied, independently pinned 12 source bytes and
four old-file bytes into a single immutable-by-digest archive. It DOES NOT read
live H4 files, fetch GitHub, extract archives, mutate a viewer or obtain field
authorization. Future field consumers need a separately reviewed release lane.
"""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from io import BytesIO
import json
import re
import struct
from typing import Mapping
from zipfile import BadZipFile, ZipFile, ZipInfo, ZIP_STORED

SCHEMA = "MPC010_REVIEWED_SOURCE_CAPSULE_V1"
MAX_ENTRY_SIZE = 4 * 1024 * 1024
MAX_ARCHIVE_SIZE = 64 * 1024 * 1024
SOURCES = {
    "src/control-center/server.py": "server.py",
    "src/control-center/owner_request_drafts.py": "owner_request_drafts.py",
    "src/control-center/project_tree_catalogue.py": "project_tree_catalogue.py",
    "src/control-center/supervisor_project_activation.py": "supervisor_project_activation.py",
    "src/control-center/web/app.js": "web/app.js",
    "src/control-center/web/index.html": "web/index.html",
    "src/control-center/web/styles.css": "web/styles.css",
    "src/control-center/web/project_tree_view.mjs": "web/project_tree_view.mjs",
    "src/control-center/web/project_detail_view.mjs": "web/project_detail_view.mjs",
    "src/control-center/web/project_request_view.mjs": "web/project_request_view.mjs",
    "src/control-center/web/project_supervisor_telemetry.mjs": "web/project_supervisor_telemetry.mjs",
    "docs/project-control/MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md":
        "docs/project-control/MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md",
}
OLD = frozenset({"server.py", "web/app.js", "web/index.html", "web/styles.css"})


class ReleaseCapsuleRejected(ValueError):
    pass


@dataclass(frozen=True)
class Capsule:
    data: bytes
    sha256: str


def _digest(blob: bytes) -> str:
    return sha256(blob).hexdigest().upper()


def _require_sha40(value: str) -> None:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ReleaseCapsuleRejected("PINNED_MAIN_SHA_REQUIRED")


def _pinned_map(values: Mapping[str, bytes], pins: Mapping[str, str],
                names: set[str], label: str) -> None:
    if set(values) != names or set(pins) != names:
        raise ReleaseCapsuleRejected(label + "_EXACT_FILE_SET_REQUIRED")
    for name in sorted(names):
        data = values[name]
        expected = pins[name]
        if not isinstance(data, bytes) or len(data) > MAX_ENTRY_SIZE:
            raise ReleaseCapsuleRejected(label + "_INVALID_BYTES_OR_SIZE")
        if not isinstance(expected, str) or not re.fullmatch(r"[A-F0-9]{64}", expected):
            raise ReleaseCapsuleRejected(label + "_SHA_PIN_MISSING")
        if _digest(data) != expected:
            raise ReleaseCapsuleRejected(label + "_SHA_PIN_MISMATCH")


def _expected(main_sha: str, source_pins: Mapping[str, str],
              old_pins: Mapping[str, str]) -> tuple[dict[str, str], bytes]:
    manifest_entries: dict[str, str] = {}
    for source, target in SOURCES.items():
        manifest_entries["candidate/" + target] = source_pins[source]
    for target in sorted(OLD):
        manifest_entries["backup/" + target] = old_pins[target]
        manifest_entries["restore-test/" + target] = old_pins[target]
    receipt = {
        "schema": SCHEMA,
        "expected_main_sha": main_sha,
        "field_stage_authorized": False,
        "field_apply_authorized": False,
        "entries_sha256": dict(sorted(manifest_entries.items())),
    }
    receipt_bytes = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return manifest_entries, receipt_bytes


def _info(name: str) -> ZipInfo:
    item = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    item.compress_type = ZIP_STORED
    item.create_system = 3
    item.external_attr = 0o100600 << 16  # regular file; never symlink or directory
    return item


def _canonical_zip(payloads: Mapping[str, bytes]) -> bytes:
    """Emit the one permitted byte-level archive encoding: no ZIP aliases or extras."""
    stream = BytesIO()
    with ZipFile(stream, "w", allowZip64=False) as zf:
        for name, payload in sorted(payloads.items()):
            zf.writestr(_info(name), payload)
    return stream.getvalue()


def build_source_capsule(*, reviewed_main_sha: str, sources: Mapping[str, bytes],
                         reviewed_source_pins: Mapping[str, str],
                         existing_viewer: Mapping[str, bytes],
                         reviewed_old_pins: Mapping[str, str]) -> Capsule:
    """Pure in-memory build; the caller MUST supply independently trusted pins."""
    _require_sha40(reviewed_main_sha)
    _pinned_map(sources, reviewed_source_pins, set(SOURCES), "CANDIDATE")
    _pinned_map(existing_viewer, reviewed_old_pins, set(OLD), "OLD_VIEWER")
    expected, receipt_bytes = _expected(reviewed_main_sha, reviewed_source_pins,
                                        reviewed_old_pins)
    if len(receipt_bytes) > MAX_ENTRY_SIZE:
        raise ReleaseCapsuleRejected("RECEIPT_TOO_LARGE")
    payloads = {"candidate/" + target: sources[source] for source, target in SOURCES.items()}
    for target in sorted(OLD):
        payloads["backup/" + target] = existing_viewer[target]
        payloads["restore-test/" + target] = existing_viewer[target]
    if set(payloads) != set(expected) or len(payloads) != 20:
        raise ReleaseCapsuleRejected("PACKAGE_MEMBER_SET_INVALID")
    payloads["metadata/receipt.json"] = receipt_bytes
    raw = _canonical_zip(payloads)
    if len(raw) > MAX_ARCHIVE_SIZE:
        raise ReleaseCapsuleRejected("PACKAGE_TOO_LARGE")
    capsule = Capsule(raw, _digest(raw))
    verify_source_capsule(capsule.data, capsule.sha256,
                          reviewed_main_sha=reviewed_main_sha,
                          reviewed_source_pins=reviewed_source_pins,
                          reviewed_old_pins=reviewed_old_pins)
    return capsule


def _check_zip_central_directory_boundary(data: bytes) -> None:
    """Bound ZIP central directory BEFORE ZipFile allocates any ZipInfo objects.

    The canonical archive has exactly 21 members, no comment, no ZIP64, and
    stores its EOCD as the final 22 bytes. All lengths/offsets are treated as
    untrusted and checked without decoding any entry or trusting ZIP headers.
    """
    if len(data) < 22 or data[-22:-18] != b"PK\x05\x06":
        raise ReleaseCapsuleRejected("CONSUMER_INVALID_EOCD")
    try:
        signature, disk, start_disk, on_disk, count, directory_size, directory_at, comment_len = (
            struct.unpack_from("<4s4H2IH", data, len(data) - 22)
        )
    except struct.error as exc:
        raise ReleaseCapsuleRejected("CONSUMER_INVALID_EOCD") from exc
    end_of_directory = len(data) - 22
    # 16 KiB is much greater than the 21 canonical entries require, while
    # making both central-directory read size and allocation count bounded.
    if (signature != b"PK\x05\x06" or disk != 0 or start_disk != 0
            or on_disk != 21 or count != 21 or comment_len != 0
            or directory_size < 21 * 46 or directory_size > 16 * 1024
            or directory_at > end_of_directory
            or directory_at + directory_size != end_of_directory
            or data[directory_at:directory_at + 4] != b"PK\x01\x02"):
        raise ReleaseCapsuleRejected("CONSUMER_CENTRAL_DIRECTORY_NOT_BOUNDED")


def verify_source_capsule(data: bytes, externally_pinned_capsule_sha: str, *,
                          reviewed_main_sha: str, reviewed_source_pins: Mapping[str, str],
                          reviewed_old_pins: Mapping[str, str]) -> bool:
    """Verify without extracting or writing ANY file. Trust pins from outside ZIP."""
    _require_sha40(reviewed_main_sha)
    if set(reviewed_source_pins) != set(SOURCES) or set(reviewed_old_pins) != set(OLD):
        raise ReleaseCapsuleRejected("CONSUMER_PIN_SET_INCOMPLETE")
    for hash_value in list(reviewed_source_pins.values()) + list(reviewed_old_pins.values()):
        if not isinstance(hash_value, str) or not re.fullmatch(r"[A-F0-9]{64}", hash_value):
            raise ReleaseCapsuleRejected("CONSUMER_PIN_INVALID")
    if not isinstance(data, bytes) or len(data) > MAX_ARCHIVE_SIZE:
        raise ReleaseCapsuleRejected("CONSUMER_CAPSULE_SIZE_INVALID")
    if (_digest(data) != externally_pinned_capsule_sha or
            not isinstance(externally_pinned_capsule_sha, str)):
        raise ReleaseCapsuleRejected("CONSUMER_CAPSULE_DIGEST_MISMATCH")
    expected, receipt = _expected(reviewed_main_sha, reviewed_source_pins,
                                  reviewed_old_pins)
    inventory = set(expected) | {"metadata/receipt.json"}
    _check_zip_central_directory_boundary(data)
    try:
        with ZipFile(BytesIO(data), "r", allowZip64=False) as zf:
            info = zf.infolist()
            # Enforce raw names before checking the expected inventory:
            # the Unicode Path extra can rewrite ZipInfo.filename itself.
            for item in info:
                if (item.filename != item.orig_filename or item.extra or
                        item.comment or item.flag_bits != 0):
                    raise ReleaseCapsuleRejected("CONSUMER_NONCANONICAL_ZIP_METADATA")
            names = [x.filename for x in info]
            if len(info) != 21 or len(names) != len(set(names)) or set(names) != inventory:
                raise ReleaseCapsuleRejected("CONSUMER_UNREVIEWED_OR_MISSING_MEMBER")
            if sum(x.file_size for x in info) > 21 * MAX_ENTRY_SIZE:
                raise ReleaseCapsuleRejected("CONSUMER_TOTAL_SIZE_INVALID")
            if zf.comment:
                raise ReleaseCapsuleRejected("CONSUMER_NONCANONICAL_ZIP_METADATA")
            for item in info:
                mode = (item.external_attr >> 16) & 0o170000
                # Reject Unicode Path (0x7075) and every other ZIP extra field,
                # alias, comment, encryption/descriptor flag, or unreviewed layout.
                # No other parser may see a different entry name than this one.
                if (item.filename != item.orig_filename or item.extra or item.comment
                        or item.flag_bits != 0):
                    raise ReleaseCapsuleRejected("CONSUMER_NONCANONICAL_ZIP_METADATA")
                if (item.is_dir() or item.file_size > MAX_ENTRY_SIZE or
                        item.compress_type != ZIP_STORED or mode != 0o100000):
                    raise ReleaseCapsuleRejected("CONSUMER_MEMBER_PROPERTIES_INVALID")
            verified_payloads = {}
            for name, digest in expected.items():
                value = zf.read(name)
                if _digest(value) != digest:
                    raise ReleaseCapsuleRejected("CONSUMER_MEMBER_HASH_MISMATCH")
                verified_payloads[name] = value
            if zf.read("metadata/receipt.json") != receipt:
                raise ReleaseCapsuleRejected("CONSUMER_RECEIPT_NOT_CANONICAL")
            verified_payloads["metadata/receipt.json"] = receipt
            # Exact wire-format canonicalization additionally validates raw
            # local and central entry names, offsets, flags, and all ZIP bytes.
            # This closes parser-disagreement gaps that ZipInfo fields may hide.
            if data != _canonical_zip(verified_payloads):
                raise ReleaseCapsuleRejected("CONSUMER_NONCANONICAL_ZIP_LAYOUT")
    except (BadZipFile, OSError, EOFError, ValueError, RuntimeError, KeyError) as exc:
        if isinstance(exc, ReleaseCapsuleRejected):
            raise
        raise ReleaseCapsuleRejected("CONSUMER_INVALID_ZIP") from exc
    return True


def stage_or_apply(*_args, **_kwargs) -> None:
    raise ReleaseCapsuleRejected("MPC010_FIELD_STAGE_APPLY_NOT_AUTHORIZED")


if __name__ == "__main__":
    raise ReleaseCapsuleRejected("MPC010_SOURCE_LIBRARY_ONLY_NO_CLI")
