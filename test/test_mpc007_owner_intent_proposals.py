# -*- coding: utf-8 -*-
"""MPC-007 source-only synthetic QA. Never reads H4 or actual Owner requests."""
import copy
import hashlib
import hmac
import importlib.util
import json
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mpc007", ROOT / "src/control-center/owner_intent_proposals.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SECRET = bytes(range(32))
REVISION = "ab" * 20
TARGET = "supervisor/project-control/MPC-006"
SCREEN = "https://github.com/user-attachments/assets/70d27727-118a-4246-ac55-237479747f91"


def canonical(v):
    return json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fixture():
    payload = {
        "description": "Tôi muốn sửa giao diện cho Owner dễ sử dụng trên điện thoại.",
        "idempotency_key": str(uuid.uuid4()),
        "priority": "NORMAL", "screenshots": [SCREEN], "target": TARGET,
    }
    encoded = canonical(payload)
    request = {
        "request_id": str(uuid.uuid4()), "owner_id": "magasincoffee",
        "status": "PENDING_OWNER_REVIEW",
        "payload_hash": hashlib.sha256(encoded.encode("utf-8")).hexdigest(),
        "payload_json": encoded,
    }
    source = {
        "repository": "magasincoffee/magasin-supervisor",
        "path": "SOURCE_OF_TRUTH.md", "revision": REVISION,
        "target": TARGET, "verification": "VERIFIED_PINNED_CANONICAL_MAIN",
    }
    approval = {
        "schema": m.APPROVAL_SCHEMA, "approval_id": str(uuid.uuid4()),
        "decision": "APPROVED", "owner_id": "magasincoffee",
        "request_id": request["request_id"],
        "payload_hash": request["payload_hash"],
        "source_repository": source["repository"],
        "source_path": source["path"],
        "source_revision": source["revision"], "target": TARGET,
    }
    seal(approval)
    return request, source, approval


def seal(approval):
    raw = {k: v for k, v in approval.items() if k != "signature"}
    approval["signature"] = hmac.new(SECRET, canonical(raw).encode("utf-8"),
                                     hashlib.sha256).hexdigest()


def project(request=None, source=None, approval=None, secret=SECRET):
    r, s, a = fixture()
    return m.propose(request=request if request is not None else r,
                     source=source if source is not None else s,
                     approval=approval if approval is not None else a,
                     verifier_secret=secret)


class ProjectionTests(unittest.TestCase):
    def test_bound_approval_produces_only_deterministic_drafts(self):
        r, s, a = fixture()
        x = m.propose(request=r, source=s, approval=a, verifier_secret=SECRET)
        y = m.propose(request=copy.deepcopy(r), source=copy.deepcopy(s),
                      approval=copy.deepcopy(a), verifier_secret=SECRET)
        self.assertEqual(x, y)
        self.assertEqual(x["status"], "DRAFT_ONLY_NOT_AUTHORIZED_FOR_WRITE")
        self.assertTrue(x["proposal_id"].startswith("mpc007-"))
        self.assertEqual(x["technical_issue_draft"]["repository"], s["repository"])
        self.assertEqual(x["canonical_sot_change_draft"]["path"], s["path"])
        self.assertEqual(x["canonical_sot_change_draft"]["expected_main_revision"], REVISION)
        self.assertIn("điện thoại", x["technical_issue_draft"]["description"])
        for k in ("dispatch_authorized", "start_authorized",
                  "project_switch_authorized", "h4_apply_authorized"):
            self.assertIs(x[k], False)
        self.assertIs(x["technical_issue_draft"]["create_issue_authorized"], False)
        self.assertIs(x["canonical_sot_change_draft"]["write_sot_authorized"], False)
        self.assertNotIn("issue_number", x)
        self.assertNotIn("dispatch_id", x)

    def test_never_promotes_pending_request_from_client_boolean(self):
        r, s, a = fixture()
        r["approved"] = True
        with self.assertRaisesRegex(m.Rejected, "REQUEST_NOT_IMMUTABLE_SNAPSHOT"):
            m.propose(request=r, source=s, approval=a, verifier_secret=SECRET)
        r.pop("approved")
        a["decision"] = "PENDING_OWNER_REVIEW"
        seal(a)
        with self.assertRaisesRegex(m.Rejected, "APPROVAL_NOT_BOUND_TO_REQUEST"):
            m.propose(request=r, source=s, approval=a, verifier_secret=SECRET)

    def test_no_verifier_or_bad_signature_fails_closed(self):
        r, s, a = fixture()
        for secret in (None, b"", b"x" * 31, "unsafe", bytes(32)):
            with self.subTest(secret=repr(secret)):
                with self.assertRaises(m.Rejected):
                    m.propose(request=r, source=s, approval=a, verifier_secret=secret)
        a["signature"] = "0" * 64
        with self.assertRaisesRegex(m.Rejected, "APPROVAL_SIGNATURE_INVALID"):
            m.propose(request=r, source=s, approval=a, verifier_secret=SECRET)

    def test_separate_owner_attestation_required(self):
        r, s, a = fixture()
        for key, value in (("owner_id", "manager"), ("request_id", str(uuid.uuid4())),
                           ("payload_hash", "f" * 64), ("target", "supervisor/foo/TEST"),
                           ("source_revision", "cd" * 20),
                           ("source_repository", "magasincoffee/OPS-WebApp")):
            altered = dict(a)
            altered[key] = value
            seal(altered)  # Even a signed but misbound claim is rejected.
            with self.subTest(field=key):
                with self.assertRaisesRegex(m.Rejected, "APPROVAL_NOT_BOUND_TO_REQUEST"):
                    m.propose(request=r, source=s, approval=altered, verifier_secret=SECRET)

    def test_bad_request_hash_or_immutable_status_rejected(self):
        r, s, a = fixture()
        for key, value in (("payload_hash", "e" * 64), ("status", "APPROVED"),
                           ("owner_id", "employee"), ("request_id", "bad")):
            altered = dict(r)
            altered[key] = value
            with self.subTest(key=key):
                with self.assertRaises(m.Rejected):
                    m.propose(request=altered, source=s, approval=a, verifier_secret=SECRET)

    def test_changed_request_payload_with_old_hash_fails(self):
        r, s, a = fixture()
        obj = json.loads(r["payload_json"])
        obj["description"] = "Đề nghị thay đổi ngoài bằng chứng đã duyệt trong SOT."
        r["payload_json"] = canonical(obj)
        with self.assertRaisesRegex(m.Rejected, "REQUEST_HASH_MISMATCH"):
            m.propose(request=r, source=s, approval=a, verifier_secret=SECRET)

    def test_source_cross_repo_and_stale_revisions_denied(self):
        r, s, a = fixture()
        cases = [
            ("repository", "magasincoffee/OPS-WebApp"),
            ("path", "README.md"), ("revision", "main"),
            ("verification", "LOCAL_UNVERIFIED"), ("target", "supervisor/project-control/MPC-007")
        ]
        for key, value in cases:
            altered = dict(s)
            altered[key] = value
            with self.subTest(key=key):
                with self.assertRaises(m.Rejected):
                    m.propose(request=r, source=altered, approval=a, verifier_secret=SECRET)

    def test_xss_binaries_arbitrary_external_urls_denied(self):
        r, s, a = fixture()
        obj = json.loads(r["payload_json"])
        obj["screenshots"] = ["https://github.com.evil.tld/user-attachments/assets/" +
                              SCREEN.rsplit("/", 1)[-1]]
        encoded = canonical(obj)
        r["payload_json"] = encoded
        r["payload_hash"] = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
        a["payload_hash"] = r["payload_hash"]
        seal(a)
        with self.assertRaisesRegex(m.Rejected, "SCREENSHOT_INVALID"):
            m.propose(request=r, source=s, approval=a, verifier_secret=SECRET)

    def test_controls_hidden_by_urlsplit_are_rejected(self):
        for char in ("\r", "\n", "\t", "\x00", "\x7f"):
            r, s, a = fixture()
            p = json.loads(r["payload_json"])
            p["screenshots"] = [SCREEN[:19] + char + SCREEN[19:]]
            encoded = canonical(p)
            r["payload_json"] = encoded
            r["payload_hash"] = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
            a["payload_hash"] = r["payload_hash"]
            seal(a)
            with self.subTest(char=repr(char)):
                with self.assertRaisesRegex(m.Rejected, "SCREENSHOT_INVALID"):
                    m.propose(request=r, source=s, approval=a, verifier_secret=SECRET)

    def test_unsafe_request_objects_fail_closed_without_crash(self):
        r, s, a = fixture()
        for value in (None, [], {}, {"status": "APPROVED"}, 123, True):
            with self.subTest(value=repr(value)):
                with self.assertRaises(m.Rejected):
                    m.propose(request=value, source=s, approval=a, verifier_secret=SECRET)

    def test_no_mutations_of_evidence_or_external_effects(self):
        r, s, a = fixture()
        before = copy.deepcopy((r, s, a))
        m.propose(request=r, source=s, approval=a, verifier_secret=SECRET)
        self.assertEqual((r, s, a), before)


if __name__ == "__main__":
    unittest.main()
