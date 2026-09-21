export const WORK_CAPACITY_STATES = Object.freeze({
  NOT_FULL: "NOT_FULL",
  AMBIGUOUS: "AMBIGUOUS",
  FULL_CONFIRMED: "FULL_CONFIRMED"
});

export const WORK_CAPACITY_EVIDENCE = Object.freeze({
  EXPLICIT_FULL_LIMIT_UI: "EXPLICIT_FULL_LIMIT_UI",
  COMPOSER_CAPACITY_BLOCKED: "COMPOSER_CAPACITY_BLOCKED",
  SEND_REJECTION_CAPACITY: "SEND_REJECTION_CAPACITY",
  LEGACY_FULL_TEXT: "LEGACY_FULL_TEXT",
  RESPONSE_RUNNING_GUARD: "RESPONSE_RUNNING_GUARD",
  INCOMPLETE_TURN_GUARD: "INCOMPLETE_TURN_GUARD",
  NETWORK_GUARD: "NETWORK_GUARD",
  SECURITY_GUARD: "SECURITY_GUARD",
  TRANSIENT_GUARD: "TRANSIENT_GUARD",
  CONVERSATION_MISSING_GUARD: "CONVERSATION_MISSING_GUARD",
  STABLE_IDENTITY_REQUIRED: "STABLE_IDENTITY_REQUIRED",
  STABLE_PROBE_REQUIRED: "STABLE_PROBE_REQUIRED"
});

function bool(value) {
  return Boolean(value);
}

export function normalizeWorkCapacitySignals(value = {}) {
  return {
    explicit_full_limit_ui: bool(value.explicit_full_limit_ui),
    composer_capacity_blocked: bool(value.composer_capacity_blocked),
    send_rejection_capacity: bool(value.send_rejection_capacity),
    legacy_conversation_full: bool(value.legacy_conversation_full),
    response_running: bool(value.response_running),
    incomplete_turn: bool(value.incomplete_turn),
    network_error: bool(value.network_error),
    security_blocked: bool(value.security_blocked),
    transient_state: bool(value.transient_state),
    conversation_missing: bool(value.conversation_missing)
  };
}

export function workCapacitySignalsFromSnapshot(
  snapshot = {},
  { sendRejectionCapacity = false } = {}
) {
  return normalizeWorkCapacitySignals({
    explicit_full_limit_ui: snapshot.capacityExplicitFullUi,
    composer_capacity_blocked: snapshot.composerCapacityBlocked,
    send_rejection_capacity: sendRejectionCapacity,
    legacy_conversation_full: snapshot.conversationFull,
    response_running: snapshot.responseRunning,
    incomplete_turn:
      snapshot.lastMessageRole === "user" ||
      snapshot.hasContinueControl ||
      snapshot.assistantBusy ||
      snapshot.mainBusy,
    network_error: snapshot.hasNetworkError,
    security_blocked:
      snapshot.loginRequired ||
      snapshot.hasCaptcha ||
      snapshot.conversationAccessDenied,
    transient_state:
      snapshot.hasTransientError ||
      snapshot.hasRetryControl ||
      snapshot.modelSwitching,
    conversation_missing: snapshot.conversationMissing
  });
}

function guardReason(first, second) {
  const both = [first, second];
  if (both.some((item) => item.security_blocked)) {
    return WORK_CAPACITY_EVIDENCE.SECURITY_GUARD;
  }
  if (both.some((item) => item.conversation_missing)) {
    return WORK_CAPACITY_EVIDENCE.CONVERSATION_MISSING_GUARD;
  }
  if (both.some((item) => item.network_error)) {
    return WORK_CAPACITY_EVIDENCE.NETWORK_GUARD;
  }
  if (both.some((item) => item.transient_state)) {
    return WORK_CAPACITY_EVIDENCE.TRANSIENT_GUARD;
  }
  if (both.some((item) => item.response_running)) {
    return WORK_CAPACITY_EVIDENCE.RESPONSE_RUNNING_GUARD;
  }
  if (both.some((item) => item.incomplete_turn)) {
    return WORK_CAPACITY_EVIDENCE.INCOMPLETE_TURN_GUARD;
  }
  return null;
}

function stableEvidence(first, second) {
  const evidence = [];
  if (first.explicit_full_limit_ui && second.explicit_full_limit_ui) {
    evidence.push(WORK_CAPACITY_EVIDENCE.EXPLICIT_FULL_LIMIT_UI);
  }
  if (first.composer_capacity_blocked && second.composer_capacity_blocked) {
    evidence.push(WORK_CAPACITY_EVIDENCE.COMPOSER_CAPACITY_BLOCKED);
  }
  if (first.send_rejection_capacity || second.send_rejection_capacity) {
    evidence.push(WORK_CAPACITY_EVIDENCE.SEND_REJECTION_CAPACITY);
  }
  if (first.legacy_conversation_full && second.legacy_conversation_full) {
    evidence.push(WORK_CAPACITY_EVIDENCE.LEGACY_FULL_TEXT);
  }
  return evidence;
}

export function evaluateWorkCapacity({
  first = {},
  second = {},
  stableIdentity = false,
  stableProbeCount = 2
} = {}) {
  const a = normalizeWorkCapacitySignals(first);
  const b = normalizeWorkCapacitySignals(second);

  const guard = guardReason(a, b);
  if (guard) {
    return {
      state: WORK_CAPACITY_STATES.NOT_FULL,
      evidence_codes: [guard],
      supporting_count: 0,
      strong: false
    };
  }

  if (!stableIdentity) {
    return {
      state: WORK_CAPACITY_STATES.AMBIGUOUS,
      evidence_codes: [WORK_CAPACITY_EVIDENCE.STABLE_IDENTITY_REQUIRED],
      supporting_count: 0,
      strong: false
    };
  }

  if (Number(stableProbeCount || 0) < 2) {
    return {
      state: WORK_CAPACITY_STATES.AMBIGUOUS,
      evidence_codes: [WORK_CAPACITY_EVIDENCE.STABLE_PROBE_REQUIRED],
      supporting_count: 0,
      strong: false
    };
  }

  const evidence = stableEvidence(a, b);
  const strong = evidence.includes(WORK_CAPACITY_EVIDENCE.EXPLICIT_FULL_LIMIT_UI);
  const supporting = evidence.filter((code) =>
    code !== WORK_CAPACITY_EVIDENCE.EXPLICIT_FULL_LIMIT_UI
  );

  if (strong) {
    return {
      state: WORK_CAPACITY_STATES.FULL_CONFIRMED,
      evidence_codes: evidence,
      supporting_count: supporting.length,
      strong: true
    };
  }

  if (supporting.length >= 2) {
    return {
      state: WORK_CAPACITY_STATES.FULL_CONFIRMED,
      evidence_codes: evidence,
      supporting_count: supporting.length,
      strong: false
    };
  }

  if (evidence.length > 0) {
    return {
      state: WORK_CAPACITY_STATES.AMBIGUOUS,
      evidence_codes: evidence,
      supporting_count: supporting.length,
      strong: false
    };
  }

  const unstableCapacityEvidence = Boolean(
    a.explicit_full_limit_ui ||
    b.explicit_full_limit_ui ||
    a.composer_capacity_blocked ||
    b.composer_capacity_blocked ||
    a.send_rejection_capacity ||
    b.send_rejection_capacity ||
    a.legacy_conversation_full ||
    b.legacy_conversation_full
  );
  if (unstableCapacityEvidence) {
    return {
      state: WORK_CAPACITY_STATES.AMBIGUOUS,
      evidence_codes: [WORK_CAPACITY_EVIDENCE.STABLE_PROBE_REQUIRED],
      supporting_count: 0,
      strong: false
    };
  }

  return {
    state: WORK_CAPACITY_STATES.NOT_FULL,
    evidence_codes: [],
    supporting_count: 0,
    strong: false
  };
}
