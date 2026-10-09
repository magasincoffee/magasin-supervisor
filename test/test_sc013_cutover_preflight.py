"""SC-013 MIG-CC-01 pre-cutover dashboard: privacy and no-actuator tests."""
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "src" / "control-center" / "cutover_preflight.py"
spec = importlib.util.spec_from_file_location("sc013_cutover_preflight", SOURCE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ReadOnlyCutoverTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix="sc013_readiness_")
        self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)
        self.log_dir=self.path/"logs"
        self.log_dir.mkdir()
        self.state=self.path/"state.json"
        self.state.write_text(json.dumps({
            "pending":{"target_date":"2026-10-08",
                       "export_url":"https://private.example/?token=secret",
                       "raw_path":"C:\\confidential\\customer.xlsx"},
            "last_success":{"result":"success","export_url":"private-token-123"},
        }))
        (self.log_dir/"diagnostic_run_2026-10-08_20261009_103003.log").write_text(
            "error LOGIN_REQUIRED for name@example.com token secret",encoding="utf-8")
        (self.log_dir/"diagnostic_run_2026-10-07_20261008_103608.log").write_text(
            "timed out while calling private account",encoding="utf-8")
        self.params={
            "sapo_state_path":self.state,
            "sapo_logs_dir":self.log_dir,
            "supervisor_state":{"outbound":{"state":"ENQUEUED",
                "last_error_code":"AMBIGUOUS_ENQUEUED_OUTCOME"}},
            "supervisor_stop":True,
            "supervisor_autostart_disabled":True,
            "saydi":{"chapter2":{"stage":"REVIEW_READY"},"worker":False,
                     "account":"private-account"},
            "ram_free_gib":2.76,
            "legacy_auto_start_present":True,
            "now":datetime(2026,10,9,22,15,tzinfo=timezone.utc),
        }

    def inspect(self, **diff):
        return m.inspect(**{**self.params,**diff})

    def test_realistic_host_risk_never_promotes_owner_lifecycle(self):
        r=self.inspect()
        self.assertEqual(r["schema"],m.SCHEMA)
        self.assertEqual(r["milestone_status"],"IN_PROGRESS")
        self.assertEqual(r["status"],"BLOCKED_NOT_QUALIFIED")
        for key in ("qualified","cutover_allowed","business_dispatch_enabled",
                    "owner_start_authorized","production_effects"):
            self.assertIs(r[key],False)
        self.assertIn("SUPERVISOR_STOP_LATCH_PRESENT_OR_UNKNOWN",r["robots"]["supervisor"]["blockers"])
        self.assertIn("SUPERVISOR_OUTBOUND_UNKNOWN_OUTCOME_NO_RESEND",r["robots"]["supervisor"]["blockers"])
        self.assertIn("SAYDI_CHAPTER_REVIEW_NOT_FINAL",r["robots"]["saydi"]["blockers"])
        self.assertIn("SAPO_PENDING_EXPORT_NOT_RECONCILED",r["robots"]["sapo"]["blockers"])
        self.assertEqual(r["robots"]["sapo"]["pending_export_evidence"],"PRESENT")
        self.assertIn("LOGIN_OR_AUTH",r["robots"]["sapo"]["log_failure_classes"])
        self.assertIn("TIMEOUT",r["robots"]["sapo"]["log_failure_classes"])

    def test_no_sensitive_urls_emails_paths_or_token_content_is_returned(self):
        result=json.dumps(self.inspect(),ensure_ascii=False)
        for private in ("private.example","private-token","name@example.com",
                        "customer.xlsx","2026-10-08","token secret","private-account"):
            self.assertNotIn(private,result)
        self.assertNotIn("export_url",result)
        self.assertNotIn("raw_path",result)
        self.assertNotIn("diagnostic_run_2026",result)

    def test_no_pending_and_no_log_still_not_verified_financially(self):
        self.state.write_text('{"pending":{},"last_success":{}}')
        for p in self.log_dir.glob("*"):
            p.unlink()
        r=self.inspect(supervisor_stop=False,supervisor_autostart_disabled=False,
                       supervisor_state={"outbound":{"state":"DONE_CONFIRMED"}},
                       legacy_auto_start_present=False,
                       saydi={"chapter2":{"stage":"FINAL"},"worker":False},
                       ram_free_gib=9)
        self.assertFalse(r["cutover_allowed"])
        self.assertIn("SAPO_FINANCIAL_CHECKPOINT_UNVERIFIED",r["robots"]["sapo"]["blockers"])
        self.assertIn("SAPO_LOGS_UNAVAILABLE",r["robots"]["sapo"]["blockers"])
        self.assertIn("SAYDI_CHAPTER_CHECKPOINT_UNVERIFIED",r["robots"]["saydi"]["blockers"])
        self.assertIn("SUPERVISOR_OUTBOUND_DELIVERY_NOT_INDEPENDENTLY_VERIFIED",r["robots"]["supervisor"]["blockers"])

    def test_corrupt_large_or_symlink_state_cannot_qualify(self):
        self.state.write_text("{NOT JSON")
        self.assertIn("SAPO_STATE_INVALID",self.inspect()["robots"]["sapo"]["blockers"])
        self.state.write_text("x"*70000)
        self.assertIn("SAPO_STATE_NOT_READABLE",self.inspect()["robots"]["sapo"]["blockers"])
        self.state.unlink()
        try:
            self.state.symlink_to(self.path/"unknown.json")
        except (NotImplementedError,OSError):
            pass
        else:
            self.assertIn("SAPO_STATE_NOT_READABLE",self.inspect()["robots"]["sapo"]["blockers"])

    def test_low_ram_or_media_worker_does_not_trigger_restart(self):
        r=self.inspect(saydi={"chapter2":{"stage":"PAUSED_RESOURCE"},"worker":True},
                       ram_free_gib=1.5)
        for reason in ("SAYDI_CHAPTER_QC_WAIT_RESOURCE","SAYDI_WORKER_ACTIVITY_NOT_SAFE_TO_INTERRUPT",
                       "SAYDI_QC_RAM_BELOW_GATE"):
            self.assertIn(reason,r["robots"]["saydi"]["blockers"])
        self.assertIs(r["owner_start_authorized"],False)

    def test_unknown_stop_and_unknown_outbound_never_allow_cutover(self):
        r=self.inspect(supervisor_stop=None,supervisor_autostart_disabled=None,
                       supervisor_state=None)
        self.assertIn("SUPERVISOR_STOP_LATCH_PRESENT_OR_UNKNOWN",r["robots"]["supervisor"]["blockers"])
        self.assertIn("SUPERVISOR_OUTBOUND_UNVERIFIED",r["robots"]["supervisor"]["blockers"])

    def test_hostile_log_names_are_not_disclosed_or_inspected(self):
        (self.log_dir/"secret-customer-123.txt").write_text(
            "login ABC email secret_customer@example.com",encoding="utf-8")
        (self.log_dir/"robot_2026-10-01.log").write_text("timeout",encoding="utf-8")
        result=json.dumps(self.inspect())
        self.assertNotIn("secret_customer",result)
        self.assertIn("TIMEOUT",result)

    def test_missing_local_sources_are_fail_closed(self):
        result=m.inspect(**{**self.params,"sapo_state_path":self.path/"nonexistent",
                            "sapo_logs_dir":self.path/"missing"})
        self.assertFalse(result["cutover_allowed"])
        self.assertIn("SAPO_STATE_NOT_READABLE",result["robots"]["sapo"]["blockers"])
        self.assertIn("SAPO_LOGS_UNAVAILABLE",result["robots"]["sapo"]["blockers"])


if __name__ == "__main__":
    unittest.main()
