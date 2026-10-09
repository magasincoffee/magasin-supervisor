"""SC-013 non-production durable Business Executor fixture regression.

Never imports the live Coordinator, Gateway, Supervisor or network connector.
Every disk write is restricted to an OS-temporary disposable fixture directory.
"""
import importlib.util
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "src" / "coordinator" / "disposable_business_executor.py"
spec = importlib.util.spec_from_file_location("sc013_disposable_fixture", MODULE)
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)
DIGEST = "e" * 64


class BusinessExecutorFixtureTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="sc013_fixture_")
        self.addCleanup(self.directory.cleanup)
        self.db = Path(self.directory.name) / "simulation.sqlite3"
        self.clock = [1000.0]
        self.fixture = fx.DisposableExecutor(self.db, fixture_only=True,
                                             clock=lambda: self.clock[0])
        self.request = fx.synthetic_request()
        self.guards = fx.synthetic_guards()

    def claim(self, *, request=None, guards=None):
        return self.fixture.claim(request or self.request, guards or self.guards)

    def test_requires_explicit_fixture_mode_and_os_temp_database(self):
        with self.assertRaisesRegex(fx.FixtureRejected, "EXPLICIT_FIXTURE_OPT_IN_REQUIRED"):
            fx.DisposableExecutor(self.db)
        with self.assertRaisesRegex(fx.FixtureRejected, "TEMP_DIRECTORY_ONLY"):
            fx.DisposableExecutor(Path.home() / "prod_coordinator.sqlite3", fixture_only=True)
        self.assertTrue(self.db.is_file())

    def test_synthetic_claim_ack_qa_finalize_without_external_effect(self):
        claim = self.claim()
        self.assertFalse(claim["duplicate"])
        self.assertEqual(claim["stage"], "CLAIMED")
        self.assertFalse(claim["execution_qualified"])
        self.assertFalse(claim["production_dispatch"])
        self.assertFalse(claim["external_effects"])
        receipt = "fixture-ack:" + ("f" * 32)
        ack = self.fixture.ack(self.request["source_id"], claim["token"],
                               worker_receipt=receipt, guards=self.guards)
        self.assertEqual(ack["stage"], "ACKED")
        finished = self.fixture.finish(self.request["source_id"], claim["token"],
                                       output_digest=DIGEST, qa_passed=True,
                                       guards=self.guards)
        self.assertEqual(finished["stage"], "COMPLETE_FIXTURE_ONLY")
        self.assertEqual(finished["qa"], "PASS_FIXTURE_ONLY")
        duplicate = self.claim()
        self.assertTrue(duplicate["duplicate"])
        self.assertIsNone(duplicate["token"])
        self.assertEqual(duplicate["stage"], "COMPLETE_FIXTURE_ONLY")
        with sqlite3.connect(self.db) as cx:
            self.assertEqual(cx.execute("SELECT COUNT(*) FROM fixture_runs").fetchone()[0], 1)

    def test_duplicate_claim_is_not_a_duplicate_dispatch_even_before_ack(self):
        first = self.claim()
        second = self.claim()
        self.assertEqual(first["stage"], "CLAIMED")
        self.assertIsNone(second["token"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(second["attempts"], 1)

    def test_restart_recovery_does_not_replay_expired_unknown_claim(self):
        original = self.claim()
        self.clock[0] += 61
        restarted = fx.DisposableExecutor(self.db, fixture_only=True,
                                          clock=lambda: self.clock[0])
        ambiguous = restarted.reconcile_uncertain(self.request["source_id"])
        self.assertEqual(ambiguous["stage"], "BLOCKED_UNKNOWN_OUTCOME")
        self.assertFalse(ambiguous["production_dispatch"])
        duplicate = restarted.claim(self.request, self.guards)
        self.assertEqual(duplicate["stage"], "BLOCKED_UNKNOWN_OUTCOME")
        self.assertIsNone(duplicate["token"])
        with self.assertRaisesRegex(fx.FixtureRejected, "ACK_NOT_SAFE"):
            restarted.ack(self.request["source_id"], original["token"],
                          worker_receipt="fixture-ack:" + ("f"*32),
                          guards=self.guards)

    def test_revision_conflict_never_claims_second_turn_for_same_source_id(self):
        first = self.claim()
        other = {**self.request, "revision": "c" * 40}
        conflict = self.fixture.claim(other, self.guards)
        self.assertEqual(conflict["stage"], "BLOCKED_REVISION_CONFLICT")
        self.assertFalse(conflict["production_dispatch"])
        self.assertEqual(self.fixture.inspect(self.request["source_id"])["attempts"], 1)
        self.assertIsNotNone(first["token"])

    def test_owner_stop_off_worker_not_alive_and_fake_production_guards_are_rejected(self):
        for guards in [
            fx.synthetic_guards(stop=True),
            fx.synthetic_guards(owner_enabled=False),
            fx.synthetic_guards(worker_enabled=False),
            fx.synthetic_guards(worker_alive=False),
            {**self.guards, "machine":"DESKTOP-H4A16IL"},
            {**self.guards, "schema":"MAGASIN_OWNER_PROD_V1"},
            {**self.guards, "extra_authorize":True},
        ]:
            with self.assertRaises(fx.FixtureRejected):
                self.claim(guards=guards)
        with sqlite3.connect(self.db) as cx:
            self.assertEqual(cx.execute("SELECT COUNT(*) FROM fixture_runs").fetchone()[0], 0)

    def test_real_issue_gateway_and_code_injection_payloads_are_always_rejected(self):
        invalid = [
            {**self.request, "source_id":"github:magasincoffee/magasin-supervisor:issue:339"},
            {**self.request, "action":"execute_task"},
            {**self.request, "target":"supervisor"},
            {**self.request, "fixture_sot_state":"READY"},
            {**self.request, "task_id":"OPS-075"},
            {**self.request, "command":"start-supervisor"},
            {**self.request, "sot_url":"https://github.com/magasincoffee/magasin-supervisor"},
            {**self.request, "revision":"old-main"},
            {**self.request, "cpu_budget_seconds":0},
            {**self.request, "cpu_budget_seconds":5000},
            {**self.request, "memory_budget_mb":100000},
            {**self.request, "memory_budget_mb":True},
        ]
        for request in invalid:
            with self.subTest(request=request):
                with self.assertRaises(fx.FixtureRejected):
                    self.claim(request=request)
        with sqlite3.connect(self.db) as cx:
            self.assertEqual(cx.execute("SELECT COUNT(*) FROM fixture_runs").fetchone()[0], 0)

    def test_ack_cannot_claim_real_worker_identity_or_skip_nonce(self):
        first = self.claim()
        for token,receipt in [
            ("f"*48, "fixture-ack:" + "f"*32),
            (first["token"], "prod-worker-ack"),
            (first["token"], "fixture-ack:bad"),
        ]:
            with self.assertRaises(fx.FixtureRejected):
                self.fixture.ack(self.request["source_id"],token,
                                 worker_receipt=receipt,guards=self.guards)
        self.assertEqual(self.fixture.inspect(self.request["source_id"])["stage"], "CLAIMED")

    def test_qa_failure_and_no_ack_cannot_complete(self):
        first = self.claim()
        with self.assertRaisesRegex(fx.FixtureRejected, "FINALIZE_NOT_SAFE"):
            self.fixture.finish(self.request["source_id"], first["token"],
                                output_digest=DIGEST,qa_passed=True,guards=self.guards)
        self.fixture.ack(self.request["source_id"],first["token"],
                         worker_receipt="fixture-ack:"+("d"*32),guards=self.guards)
        for digest,qa in [(DIGEST,False),("wrong",True),(DIGEST,"true")]:
            with self.assertRaisesRegex(fx.FixtureRejected, "FIXTURE_QA_NOT_PASS"):
                self.fixture.finish(self.request["source_id"],first["token"],
                                    output_digest=digest,qa_passed=qa,guards=self.guards)
        self.assertEqual(self.fixture.inspect(self.request["source_id"])["stage"],"ACKED")

    def test_stop_arriving_after_claim_prevents_ack_and_finalize(self):
        first = self.claim()
        with self.assertRaisesRegex(fx.FixtureRejected, "OWNER_STOP"):
            self.fixture.ack(self.request["source_id"], first["token"],
                             worker_receipt="fixture-ack:"+("d"*32),
                             guards=fx.synthetic_guards(stop=True))
        self.assertEqual(self.fixture.inspect(self.request["source_id"])["stage"], "CLAIMED")

    def test_concurrent_threads_can_acquire_only_one_claim(self):
        barrier=threading.Barrier(5)
        results=[]
        errors=[]
        gate=threading.Lock()
        def claim_worker():
            try:
                barrier.wait(timeout=4)
                reply=self.fixture.claim(self.request,self.guards)
                with gate:
                    results.append(reply)
            except Exception as e:
                with gate:
                    errors.append(str(e))
        threads=[threading.Thread(target=claim_worker,daemon=True) for _ in range(5)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=6)
        self.assertFalse(errors, errors)
        self.assertEqual(len(results),5)
        self.assertEqual(sum(not r["duplicate"] for r in results),1)
        self.assertEqual(sum(r["token"] is not None for r in results),1)

    def test_never_exports_live_task_result_as_real_completion(self):
        result=self.claim()
        self.assertFalse(result["execution_qualified"])
        self.assertFalse(result["production_dispatch"])
        self.assertEqual(result["schema"],fx.SCHEMA)
        self.assertNotIn("github_writeback",result)
        self.assertNotIn("worker_process_id",result)


if __name__ == "__main__":
    unittest.main()
