"""Synthetic tests only; never load H4 SQLite or start workers."""
from datetime import datetime,timedelta,timezone
import importlib.util
from pathlib import Path
import unittest

path=Path(__file__).resolve().parents[1]/"src"/"coordinator"/"local_mcp_field_preflight.py"
spec=importlib.util.spec_from_file_location("h4_preflight",path)
sut=importlib.util.module_from_spec(spec)
spec.loader.exec_module(sut)
NOW=datetime(2026,10,14,3,0,tzinfo=timezone.utc)
MAIN="0bde4a03e3f63f1370a354297f4962b6d0cbf20f"


def fixture():
    f={
        "schema":sut.SCHEMA,"collector":"INDEPENDENT_H4",
        "host":"DESKTOP-H4A16IL","main_sha":MAIN,
        "gateway_sha":sut.GATEWAY_SHA,"worker_sha":sut.WORKER_SHA,
        "owner_stop":True,"autostart_disabled":True,
        "process_ownership_verified":True,"gateway_pids":[9384,9844],
        "observed_at":(NOW-timedelta(minutes=1)).isoformat(),
        "whole_db_read":True,"inbox":[],"jobs":[{"id":"done","status":"DONE"}],
        "backup":{"method":"SQLITE_ONLINE_BACKUP","storage":"D_PROTECTED",
                  "integrity_ok":True,"hash_verified":True,"acl_restricted":True,
                  "restorable":True,"sha256":"a"*64},
        "owner_issue_bound_approval":True,"rollback_verified":True,
        "gateway_ingest_replay_guard":True,
    }
    for key,(task,target,action,status) in sut.EXPECTED.items():
        f["inbox"].append({"source_id":key,"source":"github","task_id":task,
             "target":target,"action":action,"status":status,
             "sot_url":sut.SOT,"local_job_id":None,
             "updated_at":(NOW-timedelta(days=4)).isoformat()})
    f["inbox"].append({"source_id":"done","status":"DONE"})
    f["inbox_total"]=len(f["inbox"])
    f["jobs_total"]=len(f["jobs"])
    return f


def check(payload):
    return sut.evaluate(payload,now=NOW,pinned_main_sha=MAIN)


class LocalFieldPreflightTests(unittest.TestCase):
    def test_perfect_synthetic_snapshot_still_cannot_authorize_apply(self):
        r=check(fixture())
        self.assertEqual(r["assessment"],"SYNTHETIC_METADATA_MATCH")
        self.assertFalse(r["field_apply_authorized"])
        self.assertFalse(r["business_dispatch_authorized"])
        self.assertFalse(r["live_h4_inspected"])
        self.assertEqual(r["reasons"],[])

    def test_missing_evidence_is_a_hard_hold(self):
        self.assertIn("MISSING_EVIDENCE",check(None)["reasons"])

    def test_owner_stop_host_and_process_guards(self):
        variants=[
            ("host","DESKTOP-4K7IM13"),("main_sha","0"*40),
            ("gateway_sha","1"*64),("worker_sha","2"*64),
            ("owner_stop",False),("autostart_disabled",False),
            ("gateway_pids",[5,5]),("gateway_pids",["5",6]),
            ("process_ownership_verified",False),("owner_issue_bound_approval",False),
            ("rollback_verified",False),("gateway_ingest_replay_guard",False),
        ]
        for key,value in variants:
            with self.subTest(key=key,value=value):
                p=fixture();p[key]=value
                self.assertEqual(check(p)["assessment"],"HOLD")
                self.assertFalse(check(p)["field_apply_authorized"])

    def test_stale_and_backup_guards(self):
        for key,value in [
            ("method","RAW_FILE_COPY"),("storage","C"),
            ("integrity_ok",False),("hash_verified",False),
            ("acl_restricted",False),("restorable",False),("sha256","bad")
        ]:
            with self.subTest(backup=key):
                p=fixture();p["backup"][key]=value
                self.assertIn("BACKUP_NOT_VERIFIED",check(p)["reasons"])
        p=fixture();p["observed_at"]=NOW.isoformat().replace("2026","2025")
        self.assertIn("STALE_SNAPSHOT",check(p)["reasons"])

    def test_all_pending_rows_and_jobs_must_be_examined(self):
        for kind in ("active_job","unknown_job","unexpected_pending","partial",
                     "linked_old_request","young_old_request","unknown_inbox_status",
                     "other_target","missing_old_request"):
            with self.subTest(kind=kind):
                p=fixture()
                if kind=="active_job":
                    p["jobs"].append({"id":"queue","status":"QUEUED"});p["jobs_total"]+=1
                if kind=="unknown_job":p["jobs"][0]["status"]="RETRY"
                if kind=="unexpected_pending":
                    p["inbox"].append({"source_id":"other","status":"READY"});p["inbox_total"]+=1
                if kind=="partial":p["whole_db_read"]=False
                if kind=="linked_old_request":p["inbox"][0]["local_job_id"]="already-linked"
                if kind=="young_old_request":p["inbox"][1]["updated_at"]=NOW.isoformat()
                if kind=="unknown_inbox_status":p["inbox"][2]["status"]="BANANA"
                if kind=="other_target":p["inbox"][0]["target"]="saydi"
                if kind=="missing_old_request":p["inbox"].pop(0);p["inbox_total"]-=1
                r=check(p)
                self.assertEqual(r["assessment"],"HOLD")
                self.assertFalse(r["field_apply_authorized"])

    def test_receipt_redacts_untrusted_private_fields(self):
        p=fixture();p["secret"]="SENSITIVE_H4_OWNER_VALUE"
        self.assertNotIn("SENSITIVE_H4_OWNER_VALUE",repr(check(p)))


if __name__=="__main__":
    unittest.main()
