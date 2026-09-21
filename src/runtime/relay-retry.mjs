export const RELAY_SEND_MAX_ATTEMPTS = 3;

const RETRY_DELAYS_MS = Object.freeze([
  15_000,
  30_000,
  60_000
]);

export const RELAY_RETRY_STATES = Object.freeze({
  READY: "READY",
  WAIT: "WAIT",
  EXHAUSTED: "EXHAUSTED"
});

export const RELAY_REARM_STATES = Object.freeze({
  REARMED: "REARMED",
  NO_LATCH: "NO_LATCH",
  NOT_EXHAUSTED: "NOT_EXHAUSTED",
  ALREADY_APPLIED: "ALREADY_APPLIED"
});

function nonNegativeInteger(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

export function relayRetryState(latch, now = Date.now()) {
  if (latch?.retry_exhausted) return RELAY_RETRY_STATES.EXHAUSTED;
  const retryAt = Date.parse(String(latch?.retry_not_before || ""));
  if (Number.isFinite(retryAt) && retryAt > now) {
    return RELAY_RETRY_STATES.WAIT;
  }
  return RELAY_RETRY_STATES.READY;
}

export function rearmRelayRetry(
  latch,
  { revision, appliedRevision = 0 } = {}
) {
  const requestedRevision = nonNegativeInteger(revision);
  const currentAppliedRevision = nonNegativeInteger(appliedRevision);

  if (requestedRevision <= currentAppliedRevision) {
    return {
      status: RELAY_REARM_STATES.ALREADY_APPLIED,
      applied_revision: currentAppliedRevision,
      retry_epoch: nonNegativeInteger(latch?.retry_epoch)
    };
  }

  if (!latch || typeof latch !== "object") {
    return {
      status: RELAY_REARM_STATES.NO_LATCH,
      applied_revision: requestedRevision,
      retry_epoch: 0
    };
  }

  if (!latch.retry_exhausted) {
    return {
      status: RELAY_REARM_STATES.NOT_EXHAUSTED,
      applied_revision: requestedRevision,
      retry_epoch: nonNegativeInteger(latch.retry_epoch)
    };
  }

  latch.retry_epoch = nonNegativeInteger(latch.retry_epoch) + 1;
  latch.attempt_count = 0;
  latch.retry_not_before = null;
  latch.retry_exhausted = false;
  latch.last_attempt_state = "OWNER_REARMED";
  latch.owner_rearm_revision = requestedRevision;

  return {
    status: RELAY_REARM_STATES.REARMED,
    applied_revision: requestedRevision,
    retry_epoch: latch.retry_epoch
  };
}

export function beginRelaySendAttempt(latch) {
  if (!latch || typeof latch !== "object") {
    throw new TypeError("relay latch is required");
  }
  latch.attempt_count = Math.max(0, Number(latch.attempt_count || 0)) + 1;
  latch.retry_not_before = null;
  latch.retry_exhausted = false;
  latch.last_attempt_state = "SENDING";
  return latch.attempt_count;
}

export function scheduleRelayRetry(
  latch,
  { now = Date.now(), maxAttempts = RELAY_SEND_MAX_ATTEMPTS } = {}
) {
  if (!latch || typeof latch !== "object") {
    throw new TypeError("relay latch is required");
  }

  const attempts = Math.max(0, Number(latch.attempt_count || 0));
  if (attempts >= maxAttempts) {
    latch.retry_not_before = null;
    latch.retry_exhausted = true;
    latch.last_attempt_state = "EXHAUSTED";
    return RELAY_RETRY_STATES.EXHAUSTED;
  }

  const delayIndex = Math.min(
    Math.max(0, attempts - 1),
    RETRY_DELAYS_MS.length - 1
  );
  latch.retry_not_before = new Date(now + RETRY_DELAYS_MS[delayIndex]).toISOString();
  latch.retry_exhausted = false;
  latch.last_attempt_state = "RETRY_SCHEDULED";
  return RELAY_RETRY_STATES.WAIT;
}
