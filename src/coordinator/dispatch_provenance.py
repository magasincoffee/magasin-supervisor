# -*- coding: utf-8 -*-
"""SC-013 read-only Issue/Gateway provenance and independent Owner evidence gate.

Not imported by the installed Coordinator, local tick or Business Executor.
A GitHub Issue from an expected author is a REQUEST, not SOT/Owner authority.
All outcomes categorically deny production dispatch, including matching inputs.

GitHub API read uses a caller-supplied scoped token over pinned HTTPS to an
exact Issue endpoint; never accepts a URL from issue text, never follows a
redirect, never writes or runs a specialist.
"""
from __future__ import annotations

import hashlib
import json
import re
import socket
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.request import Request, HTTPRedirectHandler, build_opener

REPO = "magasincoffee/magasin-supervisor"
EXPECTED_AUTHOR_LOGIN = "magasincoffee"
EXPECTED_AUTHOR_ID = 191064507
SOT_URL = "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md"
API = f"https://api.github.com/repos/{REPO}"
ISSUE_RE = re.compile(r"^github:magasincoffee/magasin-supervisor:issue:([1-9][0-9]{0,12})$")
MAX_ISSUE_BYTES = 65536
MAX_DB_ROWS = 1
MACHINE = "DESKTOP-H4A16IL"
GATEWAY = Path(r"C:\MAGASIN_MCP\state\jobs.sqlite3")
LIFECYCLE = Path(r"D:\MAGASIN_ROBOTS\robots\coordinator\state\owner-lifecycle.json")
FLAGS = Path(r"D:\MAGASIN_ROBOTS\robots\coordinator\config\owner_enabled.json")
STOP_ROOT = Path(r"C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor")

FIELDS = frozenset({"schema", "task_id", "target", "action", "sot_url"})
ENVELOPE = {
    "schema": "MAGASIN_DISPATCH_V1", "task_id": "SC-013",
    "target": "supervisor", "action": "execute_task", "sot_url": SOT_URL,
}
LIFECYCLE_SCHEMA = "MAGASIN_SC013_OWNER_MONITOR_LIFECYCLE_V1"
REPORT_SCHEMA = "MAGASIN_SC013_PROVENANCE_INSPECTION_V1"


class InspectionRejected(ValueError):
    pass


def _result(status: str, reason: str, *, source_id: str = "",
            issue_body_sha256: str = "", owner_monitor: str = "UNVERIFIED"):
    return {
        "schema": REPORT_SCHEMA, "status": status, "reason": reason,
        "source_id": source_id, "issue_body_sha256": issue_body_sha256,
        "owner_monitor": owner_monitor,
        "issue_gateway_fields_matched": status == "REQUEST_PROVENANCE_MATCHED_ONLY",
        "specialist_owner_authority_verified": False,
        "sot_execution_authority_verified": False,
        "business_dispatch_authorized": False,
        "execution_qualified": False,
        "dispatched": False,
        "business_completed": False,
    }


def _unique_object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise InspectionRejected("DUPLICATE_JSON_FIELD")
        out[key] = value
    return out


def _parse_json(data: str):
    if not isinstance(data, str) or len(data.encode("utf-8")) > MAX_ISSUE_BYTES:
        raise InspectionRejected("ISSUE_JSON_SIZE")
    try:
        return json.loads(data, object_pairs_hook=_unique_object)
    except (ValueError, UnicodeError) as exc:
        raise InspectionRejected("ISSUE_JSON_INVALID") from exc


def _issue_number(source_id):
    if type(source_id) is not str:
        raise InspectionRejected("SOURCE_ID_INVALID")
    match = ISSUE_RE.fullmatch(source_id)
    if not match or int(match.group(1)) > 2**31 - 1:
        raise InspectionRejected("SOURCE_ID_INVALID")
    return int(match.group(1))


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise InspectionRejected("GITHUB_REDIRECT_DISALLOWED")


def fetch_issue(number: int, *, token: str,
                opener: Callable[[Request], Any] | None = None):
    """Read one exact GitHub Issue from GitHub HTTPS API with bearer identity.

    This authenticates the transport/platform response, not a cryptographic
    signature made by Owner, nor project SOT readiness. The caller MUST NOT
    treat success as permission to dispatch.
    """
    if type(number) is not int or number < 1 or number > 2**31 - 1:
        raise InspectionRejected("ISSUE_NUMBER_INVALID")
    if type(token) is not str or not 8 <= len(token) <= 2048 or "\n" in token:
        raise InspectionRejected("SCOPED_GITHUB_TOKEN_REQUIRED")
    url = f"{API}/issues/{number}"
    req = Request(url, headers={
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "MAGASIN-SC013-Provenance-ReadOnly/1",
    }, method="GET")
    open_call = opener or build_opener(_NoRedirect()).open
    try:
        with open_call(req) as response:
            status = int(getattr(response, "status", 0))
            actual_url = response.geturl()
            if status != 200 or actual_url != url:
                raise InspectionRejected("GITHUB_ORIGIN_NOT_VERIFIED")
            raw = response.read(MAX_ISSUE_BYTES + 1)
            if len(raw) > MAX_ISSUE_BYTES:
                raise InspectionRejected("GITHUB_RESPONSE_TOO_LARGE")
            return _parse_json(raw.decode("utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        if isinstance(exc, InspectionRejected):
            raise
        raise InspectionRejected("GITHUB_API_UNAVAILABLE") from exc


def read_gateway_row(source_id: str, *, db: Path = GATEWAY):
    """Queries the real Gateway inbox only in SQLite mode=ro, no DB writes."""
    _issue_number(source_id)
    if not isinstance(db, Path) or not db.is_file() or db.is_symlink():
        raise InspectionRejected("GATEWAY_DB_NOT_TRUSTED")
    cx = None
    try:
        cx = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True, timeout=2)
        cx.row_factory = sqlite3.Row
        rows = cx.execute(
            "SELECT source_id,source,task_id,target,action,sot_url,status,local_job_id "
            "FROM dispatch_inbox WHERE source_id=? LIMIT ?", (source_id, MAX_DB_ROWS + 1)
        ).fetchall()
        if len(rows) != 1:
            raise InspectionRejected("GATEWAY_RECEIPT_MISSING")
        return dict(rows[0])
    except sqlite3.DatabaseError as exc:
        raise InspectionRejected("GATEWAY_SQLITE_UNAVAILABLE") from exc
    finally:
        if cx is not None:
            cx.close()


def check_issue_gateway(source_id: str, issue: dict, row: dict):
    """Strict validation against independently re-fetched issue metadata.

    Issue body is deliberately checked as *only* an envelope request; it does
    not certify TASK READY, task acceptance or Owner specialist START.
    """
    number = _issue_number(source_id)
    if not isinstance(issue, dict) or not isinstance(row, dict):
        raise InspectionRejected("ISSUE_OR_GATEWAY_UNAVAILABLE")
    try:
        user = issue["user"]
        if (type(issue.get("number")) is not int or issue["number"] != number or
            type(issue.get("id")) is not int or issue["id"] < 1 or
            type(user) is not dict or
            user.get("login") != EXPECTED_AUTHOR_LOGIN or
            type(user.get("id")) is not int or
            user["id"] != EXPECTED_AUTHOR_ID or
            issue.get("state") != "open" or
            "pull_request" in issue or
            not isinstance(issue.get("title"), str) or
            not issue["title"].startswith("[MAGASIN-DISPATCH]") or
            issue.get("html_url") != f"https://github.com/{REPO}/issues/{number}" or
            issue.get("url") != f"{API}/issues/{number}" or
            issue.get("repository_url") != API):
            raise InspectionRejected("GITHUB_ISSUE_METADATA_MISMATCH")
        body = issue.get("body")
        payload = _parse_json(body)
        if type(payload) is not dict or set(payload) != FIELDS or payload != ENVELOPE:
            raise InspectionRejected("ISSUE_ENVELOPE_NOT_ALLOWLISTED")
        if (set(row) != {"source_id","source","task_id","target","action",
                          "sot_url","status","local_job_id"} or
            row.get("source_id") != source_id or row.get("source") != "github" or
            row.get("task_id") != payload["task_id"] or
            row.get("target") != payload["target"] or
            row.get("action") != payload["action"] or
            row.get("sot_url") != payload["sot_url"] or
            row.get("status") != "WAIT_SOT_AUTHORITY" or
            row.get("local_job_id") is not None):
            raise InspectionRejected("ISSUE_GATEWAY_RECEIPT_MISMATCH")
        return hashlib.sha256(body.encode("utf-8")).hexdigest()
    except (KeyError, TypeError, AttributeError) as exc:
        raise InspectionRejected("GITHUB_OR_GATEWAY_FIELDS_MISSING") from exc


def _read_small_json(path: Path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 8192:
        raise InspectionRejected("OWNER_EVIDENCE_MISSING_OR_OVERSIZED")
    data = _parse_json(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise InspectionRejected("OWNER_EVIDENCE_NOT_OBJECT")
    return data


def observe_owner(*, machine: str | None = None, lifecycle: Path = LIFECYCLE,
                  flags: Path = FLAGS, stop_root: Path = STOP_ROOT):
    """Pure read-only lifecycle observation; never authenticates specialist START.

    A local Coordinator MONITOR_READ_ONLY is *not* a Supervisor START.
    owner_enabled.json is advisory and cannot grant any specialist authority.
    """
    if (machine or socket.gethostname()).upper() != MACHINE:
        raise InspectionRejected("WRONG_TARGET_MACHINE")
    if (stop_root / "STOP").exists() or (stop_root / "AUTOSTART_DISABLED").exists():
        raise InspectionRejected("OWNER_STOP_ACTIVE")
    actual = _read_small_json(lifecycle)
    advisory = _read_small_json(flags)
    if (actual.get("schema") != LIFECYCLE_SCHEMA or
        actual.get("desired") != "MONITOR_READ_ONLY" or
        actual.get("control_source") != "local_control_center" or
        type(actual.get("generation")) is not int or actual["generation"] < 1 or
        actual.get("execution_enabled") is not False or
        actual.get("business_dispatch_enabled") is not False or
        actual.get("specialists_started") is not False):
        raise InspectionRejected("COORDINATOR_OWNER_MONITOR_UNQUALIFIED")
    # A stale/malformed time must not be interpreted as fresh Owner authority.
    at = actual.get("requested_at")
    try:
        parsed = datetime.fromisoformat(at.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("timestamp without timezone")
    except (ValueError, TypeError, AttributeError) as exc:
        raise InspectionRejected("OWNER_TIMESTAMP_INVALID") from exc
    if (set(advisory) != {"supervisor","saydi","sapo"} or
        any(advisory[k] is not False for k in ("supervisor","saydi","sapo"))):
        raise InspectionRejected("SPECIALIST_OWNER_FLAGS_NOT_OFF")
    return {
        "coordinator_monitor": "OWNER_MONITOR_READ_ONLY_OBSERVED",
        "specialist_owner_lifecycle": "UNVERIFIED_NO_SPECIALIST_OWNER_START_PROOF",
        "specialist_dispatch_authorized": False,
        "business_dispatch_authorized": False,
    }


def inspect_once(source_id: str, *, token: str,
                 issue_fetch: Callable[..., dict] = fetch_issue,
                 gateway_read: Callable[[str], dict] = read_gateway_row,
                 owner_read: Callable[[], dict] = observe_owner):
    """Two independent GitHub reads bracket local evidence to detect edits.

    This result CANNOT be promoted to an executable task. A real worker's
    lifecycle attestation plus a live canonical SOT READY proof remain missing.
    """
    try:
        number = _issue_number(source_id)
        first = issue_fetch(number, token=token)
        row = gateway_read(source_id)
        digest = check_issue_gateway(source_id, first, row)
        owner = owner_read()
        second = issue_fetch(number, token=token)
        second_digest = check_issue_gateway(source_id, second, row)
        if (first.get("updated_at") != second.get("updated_at") or
            digest != second_digest or first.get("id") != second.get("id")):
            raise InspectionRejected("ISSUE_CHANGED_DURING_CHECK")
        if (not isinstance(owner, dict) or
            owner.get("coordinator_monitor") != "OWNER_MONITOR_READ_ONLY_OBSERVED" or
            owner.get("specialist_dispatch_authorized") is not False or
            owner.get("business_dispatch_authorized") is not False):
            raise InspectionRejected("OWNER_OBSERVER_UNTRUSTED")
        return _result("REQUEST_PROVENANCE_MATCHED_ONLY",
                       "OWNER_SPECIALIST_AND_SOT_AUTHORITY_MISSING",
                       source_id=source_id, issue_body_sha256=digest,
                       owner_monitor=owner["coordinator_monitor"])
    except InspectionRejected as exc:
        return _result("BLOCKED_NOT_QUALIFIED", str(exc), source_id=str(source_id)[:150])
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return _result("BLOCKED_NOT_QUALIFIED", "UNEXPECTED_READ_ONLY_INPUT",
                       source_id=str(source_id)[:150])
