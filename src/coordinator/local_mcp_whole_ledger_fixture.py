"""SC-013 whole-ledger read-only *fixture*, not an H4 collector.

Deliberately lacks filesystem/network/process access, a CLI and any production
SQLite connector. Only factory-created in-memory synthetic databases can be
observed. A future field tool requires independent approval and source review.
"""
from __future__ import annotations

from collections import Counter
import sqlite3

SCHEMA = "SC013_MCP_WHOLE_LEDGER_FIXTURE_RECEIPT_V1"
PREFIX = "github:magasincoffee/magasin-supervisor:issue:"
EXPECTED = {
    PREFIX + "339": ("SC-013", "supervisor", "execute_task", "WAIT_SOT_AUTHORITY"),
    PREFIX + "381": ("SC-013", "supervisor", "health_check", "WAIT_OWNER_STOP"),
}
TERMINAL = frozenset(("DONE", "FAILED", "CANCELLED_STALE"))
INBOX_ALLOWED = TERMINAL | frozenset(("WAIT_SOT_AUTHORITY", "WAIT_OWNER_STOP", "READY", "QUEUED", "RUNNING"))
JOB_ALLOWED = frozenset(("DONE", "FAILED", "QUEUED", "RUNNING"))
MAX_ROWS = 20000

# Connection object identity instead of PRAGMA database_list filename.
# sqlite3.connect("") creates a disk-backed temp DB with the same empty
# filename as :memory:, so checking database_list alone is unsafe.
_ALLOWED: dict[int, sqlite3.Connection] = {}


class FixtureHold(ValueError):
    """Static error code only; no private local paths in diagnostics."""


def create_memory_fixture():
    connection = sqlite3.connect(":memory:")
    _ALLOWED[id(connection)] = connection
    return connection


def _valid_fixture(db):
    if not isinstance(db, sqlite3.Connection) or _ALLOWED.get(id(db)) is not db:
        raise FixtureHold("ONLY_REGISTERED_MEMORY_FIXTURE")
    try:
        names = db.execute("PRAGMA database_list").fetchall()
    except sqlite3.Error:
        raise FixtureHold("FIXTURE_DB_NOT_READABLE") from None
    if len(names) != 1 or names[0][1:] != ("main", ""):
        raise FixtureHold("ATTACHED_OR_DISK_DATABASE_FORBIDDEN")


def snapshot_fixture(db):
    """Count EVERY synthetic inbox and job row, never latest 10.

    Result contains no raw details, credentials or file paths.
    Always denies live qualification and cancellation, even with zero holds.
    """
    _valid_fixture(db)
    try:
        if db.in_transaction:
            raise FixtureHold("UNFINISHED_FIXTURE_TRANSACTION")
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        try:
            counts = db.execute(
                "SELECT (SELECT COUNT(*) FROM dispatch_inbox),"
                "(SELECT COUNT(*) FROM jobs)"
            ).fetchone()
            if any(type(n) is not int or n > MAX_ROWS or n < 0 for n in counts):
                raise FixtureHold("FULL_LEDGER_SIZE_LIMIT")
            inbox = db.execute(
                "SELECT source_id,source,task_id,target,action,status,local_job_id "
                "FROM dispatch_inbox ORDER BY source_id"
            ).fetchall()
            jobs = db.execute(
                "SELECT id,status FROM jobs ORDER BY id"
            ).fetchall()
            if len(inbox) != counts[0] or len(jobs) != counts[1]:
                raise FixtureHold("INCONSISTENT_LEDGER_COUNTS")
        finally:
            db.execute("ROLLBACK")
    except FixtureHold:
        raise
    except sqlite3.Error:
        raise FixtureHold("FIXTURE_QUERY_FAILED") from None

    issues = []
    pending_count = 0
    unexpected_pending = 0
    inbox_histogram = Counter()
    for row in inbox:
        source_id, source, task, target, action, status, local_job_id = row
        safe_status = status if status in INBOX_ALLOWED else "UNKNOWN"
        inbox_histogram[safe_status] += 1
        if safe_status not in TERMINAL:
            pending_count += 1
            if source_id not in EXPECTED:
                unexpected_pending += 1
        expected = EXPECTED.get(source_id)
        if expected is not None:
            issues.append({
                "issue_number": int(source_id.rsplit(":", 1)[1]),
                "status": safe_status,
                "identity_matches": (task, target, action, status) == expected and source == "github",
                "local_job_absent": local_job_id is None,
            })
    job_histogram = Counter()
    for _, status in jobs:
        job_histogram[status if status in JOB_ALLOWED else "UNKNOWN"] += 1
    blockers = set()
    if len(issues) != len(EXPECTED) or any(
        not x["identity_matches"] or not x["local_job_absent"] or
        x["status"] not in {"WAIT_SOT_AUTHORITY", "WAIT_OWNER_STOP"}
        for x in issues
    ):
        blockers.add("EXPECTED_STALE_REQUEST_DRIFT")
    if unexpected_pending:
        blockers.add("OTHER_PENDING_REQUESTS")
    if inbox_histogram.get("UNKNOWN"):
        blockers.add("UNKNOWN_INBOX_STATUS")
    if sum(v for k, v in job_histogram.items() if k not in ("DONE", "FAILED")):
        blockers.add("ACTIVE_OR_UNKNOWN_WORKER_JOBS")
    if pending_count != 2:
        blockers.add("UNEXPECTED_PENDING_TOTAL")
    return {
        "schema": SCHEMA,
        "source": "IN_MEMORY_FIXTURE_ONLY",
        "inbox_total": len(inbox),
        "jobs_total": len(jobs),
        "inbox_status_counts": dict(sorted(inbox_histogram.items())),
        "job_status_counts": dict(sorted(job_histogram.items())),
        "pending_count": pending_count,
        "unexpected_pending_count": unexpected_pending,
        "candidate_issues": sorted(issues, key=lambda x:x["issue_number"]),
        "blockers": sorted(blockers),
        "whole_fixture_ledger_enumerated": True,
        "live_h4_observed": False,
        "production_database_opened": False,
        "field_apply_authorized": False,
        "cancellation_performed": False,
        "stop_changed": False,
    }
