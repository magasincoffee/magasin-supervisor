# -*- coding: utf-8 -*-
"""SC-013 reviewed pure source patch for H4 local Gateway.

A health_check is an independently read-only system observation, even when
Owner STOP forbids production workers. The patch never grants business
actions execution authority, mutates local files, or starts any process.
Actual deployment is a separate hash-pinned Owner-reviewed gate.
"""
from __future__ import annotations

import ast
import hashlib

SCHEMA = "MAGASIN_SC013_GATEWAY_READONLY_STOP_PATCH_V1"
TARGET_SHA256 = "64d2758fdfbfaa468937f4b91bbe1909103db9a427587bd93854bc1d79f00ba1"

OLD_HEALTH = '''            if env["action"] == "health_check":
                condition = "WAIT_OWNER_STOP" if is_owner_stop() else "READY"
'''
NEW_HEALTH = '''            if env["action"] == "health_check":
                # Independent read-only status may run while Owner STOP is on.
                condition = "READY"
'''

OLD_DISPATCH = '''        # Dispatch only allowlisted, no side-effect local snapshots.
        if not is_owner_stop():
            rows = db.execute("SELECT source_id FROM dispatch_inbox WHERE status='READY' ORDER BY received_at LIMIT 10").fetchall()
            for row in rows:
                target_row = db.execute("SELECT target FROM dispatch_inbox WHERE source_id=?", (row["source_id"],)).fetchone()
                read_only = {
                    "supervisor": "supervisor_snapshot",
                    "webapp": "webapp_snapshot",
                    "saydi": "saydi_snapshot",
                    "sapo": "sapo_snapshot",
                }
                job = submit(read_only[target_row["target"]], dedupe_key=row["source_id"])
                db.execute("UPDATE dispatch_inbox SET local_job_id=?,status='QUEUED',updated_at=? WHERE source_id=?",
                           (job["id"],now(),row["source_id"]))
'''

NEW_DISPATCH = '''        # Only authenticated/validated read-only health_check may run even
        # while Owner STOP prevents every production worker / business task.
        db.execute("""UPDATE dispatch_inbox SET status='READY',updated_at=?
                      WHERE action='health_check' AND status='WAIT_OWNER_STOP'
                        AND local_job_id IS NULL""", (now(),))
        rows = db.execute(
            "SELECT source_id,target FROM dispatch_inbox WHERE status='READY' "
            "AND action='health_check' ORDER BY received_at LIMIT 10"
        ).fetchall()
        read_only = {
            "supervisor": "supervisor_snapshot",
            "webapp": "webapp_snapshot",
            "saydi": "saydi_snapshot",
            "sapo": "sapo_snapshot",
        }
        for row in rows:
            kind = read_only.get(row["target"])
            if kind is None:
                continue
            job = submit(kind, dedupe_key=row["source_id"])
            db.execute("UPDATE dispatch_inbox SET local_job_id=?,status='QUEUED',updated_at=? WHERE source_id=?",
                       (job["id"],now(),row["source_id"]))
'''


class PatchRejected(ValueError):
    pass


def transform(source: bytes, *, original_sha256: str = TARGET_SHA256) -> bytes:
    """Pure function: verify original SHA, exact anchors and candidate syntax."""
    if type(source) is not bytes or len(source) < 2000 or len(source) > 512_000:
        raise PatchRejected("GATEWAY_SOURCE_SIZE_INVALID")
    if hashlib.sha256(source).hexdigest() != original_sha256:
        raise PatchRejected("GATEWAY_SOURCE_SHA256_DRIFT")
    try:
        text = source.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise PatchRejected("GATEWAY_SOURCE_NOT_UTF8") from exc
    newline = "\r\n" if "\r\n" in text else "\n"
    normalized = text.replace("\r\n", "\n")
    for anchor in (OLD_HEALTH, OLD_DISPATCH):
        if normalized.count(anchor) != 1:
            raise PatchRejected("GATEWAY_PATCH_ANCHOR_NOT_UNIQUE")
    patched = normalized.replace(OLD_HEALTH, NEW_HEALTH).replace(OLD_DISPATCH, NEW_DISPATCH)
    try:
        ast.parse(patched, filename="dispatch_gateway.py")
    except SyntaxError as exc:
        raise PatchRejected("GATEWAY_PATCH_PYTHON_INVALID") from exc
    if 'condition = "WAIT_SOT_AUTHORITY"' not in patched:
        raise PatchRejected("GATEWAY_NONHEALTH_AUTHORITY_MISSING")
    if "AND action='health_check' ORDER BY received_at" not in patched:
        raise PatchRejected("GATEWAY_DISPATCH_NOT_HEALTH_ONLY")
    if "AND local_job_id IS NULL" not in patched:
        raise PatchRejected("GATEWAY_OLD_HEALTH_RECOVERY_UNSCOPED")
    out = patched.replace("\n", newline).encode("utf-8")
    if source.startswith(b"\xef\xbb\xbf"):
        out = b"\xef\xbb\xbf" + out
    if out == source:
        raise PatchRejected("GATEWAY_PATCH_DID_NOT_CHANGE")
    return out


def describe(source: bytes, *, original_sha256: str = TARGET_SHA256) -> dict:
    result = transform(source, original_sha256=original_sha256)
    return {
        "schema": SCHEMA,
        "source_sha256": hashlib.sha256(source).hexdigest(),
        "candidate_sha256": hashlib.sha256(result).hexdigest(),
        "health_when_owner_stopped": "READ_ONLY_ALLOWED",
        "business_actions_when_owner_stopped": "WAIT_SOT_AUTHORITY",
        "owner_stop_modified": False,
        "local_files_modified": False,
        "runner_started": False,
        "requires_separate_owner_reviewed_local_apply": True,
    }
