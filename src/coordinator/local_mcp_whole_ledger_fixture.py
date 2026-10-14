"""SC-013 whole-ledger read-only *fixture*, not an H4 collector.

Deliberately lacks filesystem/network/process access, a CLI and any production
SQLite connector. Only factory-created in-memory synthetic databases can be
observed. A future field tool requires independent approval and source review.
"""
from __future__ import annotations

from collections import Counter
import sqlite3
import time
import re

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
MAX_FIELD_BYTES = 4096
MAX_PROJECTED_BYTES = 2_000_000

# Connection object identity instead of PRAGMA database_list filename.
# sqlite3.connect("") creates a disk-backed temp DB with the same empty
# filename as :memory:, so checking database_list alone is unsafe.
_ALLOWED: dict[int, sqlite3.Connection] = {}


class FixtureHold(ValueError):
    """Static error code only; no private local paths in diagnostics."""


def create_memory_fixture():
    connection = sqlite3.connect(":memory:")
    # SQLite may allocate internal sort/FTS work files when temp_store is
    # configured FILE, even with an in-RAM MAIN database.
    connection.execute("PRAGMA temp_store=MEMORY")
    _ALLOWED[id(connection)] = connection
    return connection


def _valid_fixture(db):
    if not isinstance(db, sqlite3.Connection) or _ALLOWED.get(id(db)) is not db:
        raise FixtureHold("ONLY_REGISTERED_MEMORY_FIXTURE")
    try:
        names = db.execute("PRAGMA database_list").fetchall()
    except sqlite3.Error:
        raise FixtureHold("FIXTURE_DB_NOT_READABLE") from None
    # SQLite may lazily initialize the built-in TEMP schema when
    # sqlite_temp_schema is first read (not an ATTACHed foreign database).
    # Its presence with ZERO temp objects is safe for this :memory: fixture.
    observed = {(name, filename) for _, name, filename in names}
    if not observed or ("main", "") not in observed or not observed.issubset(
        {("main", ""), ("temp", "")}
    ):
        raise FixtureHold("ATTACHED_OR_DISK_DATABASE_FORBIDDEN")

    # Views and VIRTUAL TABLES can materialize or execute extension code
    # BEFORE a cursor yields a value to the projected-byte limiter.
    # sqlite_schema.type="table" even for CREATE VIRTUAL TABLE; check SQL.
    # Any TEMP object is prohibited, not only ones named jobs/inbox.
    try:
        temp_mode = db.execute("PRAGMA temp_store").fetchone()[0]
        kinds = db.execute(
            "SELECT name, type, sql FROM main.sqlite_schema "
            "WHERE name IN ('dispatch_inbox', 'jobs')"
        ).fetchall()
        temp_objects = db.execute("SELECT 1 FROM sqlite_temp_schema LIMIT 1").fetchone()
    except sqlite3.Error:
        raise FixtureHold("FIXTURE_SCHEMA_UNREADABLE") from None
    if temp_mode != 2 or temp_objects:
        raise FixtureHold("TEMP_STORAGE_OR_OBJECTS_FORBIDDEN")
    if (len(kinds) != 2
            or {row[0] for row in kinds} != {"dispatch_inbox", "jobs"}
            or any(
                kind != "table" or not isinstance(sql, str)
                or re.match(r"(?is)^\s*CREATE\s+TABLE\b", sql) is None
                for _, kind, sql in kinds
            )):
        raise FixtureHold("FIXTURE_NOT_CANONICAL_TABLES")


def snapshot_fixture(db, *, budget_seconds=3.0, _clock=None):
    """Count every IN-MEMORY fixture row, under a hard deadline and byte budget.

    No on-disk SQLite accepted; emits metadata only and never authorizes APPLY.
    """
    # Only compare identity here; do not query schema before the scan guard.
    if not isinstance(db, sqlite3.Connection) or _ALLOWED.get(id(db)) is not db:
        raise FixtureHold("ONLY_REGISTERED_MEMORY_FIXTURE")
    if (type(budget_seconds) not in (int, float)
            or not 0 < budget_seconds <= 5):
        raise FixtureHold("INVALID_READ_BUDGET")
    clock = time.monotonic if _clock is None else _clock
    deadline = clock() + budget_seconds

    def expired():
        return clock() >= deadline

    def interrupt():
        return 1 if expired() else 0

    seen_bytes = 0

    def read_projected(sql):
        nonlocal seen_bytes
        rows = []
        cursor = db.execute(sql)
        for row in cursor:
            if expired():
                raise FixtureHold("FIXTURE_READ_DEADLINE_EXCEEDED")
            for value in row:
                if value is None:
                    size = 0
                elif isinstance(value, str):
                    size = len(value.encode("utf-8"))
                elif isinstance(value, bytes):
                    size = len(value)
                elif isinstance(value, (float, int)):
                    size = 16
                else:
                    raise FixtureHold("UNSUPPORTED_FIELD_VALUE")
                if size > MAX_FIELD_BYTES:
                    raise FixtureHold("OVERSIZED_LEDGER_FIELD")
                seen_bytes += size
                if seen_bytes > MAX_PROJECTED_BYTES:
                    raise FixtureHold("FIXTURE_PROJECTION_BYTE_LIMIT")
            rows.append(row)
        return rows

    previous_limit = None
    in_tx = False
    try:
        if db.in_transaction:
            raise FixtureHold("UNFINISHED_FIXTURE_TRANSACTION")
        # One SQLite value may be huge even with a small row count.
        previous_limit = db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_FIELD_BYTES)
        # Bound ALL SQLite reads, INCLUDING schema metadata validation.
        db.set_progress_handler(interrupt, 100)
        _valid_fixture(db)
        if expired():
            raise FixtureHold("FIXTURE_READ_DEADLINE_EXCEEDED")
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        in_tx = True
        counts = db.execute(
            "SELECT (SELECT COUNT(*) FROM dispatch_inbox),"
            "(SELECT COUNT(*) FROM jobs)"
        ).fetchone()
        if expired():
            raise FixtureHold("FIXTURE_READ_DEADLINE_EXCEEDED")
        if any(type(n) is not int or n > MAX_ROWS or n < 0 for n in counts):
            raise FixtureHold("FULL_LEDGER_SIZE_LIMIT")
        inbox = read_projected(
            "SELECT source_id,source,task_id,target,action,status,local_job_id "
            "FROM dispatch_inbox"
        )
        jobs = read_projected("SELECT id,status FROM jobs")
        if len(inbox) != counts[0] or len(jobs) != counts[1]:
            raise FixtureHold("INCONSISTENT_LEDGER_COUNTS")
    except sqlite3.Error as exc:
        if expired() or "interrupted" in str(exc).lower():
            raise FixtureHold("FIXTURE_READ_DEADLINE_EXCEEDED") from None
        raise FixtureHold("FIXTURE_QUERY_FAILED") from None
    finally:
        # Disable interruption before transaction cleanup.
        db.set_progress_handler(None, 0)
        if in_tx:
            db.execute("ROLLBACK")
        if previous_limit is not None:
            db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, previous_limit)

    issues = []
    pending_count = 0
    unexpected_pending = 0
    inbox_histogram = Counter()
    for row in inbox:
        if expired():
            raise FixtureHold("FIXTURE_READ_DEADLINE_EXCEEDED")
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
        if expired():
            raise FixtureHold("FIXTURE_READ_DEADLINE_EXCEEDED")
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
