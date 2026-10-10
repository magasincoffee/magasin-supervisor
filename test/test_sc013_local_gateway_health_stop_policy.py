# -*- coding: utf-8 -*-
"""SC-013 local MCP health-only patch: sqlite fixture and no-worker authority."""
import ast
import hashlib
import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path

FILE=Path(__file__).resolve().parents[1]/"src"/"coordinator"/"local_gateway_health_patch.py"
spec=importlib.util.spec_from_file_location("sc013_local_gateway_stop_policy",FILE)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def gateway_fixture():
    # Use the real observed ingest sites, surrounded by an isolated test-only
    # function with a compatible ephemeral SQLite schema.
    s='''# SC-013 SYNTHETIC GATEWAY; NOT REAL H4 RUNTIME SOURCE
def ingest(entries):
    db=dbconn()
    counters={"added":0,"existing":0}
    try:
        for source_id,source,env in entries:
            if len(source_id)>150:
                continue
            at=now()
            condition="WAIT_SOT_AUTHORITY"
            local_id=None
'''
    s+=m.OLD_HEALTH
    s+='''            row=db.execute("SELECT status FROM dispatch_inbox WHERE source_id=?",(source_id,)).fetchone()
            if row:
                counters["existing"]+=1
                continue
            db.execute("""INSERT INTO dispatch_inbox
                (source_id,source,task_id,target,action,sot_url,status,local_job_id,received_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (source_id,source,env["task_id"],env["target"],env["action"],env["sot_url"],
                 condition,local_id,at,at))
            counters["added"]+=1
'''
    s+=m.OLD_DISPATCH
    s+='''        for row in db.execute("SELECT source_id,local_job_id FROM dispatch_inbox WHERE status='QUEUED'").fetchall():
            result=job_status(row["local_job_id"])
            if result.get("status") in ("DONE","FAILED"):
                db.execute("UPDATE dispatch_inbox SET status=?,updated_at=? WHERE source_id=?",
                           (result["status"],now(),row["source_id"]))
        return counters
    finally:
        db.close()
'''
    return ("# fixture-padding-only\n"*170+s).encode("utf-8")


class PolicyPatchTests(unittest.TestCase):
    def setUp(self):
        self.raw=gateway_fixture()
        self.sha=hashlib.sha256(self.raw).hexdigest()
        self.patched=m.transform(self.raw,original_sha256=self.sha)
        self.tmp=tempfile.TemporaryDirectory(prefix="sc013-gateway-health-stop-")
        self.addCleanup(self.tmp.cleanup)
        self.dbfile=Path(self.tmp.name)/"jobs.sqlite3"
        self.calls=[]
        self.jobs={}
        self.owner_stop=True
        self.clock=0
        self.env={
            "task_id":"SC-013","target":"supervisor",
            "sot_url":"https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md",
        }
        conn=self.conn()
        conn.execute("""CREATE TABLE dispatch_inbox (
            source_id TEXT PRIMARY KEY,source TEXT,task_id TEXT,target TEXT,
            action TEXT,sot_url TEXT,status TEXT,local_job_id TEXT,
            received_at TEXT,updated_at TEXT)""")
        conn.close()
        mod=ast.parse(self.patched)
        funcs=[x for x in mod.body if isinstance(x,ast.FunctionDef) and x.name=="ingest"]
        self.assertEqual(len(funcs),1)
        self.scope={
            "dbconn":self.conn,"now":self.now,"is_owner_stop":lambda: self.owner_stop,
            "submit":self.submit,"job_status":self.job_status,
        }
        exec(compile(ast.Module(body=funcs,type_ignores=[]),"<synthetic-gateway>","exec"),
             self.scope)

    def conn(self):
        db=sqlite3.connect(self.dbfile,isolation_level=None)
        db.row_factory=sqlite3.Row
        return db

    def now(self):
        self.clock+=1
        return f"2026-10-10T03:55:{self.clock:02d}Z"

    def submit(self,kind,dedupe_key):
        self.assertIn(kind,("supervisor_snapshot","webapp_snapshot","saydi_snapshot","sapo_snapshot"))
        if dedupe_key not in self.jobs:
            ident=f"fixture:{len(self.jobs)+1}"
            self.jobs[dedupe_key]={"id":ident,"kind":kind,"status":"QUEUED"}
            self.calls.append((kind,dedupe_key))
        return self.jobs[dedupe_key]

    def job_status(self,job_id):
        for job in self.jobs.values():
            if job["id"]==job_id:return job
        return {"status":"UNKNOWN"}

    def invoke(self,entries):
        return self.scope["ingest"](entries)

    def row(self,source_id):
        db=self.conn()
        try:
            r=db.execute("SELECT source_id,action,status,local_job_id FROM dispatch_inbox WHERE source_id=?",(source_id,)).fetchone()
            return dict(r) if r else None
        finally:db.close()

    def insert_existing(self,ident,action,status,job=None,target="supervisor"):
        db=self.conn()
        try:
            db.execute("INSERT INTO dispatch_inbox VALUES(?,?,?,?,?,?,?,?,?,?)",
                       (ident,"github","SC-013",target,action,self.env["sot_url"],status,job,self.now(),self.now()))
        finally:db.close()

    def test_real_style_health_issue_is_done_while_owner_stopped(self):
        ident="github:magasincoffee/magasin-supervisor:issue:381"
        self.assertTrue(self.owner_stop)
        result=self.invoke([(ident,"github",{**self.env,"action":"health_check"})])
        self.assertEqual(result["added"],1)
        self.assertEqual(self.row(ident)["status"],"QUEUED")
        self.assertEqual(self.calls,[("supervisor_snapshot",ident)])
        job=self.jobs[ident]
        job["status"]="DONE"
        self.invoke([])
        self.assertEqual(self.row(ident)["status"],"DONE")
        self.invoke([(ident,"github",{**self.env,"action":"health_check"})])
        self.assertEqual(len(self.calls),1)

    def test_existing_wait_owner_stop_health_only_gets_resumed(self):
        ident="github:magasincoffee/magasin-supervisor:issue:381"
        self.insert_existing(ident,"health_check","WAIT_OWNER_STOP")
        self.insert_existing("old-business","execute_task","WAIT_OWNER_STOP")
        self.invoke([])
        self.assertEqual(self.row(ident)["status"],"QUEUED")
        self.assertEqual(self.row("old-business")["status"],"WAIT_OWNER_STOP")
        self.assertEqual(self.row("old-business")["local_job_id"],None)
        self.assertEqual(len(self.calls),1)

    def test_three_business_actions_remain_blocked_even_owner_stop_false(self):
        for stop in (True,False):
            self.owner_stop=stop
            for action in ("execute_task","render_qc","sync_revenue"):
                ident=f"fixture:{str(stop)}:{action}"
                self.invoke([(ident,"github",{**self.env,"action":action})])
                self.assertEqual(self.row(ident)["status"],"WAIT_SOT_AUTHORITY")
                self.assertIsNone(self.row(ident)["local_job_id"])
        self.assertEqual(self.calls,[])

    def test_forged_ready_business_action_never_reaches_local_queue(self):
        self.insert_existing("forged-exec","execute_task","READY")
        self.insert_existing("forged-render","render_qc","READY")
        self.invoke([])
        self.assertEqual(self.calls,[])
        self.assertEqual(self.row("forged-exec")["status"],"READY")

    def test_wrong_health_target_cannot_select_a_worker(self):
        self.insert_existing("badtarget","health_check","READY",target="operator_shell")
        self.invoke([])
        self.assertEqual(self.calls,[])
        self.assertEqual(self.row("badtarget")["local_job_id"],None)

    def test_hash_mismatch_or_double_patch_fails_closed(self):
        with self.assertRaisesRegex(m.PatchRejected,"GATEWAY_SOURCE_SHA256_DRIFT"):
            m.transform(self.raw)
        with self.assertRaisesRegex(m.PatchRejected,"GATEWAY_PATCH_ANCHOR_NOT_UNIQUE"):
            m.transform(self.patched,original_sha256=hashlib.sha256(self.patched).hexdigest())
        with self.assertRaises(m.PatchRejected):
            m.transform(self.raw.replace(b'health_check',b'healthprobe'),
                        original_sha256=hashlib.sha256(self.raw.replace(b'health_check',b'healthprobe')).hexdigest())

    def test_pure_source_patch_no_local_side_effect_or_owner_stop_change(self):
        status=m.describe(self.raw,original_sha256=self.sha)
        self.assertEqual(status["health_when_owner_stopped"],"READ_ONLY_ALLOWED")
        self.assertEqual(status["business_actions_when_owner_stopped"],"WAIT_SOT_AUTHORITY")
        self.assertFalse(status["local_files_modified"])
        self.assertFalse(status["runner_started"])
        self.assertFalse(status["owner_stop_modified"])
        self.assertEqual(status["candidate_sha256"],hashlib.sha256(self.patched).hexdigest())
        text=self.patched.decode()
        self.assertIn("AND action='health_check' ORDER BY received_at",text)
        self.assertIn("condition = \"WAIT_SOT_AUTHORITY\"",text)
        self.assertNotIn("if not is_owner_stop():",text)


if __name__=="__main__":
    unittest.main()
