# -*- coding: utf-8 -*-
"""Robot Tong: read-only, idempotent task classification; manual Owner start only."""
import argparse
import json
import sqlite3
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent
INBOX = Path(r"C:\MAGASIN_MCP\state\jobs.sqlite3")
LEDGER = BASE / "state" / "plans.sqlite3"
REPORT = BASE / "state" / "coordinator-status.json"
CONFIG = BASE / "config" / "owner_enabled.json"
READONLY_BRIDGE = BASE / "sot-preflight-python-bridge.py"
MAX_PREFLIGHT_STDOUT = 16_384
ROUTES = {"supervisor":"supervisor", "webapp":"supervisor", "saydi":"saydi", "sapo":"sapo"}
ACTIONS = {"health_check", "execute_task", "render_qc", "sync_revenue"}

def now():
    return datetime.now(timezone.utc).isoformat()

def flags():
    try:
        data=json.loads(CONFIG.read_text(encoding="utf-8-sig"))
        if not isinstance(data,dict): data={}
    except (OSError,ValueError):
        data={}
    return {x:(data.get(x) is True) for x in set(ROUTES.values())}

def input_jobs():
    if not INBOX.exists(): return []
    cx=sqlite3.connect(f"file:{INBOX.as_posix()}?mode=ro",uri=True,timeout=3)
    cx.row_factory=sqlite3.Row
    try:
        return [dict(r) for r in cx.execute(
            "SELECT source_id,task_id,target,action,sot_url,status FROM dispatch_inbox ORDER BY received_at DESC LIMIT 100")]
    except sqlite3.DatabaseError:
        return []
    finally:
        cx.close()

def classify(row, allowed):
    specialist=ROUTES[row["target"]]
    if row["action"]=="health_check":
        if row["status"]=="DONE": return "HEALTH_CHECK_DONE","Kiểm tra kỹ thuật xong; không chứng minh task nghiệp vụ đã hoàn thành"
        if row["status"]=="FAILED": return "HEALTH_CHECK_FAILED","Cần phân tích lỗi kiểm tra"
        return "HEALTH_CHECK_PENDING","Chờ kết quả kiểm tra kỹ thuật"
    if not allowed[specialist]:
        return "WAIT_OWNER_ENABLE","Robot đang OFF; không tự khởi động"
    return "WAIT_SOT_VERIFICATION","Chưa đọc/đối chiếu SOT và chưa có adapter thực thi an toàn"


def safe_preflight_readonly(*, run=subprocess.run, machine=None, bridge=None):
    """Bounded inspection in the already-existing 30m classifier cycle.

    Never grants execution and cannot alter the Gateway inbox or worker state.
    The existing local bridge verifies SOT independently via GitHub GET.
    """
    state = {"schema": "MAGASIN_COORDINATOR_SOT_PREFLIGHT_V1",
             "status": "NOT_VERIFIED", "execution_qualified": False,
             "dispatched": False, "business_completed": False,
             "probes": 0, "results": []}
    if (machine or socket.gethostname()).upper() != "DESKTOP-H4A16IL":
        return {**state, "status": "WRONG_TARGET_MACHINE"}
    script = bridge if bridge is not None else READONLY_BRIDGE
    if not script.is_file():
        return {**state, "status": "BRIDGE_NOT_INSTALLED"}
    try:
        proc = run(
            [sys.executable, str(script)],
            input=None, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=11,
            cwd=str(BASE), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if proc.returncode != 0 or len(proc.stdout) > MAX_PREFLIGHT_STDOUT:
            raise ValueError("BRIDGE_FAILED_OR_OVERSIZED")
        data = json.loads(proc.stdout)
        if (not isinstance(data, dict) or data.get("mode") != "READ_ONLY" or
            data.get("machine") != "DESKTOP-H4A16IL" or
            data.get("execution_enabled") is True or
            not isinstance(data.get("results"), list) or
            len(data["results"]) > 5 or
            type(data.get("probes")) is not int or not 0 <= data["probes"] <= 5):
            raise ValueError("UNTRUSTED_BRIDGE_REPORT")
        clean = []
        for item in data["results"]:
            if (not isinstance(item, dict) or
                item.get("schema") != "MAGASIN_PYTHON_PREFLIGHT_BRIDGE_V1" or
                item.get("execution_qualified") is not False or
                item.get("dispatched") is not False or
                item.get("business_completed") is not False):
                raise ValueError("UNTRUSTED_BRIDGE_RESULT")
            evidence = item.get("evidence") or {}
            if not isinstance(evidence, dict):
                raise ValueError("UNTRUSTED_EVIDENCE")
            clean.append({
                "status": str(item.get("status") or "UNKNOWN")[:48],
                "reason": str(item.get("reason") or "")[:64],
                "task_id": str(item.get("task_id") or "")[:48],
                "source_id": str(item.get("source_id") or "")[:150],
                "sot_state": str(evidence.get("task_state") or "")[:32],
                "sot_reason": str(evidence.get("reason") or "")[:64],
                "sot_revision": str(evidence.get("revision") or "")[:40],
            })
        return {**state, "status": "READ_ONLY_CLASSIFIED",
                "probes": data["probes"], "results": clean}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {**state, "status": "BRIDGE_FAILED_CLOSED"}


def once():
    rows=input_jobs()
    allowed=flags()
    LEDGER.parent.mkdir(parents=True,exist_ok=True)
    cx=sqlite3.connect(str(LEDGER),timeout=8)
    cx.row_factory=sqlite3.Row
    cx.execute("PRAGMA journal_mode=WAL")
    cx.execute("""CREATE TABLE IF NOT EXISTS plans(
        source_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,source_target TEXT NOT NULL,
        specialist TEXT NOT NULL,action TEXT NOT NULL,sot_url TEXT NOT NULL,
        source_status TEXT NOT NULL,stage TEXT NOT NULL,explanation TEXT NOT NULL,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL)""")
    total=0
    for row in rows:
        if row.get("target") not in ROUTES or row.get("action") not in ACTIONS:continue
        if not str(row.get("sot_url","")).startswith("https://github.com/magasincoffee/"):continue
        stage,explanation=classify(row,allowed)
        cx.execute("""INSERT INTO plans
        (source_id,task_id,source_target,specialist,action,sot_url,source_status,stage,explanation,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source_id) DO UPDATE SET
        source_status=excluded.source_status,stage=excluded.stage,
        explanation=excluded.explanation,updated_at=excluded.updated_at""",
        (row["source_id"],row["task_id"],row["target"],ROUTES[row["target"]],
        row["action"],row["sot_url"],row["status"],stage,explanation,now(),now()))
        total+=1
    cx.commit()
    states={str(k):v for k,v in cx.execute("SELECT stage,COUNT(*) FROM plans GROUP BY stage")}
    records=[dict(r) for r in cx.execute(
       "SELECT source_id,task_id,specialist,action,stage,explanation,updated_at FROM plans ORDER BY updated_at DESC LIMIT 12")]
    cx.close()
    preflight=safe_preflight_readonly()
    obj={"updated":now(),"mode":"OFF_OWNER_MANUAL","execution_enabled":False,
      "source_jobs_seen":len(rows),"classified":total,"owner_enabled":allowed,
      "states":states,"recent":records,
      "sot_preflight":preflight,
      "limitations":"Phân loại Gateway và kiểm tra SOT chỉ đọc; chưa có quyền giao việc chuyên môn, QA hoặc tự sửa lỗi."}
    tmp=REPORT.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj,ensure_ascii=False,indent=2),encoding="utf-8")
    tmp.replace(REPORT)
    return obj

if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("mode",choices=["once","report"]);a=p.parse_args()
    if a.mode=="once": print(json.dumps(once(),ensure_ascii=True))
    else:
        try: print(REPORT.read_text(encoding="utf-8"))
        except OSError: print('{"mode":"NOT_READY"}')