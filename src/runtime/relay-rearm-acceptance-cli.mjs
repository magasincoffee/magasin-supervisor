import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  RELAY_REARM_STATES,
  RELAY_RETRY_STATES,
  beginRelaySendAttempt,
  rearmRelayRetry,
  relayRetryState,
  scheduleRelayRetry
} from "./relay-retry.mjs";
import {
  normalizeLaneConfig,
  normalizeLaneRegistry
} from "./three-lane.mjs";

const RELAY_ID = "a".repeat(32);
const TASK_ID = "TASK-FIXTURE-RELAY-REARM";
const RESPONSE_DIGEST = "b".repeat(64);
const TEXT_DIGEST = "c".repeat(64);

const config = normalizeLaneConfig({
  lanes: [{
    lane_id: "lane-1",
    enabled: true,
    brain_url: "https://chatgpt.com/c/fixture-brain",
    brain_url_revision: 4,
    work_url: "https://chatgpt.com/c/fixture-work",
    work_url_revision: 7,
    relay_retry_rearm_revision: 1,
    relay_retry_rearm_requested_at: "2026-09-20T14:30:00.000Z"
  }]
});
const registry = normalizeLaneRegistry({
  lanes: {
    "lane-1": {
      brain_url: "https://chatgpt.com/c/fixture-brain",
      applied_brain_url_revision: 4,
      work_url: "https://chatgpt.com/c/fixture-work",
      applied_work_url_revision: 7,
      work_generation: 5,
      task_id: TASK_ID,
      awaiting_work: true,
      last_dispatch_id: "d".repeat(32),
      last_work_result_digest: RESPONSE_DIGEST,
      pending_work_url: "https://chatgpt.com/c/fixture-next-work",
      pending_work_url_revision: 8,
      pending_work_mode: "OWNER",
      applied_relay_retry_rearm_revision: 0,
      relay_inflight: {
        relay_id: RELAY_ID,
        response_digest: RESPONSE_DIGEST,
        text_digest: TEXT_DIGEST,
        screenshot_path: "C:/fixture/relay.png",
        attempt_count: 3,
        retry_not_before: null,
        retry_exhausted: true,
        last_attempt_state: "EXHAUSTED",
        retry_epoch: 0
      }
    }
  }
});

const lane = registry.lanes["lane-1"];
const latch = lane.relay_inflight;
const truthBefore = JSON.stringify({
  task_id: lane.task_id,
  awaiting_work: lane.awaiting_work,
  brain_url: lane.brain_url,
  work_url: lane.work_url,
  work_generation: lane.work_generation,
  last_dispatch_id: lane.last_dispatch_id,
  last_work_result_digest: lane.last_work_result_digest,
  pending_work_url: lane.pending_work_url,
  pending_work_url_revision: lane.pending_work_url_revision,
  relay_id: latch.relay_id,
  response_digest: latch.response_digest,
  text_digest: latch.text_digest,
  screenshot_path: latch.screenshot_path
});

const first = rearmRelayRetry(latch, {
  revision: config.lanes[0].relay_retry_rearm_revision,
  appliedRevision: lane.applied_relay_retry_rearm_revision
});
assert.equal(first.status, RELAY_REARM_STATES.REARMED);
assert.equal(first.retry_epoch, 1);
assert.equal(latch.relay_id, RELAY_ID);
assert.equal(latch.attempt_count, 0);
assert.equal(latch.retry_exhausted, false);
lane.applied_relay_retry_rearm_revision = first.applied_revision;

const restarted = normalizeLaneRegistry(JSON.parse(JSON.stringify(registry)));
const restartedLatch = restarted.lanes["lane-1"].relay_inflight;
const duplicateRevision = rearmRelayRetry(restartedLatch, {
  revision: 1,
  appliedRevision: restarted.lanes["lane-1"].applied_relay_retry_rearm_revision
});
assert.equal(duplicateRevision.status, RELAY_REARM_STATES.ALREADY_APPLIED);
assert.equal(restartedLatch.retry_epoch, 1);
assert.equal(restartedLatch.attempt_count, 0);

const now = Date.parse("2026-09-20T14:31:00.000Z");
for (let attempt = 1; attempt <= 3; attempt += 1) {
  restartedLatch.retry_not_before = null;
  assert.equal(beginRelaySendAttempt(restartedLatch), attempt);
  const state = scheduleRelayRetry(restartedLatch, { now });
  if (attempt < 3) assert.equal(state, RELAY_RETRY_STATES.WAIT);
  else assert.equal(state, RELAY_RETRY_STATES.EXHAUSTED);
}
assert.equal(relayRetryState(restartedLatch, now), RELAY_RETRY_STATES.EXHAUSTED);

const noAutoRearmSnapshot = JSON.stringify(restartedLatch);
assert.equal(relayRetryState(restartedLatch, now + 999_999), RELAY_RETRY_STATES.EXHAUSTED);
assert.equal(JSON.stringify(restartedLatch), noAutoRearmSnapshot);

const secondEpoch = rearmRelayRetry(restartedLatch, {
  revision: 2,
  appliedRevision: 1
});
assert.equal(secondEpoch.status, RELAY_REARM_STATES.REARMED);
assert.equal(secondEpoch.retry_epoch, 2);
assert.equal(restartedLatch.relay_id, RELAY_ID);

const truthAfter = JSON.stringify({
  task_id: lane.task_id,
  awaiting_work: lane.awaiting_work,
  brain_url: lane.brain_url,
  work_url: lane.work_url,
  work_generation: lane.work_generation,
  last_dispatch_id: lane.last_dispatch_id,
  last_work_result_digest: lane.last_work_result_digest,
  pending_work_url: lane.pending_work_url,
  pending_work_url_revision: lane.pending_work_url_revision,
  relay_id: latch.relay_id,
  response_digest: latch.response_digest,
  text_digest: latch.text_digest,
  screenshot_path: latch.screenshot_path
});
assert.equal(truthAfter, truthBefore);

const runtimeSource = await fs.readFile(
  new URL("./three-lane-cli.mjs", import.meta.url),
  "utf8"
);
const applyStart = runtimeSource.indexOf("async function applyOwnerRelayRetryRearm");
const applyEnd = runtimeSource.indexOf("async function applyOwnerWorkTarget", applyStart);
const applySource = runtimeSource.slice(applyStart, applyEnd);
assert.ok(applyStart >= 0 && applyEnd > applyStart);
const exhaustedApplySource = applySource.slice(applySource.indexOf("if (!brainPage)"));
assert.ok(exhaustedApplySource.indexOf("hasRelayMarker") < exhaustedApplySource.indexOf("rearmRelayRetry"));
assert.ok(exhaustedApplySource.indexOf("waitForStableSendSurface") < exhaustedApplySource.indexOf("rearmRelayRetry"));
assert.match(exhaustedApplySource, /BRAIN_NOT_READY/);
assert.match(applySource, /finalizeConfirmedRelay/);
assert.match(applySource, /EVIDENCE_MISSING/);
assert.doesNotMatch(applySource, /clearRelayInflight/);
assert.match(runtimeSource, /relayOutcome === "EVIDENCE_MISSING"/);
assert.match(runtimeSource, /RESULT_IDENTITY_MISMATCH/);
assert.match(runtimeSource, /FAIL_CLOSED_RECONSTRUCTED_RESULT_MISMATCH/);
assert.match(runtimeSource, /if \(args\.relayRearmFixture\)/);

console.log("RELAY_REARM_FIXTURE_EXHAUSTED_OWNER_REARMED=True");
console.log("RELAY_REARM_FIXTURE_SAME_RELAY_ID=True");
console.log("RELAY_REARM_FIXTURE_BOUNDED_THREE_ATTEMPTS=True");
console.log("RELAY_REARM_FIXTURE_NO_AUTO_REARM=True");
console.log("RELAY_REARM_FIXTURE_SAME_REVISION_APPLIES_ONCE=True");
console.log("RELAY_REARM_FIXTURE_NEW_REVISION_OPENS_ONE_EPOCH=True");
console.log("RELAY_REARM_FIXTURE_MARKER_RECONCILE_BEFORE_REARM=True");
console.log("RELAY_REARM_FIXTURE_STABLE_BRAIN_GATE=True");
console.log("RELAY_REARM_FIXTURE_RESULT_IDENTITY_FAIL_CLOSED=True");
console.log("RELAY_REARM_FIXTURE_EVIDENCE_FAIL_CLOSED=True");
console.log("RELAY_REARM_FIXTURE_TASK_RESULT_TARGETS_PRESERVED=True");
console.log("RELAY_REARM_FIXTURE_NO_WORK_DISPATCH_RESET=True");
