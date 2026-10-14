"""Offline synthetic-only gates: never inspect H4 or persistent SQLite."""
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest

PATH = Path(__file__).resolve().parents[1] / "src" / "coordinator" / "sc013_watchdog_release_preflight.py"
spec = importlib.util.spec_from_file_location("watchdog_release_preflight", PATH)
sut = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sut)
NOW = datetime(2026, 10, 14, 10, 0, tzinfo=timezone.utc)
MAIN = "92fda450897bf2868f3054c7cfa24b24b886690a"
ERROR = "The property 'last_error_code' cannot be found on this object. Verify that the property exists."


def fixture():
    return {
        "schema": sut.SCHEMA, "collector": "H4_READ_ONLY_METADATA",
        "host": "DESKTOP-H4A16IL", "state_root_source": "UserEnvironment",
        "observed_at": (NOW - timedelta(minutes=1)).isoformat(),
        "main_sha": MAIN, "candidate_file": "windows/local-watchdog.ps1",
        "old_sha256": sut.EXPECTED_OLD_SHA256,
        "old_file_exists": True, "old_file_regular_no_reparse": True,
        "owner_stop": True, "autostart_disabled": True,
        "supervisor_status": "STOPPED", "watchdog_error": ERROR,
        "rollback_on_D_prepared": True, "candidate_hash_verified": True,
        "no_worker_start": True, "no_latch_change": True,
    }


def assess(evidence):
    return sut.evaluate(evidence, pinned_main_sha=MAIN, now=NOW)


class WatchdogPreflightTests(unittest.TestCase):
    def test_matching_synthetic_receipt_cannot_authorize_field_apply(self):
        result = assess(fixture())
        self.assertEqual(result["assessment"], "SYNTHETIC_METADATA_MATCH")
        self.assertEqual(result["reasons"], [])
        for field in ("field_apply_authorized", "worker_start_authorized",
                      "owner_stop_change_authorized", "sqlite_operation_authorized",
                      "live_h4_modified", "live_h4_install_verified"):
            self.assertIs(result[field], False, field)
        self.assertTrue(result["independent_owner_field_gate_required"])

    def test_all_missing_and_drifted_field_gates_hold(self):
        cases = {
            "schema": "NEW_SCHEMA", "collector": "UNKNOWN",
            "host": "DESKTOP-4K7IM13", "state_root_source": "CurrentUserFallback",
            "main_sha": "f" * 40, "candidate_file": "src/coordinator/agent.py",
            "old_sha256": "b" * 64,
            "old_file_exists": False, "old_file_regular_no_reparse": False,
            "owner_stop": False, "autostart_disabled": False,
            "supervisor_status": "RUNNING", "watchdog_error": "none",
            "rollback_on_D_prepared": False, "candidate_hash_verified": False,
            "no_worker_start": False, "no_latch_change": False,
        }
        for key, value in cases.items():
            with self.subTest(key=key):
                rec = fixture(); rec[key] = value
                result = assess(rec)
                self.assertEqual(result["assessment"], "HOLD")
                self.assertFalse(result["field_apply_authorized"])

    def test_absent_malformed_and_old_evidence_fail_closed(self):
        for rec in (None, [], {}, {"schema":sut.SCHEMA}):
            with self.subTest(rec=type(rec).__name__):
                self.assertEqual(assess(rec)["assessment"], "HOLD")
        for value in ("bad", "2026-10-14T09:59:00", "2026-10-14T09:50:00Z",
                      "2026-10-14T10:01:00Z", "2026-10-14T00:00:00" + "Z" * 999):
            with self.subTest(timestamp=value):
                rec = fixture(); rec["observed_at"] = value
                self.assertIn("STALE_OR_INVALID_OBSERVATION", assess(rec)["reasons"])

    def test_bad_shas_and_untrusted_pins_hold(self):
        for old in (None, True, 3, [], "A" * 64):
            rec = fixture(); rec["old_sha256"] = old
            self.assertEqual(assess(rec)["assessment"], "HOLD")
        for main in ("bad", "A"*40, None, "0"*39):
            result = sut.evaluate(fixture(), pinned_main_sha=main, now=NOW)
            self.assertEqual(result["assessment"], "HOLD")
            self.assertFalse(result["field_apply_authorized"])

    def test_no_secrets_or_private_paths_reflected(self):
        rec=fixture()
        rec["secret"]="MAGASIN_PRIVATE_OWNER_DATA"
        self.assertNotIn("MAGASIN_PRIVATE_OWNER_DATA", repr(assess(rec)))
        self.assertNotIn("C:\\Users\\admin", repr(assess(rec)))


if __name__ == "__main__":
    unittest.main()
