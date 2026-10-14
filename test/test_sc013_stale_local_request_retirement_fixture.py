"""Only synthetic in-memory SQLite. No H4, network or external filesystem."""
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import sqlite3
import unittest

MODULE = Path(__file__).resolve().parents[1] / "src" / "coordinator" / "stale_local_request_retirement_fixture.py"
spec = importlib.util.spec_from_file_location("retirement_fixture", MODULE)
sut = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sut)
NOW = datetime(2026, 10, 14, 1, 45, tzinfo=timezone.utc)
OLD = "2026-10-10T01:00:00+00:00"


def seeded():
    db = sut.create_memory_fixture()
    db.execute("CREATE TABLE dispatch_inbox (source_id TEXT PRIMARY KEY, source TEXT, task_id TEXT, "
               "target TEXT, action TEXT, sot_url TEXT, status TEXT, local_job_id TEXT, updated_at TEXT)")
    db.execute("CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT, status TEXT)")
    for n, action, status in ((339, "execute_task", "WAIT_SOT_AUTHORITY"),
                              (381, "health_check", "WAIT_OWNER_STOP"),
                              (341, "health_check", "DONE")):
        db.execute("INSERT INTO dispatch_inbox VALUES (?,?,?,?,?,?,?,?,?)",
                   (sut.REPO_PREFIX+str(n), "github", "SC-013", "supervisor",
                    action, sut.SOT, status,
                    "historical-completed-id" if n == 341 else None, OLD))
    db.execute("INSERT INTO jobs VALUES ('historical-completed-id','supervisor_snapshot','DONE')")
    return db


class QueueRetirementFixtureTests(unittest.TestCase):
    def test_retire_exact_two_without_erasing_completed_evidence(self):
        db = seeded()
        receipt = sut.fixture_retire(db, at=NOW, fixture_only=True)
        self.assertEqual(receipt["status"], "SIMULATED_RETIREMENT_VERIFIED")
        self.assertEqual(receipt["retirement_issues"], [339, 381])
        self.assertFalse(receipt["production_applied"])
        self.assertEqual(db.execute("SELECT COUNT(*) FROM dispatch_inbox WHERE status='CANCELLED_STALE'").fetchone()[0], 2)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM dispatch_inbox WHERE status='DONE'").fetchone()[0], 1)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM jobs WHERE status='DONE'").fetchone()[0], 1)

    def test_default_refuses_even_in_memory_without_explicit_fixture_flag(self):
        db = seeded()
        with self.assertRaisesRegex(sut.QueueRetirementHold, "LIVE_APPLY_NOT_QUALIFIED"):
            sut.fixture_retire(db, at=NOW)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM dispatch_inbox WHERE status='CANCELLED_STALE'").fetchone()[0], 0)

    def test_unexpected_pending_request_blocks_entire_transaction(self):
        db = seeded()
        db.execute("INSERT INTO dispatch_inbox VALUES (?,?,?,?,?,?,?,?,?)",
                   (sut.REPO_PREFIX+"999", "github", "SC-013", "supervisor",
                    "health_check", sut.SOT, "QUEUED", None, OLD))
        with self.assertRaisesRegex(sut.QueueRetirementHold, "QUEUE_HAS_UNQUALIFIED_WORK"):
            sut.fixture_retire(db, at=NOW, fixture_only=True)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM dispatch_inbox WHERE status='CANCELLED_STALE'").fetchone()[0], 0)

    def test_active_worker_prevents_cancellation(self):
        for status in ("QUEUED", "RUNNING", "RETRY"):
            with self.subTest(status=status):
                db = seeded()
                db.execute("INSERT INTO jobs VALUES ('unknown','system_snapshot',?)", (status,))
                with self.assertRaisesRegex(sut.QueueRetirementHold, "ACTIVE_OR_UNKNOWN_WORKER_JOB"):
                    sut.fixture_retire(db, at=NOW, fixture_only=True)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM dispatch_inbox WHERE status='CANCELLED_STALE'").fetchone()[0], 0)

    def test_guard_inbox_identity_timestamp_and_job_linkage(self):
        for column, value in (("status", "QUEUED"), ("action", "sync_revenue"),
                              ("task_id", "OPS-075"), ("local_job_id", "unknown"),
                              ("sot_url", "https://invalid.invalid"),
                              ("updated_at", "2026-10-14T01:40:00+00:00")):
            with self.subTest(column=column):
                db = seeded()
                db.execute(f"UPDATE dispatch_inbox SET {column}=? WHERE source_id=?",
                           (value, sut.REPO_PREFIX+"339"))
                with self.assertRaises(sut.QueueRetirementHold):
                    sut.fixture_retire(db, at=NOW, fixture_only=True)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM dispatch_inbox WHERE status='CANCELLED_STALE'").fetchone()[0], 0)

    def test_replay_refused_after_already_cancelled(self):
        db = seeded()
        sut.fixture_retire(db, at=NOW, fixture_only=True)
        with self.assertRaises(sut.QueueRetirementHold):
            sut.fixture_retire(db, at=NOW, fixture_only=True)

    def test_no_local_database_file_even_if_fixture_flag_true(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.sqlite"
            db = sqlite3.connect(str(path))
            try:
                with self.assertRaisesRegex(sut.QueueRetirementHold, "UNREGISTERED_MEMORY_FIXTURE"):
                    sut.fixture_retire(db, at=NOW, fixture_only=True)
            finally:
                # Windows prevents TemporaryDirectory cleanup while sqlite holds the file.
                db.close()


    def test_rejects_unnamed_disk_backed_sqlite_temporary_database(self):
        # Codex P2: sqlite3.connect("") reports filename="" just like :memory:.
        db = sqlite3.connect("")
        try:
            self.assertEqual(db.execute("PRAGMA database_list").fetchone()[2], "")
            with self.assertRaisesRegex(sut.QueueRetirementHold, "UNREGISTERED_MEMORY_FIXTURE"):
                sut.fixture_retire(db, at=NOW, fixture_only=True)
        finally:
            db.close()

    def test_rejects_arbitrary_unregistered_memory_connection(self):
        db = sqlite3.connect(":memory:")
        try:
            with self.assertRaisesRegex(sut.QueueRetirementHold, "UNREGISTERED_MEMORY_FIXTURE"):
                sut.fixture_retire(db, at=NOW, fixture_only=True)
        finally:
            db.close()

    def test_rejects_attached_file_even_on_registered_memory_connection(self):
        import tempfile
        db = seeded()
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "attached.sqlite"
                try:
                    db.execute("ATTACH DATABASE ? AS unsafe_attachment", (str(path),))
                    with self.assertRaisesRegex(sut.QueueRetirementHold, "PERSISTENT_DATABASE_NOT_ALLOWED"):
                        sut.fixture_retire(db, at=NOW, fixture_only=True)
                finally:
                    db.execute("DETACH DATABASE unsafe_attachment")
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
