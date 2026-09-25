import fs from "node:fs/promises";
import path from "node:path";

export const LANE_EVENT_SCHEMA_VERSION = "lane-event.v1";
export const TASK_TIMING_SCHEMA_VERSION = "task-timing.v1";
export const WORK_ACTIVITY_EVENT_COALESCE_MS = 30_000;

export const LANE_EVENT_TYPES = Object.freeze({
  BRAIN_TASK_ASSIGNED: "BRAIN_TASK_ASSIGNED",
  WORK_DISPATCH_CONFIRMED: "WORK_DISPATCH_CONFIRMED",
  WORK_STARTED: "WORK_STARTED",
  WORK_ACTIVITY: "WORK_ACTIVITY",
  WORK_COMPLETED: "WORK_COMPLETED",
  RESULT_RELAY_CONFIRMED: "RESULT_RELAY_CONFIRMED",
  BRAIN_RESULT_ACCEPTED: "BRAIN_RESULT_ACCEPTED",
  BRAIN_RESULT_REJECTED: "BRAIN_RESULT_REJECTED",
  WORK_TARGET_SAVED: "WORK_TARGET_SAVED",
  WORK_TARGET_PENDING: "WORK_TARGET_PENDING",
  WORK_TARGET_APPLIED: "WORK_TARGET_APPLIED",
  WORK_LONG_RUNNING: "WORK_LONG_RUNNING",
  WATCHDOG_STALL_CHECK: "WATCHDOG_STALL_CHECK",
  PAGE_RECOVERY_RELOAD: "PAGE_RECOVERY_RELOAD",
  WATCHDOG_CONTINUE_POKE: "WATCHDOG_CONTINUE_POKE",
  WATCHDOG_PROGRESS_REARMED: "WATCHDOG_PROGRESS_REARMED",
  POSSIBLY_STALLED: "POSSIBLY_STALLED",
  RELAY_REARM_APPLIED: "RELAY_REARM_APPLIED",
  RELAY_REARM_DEDUPED: "RELAY_REARM_DEDUPED",
  RELAY_REARM_EXHAUSTED: "RELAY_REARM_EXHAUSTED",
  WORK_FULL_EVIDENCE: "WORK_FULL_EVIDENCE",
  WORK_FULL_CONFIRMED: "WORK_FULL_CONFIRMED",
  WORK_FULL_AMBIGUOUS: "WORK_FULL_AMBIGUOUS",
  WORK_ROLLOVER_INTENT: "WORK_ROLLOVER_INTENT",
  WORK_ROLLOVER_TARGET_PERSISTED: "WORK_ROLLOVER_TARGET_PERSISTED",
  WORK_ROLLOVER_DISPATCH_CONFIRMED: "WORK_ROLLOVER_DISPATCH_CONFIRMED",
  TARGET_QUARANTINED: "TARGET_QUARANTINED",
  TARGET_QUARANTINE_CLEARED: "TARGET_QUARANTINE_CLEARED",
  TARGET_REOPEN_SUPPRESSED: "TARGET_REOPEN_SUPPRESSED",
  RECOVERY: "RECOVERY",
  ERROR: "ERROR"
});

const EVENT_KEYS = new Set([
  "schema_version",
  "timestamp",
  "lane_id",
  "actor",
  "event_type",
  "task_id",
  "phase",
  "reason_code",
  "work_generation",
  "work_url_revision",
  "elapsed_ms",
  "queue_time_ms",
  "execution_time_ms",
  "dispatch_id",
  "relay_id",
  "target_role",
  "target_digest",
  "target_revision"
]);

const ACTORS = new Set(["BRAIN", "WORK", "SUPERVISOR"]);
const PHASES = new Set([
  "ASSIGNED",
  "STARTED",
  "WORKING",
  "COMPLETED",
  "RELAYED",
  "ACCEPTED",
  "REJECTED",
  "SAVED",
  "PENDING",
  "APPLIED",
  "WORKING_LONG",
  "STALL_CHECK",
  "CONTINUE_POKE",
  "POSSIBLY_STALLED",
  "FULL_CONFIRMED",
  "ROLLOVER",
  "RECOVERY",
  "ERROR"
]);
const REASON_CODES = new Set([
  "TURN_COUNT_CHANGED",
  "TURN_ORDINAL_CHANGED",
  "RESPONSE_RUNNING_CHANGED",
  "ASSISTANT_PROGRESS_CHANGED",
  "COMPLETION_STATE_CHANGED",
  "MULTIPLE_SAFE_PROGRESS_SIGNALS",
  "RUNTIME_BOOT",
  "TRANSIENT_NAVIGATION_ERROR",
  "LANE_PROCESSING_ERROR",
  "CDP_RESTART_REQUESTED",
  "EVENT_SINK_WRITE_FAILED",
  "OWNER_WORK_REVISION",
  "ACTIVE_WORK_PRESERVED",
  "SAFE_BOUNDARY",
  "SAME_TARGET_NO_CHURN",
  "CONTINUE_CONTROL_CHANGED",
  "RETRY_CONTROL_CHANGED",
  "WATCHDOG_BELOW_LONG_THRESHOLD",
  "WATCHDOG_OBSERVATION_BAND",
  "WATCHDOG_RESPONSE_RUNNING",
  "WATCHDOG_SAFE_PROGRESS",
  "WATCHDOG_RECENT_ACTIVITY",
  "WATCHDOG_ACTIVITY_UNKNOWN",
  "WATCHDOG_STALL_ELIGIBLE",
  "WATCHDOG_RELOAD_ELIGIBLE",
  "WATCHDOG_RELOAD_COOLDOWN",
  "WATCHDOG_RELOAD_INTENT_PERSISTED",
  "WATCHDOG_POST_RELOAD_WINDOW",
  "WATCHDOG_CONTINUE_ELIGIBLE",
  "WATCHDOG_CONTINUE_INTENT_PERSISTED",
  "WATCHDOG_CONTINUE_SENT",
  "WATCHDOG_CONTINUE_CONTROL_CLICKED",
  "WATCHDOG_POST_CONTINUE_WINDOW",
  "WATCHDOG_NO_PROGRESS_AFTER_CONTINUE",
  "WATCHDOG_CONTINUE_OUTCOME_UNCERTAIN",
  "WATCHDOG_CONTINUE_ACTION_UNCERTAIN",
  "WATCHDOG_NO_PROGRESS_AFTER_RELOAD",
  "WATCHDOG_RELOAD_OUTCOME_UNCERTAIN",
  "WATCHDOG_PROGRESS_REARMED",
  "WATCHDOG_OWNER_STOP",
  "WATCHDOG_SECURITY_BOUNDARY",
  "WATCHDOG_IDENTITY_MISMATCH",
  "WATCHDOG_STARTED_AT_UNKNOWN",
  "WATCHDOG_NOT_EXECUTING",
  "WATCHDOG_DISPATCH_MARKER_MISSING",
  "OWNER_RELAY_REARM",
  "OWNER_RELAY_REARM_DEDUPED",
  "OWNER_RELAY_REARM_EXHAUSTED",
  "EXPLICIT_FULL_LIMIT_UI",
  "COMPOSER_CAPACITY_BLOCKED",
  "SEND_REJECTION_CAPACITY",
  "LEGACY_FULL_TEXT",
  "RESPONSE_RUNNING_GUARD",
  "INCOMPLETE_TURN_GUARD",
  "NETWORK_GUARD",
  "SECURITY_GUARD",
  "TRANSIENT_GUARD",
  "CONVERSATION_MISSING_GUARD",
  "STABLE_IDENTITY_REQUIRED",
  "STABLE_PROBE_REQUIRED",
  "CAPACITY_MULTI_SIGNAL",
  "CAPACITY_AMBIGUOUS",
  "ROLLOVER_INTENT_PERSISTED",
  "ROLLOVER_TARGET_PERSISTED",
  "ROLLOVER_DISPATCH_LATCH_PERSISTED",
  "ROLLOVER_DISPATCH_CONFIRMED",
  "TARGET_CONVERSATION_MISSING",
  "TARGET_CONVERSATION_ACCESS_DENIED",
  "TARGET_STABLE_REDIRECT_AWAY",
  "TARGET_NEW_CANONICAL_IDENTITY",
  "TARGET_QUARANTINED",
  "ACCEPT_DOD_MET",
  "ACCEPT_EVIDENCE_VERIFIED",
  "REJECT_DOD_NOT_MET",
  "REJECT_EVIDENCE_INCOMPLETE",
  "REJECT_CORRECTION_REQUIRED",
  "OWNER_INTERVENTION_REQUIRED"
]);
const EVENT_TYPE_VALUES = new Set(Object.values(LANE_EVENT_TYPES));
const LANE_IDS = new Set(["lane-1", "lane-2", "lane-3"]);
const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:\\/-]{0,191}$/;
const HEX_CORRELATION_RE = /^[a-f0-9]{16,128}$/i;

function asIsoOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value);
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return iso === raw ? iso : null;
}

function isoRequired(value, name) {
  const iso = asIsoOrNull(value);
  if (!iso) throw new TypeError(`${name} must be a UTC ISO8601 timestamp`);
  return iso;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return number;
}

function safeIdentifier(value, name) {
  const raw = String(value || "").trim();
  if (
    !SAFE_IDENTIFIER_RE.test(raw) ||
    raw.includes("..") ||
    raw.includes("//") ||
    raw.includes("://") ||
    /^[A-Za-z]:\//.test(raw)
  ) {
    throw new TypeError(`${name} is not a safe operational identifier`);
  }
  return raw;
}

function correlationIdentifier(value, name) {
  const raw = String(value || "").trim();
  if (!HEX_CORRELATION_RE.test(raw)) {
    throw new TypeError(`${name} must be a deterministic hex correlation id`);
  }
  return raw;
}

export function serializeLaneEvent(input = {}, { now = () => new Date() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("lane event must be an object");
  }

  for (const key of Object.keys(input)) {
    if (!EVENT_KEYS.has(key)) {
      throw new TypeError(`lane event field is not allowlisted: ${key}`);
    }
  }

  if (
    input.schema_version !== undefined &&
    input.schema_version !== LANE_EVENT_SCHEMA_VERSION
  ) {
    throw new TypeError("lane event schema_version is invalid");
  }

  const eventType = String(input.event_type || "").trim();
  if (!EVENT_TYPE_VALUES.has(eventType)) {
    throw new TypeError("lane event_type is not allowlisted");
  }

  const actor = String(input.actor || "").trim();
  if (!ACTORS.has(actor)) {
    throw new TypeError("lane actor is not allowlisted");
  }

  const output = {
    schema_version: LANE_EVENT_SCHEMA_VERSION,
    timestamp: isoRequired(
      input.timestamp || now().toISOString(),
      "timestamp"
    ),
    actor,
    event_type: eventType
  };

  if (input.lane_id !== undefined && input.lane_id !== null) {
    const laneId = String(input.lane_id);
    if (!LANE_IDS.has(laneId)) throw new TypeError("lane_id is invalid");
    output.lane_id = laneId;
  }

  if (input.task_id !== undefined && input.task_id !== null) {
    output.task_id = safeIdentifier(input.task_id, "task_id");
  }

  if (input.phase !== undefined && input.phase !== null) {
    const phase = String(input.phase);
    if (!PHASES.has(phase)) throw new TypeError("phase is not allowlisted");
    output.phase = phase;
  }

  if (input.reason_code !== undefined && input.reason_code !== null) {
    const reasonCode = String(input.reason_code);
    if (!REASON_CODES.has(reasonCode)) {
      throw new TypeError("reason_code is not allowlisted");
    }
    output.reason_code = reasonCode;
  }

  if (input.work_generation !== undefined && input.work_generation !== null) {
    output.work_generation = nonNegativeInteger(
      input.work_generation,
      "work_generation"
    );
  }

  if (input.work_url_revision !== undefined && input.work_url_revision !== null) {
    output.work_url_revision = nonNegativeInteger(
      input.work_url_revision,
      "work_url_revision"
    );
  }

  for (const key of [
    "elapsed_ms",
    "queue_time_ms",
    "execution_time_ms"
  ]) {
    if (input[key] !== undefined && input[key] !== null) {
      output[key] = nonNegativeInteger(input[key], key);
    }
  }

  if (input.dispatch_id !== undefined && input.dispatch_id !== null) {
    output.dispatch_id = correlationIdentifier(
      input.dispatch_id,
      "dispatch_id"
    );
  }

  if (input.relay_id !== undefined && input.relay_id !== null) {
    output.relay_id = correlationIdentifier(input.relay_id, "relay_id");
  }

  if (input.target_role !== undefined && input.target_role !== null) {
    const role = String(input.target_role || "").trim().toUpperCase();
    if (role !== "BRAIN" && role !== "WORK") {
      throw new TypeError("target_role must be BRAIN or WORK");
    }
    output.target_role = role;
  }

  if (input.target_digest !== undefined && input.target_digest !== null) {
    output.target_digest = correlationIdentifier(
      input.target_digest,
      "target_digest"
    );
  }

  if (input.target_revision !== undefined && input.target_revision !== null) {
    output.target_revision = nonNegativeInteger(
      input.target_revision,
      "target_revision"
    );
  }

  return output;
}

export async function appendLaneEvent(
  filePath,
  input,
  {
    mkdir = fs.mkdir,
    appendFile = fs.appendFile,
    now
  } = {}
) {
  const event = serializeLaneEvent(input, now ? { now } : {});
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(event) + "\n", "utf8");
  return event;
}

export function createLaneEventSink({
  filePath,
  append = appendLaneEvent,
  onError = null
} = {}) {
  if (!filePath) throw new TypeError("lane event filePath is required");

  return Object.freeze({
    filePath,
    async emit(input) {
      try {
        const event = await append(filePath, input);
        return { ok: true, event };
      } catch {
        if (typeof onError === "function") {
          await onError({ code: "EVENT_SINK_WRITE_FAILED" }).catch(() => {});
        }
        return { ok: false, code: "EVENT_SINK_WRITE_FAILED" };
      }
    }
  });
}

export function defaultTaskTiming() {
  return {
    schema_version: TASK_TIMING_SCHEMA_VERSION,
    task_id: null,
    directive_digest: null,
    assigned_at: null,
    started_at: null,
    last_activity_at: null,
    completed_at: null,
    relay_confirmed_at: null,
    last_activity_event_at: null,
    last_observation: null
  };
}

function normalizeSafeObservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    user_message_count: Math.max(0, Number(value.user_message_count || 0)),
    assistant_message_count: Math.max(
      0,
      Number(value.assistant_message_count || 0)
    ),
    max_turn_ordinal: Math.max(0, Number(value.max_turn_ordinal || 0)),
    response_running: Boolean(value.response_running),
    response_complete: Boolean(value.response_complete),
    continue_control: Boolean(value.continue_control),
    retry_control: Boolean(value.retry_control),
    last_assistant_char_count: Math.max(
      0,
      Number(value.last_assistant_char_count || 0)
    )
  };
}

export function normalizeTaskTiming(value = null) {
  const safe = defaultTaskTiming();
  if (!value || typeof value !== "object" || Array.isArray(value)) return safe;

  safe.task_id = value.task_id ? String(value.task_id) : null;
  safe.directive_digest = value.directive_digest
    ? String(value.directive_digest)
    : null;
  safe.assigned_at = asIsoOrNull(value.assigned_at);
  safe.started_at = asIsoOrNull(value.started_at);
  safe.last_activity_at = asIsoOrNull(value.last_activity_at);
  safe.completed_at = asIsoOrNull(value.completed_at);
  safe.relay_confirmed_at = asIsoOrNull(value.relay_confirmed_at);
  safe.last_activity_event_at = asIsoOrNull(value.last_activity_event_at);
  safe.last_observation = normalizeSafeObservation(value.last_observation);
  return safe;
}

function setFreshAssignment(timing, { taskId, directiveDigest, at }) {
  timing.schema_version = TASK_TIMING_SCHEMA_VERSION;
  timing.task_id = String(taskId || "") || null;
  timing.directive_digest = String(directiveDigest || "") || null;
  timing.assigned_at = at;
  timing.started_at = null;
  timing.last_activity_at = null;
  timing.completed_at = null;
  timing.relay_confirmed_at = null;
  timing.last_activity_event_at = null;
  timing.last_observation = null;
}

export function beginTaskAssignment(
  timing,
  { taskId, directiveDigest, at = new Date().toISOString() } = {}
) {
  if (!timing || typeof timing !== "object") {
    throw new TypeError("task timing state is required");
  }
  const timestamp = isoRequired(at, "assigned_at");
  const sameAssignment =
    timing.task_id === String(taskId || "") &&
    timing.directive_digest === String(directiveDigest || "");

  if (sameAssignment && timing.assigned_at) {
    return { changed: false, timing };
  }

  setFreshAssignment(timing, { taskId, directiveDigest, at: timestamp });
  return { changed: true, timing };
}

export function markTaskStarted(
  timing,
  {
    taskId,
    directiveDigest = null,
    at = new Date().toISOString()
  } = {}
) {
  if (!timing || typeof timing !== "object") {
    throw new TypeError("task timing state is required");
  }
  if (timing.started_at) return { changed: false, timing };

  const timestamp = isoRequired(at, "started_at");
  if (!timing.task_id) timing.task_id = String(taskId || "") || null;
  if (!timing.directive_digest && directiveDigest) {
    timing.directive_digest = String(directiveDigest);
  }
  timing.started_at = timestamp;
  if (!timing.last_activity_at) timing.last_activity_at = timestamp;
  return { changed: true, timing };
}

export function buildSafeWorkObservation(snapshot = {}, responseComplete = false) {
  return {
    user_message_count: Math.max(0, Number(snapshot.userMessageCount || 0)),
    assistant_message_count: Math.max(
      0,
      Number(snapshot.assistantMessageCount || 0)
    ),
    max_turn_ordinal: Math.max(
      0,
      Number(snapshot.maxConversationTurnOrdinal || 0)
    ),
    response_running: Boolean(snapshot.responseRunning),
    response_complete: Boolean(responseComplete),
    continue_control: Boolean(snapshot.hasContinueControl),
    retry_control: Boolean(snapshot.hasRetryControl),
    last_assistant_char_count: Math.max(
      0,
      Number(snapshot.lastAssistantCharCount || 0)
    )
  };
}

function activitySignals(previous, next) {
  const signals = [];
  if (
    next.user_message_count > previous.user_message_count ||
    next.assistant_message_count > previous.assistant_message_count
  ) {
    signals.push("TURN_COUNT_CHANGED");
  }
  if (next.max_turn_ordinal > previous.max_turn_ordinal) {
    signals.push("TURN_ORDINAL_CHANGED");
  }
  if (next.response_running !== previous.response_running) {
    signals.push("RESPONSE_RUNNING_CHANGED");
  }
  if (!previous.response_complete && next.response_complete) {
    signals.push("COMPLETION_STATE_CHANGED");
  }
  if (next.continue_control !== previous.continue_control) {
    signals.push("CONTINUE_CONTROL_CHANGED");
  }
  if (next.retry_control !== previous.retry_control) {
    signals.push("RETRY_CONTROL_CHANGED");
  }
  if (
    next.last_assistant_char_count >
    previous.last_assistant_char_count
  ) {
    signals.push("ASSISTANT_PROGRESS_CHANGED");
  }
  return [...new Set(signals)];
}

export function observeWorkActivity(
  timing,
  observation,
  {
    at = new Date().toISOString(),
    coalesceMs = WORK_ACTIVITY_EVENT_COALESCE_MS
  } = {}
) {
  if (!timing || typeof timing !== "object") {
    throw new TypeError("task timing state is required");
  }
  const next = normalizeSafeObservation(observation);
  if (!next) throw new TypeError("safe Work observation is required");

  if (!timing.last_observation) {
    timing.last_observation = next;
    return {
      changed: false,
      baseline_initialized: true,
      event_due: false,
      reason_code: null,
      timing
    };
  }

  const signals = activitySignals(timing.last_observation, next);
  timing.last_observation = next;
  if (!signals.length) {
    return {
      changed: false,
      baseline_initialized: false,
      event_due: false,
      reason_code: null,
      timing
    };
  }

  const timestamp = isoRequired(at, "last_activity_at");
  timing.last_activity_at = timestamp;

  const structural = signals.some((signal) =>
    signal !== "ASSISTANT_PROGRESS_CHANGED"
  );
  const previousEventAt = Date.parse(
    String(timing.last_activity_event_at || "")
  );
  const currentAt = Date.parse(timestamp);
  const cooldownElapsed =
    !Number.isFinite(previousEventAt) ||
    currentAt - previousEventAt >= Math.max(0, Number(coalesceMs || 0));
  const eventDue = structural || cooldownElapsed;

  if (eventDue) timing.last_activity_event_at = timestamp;

  return {
    changed: true,
    baseline_initialized: false,
    event_due: eventDue,
    reason_code:
      signals.length === 1
        ? signals[0]
        : "MULTIPLE_SAFE_PROGRESS_SIGNALS",
    timing
  };
}

export function markTaskCompleted(
  timing,
  { taskId, at = new Date().toISOString() } = {}
) {
  if (!timing || typeof timing !== "object") {
    throw new TypeError("task timing state is required");
  }
  if (timing.completed_at) return { changed: false, timing };
  const timestamp = isoRequired(at, "completed_at");
  if (!timing.task_id) timing.task_id = String(taskId || "") || null;
  timing.completed_at = timestamp;
  timing.last_activity_at = timestamp;
  return { changed: true, timing };
}

export function markRelayConfirmed(
  timing,
  { taskId, at = new Date().toISOString() } = {}
) {
  if (!timing || typeof timing !== "object") {
    throw new TypeError("task timing state is required");
  }
  if (timing.relay_confirmed_at) return { changed: false, timing };
  const timestamp = isoRequired(at, "relay_confirmed_at");
  if (!timing.task_id) timing.task_id = String(taskId || "") || null;
  timing.relay_confirmed_at = timestamp;
  return { changed: true, timing };
}

function diffMs(later, earlier) {
  const a = Date.parse(String(later || ""));
  const b = Date.parse(String(earlier || ""));
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < b) return null;
  return Math.round(a - b);
}

export function taskTimingMetrics(
  timing,
  { now = new Date().toISOString() } = {}
) {
  const current = normalizeTaskTiming(timing);
  const queueTimeMs = diffMs(current.started_at, current.assigned_at);
  const executionTimeMs = diffMs(current.completed_at, current.started_at);
  const totalEnd = current.completed_at || asIsoOrNull(now);
  const totalElapsedMs = diffMs(totalEnd, current.assigned_at);

  return {
    queue_time_ms: queueTimeMs,
    execution_time_ms: executionTimeMs,
    total_elapsed_ms: totalElapsedMs
  };
}
