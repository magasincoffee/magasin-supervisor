"""MPC-010 synthetic single-file capsule experiment. NOT a field Stage or H4 runner.

A single flat ZIP container removes the mutable candidate/backup directory
namespace from the package itself. A Windows exclusive CreateFileW handle holds
the file through verification. Any future consumer MUST reopen and revalidate
the entire capsule against independently trusted exact-main source pins.
"""
from __future__ import annotations
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import zipfile

MAX_MEMBER_BYTES = 1_048_576
SCHEMA = "MPC010_SYNTHETIC_CAPSULE_V1"
_PROOF = "MPC010_SYNTHETIC_CI_ONLY"


class CapsuleRejected(RuntimeError):
    pass


def sha256(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest().upper()


def _valid_members(members: dict[str, bytes]) -> None:
    if len(members) != 20:
        raise CapsuleRejected("SYNTHETIC_EXACT_MEMBER_COUNT_REQUIRED")
    prefixes = {"candidate/": 12, "backup/": 4, "restore-test/": 4}
    for prefix, n in prefixes.items():
        if sum(k.startswith(prefix) for k in members) != n:
            raise CapsuleRejected("SYNTHETIC_MEMBER_CATEGORY_COUNT_MISMATCH")
    for name, value in members.items():
        if not isinstance(value, bytes) or len(value) > MAX_MEMBER_BYTES:
            raise CapsuleRejected("SYNTHETIC_MEMBER_TOO_LARGE_OR_NONBYTES")
        if ("\\" in name or ":" in name or name.startswith("/") or
                not re.fullmatch(r"(?:candidate|backup|restore-test)/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+", name) or
                any(x in (".", "..") for x in name.split("/"))):
            raise CapsuleRejected("SYNTHETIC_UNSAFE_ENTRY_NAME")


def _manifest(members: dict[str, bytes], commit_sha: str) -> dict:
    return {"schema": SCHEMA, "synthetic_only": True,
            "field_stage_authorized": False,
            "expected_main_sha": commit_sha,
            "members_sha256": {key: sha256(value) for key, value in sorted(members.items())}}


def _container_file(root: Path):
    if os.path.normcase(os.path.commonpath([str(root), str(Path(tempfile.gettempdir()).resolve())])) != os.path.normcase(str(Path(tempfile.gettempdir()).resolve())) or not root.name.startswith("mpc010-synthetic-"):
        raise CapsuleRejected("SYNTHETIC_TEMP_DIRECTORY_ONLY")
    dest = root / "capsule-synthetic.zip"
    if sys.platform == "win32":
        import msvcrt
        import ctypes.wintypes as wt
        f = ctypes.WinDLL("kernel32", use_last_error=True).CreateFileW
        f.argtypes = [wt.LPCWSTR, wt.DWORD, wt.DWORD, ctypes.c_void_p,
                      wt.DWORD, wt.DWORD, ctypes.c_void_p]
        f.restype = ctypes.c_void_p
        handle = f(str(dest), 0xC0000000, 0, None, 1, 0x00200000, None)
        if handle == ctypes.c_void_p(-1).value:
            raise CapsuleRejected("SYNTHETIC_EXCLUSIVE_CREATE_DENIED_" + str(ctypes.get_last_error()))
        try:
            fd = msvcrt.open_osfhandle(handle, os.O_BINARY | os.O_RDWR)
        except Exception:
            ctypes.WinDLL("kernel32").CloseHandle(ctypes.c_void_p(handle))
            raise
    else:
        fd = os.open(dest, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    return dest, os.fdopen(fd, "w+b", buffering=0)


def _readback(locked_file, expected_manifest: dict) -> None:
    locked_file.seek(0)
    with zipfile.ZipFile(locked_file, "r") as archive:
        entries = archive.infolist()
        expected = set(expected_manifest["members_sha256"]) | {"metadata/receipt.json"}
        names = [e.filename for e in entries]
        if len(names) != len(expected) or len(set(names)) != len(names) or set(names) != expected:
            raise CapsuleRejected("SYNTHETIC_EXTRA_OR_MISSING_ARCHIVE_ENTRY")
        for e in entries:
            if e.file_size > MAX_MEMBER_BYTES or e.compress_type != zipfile.ZIP_STORED or (e.external_attr >> 16) & 0o170000 == 0o120000:
                raise CapsuleRejected("SYNTHETIC_ARCHIVE_ENTRY_PROPERTIES_REJECTED")
        for name, digest in expected_manifest["members_sha256"].items():
            if sha256(archive.read(name)) != digest:
                raise CapsuleRejected("SYNTHETIC_MEMBER_HASH_MISMATCH")
        expected_json = json.dumps(expected_manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
        if archive.read("metadata/receipt.json") != expected_json:
            raise CapsuleRejected("SYNTHETIC_RECEIPT_MISMATCH")


def build_synthetic_capsule(root: Path, members: dict[str, bytes], *,
                             commit_sha: str, proof: str, while_locked=None) -> tuple[Path, str]:
    if proof != _PROOF:
        raise CapsuleRejected("SYNTHETIC_PROOF_REQUIRED")
    if not re.fullmatch(r"[0-9a-f]{40}", commit_sha):
        raise CapsuleRejected("SYNTHETIC_COMMIT_SHA_REQUIRED")
    _valid_members(members)
    root = Path(root).resolve(strict=True)
    if not root.is_dir() or root.is_symlink():
        raise CapsuleRejected("SYNTHETIC_DIRECTORY_REQUIRED")
    manifest = _manifest(members, commit_sha)
    path, locked = _container_file(root)
    with locked:
        with zipfile.ZipFile(locked, mode="w", compression=zipfile.ZIP_STORED, allowZip64=False) as out:
            for name, value in sorted(members.items()):
                out.writestr(name, value, compress_type=zipfile.ZIP_STORED)
            out.writestr("metadata/receipt.json",
                         json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8"),
                         compress_type=zipfile.ZIP_STORED)
        locked.flush()
        os.fsync(locked.fileno())
        _readback(locked, manifest)
        if while_locked is not None:
            while_locked(path)
        _readback(locked, manifest)
        locked.seek(0)
        archive_hash = hashlib.sha256(locked.read()).hexdigest().upper()
        # The exclusive Windows handle stays open throughout verification.
    return path, archive_hash


def inspect_synthetic_capsule(path: Path, expected_digest: str,
                              expected_members: dict[str, bytes], commit_sha: str) -> bool:
    _valid_members(expected_members)
    manifest = _manifest(expected_members, commit_sha)
    with Path(path).open("rb") as f:
        content = f.read()
    if sha256(content) != expected_digest:
        raise CapsuleRejected("SYNTHETIC_CAPSULE_CHANGED_AFTER_RELEASE")
    with io.BytesIO(content) as inp:
        _readback(inp, manifest)
    return True


def stage_for_production(*args, **kwargs):
    raise CapsuleRejected("MPC010_STAGE_NAMESPACE_SEAL_NOT_QUALIFIED")


if __name__ == "__main__":
    raise CapsuleRejected("MPC010_SYNTHETIC_LIBRARY_NO_CLI")
