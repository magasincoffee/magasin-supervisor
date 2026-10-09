# -*- coding: utf-8 -*-
"""SC-013: bounded, non-invasive half-hour local work and evidence heartbeat.

Allowed work: poll validated GitHub inbox; classify task plans (no dispatch);
reconcile reporter separately. Never start a disabled specialist, mutate the
Supervisor conversation ledger, send ChatGPT messages, deploy source, or
pretend a health-check completes a business task.
"""
import argparse
import json
import os
import re
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(r"D:\MAGASIN_ROBOTS")
COORD = ROOT / "robots" / "coordinator"
MONITOR = ROOT / "control-center" / "state"
SUP = Path(os.environ.get("LOCALAPPDATA", "")) / "MAGASIN" / "BusinessOS" / "supervisor"
MCP = Path(r"C:\MAGASIN_MCP")
ISSUE = 347
API = "https://api.github.com/repos/magasincoffee/magasin-supervisor"
TOKEN = os.environ.get("GH_TOKEN", "")
SCHEMA = "MAGASIN_LOCAL_30M_TICK_V1"


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(p):
    try:
        data = json.loads(p.read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError, UnicodeError):
        return {}


def github(method, suffix, body=None):
    if suffix not in ("/issues/346", "/issues/347"):
        raise ValueError("GitHub destination is not allowlisted")
    if not TOKEN:
        raise ValueError("Missing GitHub Actions token")
    headers = {"Authorization": "Bearer " + TOKEN,
               "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28",
               "User-Agent": "MAGASIN-local-30m-evidence/1"}
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body else None
    if payload is not None:
        headers["Content-Type"] = "application/json"
    with urlopen(Request(API + suffix, data=payload, headers=headers,
                         method=method), timeout=12) as response:
        return json.loads(response.read(180000))


def run_step(label, argv, timeout, report):
    try:
        proc = subprocess.run(argv, cwd=str(MCP if label == "gateway" else COORD),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=timeout, encoding="utf-8", errors="replace",
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        report["actions"].append({"name": label,
             "state": "PASS" if proc.returncode == 0 else "FAILED",
             "exit_code": proc.returncode})
        if proc.returncode != 0:
            report["errors"].append(label + "_FAILED")
        return proc.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        report["actions"].append({"name": label, "state": "ERROR"})
        report["errors"].append(label + "_FAILED")
        return False


def inspect_chatgpt():
    try:
        issue = github("GET", "/issues/346")
        body = str(issue.get("body") or "")
        m = re.search(r"## Latest verified scheduled heartbeat\s*`{3}json\s*(.*?)\s*`{3}",
                      body, re.S)
        item = json.loads(m.group(1)) if m else None
        if (not isinstance(item, dict) or
            item.get("schema") != "MAGASIN_CHATGPT_MONITOR_V1" or
            item.get("executor") != "chatgpt_automation" or
            item.get("target") != "DESKTOP-H4A16IL"):
            return {"state": "UNVERIFIED", "source_issue": 346}
        checked = datetime.fromisoformat(str(item["checked_at"]).replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - checked.astimezone(timezone.utc)).total_seconds()
        status = "FRESH" if 0 <= age <= 5400 else "STALE"
        return {"state":status, "checked_at":item["checked_at"],
                "result":str(item.get("result") or "UNKNOWN")[:40],
                "summary":str(item.get("summary") or "")[:150],
                "source_issue":346}
    except (OSError, ValueError, KeyError, TypeError):
        return {"state":"UNKNOWN", "source_issue":346}


def snapshot():
    guard = read_json(SUP / "guardian-status.json")
    durable = read_json(SUP / "single-conversation-state.json")
    out = durable.get("outbound") or {}
    automation = durable.get("automation") or {}
    coord = read_json(COORD / "state" / "coordinator-status.json")
    gateway = read_json(MCP / "state" / "dispatch-gateway.json")
    stopped = (SUP / "STOP").exists() or (SUP / "AUTOSTART_DISABLED").exists()
    return {
        "supervisor": {
            "status_recorded": str(automation.get("status") or "UNKNOWN")[:40],
            "phase_recorded": str(automation.get("phase") or "UNKNOWN")[:45],
            "wrapper_alive_reported":guard.get("wrapper_alive") is True,
            "watchdog":str(guard.get("watchdog_mode") or "UNKNOWN")[:40],
            "owner_stop": bool(stopped or guard.get("owner_stop")),
            "outbound":str(out.get("state") or "UNKNOWN")[:40],
            "business_completed":False
        },
        "coordinator": {
            "classification_updated":coord.get("updated"),
            "classified":int(coord.get("classified") or 0),
            "owner_enabled":coord.get("owner_enabled") or {},
            "execution_enabled":False,
            "stages":coord.get("states") or {}
        },
        "gateway": {
            "last_poll":gateway.get("at"),
            "github":str(gateway.get("github") or "UNKNOWN")[:40]
        }
    }


def save_atomic(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def publish(report):
    issue = github("GET", "/issues/347")
    old = str(issue.get("body") or "")
    marker = "## Last observed local tick"
    if old.count(marker) != 1:
        raise ValueError("GitHub issue heartbeat marker missing or ambiguous")
    prefix = old.split(marker, 1)[0] + marker
    # Only this issue's dedicated machine heartbeat gets updated.
    body = prefix + "\n\n```json\n" + json.dumps(
        report, ensure_ascii=False, indent=2) + "\n```\n"
    github("PATCH", "/issues/347", {"body":body})


def run(dry_run=False):
    if socket.gethostname().upper() != "DESKTOP-H4A16IL":
        raise SystemExit("WRONG_MACHINE_FAIL_CLOSED")
    if os.getenv("GITHUB_ACTIONS") != "true" and not dry_run:
        raise SystemExit("ONLY_ACTIONS_OR_DRY_RUN")
    if not TOKEN and not dry_run:
        raise SystemExit("ACTIONS_TOKEN_REQUIRED")
    start = time.monotonic()
    report = {"schema":SCHEMA, "checked_at":utc(), "target":"DESKTOP-H4A16IL",
              "task_id":"SC-013", "source_issue":339, "heartbeat_issue":347,
              "cadence":"30_minutes", "executor":"local_github_runner",
              "actions":[], "errors":[], "scope":"SAFE_QUALIFIED_WORK_ONLY",
              "business_execution":"NOT_QUALIFIED_NO_SOT_ADAPTER"}

    # Only existing allowlisted Gateway behavior: non-read-only requests stay
    # WAIT_SOT_AUTHORITY. No arbitrary Issue text becomes an executable command.
    ok_gateway = run_step("gateway",
                         [sys.executable, str(MCP / "dispatch_gateway.py"), "once"], 25, report)
    # Existing classifier is read-only w.r.t. production and leaves Owner flags OFF.
    ok_coord = run_step("coordinator_classify",
                        [sys.executable, str(COORD / "coordinator.py"), "once"], 15, report)
    report.update(snapshot())
    report["chatgpt_monitor"] = inspect_chatgpt() if TOKEN else {
        "state":"NOT_QUERIED_DRY_RUN", "source_issue":346}
    report["work_performed"] = bool(ok_gateway and ok_coord)
    report["result"] = ("CHECKED_AND_CLASSIFIED" if report["work_performed"]
                        else "PARTIAL_OR_ERROR")
    report["elapsed_seconds"] = round(time.monotonic() - start, 2)
    report["completed_at"] = utc()
    # Publish the local snapshot first, even if GitHub writeback fails.
    save_atomic(MONITOR / "sc013-local-30m.json", report)
    save_atomic(MONITOR / "sc013-chatgpt-monitor.json", report["chatgpt_monitor"])
    if not dry_run:
        publish(report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    a = parser.parse_args()
    result = run(a.dry_run)
    print(json.dumps({"result":result["result"], "checked_at":result["checked_at"],
                      "actions":result["actions"], "business_execution":
                      result["business_execution"]}, ensure_ascii=False))
    if result["errors"]:
        raise SystemExit(1)
