"""Synthetic whole-ledger SQLite negative tests; never touch H4 or production DB."""
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

PATH = Path(__file__).resolve().parents[1]/"src"/"coordinator"/"local_mcp_whole_ledger_fixture.py"
spec = importlib.util.spec_from_file_location("whole_ledger", PATH)
sut = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sut)


def seed(older_jobs=0):
    db = sut.create_memory_fixture()
    db.execute("""CREATE TABLE dispatch_inbox (
        source_id TEXT PRIMARY KEY, source TEXT, task_id TEXT, target TEXT,
        action TEXT, status TEXT, local_job_id TEXT, details TEXT
    )""")
    db.execute("CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT, error TEXT)")
    for number, task, target, action, status in (
        (339,"SC-013","supervisor","execute_task","WAIT_SOT_AUTHORITY"),
        (381,"SC-013","supervisor","health_check","WAIT_OWNER_STOP"),
        (341,"SC-013","supervisor","health_check","DONE")
    ):
        db.execute(
            "INSERT INTO dispatch_inbox VALUES (?,?,?,?,?,?,?,?)",
            (sut.PREFIX + str(number), "github", task, target, action,
             status, None, "PRIVATE_ACCESS_TOKEN_SHOULD_NOT_LEAK")
        )
    for number in range(older_jobs):
        db.execute("INSERT INTO jobs VALUES (?,?,?)",
                   (f"job-{number:04d}", "DONE", "PRIVATE_LOG_NEVER_ECHO"))
    db.commit()
    return db


class SyntheticWholeLedgerTests(unittest.TestCase):
    def test_historical_11th_active_job_is_not_hidden_by_last_ten(self):
        db = seed(24)
        db.execute("UPDATE jobs SET status='QUEUED' WHERE id='job-0000'")
        db.commit()
        result = sut.snapshot_fixture(db)
        self.assertEqual(result["jobs_total"], 24)
        self.assertEqual(result["job_status_counts"]["QUEUED"], 1)
        self.assertIn("ACTIVE_OR_UNKNOWN_WORKER_JOBS", result["blockers"])
        self.assertFalse(result["field_apply_authorized"])
        db.close()

    def test_full_synthetic_fixture_never_qualifies_live_operation(self):
        db = seed(15)
        receipt = sut.snapshot_fixture(db)
        self.assertEqual(receipt["inbox_total"],3)
        self.assertEqual(receipt["jobs_total"],15)
        self.assertEqual(receipt["pending_count"],2)
        self.assertEqual(receipt["blockers"],[])
        self.assertFalse(receipt["live_h4_observed"])
        self.assertFalse(receipt["field_apply_authorized"])
        self.assertFalse(receipt["cancellation_performed"])
        self.assertNotIn("PRIVATE_ACCESS_TOKEN",repr(receipt))
        self.assertNotIn("PRIVATE_LOG",repr(receipt))
        # query_only=ON disallows writes even to in-RAM synthetic fixtures
        with self.assertRaises(sqlite3.OperationalError):
            db.execute("DELETE FROM jobs")
        db.close()

    def test_unknown_or_other_pending_inbox_never_passes(self):
        for scenario in ("unexpected", "unknown", "changed_action", "linked"):
            with self.subTest(scenario=scenario):
                db = seed(1)
                if scenario == "unexpected":
                    db.execute("INSERT INTO dispatch_inbox VALUES (?,?,?,?,?,?,?,?)",
                               ("foreign","github","OPS-075","sapo","sync_revenue",
                                "READY",None,"SECRET"))
                elif scenario == "unknown":
                    db.execute("UPDATE dispatch_inbox SET status='MYSTERY' WHERE source_id=?",
                               (sut.PREFIX+"341",))
                elif scenario == "changed_action":
                    db.execute("UPDATE dispatch_inbox SET action='sync_revenue' WHERE source_id=?",
                               (sut.PREFIX+"339",))
                else:
                    db.execute("UPDATE dispatch_inbox SET local_job_id='linked' WHERE source_id=?",
                               (sut.PREFIX+"381",))
                db.commit()
                result=sut.snapshot_fixture(db)
                self.assertNotEqual(result["blockers"],[])
                self.assertFalse(result["field_apply_authorized"])
                db.close()

    def test_disallows_file_backed_and_anonymous_temp_databases(self):
        for path in ("",":memory:"):
            db = sqlite3.connect(path)
            try:
                with self.assertRaisesRegex(sut.FixtureHold,"ONLY_REGISTERED_MEMORY_FIXTURE"):
                    sut.snapshot_fixture(db)
            finally:
                db.close()
        with tempfile.TemporaryDirectory() as folder:
            db=sqlite3.connect(str(Path(folder)/"data.sqlite"))
            try:
                with self.assertRaisesRegex(sut.FixtureHold,"ONLY_REGISTERED_MEMORY_FIXTURE"):
                    sut.snapshot_fixture(db)
            finally:
                db.close()

    def test_disallows_attached_file_in_registered_memory_fixture(self):
        with tempfile.TemporaryDirectory() as folder:
            db=seed()
            try:
                db.execute("ATTACH DATABASE ? AS extra",(str(Path(folder)/"attached.sqlite"),))
                with self.assertRaisesRegex(sut.FixtureHold,"ATTACHED_OR_DISK_DATABASE_FORBIDDEN"):
                    sut.snapshot_fixture(db)
                db.execute("DETACH DATABASE extra")
            finally:
                db.close()

    def test_rejects_unfinished_transaction_before_read(self):
        db=seed()
        db.execute("INSERT INTO jobs VALUES ('new','QUEUED',NULL)")
        with self.assertRaisesRegex(sut.FixtureHold,"UNFINISHED_FIXTURE_TRANSACTION"):
            sut.snapshot_fixture(db)
        db.rollback()
        db.close()

    def test_limit_fails_closed_instead_of_truncating(self):
        db=seed()
        original=sut.MAX_ROWS
        try:
            sut.MAX_ROWS=2
            with self.assertRaisesRegex(sut.FixtureHold,"FULL_LEDGER_SIZE_LIMIT"):
                sut.snapshot_fixture(db)
        finally:
            sut.MAX_ROWS=original
            db.close()


if __name__ == "__main__":
    unittest.main()
