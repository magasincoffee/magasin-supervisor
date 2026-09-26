import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  LEGACY_THREE_LANE_CONFIG_FILENAME,
  LEGACY_THREE_LANE_REGISTRY_FILENAME,
  SINGLE_LANE_CONFIG_SCHEMA,
  SINGLE_LANE_MODE,
  SINGLE_LANE_REGISTRY_SCHEMA,
  normalizeSingleLaneConfig,
  normalizeSingleLaneRegistry
} from "./single-lane-state.mjs";

const LEGACY_MODE = "THREE_LANE_V1";
const LEGACY_CONFIG_SCHEMA = "three-lane-config.v1";
const LEGACY_REGISTRY_SCHEMA = "three-lane-registry.v1";
const LANE_IDS = Object.freeze(["lane-1", "lane-2", "lane-3"]);
const LANE_ID_SET = new Set(LANE_IDS);
const WORK_MODES = new Set(["AUTO", "OWNER"]);
const TOPOLOGY_KEYS = new Set(["lanes", "lane_id"]);
const PROCESS_LIVENESS_KEYS = new Set([
  "process_alive",
  "runtime_alive",
  "chrome_alive",
  "cdp_alive",
  "wrapper_alive"
]);
const URL_MAX = 4096;
const PROJECT_NAME_MAX = 180;
const IDENTITY_MAX = 512;
const HEX_ID_RE = /^[a-f0-9]{16,128}$/i;

const CONFIG_LANE_FIELDS = new Set([
  "lane_id",
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

const REGISTRY_LANE_FIELDS = new Set([
  "lane_id",
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

function assertExactFields(value, fields, label) {
  assertPlainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) throw new TypeError(`unsupported ${label} field: ${key}`);
  }
  for (const key of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`${label} missing required field: ${key}`);
    }
  }
}

function assertString(value, label, maxLength = IDENTITY_MAX) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  if (value.length > maxLength) throw new TypeError(`${label} exceeds ${maxLength} characters`);
  return value;
}

function assertNullableString(value, label, maxLength = IDENTITY_MAX) {
  if (value === null) return null;
  return assertString(value, label, maxLength);
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function assertRevision(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function assertIsoOrNull(value, label) {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a canonical UTC ISO8601 string or null`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO8601 string or null`);
  }
  return value;
}

function assertWorkMode(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !WORK_MODES.has(value)) {
    throw new TypeError(`${label} must be AUTO or OWNER${nullable ? " or null" : ""}`);
  }
  return value;
}

function assertLaneId(value, label = "lane selection") {
  if (typeof value !== "string" || !LANE_ID_SET.has(value)) {
    throw new TypeError(`${label} must be explicitly set to lane-1, lane-2, or lane-3`);
  }
  return value;
}

function parseJson(text, label) {
  if (typeof text !== "string") throw new TypeError(`${label} must be UTF-8 JSON text`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TypeError(`${label} is malformed JSON: ${error.message}`);
  }
}

function cloneJsonNoTopology(value, label) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneJsonNoTopology(item, `${label}[${index}]`));
  }
  assertPlainObject(value, label);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (TOPOLOGY_KEYS.has(key)) {
      throw new TypeError(`${label} contains legacy topology field ${key}`);
    }
    if (PROCESS_LIVENESS_KEYS.has(key)) {
      throw new TypeError(`${label} contains forbidden process-liveness authority ${key}`);
    }
    output[key] = cloneJsonNoTopology(item, `${label}.${key}`);
  }
  return output;
}

function cloneObjectOrNull(value, label) {
  if (value === null) return null;
  assertPlainObject(value, label);
  return cloneJsonNoTopology(value, label);
}

function cloneState(value, label, schema) {
  assertPlainObject(value, label);
  if (value.schema_version !== schema) {
    throw new TypeError(`${label}.schema_version must equal ${schema}`);
  }
  return cloneJsonNoTopology(value, label);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function validateLegacyConfigLane(lane, index) {
  const label = `legacy config lane[${index}]`;
  assertExactFields(lane, CONFIG_LANE_FIELDS, label);
  const laneId = assertLaneId(lane.lane_id, `${label}.lane_id`);
  return {
    lane_id: laneId,
    project_name: assertString(lane.project_name, `${label}.project_name`, PROJECT_NAME_MAX),
    brain_url: assertString(lane.brain_url, `${label}.brain_url`, URL_MAX),
    brain_url_revision: assertRevision(lane.brain_url_revision, `${label}.brain_url_revision`),
    work_url: assertString(lane.work_url, `${label}.work_url`, URL_MAX),
    work_url_revision: assertRevision(lane.work_url_revision, `${label}.work_url_revision`),
    work_url_saved_at: assertIsoOrNull(lane.work_url_saved_at, `${label}.work_url_saved_at`),
    work_mode: assertWorkMode(lane.work_mode, `${label}.work_mode`),
    work_state_reset_revision: assertRevision(lane.work_state_reset_revision, `${label}.work_state_reset_revision`),
    relay_retry_rearm_revision: assertRevision(lane.relay_retry_rearm_revision, `${label}.relay_retry_rearm_revision`),
    relay_retry_rearm_requested_at: assertIsoOrNull(lane.relay_retry_rearm_requested_at, `${label}.relay_retry_rearm_requested_at`),
    resume_revision: assertRevision(lane.resume_revision, `${label}.resume_revision`),
    resume_requested_at: assertIsoOrNull(lane.resume_requested_at, `${label}.resume_requested_at`),
    enabled: assertBoolean(lane.enabled, `${label}.enabled`)
  };
}

function validateLegacyRegistryLane(lane, laneId) {
  const label = `legacy registry ${laneId}`;
  assertExactFields(lane, REGISTRY_LANE_FIELDS, label);
  if (lane.lane_id !== laneId) {
    throw new TypeError(`${label}.lane_id conflicts with registry key`);
  }

  const output = {
    lane_id: assertLaneId(lane.lane_id, `${label}.lane_id`),
    brain_url: assertString(lane.brain_url, `${label}.brain_url`, URL_MAX),
    applied_brain_url_revision: assertRevision(lane.applied_brain_url_revision, `${label}.applied_brain_url_revision`),
    work_url: assertString(lane.work_url, `${label}.work_url`, URL_MAX),
    work_generation: assertRevision(lane.work_generation, `${label}.work_generation`),
    applied_work_mode: assertWorkMode(lane.applied_work_mode, `${label}.applied_work_mode`),
    applied_work_saved_at: assertIsoOrNull(lane.applied_work_saved_at, `${label}.applied_work_saved_at`),
    pending_work_url: assertString(lane.pending_work_url, `${label}.pending_work_url`, URL_MAX),
    pending_work_url_revision: assertRevision(lane.pending_work_url_revision, `${label}.pending_work_url_revision`),
    pending_work_saved_at: assertIsoOrNull(lane.pending_work_saved_at, `${label}.pending_work_saved_at`),
    pending_work_mode: assertWorkMode(lane.pending_work_mode, `${label}.pending_work_mode`, { nullable: true }),
    applied_work_state_reset_revision: assertRevision(lane.applied_work_state_reset_revision, `${label}.applied_work_state_reset_revision`),
    applied_work_url_revision: assertRevision(lane.applied_work_url_revision, `${label}.applied_work_url_revision`),
    task_id: assertNullableString(lane.task_id, `${label}.task_id`),
    instruction_digest: assertNullableString(lane.instruction_digest, `${label}.instruction_digest`),
    last_brain_directive_digest: assertNullableString(lane.last_brain_directive_digest, `${label}.last_brain_directive_digest`),
    last_work_result_digest: assertNullableString(lane.last_work_result_digest, `${label}.last_work_result_digest`),
    last_result_relay_id: assertNullableString(lane.last_result_relay_id, `${label}.last_result_relay_id`),
    last_result_verdict: cloneObjectOrNull(lane.last_result_verdict, `${label}.last_result_verdict`),
    last_dispatch_id: assertNullableString(lane.last_dispatch_id, `${label}.last_dispatch_id`),
    dispatch_inflight: cloneObjectOrNull(lane.dispatch_inflight, `${label}.dispatch_inflight`),
    relay_inflight: cloneObjectOrNull(lane.relay_inflight, `${label}.relay_inflight`),
    applied_relay_retry_rearm_revision: assertRevision(lane.applied_relay_retry_rearm_revision, `${label}.applied_relay_retry_rearm_revision`),
    applied_resume_revision: assertRevision(lane.applied_resume_revision, `${label}.applied_resume_revision`),
    brain_resume_recovery_version: assertRevision(lane.brain_resume_recovery_version, `${label}.brain_resume_recovery_version`),
    brain_request_inflight: cloneObjectOrNull(lane.brain_request_inflight, `${label}.brain_request_inflight`),
    brain_request_sent: assertBoolean(lane.brain_request_sent, `${label}.brain_request_sent`),
    project_plan_bootstrap_retries: assertRevision(lane.project_plan_bootstrap_retries, `${label}.project_plan_bootstrap_retries`),
    brain_idle_recheck_retries: assertRevision(lane.brain_idle_recheck_retries, `${label}.brain_idle_recheck_retries`),
    awaiting_work: assertBoolean(lane.awaiting_work, `${label}.awaiting_work`),
    task_timing: cloneState(lane.task_timing, `${label}.task_timing`, "task-timing.v1"),
    project_progress: cloneState(lane.project_progress, `${label}.project_progress`, "project-progress.v1"),
    work_watchdog: cloneState(lane.work_watchdog, `${label}.work_watchdog`, "work-watchdog.v1"),
    work_rollover: lane.work_rollover === null
      ? null
      : cloneState(lane.work_rollover, `${label}.work_rollover`, "work-rollover.v1"),
    brain_target_health: cloneState(lane.brain_target_health, `${label}.brain_target_health`, "target-health.v1"),
    work_target_health: cloneState(lane.work_target_health, `${label}.work_target_health`, "target-health.v1")
  };

  validateRegistryInternalAuthority(output, label);
  return output;
}

function validateConfigRegistryAuthority(config, registry, laneId) {
  const label = `selected ${laneId}`;
  if (registry.applied_brain_url_revision > config.brain_url_revision) {
    throw new TypeError(`${label} applied Brain revision exceeds configured revision`);
  }
  if (
    registry.applied_brain_url_revision === config.brain_url_revision &&
    registry.brain_url !== config.brain_url
  ) {
    throw new TypeError(`${label} Brain identity conflicts at the same revision`);
  }

  if (registry.applied_work_url_revision > config.work_url_revision) {
    throw new TypeError(`${label} applied Work revision exceeds configured revision`);
  }
  if (registry.pending_work_url_revision > config.work_url_revision) {
    throw new TypeError(`${label} pending Work revision exceeds configured revision`);
  }
  if (
    registry.pending_work_url_revision > 0 &&
    registry.pending_work_url_revision <= registry.applied_work_url_revision
  ) {
    throw new TypeError(`${label} pending Work revision must be newer than applied Work revision`);
  }
  if (registry.pending_work_url_revision === 0) {
    if (registry.pending_work_url || registry.pending_work_saved_at !== null || registry.pending_work_mode !== null) {
      throw new TypeError(`${label} has pending Work payload without pending revision authority`);
    }
  } else {
    if (!registry.pending_work_url || registry.pending_work_saved_at === null || registry.pending_work_mode === null) {
      throw new TypeError(`${label} pending Work revision is missing target authority`);
    }
    if (registry.pending_work_url_revision !== config.work_url_revision) {
      throw new TypeError(`${label} pending Work revision does not correlate with configured revision`);
    }
    if (
      registry.pending_work_url !== config.work_url ||
      registry.pending_work_saved_at !== config.work_url_saved_at ||
      registry.pending_work_mode !== config.work_mode
    ) {
      throw new TypeError(`${label} pending Work target conflicts with configured target identity`);
    }
  }

  if (
    config.work_mode === "OWNER" &&
    registry.pending_work_url_revision === 0 &&
    registry.applied_work_url_revision === config.work_url_revision &&
    (registry.work_url !== config.work_url || registry.applied_work_mode !== config.work_mode)
  ) {
    throw new TypeError(`${label} applied Owner Work target conflicts at the same revision`);
  }

  for (const [applied, requested, name] of [
    [registry.applied_work_state_reset_revision, config.work_state_reset_revision, "Work reset"],
    [registry.applied_relay_retry_rearm_revision, config.relay_retry_rearm_revision, "relay rearm"],
    [registry.applied_resume_revision, config.resume_revision, "resume"]
  ]) {
    if (applied > requested) {
      throw new TypeError(`${label} applied ${name} revision exceeds configured revision`);
    }
  }
}

function validateHexIfPresent(value, label) {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || !HEX_ID_RE.test(value)) {
    throw new TypeError(`${label} must be a 16-128 character hex identity`);
  }
}

function validateRegistryInternalAuthority(registry, label) {
  if (registry.work_generation > 0 && !registry.work_url) {
    throw new TypeError(`${label} has Work generation without a Work target`);
  }

  if (registry.dispatch_inflight && registry.relay_inflight) {
    throw new TypeError(`${label} cannot hold dispatch_inflight and relay_inflight simultaneously`);
  }
  if (registry.brain_request_sent && registry.brain_request_inflight) {
    throw new TypeError(`${label} brain request cannot be both sent and inflight`);
  }

  const dispatch = registry.dispatch_inflight;
  if (dispatch) {
    const taskId = assertString(dispatch.task_id, `${label}.dispatch_inflight.task_id`);
    const dispatchId = assertString(dispatch.dispatch_id, `${label}.dispatch_inflight.dispatch_id`);
    assertString(dispatch.instruction_digest, `${label}.dispatch_inflight.instruction_digest`);
    validateHexIfPresent(dispatchId, `${label}.dispatch_inflight.dispatch_id`);
    if (dispatch.work_generation !== undefined) {
      assertRevision(dispatch.work_generation, `${label}.dispatch_inflight.work_generation`);
      if (dispatch.work_generation !== registry.work_generation) {
        throw new TypeError(`${label} dispatch latch Work generation conflicts with active generation`);
      }
    }
    if (dispatch.work_url_revision !== undefined) {
      assertRevision(dispatch.work_url_revision, `${label}.dispatch_inflight.work_url_revision`);
      if (dispatch.work_url_revision !== registry.applied_work_url_revision) {
        throw new TypeError(`${label} dispatch latch Work revision conflicts with active revision`);
      }
    }
    if (dispatch.work_target_digest !== undefined && dispatch.work_target_digest !== null) {
      validateHexIfPresent(dispatch.work_target_digest, `${label}.dispatch_inflight.work_target_digest`);
      if (!registry.work_url || dispatch.work_target_digest !== sha256(registry.work_url)) {
        throw new TypeError(`${label} dispatch latch target digest conflicts with active Work target`);
      }
    }
    if (registry.awaiting_work) {
      throw new TypeError(`${label} cannot await a Work result while a dispatch latch is still inflight`);
    }
    if (registry.last_dispatch_id && registry.last_dispatch_id === dispatchId) {
      throw new TypeError(`${label} inflight dispatch is already recorded as confirmed`);
    }
    if (!taskId) throw new TypeError(`${label} dispatch latch task identity is empty`);
  }

  const relay = registry.relay_inflight;
  if (relay) {
    if (!registry.task_id || !registry.awaiting_work) {
      throw new TypeError(`${label} relay latch requires an active awaiting Work task`);
    }
    const relayId = assertString(relay.relay_id, `${label}.relay_inflight.relay_id`);
    validateHexIfPresent(relayId, `${label}.relay_inflight.relay_id`);
    assertString(relay.response_digest, `${label}.relay_inflight.response_digest`);
    assertString(relay.text_digest, `${label}.relay_inflight.text_digest`);
    if (registry.last_result_relay_id === relayId) {
      throw new TypeError(`${label} inflight relay is already recorded as confirmed`);
    }
  }

  if (registry.awaiting_work) {
    if (!registry.task_id || !registry.last_dispatch_id || !registry.work_url) {
      throw new TypeError(`${label} awaiting Work state is missing task/dispatch/target authority`);
    }
  }
  if (registry.last_result_relay_id && !registry.last_work_result_digest) {
    throw new TypeError(`${label} confirmed relay identity is missing its Work result digest`);
  }

  if (registry.last_result_verdict) {
    const verdict = registry.last_result_verdict;
    const taskId = assertString(verdict.task_id, `${label}.last_result_verdict.task_id`);
    const relayId = assertString(verdict.relay_id, `${label}.last_result_verdict.relay_id`);
    validateHexIfPresent(relayId, `${label}.last_result_verdict.relay_id`);
    if (!taskId) throw new TypeError(`${label}.last_result_verdict.task_id is empty`);
    if (verdict.verdict !== "ACCEPT" && verdict.verdict !== "REJECT") {
      throw new TypeError(`${label}.last_result_verdict.verdict must be ACCEPT or REJECT`);
    }
  }

  if (registry.brain_request_inflight) {
    if (!registry.brain_url) throw new TypeError(`${label} Brain request latch has no Brain target`);
    assertString(registry.brain_request_inflight.digest, `${label}.brain_request_inflight.digest`);
    assertString(registry.brain_request_inflight.marker, `${label}.brain_request_inflight.marker`);
  }

  const timingTaskId = registry.task_timing.task_id;
  if (timingTaskId !== null) {
    const allowedTaskIds = new Set([
      registry.task_id,
      registry.dispatch_inflight?.task_id ?? null
    ].filter(Boolean));
    if (!allowedTaskIds.has(timingTaskId)) {
      throw new TypeError(`${label} task_timing task identity cannot be correlated to durable task authority`);
    }
  }

  const watchdog = registry.work_watchdog;
  if (watchdog.task_id !== null) {
    if (watchdog.task_id !== registry.task_id) {
      throw new TypeError(`${label} watchdog task identity conflicts with active task`);
    }
    if (
      watchdog.work_generation !== registry.work_generation ||
      watchdog.work_url_revision !== registry.applied_work_url_revision
    ) {
      throw new TypeError(`${label} watchdog target identity conflicts with active Work target`);
    }
  }

  if (registry.work_rollover) {
    const rollover = registry.work_rollover;
    const allowedTaskIds = new Set([
      registry.task_id,
      registry.dispatch_inflight?.task_id ?? null
    ].filter(Boolean));
    if (!allowedTaskIds.has(rollover.task_id)) {
      throw new TypeError(`${label} rollover task identity cannot be correlated to durable task authority`);
    }
    if (rollover.old_work_generation > registry.work_generation) {
      throw new TypeError(`${label} rollover old generation exceeds active Work generation`);
    }
    if (rollover.new_work_generation > registry.work_generation) {
      throw new TypeError(`${label} rollover new generation exceeds active Work generation`);
    }
  }

  validateTargetHealth(registry.brain_target_health, {
    role: "BRAIN",
    url: registry.brain_url,
    revision: registry.applied_brain_url_revision,
    generation: 0,
    label: `${label}.brain_target_health`
  });
  validateTargetHealth(registry.work_target_health, {
    role: "WORK",
    url: registry.work_url,
    revision: registry.applied_work_url_revision,
    generation: registry.work_generation,
    label: `${label}.work_target_health`
  });
}

function validateTargetHealth(health, { role, url, revision, generation, label }) {
  if (health.role === null) {
    if (
      health.target_digest !== null ||
      health.target_revision !== 0 ||
      health.work_generation !== 0
    ) {
      throw new TypeError(`${label} has target identity without a target role`);
    }
    return;
  }
  if (health.role !== role) throw new TypeError(`${label}.role conflicts with target role`);
  if (health.target_revision !== revision) {
    throw new TypeError(`${label}.target_revision conflicts with active target revision`);
  }
  if (role === "WORK" && health.work_generation !== generation) {
    throw new TypeError(`${label}.work_generation conflicts with active Work generation`);
  }
  if (role === "BRAIN" && health.work_generation !== 0) {
    throw new TypeError(`${label}.work_generation must be zero for Brain target health`);
  }
  if (health.target_digest !== null) {
    validateHexIfPresent(health.target_digest, `${label}.target_digest`);
    if (!url || health.target_digest !== sha256(url)) {
      throw new TypeError(`${label}.target_digest conflicts with active target`);
    }
  }
}

export function validateLegacyThreeLaneConfig(value) {
  assertExactFields(value, new Set(["schema_version", "mode", "lanes"]), "legacy lanes.json");
  if (value.schema_version !== LEGACY_CONFIG_SCHEMA) {
    throw new TypeError(`legacy lanes.json schema_version must equal ${LEGACY_CONFIG_SCHEMA}`);
  }
  if (value.mode !== LEGACY_MODE) {
    throw new TypeError(`legacy lanes.json mode must equal ${LEGACY_MODE}`);
  }
  if (!Array.isArray(value.lanes) || value.lanes.length !== LANE_IDS.length) {
    throw new TypeError("legacy lanes.json must contain exactly lane-1, lane-2, and lane-3");
  }
  const lanes = value.lanes.map(validateLegacyConfigLane);
  const ids = lanes.map((lane) => lane.lane_id);
  if (new Set(ids).size !== LANE_IDS.length || LANE_IDS.some((laneId) => !ids.includes(laneId))) {
    throw new TypeError("legacy lanes.json has absent or ambiguous lane identities");
  }
  return { schema_version: LEGACY_CONFIG_SCHEMA, mode: LEGACY_MODE, lanes };
}

export function validateLegacyThreeLaneRegistry(value) {
  assertExactFields(value, new Set(["schema_version", "mode", "lanes"]), "legacy lane-registry.json");
  if (value.schema_version !== LEGACY_REGISTRY_SCHEMA) {
    throw new TypeError(`legacy lane-registry.json schema_version must equal ${LEGACY_REGISTRY_SCHEMA}`);
  }
  if (value.mode !== LEGACY_MODE) {
    throw new TypeError(`legacy lane-registry.json mode must equal ${LEGACY_MODE}`);
  }
  assertPlainObject(value.lanes, "legacy lane-registry.json.lanes");
  const keys = Object.keys(value.lanes);
  if (
    keys.length !== LANE_IDS.length ||
    LANE_IDS.some((laneId) => !Object.prototype.hasOwnProperty.call(value.lanes, laneId)) ||
    keys.some((laneId) => !LANE_ID_SET.has(laneId))
  ) {
    throw new TypeError("legacy lane-registry.json must contain exactly lane-1, lane-2, and lane-3");
  }
  const lanes = Object.fromEntries(
    LANE_IDS.map((laneId) => [laneId, validateLegacyRegistryLane(value.lanes[laneId], laneId)])
  );
  return { schema_version: LEGACY_REGISTRY_SCHEMA, mode: LEGACY_MODE, lanes };
}

export function parseLegacyThreeLaneConfig(text) {
  return validateLegacyThreeLaneConfig(parseJson(text, LEGACY_THREE_LANE_CONFIG_FILENAME));
}

export function parseLegacyThreeLaneRegistry(text) {
  return validateLegacyThreeLaneRegistry(parseJson(text, LEGACY_THREE_LANE_REGISTRY_FILENAME));
}

export function migrateLegacyLaneToSingleLane({ legacyConfig, legacyRegistry, laneId } = {}) {
  const selectedLaneId = assertLaneId(laneId);
  const config = validateLegacyThreeLaneConfig(legacyConfig);
  const registry = validateLegacyThreeLaneRegistry(legacyRegistry);
  const selectedConfig = config.lanes.find((lane) => lane.lane_id === selectedLaneId);
  const selectedRegistry = registry.lanes[selectedLaneId];
  if (!selectedConfig || !selectedRegistry) {
    throw new TypeError(`selected ${selectedLaneId} is absent from legacy state`);
  }

  validateConfigRegistryAuthority(selectedConfig, selectedRegistry, selectedLaneId);

  const singleLaneConfig = normalizeSingleLaneConfig({
    schema_version: SINGLE_LANE_CONFIG_SCHEMA,
    mode: SINGLE_LANE_MODE,
    project_name: selectedConfig.project_name,
    brain_url: selectedConfig.brain_url,
    brain_url_revision: selectedConfig.brain_url_revision,
    work_url: selectedConfig.work_url,
    work_url_revision: selectedConfig.work_url_revision,
    work_url_saved_at: selectedConfig.work_url_saved_at,
    work_mode: selectedConfig.work_mode,
    work_state_reset_revision: selectedConfig.work_state_reset_revision,
    relay_retry_rearm_revision: selectedConfig.relay_retry_rearm_revision,
    relay_retry_rearm_requested_at: selectedConfig.relay_retry_rearm_requested_at,
    resume_revision: selectedConfig.resume_revision,
    resume_requested_at: selectedConfig.resume_requested_at,
    enabled: selectedConfig.enabled
  });

  const { lane_id: _legacyLaneId, ...registryFields } = selectedRegistry;
  const singleLaneRegistry = normalizeSingleLaneRegistry({
    schema_version: SINGLE_LANE_REGISTRY_SCHEMA,
    mode: SINGLE_LANE_MODE,
    ...registryFields
  });

  return {
    source_lane_id: selectedLaneId,
    config: singleLaneConfig,
    registry: singleLaneRegistry
  };
}

export function migrateLegacyThreeLaneJson({ configText, registryText, laneId } = {}) {
  return migrateLegacyLaneToSingleLane({
    legacyConfig: parseLegacyThreeLaneConfig(configText),
    legacyRegistry: parseLegacyThreeLaneRegistry(registryText),
    laneId
  });
}

export async function readLegacyThreeLaneState({ root, laneId } = {}) {
  assertLaneId(laneId);
  if (typeof root !== "string" || !root.trim()) {
    throw new TypeError("legacy state root must be an explicit non-empty path");
  }
  const configPath = path.join(root, LEGACY_THREE_LANE_CONFIG_FILENAME);
  const registryPath = path.join(root, LEGACY_THREE_LANE_REGISTRY_FILENAME);
  const [configText, registryText] = await Promise.all([
    fs.readFile(configPath, "utf8"),
    fs.readFile(registryPath, "utf8")
  ]);
  return migrateLegacyThreeLaneJson({ configText, registryText, laneId });
}
