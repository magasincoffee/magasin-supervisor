# -*- coding: utf-8 -*-
"""Source-only SC-013 specialist lifecycle attestation tests: no real robot."""
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "src" / "coordinator" / "specialist_lifecycle_attestation.py"
spec = importlib.util.spec_from_file_location("sc013_specialist_lifecycle", SOURCE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = datetime(2026, 10, 9, 13, 55, tzinfo=timezone.utc)
KEY = m.FIXTURE_KEY_PREFIX + b"fixture-identity-secret-not-a-production-key-00000000000"


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def statement(robot="supervisor", **change):
    obj = {
        "schema": m.FIXTURE_SCHEMA, "machine": "SIMULATED_ONLY",
        "robot": robot, "intent":"OWNER_ENABLED_FIXTURE",
        "generation": 7, "boot_id": "a"*32, "worker_instance":"b"*32,
        "worker_pid": 7123,
        "issued_at": (NOW - timedelta(seconds=3)).isoformat(),
        "expires_at": (NOW + timedelta(seconds=45)).isoformat(),
        "nonce": "c"*32,
    }
    obj.update(change)
    return obj


def witness(att):
    return {
        "schema":"SC013_WORKER_WITNESS_FIXTURE_V1",
        "robot":att["robot"], "machine":"SIMULATED_ONLY",
        "generation":att["generation"], "boot_id":att["boot_id"],
        "worker_instance":att["worker_instance"], "worker_pid":att["worker_pid"],
        "heartbeat_at": NOW.isoformat(), "alive":True, "worker_off":False,
    }


class LifecycleAttestationTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(prefix="sc013_attestation_")
        self.addCleanup(self.dir.cleanup)
        root=Path(self.dir.name)
        self.manifests={}
        for k, ident in m.MANIFEST_IDS.items():
            self.manifests[k]=root / k / "robot.json"
            write(self.manifests[k], {
                "id": ident, "manual_controls_verified":False,
                "startup":"legacy-scheduled-tasks-and-control"})
        self.flags=root/"flags.json"
        write(self.flags,{"supervisor":False,"saydi":False,"sapo":False})
        self.supervisor=root/"supervisor-runtime"
        self.supervisor.mkdir()
        write(self.supervisor/"guardian-status.json", {
            "timestamp": NOW.isoformat(), "wrapper_alive":False,
            "watchdog_mode":"FAULT", "automation_status":"BLOCKED",
            "owner_stop":False, "control_valid":True,
        })

    def observe(self, robot, **kwargs):
        return m.observe_local(robot,host=m.HOST,manifests=self.manifests,
                               coordinator_flags=self.flags,
                               supervisor_root=self.supervisor,now=NOW,**kwargs)

    def verify(self, att=None, **kwargs):
        att=att or statement()
        signed=m.fixture_signature(att, KEY)
        params={
            "key":KEY, "trusted_generation":7,
            "witness":witness(att), "stop":False,
            "now":NOW, "fixture_only":True,
        }
        params.update(kwargs)
        return m.verify_fixture_attestation(att,signed,**params)

    def test_supervisor_guardian_fault_and_wrapper_absence_block_automation(self):
        result=self.observe("supervisor")
        self.assertEqual(result["status"],"BLOCKED_NOT_QUALIFIED")
        for blocker in ("SUPERVISOR_WRAPPER_NOT_ALIVE",
                        "SUPERVISOR_GUARDIAN_FAULT_OR_UNKNOWN",
                        "SPECIALIST_START_STOP_NOT_QUALIFIED",
                        "SIGNED_OWNER_AND_WORKER_PROOF_NOT_INSTALLED"):
            self.assertIn(blocker,result["blockers"])
        self.assertFalse(result["business_dispatch_authorized"])
        self.assertFalse(result["owner_start_verified"])

    def test_media_and_sales_legacy_manifests_do_not_prove_owner_start(self):
        for robot in ("saydi","sapo"):
            with self.subTest(robot=robot):
                result=self.observe(robot)
                self.assertEqual(result["status"],"BLOCKED_NOT_QUALIFIED")
                self.assertIn("LEGACY_STARTUP_NOT_OWNER_ATTESTATION",result["blockers"])
                self.assertIn("NO_INDEPENDENT_SPECIALIST_OWNER_PROOF",result["blockers"])
                self.assertFalse(result["execution_qualified"])

    def test_advisory_flag_true_never_qualifies_any_specialist(self):
        write(self.flags,{"supervisor":True,"saydi":True,"sapo":True})
        for robot in m.MANIFESTS:
            result=self.observe(robot)
            self.assertIn("SPECIALIST_NOT_CONFIRMED_OFF",result["blockers"])
            self.assertFalse(result["owner_start_verified"])

    def test_supervisor_healthy_process_without_owner_attestation_is_still_not_qualified(self):
        write(self.manifests["supervisor"],{
            "id":"supervisor", "manual_controls_verified":True,
            "startup":"manual"})
        write(self.supervisor/"guardian-status.json",{
            "timestamp":NOW.isoformat(), "wrapper_alive":True,
            "watchdog_mode":"HEALTHY", "automation_status":"RUNNING",
            "owner_stop":False, "control_valid":True,
        })
        result=self.observe("supervisor")
        self.assertEqual(result["status"],"BLOCKED_NOT_QUALIFIED")
        self.assertEqual(result["blockers"],["SIGNED_OWNER_AND_WORKER_PROOF_NOT_INSTALLED"])

    def test_supervisor_stop_latch_stale_heartbeat_and_bad_manifest(self):
        (self.supervisor/"STOP").touch()
        self.assertIn("SUPERVISOR_STOP_LATCH",self.observe("supervisor")["blockers"])
        (self.supervisor/"STOP").unlink()
        write(self.supervisor/"guardian-status.json",{
            "timestamp":(NOW-timedelta(hours=2)).isoformat(),
            "wrapper_alive":True,"watchdog_mode":"HEALTHY",
            "automation_status":"RUNNING","owner_stop":False,"control_valid":True
        })
        self.assertIn("GUARDIAN_HEARTBEAT_STALE",self.observe("supervisor")["blockers"])
        write(self.manifests["supervisor"],{
            "id":"sapo","manual_controls_verified":True
        })
        self.assertIn("MANIFEST_IDENTITY_MISMATCH",self.observe("supervisor")["blockers"])

    def test_missing_corrupt_evidence_wrong_machine_or_unknown_robot_rejected(self):
        self.assertEqual(m.observe_local("root", host=m.HOST)["status"],
                         "BLOCKED_UNSUPPORTED_ROBOT")
        self.assertEqual(m.observe_local("supervisor",host="DESKTOP-4K7IM13")["status"],
                         "BLOCKED_WRONG_MACHINE")
        self.manifests["sapo"].unlink()
        self.assertIn("LOCAL_EVIDENCE_MISSING_OR_INVALID",self.observe("sapo")["blockers"])
        self.assertFalse(self.observe("sapo")["business_dispatch_authorized"])

    def test_signed_synthetic_owner_and_worker_witness_never_authorize_dispatch(self):
        for robot in m.MANIFESTS:
            proof=statement(robot)
            good=self.verify(proof)
            self.assertEqual(good["status"],"FIXTURE_SIGNATURE_AND_WITNESS_MATCHED_ONLY")
            self.assertEqual(good["reason"],"REAL_OWNER_AND_WORKER_TRUST_ROOTS_NOT_INSTALLED")
            for k in ("owner_start_verified","worker_identity_verified",
                      "business_dispatch_authorized","execution_qualified","dispatched"):
                self.assertFalse(good[k],k)

    def test_signature_unknown_key_wrong_generation_or_unapproved_scope_fails_closed(self):
        signed=m.fixture_signature(statement(), KEY)
        changed=statement(worker_pid=1)
        badsig=m.verify_fixture_attestation(changed,signed,key=KEY,
            trusted_generation=7,witness=witness(changed),stop=False,
            now=NOW,fixture_only=True)
        self.assertEqual(badsig["reason"],"SIGNATURE_MISMATCH")
        for params, reason in [
            ({"trusted_generation":6},"ATTESTATION_AUTHORITY_MISMATCH"),
            ({"stop":True},"OWNER_STOP_OR_UNKNOWN"),
            ({"fixture_only":False},"EXPLICIT_FIXTURE_ONLY_REQUIRED"),
            ({"key":b"real-key"},"FIXTURE_KEY_UNQUALIFIED"),
        ]:
            self.assertEqual(self.verify(**params)["reason"],reason)

    def test_stale_replay_future_or_overlong_signature_expiry_rejected(self):
        stale=statement(issued_at=(NOW-timedelta(minutes=3)).isoformat(),
                        expires_at=(NOW-timedelta(minutes=2)).isoformat())
        self.assertEqual(self.verify(stale)["reason"],"PROOF_EXPIRED_FUTURE_OR_LONG_LIVED")
        future=statement(issued_at=(NOW+timedelta(minutes=1)).isoformat(),
                         expires_at=(NOW+timedelta(minutes=2)).isoformat())
        self.assertEqual(self.verify(future)["reason"],"PROOF_EXPIRED_FUTURE_OR_LONG_LIVED")
        overlong=statement(expires_at=(NOW+timedelta(hours=1)).isoformat())
        self.assertEqual(self.verify(overlong)["reason"],"PROOF_EXPIRED_FUTURE_OR_LONG_LIVED")
        self.assertEqual(self.verify(used_nonces=["c"*32])["reason"],
                         "ATTESTATION_NONCE_ALREADY_CONSUMED")

    def test_wrong_worker_pid_boot_instance_generation_or_stale_heartbeat_rejected(self):
        att=statement()
        for changes in [
            {"worker_pid":1919},{"boot_id":"d"*32},
            {"worker_instance":"d"*32},{"generation":6},
            {"worker_off":True},{"alive":False},
            {"heartbeat_at":(NOW-timedelta(minutes=15)).isoformat()},
            {"machine":"DESKTOP-H4A16IL"},
        ]:
            with self.subTest(change=changes):
                w={**witness(att),**changes}
                actual=self.verify(att,witness=w)
                self.assertIn(actual["reason"],("WORKER_WITNESS_MISMATCH",
                                                 "WORKER_HEARTBEAT_STALE"))
                self.assertFalse(actual["business_dispatch_authorized"])

    def test_attestation_shapes_and_real_machine_are_rejected(self):
        for proof in [
            statement(machine="DESKTOP-H4A16IL"),
            statement(intent="OWNER_ENABLE_PRODUCTION"),
            statement(generation=True),
            statement(worker_pid="8123"),
            statement(nonce="not-hex"),
            {**statement(),"shell":"powershell -command start-robot"},
        ]:
            with self.subTest(proof=proof):
                result=self.verify(proof)
                self.assertNotEqual(result["status"],"FIXTURE_SIGNATURE_AND_WITNESS_MATCHED_ONLY")
                self.assertFalse(result["business_dispatch_authorized"])

    def test_no_implicit_real_owner_credential_can_be_used_in_fixture(self):
        with self.assertRaisesRegex(m.EvidenceRejected,
                                    "REAL_OR_WEAK_SECRET_FORBIDDEN_IN_FIXTURE"):
            m.fixture_signature(statement(),b"x"*64)


if __name__=="__main__":
    unittest.main()
