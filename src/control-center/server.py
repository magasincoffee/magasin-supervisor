# -*- coding: utf-8 -*-
"""MAGASIN Robot Control Center V1: safe, local-only unified dashboard.

This process is a CONTROL VIEW with an Owner-confirmed Supervisor lifecycle
adapter. Specialist robot SOTs and runtime folders remain authoritative.
Supervisor START/STOP requires local same-origin CSRF, exact action confirmation
and fresh safety checks. SAYDI/SAPO lifecycle controls remain disabled.
"""
from __future__ import annotations

import json
import os
import sys
import secrets
import hmac
import time
import threading
from pathlib import Path
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from urllib.request import urlopen
import psutil
import observability

BASE = Path(__file__).resolve().parent
WEB = BASE / "web"
PORT = 8781
HOST = "127.0.0.1"
SUP = Path(os.environ.get("LOCALAPPDATA", "")) / "MAGASIN" / "BusinessOS" / "supervisor"
SAYDI = Path(r"C:\SAYDI")
SAPO = Path(os.environ.get("LOCALAPPDATA", "")) / "MAGASIN" / "SAPO"
MCP = Path(r"C:\MAGASIN_MCP")
ROBOT_DIR = BASE.parent / "robots"
sys.path.insert(0, str(ROBOT_DIR / "supervisor"))
sys.path.insert(0, str(ROBOT_DIR / "coordinator"))
CONTROL_TOKEN = secrets.token_urlsafe(32)

ROBOTS = {
    "coordinator": {"name": "Robot Tổng — Điều phối", "category": "GitHub / Supabase → SOT → phân phối",
        "root": BASE.parent / "robots" / "coordinator",
        "summary": "Nhận yêu cầu, phân tích, lên phương án giao việc, theo dõi QA và chuyển lại khi chưa đạt",
        "repository": "https://github.com/magasincoffee/magasin-supervisor",
        "icon": "🧠"},
    "supervisor": {"name": "Supervisor / WebApp", "category": "WebApp • GitHub • CI", "root": SUP,
                   "summary": "Phát triển và kiểm tra WebApp theo SOT riêng",
                   "repository": "https://github.com/magasincoffee/magasin-supervisor",
                   "icon": "🖥️"},
    "saydi": {"name": "SAYDI Media", "category": "Sách nói • Render • QC", "root": SAYDI,
              "summary": "Sản xuất và kiểm tra chất lượng sách nói",
              "repository": "https://github.com/magasincoffee/magasin-media-robot",
              "icon": "🎙️"},
    "sapo": {"name": "SAPO Sync", "category": "Doanh thu • Đồng bộ", "root": SAPO,
             "summary": "Đồng bộ, đối soát và kiểm tra doanh thu",
             "repository": "https://github.com/magasincoffee/OPS-WebApp",
             "icon": "📦"},
    "gateway": {"name": "MCP / GitHub Gateway", "category": "Kết nối • Hàng đợi • Kiểm tra",
                "root": MCP, "summary": "Nhận và kiểm tra nhiệm vụ local; không tự bật robot",
                "repository": "https://github.com/magasincoffee/magasin-supervisor",
                "icon": "🔗"},
}


def read_json(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
        return value if isinstance(value, dict) else {}
    except (ValueError, OSError, UnicodeError):
        return {}


def ts():
    return datetime.now(timezone.utc).isoformat()


_snapshot_lock = threading.Lock()
_process_snapshot = {"at": 0.0, "rows": []}

def running_processes(needles, limit=18):
    # One bounded cached process scan shared across all robot details.
    # Lifecycle controls separately check fresh process truth.
    with _snapshot_lock:
        if time.monotonic() - _process_snapshot["at"] >= 8:
            found = []
            for proc in psutil.process_iter(["pid", "name", "cmdline"]):
                try:
                    name = (proc.info.get("name") or "").lower()
                    if name not in {"python.exe", "pythonw.exe", "node.exe", "powershell.exe", "cmd.exe", "runner.listener.exe"}:
                        continue
                    cmd = " ".join(proc.info.get("cmdline") or []).lower()
                    if cmd:
                        found.append((proc.pid,proc.info.get("name"),cmd))
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            _process_snapshot["rows"] = found
            _process_snapshot["at"] = time.monotonic()
        rows = list(_process_snapshot["rows"])
    result = []
    for pid, name, cmd in rows:
        if any(n in cmd for n in needles):
            try:
                ram = round(psutil.Process(pid).memory_info().rss / (1024 * 1024), 1)
            except (psutil.NoSuchProcess,psutil.AccessDenied):
                ram = 0
            result.append({"pid": pid, "name": name, "memory_mb": ram})
            if len(result) >= limit:
                break
    return result


def supervisor_status():
    guard = read_json(SUP / "guardian-status.json")
    watch = read_json(SUP / "local-watchdog-status.json")
    procs = running_processes(["run-supervisor.ps1"])
    active = bool(procs) and bool(guard.get("wrapper_alive"))
    if guard.get("owner_stop"):
        label, code = "Đã dừng bởi Owner", "stopped"
    elif active and guard.get("watchdog_mode") != "FAULT":
        label, code = "Đang chạy", "running"
    elif guard.get("watchdog_mode") == "FAULT" or (guard.get("automation_status") == "RUNNING" and not active):
        label, code = "Có lỗi / Chưa chạy", "error"
    else:
        label, code = "Đã dừng", "stopped"
    outbound=(read_json(SUP / "single-conversation-state.json").get("outbound") or {})
    return {"status": code, "label": label, "phase": guard.get("automation_phase") or "Chưa có thông tin",
            "last_seen": guard.get("timestamp"), "processes": procs,
            "details": {"Trạng thái điều khiển": guard.get("automation_status", "Không rõ"),
                        "Watchdog": guard.get("watchdog_mode", "Không rõ"),
                        "Wrapper thực tế": "Đang chạy" if active else "Không chạy",
                        "GitHub Runner": guard.get("github_runner_service", "Không rõ"),
                        "Giới hạn khởi động": guard.get("wrapper_restarts_last_hour", "Không rõ"),
                        "Giao dịch gửi lệnh": outbound.get("state","Không rõ"),
                        "Mã lỗi giao dịch": outbound.get("last_error_code","Không rõ"),
                        "Đã thử gửi lại": outbound.get("retry_count",0),
                        "Owner STOP": bool(guard.get("owner_stop"))},
            "notes": "Lệnh Bắt đầu/Dừng sẽ chỉ được mở sau khi kiểm thử ràng buộc SOT và an toàn phiên Chrome.",
            "links": [{"title": "GitHub Supervisor", "url": ROBOTS["supervisor"]["repository"]}]}


def saydi_status():
    data = {}
    try:
        with urlopen("http://127.0.0.1:8776/api/status", timeout=1.5) as response:
            data = json.loads(response.read(500000))
    except (OSError, ValueError):
        pass
    st = data.get("status") or {}
    status = st.get("kind", "offline")
    phase = data.get("phase", "Chưa kết nối Media Control")
    pr = data.get("progress") or {}
    qa = data.get("quality") or {}
    active = data.get("processes") or []
    return {
        "status": {"running":"running","done":"done","review":"review","warning":"error","idle":"stopped"}.get(status,"offline"),
        "label": st.get("title", "Không kết nối Media Control"),
        "phase": phase,
        "last_seen": data.get("updated"),
        "processes": active,
        "details": {"Đã render": str(pr.get("render", "—")) + "/" + str(pr.get("total", "—")),
                    "Đã QC": pr.get("qc", "—"), "Đã sửa R2": str(pr.get("repair", "—")) + "/" + str(pr.get("repair_total", "—")),
                    "Cảnh báo QC": qa.get("review", "—"), "ASR nghiêm ngặt": qa.get("strict_review", "—"),
                    "Đang render/QC": "Có" if st.get("active") else "Không"},
        "notes": "Chi tiết sách nói được đọc từ SAYDI Media Control hiện có. QC tự động không thay thế nghe duyệt của Owner.",
        "links": [{"title": "Mở SAYDI Control riêng", "url": "http://127.0.0.1:8776/"},
                  {"title": "GitHub Media Robot", "url": ROBOTS["saydi"]["repository"]}]
    }


def sapo_status():
    procs = running_processes(["diagnostic_runner.py", "magasin_sync", "sapo\\robot.py", "sapo/robot.py"])
    return {"status": "running" if procs else "stopped",
            "label": "Đang có tiến trình" if procs else "Chưa phát hiện tiến trình đồng bộ",
            "phase": "Đang kiểm tra tiến trình" if procs else "Đã dừng / Chờ lịch hoặc Owner",
            "last_seen": ts(), "processes": procs,
            "details": {"Thư mục SAPO": "Có" if SAPO.is_dir() else "Không",
                        "Tiến trình liên quan": len(procs),
                        "Đã đối soát doanh thu": "Chưa xác minh từ dữ liệu nghiệp vụ"},
            "notes": "Không dùng hiện diện tiến trình để kết luận doanh thu đã đồng bộ. Không can thiệp lịch SAPO production.",
            "links": [{"title": "GitHub OPS", "url": ROBOTS["sapo"]["repository"]}]}


def mcp_status():
    hb = read_json(MCP / "state" / "agent-heartbeat.json")
    gateway = read_json(MCP / "state" / "dispatch-gateway.json")
    proc = running_processes(["server.py --transport streamable-http","local_jobs.py","dispatch_gateway.py"])
    islive = False
    try:
        import socket
        with socket.create_connection(("127.0.0.1",8765),timeout=0.25): islive=True
    except OSError:
        pass
    return {"status": "running" if islive else "error",
            "label": "MCP đang kết nối" if islive else "MCP không phản hồi",
            "phase": "GitHub: " + str(gateway.get("github","Không rõ")),
            "last_seen": gateway.get("at"), "processes": proc,
            "details": {"Cổng MCP": "127.0.0.1:8765",
                        "Trạng thái GitHub": gateway.get("github","Không rõ"),
                        "Trạng thái Supabase": gateway.get("supabase","Chưa kết nối"),
                        "PID Local Worker": hb.get("pid","Không rõ")},
            "notes": "Dịch vụ Gateway là hạ tầng nhẹ. Không cho phép Gateway tự bật các robot đang tắt.",
            "links": [{"title": "GitHub Supervisor", "url": ROBOTS["gateway"]["repository"]}]}


def coordinator_status():
    folder = BASE.parent / "robots" / "coordinator"
    state = read_json(folder / "state" / "coordinator-status.json")
    # A valid Owner START only arms read-only monitoring. Actual RUNNING
    # requires a distinct fresh scheduled heartbeat after the START action.
    processes = []
    try:
        import owner_lifecycle
        lifecycle = owner_lifecycle.evaluate()
    except Exception:
        lifecycle = {"status":"BLOCKED_SAFETY", "start_allowed":False,
                     "stop_allowed":False,"blockers":["LIFECYCLE_UNAVAILABLE"]}
    active = lifecycle["status"] == "MONITORING_READ_ONLY"
    plans = state.get("states") or {}
    count = sum(int(v) for v in plans.values() if isinstance(v,int))
    return {
        "status": "running" if active else ("error" if lifecycle["status"] == "BLOCKED_SAFETY" else "stopped"),
        "label": ("Giám sát SOT chỉ đọc" if active else
                  ("Đang chờ lượt kiểm tra mới" if lifecycle["status"] == "ARMED_READ_ONLY" else
                   ("Bị chặn an toàn" if lifecycle["status"] == "BLOCKED_SAFETY" else "Owner STOP"))),
        "phase": "Đã lập " + str(count) + " hồ sơ định tuyến (chưa giao việc)",
        "last_seen": state.get("updated"),
        "processes": processes,
        "details": {
            "Kênh GitHub": read_json(MCP / "state" / "dispatch-gateway.json").get("github", "Chưa rõ"),
            "Kênh Supabase": read_json(MCP / "state" / "dispatch-gateway.json").get("supabase", "Chờ dự án riêng"),
            "Hồ sơ đã phân loại": count,
            "Chờ Owner bật": plans.get("WAIT_OWNER_ENABLE",0),
            "Chờ SOT/adapter": plans.get("WAIT_SOT_VERIFICATION",0),
            "Đã ghi nhận kiểm tra": plans.get("HEALTH_CHECK_DONE",0),
            "Giao nhiệm vụ chuyên môn": "Chưa kích hoạt",
            "Tự sửa / QA": "Chưa triển khai",
            "Chế độ Owner": lifecycle["status"],
            "Kiểm tra SOT": (state.get("sot_preflight") or {}).get("status","Chưa xác minh"),
            "Thực thi nghiệp vụ": "CHƯA ĐỦ ĐIỀU KIỆN"},
        "notes": "START chỉ cấp quyền giám sát SOT đọc-only qua lịch 30 phút hiện có. Không có Business Executor hoặc robot con tự bật; thiếu heartbeat mới phải hiển thị chờ/stale.",
        "links": [{"title":"GitHub Supervisor SOT","url":ROBOTS["coordinator"]["repository"]}],
        "route_plans": state.get("recent", [])[:8],
        "control": {
            "control_ready": lifecycle["status"] != "BLOCKED_SAFETY" or lifecycle.get("stop_allowed",False),
            "start_allowed": lifecycle.get("start_allowed",False),
            "stop_allowed": lifecycle.get("stop_allowed",False),
            "start_blockers": lifecycle.get("blockers",[]),
            "desired": lifecycle.get("desired","STOP"),
            "mode": lifecycle["status"],
            "business_dispatch_enabled": False
        }
    }


PROBES = {"coordinator": coordinator_status, "supervisor": supervisor_status, "saydi": saydi_status,
          "sapo": sapo_status, "gateway": mcp_status}


def detail(robot_id):
    robot = ROBOTS[robot_id].copy()
    robot["id"] = robot_id
    robot["root"] = str(robot["root"])
    robot["organized_folder"] = str(ROBOT_DIR / {"saydi":"saydi-media", "gateway":"mcp-gateway"}.get(robot_id,robot_id))
    robot.update(PROBES[robot_id]())
    robot["controls_ready"] = False
    if robot_id in ("saydi", "sapo"):
        try:
            import specialist_readiness
            raw = {}
            if robot_id == "saydi":
                try:
                    with urlopen("http://127.0.0.1:8776/api/status", timeout=1.5) as response:
                        raw = json.loads(response.read(500000))
                except (OSError, ValueError, UnicodeError):
                    pass
            flags = read_json(ROBOT_DIR / "coordinator" / "config" / "owner_enabled.json")
            proof = specialist_readiness.examine(
                robot_id,
                manifest_path=ROBOT_DIR / ("saydi-media" if robot_id == "saydi" else "sapo") / "robot.json",
                media=raw,
                free_ram_gb=psutil.virtual_memory().available / 1073741824,
                specialist_enabled=flags.get(robot_id),
            )
            robot["control"] = proof
            robot["controls_ready"] = False
        except Exception:
            robot["control"] = {
                "control_ready": False, "start_allowed": False, "stop_allowed": False,
                "start_blockers": ["KHÔNG_ĐỌC_ĐƯỢC_BẰNG_CHỨNG_ĐIỀU_KHIỂN"],
                "recovery_hint": "Giữ OFF; kiểm tra bộ đọc trạng thái local của robot.",
                "business_dispatch_authorized": False,
            }
    if robot_id == "coordinator":
        robot["controls_ready"] = bool(robot["control"].get("control_ready"))
    if robot_id == "supervisor":
        try:
            import control_adapter
            robot["control"] = control_adapter.preflight()
            robot["controls_ready"] = robot["control"]["control_ready"]
        except Exception as exc:
            robot["control"] = {"control_ready": False, "start_allowed":False,
                                "stop_allowed":False, "start_blockers":["Bộ điều khiển lỗi: "+type(exc).__name__]}
    return robot


def status():
    mem = psutil.virtual_memory()
    disk_c = psutil.disk_usage("C:\\")
    disk_d = psutil.disk_usage("D:\\")
    return {"updated": ts(), "hostname": os.environ.get("COMPUTERNAME"),
            "csrf":CONTROL_TOKEN,
            "system": {"cpu_percent": psutil.cpu_percent(interval=0.05),
                       "ram_percent": mem.percent, "ram_free_gb": round(mem.available/1073741824,2),
                       "ram_total_gb": round(mem.total/1073741824,2),
                       "disk_c_free_gb":round(disk_c.free/1073741824,2),
                       "disk_d_free_gb":round(disk_d.free/1073741824,2)},
            "coordinator": detail("coordinator"),
            "robots": [detail(x) for x in ROBOTS if x not in ("gateway","coordinator")],
            "services": [detail("gateway")]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):
        return

    def send_data(self,data,mime="application/json; charset=utf-8",code=200):
        b=data.encode("utf-8") if isinstance(data,str) else data
        self.send_response(code)
        self.send_header("Content-Type",mime)
        self.send_header("Content-Length",str(len(b)))
        self.send_header("Cache-Control","no-store")
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("X-Frame-Options","DENY")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.headers.get("Host","").lower() not in ("127.0.0.1:8781","localhost:8781"):
            return self.send_data('{"error":"local-only"}',code=403)
        p=urlsplit(self.path).path
        try:
            if p=="/healthz":
                return self.send_data("ok",mime="text/plain; charset=utf-8")
            if p=="/api/overview":
                return self.send_data(json.dumps(status(),ensure_ascii=False))
            if p=="/api/monitor":
                return self.send_data(json.dumps(observability.get_monitor(),ensure_ascii=False))
            if p.startswith("/api/robot/"):
                key=p.rsplit("/",1)[-1]
                if key not in ROBOTS:
                    return self.send_data('{"error":"unknown robot"}',code=404)
                return self.send_data(json.dumps(detail(key),ensure_ascii=False))
            if p in ("/","/index.html") or p.startswith("/robot/"):
                return self.send_data((WEB/"index.html").read_bytes(),mime="text/html; charset=utf-8")
            if p=="/app.js":
                return self.send_data((WEB/"app.js").read_bytes(),mime="application/javascript; charset=utf-8")
            if p=="/styles.css":
                return self.send_data((WEB/"styles.css").read_bytes(),mime="text/css; charset=utf-8")
            return self.send_data('{"error":"not-found"}',code=404)
        except Exception as exc:
            return self.send_data(json.dumps({"error":type(exc).__name__}),code=503)

    def do_POST(self):
        host=self.headers.get("Host","").lower()
        origin=self.headers.get("Origin","")
        if host not in ("127.0.0.1:8781","localhost:8781"):
            return self.send_data('{"ok":false,"message":"Local host only"}',code=403)
        # A third-party webpage cannot invoke a robot through browser CSRF.
        if origin != "http://" + host or self.headers.get("Sec-Fetch-Site","same-origin") not in ("same-origin","none"):
            return self.send_data('{"ok":false,"message":"Bad origin"}',code=403)
        if not hmac.compare_digest(self.headers.get("X-MAGASIN-CSRF",""),CONTROL_TOKEN):
            return self.send_data('{"ok":false,"message":"Missing control authorization"}',code=403)
        route=urlsplit(self.path).path
        if route not in ("/api/supervisor/control","/api/coordinator/control"):
            return self.send_data('{"ok":false,"message":"Unsupported robot control"}',code=405)
        if self.headers.get("Content-Type","").split(";")[0] != "application/json":
            return self.send_data('{"ok":false,"message":"Expected JSON"}',code=415)
        try:
            length=int(self.headers.get("Content-Length","0"))
            if length < 2 or length > 250:raise ValueError("Bad payload length")
            value=json.loads(self.rfile.read(length))
            if not isinstance(value,dict) or set(value) != {"action","confirm"}:raise ValueError("Bad payload")
            action=value["action"]
            if action not in ("start","stop"):
                raise ValueError("Unknown action")
            expected = (("START_SUPERVISOR" if action=="start" else "STOP_SUPERVISOR")
                        if route=="/api/supervisor/control" else
                        ("START_COORDINATOR_READ_ONLY" if action=="start" else "STOP_COORDINATOR"))
            if value["confirm"] != expected:
                raise ValueError("Confirmation missing")
        except (ValueError,TypeError,UnicodeDecodeError):
            return self.send_data('{"ok":false,"message":"Invalid command"}',code=400)
        try:
            if route == "/api/coordinator/control":
                import owner_lifecycle
                status_code,response=owner_lifecycle.perform(
                    action, value["confirm"], source="local_control_center")
            else:
                import control_adapter
                status_code,response=control_adapter.perform(action)
            return self.send_data(json.dumps(response,ensure_ascii=False),code=status_code)
        except Exception as exc:
            return self.send_data(json.dumps({"ok":False,"message":"Điều khiển lỗi: "+type(exc).__name__},ensure_ascii=False),code=503)


if __name__=="__main__":
    s=ThreadingHTTPServer((HOST,PORT),Handler)
    s.daemon_threads=True
    s.serve_forever()