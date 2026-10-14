"""SC-013 owner-approved stale-request retirement: offline fixture contract ONLY.

This module cannot open the real H4 database or serve as a shell/worker entrypoint.
It prepares a reversible, narrowly allowlisted cancellation transition for
independent future SOT/Owner-gated H4 application. Do not run it on production.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import sqlite3

SCHEMA = "MAGASIN_SC013_STALE_LOCAL_REQUEST_RETIREMENT_FIXTURE_V1"
REPO_PREFIX = "github:magasincoffee/magasin-supervisor:issue:"
EXPECTED = {
    REPO_PREFIX + "339": ("SC-013", "supervisor", "execute_task", "WAIT_SOT_AUTHORITY"),
    REPO_PREFIX + "381": ("SC-013", "supervisor", "health_check", "WAIT_OWNER_STOP"),
}
SOT = "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md"
TERMINAL = frozenset({"DONE", "FAILED", "CANCELLED_STALE"})
WAITING = frozenset({"WAIT_SOT_AUTHORITY", "WAIT_OWNER_STOP", "READY", "QUEUED", "RUNNING"})
JOB_TERMINAL = frozenset({"DONE", "FAILED"})


class QueueRetirementHold(ValueError):
    """A deliberate refusal, with no local paths or contents in its message."""


def _dt(value):
    try:
        ts = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if ts.tzinfo is None:
            raise ValueError("naive datetime")
        return ts.astimezone(timezone.utc)
    except (ValueError, AttributeError, TypeError) as exc:
        raise QueueRetirementHold("UNTRUSTED_TIMESTAMP") from None


def classify_fixture(db: sqlite3.Connection, *, at: datetime) -> dict:
    """Whole-ledger check on synthetic SQLite; never access H4 by path."""
    if at.tzinfo is None:
        raise QueueRetirementHold("INVALID_TIME_AUTHORITY")
    timestamp = at.astimezone(timezone.utc)
    inbox = db.execute(
        "SELECT source_id,source,task_id,target,action,sot_url,status,"
        "local_job_id,updated_at FROM dispatch_inbox"
    ).fetchall()
    rows = {row[0]: row for row in inbox}
    if len(rows) != len(inbox):
        raise QueueRetirementHold("DUPLICATE_SOURCE_ID")
    awaiting = {row[0] for row in inbox if row[6] in WAITING}
    if any(row[6] not in WAITING | TERMINAL for row in inbox):
        raise QueueRetirementHold("UNKNOWN_INBOX_STATE")
    if awaiting != set(EXPECTED):
        raise QueueRetirementHold("QUEUE_HAS_UNQUALIFIED_WORK")
    jobs = db.execute("SELECT status FROM jobs").fetchall()
    if any(row[0] not in JOB_TERMINAL for row in jobs):
        raise QueueRetirementHold("ACTIVE_OR_UNKNOWN_WORKER_JOB")
    for key, (task, target, action, status) in EXPECTED.items():
        row = rows[key]
        if row[1] != "github" or row[2:5] != (task, target, action):
            raise QueueRetirementHold("REQUEST_IDENTITY_DRIFT")
        if row[5] != SOT or row[6] != status or row[7] is not None:
            raise QueueRetirementHold("REQUEST_STATE_DRIFT")
        age = timestamp - _dt(row[8])
        if not timedelta(days=2) <= age <= timedelta(days=365):
            raise QueueRetirementHold("REQUEST_NOT_VERIFIED_STALE")
    return {
        "schema": SCHEMA,
        "status": "SYNTHETIC_PLAN_ONLY",
        "retirement_count": len(EXPECTED),
        "retirement_issues": [339, 381],
        "worker_jobs_to_change": 0,
        "completed_jobs_preserved": len(jobs),
        "stop_or_autostart_changed": False,
        "production_applied": False,
    }


def fixture_retire(db: sqlite3.Connection, *, at: datetime, fixture_only: bool = False) -> dict:
    """Only usable from an isolated in-memory test fixture, NEVER H4."""
    if fixture_only is not True:
        raise QueueRetirementHold("LIVE_APPLY_NOT_QUALIFIED")
    if not isinstance(db, sqlite3.Connection):
        raise QueueRetirementHold("INVALID_FIXTURE")
    # Never permit a filesystem-backed SQLite connection, even in fixtures.
    db_names = db.execute("PRAGMA database_list").fetchall()
    if len(db_names) != 1 or db_names[0][2] not in ("", ":memory:"):
        raise QueueRetirementHold("PERSISTENT_DATABASE_NOT_ALLOWED")
    db.execute("SAVEPOINT sc013_retire")
    try:
        plan = classify_fixture(db, at=at)
        for key, (_, _, _, old_status) in EXPECTED.items():
            cur = db.execute(
                "UPDATE dispatch_inbox SET status=?,updated_at=? "
                "WHERE source_id=? AND status=? AND local_job_id IS NULL",
                ("CANCELLED_STALE", at.astimezone(timezone.utc).isoformat(), key, old_status)
            )
            if cur.rowcount != 1:
                raise QueueRetirementHold("ATOMIC_RETIRE_PRECONDITION_FAILED")
        current = db.execute(
            "SELECT COUNT(*) FROM dispatch_inbox WHERE status IN "
            "('WAIT_SOT_AUTHORITY','WAIT_OWNER_STOP','READY','QUEUED','RUNNING')"
        ).fetchone()[0]
        if current != 0:
            raise QueueRetirementHold("WAITING_REQUEST_REMAINING")
        db.execute("RELEASE SAVEPOINT sc013_retire")
        return {**plan, "status": "SIMULATED_RETIREMENT_VERIFIED", "production_applied": False}
    except Exception:
        db.execute("ROLLBACK TO SAVEPOINT sc013_retire")
        db.execute("RELEASE SAVEPOINT sc013_retire")
        raise
