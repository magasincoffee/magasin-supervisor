import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  WORK_CAPACITY_EVIDENCE,
  WORK_CAPACITY_STATES,
  evaluateWorkCapacity,
  workCapacitySignalsFromSnapshot
} from "../src/runtime/work-capacity.mjs";
import {
  SEND_REJECTION_CLASSES,
  classifyComposerSendRejection
} from "../src/ui/actions.mjs";

function base(overrides = {}) {
  return {
    explicit_full_limit_ui: false,
    composer_capacity_blocked: false,
    send_rejection_capacity: false,
    legacy_conversation_full: false,
    response_running: false,
    incomplete_turn: false,
    network_error: false,
    security_blocked: false,
    transient_state: false,
    conversation_missing: false,
    ...overrides
  };
}

function evaluate(first, second = first, extra = {}) {
  return evaluateWorkCapacity({
    first,
    second,
    stableIdentity: true,
    stableProbeCount: 2,
    ...extra
  });
}

test("strong structured full signal stable across probes confirms FULL", () => {
  const result = evaluate(
    base({ explicit_full_limit_ui: true }),
    base({ explicit_full_limit_ui: true })
  );
  assert.equal(result.state, WORK_CAPACITY_STATES.FULL_CONFIRMED);
  assert.equal(result.strong, true);
  assert.deepEqual(result.evidence_codes, [
    WORK_CAPACITY_EVIDENCE.EXPLICIT_FULL_LIMIT_UI
  ]);
});

test("single legacy regex signal is ambiguous and cannot authorize rollover", () => {
  const result = evaluate(
    base({ legacy_conversation_full: true }),
    base({ legacy_conversation_full: true })
  );
  assert.equal(result.state, WORK_CAPACITY_STATES.AMBIGUOUS);
  assert.equal(result.strong, false);
  assert.equal(result.supporting_count, 1);
});

test("two independent supporting signal families confirm FULL", () => {
  const result = evaluate(
    base({
      legacy_conversation_full: true,
      composer_capacity_blocked: true
    }),
    base({
      legacy_conversation_full: true,
      composer_capacity_blocked: true
    })
  );
  assert.equal(result.state, WORK_CAPACITY_STATES.FULL_CONFIRMED);
  assert.equal(result.strong, false);
  assert.equal(result.supporting_count, 2);
});

test("capacity send rejection plus legacy evidence is multi-signal FULL", () => {
  const result = evaluate(
    base({
      legacy_conversation_full: true,
      send_rejection_capacity: true
    }),
    base({ legacy_conversation_full: true })
  );
  assert.equal(result.state, WORK_CAPACITY_STATES.FULL_CONFIRMED);
  assert.ok(result.evidence_codes.includes(
    WORK_CAPACITY_EVIDENCE.SEND_REJECTION_CAPACITY
  ));
});

test("generic disabled composer alone is not capacity evidence", () => {
  const signals = workCapacitySignalsFromSnapshot({
    composerReady: true,
    composerGenericBlocked: true,
    composerCapacityBlocked: false
  });
  const result = evaluate(signals, signals);
  assert.equal(result.state, WORK_CAPACITY_STATES.NOT_FULL);
  assert.equal(result.evidence_codes.length, 0);
});

test("responseRunning vetoes even strong full-looking UI", () => {
  const result = evaluate(
    base({ explicit_full_limit_ui: true, response_running: true }),
    base({ explicit_full_limit_ui: true })
  );
  assert.equal(result.state, WORK_CAPACITY_STATES.NOT_FULL);
  assert.deepEqual(result.evidence_codes, [
    WORK_CAPACITY_EVIDENCE.RESPONSE_RUNNING_GUARD
  ]);
});

test("incomplete turn vetoes capacity rollover", () => {
  const result = evaluate(
    base({ explicit_full_limit_ui: true, incomplete_turn: true }),
    base({ explicit_full_limit_ui: true })
  );
  assert.equal(result.state, WORK_CAPACITY_STATES.NOT_FULL);
  assert.equal(
    result.evidence_codes[0],
    WORK_CAPACITY_EVIDENCE.INCOMPLETE_TURN_GUARD
  );
});

test("network error is never conversation full", () => {
  const result = evaluate(
    base({ legacy_conversation_full: true, network_error: true }),
    base({ legacy_conversation_full: true })
  );
  assert.equal(result.state, WORK_CAPACITY_STATES.NOT_FULL);
  assert.equal(result.evidence_codes[0], WORK_CAPACITY_EVIDENCE.NETWORK_GUARD);
});

test("auth MFA CAPTCHA/access boundary is never conversation full", () => {
  const result = evaluate(
    base({ explicit_full_limit_ui: true, security_blocked: true }),
    base({ explicit_full_limit_ui: true })
  );
  assert.equal(result.state, WORK_CAPACITY_STATES.NOT_FULL);
  assert.equal(result.evidence_codes[0], WORK_CAPACITY_EVIDENCE.SECURITY_GUARD);
});

test("transient retry/model switching state is never conversation full", () => {
  const result = evaluate(
    base({ legacy_conversation_full: true, transient_state: true }),
    base({ legacy_conversation_full: true })
  );
  assert.equal(result.state, WORK_CAPACITY_STATES.NOT_FULL);
  assert.equal(result.evidence_codes[0], WORK_CAPACITY_EVIDENCE.TRANSIENT_GUARD);
});

test("missing/access-denied conversation is not a full signal", () => {
  const result = evaluate(
    base({ conversation_missing: true, explicit_full_limit_ui: true }),
    base({ explicit_full_limit_ui: true })
  );
  assert.equal(result.state, WORK_CAPACITY_STATES.NOT_FULL);
  assert.equal(
    result.evidence_codes[0],
    WORK_CAPACITY_EVIDENCE.CONVERSATION_MISSING_GUARD
  );
});

test("strong signal observed in only one probe remains ambiguous", () => {
  const result = evaluate(
    base({ explicit_full_limit_ui: true }),
    base()
  );
  assert.equal(result.state, WORK_CAPACITY_STATES.AMBIGUOUS);
  assert.equal(
    result.evidence_codes[0],
    WORK_CAPACITY_EVIDENCE.STABLE_PROBE_REQUIRED
  );
});

test("stable exact conversation identity is mandatory", () => {
  const result = evaluateWorkCapacity({
    first: base({ explicit_full_limit_ui: true }),
    second: base({ explicit_full_limit_ui: true }),
    stableIdentity: false,
    stableProbeCount: 2
  });
  assert.equal(result.state, WORK_CAPACITY_STATES.AMBIGUOUS);
  assert.equal(
    result.evidence_codes[0],
    WORK_CAPACITY_EVIDENCE.STABLE_IDENTITY_REQUIRED
  );
});

test("two stable probes are mandatory", () => {
  const result = evaluateWorkCapacity({
    first: base({ explicit_full_limit_ui: true }),
    second: base({ explicit_full_limit_ui: true }),
    stableIdentity: true,
    stableProbeCount: 1
  });
  assert.equal(result.state, WORK_CAPACITY_STATES.AMBIGUOUS);
  assert.equal(
    result.evidence_codes[0],
    WORK_CAPACITY_EVIDENCE.STABLE_PROBE_REQUIRED
  );
});

test("send rejection classifier distinguishes capacity from network/auth/transient/generic composer", () => {
  assert.equal(
    classifyComposerSendRejection({ capacityExplicitFullUi: true }),
    SEND_REJECTION_CLASSES.CAPACITY_REJECTED
  );
  assert.equal(
    classifyComposerSendRejection({ composerCapacityBlocked: true }),
    SEND_REJECTION_CLASSES.CAPACITY_REJECTED
  );
  assert.equal(
    classifyComposerSendRejection({ hasNetworkError: true }),
    SEND_REJECTION_CLASSES.NETWORK_TRANSIENT
  );
  assert.equal(
    classifyComposerSendRejection({ loginRequired: true }),
    SEND_REJECTION_CLASSES.AUTH_SECURITY
  );
  assert.equal(
    classifyComposerSendRejection({ hasTransientError: true }),
    SEND_REJECTION_CLASSES.TRANSIENT
  );
  assert.equal(
    classifyComposerSendRejection({
      composerReady: true,
      composerGenericBlocked: true
    }),
    SEND_REJECTION_CLASSES.COMPOSER_NOT_READY
  );
});

test("snapshot capacity source excludes conversation message bodies from recovery evidence", async () => {
  const source = await fs.readFile(
    new URL("../src/ui/snapshot.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /\[data-message-author-role\],\[data-turn-key\],\[data-user-message-bubble\],\[data-content-search-unit-key\]/);
  assert.match(source, /capacityExplicitFullUi/);
  assert.match(source, /composerCapacityBlocked/);
  const capacitySection = source.slice(
    source.indexOf("const explicitFullLimitUi"),
    source.indexOf("const conversationMissing")
  );
  assert.doesNotMatch(capacitySection, /lastMessage\.textContent/);
  assert.doesNotMatch(capacitySection, /assistantMessages.*textContent/s);
});
