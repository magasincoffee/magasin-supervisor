# -*- coding: utf-8 -*-
"""SC-013 per-specialist Owner START/STOP attestation *contract*, source-only.

Two hard-separated modes:
- observe_local(): filesystem read-only, conservatively classifies currently
  installed Supervisor/SAYDI/SAPO; never infers Owner START from process,
  watchdog, an advisory flag or a legacy Windows task.
- verify_fixture_attestation(): HMAC-bound synthetic proof for a disposable
  test-worker contract. It ONLY accepts fixture identity, simulated machine
  and fixture credentials; even valid signatures NEVER authorize dispatch.

This module is not imported by installed Coordinator, Scheduler or robots.
It cannot START/STOP workers, modify any lifecycle, call GitHub or grant access.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SCHEMA = "MAGASIN_SC013_SPECIALIST_LIFECYCLE_V1"
FIXTURE_SCHEMA = "MAGASIN_SC013_SPECIALIST_OWNER_FIXTURE_V1"
HOST = "DESKTOP-H4A16IL"
ROOT = Path(r"D:\MAGASIN_ROBOTS\robots")
SUPERVISOR_RUNTIME = Path(r"C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor")
ADVISORY = ROOT / "coordinator" / "config" / "owner_enabled.json"
MANIFESTS = {
    "supervisor": ROOT / "supervisor" / "robot.json",
    "saydi": ROOT / "saydi-media" / "robot.json",
    "sapo": ROOT / "sapo" / "robot.json",
}
MANIFEST_IDS = {"supervisor":"supervisor", "saydi":"saydi-media", "sapo":"sapo"}
MAX_BYTES = 8192
MAX_STALENESS_SECONDS = 90
MAX_PROOF_TTL_SECONDS = 90
HEX = re.compile(r"^[a-f0-9]{32,64}$")
FIXTURE_KEY_PREFIX = b"sc013-fixture-only-test-key:"


class EvidenceRejected(ValueError):
    pass


def _ts(value: Any):
    if type(value) is not str:
        raise EvidenceRejected("TIMESTAMP_INVALID")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("timezone required")
        return parsed.astimezone(timezone.utc)
    except ValueError as exc:
        raise EvidenceRejected("TIMESTAMP_INVALID") from exc


def _json(path: Path):
    # No symlinks (runtime manifests deliberately in real D: folders, not junctions)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise EvidenceRejected("EVIDENCE_UNREADABLE")
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise EvidenceRejected("EVIDENCE_INVALID_JSON") from exc
    if type(payload) is not dict:
        raise EvidenceRejected("EVIDENCE_NOT_OBJECT")
    return payload


def _status(robot, status, reasons, *, heartbeat_age_seconds=None):
    return {
        "schema": SCHEMA, "robot": robot, "status": status,
        "blockers": sorted(set(reasons)),
        "heartbeat_age_seconds": heartbeat_age_seconds,
        "owner_start_verified": False, "worker_identity_verified": False,
        "business_dispatch_authorized": False, "execution_qualified": False,
        "dispatched": False, "specialist_started": False,
    }


def observe_local(robot: str, *, host=None, manifests=None,
                  coordinator_flags=ADVISORY, supervisor_root=SUPERVISOR_RUNTIME,
                  now=None):
    """Read-only inventory, never issues a START or treats a PID as Owner authority."""
    if robot not in MANIFESTS:
        return _status(str(robot)[:30], "BLOCKED_UNSUPPORTED_ROBOT", ["TARGET_NOT_ALLOWLISTED"])
    when = now or datetime.now(timezone.utc)
    if when.tzinfo is None:
        return _status(robot, "BLOCKED_INVALID_CLOCK", ["CLOCK_WITHOUT_TIMEZONE"])
    if (host or socket.gethostname()).upper() != HOST:
        return _status(robot, "BLOCKED_WRONG_MACHINE", ["WRONG_MACHINE"])
    reasons = []
    try:
        config = _json((manifests or MANIFESTS)[robot])
        advisory = _json(coordinator_flags)
        if config.get("id") != MANIFEST_IDS[robot]:
            reasons.append("MANIFEST_IDENTITY_MISMATCH")
        if config.get("manual_controls_verified") is not True:
            reasons.append("SPECIALIST_START_STOP_NOT_QUALIFIED")
        # The Coordinator advisory is NEVER proof of START, even if true.
        if advisory.get(robot) is not False:
            reasons.append("SPECIALIST_NOT_CONFIRMED_OFF")
        if (supervisor_root / "STOP").exists() or (
                supervisor_root / "AUTOSTART_DISABLED").exists():
            reasons.append("SUPERVISOR_STOP_LATCH")
        if robot == "supervisor":
            guardian = _json(supervisor_root / "guardian-status.json")
            try:
                stamp = _ts(guardian.get("timestamp"))
                age = (when - stamp).total_seconds()
            except EvidenceRejected:
                age = None
            if age is None or age < -5 or age > MAX_STALENESS_SECONDS:
                reasons.append("GUARDIAN_HEARTBEAT_STALE")
            if guardian.get("owner_stop") is not False:
                reasons.append("SUPERVISOR_OWNER_STOP_OR_UNKNOWN")
            if guardian.get("wrapper_alive") is not True:
                reasons.append("SUPERVISOR_WRAPPER_NOT_ALIVE")
            if guardian.get("watchdog_mode") != "HEALTHY" or guardian.get("automation_status") in (
                    "BLOCKED", "FAILED", "STOPPED"):
                reasons.append("SUPERVISOR_GUARDIAN_FAULT_OR_UNKNOWN")
            if guardian.get("control_valid") is not True:
                reasons.append("SUPERVISOR_CONTROL_INVALID")
        else:
            age = None
            reasons.append("NO_INDEPENDENT_SPECIALIST_OWNER_PROOF")
            if str(config.get("startup","")).startswith("legacy"):
                reasons.append("LEGACY_STARTUP_NOT_OWNER_ATTESTATION")
        # No signed Owner generation/revocation + bound worker attestation exists.
        reasons.append("SIGNED_OWNER_AND_WORKER_PROOF_NOT_INSTALLED")
    except (EvidenceRejected, OSError, KeyError) as exc:
        reasons.append("LOCAL_EVIDENCE_MISSING_OR_INVALID")
        age = None
    return _status(robot, "BLOCKED_NOT_QUALIFIED", reasons,
                   heartbeat_age_seconds=round(age, 2) if age is not None else None)


FIXTURE_FIELDS = frozenset({
    "schema", "machine", "robot", "intent", "generation", "boot_id",
    "worker_instance", "worker_pid", "issued_at", "expires_at", "nonce",
})


def fixture_signature(statement: dict, key: bytes):
    """Used by tests to model an out-of-band, separate Owner signer ONLY."""
    if type(key) is not bytes or not key.startswith(FIXTURE_KEY_PREFIX) or len(key) < 56:
        raise EvidenceRejected("REAL_OR_WEAK_SECRET_FORBIDDEN_IN_FIXTURE")
    msg = json.dumps(statement, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hmac.new(key, msg, hashlib.sha256).hexdigest()


def verify_fixture_attestation(statement: dict, signature: str, *, key: bytes,
                               trusted_generation: int, witness: dict,
                               stop: bool, now: datetime, used_nonces=(),
                               fixture_only: bool = False):
    """Positive fixture outcome is NEVER a production START/dispatch permission.

    trusted_generation and witness stand in for distinct Owner and worker
    trust roots NOT YET IMPLEMENTED on H4. No production caller may use
    this fixture API to authorize anything.
    """
    denied = {"schema": FIXTURE_SCHEMA, "status":"BLOCKED_FIXTURE_NOT_QUALIFIED",
              "reason":"UNVERIFIED", "owner_start_verified":False,
              "worker_identity_verified":False,
              "business_dispatch_authorized":False,
              "execution_qualified":False, "dispatched":False}
    def block(reason):
        return {**denied, "reason":reason}
    if fixture_only is not True:
        return block("EXPLICIT_FIXTURE_ONLY_REQUIRED")
    if stop is not False:
        return block("OWNER_STOP_OR_UNKNOWN")
    if (type(statement) is not dict or set(statement) != FIXTURE_FIELDS or
        type(witness) is not dict or type(trusted_generation) is not int or
        trusted_generation < 1 or now.tzinfo is None):
        return block("UNTRUSTED_ATTESTATION_SHAPE")
    if (statement["schema"] != FIXTURE_SCHEMA or
        statement["machine"] != "SIMULATED_ONLY" or
        statement["robot"] not in MANIFESTS or
        statement["intent"] != "OWNER_ENABLED_FIXTURE" or
        type(statement["generation"]) is not int or
        statement["generation"] != trusted_generation or
        type(statement["worker_pid"]) is not int or
        statement["worker_pid"] < 1 or
        any(type(statement[k]) is not str or not HEX.fullmatch(statement[k])
            for k in ("nonce", "boot_id", "worker_instance"))):
        return block("ATTESTATION_AUTHORITY_MISMATCH")
    try:
        issued = _ts(statement["issued_at"])
        expires = _ts(statement["expires_at"])
    except EvidenceRejected:
        return block("PROOF_CLOCK_INVALID")
    utcnow = now.astimezone(timezone.utc)
    if not (issued <= utcnow <= expires and
            0 < (expires - issued).total_seconds() <= MAX_PROOF_TTL_SECONDS):
        return block("PROOF_EXPIRED_FUTURE_OR_LONG_LIVED")
    if statement["nonce"] in used_nonces:
        return block("ATTESTATION_NONCE_ALREADY_CONSUMED")
    if (type(signature) is not str or not re.fullmatch(r"[a-f0-9]{64}", signature)):
        return block("BAD_SIGNATURE")
    try:
        expected = fixture_signature(statement, key)
    except (EvidenceRejected, TypeError, ValueError):
        return block("FIXTURE_KEY_UNQUALIFIED")
    if not hmac.compare_digest(expected, signature):
        return block("SIGNATURE_MISMATCH")
    # A worker PID by itself is insufficient; witness must bind boot, instance,
    # owner generation and fresh heartbeat to this signed simulated assertion.
    if (set(witness) != {"schema", "robot", "machine", "generation", "boot_id",
                         "worker_instance", "worker_pid", "heartbeat_at",
                         "alive", "worker_off"} or
        witness.get("schema") != "SC013_WORKER_WITNESS_FIXTURE_V1" or
        witness.get("robot") != statement["robot"] or
        witness.get("machine") != "SIMULATED_ONLY" or
        type(witness.get("generation")) is not int or
        witness["generation"] != trusted_generation or
        witness.get("boot_id") != statement["boot_id"] or
        witness.get("worker_instance") != statement["worker_instance"] or
        type(witness.get("worker_pid")) is not int or
        witness["worker_pid"] != statement["worker_pid"] or
        witness.get("alive") is not True or witness.get("worker_off") is not False):
        return block("WORKER_WITNESS_MISMATCH")
    try:
        age = (utcnow - _ts(witness.get("heartbeat_at"))).total_seconds()
    except EvidenceRejected:
        return block("WORKER_HEARTBEAT_INVALID")
    if age < -5 or age > MAX_STALENESS_SECONDS:
        return block("WORKER_HEARTBEAT_STALE")
    # This proof is valid only in the isolated fixture. Never return READY or
    # a production-success boolean, even if every signature check succeeds.
    return {**denied, "status":"FIXTURE_SIGNATURE_AND_WITNESS_MATCHED_ONLY",
            "reason":"REAL_OWNER_AND_WORKER_TRUST_ROOTS_NOT_INSTALLED"}
