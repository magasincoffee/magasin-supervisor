export const SINGLE_LANE_MODE = "SINGLE_LANE_V3";
export const SINGLE_LANE_CONFIG_SCHEMA = "single-lane-config.v1";
export const SINGLE_LANE_REGISTRY_SCHEMA = "single-lane-registry.v1";
export const SINGLE_LANE_CONFIG_FILENAME = "single-lane-config.json";
export const SINGLE_LANE_REGISTRY_FILENAME = "single-lane-registry.json";

export const LEGACY_THREE_LANE_CONFIG_FILENAME = "lanes.json";
export const LEGACY_THREE_LANE_REGISTRY_FILENAME = "lane-registry.json";

export const SINGLE_LANE_WORK_MODES = Object.freeze({
  AUTO: "AUTO",
  OWNER: "OWNER"
});

const CONFIG_FIELDS = new Set([
  "schema_version",
  "mode",
  "project_name",
  "brain_url",
  "brain_url_revision",
  "work_url",
  "work_url_revision",
  "work_url_saved_at",
  "work_mode",
  "work_state_reset_revision",
  "relay_retry_rearm_revision",
  "relay_retry_rearm_requested_at",
  "resume_revision",
  "resume_requested_at",
  "enabled"
]);

const REGISTRY_FIELDS = new Set([
  "schema_version",
  "mode",
  "brain_url",
  "applied_brain_url_revision",
  "work_url",
  "work_generation",
  "applied_work_mode",
  "applied_work_saved_at",
  "pending_work_url",
  "pending_work_url_revision",
  "pending_work_saved_at",
  "pending_work_mode",
  "applied_work_state_reset_revision",
  "applied_work_url_revision",
  "task_id",
  "instruction_digest",
  "last_brain_directive_digest",
  "last_work_result_digest",
  "last_result_relay_id",
  "last_result_verdict",
  "last_dispatch_id",
  "dispatch_inflight",
  "relay_inflight",
  "applied_relay_retry_rearm_revision",
  "applied_resume_revision",
  "brain_resume_recovery_version",
  "brain_request_inflight",
  "brain_request_sent",
  "project_plan_bootstrap_retries",
  "brain_idle_recheck_retries",
  "awaiting_work",
  "task_timing",
  "project_progress",
  "work_watchdog",
  "work_rollover",
  "brain_target_health",
  "work_target_health"
]);

const VALID_WORK_MODES = new Set(Object.values(SINGLE_LANE_WORK_MODES));
const FORBIDDEN_TOPOLOGY_KEYS = new Set(["lanes", "lane_id"]);
const PROJECT_NAME_MAX = 180;
const URL_MAX = 4096;
const IDENTITY_STRING_MAX = 512;

function assertPlainObject(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertAllowedFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_TOPOLOGY_KEYS.has(key)) {
      throw new TypeError(`${label} contains forbidden legacy topology field: ${key}`);
    }
    if (!allowed.has(key)) {
      throw new TypeError(`unsupported ${label} field: ${key}`);
    }
  }
}

function assertRequiredFields(value, required, label) {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`${label} missing required field: ${key}`);
    }
  }
}

function assertSchema(value, expected, label) {
  if (typeof value !== "string" || value !== expected) {
    throw new TypeError(`${label} must equal ${expected}`);
  }
  return value;
}

function assertMode(value, label = "mode") {
  if (typeof value !== "string" || value !== SINGLE_LANE_MODE) {
    throw new TypeError(`${label} must equal ${SINGLE_LANE_MODE}`);
  }
  return value;
}

function assertString(value, label, maxLength) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  if (value.length > maxLength) {
    throw new TypeError(`${label} exceeds ${maxLength} characters`);
  }
  return value;
}

function assertNullableString(value, label, maxLength = IDENTITY_STRING_MAX) {
  if (value === null) return null;
  return assertString(value, label, maxLength);
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function assertRevision(value, label) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function assertIsoOrNull(value, label) {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be an ISO8601 string or null`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO8601 string or null`);
  }
  return value;
}

function assertWorkMode(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !VALID_WORK_MODES.has(value)) {
    throw new TypeError(
      `${label} must be ${[...VALID_WORK_MODES].join(" or ")}${nullable ? " or null" : ""}`
    );
  }
  return value;
}

function cloneJson(value, label = "state") {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} contains a non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneJson(item, `${label}[${index}]`));
  }
  if (
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must contain JSON-compatible values only`);
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_TOPOLOGY_KEYS.has(key)) {
      throw new TypeError(`${label} contains forbidden legacy topology field: ${key}`);
    }
    output[key] = cloneJson(item, `${label}.${key}`);
  }
  return output;
}

function cloneObjectOrNull(value, label) {
  if (value === null) return null;
  assertPlainObject(value, label);
  return cloneJson(value, label);
}

function cloneGenericState(value, label, expectedSchema) {
  assertPlainObject(value, label);
  if (value.schema_version !== expectedSchema) {
    throw new TypeError(`${label}.schema_version must equal ${expectedSchema}`);
  }
  return cloneJson(value, label);
}

function defaultTaskTiming() {
  return {
    schema_version: "task-timing.v1",
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

function defaultProjectProgress() {
  return {
    schema_version: "project-progress.v1",
    plan_known: false,
    plan_digest: null,
    tasks: [],
    updated_at: null
  };
}

function defaultWorkWatchdog() {
  return {
    schema_version: "work-watchdog.v1",
    task_id: null,
    work_generation: 0,
    work_url_revision: 0,
    phase: "IDLE",
    recovery_epoch: 0,
    reload_count: 0,
    continue_count: 0,
    stall_check_at: null,
    reload_intent_at: null,
    reloaded_at: null,
    last_reload_at: null,
    post_reload_probe_at: null,
    continue_intent_at: null,
    continued_at: null,
    last_continue_at: null,
    post_continue_probe_at: null,
    fresh_progress_at: null,
    rearmed_at: null,
    long_event_emitted_at: null,
    possibly_stalled_at: null
  };
}

function defaultTargetHealth() {
  return {
    schema_version: "target-health.v1",
    state: "UNKNOWN",
    reason_code: "NONE",
    role: null,
    target_digest: null,
    target_revision: 0,
    work_generation: 0,
    first_detected_at: null,
    last_checked_at: null,
    quarantined_at: null
  };
}

export function defaultSingleLaneConfig() {
  return {
    schema_version: SINGLE_LANE_CONFIG_SCHEMA,
    mode: SINGLE_LANE_MODE,
    project_name: "",
    brain_url: "",
    brain_url_revision: 0,
    work_url: "",
    work_url_revision: 0,
    work_url_saved_at: null,
    work_mode: SINGLE_LANE_WORK_MODES.AUTO,
    work_state_reset_revision: 0,
    relay_retry_rearm_revision: 0,
    relay_retry_rearm_requested_at: null,
    resume_revision: 0,
    resume_requested_at: null,
    enabled: false
  };
}

export function normalizeSingleLaneConfig(value = undefined) {
  if (value === undefined || value === null) {
    return defaultSingleLaneConfig();
  }

  assertPlainObject(value, "single-lane config");
  assertAllowedFields(value, CONFIG_FIELDS, "single-lane config");
  assertRequiredFields(value, CONFIG_FIELDS, "single-lane config");

  return {
    schema_version: assertSchema(
      value.schema_version,
      SINGLE_LANE_CONFIG_SCHEMA,
      "single-lane config schema_version"
    ),
    mode: assertMode(value.mode, "single-lane config mode"),
    project_name: assertString(value.project_name, "project_name", PROJECT_NAME_MAX),
    brain_url: assertString(value.brain_url, "brain_url", URL_MAX),
    brain_url_revision: assertRevision(value.brain_url_revision, "brain_url_revision"),
    work_url: assertString(value.work_url, "work_url", URL_MAX),
    work_url_revision: assertRevision(value.work_url_revision, "work_url_revision"),
    work_url_saved_at: assertIsoOrNull(value.work_url_saved_at, "work_url_saved_at"),
    work_mode: assertWorkMode(value.work_mode, "work_mode"),
    work_state_reset_revision: assertRevision(
      value.work_state_reset_revision,
      "work_state_reset_revision"
    ),
    relay_retry_rearm_revision: assertRevision(
      value.relay_retry_rearm_revision,
      "relay_retry_rearm_revision"
    ),
    relay_retry_rearm_requested_at: assertIsoOrNull(
      value.relay_retry_rearm_requested_at,
      "relay_retry_rearm_requested_at"
    ),
    resume_revision: assertRevision(value.resume_revision, "resume_revision"),
    resume_requested_at: assertIsoOrNull(value.resume_requested_at, "resume_requested_at"),
    enabled: assertBoolean(value.enabled, "enabled")
  };
}

export function defaultSingleLaneRegistry() {
  return {
    schema_version: SINGLE_LANE_REGISTRY_SCHEMA,
    mode: SINGLE_LANE_MODE,

    brain_url: "",
    applied_brain_url_revision: 0,

    work_url: "",
    work_generation: 0,
    applied_work_mode: SINGLE_LANE_WORK_MODES.AUTO,
    applied_work_saved_at: null,

    pending_work_url: "",
    pending_work_url_revision: 0,
    pending_work_saved_at: null,
    pending_work_mode: null,

    applied_work_state_reset_revision: 0,
    applied_work_url_revision: 0,

    task_id: null,
    instruction_digest: null,

    last_brain_directive_digest: null,
    last_work_result_digest: null,
    last_result_relay_id: null,
    last_result_verdict: null,
    last_dispatch_id: null,

    dispatch_inflight: null,
    relay_inflight: null,

    applied_relay_retry_rearm_revision: 0,
    applied_resume_revision: 0,

    brain_resume_recovery_version: 1,

    brain_request_inflight: null,
    brain_request_sent: false,

    project_plan_bootstrap_retries: 0,
    brain_idle_recheck_retries: 0,

    awaiting_work: false,

    task_timing: defaultTaskTiming(),
    project_progress: defaultProjectProgress(),
    work_watchdog: defaultWorkWatchdog(),
    work_rollover: null,

    brain_target_health: defaultTargetHealth(),
    work_target_health: defaultTargetHealth()
  };
}

export function normalizeSingleLaneRegistry(value = undefined) {
  if (value === undefined || value === null) {
    return defaultSingleLaneRegistry();
  }

  assertPlainObject(value, "single-lane registry");
  assertAllowedFields(value, REGISTRY_FIELDS, "single-lane registry");
  assertRequiredFields(value, REGISTRY_FIELDS, "single-lane registry");

  return {
    schema_version: assertSchema(
      value.schema_version,
      SINGLE_LANE_REGISTRY_SCHEMA,
      "single-lane registry schema_version"
    ),
    mode: assertMode(value.mode, "single-lane registry mode"),

    brain_url: assertString(value.brain_url, "brain_url", URL_MAX),
    applied_brain_url_revision: assertRevision(
      value.applied_brain_url_revision,
      "applied_brain_url_revision"
    ),

    work_url: assertString(value.work_url, "work_url", URL_MAX),
    work_generation: assertRevision(value.work_generation, "work_generation"),
    applied_work_mode: assertWorkMode(value.applied_work_mode, "applied_work_mode"),
    applied_work_saved_at: assertIsoOrNull(
      value.applied_work_saved_at,
      "applied_work_saved_at"
    ),

    pending_work_url: assertString(value.pending_work_url, "pending_work_url", URL_MAX),
    pending_work_url_revision: assertRevision(
      value.pending_work_url_revision,
      "pending_work_url_revision"
    ),
    pending_work_saved_at: assertIsoOrNull(
      value.pending_work_saved_at,
      "pending_work_saved_at"
    ),
    pending_work_mode: assertWorkMode(
      value.pending_work_mode,
      "pending_work_mode",
      { nullable: true }
    ),

    applied_work_state_reset_revision: assertRevision(
      value.applied_work_state_reset_revision,
      "applied_work_state_reset_revision"
    ),
    applied_work_url_revision: assertRevision(
      value.applied_work_url_revision,
      "applied_work_url_revision"
    ),

    task_id: assertNullableString(value.task_id, "task_id"),
    instruction_digest: assertNullableString(
      value.instruction_digest,
      "instruction_digest"
    ),

    last_brain_directive_digest: assertNullableString(
      value.last_brain_directive_digest,
      "last_brain_directive_digest"
    ),
    last_work_result_digest: assertNullableString(
      value.last_work_result_digest,
      "last_work_result_digest"
    ),
    last_result_relay_id: assertNullableString(
      value.last_result_relay_id,
      "last_result_relay_id"
    ),
    last_result_verdict: cloneObjectOrNull(
      value.last_result_verdict,
      "last_result_verdict"
    ),
    last_dispatch_id: assertNullableString(value.last_dispatch_id, "last_dispatch_id"),

    dispatch_inflight: cloneObjectOrNull(value.dispatch_inflight, "dispatch_inflight"),
    relay_inflight: cloneObjectOrNull(value.relay_inflight, "relay_inflight"),

    applied_relay_retry_rearm_revision: assertRevision(
      value.applied_relay_retry_rearm_revision,
      "applied_relay_retry_rearm_revision"
    ),
    applied_resume_revision: assertRevision(
      value.applied_resume_revision,
      "applied_resume_revision"
    ),

    brain_resume_recovery_version: assertRevision(
      value.brain_resume_recovery_version,
      "brain_resume_recovery_version"
    ),

    brain_request_inflight: cloneObjectOrNull(
      value.brain_request_inflight,
      "brain_request_inflight"
    ),
    brain_request_sent: assertBoolean(value.brain_request_sent, "brain_request_sent"),

    project_plan_bootstrap_retries: assertRevision(
      value.project_plan_bootstrap_retries,
      "project_plan_bootstrap_retries"
    ),
    brain_idle_recheck_retries: assertRevision(
      value.brain_idle_recheck_retries,
      "brain_idle_recheck_retries"
    ),

    awaiting_work: assertBoolean(value.awaiting_work, "awaiting_work"),

    task_timing: cloneGenericState(
      value.task_timing,
      "task_timing",
      "task-timing.v1"
    ),
    project_progress: cloneGenericState(
      value.project_progress,
      "project_progress",
      "project-progress.v1"
    ),
    work_watchdog: cloneGenericState(
      value.work_watchdog,
      "work_watchdog",
      "work-watchdog.v1"
    ),
    work_rollover: value.work_rollover === null
      ? null
      : cloneGenericState(value.work_rollover, "work_rollover", "work-rollover.v1"),

    brain_target_health: cloneGenericState(
      value.brain_target_health,
      "brain_target_health",
      "target-health.v1"
    ),
    work_target_health: cloneGenericState(
      value.work_target_health,
      "work_target_health",
      "target-health.v1"
    )
  };
}
