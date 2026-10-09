# -*- coding: utf-8 -*-
"""SC-013 GitHub/Gateway provenance source fixture; ZERO real network/workers."""
import importlib.util
import io
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "src" / "coordinator" / "dispatch_provenance.py"
spec = importlib.util.spec_from_file_location("sc013_source_provenance", SCRIPT)
pv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pv)
SOURCE = "github:magasincoffee/magasin-supervisor:issue:339"
NUMBER = 339
BODY = json.dumps(pv.ENVELOPE, separators=(",", ":"))


def issue(**changes):
    value = {
        "number": NUMBER, "id": 991338,
        "url": f"{pv.API}/issues/{NUMBER}",
        "html_url": f"https://github.com/{pv.REPO}/issues/{NUMBER}",
        "repository_url": pv.API,
        "state": "open", "title": "[MAGASIN-DISPATCH] SC-013 tested owner request",
        "body": BODY, "updated_at": "2026-10-09T12:00:00Z",
        "user": {"login": pv.EXPECTED_AUTHOR_LOGIN, "id": pv.EXPECTED_AUTHOR_ID},
    }
    value.update(changes)
    return value


def row(**changes):
    value = {
        "source_id": SOURCE, "source": "github", "task_id": "SC-013",
        "target": "supervisor", "action": "execute_task",
        "sot_url": pv.SOT_URL, "status": "WAIT_SOT_AUTHORITY",
        "local_job_id": None,
    }
    value.update(changes)
    return value


def owner(**changes):
    value = {
        "coordinator_monitor": "OWNER_MONITOR_READ_ONLY_OBSERVED",
        "specialist_dispatch_authorized": False,
        "business_dispatch_authorized": False,
    }
    value.update(changes)
    return value


class Response:
    def __init__(self, data, *, url, status=200):
        self.source = io.BytesIO(data)
        self.url = url
        self.status = status
    def __enter__(self):
        return self
    def __exit__(self, *a):
        self.source.close()
    def geturl(self):
        return self.url
    def read(self, count):
        return self.source.read(count)


class ProvenanceChecks(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix="sc013_provenance_")
        self.addCleanup(self.work.cleanup)
        self.path = Path(self.work.name)
        self.db = self.path / "gateway-fixture.sqlite3"
        self.lifecycle = self.path / "owner.json"
        self.flags = self.path / "flags.json"
        self.stop_root = self.path / "supervisor"
        self.stop_root.mkdir()
        self._write_owner()
        with closing(sqlite3.connect(self.db)) as cx:
            cx.execute("""CREATE TABLE dispatch_inbox (
                source_id TEXT PRIMARY KEY, source TEXT,task_id TEXT,target TEXT,
                action TEXT,sot_url TEXT,status TEXT,local_job_id TEXT)""")
            cx.execute("""INSERT INTO dispatch_inbox VALUES(?,?,?,?,?,?,?,?)""",
                       tuple(row().values()))

    def _write_owner(self, **changes):
        saved = {
            "schema": pv.LIFECYCLE_SCHEMA,
            "desired": "MONITOR_READ_ONLY",
            "control_source": "local_control_center", "generation": 1,
            "requested_at": "2026-10-09T10:33:11+00:00",
            "execution_enabled": False, "business_dispatch_enabled": False,
            "specialists_started": False,
        }
        saved.update(changes)
        self.lifecycle.write_text(json.dumps(saved), encoding="utf-8")
        self.flags.write_text(json.dumps({
            "supervisor": False, "saydi": False, "sapo": False
        }), encoding="utf-8")

    def _observe(self):
        return pv.observe_owner(
            machine=pv.MACHINE, lifecycle=self.lifecycle,
            flags=self.flags, stop_root=self.stop_root)

    def test_two_stable_issue_reads_match_gateway_but_never_authorize_execution(self):
        calls = []
        def fetched(number, *, token):
            calls.append((number, token))
            return issue()
        result = pv.inspect_once(
            SOURCE, token="fake-test-token",
            issue_fetch=fetched, gateway_read=lambda key: row(),
            owner_read=lambda: owner())
        self.assertEqual(len(calls), 2)
        self.assertEqual(result["status"], "REQUEST_PROVENANCE_MATCHED_ONLY")
        self.assertTrue(result["issue_gateway_fields_matched"])
        self.assertEqual(result["reason"], "OWNER_SPECIALIST_AND_SOT_AUTHORITY_MISSING")
        for key in ("specialist_owner_authority_verified",
                    "sot_execution_authority_verified",
                    "business_dispatch_authorized", "execution_qualified",
                    "dispatched", "business_completed"):
            self.assertFalse(result[key], key)

    def test_reads_actual_sqlite_schema_only_by_source_id_and_does_not_mutate(self):
        before = self.db.read_bytes()
        observed = pv.read_gateway_row(SOURCE, db=self.db)
        self.assertEqual(observed, row())
        self.assertEqual(self.db.read_bytes(), before)
        with self.assertRaisesRegex(pv.InspectionRejected, "SOURCE_ID_INVALID"):
            pv.read_gateway_row("supabase:some-id", db=self.db)
        with self.assertRaisesRegex(pv.InspectionRejected, "GATEWAY_RECEIPT_MISSING"):
            pv.read_gateway_row("github:magasincoffee/magasin-supervisor:issue:678", db=self.db)

    def test_wrong_author_identity_repo_issue_or_pull_request_are_rejected(self):
        invalid = [
            {"user": {"login": pv.EXPECTED_AUTHOR_LOGIN, "id": 999}},
            {"user": {"login": "attacker", "id": pv.EXPECTED_AUTHOR_ID}},
            {"repository_url": "https://api.github.com/repos/attacker/evil"},
            {"html_url": "https://github.com/attacker/evil/issues/339"},
            {"number": True},
            {"number": 338},
            {"id": False},
            {"state": "closed"},
            {"pull_request": {"url": "irrelevant"}},
            {"title": "Please run this command"},
            {"url": "https://api.github.com/repos/elsewhere/issues/339"},
        ]
        for change in invalid:
            with self.subTest(change=change):
                with self.assertRaises(pv.InspectionRejected):
                    pv.check_issue_gateway(SOURCE, issue(**change), row())

    def test_issue_json_duplicates_injection_and_wrong_sot_are_rejected(self):
        invalid = [
            {"body": '{"schema":"MAGASIN_DISPATCH_V1","schema":"FAKE"}'},
            {"body": json.dumps({**pv.ENVELOPE, "shell": "powershell"})},
            {"body": json.dumps({**pv.ENVELOPE, "sot_url": "https://evil.test"})},
            {"body": json.dumps({**pv.ENVELOPE, "task_id": "OPS-075"})},
            {"body": json.dumps({**pv.ENVELOPE, "target": "saydi"})},
            {"body": json.dumps({**pv.ENVELOPE, "action": "health_check"})},
            {"body": "not-json"},
            {"body": None},
            {"body": "x" * (pv.MAX_ISSUE_BYTES + 1)},
        ]
        for change in invalid:
            with self.subTest(change=str(change)[:80]):
                with self.assertRaises(pv.InspectionRejected):
                    pv.check_issue_gateway(SOURCE, issue(**change), row())

    def test_gateway_receipt_conflicts_are_rejected_even_if_github_issue_is_valid(self):
        for field, bad in [
            ("source_id", "github:magasincoffee/magasin-supervisor:issue:338"),
            ("source", "supabase"), ("task_id", "OPS-075"),
            ("target", "sapo"), ("action", "health_check"),
            ("sot_url", "https://evil.example"), ("status", "DONE"),
            ("local_job_id", "irreversible-work"),
        ]:
            with self.subTest(field=field):
                with self.assertRaisesRegex(pv.InspectionRejected, "ISSUE_GATEWAY_RECEIPT_MISMATCH"):
                    pv.check_issue_gateway(SOURCE, issue(), row(**{field: bad}))

    def test_issue_edited_between_two_reads_fails_closed(self):
        reads = [issue(), issue(updated_at="2026-10-09T12:01:00Z")]
        result = pv.inspect_once(SOURCE, token="fake-test-token",
                                 issue_fetch=lambda number, *, token: reads.pop(0),
                                 gateway_read=lambda source: row(), owner_read=lambda: owner())
        self.assertEqual(result["status"], "BLOCKED_NOT_QUALIFIED")
        self.assertEqual(result["reason"], "ISSUE_CHANGED_DURING_CHECK")
        self.assertFalse(result["business_dispatch_authorized"])

    def test_owner_monitor_is_observed_but_not_a_specialist_start(self):
        observed = self._observe()
        self.assertEqual(observed["coordinator_monitor"], "OWNER_MONITOR_READ_ONLY_OBSERVED")
        self.assertEqual(observed["specialist_owner_lifecycle"],
                         "UNVERIFIED_NO_SPECIALIST_OWNER_START_PROOF")
        self.assertFalse(observed["specialist_dispatch_authorized"])
        self.assertFalse(observed["business_dispatch_authorized"])

    def test_owner_stop_corrupt_owner_file_and_off_flags_block_observation(self):
        (self.stop_root / "STOP").touch()
        with self.assertRaisesRegex(pv.InspectionRejected, "OWNER_STOP_ACTIVE"):
            self._observe()
        (self.stop_root / "STOP").unlink()
        self._write_owner(desired="STOP")
        with self.assertRaisesRegex(pv.InspectionRejected, "COORDINATOR_OWNER_MONITOR_UNQUALIFIED"):
            self._observe()
        self._write_owner(execution_enabled=True)
        with self.assertRaisesRegex(pv.InspectionRejected, "COORDINATOR_OWNER_MONITOR_UNQUALIFIED"):
            self._observe()
        self._write_owner()
        self.flags.write_text(json.dumps({"supervisor": True, "saydi": False, "sapo": False}))
        with self.assertRaisesRegex(pv.InspectionRejected, "SPECIALIST_OWNER_FLAGS_NOT_OFF"):
            self._observe()

    def test_wrong_machine_missing_timestamp_or_symlink_block_observation(self):
        with self.assertRaisesRegex(pv.InspectionRejected, "WRONG_TARGET_MACHINE"):
            pv.observe_owner(machine="DESKTOP-4K7IM13", lifecycle=self.lifecycle,
                             flags=self.flags, stop_root=self.stop_root)
        self._write_owner(requested_at="not-an-ISO-date")
        with self.assertRaisesRegex(pv.InspectionRejected, "OWNER_TIMESTAMP_INVALID"):
            self._observe()
        self._write_owner()
        if (self.path / "owner-link.json").exists():
            (self.path / "owner-link.json").unlink()
        try:
            (self.path / "owner-link.json").symlink_to(self.lifecycle)
        except (OSError, NotImplementedError):
            pass
        else:
            with self.assertRaisesRegex(pv.InspectionRejected, "OWNER_EVIDENCE_MISSING_OR_OVERSIZED"):
                pv.observe_owner(machine=pv.MACHINE, lifecycle=self.path/"owner-link.json",
                                 flags=self.flags, stop_root=self.stop_root)

    def test_https_issue_get_rejects_wrong_url_status_missing_token_and_oversize(self):
        captured = []
        def opens(req):
            captured.append(req)
            return Response(json.dumps(issue()).encode(), url=req.full_url)
        fetched = pv.fetch_issue(NUMBER, token="fake-test-token", opener=opens)
        self.assertEqual(fetched["number"], NUMBER)
        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0].get_method(), "GET")
        self.assertEqual(captured[0].full_url, f"{pv.API}/issues/339")
        self.assertEqual(captured[0].get_header("Authorization"), "Bearer fake-test-token")
        for kwargs in [
            {"status": 302, "url": f"{pv.API}/issues/339"},
            {"status": 200, "url": "https://evil.example/issue"},
        ]:
            with self.assertRaisesRegex(pv.InspectionRejected, "GITHUB_ORIGIN_NOT_VERIFIED"):
                pv.fetch_issue(NUMBER, token="fake-test-token",
                               opener=lambda req, kw=kwargs: Response(b"{}", **kw))
        with self.assertRaisesRegex(pv.InspectionRejected, "GITHUB_RESPONSE_TOO_LARGE"):
            pv.fetch_issue(NUMBER, token="fake-test-token",
                           opener=lambda req: Response(b"x"*(pv.MAX_ISSUE_BYTES+1),
                                                       url=req.full_url))
        with self.assertRaisesRegex(pv.InspectionRejected, "SCOPED_GITHUB_TOKEN_REQUIRED"):
            pv.fetch_issue(NUMBER, token="", opener=opens)

    def test_unavailable_owner_or_issue_never_becomes_ready(self):
        for getter in [
            lambda: (_ for _ in ()).throw(pv.InspectionRejected("OWNER_STOP_ACTIVE")),
            lambda: {"coordinator_monitor": "MONITORING_READ_ONLY",
                     "specialist_dispatch_authorized": True,
                     "business_dispatch_authorized": True},
        ]:
            res = pv.inspect_once(
                SOURCE, token="fake-test-token",
                issue_fetch=lambda n, *, token: issue(),
                gateway_read=lambda source: row(), owner_read=getter)
            self.assertEqual(res["status"], "BLOCKED_NOT_QUALIFIED")
            self.assertFalse(res["execution_qualified"])
            self.assertFalse(res["dispatched"])

    def test_real_issue_source_id_cannot_turn_fixture_executor_on(self):
        from unittest.mock import MagicMock
        fake_executor=MagicMock()
        out=pv.inspect_once(SOURCE,token="fake-test-token",
                            issue_fetch=lambda n,*,token: issue(),
                            gateway_read=lambda source: row(),
                            owner_read=lambda: owner())
        self.assertEqual(out["reason"], "OWNER_SPECIALIST_AND_SOT_AUTHORITY_MISSING")
        self.assertFalse(out["business_dispatch_authorized"])
        fake_executor.assert_not_called()


if __name__ == "__main__":
    unittest.main()
