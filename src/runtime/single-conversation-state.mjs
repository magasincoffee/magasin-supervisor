import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { atomicJsonWrite } from "./atomic-json-write.mjs";

export const SINGLE_CONVERSATION_MODE = "SINGLE_CONVERSATION_V1";
export const SINGLE_CONVERSATION_STATE_SCHEMA = "single-conversation-state.v1";

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const MESSAGE_STATES = new Set([
  "NONE",
  "PREPARED",
  "ENQUEUED",
  "DELIVERED",
  "RESPONSE_RUNNING",
  "RESPONSE_COMPLETE",
  "VERIFIED"
]);

function isoNow(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error("invalid timestamp");
  return date.toISOString();
}

function requireProjectId(value) {
  const id = String(value || "LIVE").trim();
  if (!PROJECT_ID_RE.test(id)) throw new Error("invalid project_id");
  return id;
}

export function normalizeSourceOfTruthUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("source_of_truth_url is required");

  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error("source_of_truth_url must be a valid URL", { cause: error });
  }
  if (url.protocol !== "https:") {
    throw new Error("source_of_truth_url must use HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("source_of_truth_url must not contain credentials");
  }
  url.hash = "";
  return url.toString();
}

function blankOutbound() {
  return {
    state: "NONE",
    message_id: null,
    message_digest: null,
    kind: null,
    task_id: null,
    cmd_id: null,
    baseline_user_turn_id: null,
    delivered_user_turn_id: null,
    prepared_at: null,
    enqueued_at: null,
    delivered_at: null,
    response_running_at: null,
    response_complete_at: null,
    verified_at: null,
    retry_count: 0,
    last_error_code: null,
    last_error_stage: null,
    last_pre_actuation_error_code: null,
    last_pre_actuation_error_stage: null
  };
}

function blankExternalWork() {
  return {
    task_id: null,
    checkpoint_id: null,
    repo: null,
    commit_sha: null,
    workflow_run_id: null,
    workflow_name: null,
    workflow_status: null,
    workflow_conclusion: null,
    failure_signature: null,
    failure_count: 0,
    repair_attempt: 0,
    max_repair_attempts: 3,
    last_action: null,
    next_action: null,
    last_progress_at: null,
    owner_required: false,
    decision: null,
    progress_token: null,
    observed_at: null,
    history: [],
    authoritative_sha: null,
    run_authority: "UNKNOWN",
    execution_phase: null,
    current_gate: null,
    gate_started_at: null,
    last_result: null,
    poll_attempt: 0,
    next_check_seconds: 0,
    failure_root_key: null,
    failure_fingerprint: null,
    failure_occurrence_count: 0,
    loop_detected: false,
    last_failure_batch_count: 0,
    last_failure_batch_signature: null,
    last_failure_batch_run_id: null,
    last_failure_batch_commit_sha: null,
    targeted_qa_required: true,
    release_regression_required: true,
    obsolete_runs: []
  };
}

export function createSingleConversationState({
  sourceOfTruthUrl,
  projectId = "LIVE",
  sessionId = randomUUID(),
  now = () => new Date().toISOString()
} = {}) {
  const at = isoNow(now);
  const source = normalizeSourceOfTruthUrl(sourceOfTruthUrl);
  const project = requireProjectId(projectId);
  const session = String(sessionId || "").trim();
  if (!session) throw new Error("session_id is required");

  return {
    schema_version: SINGLE_CONVERSATION_STATE_SCHEMA,
    mode: SINGLE_CONVERSATION_MODE,
    project_id: project,
    session_id: session,
    source_of_truth: {
      url: source,
      last_verified_at: null,
      last_revision: null,
      sync_status: "NEVER"
    },
    conversation: {
      generation: 0,
      status: "NONE",
      runtime_id: null,
      page_id: null,
      created_at: null,
      last_seen_at: null,
      retired_at: null,
      retirement_reason: null
    },
    outbound: blankOutbound(),
    external_work: blankExternalWork(),
    automation: {
      status: "STOPPED",
      reason: null,
      phase: "STOPPED",
      updated_at: at,
      wait_kind: null,
      wait_label: null,
      wait_task_id: null,
      wait_started_at: null,
      wait_until: null,
      wait_seconds_total: 0
    },
    created_at: at,
    updated_at: at
  };
}

function requireNullableString(value, field, max = 500) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!text.trim()) return null;
  if (text.length > max) throw new Error(`${field} is too long`);
  return text;
}

export function assertSingleConversationState(value) {
  if (!value || typeof value !== "object") {
    throw new Error("single-conversation state must be an object");
  }
  if (value.schema_version !== SINGLE_CONVERSATION_STATE_SCHEMA) {
    throw new Error("unsupported single-conversation state schema");
  }
  if (value.mode !== SINGLE_CONVERSATION_MODE) {
    throw new Error("unsupported single-conversation runtime mode");
  }

  value.project_id = requireProjectId(value.project_id);
  value.session_id = requireNullableString(value.session_id, "session_id", 200);
  if (!value.session_id) throw new Error("session_id is required");

  if (!value.source_of_truth || typeof value.source_of_truth !== "object") {
    throw new Error("source_of_truth is required");
  }
  value.source_of_truth.url = normalizeSourceOfTruthUrl(value.source_of_truth.url);
  value.source_of_truth.last_verified_at =
    requireNullableString(value.source_of_truth.last_verified_at, "last_verified_at", 64);
  value.source_of_truth.last_revision =
    requireNullableString(value.source_of_truth.last_revision, "last_revision", 200);
  value.source_of_truth.sync_status = String(
    value.source_of_truth.sync_status || "NEVER"
  ).toUpperCase();
  if (!["NEVER", "SYNCING", "VERIFIED", "FAILED"].includes(value.source_of_truth.sync_status)) {
    throw new Error("invalid source_of_truth.sync_status");
  }

  if (!value.conversation || typeof value.conversation !== "object") {
    throw new Error("conversation state is required");
  }
  const generation = Number(value.conversation.generation);
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error("conversation.generation must be a non-negative integer");
  }
  value.conversation.generation = generation;
  value.conversation.status = String(value.conversation.status || "NONE").toUpperCase();
  if (!["NONE", "CREATING", "ACTIVE", "UNUSABLE", "RETIRED"].includes(value.conversation.status)) {
    throw new Error("invalid conversation.status");
  }
  value.conversation.runtime_id =
    requireNullableString(value.conversation.runtime_id, "conversation.runtime_id", 500);
  value.conversation.page_id =
    requireNullableString(value.conversation.page_id, "conversation.page_id", 500);

  // Durable state intentionally contains no conversation URL. Conversation
  // identity is disposable runtime metadata, not project authority.
  if (
    Object.hasOwn(value.conversation, "url") ||
    Object.hasOwn(value.conversation, "target") ||
    Object.hasOwn(value, "planner") ||
    Object.hasOwn(value, "executor")
  ) {
    throw new Error("persistent conversation targets are forbidden in SINGLE_CONVERSATION_V1");
  }

  if (!value.outbound || typeof value.outbound !== "object") {
    value.outbound = blankOutbound();
  }
  value.outbound.state = String(value.outbound.state || "NONE").toUpperCase();
  if (!MESSAGE_STATES.has(value.outbound.state)) {
    throw new Error("invalid outbound.state");
  }
  value.outbound.message_id =
    requireNullableString(value.outbound.message_id, "outbound.message_id", 200);
  value.outbound.message_digest =
    requireNullableString(value.outbound.message_digest, "outbound.message_digest", 128);
  value.outbound.kind =
    requireNullableString(value.outbound.kind, "outbound.kind", 80);
  value.outbound.task_id =
    requireNullableString(value.outbound.task_id, "outbound.task_id", 120);
  if (value.outbound.task_id && !TASK_ID_RE.test(value.outbound.task_id)) {
    throw new Error("invalid outbound.task_id");
  }
  value.outbound.last_error_stage =
    requireNullableString(value.outbound.last_error_stage, "outbound.last_error_stage", 120);
  value.outbound.last_pre_actuation_error_code =
    requireNullableString(value.outbound.last_pre_actuation_error_code, "outbound.last_pre_actuation_error_code", 120);
  value.outbound.last_pre_actuation_error_stage =
    requireNullableString(value.outbound.last_pre_actuation_error_stage, "outbound.last_pre_actuation_error_stage", 120);
  value.outbound.cmd_id =
    requireNullableString(value.outbound.cmd_id, "outbound.cmd_id", 300);
  value.outbound.baseline_user_turn_id =
    requireNullableString(value.outbound.baseline_user_turn_id, "outbound.baseline_user_turn_id", 500);
  value.outbound.delivered_user_turn_id =
    requireNullableString(value.outbound.delivered_user_turn_id, "outbound.delivered_user_turn_id", 500);
  const retryCount = Number(value.outbound.retry_count || 0);
  if (!Number.isInteger(retryCount) || retryCount < 0) {
    throw new Error("outbound.retry_count must be a non-negative integer");
  }
  value.outbound.retry_count = retryCount;

  if (!value.external_work || typeof value.external_work !== "object") {
    value.external_work = blankExternalWork();
  }
  const external = value.external_work;
  external.task_id =
    requireNullableString(external.task_id, "external_work.task_id", 120);
  if (external.task_id && !TASK_ID_RE.test(external.task_id)) {
    throw new Error("invalid external_work.task_id");
  }
  external.checkpoint_id =
    requireNullableString(external.checkpoint_id, "external_work.checkpoint_id", 120);
  if (external.checkpoint_id && !TASK_ID_RE.test(external.checkpoint_id)) {
    throw new Error("invalid external_work.checkpoint_id");
  }
  external.repo =
    requireNullableString(external.repo, "external_work.repo", 240);
  external.commit_sha =
    requireNullableString(external.commit_sha, "external_work.commit_sha", 80);
  external.workflow_run_id =
    requireNullableString(external.workflow_run_id, "external_work.workflow_run_id", 80);
  external.workflow_name =
    requireNullableString(external.workflow_name, "external_work.workflow_name", 160);
  external.workflow_status =
    requireNullableString(external.workflow_status, "external_work.workflow_status", 80);
  external.workflow_conclusion =
    requireNullableString(external.workflow_conclusion, "external_work.workflow_conclusion", 80);
  external.failure_signature =
    requireNullableString(external.failure_signature, "external_work.failure_signature", 240);
  external.last_action =
    requireNullableString(external.last_action, "external_work.last_action", 160);
  external.next_action =
    requireNullableString(external.next_action, "external_work.next_action", 160);
  external.last_progress_at =
    requireNullableString(external.last_progress_at, "external_work.last_progress_at", 64);
  external.decision =
    requireNullableString(external.decision, "external_work.decision", 80);
  external.progress_token =
    requireNullableString(external.progress_token, "external_work.progress_token", 1000);
  external.observed_at =
    requireNullableString(external.observed_at, "external_work.observed_at", 64);
  external.owner_required = Boolean(external.owner_required);
  const failureCount = Number(external.failure_count || 0);
  if (!Number.isInteger(failureCount) || failureCount < 0 || failureCount > 999) {
    throw new Error("external_work.failure_count must be an integer between 0 and 999");
  }
  external.failure_count = failureCount;
  const repairAttempt = Number(external.repair_attempt || 0);
  if (!Number.isInteger(repairAttempt) || repairAttempt < 0 || repairAttempt > 100) {
    throw new Error("external_work.repair_attempt must be a non-negative integer");
  }
  external.repair_attempt = repairAttempt;
  const maxRepairAttempts = Number(external.max_repair_attempts || 3);
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 1 || maxRepairAttempts > 20) {
    throw new Error("external_work.max_repair_attempts must be an integer between 1 and 20");
  }
  external.max_repair_attempts = maxRepairAttempts;
  if (!Array.isArray(external.history)) external.history = [];
  external.history = external.history.slice(-8).map((item) => ({
    key: requireNullableString(item?.key, "external_work.history.key", 400),
    workflow_run_id: requireNullableString(item?.workflow_run_id, "external_work.history.workflow_run_id", 80),
    commit_sha: requireNullableString(item?.commit_sha, "external_work.history.commit_sha", 80),
    conclusion: requireNullableString(item?.conclusion, "external_work.history.conclusion", 80),
    failure_signature: requireNullableString(item?.failure_signature, "external_work.history.failure_signature", 240),
    observed_at: requireNullableString(item?.observed_at, "external_work.history.observed_at", 64)
  }));

  external.authoritative_sha =
    requireNullableString(external.authoritative_sha, "external_work.authoritative_sha", 80);
  external.run_authority = String(external.run_authority || "UNKNOWN").toUpperCase();
  if (!["UNKNOWN", "AUTHORITATIVE", "OBSOLETE"].includes(external.run_authority)) {
    external.run_authority = "UNKNOWN";
  }
  external.execution_phase =
    requireNullableString(external.execution_phase, "external_work.execution_phase", 80);
  external.current_gate =
    requireNullableString(external.current_gate, "external_work.current_gate", 160);
  external.gate_started_at =
    requireNullableString(external.gate_started_at, "external_work.gate_started_at", 64);
  external.last_result =
    requireNullableString(external.last_result, "external_work.last_result", 80);
  external.failure_root_key =
    requireNullableString(external.failure_root_key, "external_work.failure_root_key", 240);
  external.failure_fingerprint =
    requireNullableString(external.failure_fingerprint, "external_work.failure_fingerprint", 240);
  external.last_failure_batch_signature =
    requireNullableString(external.last_failure_batch_signature, "external_work.last_failure_batch_signature", 240);
  external.last_failure_batch_run_id =
    requireNullableString(external.last_failure_batch_run_id, "external_work.last_failure_batch_run_id", 80);
  external.last_failure_batch_commit_sha =
    requireNullableString(external.last_failure_batch_commit_sha, "external_work.last_failure_batch_commit_sha", 80);
  for (const [field, max] of [
    ["poll_attempt", 999],
    ["next_check_seconds", 3600],
    ["failure_occurrence_count", 999],
    ["last_failure_batch_count", 999]
  ]) {
    const parsed = Number(external[field] || 0);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
      throw new Error(`external_work.${field} must be an integer between 0 and ${max}`);
    }
    external[field] = parsed;
  }
  external.loop_detected = Boolean(external.loop_detected);
  external.targeted_qa_required = external.targeted_qa_required !== false;
  external.release_regression_required = external.release_regression_required !== false;
  if (!Array.isArray(external.obsolete_runs)) external.obsolete_runs = [];
  external.obsolete_runs = external.obsolete_runs.slice(-8).map((item) => ({
    workflow_run_id: requireNullableString(item?.workflow_run_id, "external_work.obsolete_runs.workflow_run_id", 80),
    commit_sha: requireNullableString(item?.commit_sha, "external_work.obsolete_runs.commit_sha", 80),
    workflow_name: requireNullableString(item?.workflow_name, "external_work.obsolete_runs.workflow_name", 160),
    superseded_by_sha: requireNullableString(item?.superseded_by_sha, "external_work.obsolete_runs.superseded_by_sha", 80),
    recorded_at: requireNullableString(item?.recorded_at, "external_work.obsolete_runs.recorded_at", 64)
  }));

  if (!value.automation || typeof value.automation !== "object") {
    throw new Error("automation state is required");
  }
  value.automation.status = String(value.automation.status || "STOPPED").toUpperCase();
  value.automation.phase = String(value.automation.phase || "STOPPED").toUpperCase();
  value.automation.reason =
    requireNullableString(value.automation.reason, "automation.reason", 300);
  value.automation.wait_kind =
    requireNullableString(value.automation.wait_kind, "automation.wait_kind", 80);
  if (value.automation.wait_kind) {
    value.automation.wait_kind = value.automation.wait_kind.toUpperCase();
  }
  value.automation.wait_label =
    requireNullableString(value.automation.wait_label, "automation.wait_label", 240);
  value.automation.wait_task_id =
    requireNullableString(value.automation.wait_task_id, "automation.wait_task_id", 120);
  if (value.automation.wait_task_id && !TASK_ID_RE.test(value.automation.wait_task_id)) {
    throw new Error("invalid automation.wait_task_id");
  }
  value.automation.wait_started_at =
    requireNullableString(value.automation.wait_started_at, "automation.wait_started_at", 64);
  value.automation.wait_until =
    requireNullableString(value.automation.wait_until, "automation.wait_until", 64);
  const waitSecondsTotal = Number(value.automation.wait_seconds_total || 0);
  if (!Number.isInteger(waitSecondsTotal) || waitSecondsTotal < 0 || waitSecondsTotal > 86400) {
    throw new Error("automation.wait_seconds_total must be an integer between 0 and 86400");
  }
  value.automation.wait_seconds_total = waitSecondsTotal;

  return value;
}

export async function writeSingleConversationState(statePath, state, {
  now = () => new Date().toISOString()
} = {}) {
  if (!statePath) throw new Error("statePath is required");
  const normalized = assertSingleConversationState(structuredClone(state));
  normalized.updated_at = isoNow(now);
  await atomicJsonWrite(statePath, normalized);
  return normalized;
}

export async function readSingleConversationState(statePath) {
  if (!statePath) throw new Error("statePath is required");
  const raw = await fs.readFile(statePath, "utf8");
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  return assertSingleConversationState(parsed);
}

export async function ensureSingleConversationState(statePath, {
  sourceOfTruthUrl,
  projectId = "LIVE",
  sessionId,
  now = () => new Date().toISOString()
} = {}) {
  try {
    const existing = await readSingleConversationState(statePath);
    const requestedSource = normalizeSourceOfTruthUrl(sourceOfTruthUrl);
    if (existing.source_of_truth.url !== requestedSource) {
      throw new Error(
        "existing single-conversation state belongs to a different Source of Truth"
      );
    }
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const state = createSingleConversationState({
    sourceOfTruthUrl,
    projectId,
    sessionId,
    now
  });
  return writeSingleConversationState(statePath, state, { now });
}

export async function markSourceOfTruthVerified(statePath, {
  revision = null,
  at = () => new Date().toISOString()
} = {}) {
  const state = await readSingleConversationState(statePath);
  state.source_of_truth.sync_status = "VERIFIED";
  state.source_of_truth.last_verified_at = isoNow(at);
  state.source_of_truth.last_revision =
    revision === null || revision === undefined ? null : String(revision);
  return writeSingleConversationState(statePath, state, { now: at });
}

export async function beginConversationGeneration(statePath, {
  runtimeId = null,
  pageId = null,
  at = () => new Date().toISOString()
} = {}) {
  const state = await readSingleConversationState(statePath);
  const startedAt = isoNow(at);
  state.conversation = {
    generation: state.conversation.generation + 1,
    status: "ACTIVE",
    runtime_id: requireNullableString(runtimeId, "conversation.runtime_id", 500),
    page_id: requireNullableString(pageId, "conversation.page_id", 500),
    created_at: startedAt,
    last_seen_at: startedAt,
    retired_at: null,
    retirement_reason: null
  };
  state.outbound = blankOutbound();
  state.automation.status = "RUNNING";
  state.automation.reason = null;
  state.automation.phase = "SYNC_SOURCE_OF_TRUTH";
  state.automation.updated_at = startedAt;
  return writeSingleConversationState(statePath, state, { now: at });
}

export async function retireConversation(statePath, {
  reason = "REPLACED",
  at = () => new Date().toISOString()
} = {}) {
  const state = await readSingleConversationState(statePath);
  const retiredAt = isoNow(at);
  state.conversation.status = "RETIRED";
  state.conversation.retired_at = retiredAt;
  state.conversation.retirement_reason = String(reason || "REPLACED").slice(0, 200);
  state.conversation.runtime_id = null;
  state.conversation.page_id = null;
  state.automation.phase = "NEW_CHAT";
  state.automation.updated_at = retiredAt;
  return writeSingleConversationState(statePath, state, { now: at });
}
