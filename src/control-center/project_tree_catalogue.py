# MPC-004: read-only, allowlisted catalogue from checked-out subordinate SOT.
# This is navigation only: every scope status remains UNKNOWN until MPC-005 proof.
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLAN = ROOT / "docs" / "project-control" / "MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md"
SUPERVISOR_SOT = "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md"
PLAN_URL = "https://github.com/magasincoffee/magasin-supervisor/blob/main/docs/project-control/MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md"
WORKFORCE_SOT = "https://github.com/magasincoffee/magasincoffee.github.io/blob/main/01_DOCS/MAGASIN/05_SYSTEM/WORKFORCE_CROSS_STORE_SCHEDULING_TEMP_SOURCE_OF_TRUTH.md"
PRINT_OPS_SOT = "https://github.com/magasincoffee/OPS-WebApp/blob/main/SOURCE_OF_TRUTH.md"
TASK_LINE = re.compile(r"^\|\s*(MPC-0(?:0[1-9]|10))(?:\s+\([^|]*\))?\s*\|[^|]*\|\s*([^|]+?)\s*\|", re.MULTILINE)


def read_only_project_catalogue(plan_path: Path = PLAN) -> dict:
    """Never derive VERIFIED_DONE or Owner authorization from local checkout text."""
    features = []
    try:
        data = plan_path.read_text(encoding="utf-8")
        tasks = [
            {"id": task_id, "title": title.strip(), "scopeStatus": "UNKNOWN",
             "sourceUrl": PLAN_URL}
            for task_id, title in TASK_LINE.findall(data)
        ]
        if tasks and len({t["id"] for t in tasks}) == len(tasks):
            features = [{
                "id": "project-control", "title": "MAGASIN PROJECT CONTROL",
                "scopeStatus": "UNKNOWN", "sourceUrl": PLAN_URL, "tasks": tasks,
            }]
    except (OSError, UnicodeError):
        pass
    return {
        "schemaVersion": "magasin-project-tree-navigation.v1",
        "status": "LOCAL_UNVERIFIED", "readOnly": True,
        "projectSwitchAllowed": False, "businessDispatchAllowed": False,
        "projects": [
            {"id": "supervisor", "title": "Supervisor & Control Center",
             "scopeStatus": "UNKNOWN", "sourceUrl": SUPERVISOR_SOT,
             "features": features},
            {"id": "workforce", "title": "MAGASIN Coffee · Lịch làm việc",
             "scopeStatus": "UNKNOWN", "sourceUrl": WORKFORCE_SOT,
             "features": []},
            {"id": "print-ops", "title": "MAGASIN CUP · OPS xưởng in",
             "scopeStatus": "UNKNOWN", "sourceUrl": PRINT_OPS_SOT,
             "features": []},
        ],
    }
