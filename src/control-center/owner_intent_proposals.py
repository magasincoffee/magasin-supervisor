# -*- coding: utf-8 -*-
"""MPC-007 — pure Owner-approved intent -> draft proposal projection.

SOURCE/QA ONLY. No filesystem, SQLite, network, GitHub API, SOT write or
worker side effects. Nothing in this module approves requests or dispatches work.
The separate approval issuer, live authority snapshot verifier and secure H4
credential provisioner are NOT implemented or authorized by MPC-007.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import uuid
from urllib.parse import urlsplit

OWNER = "magasincoffee"
APPROVAL_SCHEMA = "MAGASIN_MPC_OWNER_APPROVAL_EVIDENCE_V1"
PROPOSAL_SCHEMA = "MAGASIN_MPC_TASK_PROPOSAL_V1"
PENDING = "PENDING_OWNER_REVIEW"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX40 = re.compile(r"^[0-9a-f]{40}$")
TARGET = re.compile(r"^[A-Za-z0-9_-]{1,70}/[A-Za-z0-9_-]{1,70}/[A-Za-z0-9_-]{1,70}$")
SCREEN = re.compile(r"^/user-attachments/assets/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
ALLOWED_SOURCES = {
    "supervisor": ("magasincoffee/magasin-supervisor", "SOURCE_OF_TRUTH.md"),
    "workforce": ("magasincoffee/magasincoffee.github.io",
                  "01_DOCS/MAGASIN/05_SYSTEM/WORKFORCE_CROSS_STORE_SCHEDULING_TEMP_SOURCE_OF_TRUTH.md"),
    "print-ops": ("magasincoffee/OPS-WebApp", "SOURCE_OF_TRUTH.md"),
}
REQUEST_FIELDS = frozenset(("request_id", "owner_id", "status", "payload_hash", "payload_json"))
PAYLOAD_FIELDS = frozenset(("target", "priority", "description", "screenshots", "idempotency_key"))
PIN_FIELDS = frozenset(("repository", "path", "revision", "target", "verification"))
APPROVAL_SIGNED_FIELDS = frozenset(("schema", "approval_id", "decision", "owner_id",
                                   "request_id", "payload_hash", "source_repository",
                                   "source_path", "source_revision", "target"))
APPROVAL_FIELDS = APPROVAL_SIGNED_FIELDS | {"signature"}


class Rejected(ValueError):
    """Fail-closed boundary; no partial draft returned on invalid evidence."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _json(data):
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _exact(data, fields, code):
    if type(data) is not dict or set(data) != fields:
        raise Rejected(code)


def _uuid(value):
    try:
        return type(value) is str and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def _screenshot(url):
    if (type(url) is not str or len(url) > 240 or
            any(ord(ch) < 32 or ord(ch) == 127 for ch in url)):
        return False
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    return (parts.scheme == "https" and parts.netloc == "github.com" and
            not parts.username and not parts.password and not parts.query and
            not parts.fragment and SCREEN.fullmatch(parts.path) is not None)


def _request(request):
    _exact(request, REQUEST_FIELDS, "REQUEST_NOT_IMMUTABLE_SNAPSHOT")
    if (request["owner_id"] != OWNER or request["status"] != PENDING or
            not _uuid(request["request_id"]) or
            type(request["payload_hash"]) is not str or
            not HEX64.fullmatch(request["payload_hash"]) or
            type(request["payload_json"]) is not str or
            len(request["payload_json"]) > 16000):
        raise Rejected("REQUEST_NOT_PENDING_CANONICAL")
    try:
        payload = json.loads(request["payload_json"])
        _exact(payload, PAYLOAD_FIELDS, "PAYLOAD_SHAPE")
        if _json(payload) != request["payload_json"]:
            raise Rejected("PAYLOAD_NOT_CANONICAL")
    except (ValueError, TypeError, OverflowError) as exc:
        raise Rejected("PAYLOAD_NOT_CANONICAL") from exc
    digest = hashlib.sha256(request["payload_json"].encode("utf-8")).hexdigest()
    if not hmac.compare_digest(digest, request["payload_hash"]):
        raise Rejected("REQUEST_HASH_MISMATCH")
    target = payload["target"]
    if type(target) is not str or not TARGET.fullmatch(target):
        raise Rejected("TARGET_INVALID")
    if payload["priority"] not in ("LOW", "NORMAL", "HIGH") or type(payload["priority"]) is not str:
        raise Rejected("PRIORITY_INVALID")
    body = payload["description"]
    if (type(body) is not str or not 20 <= len(body.strip()) <= 2500 or
            len(body) > 2500 or "\x00" in body or body != body.strip()):
        raise Rejected("DESCRIPTION_INVALID")
    images = payload["screenshots"]
    if (type(images) is not list or len(images) > 3 or
            any(not _screenshot(img) for img in images) or
            len(set(images)) != len(images)):
        raise Rejected("SCREENSHOT_INVALID")
    if not _uuid(payload["idempotency_key"]):
        raise Rejected("IDEMPOTENCY_KEY_INVALID")
    return payload


def _pin(pin, target):
    _exact(pin, PIN_FIELDS, "SOURCE_PIN_SHAPE")
    project = target.split("/", 1)[0]
    allow = ALLOWED_SOURCES.get(project)
    if not allow or (pin["repository"], pin["path"]) != allow:
        raise Rejected("SOURCE_REPOSITORY_DENIED")
    if (pin["verification"] != "VERIFIED_PINNED_CANONICAL_MAIN" or
            pin["target"] != target or type(pin["revision"]) is not str or
            not HEX40.fullmatch(pin["revision"])):
        raise Rejected("SOURCE_NOT_PINNED_VERIFIED")
    # This is an input contract for a future independently verified source
    # adapter, not a claim that this pure module has fetched GitHub itself.


def _approval(approval, request, source, secret):
    _exact(approval, APPROVAL_FIELDS, "APPROVAL_SHAPE")
    if type(secret) is not bytes or len(secret) < 32:
        raise Rejected("APPROVAL_VERIFIER_UNAVAILABLE")
    if (approval["schema"] != APPROVAL_SCHEMA or
            approval["decision"] != "APPROVED" or
            approval["owner_id"] != OWNER or not _uuid(approval["approval_id"]) or
            approval["request_id"] != request["request_id"] or
            approval["payload_hash"] != request["payload_hash"] or
            approval["source_repository"] != source["repository"] or
            approval["source_path"] != source["path"] or
            approval["source_revision"] != source["revision"] or
            approval["target"] != source["target"]):
        raise Rejected("APPROVAL_NOT_BOUND_TO_REQUEST")
    sig = approval["signature"]
    if type(sig) is not str or not HEX64.fullmatch(sig):
        raise Rejected("APPROVAL_SIGNATURE_INVALID")
    signed = {key: approval[key] for key in APPROVAL_SIGNED_FIELDS}
    expected = hmac.new(secret, _json(signed).encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        raise Rejected("APPROVAL_SIGNATURE_INVALID")


def propose(*, request, source, approval, verifier_secret=None):
    """Return deterministic drafts, never issue/SOT writes or dispatch receipts.

    The caller MUST independently obtain source from the pinned canonical
    GitHub SOT and an approved, auditable Owner authorization issuer. In the
    current codebase neither source verifier nor approval signer is wired:
    an unauthenticated/pending request cannot be promoted through this module.
    """
    payload = _request(request)
    _pin(source, payload["target"])
    _approval(approval, request, source, verifier_secret)
    evidence = {
        "request_id": request["request_id"],
        "request_sha256": request["payload_hash"],
        "approval_id": approval["approval_id"],
        "canonical_repository": source["repository"],
        "canonical_path": source["path"],
        "canonical_main_sha": source["revision"],
        "target": payload["target"],
    }
    digest = hashlib.sha256(_json(evidence).encode("utf-8")).hexdigest()
    return {
        "schema": PROPOSAL_SCHEMA,
        "status": "DRAFT_ONLY_NOT_AUTHORIZED_FOR_WRITE",
        "proposal_id": "mpc007-" + digest[:24],
        "provenance": evidence,
        "technical_issue_draft": {
            "repository": source["repository"],
            "title": "[Owner proposal] " + payload["target"].split("/")[-1],
            "target": payload["target"],
            "description": payload["description"],
            "priority": payload["priority"],
            "screenshot_references": list(payload["screenshots"]),
            "create_issue_authorized": False,
        },
        "canonical_sot_change_draft": {
            "repository": source["repository"],
            "path": source["path"],
            "expected_main_revision": source["revision"],
            "kind": "PROPOSE_CHANGE_NOT_PATCH",
            "owner_request": payload["description"],
            "write_sot_authorized": False,
        },
        "owner_release_gate": "SEPARATE_OWNER_APPROVAL_REQUIRED_FOR_ISSUE_OR_SOT_WRITE",
        "dispatch_authorized": False,
        "start_authorized": False,
        "project_switch_authorized": False,
        "h4_apply_authorized": False,
    }
