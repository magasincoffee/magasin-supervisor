import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "src" / "coordinator" / "sot-preflight-python-bridge.py"
spec = importlib.util.spec_from_file_location("sc013_readonly_python_bridge", SCRIPT)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

SOURCE_ID = "github:magasincoffee/magasin-supervisor:issue:339"
BASE_ROW = {
    "source_id": SOURCE_ID, "source": "github",
    "task_id": "SC-013", "target": "supervisor", "action": "execute_task",
    "sot_url": bridge.SOT_URL, "status": "WAIT_SOT_AUTHORITY",
}


def make_db(path, rows):
    cx = sqlite3.connect(path)
    try:
        cx.execute(
            "CREATE TABLE dispatch_inbox (source_id TEXT PRIMARY KEY, source TEXT, "
            "task_id TEXT, target TEXT, action TEXT, sot_url TEXT, "
            "status TEXT, received_at TEXT)"
        )
        for i, row in enumerate(rows):
            cx.execute(
                "INSERT INTO dispatch_inbox VALUES (?,?,?,?,?,?,?,?)",
                (row["source_id"], row["source"], row["task_id"],
                 row["target"], row["action"], row["sot_url"],
                 row["status"], f"2026-10-09T08:{i:02d}:00Z"),
            )
        cx.commit()
    finally:
        cx.close()


class ReadOnlyBridgeTests(unittest.TestCase):
    def test_accepts_only_canonical_gateway_receipt_as_request(self):
        env = bridge.candidate_envelope(BASE_ROW)
        self.assertEqual(env["schema"], "MAGASIN_DISPATCH_V1")
        self.assertEqual(env["source_id"], SOURCE_ID)
        for change in [
            {"source": "supabase"}, {"action": "sync_revenue"},
            {"target": "saydi"}, {"task_id": "SC-014"},
            {"status": "READY"}, {"sot_url": "https://evil.example/sot"},
            {"source_id": "github:other/repo:issue:339"},
            {"source_id": "github:magasincoffee/magasin-supervisor:issue:0"},
        ]:
            self.assertIsNone(bridge.candidate_envelope({**BASE_ROW, **change}))
        self.assertIsNone(bridge.candidate_envelope(None))

    def test_wrong_machine_does_not_read_db_or_call_worker(self):
        result = bridge.run_once(
            hostname="DESKTOP-4K7IM13", inbox=Path("missing.sqlite3"),
            probe=lambda _: self.fail("probe called"),
        )
        self.assertEqual(result["probes"], 0)
        self.assertEqual(result["results"][0]["reason"], "WRONG_TARGET_MACHINE")

    def test_owner_stop_blocks_every_probe(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "STOP").write_text("", encoding="utf-8")
            result = bridge.run_once(
                hostname=bridge.MACHINE, inbox=root / "missing.db",
                stop_root=root, probe=lambda _: self.fail("probe called"),
            )
            self.assertEqual(result["probes"], 0)
            self.assertEqual(result["results"][0]["status"], "WAIT_OWNER_STOP")
            self.assertFalse(result["results"][0]["dispatched"])
            (root / "STOP").unlink()
            (root / "AUTOSTART_DISABLED").write_text("", encoding="utf-8")
            self.assertTrue(bridge.stop_present(root))

    def test_real_sqlite_access_is_read_only_and_bounded(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            db = root / "gateway.sqlite3"
            rows = [{**BASE_ROW, "source_id": BASE_ROW["source_id"][:-3] + str(400+i)}
                    for i in range(9)]
            rows.append({**BASE_ROW, "source_id": "github:magasincoffee/magasin-supervisor:issue:999",
                         "action": "health_check"})
            make_db(db, rows)
            observed = []
            def probe(env):
                observed.append(env)
                return bridge.result(
                    "SOT_READ_ONLY_CLASSIFIED", "PREFLIGHT_NOT_AUTHORIZATION",
                    source_id=env["source_id"], task_id=env["task_id"],
                )
            output = bridge.run_once(hostname=bridge.MACHINE, inbox=db,
                                     stop_root=root, probe=probe)
            self.assertEqual(output["probes"], 5)
            self.assertEqual(len(observed), 5)
            self.assertFalse(output["execution_enabled"])
            self.assertTrue(all(r["execution_qualified"] is False
                                and r["dispatched"] is False for r in output["results"]))
            with sqlite3.connect(db) as cx:
                self.assertEqual(cx.execute("SELECT COUNT(*) FROM dispatch_inbox").fetchone()[0], 10)
                self.assertEqual(
                    cx.execute("SELECT COUNT(*) FROM dispatch_inbox WHERE status='WAIT_SOT_AUTHORITY'")
                      .fetchone()[0], 10,
                )

    def test_database_missing_is_safe_and_honest(self):
        with tempfile.TemporaryDirectory() as d:
            out = bridge.run_once(hostname=bridge.MACHINE,
                                  inbox=Path(d) / "not-created.sqlite3",
                                  stop_root=Path(d))
            self.assertEqual(out["results"][0]["status"], "SOT_PREFLIGHT_UNAVAILABLE")
            self.assertEqual(out["probes"], 0)

    def test_missing_staged_node_cli_is_not_installed_implicitly(self):
        with tempfile.TemporaryDirectory() as d:
            result = bridge.probe_one(
                bridge.candidate_envelope(BASE_ROW),
                node=Path(d) / "node.exe", cli=Path(d) / "sot-preflight-cli.mjs",
                run=lambda *args, **kw: self.fail("started subprocess"),
            )
            self.assertEqual(result["reason"], "LOCAL_CLI_NOT_INSTALLED")
            self.assertFalse(result["dispatched"])

    def test_subprocess_uses_fixed_argv_no_shell_and_checks_response(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            node, cli = root / "node.exe", root / "sot-preflight-cli.mjs"
            node.write_text("", encoding="utf-8")
            cli.write_text("", encoding="utf-8")
            calls = []
            def fake_run(argv, **kw):
                calls.append((argv, kw))
                return SimpleNamespace(returncode=0, stdout=json.dumps({
                    "schema": "MAGASIN_SOT_ADAPTER_RESULT_V1",
                    "status": "SOT_PREFLIGHT_BLOCKED",
                    "reason": "TASK_NOT_READY",
                    "task_state": "IN PROGRESS",
                    "execution_qualified": False, "dispatched": False,
                }))
            response = bridge.probe_one(bridge.candidate_envelope(BASE_ROW),
                                        node=node, cli=cli, run=fake_run)
            self.assertEqual(response["status"], "SOT_READ_ONLY_CLASSIFIED")
            self.assertFalse(response["business_completed"])
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][0], [str(node), str(cli)])
            self.assertNotIn("shell", calls[0][1])
            self.assertEqual(calls[0][1]["timeout"], 12)
            self.assertEqual(json.loads(calls[0][1]["input"])["task_id"], "SC-013")

    def test_forged_cli_business_success_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            node, cli = root / "node.exe", root / "sot-preflight-cli.mjs"
            node.write_text("", encoding="utf-8")
            cli.write_text("", encoding="utf-8")
            def fake_run(argv, **kwargs):
                return SimpleNamespace(returncode=0, stdout=json.dumps({
                    "schema": "MAGASIN_SOT_ADAPTER_RESULT_V1",
                    "status": "SOT_PREFLIGHT_READY_NOT_AUTHORIZED",
                    "execution_qualified": True, "dispatched": True,
                }))
            response = bridge.probe_one(bridge.candidate_envelope(BASE_ROW),
                                        node=node, cli=cli, run=fake_run)
            self.assertEqual(response["reason"], "CLI_FAILED_CLOSED")
            self.assertFalse(response["execution_qualified"])
            self.assertFalse(response["dispatched"])


if __name__ == "__main__":
    unittest.main()
