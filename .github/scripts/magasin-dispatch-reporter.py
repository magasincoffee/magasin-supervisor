# -*- coding: utf-8 -*-
"""Safe GitHub to Local MCP queue receipt reporter (no specialist execution)."""
import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

REPO = "magasincoffee/magasin-supervisor"
API = "https://api.github.com/repos/" + REPO
MCP = Path(r"C:\MAGASIN_MCP")
DB = MCP / "state" / "jobs.sqlite3"
REPORTS = Path(r"D:\MAGASIN_ROBOTS\robots\coordinator\reports")
TOKEN = os.getenv("GH_TOKEN", "")
PREFIX = "[MAGASIN-DISPATCH]"
MARKER = "<!-- MAGASIN_LOCAL_RECEIPT_V1:{}:{} -->"


def request(path, payload=None):
    if not path.startswith(API + "/"):
        raise ValueError("Disallowed repository API")
    headers = {"Accept": "application/vnd.github+json",
               "User-Agent": "MAGASIN-Local-Reporter/1",
               "X-GitHub-Api-Version": "2022-11-28"}
    if TOKEN:
        headers["Authorization"] = "Bearer " + TOKEN
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    if data:
        headers["Content-Type"] = "application/json"
    req = Request(path, data=data, headers=headers,
                  method="POST" if data is not None else "GET")
    with urlopen(req, timeout=12) as response:
        return json.loads(response.read(900000))


def trustworthy(issue):
    if issue.get("user", {}).get("login") != "magasincoffee":
        return False
    if issue.get("state") != "open" or not str(issue.get("title", "")).startswith(PREFIX):
        return False
    if "pull_request" in issue:
        return False
    try:
        sys.path.insert(0, str(MCP))
        from dispatch_gateway import parse_envelope
        return parse_envelope(json.loads(issue.get("body") or "")) is not None
    except (ValueError, TypeError):
        return False


def local_state(number):
    if not DB.is_file():
        return None
    cx = sqlite3.connect("file:" + DB.as_posix() + "?mode=ro", uri=True, timeout=5)
    cx.row_factory = sqlite3.Row
    try:
        item = cx.execute(
            "SELECT target,task_id,action,status,local_job_id FROM dispatch_inbox WHERE source_id=?",
            (f"github:{REPO}:issue:{number}",)).fetchone()
        if item is None:
            return None
        out = dict(item)
        if out["local_job_id"]:
            job = cx.execute(
                "SELECT kind,status,attempts,result_json FROM jobs WHERE id=?",
                (out["local_job_id"],)).fetchone()
            if job:
                out["job"] = {"kind": job["kind"], "status": job["status"],
                              "attempts": job["attempts"]}
                try:
                    details = json.loads(job["result_json"] or "{}")
                except (ValueError, TypeError):
                    details = {}
                if item["target"] == "supervisor":
                    out["evidence"] = {
                        "guardian_alive": details.get("guardian_alive"),
                        "wrapper_alive": details.get("wrapper_alive"),
                        "watchdog": details.get("watchdog_mode"),
                        "automation": details.get("automation_status")
                    }
                else:
                    out["evidence"] = {"scope": details.get("scope", "read-only")}
        return out
    finally:
        cx.close()


def report(item, number):
    job = item.get("job", {})
    stage = item["status"]
    if item["action"] == "health_check" and stage == "DONE" and job.get("status") == "DONE":
        stage = "HEALTH_CHECK_COMPLETE"
    elif item["action"] == "health_check" and stage == "FAILED":
        stage = "HEALTH_CHECK_FAILED"
    stable = {"stage": stage, "job": job, "evidence": item.get("evidence")}
    digest = hashlib.sha256(json.dumps(stable,sort_keys=True).encode()).hexdigest()[:16]
    lines = [
        MARKER.format(number,digest),
        "### MAGASIN Local MCP - kết quả tự động",
        "- Nhiệm vụ: " + item["task_id"],
        "- Robot: " + item["target"],
        "- Hành động: " + item["action"],
        "- Trạng thái Gateway: " + item["status"],
        "- Kết quả: **" + stage + "**",
    ]
    if job:
        lines.append("- Worker: " + job["status"] + "; số lần thử: " + str(job["attempts"]))
    for key, value in item.get("evidence",{}).items():
        if value is not None and isinstance(value,(str,int,bool,float)):
            lines.append("- " + key + ": " + str(value)[:70])
    if item["action"] == "health_check":
        lines.append("Hoàn thành kiểm tra kỹ thuật KHÔNG phải đã hoàn thành nhiệm vụ nghiệp vụ.")
    if stage == "WAIT_SOT_AUTHORITY":
        lines.append("Chưa được thực thi nghiệp vụ: thiếu adapter SOT-gated hợp lệ.")
    lines.append("Đọc từ SQLite local; không gửi lệnh ChatGPT, không tác động dữ liệu production.")
    return "\n".join(lines),digest


def latest_marker(number):
    comments = request(API + f"/issues/{number}/comments?per_page=100")
    prefix = "<!-- MAGASIN_LOCAL_RECEIPT_V1:" + str(number) + ":"
    for c in reversed(comments):
        if str(c.get("body","")).startswith(prefix) and c.get("user",{}).get("login") in ("github-actions[bot]","magasincoffee"):
            return c["body"].split("\n",1)[0]
    return None


def once(number, dry=False):
    issue=request(API+f"/issues/{number}")
    if not trustworthy(issue):
        return {"issue":number,"result":"REJECTED"}
    item=local_state(number)
    if item is None:
        from dispatch_gateway import sync_once
        sync_once()
        item=local_state(number)
    if item is None:
        return {"issue":number,"result":"WAIT_GATEWAY"}
    if item["status"]=="QUEUED" and item["action"]=="health_check":
        for _ in range(8):
            time.sleep(2)
            item=local_state(number)
            if item and item["status"] in ("DONE","FAILED"):
                break
    body, digest=report(item,number)
    REPORTS.mkdir(parents=True,exist_ok=True)
    (REPORTS / ("issue-" + str(number) + "-receipt.md")).write_text(body+"\n",encoding="utf-8")
    if dry:
        return {"issue":number,"result":"DRY_RUN","gateway":item["status"],"digest":digest}
    marker=MARKER.format(number,digest)
    if latest_marker(number)==marker:
        return {"issue":number,"result":"UNCHANGED"}
    response=request(API+f"/issues/{number}/comments",{"body":body})
    return {"issue":number,"result":"POSTED","url":response.get("html_url")}


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--issue",type=int,default=0)
    p.add_argument("--dry-run",action="store_true")
    args=p.parse_args()
    if __import__("socket").gethostname().upper()!="DESKTOP-H4A16IL":
        raise SystemExit("WRONG_TARGET: only DESKTOP-H4A16IL")
    if not args.dry_run and not TOKEN:
        raise SystemExit("NO_ACTIONS_GITHUB_TOKEN")
    if args.issue:
        numbers=[args.issue]
    else:
        incoming=request(API+"/issues?state=open&per_page=100")
        numbers=[int(x["number"]) for x in incoming if trustworthy(x)][:30]
    for n in numbers:
        try:
            print(json.dumps(once(n,args.dry_run),ensure_ascii=True),flush=True)
        except Exception as exc:
            print(json.dumps({"issue":n,"result":"ERROR","error_class":type(exc).__name__}),flush=True)
            if args.issue:
                raise

if __name__=="__main__":
    main()