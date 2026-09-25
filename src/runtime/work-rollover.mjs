export const WORK_ROLLOVER_SCHEMA_VERSION = "work-rollover.v1";

export const WORK_ROLLOVER_STAGES = Object.freeze({
  FULL_CONFIRMED: "FULL_CONFIRMED",
  INTENT_PERSISTED: "INTENT_PERSISTED",
  BLANK_TARGET_CREATING: "BLANK_TARGET_CREATING",
  TARGET_PERSISTED: "TARGET_PERSISTED",
  DISPATCH_LATCH_PERSISTED: "DISPATCH_LATCH_PERSISTED",
  DISPATCH_CONFIRMED: "DISPATCH_CONFIRMED"
});

const VALID_STAGES = new Set(Object.values(WORK_ROLLOVER_STAGES));
export const WORK_ROLLOVER_REASONS = Object.freeze({
  FULL_CONFIRMED: "FULL_CONFIRMED",
  NO_WORK_TARGET: "NO_WORK_TARGET",
  UNUSABLE_TARGET: "UNUSABLE_TARGET",
  POSSIBLY_STALLED: "POSSIBLY_STALLED",
  IDENTITY_FAILURE: "IDENTITY_FAILURE"
});

const VALID_REASONS = new Set(Object.values(WORK_ROLLOVER_REASONS));

function nonNegativeInteger(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function isoOrNull(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString() === raw ? raw : null;
}

function safeHex(value) {
  const raw = String(value || "").trim();
  return /^[a-f0-9]{16,128}$/i.test(raw) ? raw : null;
}

function safeTaskId(value) {
  const raw = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,191}$/.test(raw) ? raw : null;
}

function cleanEvidence(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, 8);
}

export function normalizeWorkRollover(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!VALID_STAGES.has(value.stage)) return null;
  const taskId = safeTaskId(value.task_id);
  const directiveDigest = safeHex(value.directive_digest);
  if (!taskId || !directiveDigest) return null;

  return {
    schema_version: WORK_ROLLOVER_SCHEMA_VERSION,
    stage: value.stage,
    reason: VALID_REASONS.has(value.reason) ? value.reason : WORK_ROLLOVER_REASONS.FULL_CONFIRMED,
    task_id: taskId,
    directive_digest: directiveDigest,
    directive_instruction_digest: safeHex(value.directive_instruction_digest),
    old_work_generation: nonNegativeInteger(value.old_work_generation),
    old_work_url_revision: nonNegativeInteger(value.old_work_url_revision),
    old_work_target_digest: safeHex(value.old_work_target_digest),
    new_work_generation: nonNegativeInteger(value.new_work_generation),
    new_work_target_digest: safeHex(value.new_work_target_digest),
    dispatch_id: safeHex(value.dispatch_id),
    instruction_digest: safeHex(value.instruction_digest),
    capacity_evidence_codes: cleanEvidence(value.capacity_evidence_codes),
    created_at: isoOrNull(value.created_at),
    intent_persisted_at: isoOrNull(value.intent_persisted_at),
    blank_target_creating_at: isoOrNull(value.blank_target_creating_at),
    target_persisted_at: isoOrNull(value.target_persisted_at),
    dispatch_latch_persisted_at: isoOrNull(value.dispatch_latch_persisted_at),
    dispatch_confirmed_at: isoOrNull(value.dispatch_confirmed_at)
  };
}

export function beginWorkRollover({
  reason = WORK_ROLLOVER_REASONS.FULL_CONFIRMED,
  taskId,
  directiveDigest,
  directiveInstructionDigest = null,
  oldWorkGeneration = 0,
  oldWorkUrlRevision = 0,
  oldWorkTargetDigest = null,
  capacityEvidenceCodes = [],
  at = new Date().toISOString()
} = {}) {
  const state = normalizeWorkRollover({
    stage: reason === WORK_ROLLOVER_REASONS.FULL_CONFIRMED
      ? WORK_ROLLOVER_STAGES.FULL_CONFIRMED
      : WORK_ROLLOVER_STAGES.INTENT_PERSISTED,
    reason,
    task_id: taskId,
    directive_digest: directiveDigest,
    directive_instruction_digest: directiveInstructionDigest,
    old_work_generation: oldWorkGeneration,
    old_work_url_revision: oldWorkUrlRevision,
    old_work_target_digest: oldWorkTargetDigest,
    capacity_evidence_codes: capacityEvidenceCodes,
    created_at: at,
    intent_persisted_at: reason === WORK_ROLLOVER_REASONS.FULL_CONFIRMED ? null : at
  });
  if (!state) throw new Error("invalid Work rollover identity");
  return state;
}

export function rolloverMatchesDirective(state, directive = null) {
  const safe = normalizeWorkRollover(state);
  return Boolean(
    safe &&
    directive &&
    safe.task_id === directive.task_id &&
    safe.directive_digest === directive.digest
  );
}

export function markRolloverIntentPersisted(state, { at = new Date().toISOString() } = {}) {
  const safe = normalizeWorkRollover(state);
  if (!safe || safe.stage !== WORK_ROLLOVER_STAGES.FULL_CONFIRMED) {
    throw new Error("rollover intent requires FULL_CONFIRMED stage");
  }
  safe.stage = WORK_ROLLOVER_STAGES.INTENT_PERSISTED;
  safe.intent_persisted_at = at;
  return safe;
}

export function markBlankTargetCreating(state, { at = new Date().toISOString() } = {}) {
  const safe = normalizeWorkRollover(state);
  if (!safe || ![
    WORK_ROLLOVER_STAGES.INTENT_PERSISTED,
    WORK_ROLLOVER_STAGES.BLANK_TARGET_CREATING
  ].includes(safe.stage)) {
    throw new Error("blank target creation requires persisted rollover intent");
  }
  safe.stage = WORK_ROLLOVER_STAGES.BLANK_TARGET_CREATING;
  if (!safe.blank_target_creating_at) safe.blank_target_creating_at = at;
  return safe;
}

export function markRolloverTargetPersisted(state, {
  newWorkGeneration,
  newWorkTargetDigest,
  at = new Date().toISOString()
} = {}) {
  const safe = normalizeWorkRollover(state);
  if (!safe || safe.stage !== WORK_ROLLOVER_STAGES.BLANK_TARGET_CREATING) {
    throw new Error("target persistence requires BLANK_TARGET_CREATING stage");
  }
  const generation = nonNegativeInteger(newWorkGeneration);
  if (generation !== safe.old_work_generation + 1) {
    throw new Error("rollover generation must increment exactly once");
  }
  const targetDigest = safeHex(newWorkTargetDigest);
  if (!targetDigest) throw new Error("new Work target digest is required");
  safe.stage = WORK_ROLLOVER_STAGES.TARGET_PERSISTED;
  safe.new_work_generation = generation;
  safe.new_work_target_digest = targetDigest;
  safe.target_persisted_at = at;
  return safe;
}

export function markRolloverDispatchLatchPersisted(state, {
  dispatchId,
  instructionDigest,
  at = new Date().toISOString()
} = {}) {
  const safe = normalizeWorkRollover(state);
  if (!safe || safe.stage !== WORK_ROLLOVER_STAGES.TARGET_PERSISTED) {
    throw new Error("dispatch latch requires TARGET_PERSISTED stage");
  }
  const dispatch = safeHex(dispatchId);
  const instruction = safeHex(instructionDigest);
  if (!dispatch || !instruction) {
    throw new Error("dispatch correlation is required");
  }
  safe.stage = WORK_ROLLOVER_STAGES.DISPATCH_LATCH_PERSISTED;
  safe.dispatch_id = dispatch;
  safe.instruction_digest = instruction;
  safe.dispatch_latch_persisted_at = at;
  return safe;
}

export function markRolloverDispatchConfirmed(state, {
  dispatchId,
  at = new Date().toISOString()
} = {}) {
  const safe = normalizeWorkRollover(state);
  if (!safe || safe.stage !== WORK_ROLLOVER_STAGES.DISPATCH_LATCH_PERSISTED) {
    throw new Error("dispatch confirmation requires persisted dispatch latch");
  }
  if (safe.dispatch_id !== dispatchId) {
    throw new Error("dispatch confirmation identity mismatch");
  }
  safe.stage = WORK_ROLLOVER_STAGES.DISPATCH_CONFIRMED;
  safe.dispatch_confirmed_at = at;
  return safe;
}
