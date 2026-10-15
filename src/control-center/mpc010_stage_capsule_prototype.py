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
# Stored members only: 20 payloads, one bounded receipt, plus ZIP headers.
MAX_CAPSULE_BYTES = 21 * MAX_MEMBER_BYTES + 65_536
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
    backups = {name[len("backup/"):]: value for name, value in members.items()
               if name.startswith("backup/")}
    rehearsals = {name[len("restore-test/"):]: value for name, value in members.items()
                  if name.startswith("restore-test/")}
    if backups != rehearsals:
        raise CapsuleRejected("SYNTHETIC_RESTORE_MUST_EQUAL_BACKUP")


def _manifest(members: dict[str, bytes], commit_sha: str) -> dict:
    return {"schema": SCHEMA, "synthetic_only": True,
            "field_stage_authorized": False,
            "expected_main_sha": commit_sha,
            "members_sha256": {key: sha256(value) for key, value in sorted(members.items())}}


def _container_file(root: Path):
    # A verified leaf handle is insufficient if an attacker-controlled
    # intermediate component can be switched to a junction before opening it.
    # Synthetic test roots MUST be direct children of the trusted TEMP base.
    # No nested attacker/ directories are accepted, even if currently ordinary.
    # Lexical TEMP base only. Never resolve a caller-controlled ancestor here:
    # each component is opened from the stable volume-root handle and is rejected
    # if it is a junction/symlink/reparse point before any output is created.
    trusted_temp = Path(tempfile.gettempdir()).absolute()
    if (os.path.normcase(str(root.parent)) != os.path.normcase(str(trusted_temp))
            or not root.name.startswith("mpc010-synthetic-")):
        raise CapsuleRejected("SYNTHETIC_DIRECT_TEMP_CHILD_REQUIRED")
    dest = root / "capsule-synthetic.zip"
    if sys.platform == "win32":
        import ctypes.wintypes as wt
        import msvcrt

        class UnicodeString(ctypes.Structure):
            _fields_ = [("Length", wt.USHORT), ("MaximumLength", wt.USHORT),
                        ("Buffer", ctypes.c_void_p)]

        class ObjectAttributes(ctypes.Structure):
            _fields_ = [("Length", wt.ULONG), ("RootDirectory", ctypes.c_void_p),
                        ("ObjectName", ctypes.POINTER(UnicodeString)),
                        ("Attributes", wt.ULONG), ("SecurityDescriptor", ctypes.c_void_p),
                        ("SecurityQualityOfService", ctypes.c_void_p)]

        class IoStatusBlock(ctypes.Structure):
            _fields_ = [("Status", ctypes.c_void_p), ("Information", ctypes.c_void_p)]

        class ByHandleFileInformation(ctypes.Structure):
            _fields_ = [
                ("Attributes", wt.DWORD),
                ("Creation", wt.FILETIME), ("Access", wt.FILETIME), ("Write", wt.FILETIME),
                ("VolumeSerial", wt.DWORD), ("SizeHigh", wt.DWORD), ("SizeLow", wt.DWORD),
                ("LinkCount", wt.DWORD), ("FileIndexHigh", wt.DWORD), ("FileIndexLow", wt.DWORD)
            ]

        k = ctypes.WinDLL("kernel32", use_last_error=True)
        open_root = k.CreateFileW
        open_root.argtypes = [wt.LPCWSTR, wt.DWORD, wt.DWORD, ctypes.c_void_p,
                              wt.DWORD, wt.DWORD, ctypes.c_void_p]
        open_root.restype = ctypes.c_void_p
        close = k.CloseHandle
        close.argtypes = [ctypes.c_void_p]
        close.restype = wt.BOOL
        info = k.GetFileInformationByHandle
        info.argtypes = [ctypes.c_void_p, ctypes.POINTER(ByHandleFileInformation)]
        info.restype = wt.BOOL

        invalid = ctypes.c_void_p(-1).value
        # Anchor at the fixed local volume root, not the mutable %TEMP% path.
        # UNC, device and non-drive paths fail closed in this synthetic fixture.
        anchor = trusted_temp.anchor
        if not re.fullmatch(r"[A-Za-z]:\\", anchor):
            raise CapsuleRejected("SYNTHETIC_LOCAL_VOLUME_ROOT_REQUIRED")
        volume_handle = open_root(anchor, 0x001000A0, 0x3, None, 3,
                                  0x02000000 | 0x00200000, None)
        if volume_handle == invalid or not volume_handle:
            raise CapsuleRejected("SYNTHETIC_VOLUME_ANCHOR_UNAVAILABLE_"
                                  + str(ctypes.get_last_error()))

        def check_directory(handle):
            meta = ByHandleFileInformation()
            if not info(handle, ctypes.byref(meta)) or (
                    meta.Attributes & 0x410) != 0x10:
                raise CapsuleRejected("SYNTHETIC_ROOT_REPARSE_OR_NOT_DIRECTORY")

        def open_relative(parent_handle, leaf_name, desired, share, disposition, options):
            ntcreate = ctypes.WinDLL("ntdll").NtCreateFile
            ntcreate.argtypes = [
                ctypes.POINTER(ctypes.c_void_p), wt.ULONG,
                ctypes.POINTER(ObjectAttributes), ctypes.POINTER(IoStatusBlock),
                ctypes.c_void_p, wt.ULONG, wt.ULONG, wt.ULONG, wt.ULONG,
                ctypes.c_void_p, wt.ULONG
            ]
            ntcreate.restype = ctypes.c_long
            wide = ctypes.create_unicode_buffer(leaf_name)
            name = UnicodeString(len(leaf_name) * 2, (len(leaf_name) + 1) * 2,
                                 ctypes.cast(wide, ctypes.c_void_p))
            attributes = ObjectAttributes(ctypes.sizeof(ObjectAttributes),
                        parent_handle, ctypes.pointer(name), 0x1040, None, None)
            status = IoStatusBlock()
            child = ctypes.c_void_p()
            code = ntcreate(ctypes.byref(child), desired,
                            ctypes.byref(attributes), ctypes.byref(status),
                            None, 0x80, share, disposition, options, None, 0)
            if code < 0 or not child.value or child.value == invalid:
                raise CapsuleRejected("SYNTHETIC_RELATIVE_OPEN_DENIED_"
                                      + format(code & 0xFFFFFFFF, "08X"))
            return child

        # Walk the complete TEMP ancestry, not just its final component.
        # Share READ|WRITE (no DELETE) while handles are retained; replace/rename
        # attempts against any opened parent are denied while building the capsule.
        held = [volume_handle]
        try:
            check_directory(volume_handle)
            for component in trusted_temp.parts[1:]:
                if (not component or component in (".", "..") or
                        "/" in component or "\\" in component or ":" in component):
                    raise CapsuleRejected("SYNTHETIC_UNSAFE_TEMP_COMPONENT")
                nxt = open_relative(held[-1], component, 0x001000A0, 0x3, 1,
                                    0x00200000 | 0x00000001 | 0x00000020)
                held.append(nxt)
                check_directory(nxt)
            # The synthetic capsule root is also an exact single component.
            root_handle = open_relative(held[-1], root.name, 0x001000A0, 0x3, 1,
                                        0x00200000 | 0x00000001 | 0x00000020)
            held.append(root_handle)
            check_directory(root_handle)
            capsule_handle = open_relative(root_handle, "capsule-synthetic.zip",
                                           0xC0100000, 0, 2, 0x00200060)
            try:
                fd = msvcrt.open_osfhandle(capsule_handle.value, os.O_BINARY | os.O_RDWR)
            except Exception:
                close(capsule_handle)
                raise
            try:
                stream = os.fdopen(fd, "w+b", buffering=0)
            except Exception:
                os.close(fd)
                raise
        except Exception:
            for handle in reversed(held):
                close(handle)
            raise
        return dest, stream, (k, held)
    fd = os.open(dest, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    return dest, os.fdopen(fd, "w+b", buffering=0), None


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
    original_root = Path(root)
    # Windows junctions are distinct from symlinks in pathlib.
    if original_root.is_symlink() or (
            sys.platform == "win32" and original_root.is_junction()):
        raise CapsuleRejected("SYNTHETIC_ROOT_LINK_DENIED")
    root = original_root.resolve(strict=True)
    if not root.is_dir() or root.is_symlink() or (
            sys.platform == "win32" and root.is_junction()):
        raise CapsuleRejected("SYNTHETIC_DIRECTORY_REQUIRED")
    manifest = _manifest(members, commit_sha)
    path, locked, root_guard = _container_file(root)
    try:
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
            archive_hash = hashlib.sha256(locked.read(MAX_CAPSULE_BYTES + 1)).hexdigest().upper()
            if locked.tell() > MAX_CAPSULE_BYTES:
                raise CapsuleRejected("SYNTHETIC_BUILT_CAPSULE_TOO_LARGE")
            # Both exclusive file handle and pinned parent handle remain open
            # through the final readback, digest and success decision.
    finally:
        if root_guard is not None:
            for handle in reversed(root_guard[1]):
                root_guard[0].CloseHandle(handle)
    return path, archive_hash


def inspect_synthetic_capsule(path: Path, expected_digest: str,
                              expected_members: dict[str, bytes], commit_sha: str) -> bool:
    _valid_members(expected_members)
    manifest = _manifest(expected_members, commit_sha)
    with Path(path).open("rb") as f:
        content = f.read(MAX_CAPSULE_BYTES + 1)
        if len(content) > MAX_CAPSULE_BYTES:
            raise CapsuleRejected("SYNTHETIC_CONSUMER_CAPSULE_TOO_LARGE")
    if sha256(content) != expected_digest:
        raise CapsuleRejected("SYNTHETIC_CAPSULE_CHANGED_AFTER_RELEASE")
    with io.BytesIO(content) as inp:
        _readback(inp, manifest)
    return True


def stage_for_production(*args, **kwargs):
    raise CapsuleRejected("MPC010_STAGE_NAMESPACE_SEAL_NOT_QUALIFIED")


if __name__ == "__main__":
    raise CapsuleRejected("MPC010_SYNTHETIC_LIBRARY_NO_CLI")
