import { parseLaneDirective } from "./three-lane.mjs";

export const BRAIN_DIRECTIVE_ADOPTION = Object.freeze({
  ADOPT: "ADOPT",
  NO_DIRECTIVE: "NO_DIRECTIVE",
  RESPONSE_RUNNING: "RESPONSE_RUNNING",
  TARGET_REVISION_NOT_APPLIED: "TARGET_REVISION_NOT_APPLIED",
  STALE_HANDSHAKE_TARGET_MISMATCH: "STALE_HANDSHAKE_TARGET_MISMATCH",
  STALE_HANDSHAKE_REVISION_MISMATCH: "STALE_HANDSHAKE_REVISION_MISMATCH",
  NEWER_NON_ROBOT_TURN: "NEWER_NON_ROBOT_TURN",
  ACTIVE_EXACT_ONCE_TRANSACTION: "ACTIVE_EXACT_ONCE_TRANSACTION"
});

function latestValidDirective(turns) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.role !== "assistant") continue;
    try {
      return {
        directive: parseLaneDirective(turn.text),
        index
      };
    } catch {
      // Fail closed: prose and malformed machine blocks are never inferred.
    }
  }
  return null;
}

export function evaluateExistingBrainDirectiveAdoption({
  turns = [],
  responseRunning = false,
  expectedHandshakeDigests = [],
  currentTargetDigest = null,
  configuredRevision = 0,
  appliedRevision = 0,
  brainRequestInflight = null,
  durableState = {}
} = {}) {
  if (responseRunning) {
    return { adopt: false, reason_code: BRAIN_DIRECTIVE_ADOPTION.RESPONSE_RUNNING };
  }

  if (Number(configuredRevision || 0) !== Number(appliedRevision || 0)) {
    return {
      adopt: false,
      reason_code: BRAIN_DIRECTIVE_ADOPTION.TARGET_REVISION_NOT_APPLIED
    };
  }

  if (
    brainRequestInflight?.brain_target_digest &&
    brainRequestInflight.brain_target_digest !== currentTargetDigest
  ) {
    return {
      adopt: false,
      reason_code: BRAIN_DIRECTIVE_ADOPTION.STALE_HANDSHAKE_TARGET_MISMATCH
    };
  }

  if (
    brainRequestInflight?.brain_url_revision !== undefined &&
    brainRequestInflight?.brain_url_revision !== null &&
    Number(brainRequestInflight.brain_url_revision) !== Number(appliedRevision || 0)
  ) {
    return {
      adopt: false,
      reason_code: BRAIN_DIRECTIVE_ADOPTION.STALE_HANDSHAKE_REVISION_MISMATCH
    };
  }

  const candidate = latestValidDirective(Array.isArray(turns) ? turns : []);
  if (!candidate) {
    return { adopt: false, reason_code: BRAIN_DIRECTIVE_ADOPTION.NO_DIRECTIVE };
  }

  const allowedHandshakeDigests = new Set(expectedHandshakeDigests);
  const laterTurns = turns.slice(candidate.index + 1);
  const laterTurnsRecognized = laterTurns.every((turn) =>
    turn?.role === "user" && allowedHandshakeDigests.has(turn?.digest)
  );
  if (laterTurns.length && !laterTurnsRecognized) {
    return {
      adopt: false,
      reason_code: BRAIN_DIRECTIVE_ADOPTION.NEWER_NON_ROBOT_TURN
    };
  }

  if (
    durableState?.dispatch_inflight ||
    durableState?.relay_inflight ||
    durableState?.awaiting_work
  ) {
    return {
      adopt: false,
      reason_code: BRAIN_DIRECTIVE_ADOPTION.ACTIVE_EXACT_ONCE_TRANSACTION
    };
  }

  return {
    adopt: true,
    directive: candidate.directive,
    candidate_index: candidate.index,
    later_robot_handshake_count: laterTurns.length,
    reason_code: brainRequestInflight
      ? "STALE_HANDSHAKE_SUPERSEDED_BY_EXISTING_DIRECTIVE"
      : "EXISTING_DIRECTIVE_AUTHORITATIVE"
  };
}

export function adoptedBrainDirectiveRecord({
  directive,
  brainTargetDigest,
  brainUrlRevision,
  at = new Date().toISOString()
}) {
  return {
    action: directive.action,
    task_id: directive.action === "WORK" ? directive.task_id : null,
    directive_digest: directive.digest,
    instruction_digest:
      directive.action === "WORK" ? directive.instruction_digest : null,
    brain_target_digest: brainTargetDigest,
    brain_url_revision: Number(brainUrlRevision || 0),
    adopted_at: at
  };
}
