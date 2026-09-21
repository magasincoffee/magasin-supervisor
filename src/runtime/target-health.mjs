export const TARGET_HEALTH_SCHEMA_VERSION = "target-health.v1";

export const TARGET_HEALTH_STATES = Object.freeze({
  UNKNOWN: "UNKNOWN",
  HEALTHY: "HEALTHY",
  QUARANTINED: "QUARANTINED"
});

export const TARGET_HEALTH_REASONS = Object.freeze({
  NONE: "NONE",
  CONVERSATION_MISSING: "CONVERSATION_MISSING",
  CONVERSATION_ACCESS_DENIED: "CONVERSATION_ACCESS_DENIED",
  STABLE_REDIRECT_AWAY: "STABLE_REDIRECT_AWAY"
});

export const TARGET_AVAILABILITY = Object.freeze({
  AVAILABLE: "AVAILABLE",
  AMBIGUOUS: "AMBIGUOUS",
  DETERMINISTIC_UNAVAILABLE: "DETERMINISTIC_UNAVAILABLE"
});

const VALID_STATES = new Set(Object.values(TARGET_HEALTH_STATES));
const VALID_REASONS = new Set(Object.values(TARGET_HEALTH_REASONS));
const VALID_ROLES = new Set(["BRAIN", "WORK"]);
const HEX_RE = /^[a-f0-9]{64}$/i;

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

function hexOrNull(value) {
  const raw = String(value || "").trim();
  return HEX_RE.test(raw) ? raw.toLowerCase() : null;
}

export function targetHealthIdentity({
  role,
  targetDigest,
  targetRevision = 0,
  workGeneration = 0
} = {}) {
  const normalizedRole = String(role || "").trim().toUpperCase();
  if (!VALID_ROLES.has(normalizedRole)) {
    throw new TypeError("target health role must be BRAIN or WORK");
  }
  const digest = hexOrNull(targetDigest);
  if (!digest) throw new TypeError("target health requires a sha256 target digest");
  return Object.freeze({
    role: normalizedRole,
    target_digest: digest,
    target_revision: nonNegativeInteger(targetRevision),
    work_generation: normalizedRole === "WORK"
      ? nonNegativeInteger(workGeneration)
      : 0
  });
}

export function defaultTargetHealth() {
  return {
    schema_version: TARGET_HEALTH_SCHEMA_VERSION,
    state: TARGET_HEALTH_STATES.UNKNOWN,
    reason_code: TARGET_HEALTH_REASONS.NONE,
    role: null,
    target_digest: null,
    target_revision: 0,
    work_generation: 0,
    first_detected_at: null,
    last_checked_at: null,
    quarantined_at: null
  };
}

export function normalizeTargetHealth(value = null) {
  const safe = defaultTargetHealth();
  if (!value || typeof value !== "object" || Array.isArray(value)) return safe;

  const role = String(value.role || "").trim().toUpperCase();
  safe.role = VALID_ROLES.has(role) ? role : null;
  safe.target_digest = hexOrNull(value.target_digest);
  safe.target_revision = nonNegativeInteger(value.target_revision);
  safe.work_generation = nonNegativeInteger(value.work_generation);
  safe.state = VALID_STATES.has(value.state)
    ? value.state
    : TARGET_HEALTH_STATES.UNKNOWN;
  safe.reason_code = VALID_REASONS.has(value.reason_code)
    ? value.reason_code
    : TARGET_HEALTH_REASONS.NONE;
  safe.first_detected_at = isoOrNull(value.first_detected_at);
  safe.last_checked_at = isoOrNull(value.last_checked_at);
  safe.quarantined_at = isoOrNull(value.quarantined_at);

  if (!safe.role || !safe.target_digest) {
    return defaultTargetHealth();
  }
  if (safe.state === TARGET_HEALTH_STATES.QUARANTINED) {
    if (
      safe.reason_code === TARGET_HEALTH_REASONS.NONE ||
      !safe.quarantined_at
    ) {
      return {
        ...safe,
        state: TARGET_HEALTH_STATES.UNKNOWN,
        reason_code: TARGET_HEALTH_REASONS.NONE,
        quarantined_at: null
      };
    }
  }
  return safe;
}

export function targetHealthMatchesIdentity(health, identity) {
  const safe = normalizeTargetHealth(health);
  if (!identity || !safe.target_digest) return false;
  // A same canonical URL remains the same unavailable target even if Owner
  // merely re-saves it or an unrelated generation/reset revision changes.
  // A genuinely new canonical target necessarily has a different digest.
  return (
    safe.role === identity.role &&
    safe.target_digest === identity.target_digest
  );
}

export function isTargetQuarantined(health, identity) {
  const safe = normalizeTargetHealth(health);
  return Boolean(
    safe.state === TARGET_HEALTH_STATES.QUARANTINED &&
    targetHealthMatchesIdentity(safe, identity)
  );
}

export function adoptTargetHealthIdentity(
  health,
  identity,
  { at = new Date().toISOString() } = {}
) {
  const safe = normalizeTargetHealth(health);
  const checkedAt = isoOrNull(at) || new Date().toISOString();

  if (targetHealthMatchesIdentity(safe, identity)) {
    return {
      ...safe,
      target_revision: identity.target_revision,
      work_generation: identity.role === "WORK"
        ? identity.work_generation
        : 0,
      last_checked_at: checkedAt
    };
  }

  return {
    schema_version: TARGET_HEALTH_SCHEMA_VERSION,
    state: TARGET_HEALTH_STATES.UNKNOWN,
    reason_code: TARGET_HEALTH_REASONS.NONE,
    role: identity.role,
    target_digest: identity.target_digest,
    target_revision: identity.target_revision,
    work_generation: identity.role === "WORK"
      ? identity.work_generation
      : 0,
    first_detected_at: null,
    last_checked_at: checkedAt,
    quarantined_at: null
  };
}

export function markTargetHealthy(
  health,
  identity,
  { at = new Date().toISOString() } = {}
) {
  const checkedAt = isoOrNull(at) || new Date().toISOString();
  const base = adoptTargetHealthIdentity(health, identity, { at: checkedAt });
  if (base.state === TARGET_HEALTH_STATES.QUARANTINED) return base;
  return {
    ...base,
    state: TARGET_HEALTH_STATES.HEALTHY,
    reason_code: TARGET_HEALTH_REASONS.NONE,
    last_checked_at: checkedAt
  };
}

export function quarantineTarget(
  health,
  identity,
  {
    reasonCode,
    at = new Date().toISOString()
  } = {}
) {
  if (!VALID_REASONS.has(reasonCode) || reasonCode === TARGET_HEALTH_REASONS.NONE) {
    throw new TypeError("deterministic quarantine reason is required");
  }
  const detectedAt = isoOrNull(at) || new Date().toISOString();
  const base = adoptTargetHealthIdentity(health, identity, { at: detectedAt });
  const firstDetection = !(
    base.state === TARGET_HEALTH_STATES.QUARANTINED &&
    base.reason_code === reasonCode
  );
  return {
    health: {
      ...base,
      state: TARGET_HEALTH_STATES.QUARANTINED,
      reason_code: reasonCode,
      first_detected_at: base.first_detected_at || detectedAt,
      last_checked_at: detectedAt,
      quarantined_at: base.quarantined_at || detectedAt
    },
    changed: firstDetection
  };
}

function transientSnapshot(snapshot = {}) {
  return Boolean(
    snapshot.loginRequired ||
    snapshot.hasCaptcha ||
    snapshot.hasNetworkError ||
    snapshot.hasTransientError ||
    snapshot.hasRetryControl ||
    snapshot.modelSwitching
  );
}

function bool(value) {
  return Boolean(value);
}

export function evaluateTargetAvailability({
  firstSnapshot = {},
  secondSnapshot = {},
  firstExact = true,
  secondExact = true,
  stableRedirectLocation = false
} = {}) {
  const firstTransient = transientSnapshot(firstSnapshot);
  const secondTransient = transientSnapshot(secondSnapshot);

  if (firstTransient || secondTransient) {
    return {
      state: TARGET_AVAILABILITY.AMBIGUOUS,
      reason_code: TARGET_HEALTH_REASONS.NONE
    };
  }

  if (
    bool(firstSnapshot.conversationAccessDenied) &&
    bool(secondSnapshot.conversationAccessDenied)
  ) {
    return {
      state: TARGET_AVAILABILITY.DETERMINISTIC_UNAVAILABLE,
      reason_code: TARGET_HEALTH_REASONS.CONVERSATION_ACCESS_DENIED
    };
  }

  if (
    bool(firstSnapshot.conversationMissing) &&
    bool(secondSnapshot.conversationMissing)
  ) {
    return {
      state: TARGET_AVAILABILITY.DETERMINISTIC_UNAVAILABLE,
      reason_code: TARGET_HEALTH_REASONS.CONVERSATION_MISSING
    };
  }

  if (
    !firstExact &&
    !secondExact &&
    stableRedirectLocation &&
    !bool(firstSnapshot.responseRunning) &&
    !bool(secondSnapshot.responseRunning) &&
    !bool(firstSnapshot.conversationPath) &&
    !bool(secondSnapshot.conversationPath)
  ) {
    return {
      state: TARGET_AVAILABILITY.DETERMINISTIC_UNAVAILABLE,
      reason_code: TARGET_HEALTH_REASONS.STABLE_REDIRECT_AWAY
    };
  }

  if (
    firstExact &&
    secondExact &&
    !bool(firstSnapshot.conversationMissing) &&
    !bool(secondSnapshot.conversationMissing) &&
    !bool(firstSnapshot.conversationAccessDenied) &&
    !bool(secondSnapshot.conversationAccessDenied)
  ) {
    return {
      state: TARGET_AVAILABILITY.AVAILABLE,
      reason_code: TARGET_HEALTH_REASONS.NONE
    };
  }

  return {
    state: TARGET_AVAILABILITY.AMBIGUOUS,
    reason_code: TARGET_HEALTH_REASONS.NONE
  };
}
