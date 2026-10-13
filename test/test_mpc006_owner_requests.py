# -*- coding: utf-8 -*-
"""MPC-006 SOURCE/QA fixtures: never touch real H4 data."""
import hashlib
from contextlib import closing
import importlib.util
import json
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mpc006", ROOT / "src/control-center/owner_request_drafts.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
CATALOGUE = {"status": "LOCAL_UNVERIFIED", "projects": [
    {"id": "supervisor", "features": [{"id": "project-control",
     "tasks": [{"id": "MPC-005"}, {"id": "MPC-006"}]}]}]}
TARGET = "supervisor/project-control/MPC-006"
SCREEN = "https://github.com/user-attachments/assets/70d27727-118a-4246-ac55-237479747f91"


def payload():
    return {"target": TARGET, "priority": "NORMAL",
            "description": "Yêu cầu điều chỉnh chi tiết hiển thị cho Owner.",
            "screenshots": [SCREEN], "idempotency_key": str(uuid.uuid4())}


class StoreTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="mpc006-fixture-")
        self.addCleanup(tmp.cleanup)
        self.db = Path(tmp.name) / "private.sqlite3"

    def submit(self, data=None, actor=m.OWNER, catalogue=CATALOGUE):
        return m.submit_request(self.db, actor=actor, request=data or payload(), catalogue=catalogue)

    def test_atomic_pending_request_and_immutable_audit(self):
        receipt = self.submit()
        self.assertEqual(receipt["status"], "PENDING_OWNER_REVIEW")
        self.assertFalse(receipt["dispatch_authorized"])
        with closing(sqlite3.connect(self.db)) as db:
            row = db.execute("SELECT owner_id,status,payload_json,payload_hash FROM owner_requests").fetchone()
            audit = db.execute("SELECT owner_id,event_type,payload_hash FROM owner_audit").fetchone()
            self.assertEqual(row[:2], (m.OWNER, "PENDING_OWNER_REVIEW"))
            self.assertEqual(json.loads(row[2])["target"], TARGET)
            self.assertEqual(audit, (m.OWNER, "OWNER_DRAFT_SUBMITTED", row[3]))
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("UPDATE owner_requests SET status='APPROVED'")
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("DELETE FROM owner_audit")

    def test_idempotency_and_payload_collision(self):
        p = payload()
        one = self.submit(p)
        again = self.submit(p)
        self.assertEqual(one["request_id"], again["request_id"])
        self.assertTrue(again["duplicate"])
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM owner_audit").fetchone()[0], 1)
        p["description"] = "Một nội dung khác khi gửi lại cùng mã phải bị từ chối."
        with self.assertRaisesRegex(m.Rejected, "IDEMPOTENCY_CONFLICT"):
            self.submit(p)

    def test_only_verified_owner_can_write(self):
        for actor in (None, "manager", "employee", "", True, "magasincoffee "):
            with self.subTest(actor=actor):
                with self.assertRaisesRegex(m.Rejected, "OWNER_SESSION_REQUIRED"):
                    self.submit(actor=actor)
        self.assertFalse(self.db.exists())

    def test_reject_forged_navigation_and_bad_catalogue(self):
        p = payload()
        for c in (None, {}, {"status": "READY"}, {"status": "LOCAL_UNVERIFIED", "projects": []}):
            with self.assertRaises(m.Rejected):
                self.submit(p, catalogue=c)
        for target in ("print-ops/project-control/MPC-006", "supervisor/project-control/MPC-007",
                       "supervisor/project-control/../../evil", "<script>"):
            p["target"] = target
            with self.assertRaises(m.Rejected):
                self.submit(p)

    def test_strict_priority_description_attachment_and_idempotency(self):
        scenarios = [
            ("priority", "URGENT"), ("description", "bad"),
            ("description", "x" * 2501), ("description", "hello\x00world" * 4),
            ("screenshots", [SCREEN, SCREEN]), ("screenshots", [SCREEN] * 4),
            ("screenshots", ["https://evil.example.org/image.png"]),
            ("screenshots", ["https://github.com/user-attachments/assets/" +
                             SCREEN.rsplit("/", 1)[-1] + "?x=1"]),
            ("screenshots", ["javascript:alert(1)"]),
            ("screenshots", ["https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md"]),
            ("idempotency_key", "not-a-uuid"),
        ]
        for field, value in scenarios:
            with self.subTest(field=field, value=str(value)[:30]):
                p = payload()
                p[field] = value
                with self.assertRaises(m.Rejected):
                    self.submit(p)
        self.assertFalse(self.db.exists())

    def test_store_path_refuses_symlinks_and_relative_paths(self):
        with self.assertRaisesRegex(m.Rejected, "STORE_PATH_NOT_QUALIFIED"):
            m.submit_request(Path("relative.db"), actor=m.OWNER, request=payload(), catalogue=CATALOGUE)
        link = self.db.parent / "linked.sqlite3"
        self.db.touch()
        try:
            link.symlink_to(self.db)
        except (OSError, NotImplementedError):
            return
        with self.assertRaisesRegex(m.Rejected, "STORE_PATH_NOT_QUALIFIED"):
            m.submit_request(link, actor=m.OWNER, request=payload(), catalogue=CATALOGUE)


class AuthTest(unittest.TestCase):
    @staticmethod
    def verifier():
        salt = bytes(range(16))
        rounds = 310000
        digest = hashlib.pbkdf2_hmac("sha256", b"example-only-owner-passphrase", salt, rounds)
        return "pbkdf2_sha256$" + str(rounds) + "$" + salt.hex() + "$" + digest.hex()

    def test_unprovisioned_denies_login(self):
        auth = m.OwnerSessions()
        self.assertFalse(auth.enabled)
        with self.assertRaises(m.Rejected):
            auth.login("somepass", "127.0.0.1")
        for v in (None, "owner", "pbkdf2_sha256$10$0f$ab"):
            self.assertFalse(m.OwnerSessions(v).enabled)

    def test_expiring_owner_session_and_csrf(self):
        clock = [100.0]
        auth = m.OwnerSessions(self.verifier(), clock=lambda: clock[0])
        with self.assertRaisesRegex(m.Rejected, "OWNER_LOGIN_DENIED"):
            auth.login("wrong", "127.0.0.1")
        token, csrf = auth.login("example-only-owner-passphrase", "127.0.0.1")
        self.assertEqual(auth.check(token), {"owner_id": m.OWNER, "csrf": csrf})
        self.assertEqual(m.cookie_token("a=b; mpc_owner_session=" + token), token)
        self.assertIsNone(m.cookie_token("mpc_owner_session=bad"))
        clock[0] += 1801
        self.assertIsNone(auth.check(token))

    def test_failed_logins_rate_limited_and_logout(self):
        auth = m.OwnerSessions(self.verifier())
        for _ in range(m.LOGIN_LIMIT):
            with self.assertRaisesRegex(m.Rejected, "OWNER_LOGIN_DENIED"):
                auth.login("bad", "127.0.0.1")
        with self.assertRaisesRegex(m.Rejected, "OWNER_LOGIN_RATE_LIMIT"):
            auth.login("example-only-owner-passphrase", "127.0.0.1")
        other = m.OwnerSessions(self.verifier())
        token, _ = other.login("example-only-owner-passphrase", "127.0.0.1")
        other.logout(token)
        self.assertIsNone(other.check(token))


if __name__ == "__main__":
    unittest.main()
