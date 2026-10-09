# -*- coding: utf-8 -*-
"""SC-013 project Source-of-Truth links in unified Control Center.

Owner may submit a GitHub SOT URL for later project qualification while the
Supervisor is physically OFF. Saving a request NEVER modifies the authoritative
live single-conversation-control.json, starts a worker, fetches arbitrary URL,
or qualifies GitHub SOT readiness. Only the project SOT can authorize tasks.

The Supervisor runtime already reads source_of_truth_url from its own
single-conversation-control.json. This module surfaces the binding and keeps
new requests separate until an explicit reviewed activation gate exists.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

SCHEMA = "MAGASIN_SC013_SUPERVISOR_PROJECT_LINKS_V1"
REQUEST_SCHEMA = "MAGASIN_SC013_SUPERVISOR_SOT_REQUESTS_V1"
HOST = "DESKTOP-H4A16IL"
CURRENT = Path(os.environ.get("LOCALAPPDATA", "")) / "MAGASIN" / "BusinessOS" / "supervisor" / "single-conversation-control.json"
SUPERVISOR_ROOT = Path(os.environ.get("LOCALAPPDATA", "")) / "MAGASIN" / "BusinessOS" / "supervisor"
REQUESTS = Path(r"D:\MAGASIN_ROBOTS\robots\supervisor\config\project_sot_requests.json")
MAX_BYTES = 16384
MAX_REQUESTS = 10
SOT_NAME = re.compile(r"^[A-Za-z0-9_.-]*SOURCE_OF_TRUTH\.md$", re.I)
SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
SAFE_REPO = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")


class Rejected(ValueError):
    pass


def parse_sot_url(raw: str) -> dict:
    """Accept only canonical main-branch GitHub MAGASIN SOT document links.

    This validates *shape*, not permission, file existence, source revision,
    project state, or SOT READY. No URL is fetched or executed.
    """
    if type(raw) is not str or raw != raw.strip() or not 40 <= len(raw) <= 600:
        raise Rejected("SOT_URL_INVALID")
    if any(c in raw for c in ("%", "\\", "\n", "\r", "\t", " ", "#", "?")):
        raise Rejected("SOT_URL_NONCANONICAL")
    try:
        parsed = urlsplit(raw)
    except ValueError as exc:
        raise Rejected("SOT_URL_INVALID") from exc
    if (parsed.scheme != "https" or parsed.netloc != "github.com"
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise Rejected("SOT_HOST_NOT_ALLOWED")
    segments = parsed.path.split("/")
    if (len(segments) < 6 or segments[0] != "" or
            segments[1] != "magasincoffee" or
            segments[3:5] != ["blob", "main"] or
            not SAFE_REPO.fullmatch(segments[2]) or
            any(not SAFE_SEGMENT.fullmatch(s) or s in (".", "..") for s in segments[5:]) or
            not SOT_NAME.fullmatch(segments[-1])):
        raise Rejected("SOT_PATH_NOT_CANONICAL")
    return {
        "repository": f"magasincoffee/{segments[2]}",
        "source_repo_url": f"https://github.com/magasincoffee/{segments[2]}",
        "sot_url": raw,
        "branch": "main",
        "sot_path": "/".join(segments[5:]),
    }


def _read_json(path: Path) -> dict:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise Rejected("PROJECT_FILE_MISSING_OR_UNTRUSTED")
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, UnicodeError) as exc:
        raise Rejected("PROJECT_JSON_INVALID") from exc
    if type(data) is not dict:
        raise Rejected("PROJECT_JSON_NOT_OBJECT")
    return data


def _current_binding(path: Path):
    data = _read_json(path)
    if (data.get("schema_version") != "single-conversation-control.v1"
            or data.get("mode") != "SINGLE_CONVERSATION_V1"):
        raise Rejected("LIVE_SUPERVISOR_MODE_UNQUALIFIED")
    link = parse_sot_url(data.get("source_of_truth_url"))
    # These are navigational facts only, never a SOT task state or START proof.
    return {
        **link, "project_id": str(data.get("project_id", ""))[:90],
        "binding": "CONFIGURED_IN_RUNTIME_NOT_RUNNING",
        "sot_verified": False, "execution_authorized": False,
    }


def inspect(*, current: Path = CURRENT, requests: Path = REQUESTS,
            stop_root: Path = SUPERVISOR_ROOT, machine: str | None = None) -> dict:
    """Read current saved SOT and pending proposals without changing worker."""
    result = {
        "schema": SCHEMA,
        "active": None,
        "requests": [],
        "save_allowed": False,
        "status": "BLOCKED_UNVERIFIED",
        "blockers": [],
        "new_link_activates_project": False,
        "worker_start_allowed": False,
        "business_dispatch_authorized": False,
        "read_only": True,
    }
    if (machine or os.environ.get("COMPUTERNAME", "")).upper() != HOST:
        result["blockers"].append("WRONG_MACHINE")
        return result
    if not ((stop_root / "STOP").is_file() and
            (stop_root / "AUTOSTART_DISABLED").is_file()):
        result["blockers"].append("SUPERVISOR_NOT_OWNER_STOPPED")
        return result
    try:
        result["active"] = _current_binding(current)
    except (Rejected, OSError):
        result["blockers"].append("ACTIVE_SOT_NOT_QUALIFIED")
        return result
    if requests.exists():
        try:
            saved = _read_json(requests)
            if saved.get("schema") != REQUEST_SCHEMA or type(saved.get("requests")) is not list:
                raise Rejected("PROJECT_REQUESTS_SCHEMA_INVALID")
            for row in saved["requests"][:MAX_REQUESTS]:
                if type(row) is not dict or set(row) != {"id", "url", "created_at", "status"}:
                    raise Rejected("PROJECT_REQUEST_SHAPE_INVALID")
                src = parse_sot_url(row["url"])
                identifier = hashlib.sha256(row["url"].encode("utf-8")).hexdigest()[:24]
                if identifier != row["id"] or row["status"] != "PENDING_SOT_REVIEW":
                    raise Rejected("PROJECT_REQUEST_IDENTITY_INVALID")
                result["requests"].append({**src, "id":identifier,
                                            "status":"PENDING_SOT_REVIEW",
                                            "execution_authorized":False})
        except (Rejected, OSError):
            result["blockers"].append("REQUEST_REGISTRY_NOT_TRUSTED")
            return result
    result["save_allowed"] = True
    result["status"] = "OWNER_STOP_SAFE_TO_SAVE_LINK_REQUEST_ONLY"
    return result


def save_request(url: str, confirm: str, *, current: Path = CURRENT,
                 requests: Path = REQUESTS, stop_root: Path = SUPERVISOR_ROOT,
                 machine: str | None = None, when: datetime | None = None) -> dict:
    """Idempotent, atomic proposal write; never touch live runtime config.

    This is NOT a selection or an authorization for executing a project.
    """
    if confirm != "SAVE_SUPERVISOR_SOT_LINK_ONLY":
        raise Rejected("OWNER_CONFIRM_REQUIRED")
    info = parse_sot_url(url)
    check = inspect(current=current, requests=requests, stop_root=stop_root, machine=machine)
    if not check["save_allowed"]:
        raise Rejected("OWNER_STOP_OR_BINDING_UNVERIFIED")
    identifier = hashlib.sha256(info["sot_url"].encode("utf-8")).hexdigest()[:24]
    if check["active"]["sot_url"] == info["sot_url"]:
        return {"ok": True, "status":"ALREADY_LINKED_ACTIVE",
                "id":identifier, "new_link_activates_project":False,
                "execution_authorized":False}
    if any(row["id"] == identifier for row in check["requests"]):
        return {"ok": True, "status":"ALREADY_PENDING_REVIEW",
                "id":identifier, "new_link_activates_project":False,
                "execution_authorized":False}
    if requests.exists() and requests.is_symlink():
        raise Rejected("REGISTRY_SYMLINK_FORBIDDEN")
    if not requests.parent.is_dir() or requests.parent.is_symlink():
        raise Rejected("REGISTRY_DIRECTORY_UNTRUSTED")
    items = [
        {"id":r["id"], "url":r["sot_url"], "created_at":r.get("created_at", ""),
         "status":"PENDING_SOT_REVIEW"} for r in check["requests"]
    ]
    items.append({
        "id":identifier, "url":info["sot_url"],
        "created_at":(when or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat(),
        "status":"PENDING_SOT_REVIEW",
    })
    if len(items) > MAX_REQUESTS:
        raise Rejected("MAX_PROJECT_REQUESTS_REACHED")
    payload = json.dumps({"schema":REQUEST_SCHEMA,"requests":items},
                         ensure_ascii=False, indent=2).encode("utf-8")
    if len(payload) > MAX_BYTES:
        raise Rejected("REGISTRY_TOO_LARGE")
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=requests.parent,
                                         prefix=".sc013-project-request-", suffix=".tmp",
                                         delete=False) as file:
            temp_path = Path(file.name)
            file.write(payload)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp_path, requests)
    except OSError as exc:
        raise Rejected("REGISTRY_WRITE_FAILED") from exc
    finally:
        if temp_path and temp_path.exists():
            temp_path.unlink()
    return {"ok": True, "status":"PENDING_SOT_REVIEW",
            "id":identifier, "new_link_activates_project":False,
            "execution_authorized":False}
