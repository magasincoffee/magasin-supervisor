export const WORK_WATCHDOG_SCHEMA_VERSION = "work-watchdog.v1";

export const WORK_WATCHDOG_DEFAULTS = Object.freeze({
  longThresholdMs: 25 * 60 * 1000,
  stallThresholdMs: 30 * 60 * 1000,
  inactivityMs: 5 * 60 * 1000,
  reloadCooldownMs: 10 * 60 * 1000,
  reloadBudgetPerEpoch: 1
});

export const WORK_WATCHDOG_PHASES = Object.freeze({
  IDLE: "IDLE",
  WORKING: "WORKING",
  WORKING_LONG: "WORKING_LONG",
  STALL_CHECK: "STALL_CHECK",
  RECOVERY_INTENT: "RECOVERY_INTENT",
  POST_RELOAD: "POST_RELOAD",
  POSSIBLY_STALLED: "POSSIBLY_STALLED"
});

export const WORK_WATCHDOG_DECISIONS = Object.freeze({
  OBSERVE: "OBSERVE",
  WORKING: "WORKING",
  WORKING_LONG: "WORKING_LONG",
  STALL_CHECK: "STALL_CHECK",
  STALL_CHECK_COOLDOWN: "STALL_CHECK_COOLDOWN",
  RELOAD_ELIGIBLE: "RELOAD_ELIGIBLE",
  POST_RELOAD_OBSERVE: "POST_RELOAD_OBSERVE",
  RECOVERY_UNCERTAIN: "RECOVERY_UNCERTAIN",
  POSSIBLY_STALLED: "POSSIBLY_STALLED",
  BLOCKED_OWNER_STOP: "BLOCKED_OWNER_STOP",
  BLOCKED_SECURITY: "BLOCKED_SECURITY",
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH"
});

function asIsoOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value);
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString() === raw ? raw : null;
}

function isoRequired(value, name) {
  const iso = asIsoOrNull(value);
  if (!iso) throw new TypeError(`${name} must be a UTC ISO8601 timestamp`);
  return iso;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function elapsedMs(later, earlier) {
  const a = Date.parse(String(later || ""));
  const b = Date.parse(String(earlier || ""));
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < b) return null;
  return Math.round(a - b);
}

function validPhase(value) {
  return Object.values(WORK_WATCHDOG_PHASES).includes(value)
    ? value
    : WORK_WATCHDOG_PHASES.IDLE;
}

export function defaultWorkWatchdog() {
  return {
    schema_version: WORK_WATCHDOG_SCHEMA_VERSION,
    task_id: null,
    work_generation: 0,
    work_url_revision: 0,
    phase: WORK_WATCHDOG_PHASES.IDLE,
    recovery_epoch: 0,
    reload_count: 0,
    stall_check_at: null,
    reload_intent_at: null,
    reloaded_at: null,
    last_reload_at: null,
    post_reload_probe_at: null,
    fresh_progress_at: null,
    rearmed_at: null,
    long_event_emitted_at: null,
    possibly_stalled_at: null
  };
}

export function normalizeWorkWatchdog(value = null) {
  const safe = defaultWorkWatchdog();
  if (!value || typeof value !== "object" || Array.isArray(value)) return safe;

  safe.task_id = value.task_id ? String(value.task_id) : null;
  safe.work_generation = nonNegativeInteger(value.work_generation);
  safe.work_url_revision = nonNegativeInteger(value.work_url_revision);
  safe.phase = validPhase(value.phase);
  safe.recovery_epoch = nonNegativeInteger(value.recovery_epoch);
  safe.reload_count = Math.min(
    WORK_WATCHDOG_DEFAULTS.reloadBudgetPerEpoch,
    nonNegativeInteger(value.reload_count)
  );

  for (const key of [
    "stall_check_at",
    "reload_intent_at",
    "reloaded_at",
    "last_reload_at",
    "post_reload_probe_at",
    "fresh_progress_at",
    "rearmed_at",
    "long_event_emitted_at",
    "possibly_stalled_at"
  ]) {
    safe[key] = asIsoOrNull(value[key]);
  }
  return safe;
}

function resetForTask({ taskId, workGeneration, workUrlRevision }) {
  const state = defaultWorkWatchdog();
  state.task_id = String(taskId || "") || null;
  state.work_generation = nonNegativeInteger(workGeneration);
  state.work_url_revision = nonNegativeInteger(workUrlRevision);
  return state;
}

function syncIdentity(watchdog, identity) {
  const normalized = normalizeWorkWatchdog(watchdog);
  const taskId = String(identity.taskId || "") || null;
  const generation = nonNegativeInteger(identity.workGeneration);
  const revision = nonNegativeInteger(identity.workUrlRevision);

  if (!normalized.task_id || normalized.task_id !== taskId) {
    return {
      state: resetForTask({
        taskId,
        workGeneration: generation,
        workUrlRevision: revision
      }),
      mismatch: false,
      freshTask: true
    };
  }

  const mismatch =
    normalized.work_generation !== generation ||
    normalized.work_url_revision !== revision;

  return { state: normalized, mismatch, freshTask: false };
}

function result(decision, state, extras = {}) {
  return {
    decision,
    state,
    emit_long_running: false,
    emit_stall_check: false,
    emit_rearmed: false,
    emit_possibly_stalled: false,
    elapsed_ms: null,
    inactivity_ms: null,
    ...extras
  };
}

function markLongEventIfDue(state, now, elapsed, config) {
  if (
    elapsed !== null &&
    elapsed >= config.longThresholdMs &&
    !state.long_event_emitted_at
  ) {
    state.long_event_emitted_at = now;
    return true;
  }
  return false;
}

export function evaluateWorkWatchdog({
  now = new Date().toISOString(),
  awaitingWork = false,
  dispatchConfirmed = false,
  taskId = null,
  workGeneration = 0,
  workUrlRevision = 0,
  timing = null,
  observation = null,
  activityChanged = false,
  ownerStopped = false,
  securityBlocked = false,
  watchdog = null,
  defaults = WORK_WATCHDOG_DEFAULTS
} = {}) {
  const currentAt = isoRequired(now, "now");
  const config = {
    longThresholdMs: Number(defaults.longThresholdMs),
    stallThresholdMs: Number(defaults.stallThresholdMs),
    inactivityMs: Number(defaults.inactivityMs),
    reloadCooldownMs: Number(defaults.reloadCooldownMs),
    reloadBudgetPerEpoch: Number(defaults.reloadBudgetPerEpoch)
  };

  const identity = syncIdentity(watchdog, {
    taskId,
    workGeneration,
    workUrlRevision
  });
  const state = identity.state;

  if (identity.mismatch) {
    return result(WORK_WATCHDOG_DECISIONS.IDENTITY_MISMATCH, state, {
      reason_code: "WATCHDOG_IDENTITY_MISMATCH"
    });
  }

  const startedAt = asIsoOrNull(timing?.started_at);
  const lastActivityAt = asIsoOrNull(timing?.last_activity_at);
  const completedAt = asIsoOrNull(timing?.completed_at);
  const elapsed = startedAt ? elapsedMs(currentAt, startedAt) : null;
  const inactivity = lastActivityAt ? elapsedMs(currentAt, lastActivityAt) : null;
  const responseRunning = Boolean(observation?.response_running);

  if (
    !awaitingWork ||
    !dispatchConfirmed ||
    !startedAt ||
    completedAt
  ) {
    state.phase = WORK_WATCHDOG_PHASES.IDLE;
    return result(WORK_WATCHDOG_DECISIONS.OBSERVE, state, {
      elapsed_ms: elapsed,
      inactivity_ms: inactivity,
      reason_code: !startedAt
        ? "WATCHDOG_STARTED_AT_UNKNOWN"
        : "WATCHDOG_NOT_EXECUTING"
    });
  }

  const emitLong = markLongEventIfDue(state, currentAt, elapsed, config);

  if (ownerStopped) {
    return result(WORK_WATCHDOG_DECISIONS.BLOCKED_OWNER_STOP, state, {
      elapsed_ms: elapsed,
      inactivity_ms: inactivity,
      emit_long_running: emitLong,
      reason_code: "WATCHDOG_OWNER_STOP"
    });
  }

  if (securityBlocked) {
    return result(WORK_WATCHDOG_DECISIONS.BLOCKED_SECURITY, state, {
      elapsed_ms: elapsed,
      inactivity_ms: inactivity,
      emit_long_running: emitLong,
      reason_code: "WATCHDOG_SECURITY_BOUNDARY"
    });
  }

  if (elapsed < config.longThresholdMs) {
    state.phase = WORK_WATCHDOG_PHASES.WORKING;
    return result(WORK_WATCHDOG_DECISIONS.WORKING, state, {
      elapsed_ms: elapsed,
      inactivity_ms: inactivity,
      emit_long_running: emitLong,
      reason_code: "WATCHDOG_BELOW_LONG_THRESHOLD"
    });
  }

  if (
    state.reload_count >= config.reloadBudgetPerEpoch &&
    (activityChanged || responseRunning) &&
    !state.fresh_progress_at
  ) {
    state.fresh_progress_at = currentAt;
  }

  const recoveryAnchor = state.reloaded_at || state.reload_intent_at;
  const cooldownFromLastReload = state.last_reload_at
    ? elapsedMs(currentAt, state.last_reload_at)
    : null;
  const recoveryAge = recoveryAnchor
    ? elapsedMs(currentAt, recoveryAnchor)
    : null;

  if (
    state.reload_count >= config.reloadBudgetPerEpoch &&
    state.fresh_progress_at &&
    state.last_reload_at &&
    cooldownFromLastReload !== null &&
    cooldownFromLastReload >= config.reloadCooldownMs
  ) {
    state.recovery_epoch = Math.max(1, state.recovery_epoch) + 1;
    state.reload_count = 0;
    state.stall_check_at = null;
    state.reload_intent_at = null;
    state.reloaded_at = null;
    state.post_reload_probe_at = null;
    state.fresh_progress_at = null;
    state.possibly_stalled_at = null;
    state.rearmed_at = currentAt;
    state.phase = WORK_WATCHDOG_PHASES.WORKING_LONG;
    return result(WORK_WATCHDOG_DECISIONS.WORKING_LONG, state, {
      elapsed_ms: elapsed,
      inactivity_ms: inactivity,
      emit_long_running: emitLong,
      emit_rearmed: true,
      reason_code: "WATCHDOG_PROGRESS_REARMED"
    });
  }

  if (
    elapsed < config.stallThresholdMs ||
    responseRunning ||
    activityChanged ||
    (inactivity !== null && inactivity < config.inactivityMs)
  ) {
    state.phase = WORK_WATCHDOG_PHASES.WORKING_LONG;
    return result(WORK_WATCHDOG_DECISIONS.WORKING_LONG, state, {
      elapsed_ms: elapsed,
      inactivity_ms: inactivity,
      emit_long_running: emitLong,
      reason_code: responseRunning
        ? "WATCHDOG_RESPONSE_RUNNING"
        : activityChanged
          ? "WATCHDOG_SAFE_PROGRESS"
          : elapsed < config.stallThresholdMs
            ? "WATCHDOG_OBSERVATION_BAND"
            : "WATCHDOG_RECENT_ACTIVITY"
    });
  }

  // Missing legacy activity timestamps are never backfilled or treated as
  // proof of inactivity. Unknown history remains fail-closed observation.
  if (inactivity === null) {
    state.phase = WORK_WATCHDOG_PHASES.WORKING_LONG;
    return result(WORK_WATCHDOG_DECISIONS.WORKING_LONG, state, {
      elapsed_ms: elapsed,
      inactivity_ms: null,
      emit_long_running: emitLong,
      reason_code: "WATCHDOG_ACTIVITY_UNKNOWN"
    });
  }

  if (state.reload_count >= config.reloadBudgetPerEpoch) {
    if (!state.reloaded_at) {
      if (recoveryAge !== null && recoveryAge >= config.inactivityMs) {
        state.phase = WORK_WATCHDOG_PHASES.POSSIBLY_STALLED;
        if (!state.possibly_stalled_at) state.possibly_stalled_at = currentAt;
        return result(WORK_WATCHDOG_DECISIONS.POSSIBLY_STALLED, state, {
          elapsed_ms: elapsed,
          inactivity_ms: inactivity,
          emit_long_running: emitLong,
          emit_possibly_stalled: true,
          reason_code: "WATCHDOG_RELOAD_OUTCOME_UNCERTAIN"
        });
      }
      state.phase = WORK_WATCHDOG_PHASES.RECOVERY_INTENT;
      return result(WORK_WATCHDOG_DECISIONS.RECOVERY_UNCERTAIN, state, {
        elapsed_ms: elapsed,
        inactivity_ms: inactivity,
        emit_long_running: emitLong,
        reason_code: "WATCHDOG_RELOAD_INTENT_PERSISTED"
      });
    }

    if (recoveryAge !== null && recoveryAge < config.inactivityMs) {
      state.phase = WORK_WATCHDOG_PHASES.POST_RELOAD;
      return result(WORK_WATCHDOG_DECISIONS.POST_RELOAD_OBSERVE, state, {
        elapsed_ms: elapsed,
        inactivity_ms: inactivity,
        emit_long_running: emitLong,
        reason_code: "WATCHDOG_POST_RELOAD_WINDOW"
      });
    }

    state.phase = WORK_WATCHDOG_PHASES.POSSIBLY_STALLED;
    const firstTransition = !state.possibly_stalled_at;
    if (firstTransition) state.possibly_stalled_at = currentAt;
    return result(WORK_WATCHDOG_DECISIONS.POSSIBLY_STALLED, state, {
      elapsed_ms: elapsed,
      inactivity_ms: inactivity,
      emit_long_running: emitLong,
      emit_possibly_stalled: firstTransition,
      reason_code: "WATCHDOG_NO_PROGRESS_AFTER_RELOAD"
    });
  }

  if (state.phase !== WORK_WATCHDOG_PHASES.STALL_CHECK) {
    state.phase = WORK_WATCHDOG_PHASES.STALL_CHECK;
    state.recovery_epoch = Math.max(1, state.recovery_epoch);
    state.stall_check_at = currentAt;
    return result(WORK_WATCHDOG_DECISIONS.STALL_CHECK, state, {
      elapsed_ms: elapsed,
      inactivity_ms: inactivity,
      emit_long_running: emitLong,
      emit_stall_check: true,
      reason_code: "WATCHDOG_STALL_ELIGIBLE"
    });
  }

  if (
    state.last_reload_at &&
    cooldownFromLastReload !== null &&
    cooldownFromLastReload < config.reloadCooldownMs
  ) {
    return result(WORK_WATCHDOG_DECISIONS.STALL_CHECK_COOLDOWN, state, {
      elapsed_ms: elapsed,
      inactivity_ms: inactivity,
      emit_long_running: emitLong,
      reason_code: "WATCHDOG_RELOAD_COOLDOWN"
    });
  }

  return result(WORK_WATCHDOG_DECISIONS.RELOAD_ELIGIBLE, state, {
    elapsed_ms: elapsed,
    inactivity_ms: inactivity,
    emit_long_running: emitLong,
    reason_code: "WATCHDOG_RELOAD_ELIGIBLE"
  });
}

export function beginWatchdogReloadIntent(
  watchdog,
  { now = new Date().toISOString() } = {}
) {
  const state = normalizeWorkWatchdog(watchdog);
  if (state.reload_count >= WORK_WATCHDOG_DEFAULTS.reloadBudgetPerEpoch) {
    throw new Error("watchdog reload budget exhausted for current recovery epoch");
  }
  if (state.phase !== WORK_WATCHDOG_PHASES.STALL_CHECK) {
    throw new Error("watchdog reload requires STALL_CHECK phase");
  }

  const timestamp = isoRequired(now, "reload_intent_at");
  state.recovery_epoch = Math.max(1, state.recovery_epoch);
  state.reload_count = 1;
  state.reload_intent_at = timestamp;
  state.reloaded_at = null;
  state.post_reload_probe_at = null;
  state.fresh_progress_at = null;
  state.possibly_stalled_at = null;
  state.phase = WORK_WATCHDOG_PHASES.RECOVERY_INTENT;
  return state;
}

export function markWatchdogReloaded(
  watchdog,
  { now = new Date().toISOString() } = {}
) {
  const state = normalizeWorkWatchdog(watchdog);
  if (state.reload_count < 1 || !state.reload_intent_at) {
    throw new Error("watchdog reload completion requires persisted recovery intent");
  }
  const timestamp = isoRequired(now, "reloaded_at");
  state.reloaded_at = timestamp;
  state.last_reload_at = timestamp;
  state.post_reload_probe_at = null;
  state.phase = WORK_WATCHDOG_PHASES.POST_RELOAD;
  return state;
}

export function markWatchdogPostReloadProbe(
  watchdog,
  { now = new Date().toISOString() } = {}
) {
  const state = normalizeWorkWatchdog(watchdog);
  const timestamp = isoRequired(now, "post_reload_probe_at");
  state.post_reload_probe_at = timestamp;
  return state;
}
