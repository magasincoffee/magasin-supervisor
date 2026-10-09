# -*- coding: utf-8 -*-
"""Read-only, fail-closed evidence for disabled SAYDI/SAPO lifecycle buttons.

No START/STOP implementation exists for these specialists in the unified
Control Center. Present explicit, grounded blockers; never turn a process,
scheduled task, advisory Owner flag, or legacy SAYDI Media Control status into
authorization to mutate a specialist. Independent specialist SOT is required.
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path

MIN_SAYDI_RAM_GB = 2.3
SCHEMA = "MAGASIN_SPECIALIST_CONTROL_READINESS_V1"
MANIFEST_ID = {"saydi": "saydi-media", "sapo": "sapo"}
REQUIRED_SOT = {
    "saydi": "magasincoffee/magasin-media-robot",
    "sapo": "magasincoffee/OPS-WebApp",
}
MAX_FILE_BYTES = 8192


def _safe_json(path):
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
            return {}
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        return data if type(data) is dict else {}
    except (OSError, UnicodeError, ValueError):
        return {}


def _ram(value):
    if type(value) not in (float, int) or not math.isfinite(value) or value < 0:
        return None
    return round(value, 2)


def _is_fresh(value, now):
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if date.tzinfo is None:
            return False
        delta = (now - date.astimezone(timezone.utc)).total_seconds()
        return -15 <= delta <= 120
    except (ValueError, AttributeError, TypeError):
        return False


def examine(robot, *, manifest=None, manifest_path=None,
            media=None, free_ram_gb=None, now=None, specialist_enabled=None):
    """Return explanation only; START/STOP are always locked until separate QA.

    Production controls cannot obtain capabilities by calling this function.
    """
    if robot not in MANIFEST_ID:
        return {
            "schema": SCHEMA, "start_allowed": False, "stop_allowed": False,
            "control_ready": False, "start_blockers": ["ROBOT_KHÔNG_HỖ_TRỢ"],
            "recovery_hint": "Chưa có bộ điều khiển được nghiệm thu.",
        }
    evidence = manifest if manifest is not None else _safe_json(manifest_path)
    data = media if type(media) is dict else {}
    reasons = ["CHƯA_CÓ_BỘ_ĐIỀU_KHIỂN_START_STOP_ĐƯỢC_NGHIỆM_THU"]
    if type(evidence) is not dict or evidence.get("id") != MANIFEST_ID[robot]:
        reasons.append("THIẾU_MANIFEST_ROBOT_HỢP_LỆ")
    elif evidence.get("manual_controls_verified") is not True:
        reasons.append("CHƯA_KIỂM_THỬ_START_STOP_THỰC_TẾ")
    if specialist_enabled is not False:
        reasons.append("TRẠNG_THÁI_OWNER_CHƯA_XÁC_MINH_OFF")
    ram = _ram(free_ram_gb)
    if robot == "saydi":
        stage = data.get("chapter2") if type(data.get("chapter2")) is dict else {}
        min_ram = stage.get("min_start_ram_gb")
        if type(min_ram) not in (float, int) or not math.isfinite(min_ram):
            min_ram = MIN_SAYDI_RAM_GB
        required = max(MIN_SAYDI_RAM_GB, min_ram)
        if ram is None:
            reasons.append("CHƯA_XÁC_MINH_RAM_TRỐNG")
        elif ram < required:
            reasons.append("THIẾU_RAM_CHO_SAYDI")
        when = now or datetime.now(timezone.utc)
        if not _is_fresh(data.get("updated"), when):
            reasons.append("TRẠNG_THÁI_SAYDI_CHƯA_ĐỦ_MỚI")
        if not isinstance(data.get("status"), dict):
            reasons.append("MEDIA_CONTROL_CHƯA_PHẢN_HỒI")
        if data.get("worker") is True or (
            type(data.get("status")) is dict and data["status"].get("active") is True
        ):
            reasons.append("PHÁT_HIỆN_CÔNG_VIỆC_MEDIA_ĐANG_CHẠY_KHÔNG_TỰ_DỪNG")
        if stage.get("stage") in ("PAUSED_RESOURCE", "WAIT_RESOURCE"):
            reasons.append("QC_CHƯƠNG_2_ĐANG_CHỜ_TÀI_NGUYÊN")
        hint = (f"SAYDI cần tối thiểu {required:g} GB RAM trống cho QC chương 2. "
                "Mở Media Control để xem tiến độ; chỉ START/STOP qua bộ điều khiển SAYDI đã được kiểm thử.")
    else:
        reasons.append("SAPO_CÓ_LỊCH_ĐỒNG_BỘ_CŨ_CHƯA_CHUYỂN_SANG_OWNER_CONTROL")
        reasons.append("KHÔNG_ĐƯỢC_DỪNG_ĐỐI_SOÁT_HOẶC_GHI_DỮ_LIỆU_KHI_CHƯA_XÁC_MINH")
        hint = ("Phải nghiệm thu START/STOP riêng của SAPO, trạng thái đồng bộ và checkpoint "
                "trước khi cho phép bấm. Không dùng nút chung để chạy đồng bộ doanh thu thật.")
    return {
        "schema": SCHEMA,
        "robot": robot,
        "control_ready": False,
        "start_allowed": False,
        "stop_allowed": False,
        "start_blockers": reasons,
        "recovery_hint": hint,
        "free_ram_gb": ram,
        "owner_enable_advisory": "OFF" if specialist_enabled is False else "UNVERIFIED",
        "owner_authority_verified": False,
        "business_dispatch_authorized": False,
        "read_only": True,
        "sot_repository": REQUIRED_SOT[robot],
    }
