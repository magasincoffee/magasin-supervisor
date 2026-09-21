import test from "node:test";
import assert from "node:assert/strict";

import {
  TARGET_AVAILABILITY,
  TARGET_HEALTH_REASONS,
  TARGET_HEALTH_STATES,
  adoptTargetHealthIdentity,
  defaultTargetHealth,
  evaluateTargetAvailability,
  isTargetQuarantined,
  normalizeTargetHealth,
  quarantineTarget,
  targetHealthIdentity
} from "../src/runtime/target-health.mjs";

const D1 = "a".repeat(64);
const D2 = "b".repeat(64);
const T0 = "2026-09-20T16:00:00.000Z";

function id(role = "WORK", digest = D1, revision = 3, generation = 7) {
  return targetHealthIdentity({
    role,
    targetDigest: digest,
    targetRevision: revision,
    workGeneration: generation
  });
}

function snap(overrides = {}) {
  return {
    conversationMissing: false,
    conversationAccessDenied: false,
    conversationPath: true,
    loginRequired: false,
    hasCaptcha: false,
    hasNetworkError: false,
    hasTransientError: false,
    hasRetryControl: false,
    modelSwitching: false,
    responseRunning: false,
    ...overrides
  };
}

test("target health defaults to UNKNOWN metadata-only state", () => {
  assert.deepEqual(defaultTargetHealth(), {
    schema_version: "target-health.v1",
    state: "UNKNOWN",
    reason_code: "NONE",
    role: null,
    target_digest: null,
    target_revision: 0,
    work_generation: 0,
    first_detected_at: null,
    last_checked_at: null,
    quarantined_at: null
  });
});

test("stable missing exact target is deterministic unavailable", () => {
  const result = evaluateTargetAvailability({
    firstSnapshot: snap({ conversationMissing: true }),
    secondSnapshot: snap({ conversationMissing: true }),
    firstExact: true,
    secondExact: true
  });
  assert.equal(result.state, TARGET_AVAILABILITY.DETERMINISTIC_UNAVAILABLE);
  assert.equal(result.reason_code, TARGET_HEALTH_REASONS.CONVERSATION_MISSING);
});

test("stable access denied exact target is deterministic unavailable", () => {
  const result = evaluateTargetAvailability({
    firstSnapshot: snap({ conversationAccessDenied: true }),
    secondSnapshot: snap({ conversationAccessDenied: true }),
    firstExact: true,
    secondExact: true
  });
  assert.equal(result.state, TARGET_AVAILABILITY.DETERMINISTIC_UNAVAILABLE);
  assert.equal(result.reason_code, TARGET_HEALTH_REASONS.CONVERSATION_ACCESS_DENIED);
});

test("stable redirect away is deterministic unavailable", () => {
  const result = evaluateTargetAvailability({
    firstSnapshot: snap({ conversationPath: false }),
    secondSnapshot: snap({ conversationPath: false }),
    firstExact: false,
    secondExact: false,
    stableRedirectLocation: true
  });
  assert.equal(result.state, TARGET_AVAILABILITY.DETERMINISTIC_UNAVAILABLE);
  assert.equal(result.reason_code, TARGET_HEALTH_REASONS.STABLE_REDIRECT_AWAY);
});

test("network/transient/login/CAPTCHA evidence never permanently quarantines", () => {
  for (const override of [
    { hasNetworkError: true },
    { hasTransientError: true },
    { hasRetryControl: true },
    { modelSwitching: true },
    { loginRequired: true },
    { hasCaptcha: true }
  ]) {
    const result = evaluateTargetAvailability({
      firstSnapshot: snap({ conversationMissing: true, ...override }),
      secondSnapshot: snap({ conversationMissing: true }),
      firstExact: true,
      secondExact: true
    });
    assert.equal(result.state, TARGET_AVAILABILITY.AMBIGUOUS);
  }
});

test("one-frame missing signal is ambiguous rather than quarantined", () => {
  const result = evaluateTargetAvailability({
    firstSnapshot: snap({ conversationMissing: true }),
    secondSnapshot: snap(),
    firstExact: true,
    secondExact: true
  });
  assert.equal(result.state, TARGET_AVAILABILITY.AMBIGUOUS);
});

test("healthy exact target remains available", () => {
  const result = evaluateTargetAvailability({
    firstSnapshot: snap(),
    secondSnapshot: snap(),
    firstExact: true,
    secondExact: true
  });
  assert.equal(result.state, TARGET_AVAILABILITY.AVAILABLE);
});

test("quarantine survives normalize/restart", () => {
  const identity = id();
  const quarantined = quarantineTarget(defaultTargetHealth(), identity, {
    reasonCode: TARGET_HEALTH_REASONS.CONVERSATION_MISSING,
    at: T0
  }).health;
  const restarted = normalizeTargetHealth(JSON.parse(JSON.stringify(quarantined)));
  assert.equal(restarted.state, TARGET_HEALTH_STATES.QUARANTINED);
  assert.equal(isTargetQuarantined(restarted, identity), true);
});

test("same stale canonical target remains blocked across revision/generation churn", () => {
  const original = id("WORK", D1, 3, 7);
  const health = quarantineTarget(defaultTargetHealth(), original, {
    reasonCode: TARGET_HEALTH_REASONS.CONVERSATION_MISSING,
    at: T0
  }).health;
  const sameUrlNewMetadata = id("WORK", D1, 99, 42);
  const adopted = adoptTargetHealthIdentity(health, sameUrlNewMetadata, { at: T0 });
  assert.equal(adopted.state, TARGET_HEALTH_STATES.QUARANTINED);
  assert.equal(isTargetQuarantined(adopted, sameUrlNewMetadata), true);
});

test("different canonical target clears old quarantine identity", () => {
  const oldIdentity = id("BRAIN", D1, 3, 0);
  const newIdentity = id("BRAIN", D2, 4, 0);
  const health = quarantineTarget(defaultTargetHealth(), oldIdentity, {
    reasonCode: TARGET_HEALTH_REASONS.CONVERSATION_ACCESS_DENIED,
    at: T0
  }).health;
  const adopted = adoptTargetHealthIdentity(health, newIdentity, { at: T0 });
  assert.equal(adopted.state, TARGET_HEALTH_STATES.UNKNOWN);
  assert.equal(isTargetQuarantined(adopted, newIdentity), false);
  assert.equal(adopted.target_digest, D2);
});

test("target health durable schema contains no URL or message body", () => {
  const health = quarantineTarget(defaultTargetHealth(), id(), {
    reasonCode: TARGET_HEALTH_REASONS.CONVERSATION_MISSING,
    at: T0
  }).health;
  const text = JSON.stringify(health);
  assert.equal(text.includes("http"), false);
  assert.equal(text.includes("chatgpt.com"), false);
  assert.equal(text.includes("message"), false);
});
