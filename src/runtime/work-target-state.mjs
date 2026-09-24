export const WORK_TARGET_MODES = Object.freeze({
  OWNER: "OWNER",
  AUTO: "AUTO"
});

function nonNegativeRevision(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function optionalTimestamp(value) {
  const raw = String(value || "").trim();
  return raw || null;
}

export function normalizeWorkTargetMode(value, url = "") {
  const mode = String(value || "").trim().toUpperCase();
  if (mode === WORK_TARGET_MODES.OWNER || mode === WORK_TARGET_MODES.AUTO) {
    return mode;
  }
  return String(url || "").trim()
    ? WORK_TARGET_MODES.OWNER
    : WORK_TARGET_MODES.AUTO;
}

export function resolveWorkTargetPolicy(lane = {}) {
  const url = String(lane.work_url || "").trim();
  const mode = normalizeWorkTargetMode(lane.applied_work_mode, url);
  if (mode === WORK_TARGET_MODES.OWNER) {
    return Object.freeze({
      mode,
      work_url: url,
      has_usable_configured_target: Boolean(url),
      auto_create_allowed: false,
      reason_code: url ? "OWNER_PINNED_TARGET" : "OWNER_WORK_TARGET_REQUIRED"
    });
  }
  return Object.freeze({
    mode,
    work_url: url,
    has_usable_configured_target: Boolean(url),
    auto_create_allowed: !url,
    reason_code: url ? "AUTO_PERSISTED_TARGET_REUSE" : "AUTO_WORK_CREATE_REQUIRED"
  });
}

export function normalizeWorkTargetIntent(value = {}) {
  const rawUrl = String(value.url || "").trim();
  const mode = normalizeWorkTargetMode(value.mode, rawUrl);
  return Object.freeze({
    url: mode === WORK_TARGET_MODES.AUTO ? "" : rawUrl,
    mode,
    revision: nonNegativeRevision(value.revision),
    saved_at: optionalTimestamp(value.saved_at)
  });
}

export function hasActiveWorkTransaction(lane = {}) {
  const timing = lane?.task_timing || {};
  const completedResultNotRelayed = Boolean(
    timing.completed_at &&
    !timing.relay_confirmed_at &&
    !lane?.last_result_relay_id
  );
  return Boolean(
    lane?.awaiting_work ||
    lane?.dispatch_inflight ||
    lane?.relay_inflight ||
    completedResultNotRelayed
  );
}

function currentTarget(lane = {}) {
  const url = String(lane.work_url || "").trim();
  return {
    url,
    mode: normalizeWorkTargetMode(lane.applied_work_mode, url)
  };
}

function clearPending(lane) {
  lane.pending_work_url = "";
  lane.pending_work_url_revision = 0;
  lane.pending_work_saved_at = null;
  lane.pending_work_mode = null;
}

function applyIntent(lane, intent) {
  const before = currentTarget(lane);
  const targetChanged =
    before.url !== intent.url ||
    before.mode !== intent.mode;

  lane.work_url = intent.url;
  lane.applied_work_mode = intent.mode;
  lane.applied_work_url_revision = intent.revision;
  lane.applied_work_saved_at = intent.saved_at;

  // work_generation identifies an actual Work conversation generation.
  // OWNER -> a different concrete conversation changes generation now.
  // AUTO -> no concrete conversation exists yet; dispatch creation advances
  // generation when ChatGPT returns the canonical Work URL.
  let generationChanged = false;
  if (targetChanged && intent.mode === WORK_TARGET_MODES.OWNER) {
    lane.work_generation = Number(lane.work_generation || 0) + 1;
    generationChanged = true;
  }

  clearPending(lane);
  return {
    status: "APPLIED",
    revision: intent.revision,
    mode: intent.mode,
    target_changed: targetChanged,
    generation_changed: generationChanged
  };
}

export function acceptOwnerWorkTargetRevision(lane, value = {}) {
  const intent = normalizeWorkTargetIntent(value);
  const appliedRevision = nonNegativeRevision(lane.applied_work_url_revision);
  const pendingRevision = nonNegativeRevision(lane.pending_work_url_revision);

  if (intent.revision <= Math.max(appliedRevision, pendingRevision)) {
    return {
      status: "NOOP",
      revision: intent.revision,
      mode: intent.mode,
      target_changed: false,
      generation_changed: false
    };
  }

  const before = currentTarget(lane);
  const sameAsCurrent =
    before.url === intent.url &&
    before.mode === intent.mode;

  // A newer revision that resolves to the current canonical target is only an
  // acknowledgement. It may cancel an older pending target but must not churn
  // generation or task/latch state.
  if (sameAsCurrent) {
    lane.applied_work_mode = intent.mode;
    lane.applied_work_url_revision = intent.revision;
    lane.applied_work_saved_at = intent.saved_at;
    clearPending(lane);
    return {
      status: "ACKNOWLEDGED",
      revision: intent.revision,
      mode: intent.mode,
      target_changed: false,
      generation_changed: false
    };
  }

  if (hasActiveWorkTransaction(lane)) {
    lane.pending_work_url = intent.url;
    lane.pending_work_url_revision = intent.revision;
    lane.pending_work_saved_at = intent.saved_at;
    lane.pending_work_mode = intent.mode;
    return {
      status: "PENDING",
      revision: intent.revision,
      mode: intent.mode,
      target_changed: false,
      generation_changed: false
    };
  }

  return applyIntent(lane, intent);
}

export function applyPendingWorkTargetIfSafe(lane) {
  const pendingRevision = nonNegativeRevision(lane.pending_work_url_revision);
  if (!pendingRevision) {
    return {
      status: "NONE",
      revision: 0,
      mode: null,
      target_changed: false,
      generation_changed: false
    };
  }

  const appliedRevision = nonNegativeRevision(lane.applied_work_url_revision);
  if (pendingRevision <= appliedRevision) {
    clearPending(lane);
    return {
      status: "NOOP",
      revision: pendingRevision,
      mode: null,
      target_changed: false,
      generation_changed: false
    };
  }

  if (hasActiveWorkTransaction(lane)) {
    return {
      status: "PENDING",
      revision: pendingRevision,
      mode: normalizeWorkTargetMode(
        lane.pending_work_mode,
        lane.pending_work_url
      ),
      target_changed: false,
      generation_changed: false
    };
  }

  return applyIntent(lane, {
    url: lane.pending_work_url,
    revision: pendingRevision,
    saved_at: lane.pending_work_saved_at,
    mode: lane.pending_work_mode
  });
}
