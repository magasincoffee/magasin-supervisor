# -*- coding: utf-8 -*-
"""SC-013: source-verified Supervisor project activation preflight.

STRICTLY NON-ACTUATING. An Owner may ask the Control Center to check a saved
project Source of Truth, but this verifier NEVER switches the live project,
clears Owner STOP, starts a worker, queues a task, or changes any file.

A verified GitHub document is evidence that a SOT exists at a particular
revision, NOT evidence that a specific task is READY, that an ambiguous
outbound was not delivered, or that Owner START was authorized.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import socket
from pathlib import Path
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import URLError, HTTPError

import supervisor_project_links as links

SCHEMA = "MAGASIN_SC013_PROJECT_ACTIVATION_PREFLIGHT_V1"
MAX_HTTP_BYTES = 1_200_000  # Base64 response can exceed decoded SOT length.
MAX_SOT_BYTES = 750_000
MAX_STATE_BYTES = 128_000
GITHUB_SHA = re.compile(r"^[0-9a-f]{40}$")
BLOCKING_STATUSES = frozenset((
    "ENQUEUED", "PENDING", "PREPARED", "SENDING", "IN_FLIGHT",
    "WAIT_ACK", "DELIVERED", "RESPONSE_RUNNING", "SUBMIT_ACTUATED",
    "EXACT_ONCE_FAILED", "BLOCKED_UNKNOWN_OUTCOME", "BLOCKED",
))


class Rejected(ValueError):
    pass


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, hdrs, newurl):
        raise Rejected("SOT_REDIRECT_NOT_ALLOWED")


def _read_json(path: Path, *, max_size: int = MAX_STATE_BYTES) -> dict:
    if path.is_symlink() or not path.is_file():
        raise Rejected("LOCAL_STATE_NOT_TRUSTED")
    if not 2 <= path.stat().st_size <= max_size:
        raise Rejected("LOCAL_STATE_SIZE_UNTRUSTED")
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, UnicodeError) as exc:
        raise Rejected("LOCAL_STATE_INVALID") from exc
    if type(data) is not dict:
        raise Rejected("LOCAL_STATE_NOT_OBJECT")
    return data


def _read_git_snapshot(source: dict, *, token: str | None = None,
                       opener=None) -> dict:
    """Fetch one exact allowlisted GitHub Contents API main-branch SOT.

    No user-controlled host, shell command, redirects or embedded credentials.
    The contents response must cryptographically match its Git blob SHA.
    """
    # The source is derived from a strictly checked GitHub URL, not an arbitrary
    # HTTP endpoint. No percent encoded or traversal segments are accepted.
    link = links.parse_sot_url(source["sot_url"])
    path = link["sot_path"]
    repo = link["repository"].split("/", 1)[1]
    url = f"https://api.github.com/repos/magasincoffee/{repo}/contents/{path}?ref=main"
    headers = {"Accept": "application/vnd.github+json",
               "User-Agent": "MAGASIN-SC013-SOT-Preflight/1.0"}
    if token:
        if type(token) is not str or len(token) > 1024 or "\n" in token or "\r" in token:
            raise Rejected("BAD_GITHUB_TOKEN")
        headers["Authorization"] = "Bearer " + token
    fetch = opener or build_opener(_NoRedirect())
    request = Request(url, headers=headers, method="GET")
    try:
        response = fetch.open(request, timeout=8)
        with response:
            if response.status != 200:
                raise Rejected("GITHUB_CONTENTS_NOT_200")
            if response.geturl() != url:
                raise Rejected("GITHUB_HOST_CHANGED")
            contents = response.read(MAX_HTTP_BYTES + 1)
    except (OSError, HTTPError, URLError) as exc:
        raise Rejected("GITHUB_SOT_NOT_ACCESSIBLE") from exc
    if len(contents) > MAX_HTTP_BYTES:
        raise Rejected("GITHUB_SOT_RESPONSE_OVERSIZED")
    try:
        data = json.loads(contents)
    except (TypeError, UnicodeError, ValueError) as exc:
        raise Rejected("GITHUB_SOT_JSON_INVALID") from exc
    if type(data) is not dict:
        raise Rejected("GITHUB_SOT_NOT_A_FILE")
    if (data.get("type") != "file" or data.get("encoding") != "base64" or
            data.get("path") != path or
            not GITHUB_SHA.fullmatch(str(data.get("sha", ""))) or
            type(data.get("content")) is not str):
        raise Rejected("GITHUB_SOT_METADATA_INVALID")
    try:
        raw = base64.b64decode(data["content"], validate=False)
        text = raw.decode("utf-8-sig")
    except (ValueError, UnicodeError) as exc:
        raise Rejected("GITHUB_SOT_CONTENT_INVALID") from exc
    if not 30 <= len(raw) <= MAX_SOT_BYTES:
        raise Rejected("GITHUB_SOT_CONTENT_SIZE_INVALID")
    actual_sha = hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") +
                              b"\0" + raw).hexdigest()
    if actual_sha != data["sha"]:
        raise Rejected("GITHUB_SOT_BLOB_MISMATCH")
    # SOT identity is checked as a file/document, not as a READY task.
    first_line = text.splitlines()[0].strip() if text else ""
    if not first_line.startswith("#") or "SOURCE_OF_TRUTH" in first_line:
        raise Rejected("GITHUB_SOT_DOCUMENT_INVALID")
    return {
        "repository": link["repository"],
        "sot_path": path,
        "github_blob_sha": data["sha"],
        "content_sha256": hashlib.sha256(raw).hexdigest(),
        "sot_bytes": len(raw),
        "document_exists": True,
        "task_ready_verified": False,
        "business_execution_authorized": False,
    }


def verify_sot(source: dict, *, token: str | None = None,
               opener=None) -> dict:
    """Use two matching HTTPS reads; mismatch means do not qualify source."""
    first = _read_git_snapshot(source, token=token, opener=opener)
    second = _read_git_snapshot(source, token=token, opener=opener)
    if first != second:
        raise Rejected("GITHUB_SOT_CHANGED_DURING_VERIFICATION")
    return first


def _transaction_guard(state_path: Path) -> list[str]:
    try:
        value = _read_json(state_path)
    except (Rejected, OSError):
        return ["SUPERVISOR_TRANSACTION_STATE_UNVERIFIED"]
    outbound = value.get("outbound")
    if type(outbound) is not dict:
        return ["SUPERVISOR_OUTBOUND_UNVERIFIED"]
    state = outbound.get("state")
    if state in BLOCKING_STATUSES:
        return ["SUPERVISOR_OUTBOUND_UNKNOWN_OUTCOME_NO_REPLAY"]
    if state in ("VERIFIED", "DONE_CONFIRMED", "CANCELLED_CONFIRMED"):
        # Even this is not independent delivery-receipt attestation.
        return ["SUPERVISOR_TRANSACTION_RECEIPT_NOT_INDEPENDENTLY_ATTESTED"]
    return ["SUPERVISOR_OUTBOUND_UNVERIFIED"]


def inspect_candidate(
    request_id: str, *, current: Path = links.CURRENT,
    requests: Path = links.REQUESTS,
    stop_root: Path = links.SUPERVISOR_ROOT,
    transaction_path: Path | None = None,
    machine: str | None = None,
    fetcher=verify_sot,
) -> dict:
    """Return a truthful per-project readiness report; no side effects.

    Only pending *already saved* project proposals are considered. The Owner
    must separately approve and activate any project after this verifier and
    the independent worker/transaction/Owner gates qualify.
    """
    result = {
        "schema": SCHEMA, "status": "BLOCKED_NOT_QUALIFIED",
        "candidate": None, "sot_evidence": None,
        "blockers": [],
        "project_switch_allowed": False,
        "task_ready_verified": False,
        "owner_start_verified": False,
        "worker_identity_verified": False,
        "business_dispatch_authorized": False,
        "worker_started": False, "any_state_mutation": False,
        "next_step": "OWNER_STOP_SOT_AND_TRANSACTION_RECONCILIATION",
    }
    if type(request_id) is not str or not re.fullmatch(r"[0-9a-f]{24}", request_id):
        result["blockers"].append("PROJECT_REQUEST_ID_INVALID")
        return result
    report = links.inspect(current=current, requests=requests,
                           stop_root=stop_root, machine=machine)
    result["blockers"].extend(report.get("blockers", []))
    if not report.get("save_allowed"):
        result["blockers"].append("OWNER_STOP_OR_CURRENT_BINDING_UNVERIFIED")
        return result
    selected = next((item for item in report["requests"]
                     if item["id"] == request_id), None)
    if selected is None:
        result["blockers"].append("PROJECT_REQUEST_NOT_PENDING")
        return result
    result["candidate"] = {"repository": selected["repository"],
                            "sot_url": selected["sot_url"],
                            "id": selected["id"]}
    tx_path = transaction_path or stop_root / "single-conversation-state.json"
    result["blockers"].extend(_transaction_guard(tx_path))
    # Network access is constrained to a single constructed GitHub API host
    # and exact repository/path; no run, no mutation and no task authority.
    try:
        result["sot_evidence"] = fetcher(selected)
    except (Rejected, OSError, ValueError):
        result["blockers"].append("GITHUB_SOT_UNVERIFIED")
    # Never infer a READY task or grant a project switch from verified
    # filename/content alone, even if the transaction appears stopped.
    result["blockers"].extend([
        "PROJECT_SWITCH_AUTHORITY_NOT_QUALIFIED",
        "SOT_NEXT_TASK_REQUIRES_AUTHORITATIVE_RESYNC",
        "OWNER_WORKER_START_ATTESTATION_REQUIRED",
    ])
    result["blockers"] = sorted(set(result["blockers"]))
    return result
