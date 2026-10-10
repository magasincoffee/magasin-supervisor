# -*- coding: utf-8 -*-
"""SOT source/revision and Supervisor activation review: fixture-only QA."""
import base64
import hashlib
import importlib
import io
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

LIB = Path(__file__).resolve().parents[1] / "src" / "control-center"
sys.path.insert(0, str(LIB))
links = importlib.import_module("supervisor_project_links")
mod = importlib.import_module("supervisor_project_activation")

WORKFORCE = (
    "https://github.com/magasincoffee/magasincoffee.github.io/blob/main/"
    "01_DOCS/MAGASIN/05_SYSTEM/WORKFORCE_CROSS_STORE_SCHEDULING_TEMP_SOURCE_OF_TRUTH.md"
)
OPS = "https://github.com/magasincoffee/OPS-WebApp/blob/main/SOURCE_OF_TRUTH.md"
SOT_TEXT = b"# MAGASIN OPS Source of Truth\n\nStatus: IN PROGRESS\n\nSC-013 is blocked.\n"


class DummyResponse:
    def __init__(self, data, url, *, status=200, redirected=False):
        self.status = status
        self.url = "https://invalid.example/redirect" if redirected else url
        self.stream = io.BytesIO(data)
    def geturl(self):
        return self.url
    def read(self, length):
        return self.stream.read(length)
    def __enter__(self):
        return self
    def __exit__(self, *_):
        pass


class MockOpener:
    def __init__(self, data, **bad):
        self.data=data
        self.bad=bad
        self.calls=[]
    def open(self, request, timeout):
        self.calls.append((request.full_url, request.get_method(), timeout))
        return DummyResponse(self.data, request.full_url,
                             status=self.bad.get("status",200),
                             redirected=self.bad.get("redirect",False))


def build_api_response(raw=SOT_TEXT, *, path="SOURCE_OF_TRUTH.md",
                       sha=None, extra=None):
    digest=sha or hashlib.sha1(b"blob "+str(len(raw)).encode()+b"\0"+raw).hexdigest()
    d={"type":"file","encoding":"base64","path":path,
       "sha":digest,"content":base64.b64encode(raw).decode()}
    if extra:d.update(extra)
    return json.dumps(d).encode()


class ActivationPreflightTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix="sc013-sot-activation-")
        self.addCleanup(self.tmp.cleanup)
        root=Path(self.tmp.name)
        self.stop=root/"supervisor"
        self.stop.mkdir()
        for name in ("STOP","AUTOSTART_DISABLED"):
            (self.stop/name).touch()
        self.active=self.stop/"single-conversation-control.json"
        self.active.write_text(json.dumps({
            "schema_version":"single-conversation-control.v1",
            "mode":"SINGLE_CONVERSATION_V1",
            "project_id":"LIVE", "source_of_truth_url":WORKFORCE,
        }))
        self.tx=self.stop/"single-conversation-state.json"
        self.tx.write_text('{"outbound":{"state":"ENQUEUED", "last_error_code":"AMBIGUOUS_ENQUEUED_OUTCOME"}}')
        self.registry=root/"project_sot_requests.json"
        self.link_id=hashlib.sha256(OPS.encode()).hexdigest()[:24]
        self.registry.write_text(json.dumps({
            "schema":links.REQUEST_SCHEMA,
            "requests":[{"id":self.link_id,"url":OPS,
                         "status":"PENDING_SOT_REVIEW",
                         "created_at":"2026-10-10T02:00:00+00:00"}],
        }))
        self.params={
            "current":self.active,"requests":self.registry,"stop_root":self.stop,
            "machine":links.HOST,"transaction_path":self.tx,
        }

    def assess(self, **updates):
        return mod.inspect_candidate(self.link_id, **{**self.params,**updates})

    def test_realistic_ambiguous_outbound_blocks_switch_even_with_sot_verified(self):
        f=lambda _:{"repository":"magasincoffee/OPS-WebApp","github_blob_sha":"a"*40,
                     "document_exists":True,"task_ready_verified":False}
        baseline=self.active.read_bytes()
        result=self.assess(fetcher=f)
        self.assertEqual(result["schema"],mod.SCHEMA)
        self.assertEqual(result["candidate"]["repository"],"magasincoffee/OPS-WebApp")
        self.assertIn("SUPERVISOR_OUTBOUND_UNKNOWN_OUTCOME_NO_REPLAY",result["blockers"])
        self.assertIn("SOT_NEXT_TASK_REQUIRES_AUTHORITATIVE_RESYNC",result["blockers"])
        self.assertEqual(result["status"],"BLOCKED_NOT_QUALIFIED")
        for field in ("project_switch_allowed","task_ready_verified","owner_start_verified",
                      "worker_identity_verified","business_dispatch_authorized",
                      "worker_started","any_state_mutation"):
            self.assertIs(result[field],False)
        self.assertEqual(baseline,self.active.read_bytes())
        self.assertIn("PENDING_SOT_REVIEW",self.registry.read_text())

    def test_github_raw_snapshot_verified_with_two_exact_matching_immutable_blobs(self):
        opened=MockOpener(build_api_response())
        result=mod.verify_sot(links.parse_sot_url(OPS),opener=opened)
        self.assertTrue(result["document_exists"])
        self.assertFalse(result["task_ready_verified"])
        self.assertEqual(result["content_sha256"],hashlib.sha256(SOT_TEXT).hexdigest())
        self.assertEqual(len(opened.calls),2)
        self.assertEqual(opened.calls[0][0],
            "https://api.github.com/repos/magasincoffee/OPS-WebApp/contents/SOURCE_OF_TRUTH.md?ref=main")
        self.assertTrue(all(x[1]=="GET" and x[2]==8 for x in opened.calls))

    def test_wrong_blob_hash_rejected_even_if_sot_text_contains_ready(self):
        mock=MockOpener(build_api_response(sha="0"*40))
        with self.assertRaisesRegex(mod.Rejected,"GITHUB_SOT_BLOB_MISMATCH"):
            mod.verify_sot(links.parse_sot_url(OPS),opener=mock)

    def test_malicious_metadata_redirect_or_oversize_is_blocked(self):
        link=links.parse_sot_url(OPS)
        for response in (
            build_api_response(extra={"path":"../../SOURCE_OF_TRUTH.md"}),
            build_api_response(extra={"type":"symlink"}),
            build_api_response(extra={"encoding":"raw"}),
            b"x"*(mod.MAX_HTTP_BYTES+20),
        ):
            with self.subTest(response_len=len(response)):
                with self.assertRaises(mod.Rejected):
                    mod.verify_sot(link,opener=MockOpener(response))
        with self.assertRaisesRegex(mod.Rejected,"GITHUB_HOST_CHANGED"):
            mod.verify_sot(link,opener=MockOpener(build_api_response(),redirect=True))
        with self.assertRaisesRegex(mod.Rejected,"GITHUB_CONTENTS_NOT_200"):
            mod.verify_sot(link,opener=MockOpener(build_api_response(),status=403))

    def test_changed_sot_between_two_reads_blocks_selection(self):
        first=build_api_response()
        second=build_api_response(b"# MAGASIN Changed Source of Truth\nStatus: BLOCKED")
        class ChangeOpener:
            n=0
            def open(self, request, timeout):
                self.n+=1
                return DummyResponse(first if self.n==1 else second,request.full_url)
        with self.assertRaisesRegex(mod.Rejected,"GITHUB_SOT_CHANGED_DURING_VERIFICATION"):
            mod.verify_sot(links.parse_sot_url(OPS),opener=ChangeOpener())

    def test_no_owner_stop_rejects_before_fetching_remote_sot(self):
        (self.stop/"STOP").unlink()
        called=[]
        r=self.assess(fetcher=lambda candidate:called.append(candidate))
        self.assertIn("OWNER_STOP_OR_CURRENT_BINDING_UNVERIFIED",r["blockers"])
        self.assertEqual(called,[])
        self.assertFalse(r["project_switch_allowed"])

    def test_unknown_transaction_blocks_even_after_terminal_local_state(self):
        for state in ('{"outbound":{"state":"VERIFIED"}}','{"outbound":{}}','{}','not-json'):
            self.tx.write_text(state)
            r=self.assess(fetcher=lambda _:{"document_exists":True})
            self.assertFalse(r["project_switch_allowed"])
            self.assertTrue(any("OUTBOUND" in b or "TRANSACTION" in b
                                for b in r["blockers"]))
        self.tx.unlink()
        self.assertIn("SUPERVISOR_TRANSACTION_STATE_UNVERIFIED",
                      self.assess(fetcher=lambda _:None)["blockers"])

    def test_unknown_request_or_untrusted_local_registry_never_selected(self):
        r=mod.inspect_candidate("f"*24,**self.params,fetcher=lambda _:{"document_exists":True})
        self.assertIn("PROJECT_REQUEST_NOT_PENDING",r["blockers"])
        self.registry.write_text('{"schema":"FORGED", "requests":[]}')
        r=self.assess(fetcher=lambda _:{"document_exists":True})
        self.assertIn("REQUEST_REGISTRY_NOT_TRUSTED",r["blockers"])
        self.assertIsNone(r["sot_evidence"])

    def test_reject_url_as_request_id_and_wrong_machine(self):
        r=mod.inspect_candidate(OPS,**self.params)
        self.assertIn("PROJECT_REQUEST_ID_INVALID",r["blockers"])
        r=self.assess(machine="WRONG-MACHINE")
        self.assertIn("WRONG_MACHINE",r["blockers"])
        self.assertIsNone(r["sot_evidence"])

    def test_untrusted_remote_sot_network_error_fail_closed(self):
        def deny(_):
            raise mod.Rejected("GITHUB_SOT_NOT_ACCESSIBLE")
        result=self.assess(fetcher=deny)
        self.assertIn("GITHUB_SOT_UNVERIFIED",result["blockers"])
        self.assertFalse(result["business_dispatch_authorized"])

    def test_no_outbound_http_posts_or_live_controller_writes(self):
        import inspect
        source=inspect.getsource(mod)
        for banned in ("subprocess", "Popen(", "os.system", "os.replace",
                       "write_text(", "write_bytes(", "requests.post", "Start-ScheduledTask",
                       "control_adapter.perform", "urlopen("):
            self.assertNotIn(banned,source)
        self.assertIn('method="GET"',source)
        self.assertIn("BLOCKED_NOT_QUALIFIED",source)


if __name__=="__main__":
    unittest.main()
