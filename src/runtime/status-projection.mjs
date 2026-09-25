import {
  normalizeTaskTiming,
  taskTimingMetrics
} from "./lane-events.mjs";
import { normalizeWorkWatchdog } from "./work-watchdog.mjs";
import { normalizeWorkRollover } from "./work-rollover.mjs";
import { normalizeTargetHealth } from "./target-health.mjs";
import { normalizeStoredBrainVerdict } from "./brain-planning.mjs";

function safeIso(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString() === String(value) ? String(value) : null;
}

function safeHealth(value) {
  const health = normalizeTargetHealth(value);
  return {
    state: health.state,
    reason_code: health.reason_code
  };
}

function brainDirectiveProjection(registryLane = {}, extra = {}) {
  const explicit = String(extra.brain_directive_state || "").toUpperCase();
  if (["NONE", "IDLE", "WORK", "INVALID"].includes(explicit)) {
    return {
      state: explicit,
      reason_code: explicit === "INVALID"
        ? String(extra.brain_directive_reason_code || "INVALID_DIRECTIVE_FORMAT").toUpperCase()
        : null
    };
  }

  const adoptedAction = String(
    registryLane.brain_directive_adopted?.action || ""
  ).toUpperCase();
  if (adoptedAction === "IDLE" || adoptedAction === "WORK") {
    return { state: adoptedAction, reason_code: null };
  }

  return { state: "NONE", reason_code: null };
}

function operationalPhase({
  status,
  brainHealth,
  workHealth,
  relayExhausted,
  rollover,
  watchdog
}) {
  if (brainHealth.state === "QUARANTINED") return "BRAIN_TARGET_QUARANTINED";
  if (workHealth.state === "QUARANTINED") return "WORK_TARGET_QUARANTINED";
  if (relayExhausted) return "RELAY_EXHAUSTED";
  if (rollover?.stage) return `WORK_ROLLOVER_${rollover.stage}`;
  if (watchdog.phase && watchdog.phase !== "IDLE") return watchdog.phase;
  return String(status || "STARTING").toUpperCase();
}

export function projectLaneOperationalStatus(
  configLane = {},
  registryLane = {},
  status = "STARTING",
  extra = {},
  { now = new Date().toISOString() } = {}
) {
  const timing = normalizeTaskTiming(registryLane.task_timing);
  const metrics = taskTimingMetrics(timing, { now });
  const watchdog = normalizeWorkWatchdog(registryLane.work_watchdog);
  const rollover = normalizeWorkRollover(registryLane.work_rollover);
  const brainHealth = safeHealth(registryLane.brain_target_health);
  const workHealth = safeHealth(registryLane.work_target_health);
  const relay = registryLane.relay_inflight || null;
  const relayExhausted = Boolean(relay?.retry_exhausted);
  const lastVerdict = normalizeStoredBrainVerdict(registryLane.last_result_verdict);
  const requestedRearmRevision = Number(
    configLane.relay_retry_rearm_revision || 0
  );
  const appliedRearmRevision = Number(
    registryLane.applied_relay_retry_rearm_revision || 0
  );
  const brainDirective = brainDirectiveProjection(registryLane, extra);
  const requestedWorkResetRevision = Number(
    configLane.work_state_reset_revision || 0
  );
  const appliedWorkResetRevision = Number(
    registryLane.applied_work_state_reset_revision || 0
  );

  return {
    phase: operationalPhase({
      status,
      brainHealth,
      workHealth,
      relayExhausted,
      rollover,
      watchdog
    }),
    task_elapsed_ms: metrics.total_elapsed_ms,
    task_queue_time_ms: metrics.queue_time_ms,
    task_execution_time_ms: metrics.execution_time_ms,
    assigned_at: timing.assigned_at,
    started_at: timing.started_at,
    last_activity_at: timing.last_activity_at,
    completed_at: timing.completed_at,
    relay_confirmed_at: timing.relay_confirmed_at,
    work_generation: Number(registryLane.work_generation || 0),
    brain_directive_state: brainDirective.state,
    brain_directive_reason_code: brainDirective.reason_code,
    work_reset_requested_revision: requestedWorkResetRevision,
    work_reset_applied_revision: appliedWorkResetRevision,
    configured_work_url_revision: Number(configLane.work_url_revision || 0),
    applied_work_url_revision: Number(
      registryLane.applied_work_url_revision || 0
    ),
    pending_work_url_revision: Number(
      registryLane.pending_work_url_revision || 0
    ),
    work_url_saved_at: safeIso(configLane.work_url_saved_at),
    work_mode: String(
      registryLane.applied_work_mode || configLane.work_mode || "AUTO"
    ).toUpperCase(),
    watchdog_phase: watchdog.phase,
    relay_retry_exhausted: relayExhausted,
    relay_rearm_revision: requestedRearmRevision,
    applied_relay_rearm_revision: appliedRearmRevision,
    relay_rearm_pending: requestedRearmRevision > appliedRearmRevision,
    rollover_phase: rollover?.stage || null,
    brain_target_health: brainHealth,
    work_target_health: workHealth,
    last_result_verdict: lastVerdict
      ? {
          task_id: lastVerdict.task_id,
          relay_id: lastVerdict.relay_id,
          verdict: lastVerdict.verdict,
          reason_code: lastVerdict.reason_code,
          recorded_at: lastVerdict.recorded_at
        }
      : null,
    ...extra
  };
}
