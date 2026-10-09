# -*- coding: utf-8 -*-
"""SC-013 read-only Python -> Node SOT preflight bridge (source-only).

Never invokes a business worker, changes Coordinator/Gateway ledgers, starts a
robot, sends ChatGPT outbound, or treats a preflight result as execution authority.
Local deployment is separately SOT-gated and is NOT performed by this module.
"""
from __future__ import annotations

import json
import re
import socket
import sqlite3
import subprocess
from pathlib import Path
from typing import Any, Callable

MACHINE = "DESKTOP-H4A16IL"
SOT_URL = "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md"
SOURCE_RE = re.compile(r"^github:magasincoffee/magasin-supervisor:issue:[1-9][0-9]{0,13}$")
INBOX = Path(r"C:\MAGASIN_MCP\state\jobs.sqlite3")
SUP_STATE = Path(r"C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor")
NODE_BINARY = Path(r"C:\Program Files\nodejs\node.exe")
CLI = Path(__file__).resolve().with_name("sot-preflight-cli.mjs")
MAX_ROWS = 100
MAX_PROBES = 5
VALID_RESULTS = frozenset({
    "SOT_PREFLIGHT_BLOCKED", "SOT_PREFLIGHT_READY_NOT_AUTHORIZED",
    "SOT_PREFLIGHT_UNAVAILABLE", "REJECTED",
})


def result(status: str, reason: str, *, source_id: str | None = None,
           task_id: str | None = None, evidence: dict | None = None) -> dict:
    out: dict[str, Any] = {
        "schema": "MAGASIN_PYTHON_PREFLIGHT_BRIDGE_V1",
        "status": status, "reason": reason,
        "execution_qualified": False, "dispatched": False,
        "business_completed": False,
    }
    if source_id is not None:
        out["source_id"] = source_id
    if task_id is not None:
        out["task_id"] = task_id
    if evidence:
        # The subprocess response has already been shape-validated.
        out["evidence"] = evidence
    return out


def read_gateway_rows(path: Path = INBOX) -> list[dict]:
    """Query a validated Gateway inbox in SQLite read-only mode."""
    if not path.is_file():
        raise FileNotFoundError("GATEWAY_INBOX_MISSING")
    cx = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=3)
    cx.row_factory = sqlite3.Row
    try:
        rows = cx.execute(
            "SELECT source_id,source,task_id,target,action,sot_url,status "
            "FROM dispatch_inbox ORDER BY received_at DESC LIMIT ?", (MAX_ROWS,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        cx.close()


def candidate_envelope(row: dict) -> dict | None:
    """Gateway receipt metadata is a request, NOT task/Owner authority."""
    if not isinstance(row, dict):
        return None
    source_id = row.get("source_id")
    if (not isinstance(source_id, str) or not SOURCE_RE.fullmatch(source_id) or
        row.get("source") != "github" or row.get("target") != "supervisor" or
        row.get("task_id") != "SC-013" or
        row.get("action") != "execute_task" or
        row.get("sot_url") != SOT_URL or
        row.get("status") != "WAIT_SOT_AUTHORITY"):
        return None
    return {"schema": "MAGASIN_DISPATCH_V1",
            "task_id": "SC-013", "target": "supervisor",
            "action": "execute_task", "sot_url": SOT_URL,
            "source_id": source_id, "status": "WAIT_SOT_AUTHORITY"}


def stop_present(root: Path = SUP_STATE) -> bool:
    # A positive STOP is sufficient to block. Absence never means Owner ENABLE.
    return (root / "STOP").exists() or (root / "AUTOSTART_DISABLED").exists()


def probe_one(envelope: dict, *, node: Path = NODE_BINARY, cli: Path = CLI,
              run: Callable[..., Any] = subprocess.run) -> dict:
    """Execute only the immutable, known read-only Node CLI; no shell."""
    source_id = envelope["source_id"]
    if not node.is_file() or not cli.is_file():
        return result("SOT_PREFLIGHT_UNAVAILABLE", "LOCAL_CLI_NOT_INSTALLED",
                      source_id=source_id, task_id="SC-013")
    try:
        proc = run(
            [str(node), str(cli)], input=json.dumps(envelope, separators=(",", ":")),
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=12, cwd=str(cli.parent),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if proc.returncode != 0 or len(proc.stdout) > 16384:
            raise ValueError("CLI_FAILED_OR_OVERSIZED")
        report = json.loads(proc.stdout)
        if (not isinstance(report, dict) or
            report.get("schema") != "MAGASIN_SOT_ADAPTER_RESULT_V1" or
            report.get("status") not in VALID_RESULTS or
            report.get("execution_qualified") is not False or
            report.get("dispatched") is not False):
            raise ValueError("CLI_RESPONSE_UNTRUSTED")
        safe = {
            "status": report["status"], "reason": str(report.get("reason") or "")[:64],
            "task_state": str(report.get("task_state") or "")[:32],
            "revision": str(report.get("revision") or "")[:40],
        }
        return result("SOT_READ_ONLY_CLASSIFIED", "PREFLIGHT_NOT_AUTHORIZATION",
                      source_id=source_id, task_id="SC-013", evidence=safe)
    except (OSError, ValueError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return result("SOT_PREFLIGHT_UNAVAILABLE", "CLI_FAILED_CLOSED",
                      source_id=source_id, task_id="SC-013")


def run_once(*, hostname: str | None = None,
             inbox: Path = INBOX, stop_root: Path = SUP_STATE,
             probe: Callable[[dict], dict] = probe_one) -> dict:
    host = (hostname or socket.gethostname()).upper()
    if host != MACHINE:
        return {"mode": "READ_ONLY", "machine": host, "results": [
            result("REJECTED", "WRONG_TARGET_MACHINE")
        ], "probes": 0}
    if stop_present(stop_root):
        return {"mode": "READ_ONLY", "machine": host, "results": [
            result("WAIT_OWNER_STOP", "OWNER_STOP_OR_AUTOSTART_DISABLED")
        ], "probes": 0}
    try:
        rows = read_gateway_rows(inbox)
    except (OSError, sqlite3.Error):
        return {"mode": "READ_ONLY", "machine": host, "results": [
            result("SOT_PREFLIGHT_UNAVAILABLE", "GATEWAY_DB_UNAVAILABLE")
        ], "probes": 0}
    unique: set[str] = set()
    results = []
    for row in rows:
        env = candidate_envelope(row)
        if env is None or env["source_id"] in unique:
            continue
        unique.add(env["source_id"])
        if len(unique) > MAX_PROBES:
            break
        results.append(probe(env))
    return {"mode": "READ_ONLY", "machine": host, "probes": len(results),
            "results": results, "execution_enabled": False}


if __name__ == "__main__":
    # Intentional stdout-only operator diagnostic. Not installed as a scheduler.
    print(json.dumps(run_once(), ensure_ascii=True, separators=(",", ":")))
