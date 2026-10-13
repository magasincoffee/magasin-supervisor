# -*- coding: utf-8 -*-
"""MPC-006: Owner-authenticated, append-only request drafts. SOURCE/QA only.

No worker calls, SOT mutations, GitHub dispatch, or local START authority.
The feature is disabled unless a separately provisioned Owner password verifier
AND dedicated private request-store path are configured.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

OWNER = "magasincoffee"
SCHEMA = "MAGASIN_MPC_OWNER_REQUEST_V1"
KEY = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
TARGET = re.compile(r"^[A-Za-z0-9_-]{1,70}/[A-Za-z0-9_-]{1,70}/[A-Za-z0-9_-]{1,70}$")
PRIORITIES = frozenset(("LOW", "NORMAL", "HIGH"))
MAX_BODY = 2500
SESSION_LIFETIME = 1800
LOGIN_WINDOW = 900
LOGIN_LIMIT = 5


class Rejected(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def screenshot_reference(raw):
    """References only. Never download, proxy, or store screenshot bytes."""
    if type(raw) is not str or len(raw) > 240 or raw.strip() != raw:
        raise Rejected("SCREENSHOT_INVALID")
    try:
        u = urlsplit(raw)
    except ValueError as exc:
        raise Rejected("SCREENSHOT_INVALID") from exc
    if (u.scheme != "https" or u.netloc != "github.com" or
            u.username or u.password or u.query or u.fragment):
        raise Rejected("SCREENSHOT_HOST_DENIED")
    prefix = "/user-attachments/assets/"
    if not u.path.startswith(prefix) or not UUID.fullmatch(u.path[len(prefix):]):
        raise Rejected("SCREENSHOT_PATH_DENIED")
    return raw


def authorized_target(target, catalogue):
    """Local navigation identifies target only; never proves SOT/task READY."""
    if type(target) is not str or not TARGET.fullmatch(target):
        raise Rejected("TARGET_INVALID")
    parts = target.split("/")
    if type(catalogue) is not dict or catalogue.get("status") != "LOCAL_UNVERIFIED":
        raise Rejected("CATALOGUE_UNAVAILABLE")
    for p in catalogue.get("projects", []):
        if p.get("id") != parts[0]:
            continue
        for f in p.get("features", []):
            if f.get("id") != parts[1]:
                continue
            for t in f.get("tasks", []):
                if t.get("id") == parts[2]:
                    return target
    raise Rejected("TARGET_NOT_LISTED")


def normalize_request(data, catalogue):
    if type(data) is not dict or set(data) != {
        "target", "priority", "description", "screenshots", "idempotency_key"
    }:
        raise Rejected("REQUEST_SHAPE")
    target = authorized_target(data["target"], catalogue)
    priority = data["priority"]
    if type(priority) is not str or priority not in PRIORITIES:
        raise Rejected("PRIORITY_INVALID")
    desc = data["description"]
    if (type(desc) is not str or not 20 <= len(desc.strip()) <= MAX_BODY or
            len(desc) > MAX_BODY or "\x00" in desc):
        raise Rejected("DESCRIPTION_INVALID")
    refs = data["screenshots"]
    if type(refs) is not list or len(refs) > 3:
        raise Rejected("SCREENSHOT_COUNT")
    refs = [screenshot_reference(r) for r in refs]
    if len(set(refs)) != len(refs):
        raise Rejected("SCREENSHOT_DUPLICATE")
    key = data["idempotency_key"]
    if type(key) is not str or not KEY.fullmatch(key):
        raise Rejected("IDEMPOTENCY_KEY_INVALID")
    return {
        "target": target, "priority": priority,
        "description": desc.strip(), "screenshots": refs,
        "idempotency_key": key,
    }


def _check_db_path(path: Path):
    if not path.is_absolute() or path.name in ("", ".", ".."):
        raise Rejected("STORE_PATH_NOT_QUALIFIED")
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise Rejected("STORE_PATH_NOT_QUALIFIED")
    if not path.parent.is_dir() or path.parent.is_symlink():
        raise Rejected("STORE_PARENT_NOT_QUALIFIED")


def _init_db(db):
    db.execute("PRAGMA busy_timeout=5000")
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("""CREATE TABLE IF NOT EXISTS owner_requests (
        request_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(owner_id,idempotency_key))""")
    db.execute("""CREATE TABLE IF NOT EXISTS owner_audit (
        event_id TEXT PRIMARY KEY, request_id TEXT NOT NULL,
        owner_id TEXT NOT NULL, event_type TEXT NOT NULL,
        event_at TEXT NOT NULL, payload_hash TEXT NOT NULL,
        FOREIGN KEY(request_id) REFERENCES owner_requests(request_id))""")
    for table in ("owner_requests", "owner_audit"):
        db.execute(f"""CREATE TRIGGER IF NOT EXISTS {table}_immutable_update
            BEFORE UPDATE ON {table} BEGIN SELECT RAISE(ABORT,'IMMUTABLE'); END""")
        db.execute(f"""CREATE TRIGGER IF NOT EXISTS {table}_immutable_delete
            BEFORE DELETE ON {table} BEGIN SELECT RAISE(ABORT,'IMMUTABLE'); END""")


def submit_request(db_path, *, actor, request, catalogue):
    if actor != OWNER:
        raise Rejected("OWNER_SESSION_REQUIRED")
    normalized = normalize_request(request, catalogue)
    encoded = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    path = Path(db_path)
    _check_db_path(path)
    if not path.exists():
        # Restrict initial file creation to the current process on POSIX.
        handle = os.open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
        os.close(handle)
    with sqlite3.connect(path, timeout=5) as db:
        _init_db(db)
        db.execute("BEGIN IMMEDIATE")
        previous = db.execute(
            "SELECT request_id,payload_hash,created_at,status FROM owner_requests "
            "WHERE owner_id=? AND idempotency_key=?",
            (actor, normalized["idempotency_key"])
        ).fetchone()
        if previous:
            if not hmac.compare_digest(previous[1], digest):
                raise Rejected("IDEMPOTENCY_CONFLICT")
            return {"schema": SCHEMA, "request_id": previous[0],
                    "status": previous[3], "created_at": previous[2],
                    "duplicate": True, "dispatch_authorized": False}
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        request_id = str(uuid.uuid4())
        db.execute(
            "INSERT INTO owner_requests VALUES (?,?,?,?,?,?,?)",
            (request_id, actor, normalized["idempotency_key"], digest,
             encoded, "PENDING_OWNER_REVIEW", now))
        db.execute(
            "INSERT INTO owner_audit VALUES (?,?,?,?,?,?)",
            (str(uuid.uuid4()), request_id, actor, "OWNER_DRAFT_SUBMITTED", now, digest))
        db.commit()
    return {"schema": SCHEMA, "request_id": request_id,
            "status": "PENDING_OWNER_REVIEW", "created_at": now,
            "duplicate": False, "dispatch_authorized": False}


class OwnerSessions:
    """In-memory, expiring browser sessions; no session if verifier is missing."""

    def __init__(self, verifier=None, clock=None):
        self.verifier = verifier
        self.clock = clock or time.monotonic
        self.sessions = {}
        self.attempts = {}
        self.lock = threading.Lock()

    @property
    def enabled(self):
        try:
            algo, rounds, salt, digest = (self.verifier or "").split("$")
            return (algo == "pbkdf2_sha256" and 310000 <= int(rounds) <= 1000000
                    and len(bytes.fromhex(salt)) >= 16
                    and len(bytes.fromhex(digest)) == 32)
        except (ValueError, TypeError):
            return False

    def login(self, password, ip):
        if type(password) is not str or not self.enabled or not 1 <= len(password) <= 256:
            raise Rejected("OWNER_AUTH_NOT_QUALIFIED")
        with self.lock:
            now = self.clock()
            attempts = [t for t in self.attempts.get(ip, []) if now - t < LOGIN_WINDOW]
            if len(attempts) >= LOGIN_LIMIT:
                raise Rejected("OWNER_LOGIN_RATE_LIMIT")
            self.attempts[ip] = attempts + [now]
        _, rounds, salt, expected = self.verifier.split("$")
        proof = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                  bytes.fromhex(salt), int(rounds))
        if not hmac.compare_digest(proof, bytes.fromhex(expected)):
            raise Rejected("OWNER_LOGIN_DENIED")
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        with self.lock:
            self.sessions[hashlib.sha256(token.encode()).hexdigest()] = (now + SESSION_LIFETIME, csrf, OWNER)
            self.attempts.pop(ip, None)
        return token, csrf

    def check(self, token):
        if type(token) is not str or not 30 <= len(token) <= 150:
            return None
        key = hashlib.sha256(token.encode()).hexdigest()
        with self.lock:
            session = self.sessions.get(key)
            if session and session[0] > self.clock():
                return {"owner_id": session[2], "csrf": session[1]}
            self.sessions.pop(key, None)
        return None

    def logout(self, token):
        if type(token) is str:
            with self.lock:
                self.sessions.pop(hashlib.sha256(token.encode()).hexdigest(), None)


def cookie_token(raw):
    if type(raw) is not str or len(raw) > 1024:
        return None
    for item in raw.split(";"):
        name, sep, value = item.strip().partition("=")
        if sep and name == "mpc_owner_session" and re.fullmatch(r"[A-Za-z0-9_-]{30,150}", value):
            return value
    return None


def configured_store():
    raw = os.environ.get("MPC_OWNER_REQUESTS_DB", "")
    if not raw:
        raise Rejected("STORE_NOT_CONFIGURED")
    path = Path(raw)
    _check_db_path(path)
    return path
