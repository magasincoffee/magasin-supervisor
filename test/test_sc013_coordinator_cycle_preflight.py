import importlib.util
import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "src" / "coordinator" / "coordinator.py"
spec = importlib.util.spec_from_file_location("sc013_cycle_readonly", MODULE)
coord = importlib.util.module_from_spec(spec)
spec.loader.exec_module(coord)


class CoordinatorReadOnlyCycleTests(unittest.TestCase):
    def test_wrong_target_fails_without_subprocess(self):
        with tempfile.TemporaryDirectory() as d:
            file = Path(d) / "sot-preflight-python-bridge.py"
            file.write_text("fixture", encoding="utf-8")
            got = coord.safe_preflight_readonly(
                machine="DESKTOP-4K7IM13", bridge=file,
                run=lambda *a, **k: self.fail("unexpected subprocess"))
            self.assertEqual(got["status"], "WRONG_TARGET_MACHINE")
            self.assertFalse(got["execution_qualified"])
            self.assertFalse(got["dispatched"])

    def test_missing_readonly_bridge_never_dispatches(self):
        with tempfile.TemporaryDirectory() as d:
            got = coord.safe_preflight_readonly(
                machine="DESKTOP-H4A16IL", bridge=Path(d) / "missing.py",
                run=lambda *a, **k: self.fail("unexpected subprocess"))
            self.assertEqual(got["status"], "BRIDGE_NOT_INSTALLED")
            self.assertFalse(got["business_completed"])

    def test_valid_live_sot_blocked_result_is_display_only(self):
        with tempfile.TemporaryDirectory() as d:
            file = Path(d) / "sot-preflight-python-bridge.py"
            file.write_text("fixture", encoding="utf-8")
            calls = []
            reply = {
                "mode": "READ_ONLY", "machine": "DESKTOP-H4A16IL",
                "execution_enabled": False, "probes": 1,
                "results": [{
                    "schema": "MAGASIN_PYTHON_PREFLIGHT_BRIDGE_V1",
                    "status": "SOT_READ_ONLY_CLASSIFIED",
                    "reason": "PREFLIGHT_NOT_AUTHORIZATION",
                    "source_id": "github:magasincoffee/magasin-supervisor:issue:339",
                    "task_id": "SC-013",
                    "execution_qualified": False, "dispatched": False,
                    "business_completed": False,
                    "evidence": {
                        "status": "SOT_PREFLIGHT_BLOCKED",
                        "reason": "TASK_NOT_READY",
                        "task_state": "IN PROGRESS", "revision": "a" * 40
                    },
                }],
            }
            def fake_run(argv, **kwargs):
                calls.append((argv, kwargs))
                return SimpleNamespace(returncode=0, stdout=json.dumps(reply))
            got = coord.safe_preflight_readonly(
                machine="DESKTOP-H4A16IL", bridge=file, run=fake_run)
            self.assertEqual(got["status"], "READ_ONLY_CLASSIFIED")
            self.assertEqual(got["probes"], 1)
            self.assertEqual(got["results"][0]["sot_state"], "IN PROGRESS")
            self.assertEqual(got["results"][0]["sot_reason"], "TASK_NOT_READY")
            self.assertFalse(got["dispatched"])
            self.assertFalse(got["execution_qualified"])
            self.assertEqual(calls[0][0], [coord.sys.executable, str(file)])
            self.assertEqual(calls[0][1]["timeout"], 11)
            self.assertNotIn("shell", calls[0][1])
            self.assertTrue(calls[0][1]["capture_output"])

    def test_malicious_bridge_cannot_claim_execution_or_business_done(self):
        with tempfile.TemporaryDirectory() as d:
            file = Path(d) / "sot-preflight-python-bridge.py"
            file.write_text("fixture", encoding="utf-8")
            cases = [
                {"mode":"READ_ONLY","machine":"DESKTOP-H4A16IL","execution_enabled":True,
                 "probes":0,"results":[]},
                {"mode":"READ_ONLY","machine":"DESKTOP-H4A16IL","probes":1,
                 "results":[{"schema":"MAGASIN_PYTHON_PREFLIGHT_BRIDGE_V1",
                             "execution_qualified":True,"dispatched":False,"business_completed":False}]},
                {"mode":"READ_ONLY","machine":"DESKTOP-H4A16IL","probes":1,
                 "results":[{"schema":"MAGASIN_PYTHON_PREFLIGHT_BRIDGE_V1",
                             "execution_qualified":False,"dispatched":True,"business_completed":False}]},
                {"mode":"READ_ONLY","machine":"DESKTOP-H4A16IL","probes":1,
                 "results":[{"schema":"MAGASIN_PYTHON_PREFLIGHT_BRIDGE_V1",
                             "execution_qualified":False,"dispatched":False,"business_completed":True}]},
                {"mode":"DISPATCHING","machine":"DESKTOP-H4A16IL","probes":0,"results":[]},
                {"mode":"READ_ONLY","machine":"DESKTOP-H4A16IL","probes":100,"results":[]},
            ]
            for payload in cases:
                out=coord.safe_preflight_readonly(
                    machine="DESKTOP-H4A16IL", bridge=file,
                    run=lambda *a, data=payload, **k: SimpleNamespace(
                        returncode=0, stdout=json.dumps(data)))
                self.assertEqual(out["status"], "BRIDGE_FAILED_CLOSED")
                self.assertFalse(out["dispatched"])

    def test_timeout_and_bad_json_are_bounded_and_fail_closed(self):
        with tempfile.TemporaryDirectory() as d:
            file=Path(d)/"bridge.py"
            file.write_text("fixture",encoding="utf-8")
            for runner in [
                lambda *a, **k: (_ for _ in ()).throw(subprocess.TimeoutExpired("py",11)),
                lambda *a, **k: SimpleNamespace(returncode=0,stdout="{"),
                lambda *a, **k: SimpleNamespace(returncode=0,stdout="x"*20_000),
            ]:
                got=coord.safe_preflight_readonly(
                    machine="DESKTOP-H4A16IL",bridge=file,run=runner)
                self.assertEqual(got["status"],"BRIDGE_FAILED_CLOSED")
                self.assertFalse(got["execution_qualified"])

    def test_real_once_keeps_same_ledger_and_owner_off_with_only_readonly_preflight_field(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            rows=[{"source_id":"github:magasincoffee/magasin-supervisor:issue:339",
                   "task_id":"SC-013","target":"supervisor","action":"execute_task",
                   "sot_url":"https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md",
                   "status":"WAIT_SOT_AUTHORITY"}]
            with (patch.object(coord,"LEDGER",root/"plans.sqlite3"),
                  patch.object(coord,"REPORT",root/"coordinator-status.json"),
                  patch.object(coord,"input_jobs",return_value=rows),
                  patch.object(coord,"flags",return_value={
                      "supervisor":False,"saydi":False,"sapo":False}),
                  patch.object(coord,"safe_preflight_readonly",return_value={
                      "status":"READ_ONLY_CLASSIFIED","probes":1,
                      "execution_qualified":False,"dispatched":False,
                      "business_completed":False,"results":[]})):
                out=coord.once()
            self.assertEqual(out["mode"],"OFF_OWNER_MANUAL")
            self.assertFalse(out["execution_enabled"])
            self.assertEqual(out["states"]["WAIT_OWNER_ENABLE"],1)
            self.assertFalse(out["sot_preflight"]["dispatched"])
            self.assertIn("SOT",out["limitations"])
            recorded=json.loads((root/"coordinator-status.json").read_text(encoding="utf-8"))
            self.assertEqual(recorded["sot_preflight"]["status"],"READ_ONLY_CLASSIFIED")
            with sqlite3.connect(root/"plans.sqlite3") as cx:
                self.assertEqual(cx.execute("SELECT stage FROM plans").fetchone()[0],
                                 "WAIT_OWNER_ENABLE")


if __name__=="__main__":
    unittest.main()
