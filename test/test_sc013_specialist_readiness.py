# -*- coding: utf-8 -*-
"""SC-013 specialist control-blocker diagnostic tests; NO real robot START."""
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "src" / "control-center" / "specialist_readiness.py"
spec = importlib.util.spec_from_file_location("sc013_control_readiness", SOURCE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
NOW = datetime(2026, 10, 9, 14, 15, tzinfo=timezone.utc)


class SpecialistReadinessTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(prefix="sc013_control_blockers_")
        self.addCleanup(self.dir.cleanup)
        self.root = Path(self.dir.name)
        self.manifest = self.root / "robot.json"
        self.write_manifest("saydi-media", False)
        self.media = {
            "updated": NOW.isoformat(),
            "status": {"kind":"warning","active":False},
            "worker": False,
            "chapter2": {"stage":"PAUSED_RESOURCE","min_start_ram_gb":2.3}
        }

    def write_manifest(self, identity, verified):
        self.manifest.write_text(json.dumps({
            "id": identity, "manual_controls_verified": verified,
            "startup": "legacy-scheduled-tasks-and-control"
        }), encoding="utf-8")

    def saydi(self, **updates):
        data = dict(
            robot="saydi", manifest_path=self.manifest,
            media=self.media, free_ram_gb=1.46,
            now=NOW, specialist_enabled=False
        )
        data.update(updates)
        return mod.examine(**data)

    def test_real_sample_saydi_resource_shortage_and_missing_owner_control(self):
        r = self.saydi()
        self.assertFalse(r["control_ready"])
        self.assertFalse(r["start_allowed"])
        self.assertFalse(r["stop_allowed"])
        self.assertFalse(r["business_dispatch_authorized"])
        self.assertIn("THIẾU_RAM_CHO_SAYDI",r["start_blockers"])
        self.assertIn("QC_CHƯƠNG_2_ĐANG_CHỜ_TÀI_NGUYÊN",r["start_blockers"])
        self.assertIn("CHƯA_KIỂM_THỬ_START_STOP_THỰC_TẾ",r["start_blockers"])
        self.assertIn("2.3 GB",r["recovery_hint"])
        self.assertEqual(r["owner_enable_advisory"],"OFF")

    def test_even_ample_ram_and_healthy_media_cannot_unlock_unverified_start(self):
        self.write_manifest("saydi-media", True)
        media={**self.media,
               "status":{"kind":"idle","active":False},
               "chapter2":{"stage":"REVIEW_READY","min_start_ram_gb":2.3}}
        r=self.saydi(media=media,free_ram_gb=6)
        self.assertNotIn("THIẾU_RAM_CHO_SAYDI",r["start_blockers"])
        self.assertFalse(r["start_allowed"])
        self.assertFalse(r["stop_allowed"])
        self.assertFalse(r["owner_authority_verified"])

    def test_offline_or_stale_media_does_not_enable_button(self):
        r=self.saydi(media={})
        self.assertIn("MEDIA_CONTROL_CHƯA_PHẢN_HỒI",r["start_blockers"])
        self.assertIn("TRẠNG_THÁI_SAYDI_CHƯA_ĐỦ_MỚI",r["start_blockers"])
        stale={**self.media,"updated":(NOW-timedelta(hours=5)).isoformat()}
        self.assertIn("TRẠNG_THÁI_SAYDI_CHƯA_ĐỦ_MỚI",
                      self.saydi(media=stale)["start_blockers"])

    def test_existing_media_worker_must_not_be_terminated_by_view(self):
        r=self.saydi(media={**self.media,"worker":True})
        self.assertIn("PHÁT_HIỆN_CÔNG_VIỆC_MEDIA_ĐANG_CHẠY_KHÔNG_TỰ_DỪNG",
                      r["start_blockers"])
        self.assertFalse(r["stop_allowed"])

    def test_sapo_legacy_schedules_finance_safety_and_owner_flags(self):
        self.write_manifest("sapo",False)
        r=mod.examine("sapo",manifest_path=self.manifest,free_ram_gb=2.0,
                      specialist_enabled=False)
        self.assertFalse(r["start_allowed"])
        self.assertFalse(r["stop_allowed"])
        self.assertIn("SAPO_CÓ_LỊCH_ĐỒNG_BỘ_CŨ_CHƯA_CHUYỂN_SANG_OWNER_CONTROL",
                      r["start_blockers"])
        self.assertIn("KHÔNG_ĐƯỢC_DỪNG_ĐỐI_SOÁT_HOẶC_GHI_DỮ_LIỆU_KHI_CHƯA_XÁC_MINH",
                      r["start_blockers"])

    def test_owner_flag_true_does_not_act_as_authorization(self):
        self.write_manifest("saydi-media",True)
        r=self.saydi(specialist_enabled=True,free_ram_gb=8)
        self.assertIn("TRẠNG_THÁI_OWNER_CHƯA_XÁC_MINH_OFF",r["start_blockers"])
        self.assertFalse(r["owner_authority_verified"])
        self.assertFalse(r["business_dispatch_authorized"])

    def test_missing_or_forged_manifest_fails_closed(self):
        self.manifest.unlink()
        self.assertIn("THIẾU_MANIFEST_ROBOT_HỢP_LỆ",self.saydi()["start_blockers"])
        self.write_manifest("supervisor",True)
        self.assertIn("THIẾU_MANIFEST_ROBOT_HỢP_LỆ",self.saydi()["start_blockers"])

    def test_invalid_resource_value_fails_closed(self):
        for value in (None,True,-1,float("nan"),"8"):
            with self.subTest(value=value):
                r=self.saydi(free_ram_gb=value)
                self.assertIn("CHƯA_XÁC_MINH_RAM_TRỐNG",r["start_blockers"])
                self.assertFalse(r["start_allowed"])

    def test_unknown_robot_does_not_acquire_control(self):
        r=mod.examine("supervisor",manifest_path=self.manifest,free_ram_gb=5)
        self.assertFalse(r["start_allowed"])
        self.assertFalse(r["stop_allowed"])
        self.assertFalse(r["control_ready"])

    def test_even_deceptive_snapshot_cannot_authorize_saydi(self):
        media={**self.media,"owner_approved":True,
               "execution_qualified":True,"business_dispatch_authorized":True}
        r=self.saydi(media=media,free_ram_gb=9)
        self.assertFalse(r["start_allowed"])
        self.assertFalse(r["business_dispatch_authorized"])

if __name__=="__main__":
    unittest.main()
