import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "src" / "coordinator" / "owner_lifecycle.py"
spec = importlib.util.spec_from_file_location("sc013_owner_readonly_lifecycle", SCRIPT)
lifecycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle)
NOW = datetime(2026, 10, 9, 10, 10, 35, tzinfo=timezone.utc)


def dump(path, object):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(object), encoding="utf-8")


class OwnerLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.lstate = self.root / "owner-lifecycle.json"
        self.lock = self.root / "owner-lifecycle.lock"
        self.report = self.root / "report.json"
        self.tick = self.root / "tick.json"
        self.flags = self.root / "flags.json"
        self.supervisor = self.root / "supervisor"
        self.supervisor.mkdir()
        dump(self.report, {"mode": "OFF_OWNER_MANUAL", "execution_enabled": False})
        dump(self.flags, {"supervisor": False, "saydi": False, "sapo": False})
        dump(self.tick, {"schema": "MAGASIN_LOCAL_30M_TICK_V1",
                         "target": lifecycle.MACHINE, "executor": "local_windows_scheduler",
                         "completed_at": (NOW - timedelta(seconds=10)).isoformat(),
                         "actions": [{"name": "gateway", "state": "PASS", "exit_code": 0},
                                     {"name": "coordinator_classify", "state": "PASS", "exit_code": 0}],
                         "errors": []})
        self.ctx = dict(host=lifecycle.MACHINE, now=NOW, memory_gib=1.8,
                        lifecycle_file=self.lstate, lock_file=self.lock, report_file=self.report,
                        tick_file=self.tick, specialists_file=self.flags,
                        supervisor_root=self.supervisor)

    def test_no_saved_state_is_stopped_and_does_not_enable_execution(self):
        status = lifecycle.evaluate(**self.ctx)
        self.assertTrue(status["start_allowed"])
        self.assertEqual(status["status"], "OWNER_STOPPED")
        self.assertFalse(status["execution_enabled"])
        self.assertFalse(status["business_dispatch_enabled"])
        self.assertFalse(status["specialists_started"])

    def test_start_is_armed_until_an_independent_later_scheduled_tick(self):
        dump(self.lstate, {"schema": lifecycle.SCHEMA, "desired": "MONITOR_READ_ONLY",
                            "requested_at": NOW.isoformat(), "generation": 1,
                            "execution_enabled": False, "business_dispatch_enabled": False})
        first = lifecycle.evaluate(**self.ctx)
        self.assertEqual(first["status"], "ARMED_READ_ONLY")
        data = lifecycle.read_json(self.tick)
        data["completed_at"] = (NOW + timedelta(seconds=5)).isoformat()
        dump(self.tick, data)
        second = lifecycle.evaluate(**{**self.ctx, "now": NOW + timedelta(seconds=10)})
        self.assertEqual(second["status"], "MONITORING_READ_ONLY")
        self.assertFalse(second["business_dispatch_enabled"])

    def test_stale_missing_and_malformed_ticks_fail_closed(self):
        data = lifecycle.read_json(self.tick)
        for update in [
            {"errors": ["failure"]},
            {"completed_at": (NOW - timedelta(hours=3)).isoformat()},
            {"actions": [None, {"name": "coordinator_classify", "state": "PASS", "exit_code": 0}]},
            {"executor": "fake_chatgpt_monitor"},
        ]:
            dump(self.tick, {**data, **update})
            self.assertIn("TECHNICAL_HEARTBEAT_NOT_QUALIFIED", lifecycle.evaluate(**self.ctx)["blockers"])

    def test_stop_latches_low_memory_and_unqualified_flags_block_start(self):
        dump(self.flags, {"supervisor": True, "saydi": False, "sapo": False})
        self.assertFalse(lifecycle.evaluate(**self.ctx)["start_allowed"])
        dump(self.flags, {"supervisor": False, "saydi": False, "sapo": False})
        self.assertIn("LOW_AVAILABLE_RAM", lifecycle.evaluate(**{**self.ctx, "memory_gib": 0.3})["blockers"])
        (self.supervisor / "STOP").touch()
        self.assertIn("SUPERVISOR_STOP_LATCH", lifecycle.evaluate(**self.ctx)["blockers"])

    def test_wrong_machine_and_lock_block_start(self):
        self.assertFalse(lifecycle.evaluate(**{**self.ctx, "host": "DESKTOP-4K7IM13"})["start_allowed"])
        self.lock.touch()
        self.assertIn("LIFECYCLE_LOCK_PRESENT", lifecycle.evaluate(**self.ctx)["blockers"])

    def test_atomic_state_write_and_stop_keep_execution_immutable_false(self):
        with patch.object(lifecycle, "CONTROL_STATE", self.lstate):
            record = {"schema": lifecycle.SCHEMA, "generation": 1, "desired": "STOP",
                      "execution_enabled": False, "business_dispatch_enabled": False}
            lifecycle._write_atomic(self.lstate, record)
            self.assertEqual(lifecycle.read_json(self.lstate), record)
            self.assertFalse(self.lstate.with_suffix(".pending").exists())

    def test_perform_denies_untrusted_caller_and_forged_confirmation(self):
        code, answer = lifecycle.perform("start", "START_SUPERVISOR", source="local_control_center")
        self.assertEqual(code, 400)
        self.assertFalse(answer["ok"])
        code, answer = lifecycle.perform("start", "START_COORDINATOR_READ_ONLY", source="github_issue")
        self.assertEqual(code, 400)
        self.assertFalse(answer["ok"])

    def test_start_and_stop_are_one_owner_generation_each_never_a_business_launch(self):
        with (patch.object(lifecycle.socket, "gethostname", return_value=lifecycle.MACHINE),
              patch.object(lifecycle, "CONTROL_STATE", self.lstate),
              patch.object(lifecycle, "LOCK_PATH", self.lock),
              patch.object(lifecycle, "evaluate", return_value={
                  "start_allowed": True, "blockers": [], "status": "OWNER_STOPPED"})):
            code, started = lifecycle.perform("start", "START_COORDINATOR_READ_ONLY",
                                               source="local_control_center")
            self.assertEqual(code, 200)
            self.assertEqual(started["desired"], "MONITOR_READ_ONLY")
            self.assertFalse(started["execution_enabled"])
            self.assertFalse(started["business_dispatch_enabled"])
            code, stopped = lifecycle.perform("stop", "STOP_COORDINATOR",
                                               source="local_control_center")
            self.assertEqual(code, 200)
            self.assertEqual(stopped["desired"], "STOP")
            self.assertEqual(stopped["generation"], 2)
            self.assertFalse(self.lock.exists())
            self.assertFalse(lifecycle.read_json(self.lstate)["business_dispatch_enabled"])

    def test_start_refuses_safety_preflight_but_stop_is_always_available_locally(self):
        with (patch.object(lifecycle.socket, "gethostname", return_value=lifecycle.MACHINE),
              patch.object(lifecycle, "CONTROL_STATE", self.lstate),
              patch.object(lifecycle, "LOCK_PATH", self.lock),
              patch.object(lifecycle, "evaluate", return_value={
                  "start_allowed": False, "blockers": ["LOW_AVAILABLE_RAM"]})):
            code, reply = lifecycle.perform("start", "START_COORDINATOR_READ_ONLY",
                                             source="local_control_center")
            self.assertEqual(code, 409)
            self.assertFalse(self.lstate.exists())
            code, stopped = lifecycle.perform("stop", "STOP_COORDINATOR",
                                               source="local_control_center")
            self.assertEqual(code, 200)
            self.assertEqual(stopped["desired"], "STOP")


if __name__ == "__main__":
    unittest.main()
