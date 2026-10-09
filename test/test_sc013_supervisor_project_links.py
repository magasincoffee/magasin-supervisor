# -*- coding: utf-8 -*-
"""SC-013 Supervisor Owner-selected SOT links. No production worker or HTTP."""
import hashlib
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

MOD = Path(__file__).resolve().parents[1] / "src" / "control-center" / "supervisor_project_links.py"
spec = importlib.util.spec_from_file_location("sc013_supervisor_project_links", MOD)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
WORKFORCE = (
    "https://github.com/magasincoffee/magasincoffee.github.io/blob/main/"
    "01_DOCS/MAGASIN/05_SYSTEM/WORKFORCE_CROSS_STORE_SCHEDULING_TEMP_SOURCE_OF_TRUTH.md"
)
OPS = "https://github.com/magasincoffee/OPS-WebApp/blob/main/SOURCE_OF_TRUTH.md"
SELF = "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md"


class ProjectLinkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="sc013-project-links-")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.stop = root / "supervisor"
        self.stop.mkdir()
        (self.stop / "STOP").touch()
        (self.stop / "AUTOSTART_DISABLED").touch()
        self.ctrl = self.stop / "single-conversation-control.json"
        self.ctrl.write_text(json.dumps({
            "schema_version":"single-conversation-control.v1",
            "mode":"SINGLE_CONVERSATION_V1",
            "project_id":"WORKFORCE-CROSS-STORE",
            "source_of_truth_url":WORKFORCE,
            "updated_at":"2026-10-09T08:03:39+00:00",
        }),encoding="utf-8")
        self.pending = root / "project_sot_requests.json"
        self.args={"current":self.ctrl,"requests":self.pending,
                   "stop_root":self.stop,"machine":m.HOST}

    def check(self):
        return m.inspect(**self.args)

    def save(self,url=OPS,confirm="SAVE_SUPERVISOR_SOT_LINK_ONLY", **change):
        return m.save_request(url,confirm,**{**self.args,**change})

    def test_current_live_workforce_sot_is_discovered_but_not_qualified_to_run(self):
        state=self.check()
        self.assertEqual(state["active"]["sot_url"],WORKFORCE)
        self.assertEqual(state["active"]["repository"],"magasincoffee/magasincoffee.github.io")
        self.assertEqual(state["active"]["project_id"],"WORKFORCE-CROSS-STORE")
        self.assertEqual(state["active"]["binding"],"CONFIGURED_IN_RUNTIME_NOT_RUNNING")
        self.assertTrue(state["save_allowed"])
        self.assertFalse(state["worker_start_allowed"])
        self.assertFalse(state["business_dispatch_authorized"])
        self.assertFalse(state["new_link_activates_project"])

    def test_save_new_project_is_pending_only_and_cannot_change_active_sot(self):
        before=self.ctrl.read_bytes()
        saved=self.save()
        self.assertTrue(saved["ok"])
        self.assertEqual(saved["status"],"PENDING_SOT_REVIEW")
        self.assertFalse(saved["new_link_activates_project"])
        self.assertFalse(saved["execution_authorized"])
        self.assertEqual(self.ctrl.read_bytes(),before)
        data=json.loads(self.pending.read_text())
        self.assertEqual(data["schema"],m.REQUEST_SCHEMA)
        self.assertEqual(len(data["requests"]),1)
        self.assertEqual(data["requests"][0]["url"],OPS)
        state=self.check()
        self.assertEqual(state["active"]["sot_url"],WORKFORCE)
        self.assertEqual(state["requests"][0]["repository"],"magasincoffee/OPS-WebApp")
        self.assertEqual(state["requests"][0]["status"],"PENDING_SOT_REVIEW")

    def test_duplicates_are_idempotent_and_existing_active_link_never_mutates(self):
        self.assertEqual(self.save(WORKFORCE)["status"],"ALREADY_LINKED_ACTIVE")
        self.assertFalse(self.pending.exists())
        self.assertEqual(self.save()["status"],"PENDING_SOT_REVIEW")
        before=self.pending.read_bytes()
        self.assertEqual(self.save()["status"],"ALREADY_PENDING_REVIEW")
        self.assertEqual(self.pending.read_bytes(),before)

    def test_multiple_project_links_preserve_first_created_at(self):
        self.save(OPS,when=datetime(2026,10,10,2,0,tzinfo=timezone.utc))
        self.save(SELF,when=datetime(2026,10,10,2,5,tzinfo=timezone.utc))
        data=json.loads(self.pending.read_text())
        self.assertEqual(len(data["requests"]),2)
        self.assertEqual(data["requests"][0]["created_at"],
                         "2026-10-10T02:00:00+00:00")
        self.assertEqual(data["requests"][1]["created_at"],
                         "2026-10-10T02:05:00+00:00")

    def test_sot_url_allowlist_rejects_raw_code_links_and_hostile_hosts(self):
        bad=[
            "https://evil.example/magasincoffee/OPS-WebApp/blob/main/SOURCE_OF_TRUTH.md",
            "http://github.com/magasincoffee/OPS-WebApp/blob/main/SOURCE_OF_TRUTH.md",
            "https://github.com.evil.example/magasincoffee/OPS-WebApp/blob/main/SOURCE_OF_TRUTH.md",
            "https://example@gmail.com@github.com/magasincoffee/OPS-WebApp/blob/main/SOURCE_OF_TRUTH.md",
            "https://github.com:443/magasincoffee/OPS-WebApp/blob/main/SOURCE_OF_TRUTH.md",
            "https://github.com/magasincoffee/OPS-WebApp/blob/dev/SOURCE_OF_TRUTH.md",
            "https://github.com/another-owner/OPS-WebApp/blob/main/SOURCE_OF_TRUTH.md",
            "https://github.com/magasincoffee/OPS-WebApp/blob/main/README.md",
            "https://github.com/magasincoffee/OPS-WebApp/tree/main/SOURCE_OF_TRUTH.md",
            "https://github.com/magasincoffee/OPS-WebApp/blob/main/../SOURCE_OF_TRUTH.md",
            "https://github.com/magasincoffee/OPS-WebApp/blob/main/%2e%2e/SOURCE_OF_TRUTH.md",
            OPS+"?token=secret",
            OPS+"#L1",
            OPS+" ",
            "file:///C:/secrets/SOURCE_OF_TRUTH.md",
            "javascript:alert(1)",
            "https://raw.githubusercontent.com/magasincoffee/OPS-WebApp/main/SOURCE_OF_TRUTH.md",
            "",
        ]
        for url in bad:
            with self.subTest(url=url):
                with self.assertRaises(m.Rejected):
                    m.parse_sot_url(url)
                self.assertFalse(self.pending.exists())

    def test_owner_stop_requires_both_persistent_latches(self):
        (self.stop/"STOP").unlink()
        state=self.check()
        self.assertEqual(state["active"]["sot_url"],WORKFORCE)
        self.assertFalse(state["save_allowed"])
        with self.assertRaisesRegex(m.Rejected,"OWNER_STOP_OR_BINDING_UNVERIFIED"):
            self.save()
        self.assertFalse(self.pending.exists())
        (self.stop/"STOP").touch()
        (self.stop/"AUTOSTART_DISABLED").unlink()
        self.assertFalse(self.check()["save_allowed"])

    def test_wrong_host_or_confirmation_cannot_write(self):
        with self.assertRaisesRegex(m.Rejected,"OWNER_STOP_OR_BINDING_UNVERIFIED"):
            self.save(machine="DESKTOP-4K7IM13")
        with self.assertRaisesRegex(m.Rejected,"OWNER_CONFIRM_REQUIRED"):
            self.save(confirm="START_SUPERVISOR")
        self.assertFalse(self.pending.exists())

    def test_corrupt_or_mismatched_active_runtime_fails_closed(self):
        self.ctrl.write_text('{"schema_version":"legacy"}')
        self.assertEqual(self.check()["blockers"],["ACTIVE_SOT_NOT_QUALIFIED"])
        with self.assertRaisesRegex(m.Rejected,"OWNER_STOP_OR_BINDING_UNVERIFIED"):
            self.save()
        self.assertFalse(self.pending.exists())

    def test_corrupt_registry_cannot_be_overwritten_silently(self):
        self.pending.write_text('{"schema":"forged","requests":[]}')
        self.assertEqual(self.check()["blockers"],["REQUEST_REGISTRY_NOT_TRUSTED"])
        original=self.pending.read_bytes()
        with self.assertRaises(m.Rejected):
            self.save()
        self.assertEqual(self.pending.read_bytes(),original)

    def test_symlink_registry_is_blocked_without_touching_target(self):
        link_target=self.pending.parent/"untouched.json"
        link_target.write_text('{"private":"do-not-change"}')
        try:
            self.pending.symlink_to(link_target)
        except (OSError,NotImplementedError):
            return
        self.assertEqual(self.check()["blockers"],["REQUEST_REGISTRY_NOT_TRUSTED"])
        with self.assertRaises(m.Rejected):
            self.save()
        self.assertEqual(link_target.read_text(),'{"private":"do-not-change"}')

    def test_zero_url_network_calls_zero_worker_actions(self):
        import inspect
        source=inspect.getsource(m)
        for forbidden in ("subprocess", "Popen(", "os.system", "urllib.request",
                          "Start-ScheduledTask", "Stop-Process", "requests.post",
                          "session.post", "control_adapter.perform"):
            self.assertNotIn(forbidden,source)
        self.assertNotIn('open(current, "w")',source)
        self.assertFalse(self.save()["execution_authorized"])


if __name__=="__main__":
    unittest.main()
