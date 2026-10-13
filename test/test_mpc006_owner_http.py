# -*- coding: utf-8 -*-
"""MPC-006 synthetic loopback HTTP tests. Never contact real H4/robot."""
import hashlib
import http.client
import importlib.util
import json
import os
import sys
import tempfile
import threading
import types
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1] / "src" / "control-center"
sys.path.insert(0, str(BASE))
import owner_request_drafts as m


def verifier():
    salt = bytes(range(16))
    digest = hashlib.pbkdf2_hmac("sha256", b"fixture Owner password only", salt, 310000)
    return "pbkdf2_sha256$310000$" + salt.hex() + "$" + digest.hex()


class OwnerRouteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Hosted Ubuntu source-only CI does not install optional production psutil.
        # Stub imports in this isolated fixture; no resource/robot route is invoked.
        try:
            import psutil  # noqa: F401
        except ModuleNotFoundError:
            sys.modules["psutil"] = types.ModuleType("psutil")
            cls.addClassCleanup(sys.modules.pop, "psutil", None)
        # observability is deployed beside the Control Center on H4 but is
        # deliberately not packaged in hosted source-only CI. Owner routes
        # neither inspect it nor access any worker/monitoring state.
        if "observability" not in sys.modules:
            sys.modules["observability"] = types.ModuleType("observability")
            cls.addClassCleanup(sys.modules.pop, "observability", None)
        spec = importlib.util.spec_from_file_location("mpc006_server", BASE / "server.py")
        cls.server_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.server_mod)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="mpc006-http-fixture-")
        self.addCleanup(self.tmp.cleanup)
        self.db = Path(self.tmp.name) / "owner.sqlite"
        self.env = patch.dict(os.environ, {"MPC_OWNER_REQUESTS_DB": str(self.db)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.auth = m.OwnerSessions(verifier())
        self.old_sessions = self.server_mod.OWNER_SESSIONS
        self.server_mod.OWNER_SESSIONS = self.auth
        self.addCleanup(setattr, self.server_mod, "OWNER_SESSIONS", self.old_sessions)
        from http.server import ThreadingHTTPServer
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), self.server_mod.Handler)
        self.addCleanup(self.http.server_close)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.http.shutdown)
        self.csrf = self.server_mod.CONTROL_TOKEN
        self.cookie = None
        self.owner_csrf = None

    def call(self, method, path, payload=None, headers=None):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        h = {"Host": "127.0.0.1:8781", "Origin": "http://127.0.0.1:8781",
             "X-MAGASIN-CSRF": self.csrf, "Sec-Fetch-Site": "same-origin",
             "Content-Type": "application/json"}
        if self.cookie:
            h["Cookie"] = self.cookie
        if self.owner_csrf:
            h["X-MPC-CSRF"] = self.owner_csrf
        h.update(headers or {})
        # None means intentionally omit the header (not merely send empty).
        h = {key: value for key, value in h.items() if value is not None}
        conn = http.client.HTTPConnection("127.0.0.1", self.http.server_port, timeout=4)
        try:
            conn.request(method, path, body=data, headers=h)
            resp = conn.getresponse()
            raw = resp.read()
            cookie = resp.getheader("Set-Cookie")
            result = json.loads(raw.decode("utf-8"))
            return resp.status, result, cookie
        finally:
            conn.close()

    def login(self):
        status, data, cookie = self.call("POST", "/api/owner/login",
                                        {"password": "fixture Owner password only"})
        self.assertEqual(status, 200)
        self.assertTrue(data["authenticated"])
        self.assertIn("HttpOnly; SameSite=Strict", cookie)
        self.cookie = cookie.split(";", 1)[0]
        self.owner_csrf = data["csrf"]

    @staticmethod
    def payload():
        return {"target": "supervisor/project-control/MPC-006", "priority": "NORMAL",
                "description": "Kiểm thử lưu đề xuất chỉnh sửa có xác thực Owner.",
                "screenshots": [], "idempotency_key": str(uuid.uuid4())}

    def test_unauthenticated_and_csrf_origin_denials_do_not_write(self):
        status, info, _ = self.call("GET", "/api/owner/session")
        self.assertEqual(status, 200)
        self.assertTrue(info["login_enabled"])
        self.assertFalse(info["authenticated"])
        self.assertFalse(info["can_dispatch"])
        status, _, _ = self.call("POST", "/api/owner/requests", self.payload())
        self.assertEqual(status, 403)
        self.assertFalse(self.db.exists())
        status, _, _ = self.call("POST", "/api/owner/login",
                                 {"password": "fixture Owner password only"},
                                 headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        status, _, _ = self.call("POST", "/api/owner/login",
                                 {"password": "fixture Owner password only"},
                                 headers={"X-MAGASIN-CSRF": "forged"})
        self.assertEqual(status, 403)
        self.assertFalse(self.db.exists())

    def test_login_session_submit_duplicate_and_logout_all_fail_closed(self):
        self.login()
        request = self.payload()
        status, _, _ = self.call("POST", "/api/owner/requests", request,
                                  headers={"X-MPC-CSRF": "wrong"})
        self.assertEqual(status, 403)
        self.assertFalse(self.db.exists())
        status, result, _ = self.call("POST", "/api/owner/requests", request)
        self.assertEqual(status, 202)
        self.assertEqual(result["status"], "PENDING_OWNER_REVIEW")
        self.assertFalse(result["dispatch_authorized"])
        rid = result["request_id"]
        status, result, _ = self.call("POST", "/api/owner/requests", request)
        self.assertEqual(status, 200)
        self.assertTrue(result["duplicate"])
        self.assertEqual(result["request_id"], rid)
        request["description"] = "Nội dung khác khi retry phải bị chặn an toàn."
        status, result, _ = self.call("POST", "/api/owner/requests", request)
        self.assertEqual(status, 409)
        self.assertEqual(result["error"], "IDEMPOTENCY_CONFLICT")
        status, _, cookie = self.call("POST", "/api/owner/logout")
        self.assertEqual(status, 200)
        self.assertIn("Max-Age=0", cookie)
        status, _, _ = self.call("POST", "/api/owner/requests", self.payload())
        self.assertEqual(status, 403)

    def test_owner_routes_require_explicit_trusted_fetch_site(self):
        self.login()
        valid_token = self.cookie.split("=", 1)[1]
        for path, body in (
            ("/api/owner/logout", None),
            ("/api/owner/requests", self.payload()),
            ("/api/owner/login", {"password": "fixture Owner password only"}),
        ):
            for fetch_site in (None, "", "cross-site", "same-site", "invalid"):
                with self.subTest(path=path, fetch_site=fetch_site):
                    status, result, _ = self.call("POST", path, body, headers={
                        "Sec-Fetch-Site": fetch_site
                    })
                    self.assertEqual(status, 403, result)
                    self.assertIsNotNone(self.auth.check(valid_token))
        # Explicit trusted fetch-site still permits safe idempotent logout.
        status, outcome, _ = self.call("POST", "/api/owner/logout",
                                       headers={"Sec-Fetch-Site": "none"})
        self.assertEqual(status, 200)
        self.assertEqual(outcome, {"ok": True, "authenticated": False})
        self.assertIsNone(self.auth.check(valid_token))

    def test_logout_revokes_rotated_session_even_with_stale_owner_csrf(self):
        self.login()
        # A second tab rotated the browser cookie, while this tab kept the
        # previous X-MPC-CSRF. Revocation must target the current cookie.
        new_token, new_csrf = self.auth.login("fixture Owner password only", "127.0.0.1")
        self.assertNotEqual(self.owner_csrf, new_csrf)
        self.cookie = "mpc_owner_session=" + new_token
        self.owner_csrf = "stale-token-from-other-tab"
        status, _, _ = self.call("POST", "/api/owner/logout",
                                 headers={"Origin": "https://untrusted.example"})
        self.assertEqual(status, 403)
        self.assertIsNotNone(self.auth.check(new_token))
        status, _, _ = self.call("POST", "/api/owner/logout",
                                 headers={"X-MAGASIN-CSRF": "forged"})
        self.assertEqual(status, 403)
        self.assertIsNotNone(self.auth.check(new_token))
        status, outcome, cookie = self.call("POST", "/api/owner/logout")
        self.assertEqual(status, 200)
        self.assertEqual(outcome, {"ok": True, "authenticated": False})
        self.assertIn("Max-Age=0", cookie)
        self.assertIsNone(self.auth.check(new_token))
        # Retry is idempotent and still clears the HttpOnly cookie.
        status, _, cookie = self.call("POST", "/api/owner/logout")
        self.assertEqual(status, 200)
        self.assertIn("Max-Age=0", cookie)

    def test_logout_without_private_store_revokes_session(self):
        self.login()
        token = self.cookie.split("=", 1)[1]
        with patch.dict(os.environ, {"MPC_OWNER_REQUESTS_DB": ""}):
            status, outcome, cookie = self.call("POST", "/api/owner/logout")
        self.assertEqual(status, 200)
        self.assertFalse(outcome["authenticated"])
        self.assertIn("Max-Age=0", cookie)
        self.assertIsNone(self.auth.check(token))

    def test_full_length_unicode_owner_request_is_not_wrongly_rejected_by_bytes(self):
        self.login()
        p = self.payload()
        p["description"] = "🔥" * 2500
        status, outcome, _ = self.call("POST", "/api/owner/requests", p)
        self.assertEqual(status, 202, outcome)
        self.assertEqual(outcome["status"], "PENDING_OWNER_REVIEW")

    def test_unconfigured_auth_and_store_never_allow_request(self):
        self.server_mod.OWNER_SESSIONS = m.OwnerSessions(None)
        status, data, _ = self.call("GET", "/api/owner/session")
        self.assertEqual(status, 200)
        self.assertFalse(data["login_enabled"])
        status, _, _ = self.call("POST", "/api/owner/login",
                                 {"password": "fixture Owner password only"})
        self.assertEqual(status, 403)

    def test_strict_body_and_unlisted_target_rejected(self):
        self.login()
        for target in ("workforce/shifts/XSTORE-999", "supervisor/project-control/NOT-A-TASK"):
            candidate = self.payload()
            candidate["target"] = target
            status, data, _ = self.call("POST", "/api/owner/requests", candidate)
            self.assertEqual(status, 400, data)
        status, _, _ = self.call("POST", "/api/owner/requests", self.payload(),
                                 headers={"Content-Type": "text/plain"})
        self.assertEqual(status, 415)
        self.assertFalse(self.db.exists())


if __name__ == "__main__":
    unittest.main()
