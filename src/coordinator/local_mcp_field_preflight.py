"""SC-013 source-only metadata preflight, NOT an executable H4 maintenance tool."""
from datetime import datetime, timedelta, timezone
import re

SCHEMA = "SC013_H4_MCP_FIELD_PREFLIGHT_V1"
SOT = "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md"
GATEWAY_SHA = "64d2758fdfbfaa468937f4b91bbe1909103db9a427587bd93854bc1d79f00ba1"
WORKER_SHA = "e8311b84a290532350a83548469d19950dde6e31ae7b6323ead7f8bc6bac754f"
PREFIX = "github:magasincoffee/magasin-supervisor:issue:"
EXPECTED = {
    PREFIX+"339": ("SC-013", "supervisor", "execute_task", "WAIT_SOT_AUTHORITY"),
    PREFIX+"381": ("SC-013", "supervisor", "health_check", "WAIT_OWNER_STOP"),
}
TERMINAL = frozenset(("DONE","FAILED","CANCELLED_STALE"))
INBOX_STATUSES = TERMINAL | {"WAIT_SOT_AUTHORITY","WAIT_OWNER_STOP","QUEUED","READY","RUNNING"}
SHA40 = re.compile(r"[a-f0-9]{40}\Z")
SHA64 = re.compile(r"[a-f0-9]{64}\Z")


def _date(value):
    if not isinstance(value,str) or len(value)>36:
        return None
    try:
        dt=datetime.fromisoformat(value.replace("Z","+00:00"))
        return dt.astimezone(timezone.utc) if dt.utcoffset() is not None else None
    except (ValueError,OverflowError):
        return None


def evaluate(snapshot, *, now, pinned_main_sha):
    """Only classify synthetic/externally supplied data; ALWAYS forbid live apply."""
    errors=set()
    if not isinstance(now,datetime) or now.utcoffset() is None:
        errors.add("UNTRUSTED_OBSERVATION_TIME")
        now=datetime(1970,1,1,tzinfo=timezone.utc)
    else:
        now=now.astimezone(timezone.utc)
    if not isinstance(pinned_main_sha,str) or not SHA40.fullmatch(pinned_main_sha):
        errors.add("BAD_MAIN_PIN")
    if not isinstance(snapshot,dict):
        errors.add("MISSING_EVIDENCE")
        snapshot={}
    if snapshot.get("schema")!=SCHEMA or snapshot.get("collector")!="INDEPENDENT_H4":
        errors.add("UNVERIFIED_EVIDENCE_SOURCE")
    if snapshot.get("host")!="DESKTOP-H4A16IL":
        errors.add("WRONG_MACHINE")
    if snapshot.get("main_sha")!=pinned_main_sha:
        errors.add("MAIN_DRIFT")
    if snapshot.get("gateway_sha")!=GATEWAY_SHA or snapshot.get("worker_sha")!=WORKER_SHA:
        errors.add("SOURCE_HASH_DRIFT")
    if snapshot.get("owner_stop") is not True or snapshot.get("autostart_disabled") is not True:
        errors.add("STOP_UNVERIFIED")
    if snapshot.get("process_ownership_verified") is not True:
        errors.add("PROCESS_OWNER_UNKNOWN")
    pids=snapshot.get("gateway_pids")
    if type(pids) is not list or len(pids)!=2 or any(type(x) is not int or x<=0 for x in pids) or len(set(pids))!=2:
        errors.add("PROCESS_SET_UNVERIFIED")
    observed=_date(snapshot.get("observed_at"))
    if observed is None or not timedelta(0)<=now-observed<=timedelta(minutes=5):
        errors.add("STALE_SNAPSHOT")

    inbox=snapshot.get("inbox")
    jobs=snapshot.get("jobs")
    if (type(inbox) is not list or type(jobs) is not list or
            len(inbox)>25000 or len(jobs)>25000 or snapshot.get("whole_db_read") is not True):
        errors.add("WHOLE_LEDGER_NOT_VERIFIED")
        inbox,jobs=[],[]
    by_id={}
    for entry in inbox:
        if not isinstance(entry,dict) or not isinstance(entry.get("source_id"),str):
            errors.add("BAD_INBOX_ROW")
            continue
        source=entry["source_id"]
        if source in by_id:
            errors.add("DUPLICATE_SOURCE")
        by_id[source]=entry
        if type(entry.get("status")) is not str or entry["status"] not in INBOX_STATUSES:
            errors.add("BAD_INBOX_STATUS")
    pending={key for key,row in by_id.items()
             if isinstance(row.get("status"),str) and row["status"] not in TERMINAL}
    if pending!=set(EXPECTED):
        errors.add("UNEXPECTED_PENDING_REQUEST")
    for source,(task,target,action,status) in EXPECTED.items():
        entry=by_id.get(source)
        if entry is None or (
            entry.get("source"),entry.get("task_id"),entry.get("target"),
            entry.get("action"),entry.get("status"),entry.get("sot_url"),
            entry.get("local_job_id")
        )!=("github",task,target,action,status,SOT,None):
            errors.add("EXPECTED_REQUEST_CHANGED")
            continue
        updated=_date(entry.get("updated_at"))
        if updated is None or not timedelta(days=2)<=now-updated<=timedelta(days=365):
            errors.add("REQUEST_NOT_STALE")
    seen=set()
    for job in jobs:
        if not isinstance(job,dict) or not isinstance(job.get("id"),str) or not job["id"]:
            errors.add("BAD_JOB_ROW")
            continue
        if job["id"] in seen:
            errors.add("DUPLICATE_JOB")
        seen.add(job["id"])
        if job.get("status") not in ("DONE","FAILED"):
            errors.add("NONTERMINAL_OR_UNKNOWN_JOB")
    if snapshot.get("inbox_total")!=len(inbox) or snapshot.get("jobs_total")!=len(jobs):
        errors.add("PARTIAL_LEDGER")
    backup=snapshot.get("backup")
    if not isinstance(backup,dict) or not (
        backup.get("method")=="SQLITE_ONLINE_BACKUP" and
        backup.get("storage")=="D_PROTECTED" and
        backup.get("integrity_ok") is True and
        backup.get("hash_verified") is True and
        backup.get("acl_restricted") is True and
        backup.get("restorable") is True and
        isinstance(backup.get("sha256"),str) and SHA64.fullmatch(backup["sha256"])
    ):
        errors.add("BACKUP_NOT_VERIFIED")
    if snapshot.get("owner_issue_bound_approval") is not True:
        errors.add("OWNER_APPROVAL_NOT_VERIFIED")
    if snapshot.get("rollback_verified") is not True:
        errors.add("ROLLBACK_NOT_VERIFIED")
    if snapshot.get("gateway_ingest_replay_guard") is not True:
        errors.add("REPLAY_RACE_UNVERIFIED")
    return {
        "schema":SCHEMA,
        "assessment":"SYNTHETIC_METADATA_MATCH" if not errors else "HOLD",
        "reasons":sorted(errors),
        "candidate_issues":[339,381],
        "inbox_count":len(inbox),
        "jobs_count":len(jobs),
        "live_h4_inspected":False,
        "live_h4_modified":False,
        "field_apply_authorized":False,
        "business_dispatch_authorized":False,
        "stop_modified":False,
    }
