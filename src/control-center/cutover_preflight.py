# -*- coding: utf-8 -*-
"""SC-013 Control Center cutover preflight (strictly read-only).

The unified UI may surface missing controls, book checkpoints and SAPO ledger
risks without opening a legacy UI. No Owner START, STOP, schedule modification,
financial write, transaction resolution, process start, or cutover permission
is implemented here.

No file names or log contents from SAPO are serialized: older logs/JSON may
contain tokens, links, invoice identifiers and personal data. Return only
bounded risk codes, boolean presence, and age categories.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = "MAGASIN_SC013_PRECUTOVER_READINESS_V1"
MAX_STATE_BYTES = 65536
MAX_LOG_BYTES = 32768
MAX_LOG_FILES = 6
SENSITIVE_KEYS = frozenset({"export_url", "raw_path", "token", "cookie", "email"})
LOG_PATTERN = re.compile(r"^(?:diagnostic_run|robot)_\d{4}-\d\d-\d\d(?:_\d{6,8})?\.log$")
FAILURE_CLASSES = {
    "LOGIN_OR_AUTH": re.compile(r"\blogin\b|\bauth(?:entication|orization)?\b", re.I),
    "TIMEOUT": re.compile(r"\btimeout\b|\btimed[\s_-]?out\b", re.I),
    "ERROR": re.compile(r"\berror\b|\bfailed?\b|\bexception\b", re.I),
}


def _read_state(path: Path) -> tuple[dict, str | None]:
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_STATE_BYTES:
            return {}, "SAPO_STATE_NOT_READABLE"
        contents = path.read_text(encoding="utf-8-sig")
        if len(contents.encode("utf-8")) > MAX_STATE_BYTES:
            return {}, "SAPO_STATE_NOT_READABLE"
        data = json.loads(contents)
        if type(data) is not dict:
            return {}, "SAPO_STATE_NOT_OBJECT"
        return data, None
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}, "SAPO_STATE_INVALID"


def _log_classes(log_dir: Path) -> tuple[list[str], str | None]:
    """No raw log lines, paths, export links, or personal identifiers escape."""
    try:
        if log_dir.is_symlink() or not log_dir.is_dir():
            return [], "SAPO_LOGS_UNAVAILABLE"
        found = []
        for file in log_dir.iterdir():
            if (len(found) >= 80):
                break  # bounded directory walk; report uncertainty below
            if file.is_file() and not file.is_symlink() and LOG_PATTERN.fullmatch(file.name):
                found.append(file)
        found.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        classes = set()
        for file in found[:MAX_LOG_FILES]:
            if file.stat().st_size > MAX_LOG_BYTES:
                classes.add("LOG_TOO_LARGE_NOT_INSPECTED")
                continue
            contents = file.read_text(encoding="utf-8", errors="replace")
            for key, pattern in FAILURE_CLASSES.items():
                if pattern.search(contents):
                    classes.add(key)
        if not found:
            return [], "SAPO_LOGS_UNAVAILABLE"
        if len(found) >= 80:
            classes.add("LOG_DIRECTORY_SCAN_BOUNDED")
        return sorted(classes), None
    except (OSError, ValueError):
        return [], "SAPO_LOGS_UNAVAILABLE"


def _check_outbound(supervisor: dict | None):
    if type(supervisor) is not dict:
        return ["SUPERVISOR_OUTBOUND_UNVERIFIED"], "UNVERIFIED"
    outbound = supervisor.get("outbound")
    if type(outbound) is not dict:
        return ["SUPERVISOR_OUTBOUND_UNVERIFIED"], "UNVERIFIED"
    state = outbound.get("state")
    if state in ("IDLE", "NONE", "DONE_CONFIRMED", "CANCELLED_CONFIRMED"):
        # This is a local signal, not independent proof of durable delivery.
        return ["SUPERVISOR_OUTBOUND_DELIVERY_NOT_INDEPENDENTLY_VERIFIED"], "REPORTED_TERMINAL"
    if state in ("ENQUEUED", "PENDING", "SENDING", "IN_FLIGHT", "WAIT_ACK"):
        return ["SUPERVISOR_OUTBOUND_UNKNOWN_OUTCOME_NO_RESEND"], "AMBIGUOUS_PENDING"
    return ["SUPERVISOR_OUTBOUND_UNVERIFIED"], "UNVERIFIED"


def inspect(
    *, sapo_state_path: Path, sapo_logs_dir: Path,
    supervisor_state: dict | None, supervisor_stop: bool | None,
    supervisor_autostart_disabled: bool | None,
    saydi: dict | None, ram_free_gib: Any,
    legacy_auto_start_present: bool | None = None,
    now: datetime | None = None,
):
    """Classify a non-authoritative diagnostic snapshot; never return READY.

    A positive process/heartbeat does not prove Owner authorization.
    """
    now = now or datetime.now(timezone.utc)
    state, state_error = _read_state(sapo_state_path)
    log_classes, log_error = _log_classes(sapo_logs_dir)
    sapo_blockers = []
    if state_error:
        sapo_blockers.append(state_error)
    else:
        # Even if last_success is present, it does not resolve a pending export.
        if type(state.get("pending")) is dict and len(state["pending"]) > 0:
            sapo_blockers.append("SAPO_PENDING_EXPORT_NOT_RECONCILED")
        if type(state.get("last_success")) is dict and len(state["last_success"]) > 0:
            sapo_blockers.append("SAPO_LAST_SUCCESS_NOT_INDEPENDENTLY_VERIFIED")
        if not state.get("pending") and not state.get("last_success"):
            sapo_blockers.append("SAPO_FINANCIAL_CHECKPOINT_UNVERIFIED")
    if log_error:
        sapo_blockers.append(log_error)
    if log_classes:
        sapo_blockers.append("SAPO_RECENT_DIAGNOSTIC_REQUIRES_REVIEW")
    # Do not provide a way to infer transaction identity from this API.
    sup_blockers, sup_outbound = _check_outbound(supervisor_state)
    if supervisor_stop is not False or supervisor_autostart_disabled is not False:
        sup_blockers.append("SUPERVISOR_STOP_LATCH_PRESENT_OR_UNKNOWN")
    saydi_blockers = []
    media = saydi if type(saydi) is dict else {}
    stage = media.get("chapter2") if type(media.get("chapter2")) is dict else {}
    if stage.get("stage") == "REVIEW_READY":
        saydi_blockers.append("SAYDI_CHAPTER_REVIEW_NOT_FINAL")
    elif stage.get("stage") in ("PAUSED_RESOURCE", "WAIT_RESOURCE"):
        saydi_blockers.append("SAYDI_CHAPTER_QC_WAIT_RESOURCE")
    else:
        saydi_blockers.append("SAYDI_CHAPTER_CHECKPOINT_UNVERIFIED")
    if media.get("worker") is True:
        saydi_blockers.append("SAYDI_WORKER_ACTIVITY_NOT_SAFE_TO_INTERRUPT")
    elif media.get("worker") is not False:
        saydi_blockers.append("SAYDI_WORKER_UNVERIFIED")
    if type(ram_free_gib) not in (float, int) or not 0 <= ram_free_gib < 1024:
        saydi_blockers.append("SAYDI_FREE_RAM_UNVERIFIED")
    elif ram_free_gib < 2.3:
        saydi_blockers.append("SAYDI_QC_RAM_BELOW_GATE")
    if legacy_auto_start_present is not False:
        # Currently present across Startup, Windows Run and Scheduled Tasks.
        saydi_blockers.append("LEGACY_AUTOSTART_UNRECONCILED")
        sapo_blockers.append("LEGACY_AUTOSTART_UNRECONCILED")
    for blockers, code in [
        (saydi_blockers, "SAYDI_OWNER_CONTROL_NOT_QUALIFIED"),
        (sapo_blockers, "SAPO_FINANCIAL_STOP_CHECKPOINT_NOT_QUALIFIED"),
        (sup_blockers, "SUPERVISOR_OWNER_LIFECYCLE_NOT_QUALIFIED"),
    ]:
        blockers.append(code)
    return {
        "schema": SCHEMA,
        "checked_at_utc": now.astimezone(timezone.utc).isoformat() if now.tzinfo else None,
        "milestone": "MIG-CC-01",
        "milestone_status": "IN_PROGRESS",
        "status": "BLOCKED_NOT_QUALIFIED",
        "qualified": False, "cutover_allowed": False,
        "business_dispatch_enabled": False, "owner_start_authorized": False,
        "production_effects": False,
        "robots": {
            "supervisor": {
                "read_only": True, "ready": False,
                "outbound_state_class": sup_outbound,
                "blockers": sorted(set(sup_blockers)),
            },
            "saydi": {
                "read_only": True, "ready": False,
                "chapter_class": ("REVIEW_READY" if stage.get("stage") == "REVIEW_READY" else
                                  "WAIT_RESOURCE" if stage.get("stage") in ("PAUSED_RESOURCE", "WAIT_RESOURCE") else
                                  "UNVERIFIED"),
                "blockers": sorted(set(saydi_blockers)),
            },
            "sapo": {
                "read_only": True, "ready": False,
                "pending_export_evidence": "PRESENT" if "SAPO_PENDING_EXPORT_NOT_RECONCILED" in sapo_blockers else "UNVERIFIED",
                "log_failure_classes": log_classes,
                "blockers": sorted(set(sapo_blockers)),
            },
        },
    }
