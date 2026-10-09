# -*- coding: utf-8 -*-
"""SC-013 disposable Business Executor fixture: NEVER a production dispatcher.

This module refuses real GitHub/Gateway receipts and accepts only synthetic
fixture IDs, fixture-only task states and fixture-only Owner/worker evidence.
It writes only inside the OS temporary directory, performs no subprocess,
network, GitHub writes, worker starts, Chrome or external side effects.

A successful test proves local *algorithmic* durable claim/ack/finalization;
it does NOT qualify real receipt authentication, SOT READY or worker lifecycle.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import tempfile
import time
from contextlib import closing
from pathlib import Path

SCHEMA = "MAGASIN_SC013_DISPOSABLE_EXECUTOR_V1"
SYNTHETIC = re.compile(r"^fixture:sc013:[0-9a-f]{16,64}$")
FIXTURE_TASK = "SC-013"
FIXTURE_TARGET = "fixture-worker"
MAX_CPU_SECONDS = 5
MAX_MEMORY_MB = 128
MAX_LEASE_SECONDS = 120

class FixtureRejected(ValueError):
    """The simulated request or lifecycle evidence is not authorized."""

def _stable_json(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)

def _fingerprint(obj):
    return hashlib.sha256(_stable_json(obj).encode("utf-8")).hexdigest()

def _reject_real_path(path):
    dest = Path(path).resolve(strict=False)
    parent = Path(tempfile.gettempdir()).resolve()
    try:
        if os.path.commonpath([str(dest), str(parent)]) != str(parent):
            raise FixtureRejected("TEMP_DIRECTORY_ONLY")
        if dest == parent:
            raise FixtureRejected("EXPLICIT_CHILD_PATH_REQUIRED")
        if any(p.is_symlink() for p in [dest, dest.parent]):
            raise FixtureRejected("SYMLINK_STORAGE_NOT_ALLOWED")
    except ValueError:
        raise FixtureRejected("TEMP_DIRECTORY_ONLY") from None
    return dest

def _validate(request, guards):
    if type(request) is not dict or type(guards) is not dict:
        raise FixtureRejected("MISSING_INPUT_OR_GUARDS")
    if set(request) != {"schema", "source_id", "task_id", "target", "action",
                        "revision", "fixture_sot_state", "cpu_budget_seconds",
                        "memory_budget_mb"}:
        raise FixtureRejected("REQUEST_FIELDS_NOT_ALLOWLISTED")
    if request["schema"] != SCHEMA or type(request["source_id"]) is not str or \
       not SYNTHETIC.fullmatch(request["source_id"]):
        raise FixtureRejected("REAL_RECEIPT_NOT_ALLOWED")
    if (request["task_id"] != FIXTURE_TASK or request["target"] != FIXTURE_TARGET or
        request["action"] != "fixture_execute" or
        request["fixture_sot_state"] != "READY_FIXTURE_ONLY" or
        type(request["revision"]) is not str or
        not re.fullmatch(r"[a-f0-9]{40}", request["revision"])):
        raise FixtureRejected("SYNTHETIC_SOT_PROOF_INVALID")
    cpu, memory = request["cpu_budget_seconds"], request["memory_budget_mb"]
    if (type(cpu) is not int or not 1 <= cpu <= MAX_CPU_SECONDS or
        type(memory) is not int or not 1 <= memory <= MAX_MEMORY_MB):
        raise FixtureRejected("RESOURCE_BUDGET_REJECTED")
    if set(guards) != {"schema", "owner_enabled", "worker_enabled", "stop",
                       "worker_alive", "machine"}:
        raise FixtureRejected("GUARD_FIELDS_NOT_ALLOWLISTED")
    if guards["schema"] != "MAGASIN_SC013_FIXTURE_GUARDS_V1":
        raise FixtureRejected("REAL_OWNER_AUTH_NOT_ACCEPTED")
    if guards["machine"] != "SIMULATED_ONLY":
        raise FixtureRejected("REAL_MACHINE_NOT_ALLOWED")
    if guards["stop"] is not False:
        raise FixtureRejected("OWNER_STOP")
    if guards["owner_enabled"] is not True or guards["worker_enabled"] is not True:
        raise FixtureRejected("WAIT_OWNER_ENABLE")
    if guards["worker_alive"] is not True:
        raise FixtureRejected("WORKER_NOT_ALIVE")

def _public(row):
    return {
        "schema": SCHEMA, "source_id": row["source_id"],
        "task_id": row["task_id"], "stage": row["stage"],
        "attempts": row["attempts"], "revision": row["revision"],
        "execution_qualified": False, "production_dispatch": False,
        "external_effects": False,
    }

class DisposableExecutor:
    """Single SQLite-backed exactly-once fixture, no runtime integration.

    The absolute database path must be beneath tempfile.gettempdir(). A
    deliberately named, isolated child directory is required; this cannot use
    any installed Coordinator/Gateway production SQLite.
    """

    def __init__(self, db_path, *, fixture_only=False, clock=None):
        if fixture_only is not True:
            raise FixtureRejected("EXPLICIT_FIXTURE_OPT_IN_REQUIRED")
        self.path = _reject_real_path(db_path)
        self.clock = clock or time.time
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _db(self):
        cx = sqlite3.connect(str(self.path), isolation_level=None, timeout=2)
        cx.row_factory = sqlite3.Row
        cx.execute("PRAGMA busy_timeout=2000")
        return cx

    def _initialize(self):
        with closing(self._db()) as cx:
            cx.execute("""CREATE TABLE IF NOT EXISTS fixture_runs (
                source_id TEXT PRIMARY KEY,
                fingerprint TEXT NOT NULL,
                task_id TEXT NOT NULL,
                revision TEXT NOT NULL,
                stage TEXT NOT NULL,
                attempts INTEGER NOT NULL,
                created_at REAL NOT NULL,
                lease_deadline REAL NOT NULL,
                receipt_token_hash TEXT NOT NULL,
                worker_ack TEXT,
                output_digest TEXT,
                qa_outcome TEXT,
                final_at REAL)""")
            cx.execute("PRAGMA user_version=1")

    def _row(self, cx, source_id):
        return cx.execute("SELECT * FROM fixture_runs WHERE source_id=?",
                          (source_id,)).fetchone()

    def claim(self, request, guards, *, lease_seconds=60):
        """Atomic BEGIN IMMEDIATE prevents duplicate claims and redelivery.

        Expired or interrupted leases are NEVER auto-replayed. They become
        BLOCKED_UNKNOWN_OUTCOME until a separate explicit reconciliation.
        """
        _validate(request, guards)
        if type(lease_seconds) is not int or not 1 <= lease_seconds <= MAX_LEASE_SECONDS:
            raise FixtureRejected("INVALID_LEASE")
        key = request["source_id"]
        fingerprint = _fingerprint(request)
        with closing(self._db()) as cx:
            cx.execute("BEGIN IMMEDIATE")
            row = self._row(cx, key)
            if row:
                if row["fingerprint"] != fingerprint:
                    cx.execute("ROLLBACK")
                    return {"stage": "BLOCKED_REVISION_CONFLICT", "source_id": key,
                            "execution_qualified": False, "production_dispatch": False}
                if row["stage"] in ("CLAIMED", "ACKED") and self.clock() >= row["lease_deadline"]:
                    cx.execute("UPDATE fixture_runs SET stage=? WHERE source_id=?",
                               ("BLOCKED_UNKNOWN_OUTCOME", key))
                row = self._row(cx, key)
                cx.execute("COMMIT")
                return {**_public(row), "duplicate": True, "token": None}
            token = secrets.token_hex(24)
            at = float(self.clock())
            cx.execute("""INSERT INTO fixture_runs
                (source_id,fingerprint,task_id,revision,stage,attempts,created_at,
                 lease_deadline,receipt_token_hash)
                 VALUES (?,?,?,?,?,1,?,?,?)""",
                 (key,fingerprint,request["task_id"],request["revision"],"CLAIMED",
                  at,at+lease_seconds,hashlib.sha256(token.encode()).hexdigest()))
            row = self._row(cx, key)
            cx.execute("COMMIT")
            return {**_public(row), "duplicate": False, "token": token}

    def ack(self, source_id, token, *, worker_receipt, guards):
        """A simulated worker must acknowledge the exact original claim."""
        if (type(source_id) is not str or not SYNTHETIC.fullmatch(source_id) or
            type(token) is not str or not re.fullmatch(r"[a-f0-9]{48}", token)):
            raise FixtureRejected("INVALID_CLAIM_ID")
        if type(worker_receipt) is not str or not re.fullmatch(r"fixture-ack:[a-f0-9]{32}", worker_receipt):
            raise FixtureRejected("UNTRUSTED_WORKER_ACK")
        # Re-use synthetic-only Owner and STOP checks without real authority.
        fake = synthetic_request(source_id=source_id)
        _validate(fake, guards)
        with closing(self._db()) as cx:
            cx.execute("BEGIN IMMEDIATE")
            row = self._row(cx, source_id)
            if not row or not secrets.compare_digest(row["receipt_token_hash"],
                                                     hashlib.sha256(token.encode()).hexdigest()):
                raise FixtureRejected("CLAIM_PROOF_INVALID")
            if row["stage"] != "CLAIMED" or self.clock() >= row["lease_deadline"]:
                raise FixtureRejected("ACK_NOT_SAFE")
            cx.execute("UPDATE fixture_runs SET stage=?,worker_ack=? WHERE source_id=?",
                       ("ACKED",worker_receipt,source_id))
            cx.execute("COMMIT")
            return {**_public(self._row(cx,source_id)), "worker_ack": "VERIFIED_FIXTURE_ONLY"}

    def finish(self, source_id, token, *, output_digest, qa_passed, guards):
        """Finishes only after matching fixture ACK and explicit synthetic QA."""
        if (type(output_digest) is not str or
            not re.fullmatch(r"[a-f0-9]{64}", output_digest) or
            qa_passed is not True):
            raise FixtureRejected("FIXTURE_QA_NOT_PASS")
        if type(token) is not str or not re.fullmatch(r"[a-f0-9]{48}", token):
            raise FixtureRejected("CLAIM_PROOF_INVALID")
        _validate(synthetic_request(source_id=source_id),guards)
        with closing(self._db()) as cx:
            cx.execute("BEGIN IMMEDIATE")
            row=self._row(cx,source_id)
            if not row or not secrets.compare_digest(row["receipt_token_hash"],
                                                      hashlib.sha256(token.encode()).hexdigest()):
                raise FixtureRejected("CLAIM_PROOF_INVALID")
            if row["stage"] != "ACKED" or not row["worker_ack"] or self.clock() >= row["lease_deadline"]:
                raise FixtureRejected("FINALIZE_NOT_SAFE")
            cx.execute("""UPDATE fixture_runs
                SET stage='COMPLETE_FIXTURE_ONLY',output_digest=?,qa_outcome=?,
                    final_at=? WHERE source_id=?""",
                    (output_digest,"PASS_FIXTURE_ONLY",float(self.clock()),source_id))
            cx.execute("COMMIT")
            return {**_public(self._row(cx,source_id)), "qa": "PASS_FIXTURE_ONLY"}

    def inspect(self, source_id):
        if type(source_id) is not str or not SYNTHETIC.fullmatch(source_id):
            raise FixtureRejected("REAL_RECEIPT_NOT_ALLOWED")
        with closing(self._db()) as cx:
            row = self._row(cx,source_id)
            return _public(row) if row else None

    def reconcile_uncertain(self, source_id):
        """Explicit read-only recovery classification, never redispatch."""
        row = self.inspect(source_id)
        if row is None:
            return {"stage":"NOT_FOUND","production_dispatch":False}
        with closing(self._db()) as cx:
            cx.execute("BEGIN IMMEDIATE")
            raw=self._row(cx,source_id)
            if raw["stage"] in ("CLAIMED","ACKED") and self.clock() >= raw["lease_deadline"]:
                cx.execute("UPDATE fixture_runs SET stage=? WHERE source_id=?",
                           ("BLOCKED_UNKNOWN_OUTCOME",source_id))
            cx.execute("COMMIT")
            return _public(self._row(cx,source_id))

def synthetic_request(*, source_id="fixture:sc013:" + "a"*16, revision="b"*40,
                      cpu_budget_seconds=2, memory_budget_mb=64):
    return {
        "schema": SCHEMA, "source_id":source_id, "task_id":FIXTURE_TASK,
        "target":FIXTURE_TARGET, "action":"fixture_execute",
        "revision":revision, "fixture_sot_state":"READY_FIXTURE_ONLY",
        "cpu_budget_seconds":cpu_budget_seconds,"memory_budget_mb":memory_budget_mb,
    }

def synthetic_guards(*, stop=False, owner_enabled=True, worker_enabled=True,
                     worker_alive=True):
    return {
        "schema":"MAGASIN_SC013_FIXTURE_GUARDS_V1",
        "owner_enabled":owner_enabled,"worker_enabled":worker_enabled,
        "stop":stop,"worker_alive":worker_alive,"machine":"SIMULATED_ONLY",
    }
