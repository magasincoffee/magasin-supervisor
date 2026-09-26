import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  RELAY_REARM_STATES,
  RELAY_RETRY_STATES,
  beginRelaySendAttempt,
  rearmRelayRetry,
  relayRetryState,
  scheduleRelayRetry
} from "../src/runtime/relay-retry.mjs";
import {
  normalizeLaneConfig,
  normalizeLaneRegistry
} from "../src/runtime/three-lane.mjs";
import {
  LANE_EVENT_TYPES,
  serializeLaneEvent
} from "../src/runtime/lane-events.mjs";

function exhaustedLatch() {
  return {
    relay_id: "a".repeat(32),
    response_digest: "b".repeat(64),
    text_digest: "c".repeat(64),
    attempt_count: 3,
    retry_not_before: null,
    retry_exhausted: true,
    last_attempt_state: "EXHAUSTED",
    retry_epoch: 0
  };
}

test("TASK-RBT-005A relay rearm remains canonical after v60 Brain planning contract bump", async () => {
  const runtime = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(runtime, /SUPERVISOR_RUNTIME_VERSION = "2026-09-20\.60"/);
  assert.match(runtime, /--relay-rearm-fixture/);
  assert.match(runtime, /relay-rearm-acceptance-cli\.mjs/);
});

test("config and registry normalize monotonic Owner/applied relay rearm revisions", () => {
  const config = normalizeLaneConfig({
    lanes: [{
      lane_id: "lane-1",
      relay_retry_rearm_revision: 9,
      relay_retry_rearm_requested_at: "2026-09-20T14:30:00.000Z"
    }]
  });
  const registry = normalizeLaneRegistry({
    lanes: {
      "lane-1": { applied_relay_retry_rearm_revision: 8 }
    }
  });
  assert.equal(config.lanes[0].relay_retry_rearm_revision, 9);
  assert.equal(
    config.lanes[0].relay_retry_rearm_requested_at,
    "2026-09-20T14:30:00.000Z"
  );
  assert.equal(registry.lanes["lane-1"].applied_relay_retry_rearm_revision, 8);
});

test("Owner rearm with no relay latch is a consumed safe NOOP", () => {
  const outcome = rearmRelayRetry(null, { revision: 1, appliedRevision: 0 });
  assert.equal(outcome.status, RELAY_REARM_STATES.NO_LATCH);
  assert.equal(outcome.applied_revision, 1);
});

test("Owner rearm while relay is not exhausted is a consumed safe NOOP", () => {
  const latch = {
    relay_id: "a".repeat(32),
    attempt_count: 1,
    retry_exhausted: false,
    retry_epoch: 0
  };
  const before = JSON.stringify(latch);
  const outcome = rearmRelayRetry(latch, { revision: 2, appliedRevision: 1 });
  assert.equal(outcome.status, RELAY_REARM_STATES.NOT_EXHAUSTED);
  assert.equal(outcome.applied_revision, 2);
  assert.equal(JSON.stringify(latch), before);
});

test("RBT-010 exhausted relay opens one new bounded epoch without changing text relay identity", () => {
  const latch = exhaustedLatch();
  const identity = {
    relay_id: latch.relay_id,
    response_digest: latch.response_digest,
    text_digest: latch.text_digest
  };
  const outcome = rearmRelayRetry(latch, { revision: 1, appliedRevision: 0 });
  assert.equal(outcome.status, RELAY_REARM_STATES.REARMED);
  assert.equal(outcome.retry_epoch, 1);
  assert.equal(latch.attempt_count, 0);
  assert.equal(latch.retry_exhausted, false);
  assert.equal(latch.retry_not_before, null);
  assert.equal(latch.last_attempt_state, "OWNER_REARMED");
  assert.deepEqual({
    relay_id: latch.relay_id,
    response_digest: latch.response_digest,
    text_digest: latch.text_digest
  }, identity);
});

test("same Owner revision can apply at most once across restart", () => {
  const latch = exhaustedLatch();
  const first = rearmRelayRetry(latch, { revision: 3, appliedRevision: 2 });
  assert.equal(first.status, RELAY_REARM_STATES.REARMED);
  const restarted = JSON.parse(JSON.stringify(latch));
  const duplicate = rearmRelayRetry(restarted, {
    revision: 3,
    appliedRevision: 3
  });
  assert.equal(duplicate.status, RELAY_REARM_STATES.ALREADY_APPLIED);
  assert.equal(restarted.retry_epoch, 1);
  assert.equal(restarted.attempt_count, 0);
});

test("a new Owner revision after re-exhaustion opens exactly one later epoch", () => {
  const latch = exhaustedLatch();
  rearmRelayRetry(latch, { revision: 1, appliedRevision: 0 });
  latch.attempt_count = 3;
  latch.retry_exhausted = true;
  latch.last_attempt_state = "EXHAUSTED";
  const second = rearmRelayRetry(latch, { revision: 2, appliedRevision: 1 });
  assert.equal(second.status, RELAY_REARM_STATES.REARMED);
  assert.equal(second.retry_epoch, 2);
  assert.equal(latch.owner_rearm_revision, 2);
});

test("each rearmed epoch remains bounded to three attempts and never auto-rearms", () => {
  const latch = exhaustedLatch();
  rearmRelayRetry(latch, { revision: 1, appliedRevision: 0 });
  const now = Date.parse("2026-09-20T14:30:00.000Z");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    latch.retry_not_before = null;
    assert.equal(beginRelaySendAttempt(latch), attempt);
    const state = scheduleRelayRetry(latch, { now });
    assert.equal(
      state,
      attempt === 3 ? RELAY_RETRY_STATES.EXHAUSTED : RELAY_RETRY_STATES.WAIT
    );
  }
  assert.equal(relayRetryState(latch, now + 60_000_000), RELAY_RETRY_STATES.EXHAUSTED);
  assert.equal(latch.retry_epoch, 1);
});

test("RBT-010 runtime reconciles exact relay marker before rearm without screenshot prerequisites", async () => {
  const runtime = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  const start = runtime.indexOf("async function applyOwnerRelayRetryRearm");
  const end = runtime.indexOf("async function applyOwnerWorkTarget", start);
  const apply = runtime.slice(start, end);
  assert.ok(start >= 0 && end > start);
  const exhaustedPath = apply.slice(apply.indexOf("if (!brainPage)"));
  assert.ok(exhaustedPath.indexOf("hasRelayMarker") < exhaustedPath.indexOf("rearmRelayRetry"));
  assert.ok(exhaustedPath.indexOf("waitForStableSendSurface") < exhaustedPath.indexOf("rearmRelayRetry"));
  assert.match(exhaustedPath, /BRAIN_NOT_READY/);
  assert.match(apply, /finalizeConfirmedRelay/);
  assert.doesNotMatch(apply, /screenshot_path|EVIDENCE_MISSING|fs\.stat/);
  assert.doesNotMatch(apply, /clearRelayInflight/);
  assert.doesNotMatch(apply, /dispatchWork/);
  assert.doesNotMatch(apply, /sendComposer/);
  assert.doesNotMatch(apply, /registryLane\.task_id\s*=/);
  assert.doesNotMatch(apply, /registryLane\.awaiting_work\s*=/);
  assert.match(runtime, /RESULT_IDENTITY_MISMATCH/);
  assert.match(runtime, /FAIL_CLOSED_RECONSTRUCTED_RESULT_MISMATCH/);
  assert.match(runtime, /return "EVIDENCE_MISMATCH"/);
});

test("runtime opens exact persisted Brain through scheduler before exhausted rearm apply", async () => {
  const runtime = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(runtime, /openExactConversation\(adapter, brainUrl/);
  assert.match(runtime, /brain: true/);
  assert.match(runtime, /scheduler,/);
  const gate = runtime.slice(
    runtime.indexOf("const relayRearmRevision"),
    runtime.indexOf("if (registryLane.relay_inflight)", runtime.indexOf("const relayRearmRevision"))
  );
  assert.match(gate, /registryLane\.relay_inflight\?\.retry_exhausted/);
  assert.ok(gate.indexOf("ensureBrainPage") < gate.indexOf("applyOwnerRelayRetryRearm"));
});

test("Owner STOP is checked before any scheduler turn can apply pending rearm intent", async () => {
  const runtime = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  const loop = runtime.slice(
    runtime.indexOf("while (true)"),
    runtime.indexOf("const turn = scheduler.nextEnabledTurn")
  );
  assert.ok(loop.indexOf("fs.access(stopPath)") < loop.indexOf("normalizeLaneConfig"));
  assert.match(loop, /break;/);
});

test("Control Panel exposes bounded THỬ LẠI RELAY only for exhausted latch", async () => {
  const panel = await fs.readFile(
    new URL("../windows/control-panel.ps1", import.meta.url),
    "utf8"
  );
  assert.match(panel, /THỬ LẠI RELAY/);
  assert.match(panel, /Request-RelayRetryRearm/);
  assert.match(panel, /relay_retry_rearm_revision/);
  assert.match(panel, /applied_relay_retry_rearm_revision/);
  assert.match(panel, /retry_exhausted/);
  assert.match(panel, /relayRearmPending/);
  assert.match(panel, /RELAY HẾT LƯỢT THỬ/);
  assert.match(panel, /ĐÃ YÊU CẦU THỬ LẠI RELAY/);
  assert.match(panel, /Owner STOP/);
  assert.doesNotMatch(
    panel.slice(
      panel.indexOf("function Request-RelayRetryRearm"),
      panel.indexOf("function Save-BrainTarget")
    ),
    /brain_url|work_url|Start-Process|reset-work-state/
  );
});

test("relay rearm lifecycle events remain metadata-only and privacy allowlisted", () => {
  for (const [eventType, reasonCode] of [
    [LANE_EVENT_TYPES.RELAY_REARM_APPLIED, "OWNER_RELAY_REARM"],
    [LANE_EVENT_TYPES.RELAY_REARM_DEDUPED, "OWNER_RELAY_REARM_DEDUPED"],
    [LANE_EVENT_TYPES.RELAY_REARM_EXHAUSTED, "OWNER_RELAY_REARM_EXHAUSTED"]
  ]) {
    const event = serializeLaneEvent({
      timestamp: "2026-09-20T14:30:00.000Z",
      lane_id: "lane-1",
      actor: "SUPERVISOR",
      event_type: eventType,
      task_id: "TASK-RBT-005A",
      phase: eventType === LANE_EVENT_TYPES.RELAY_REARM_EXHAUSTED ? "ERROR" : "RECOVERY",
      reason_code: reasonCode,
      work_generation: 3,
      relay_id: "a".repeat(32)
    });
    const line = JSON.stringify(event);
    assert.equal(line.includes("chatgpt.com"), false);
    assert.equal(line.includes("screenshot_path"), false);
    assert.equal(line.includes("cookie"), false);
    assert.equal(line.includes("token"), false);
  }
});

test("installed-runtime acceptance fixture is production-state-free", async () => {
  const fixture = await fs.readFile(
    new URL("../src/runtime/relay-rearm-acceptance-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(fixture, /TASK_RESULT_TARGETS_PRESERVED=True/);
  assert.match(fixture, /MARKER_RECONCILE_BEFORE_REARM=True/);
  assert.match(fixture, /NO_AUTO_REARM=True/);
  assert.doesNotMatch(fixture, /LOCALAPPDATA|lane-registry\.json|lanes\.json|sendComposerWithAttachment|screenshot_path/);
});
