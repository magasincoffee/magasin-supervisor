import test from "node:test";
import assert from "node:assert/strict";

import {
  RELAY_RETRY_STATES,
  RELAY_SEND_MAX_ATTEMPTS,
  beginRelaySendAttempt,
  relayRetryState,
  scheduleRelayRetry
} from "../src/runtime/relay-retry.mjs";

test("v48 relay retry is bounded to three real send attempts", () => {
  const latch = {};
  const now = Date.parse("2026-09-19T12:00:00Z");

  assert.equal(RELAY_SEND_MAX_ATTEMPTS, 3);
  assert.equal(beginRelaySendAttempt(latch), 1);
  assert.equal(scheduleRelayRetry(latch, { now }), RELAY_RETRY_STATES.WAIT);
  assert.equal(relayRetryState(latch, now), RELAY_RETRY_STATES.WAIT);

  latch.retry_not_before = null;
  assert.equal(beginRelaySendAttempt(latch), 2);
  assert.equal(scheduleRelayRetry(latch, { now }), RELAY_RETRY_STATES.WAIT);

  latch.retry_not_before = null;
  assert.equal(beginRelaySendAttempt(latch), 3);
  assert.equal(
    scheduleRelayRetry(latch, { now }),
    RELAY_RETRY_STATES.EXHAUSTED
  );
  assert.equal(relayRetryState(latch, now), RELAY_RETRY_STATES.EXHAUSTED);
  assert.equal(latch.attempt_count, 3);
});

test("v48 retry backoff becomes ready only after retry_not_before", () => {
  const now = Date.parse("2026-09-19T12:00:00Z");
  const latch = { attempt_count: 1 };
  scheduleRelayRetry(latch, { now });
  assert.equal(relayRetryState(latch, now + 14_999), RELAY_RETRY_STATES.WAIT);
  assert.equal(relayRetryState(latch, now + 15_000), RELAY_RETRY_STATES.READY);
});

test("v48 retry state preserves relay identity and screenshot evidence", () => {
  const latch = {
    relay_id: "relay-1",
    screenshot_path: "C:/evidence/relay-1.png"
  };
  beginRelaySendAttempt(latch);
  scheduleRelayRetry(latch, { now: 0 });
  assert.equal(latch.relay_id, "relay-1");
  assert.equal(latch.screenshot_path, "C:/evidence/relay-1.png");
});
