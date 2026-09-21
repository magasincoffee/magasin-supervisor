const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const RELAY_ID_RE = /^[a-f0-9]{16,128}$/i;

export const BRAIN_RESULT_VERDICTS = Object.freeze({
  ACCEPT: "ACCEPT",
  REJECT: "REJECT"
});

export function normalizeStoredBrainVerdict(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const verdict = String(value.verdict || "").toUpperCase();
  const taskId = String(value.task_id || "").trim();
  const relayId = String(value.relay_id || "").trim();
  if (!TASK_ID_RE.test(taskId) || !RELAY_ID_RE.test(relayId)) return null;
  if (!Object.values(BRAIN_RESULT_VERDICTS).includes(verdict)) return null;
  return {
    task_id: taskId,
    relay_id: relayId,
    verdict,
    reason_code: value.reason_code ? String(value.reason_code) : null,
    recorded_at: value.recorded_at ? String(value.recorded_at) : null
  };
}

function sameVerdict(a, b) {
  return Boolean(
    a &&
    b &&
    a.task_id === b.task_id &&
    a.relay_id === b.relay_id &&
    a.verdict === b.verdict &&
    (a.reason_code || null) === (b.reason_code || null)
  );
}

export function evaluateBrainVerdictTransition(
  registryLane = {},
  directive = {},
  { at = new Date().toISOString() } = {}
) {
  const previous = directive.previous_result || null;
  if (!previous) {
    return { state: "LEGACY", record: null, changed: false };
  }

  const durableTaskId = String(registryLane.task_id || "").trim();
  const durableRelayId = String(registryLane.last_result_relay_id || "").trim();
  if (!durableTaskId || previous.task_id !== durableTaskId) {
    throw new Error("Brain previous_result task_id does not match durable lane truth");
  }
  if (!durableRelayId || previous.relay_id !== durableRelayId) {
    throw new Error("Brain previous_result relay_id does not match durable relay truth");
  }

  const nextRecord = {
    task_id: previous.task_id,
    relay_id: previous.relay_id,
    verdict: previous.verdict,
    reason_code: previous.reason_code || null,
    recorded_at: at
  };
  const stored = normalizeStoredBrainVerdict(registryLane.last_result_verdict);

  if (stored && stored.relay_id === nextRecord.relay_id) {
    if (sameVerdict(stored, nextRecord)) {
      return { state: "IDEMPOTENT", record: stored, changed: false };
    }
    throw new Error("conflicting Brain verdict for the same relay_id");
  }

  if (previous.verdict === BRAIN_RESULT_VERDICTS.REJECT && directive.action === "WORK") {
    const correction = directive.correction_of || null;
    const sameTaskCorrection = directive.task_id === previous.task_id;
    const explicitCorrection = Boolean(
      correction &&
      correction.task_id === previous.task_id &&
      correction.relay_id === previous.relay_id
    );
    if (!sameTaskCorrection && !explicitCorrection) {
      throw new Error("REJECT cannot dispatch an unrelated task without correction_of");
    }
  }

  return { state: "NEW", record: nextRecord, changed: true };
}
