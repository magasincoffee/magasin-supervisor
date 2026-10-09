# -*- coding: utf-8 -*-
"""SC-013 Owner START/STOP for *read-only monitoring only*.

The existing Windows 30-minute technical tick is independent. This module never
starts a daemon, triggers workers, grants a business-execution permission, clears
Supervisor STOP, or changes any specialist Owner flags. It must be called only
from the local loopback, same-origin-CSRF-protected Control Center endpoint.
"""
from __future__ import annotations

import json
import os
import socket
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MACHINE = "DESKTOP-H4A16IL"
ROOT = Path(r"D:\MAGASIN_ROBOTS\robots\coordinator")
CONTROL_STATE = ROOT / "state" / "owner-lifecycle.json"
LOCK_PATH = ROOT / "state" / "owner-lifecycle.lock"
REPORT = ROOT / "state" / "coordinator-status.json"
TECHNICAL_TICK = Path(r"D:\MAGASIN_ROBOTS\control-center\state\sc013-local-30m.json")
SPECIALISTS = ROOT / "config" / "owner_enabled.json"
SUPERVISOR = Path(os.environ.get("LOCALAPPDATA", r"C:\Users\admin\AppData\Local")) / "MAGASIN" / "BusinessOS" / "supervisor"
SCHEMA = "MAGASIN_SC013_OWNER_MONITOR_LIFECYCLE_V1"
MIN_AVAILABLE_RAM_GIB = 0.75
MAX_HEARTBEAT_AGE_SECONDS = 75 * 60
MAX_LOCK_AGE_SECONDS = 120


def utcnow():
    return datetime.now(timezone.utc)


def read_json(path: Path) -> dict:
    try:
        obj = json.loads(path.read_text(encoding="utf-8-sig"))
        return obj if isinstance(obj, dict) else {}
    except (OSError, UnicodeError, ValueError):
        return {}


def parse_time(value: Any):
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt.astimezone(timezone.utc) if dt.tzinfo else None
    except ValueError:
        return None


def _memory_gib():
    # No psutil / browser dependency. Windows exposes bounded system memory.
    import ctypes
    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ulong), ("memory_load", ctypes.c_ulong),
                    ("total_phys", ctypes.c_ulonglong), ("avail_phys", ctypes.c_ulonglong),
                    ("total_page", ctypes.c_ulonglong), ("avail_page", ctypes.c_ulonglong),
                    ("total_virtual", ctypes.c_ulonglong), ("avail_virtual", ctypes.c_ulonglong),
                    ("avail_extended_virtual", ctypes.c_ulonglong)]
    m = MemoryStatus()
    m.length = ctypes.sizeof(m)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
        return 0.0
    return m.avail_phys / (1024 ** 3)


def _lock_acquire(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    # An unexplained stale lock is NOT safe to unlink automatically.
    return os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)


def _lock_release(fd: int, path: Path):
    os.close(fd)
    try:
        path.unlink()
    except OSError:
        # An unremovable lock fails the next control action closed.
        pass


def _write_atomic(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".pending")
    if tmp.exists():
        raise RuntimeError("PENDING_LIFECYCLE_WRITE_REQUIRES_REVIEW")
    try:
        with tmp.open("x", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    except BaseException:
        if tmp.exists():
            tmp.unlink()
        raise


def evaluate(*, host=None, now=None, memory_gib=None,
             lifecycle_file=CONTROL_STATE, report_file=REPORT,
             tick_file=TECHNICAL_TICK, specialists_file=SPECIALISTS,
             supervisor_root=SUPERVISOR, lock_file=LOCK_PATH):
    """Checks state and returns an honest, non-authorizing Owner control view."""
    time_now = now or utcnow()
    hostname = (host or socket.gethostname()).upper()
    saved = read_json(lifecycle_file)
    coordinator = read_json(report_file)
    technical = read_json(tick_file)
    allowed = read_json(specialists_file)
    reasons = []
    if hostname != MACHINE:
        reasons.append("WRONG_MACHINE")
    if (supervisor_root / "STOP").exists() or (supervisor_root / "AUTOSTART_DISABLED").exists():
        reasons.append("SUPERVISOR_STOP_LATCH")
    if any(allowed.get(name) is not False for name in ("supervisor", "saydi", "sapo")):
        reasons.append("SPECIALIST_FLAGS_NOT_VERIFIED_OFF")
    if coordinator.get("execution_enabled") is not False:
        reasons.append("EXECUTION_FLAG_NOT_FALSE")
    if coordinator.get("mode") != "OFF_OWNER_MANUAL":
        # A future mode may be added only through independently reviewed source.
        reasons.append("COORDINATOR_MODE_UNQUALIFIED")
    if lock_file.exists():
        reasons.append("LIFECYCLE_LOCK_PRESENT")
    if lifecycle_file.with_suffix(".pending").exists():
        reasons.append("PENDING_LIFECYCLE_WRITE")
    ram = float(memory_gib) if memory_gib is not None else _memory_gib()
    if ram < MIN_AVAILABLE_RAM_GIB:
        reasons.append("LOW_AVAILABLE_RAM")
    at = parse_time(technical.get("completed_at"))
    age = (time_now - at).total_seconds() if at else None
    if (technical.get("schema") != "MAGASIN_LOCAL_30M_TICK_V1" or
        technical.get("target") != MACHINE or
        technical.get("executor") != "local_windows_scheduler" or
        not isinstance(technical.get("actions"), list) or
        any(a.get("state") != "PASS" or a.get("exit_code") != 0
            for a in technical["actions"] if isinstance(a, dict)) or
        len(technical["actions"]) != 2 or
        technical.get("errors") != [] or
        age is None or age < -10 or age > MAX_HEARTBEAT_AGE_SECONDS):
        reasons.append("TECHNICAL_HEARTBEAT_NOT_QUALIFIED")
    current = saved.get("desired")
    valid_saved = (saved.get("schema") == SCHEMA and
                   current in ("MONITOR_READ_ONLY", "STOP") and
                   saved.get("execution_enabled") is False and
                   saved.get("business_dispatch_enabled") is False and
                   type(saved.get("generation")) is int and saved["generation"] > 0)
    if saved and not valid_saved:
        reasons.append("LIFECYCLE_STATE_INVALID")
    desired = current if valid_saved else "STOP"
    fresh_monitor = desired == "MONITOR_READ_ONLY" and not reasons
    return {
        "schema": SCHEMA,
        "desired": desired,
        "status": "MONITORING_READ_ONLY" if fresh_monitor else
                  ("BLOCKED_SAFETY" if desired == "MONITOR_READ_ONLY" else "OWNER_STOPPED"),
        "start_allowed": not reasons,
        "stop_allowed": hostname == MACHINE,
        "blockers": sorted(set(reasons)),
        "generation": saved.get("generation", 0) if valid_saved else 0,
        "requested_at": saved.get("requested_at") if valid_saved else None,
        "technical_heartbeat_at": technical.get("completed_at"),
        "available_ram_gib": round(ram, 2),
        "execution_enabled": False,
        "business_dispatch_enabled": False,
        "specialists_started": False,
        "note": "Monitoring only; not evidence of a running business worker.",
    }


def perform(action: str, confirmation: str, *, source: str):
    """Explicit owner action via local Control Center, no subprocesses or workers."""
    if action not in ("start", "stop") or confirmation != (
        "START_COORDINATOR_READ_ONLY" if action == "start" else "STOP_COORDINATOR"
    ) or source != "local_control_center":
        return 400, {"ok": False, "message": "Lệnh Owner không hợp lệ."}
    if socket.gethostname().upper() != MACHINE:
        return 409, {"ok": False, "message": "Sai máy được ủy quyền."}
    try:
        handle = _lock_acquire(LOCK_PATH)
    except FileExistsError:
        return 409, {"ok": False, "message": "Cổng vòng đời đang bị khóa. Cần kiểm tra trước khi thử lại."}
    try:
        before = evaluate(lock_file=Path(r"Z:\not-a-real-lifecycle-lock"))
        # evaluate() receives a synthetic absent lock while this action owns
        # the real exclusive lock. Do not skip any other gate.
        if action == "start" and not before["start_allowed"]:
            return 409, {"ok": False, "message": "START bị chặn bởi kiểm tra an toàn.",
                         "preflight": before}
        existing = read_json(CONTROL_STATE)
        if existing and (existing.get("schema") != SCHEMA or
                         type(existing.get("generation")) is not int or
                         existing["generation"] < 1):
            return 409, {"ok": False, "message": "Trạng thái Owner không hợp lệ; cần kiểm tra."}
        generation = existing.get("generation", 0) + 1
        next_state = {
            "schema": SCHEMA, "generation": generation,
            "desired": "MONITOR_READ_ONLY" if action == "start" else "STOP",
            "requested_at": utcnow().isoformat(),
            "control_source": "local_control_center",
            "execution_enabled": False,
            "business_dispatch_enabled": False,
            "specialists_started": False,
        }
        _write_atomic(CONTROL_STATE, next_state)
        # We do not claim a worker was launched. The existing local 30min tick
        # remains the independent executor and may later prove a fresh cycle.
        return 200, {"ok": True, "message": (
            "Đã bật quyền GIÁM SÁT CHỈ ĐỌC. Robot chưa được phép giao việc."
            if action == "start" else
            "Đã dừng giám sát Robot Tổng. Không ảnh hưởng lịch kiểm tra kỹ thuật."
        ), "desired": next_state["desired"], "generation": generation,
            "execution_enabled": False, "business_dispatch_enabled": False}
    except (OSError, ValueError, RuntimeError):
        return 503, {"ok": False, "message": "Không thể ghi trạng thái vòng đời an toàn."}
    finally:
        _lock_release(handle, LOCK_PATH)
