"""SC-013 watchdog release metadata preflight; NO H4 access or apply capability.

Only assess externally supplied, untrusted read-only metadata. Passing synthetic
metadata is never evidence of field authorization, installation or live repair.
"""
from datetime import datetime, timedelta, timezone
import re

SCHEMA = "SC013_WATCHDOG_RELEASE_PREFLIGHT_V1"
EXPECTED_HOST = "DESKTOP-H4A16IL"
EXPECTED_OLD_SHA256 = "f5d3e369448cf17436e157e42065d00239a00e905ae7437fdabbd84f812dea3f"
SHA40 = re.compile(r"[0-9a-f]{40}\Z")
SHA64 = re.compile(r"[0-9a-f]{64}\Z")


def _utc(value):
    if not isinstance(value, str) or len(value) > 40:
        return None
    if not re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
        r"(?:\.[0-9]{1,7})?(?:Z|[+-][0-9]{2}:[0-9]{2})", value
    ):
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.astimezone(timezone.utc) if result.utcoffset() is not None else None
    except (ValueError, OverflowError):
        return None


def evaluate(evidence, *, pinned_main_sha, now):
    """Pure source-only candidate assessment; ALWAYS require a separate field gate."""
    errors = set()
    if not isinstance(now, datetime) or now.utcoffset() is None:
        errors.add("INVALID_CHECK_TIME")
        now = datetime(1970, 1, 1, tzinfo=timezone.utc)
    else:
        now = now.astimezone(timezone.utc)
    if not isinstance(pinned_main_sha, str) or not SHA40.fullmatch(pinned_main_sha):
        errors.add("INVALID_MAIN_PIN")
    if type(evidence) is not dict:
        evidence = {}
        errors.add("MISSING_EVIDENCE")
    if evidence.get("schema") != SCHEMA or evidence.get("collector") != "H4_READ_ONLY_METADATA":
        errors.add("UNVERIFIED_COLLECTOR")
    if evidence.get("host") != EXPECTED_HOST or evidence.get("state_root_source") != "UserEnvironment":
        errors.add("HOST_OR_ROOT_NOT_ATTESTED")
    observed = _utc(evidence.get("observed_at"))
    if observed is None or not timedelta(0) <= now - observed <= timedelta(minutes=5):
        errors.add("STALE_OR_INVALID_OBSERVATION")
    if evidence.get("main_sha") != pinned_main_sha:
        errors.add("MAIN_DRIFT")
    if evidence.get("old_sha256") != EXPECTED_OLD_SHA256:
        errors.add("INSTALLED_WATCHDOG_CHANGED")
    if type(evidence.get("old_sha256")) is not str or not SHA64.fullmatch(evidence["old_sha256"]):
        errors.add("INVALID_INSTALLED_DIGEST")
    if evidence.get("candidate_file") != "windows/local-watchdog.ps1":
        errors.add("CANDIDATE_SCOPE_MISMATCH")
    if evidence.get("old_file_exists") is not True or evidence.get("old_file_regular_no_reparse") is not True:
        errors.add("LIVE_FILE_IDENTITY_NOT_ATTESTED")
    if evidence.get("owner_stop") is not True or evidence.get("autostart_disabled") is not True:
        errors.add("STOP_LATCH_NOT_ATTESTED")
    if evidence.get("supervisor_status") != "STOPPED":
        errors.add("SUPERVISOR_NOT_STOPPED")
    if evidence.get("watchdog_error") != "The property 'last_error_code' cannot be found on this object. Verify that the property exists.":
        errors.add("DIAGNOSTIC_CHANGED")
    if evidence.get("rollback_on_D_prepared") is not True:
        errors.add("ROLLBACK_PLAN_NOT_VERIFIED")
    if evidence.get("candidate_hash_verified") is not True:
        errors.add("CANDIDATE_NOT_VERIFIED")
    if evidence.get("no_worker_start") is not True or evidence.get("no_latch_change") is not True:
        errors.add("LIFECYCLE_BOUNDARY_NOT_VERIFIED")

    return {
        "schema": SCHEMA,
        "assessment": "SYNTHETIC_METADATA_MATCH" if not errors else "HOLD",
        "reasons": sorted(errors),
        "expected_host": EXPECTED_HOST,
        "expected_changed_file": "windows/local-watchdog.ps1",
        "live_h4_modified": False,
        "live_h4_install_verified": False,
        "field_apply_authorized": False,
        "worker_start_authorized": False,
        "owner_stop_change_authorized": False,
        "sqlite_operation_authorized": False,
        "independent_owner_field_gate_required": True,
    }
