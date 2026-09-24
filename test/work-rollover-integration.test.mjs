import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(rel) {
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

function slice(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, "missing start " + startNeedle);
  assert.ok(end > start, "missing end " + endNeedle);
  return source.slice(start, end);
}

test("TASK-RBT-006 capacity/rollover remains canonical after v60 Brain planning contract bump", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  assert.match(runtime, /SUPERVISOR_RUNTIME_VERSION = "2026-09-20\.60"/);
  assert.equal((runtime.match(/from "\.\/work-capacity\.mjs"/g) || []).length, 1);
  assert.equal((runtime.match(/from "\.\/work-rollover\.mjs"/g) || []).length, 1);
});

test("single conversationFull regex no longer directly authorizes create/rollover", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  assert.doesNotMatch(runtime, /if \(probe\.snapshot\.conversationFull\)/);
  assert.doesNotMatch(runtime, /conversationFull[^\n]{0,120}createNew/s);
  assert.match(runtime, /probeStableWorkCapacity/);
  assert.match(runtime, /WORK_CAPACITY_STATES\.FULL_CONFIRMED/);
});

test("blank Work creation contains no task send and target persistence precedes dispatch latch", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const blank = slice(
    runtime,
    "async function createBlankWorkTarget",
    "async function dispatchWork"
  );
  assert.match(blank, /newChatPage/);
  assert.match(blank, /waitForConversationUrl/);
  assert.doesNotMatch(blank, /sendComposerInstruction/);
  assert.doesNotMatch(blank, /buildWorkDispatchInstruction/);

  const dispatch = slice(
    runtime,
    "async function dispatchWork",
    "async function reconcileRelayInflight"
  );
  const targetPersist = dispatch.indexOf("markRolloverTargetPersisted");
  const latchPersist = dispatch.indexOf("markRolloverDispatchLatchPersisted");
  const send = dispatch.indexOf("sendComposerInstruction");
  assert.ok(targetPersist >= 0);
  assert.ok(latchPersist > targetPersist);
  assert.ok(send > latchPersist);
});

test("new Work generation is adopted atomically with persisted target before send", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const dispatch = slice(
    runtime,
    "async function dispatchWork",
    "async function reconcileRelayInflight"
  );
  const generation = dispatch.indexOf("registryLane.work_generation = expectedGeneration");
  const target = dispatch.indexOf("registryLane.work_url = canonicalUrl");
  const persist = dispatch.indexOf("await atomicJsonWrite(registryPath, registry)", target);
  const send = dispatch.indexOf("sendComposerInstruction");
  assert.ok(target >= 0 && generation > target);
  assert.ok(persist > generation);
  assert.ok(send > persist);
});

test("dispatch latch correlates exact target digest, generation and deterministic dispatch id", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const dispatch = slice(
    runtime,
    "async function dispatchWork",
    "async function reconcileRelayInflight"
  );
  assert.match(dispatch, /work_generation: Number\(registryLane\.work_generation/);
  assert.match(dispatch, /work_target_digest: targetDigest/);
  assert.match(dispatch, /rollover_generation:/);
  assert.match(dispatch, /send_state: "PERSISTED_NOT_SENT"/);
  assert.match(dispatch, /send_attempted_at: null/);
  assert.match(dispatch, /workDispatchMarker\(dispatchId\)/);
});

test("crash after send intent reconciles marker before any rollover retry", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const reconcile = slice(
    runtime,
    "async function reconcileDispatchInflight",
    "async function emitWorkCapacityDecision"
  );
  assert.match(reconcile, /findWorkConversationForLatch/);
  assert.match(reconcile, /work_target_digest/);
  assert.match(reconcile, /send_attempted_at = null/);
  assert.match(reconcile, /send_state = "NOT_CONFIRMED"/);
  const rolloverBranch = reconcile.slice(
    reconcile.indexOf("if (latch.rollover_generation)"),
    reconcile.indexOf("registryLane.dispatch_inflight = null", reconcile.indexOf("if (latch.rollover_generation)"))
  );
  assert.doesNotMatch(rolloverBranch, /dispatch_inflight = null/);
  assert.match(rolloverBranch, /return "NOT_CONFIRMED"/);
});

test("Owner pending Work target is evaluated before automatic capacity rollover", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const turn = slice(runtime, "async function processLaneTurn", "async function processLane(args)");
  const pending = turn.indexOf("applyPendingWorkTargetAtSafeBoundary");
  const dispatch = turn.indexOf("dispatchWork({");
  assert.ok(pending >= 0 && dispatch > pending);
  const ownerApply = await read("../src/runtime/work-target-state.mjs");
  assert.doesNotMatch(ownerApply, /lane\?\.work_rollover/);
});

test("active Work replacement is evidence-gated while ordinary next-task dispatch keeps safe boundaries", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const turn = slice(runtime, "async function processLaneTurn", "async function processLane(args)");
  assert.match(turn, /activeReplacementRollover\(registryLane\)/);
  assert.match(turn, /recoverActiveWorkDirective/);
  assert.match(turn, /registryLane\.relay_inflight/);
  assert.match(turn, /registryLane\.dispatch_inflight/);
  assert.match(turn, /registryLane\.awaiting_work/);

  const dispatch = slice(runtime, "async function dispatchWork", "async function reconcileRelayInflight");
  assert.match(dispatch, /replacementContinuation/);
  assert.match(dispatch, /registryLane\.relay_inflight \|\| \(registryLane\.awaiting_work && !replacementContinuation\)/);
});

test("Owner STOP/lane disable is rechecked before blank creation and send mutation", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const dispatch = slice(runtime, "async function dispatchWork", "async function reconcileRelayInflight");
  const guards = dispatch.match(/isLaneMutationAllowed\(/g) || [];
  assert.ok(guards.length >= 3);
  assert.match(dispatch, /WORK_ROLLOVER_DISPATCH_SEND/);
});

test("send rejection capacity classification is persisted and never uses a forced probe send", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const dispatch = slice(runtime, "async function dispatchWork", "async function reconcileRelayInflight");
  assert.match(dispatch, /classifyComposerSendRejection/);
  assert.match(dispatch, /last_send_rejection/);
  assert.match(dispatch, /sendRejectionCapacity: true/);
  assert.doesNotMatch(dispatch, /sendComposerInstruction[\s\S]*?sendComposerInstruction[\s\S]*?capacity probe/i);
});

test("watchdog and rollover state remain separate domains", async () => {
  const state = await read("../src/runtime/three-lane.mjs");
  assert.match(state, /work_watchdog: normalizeWorkWatchdog/);
  assert.match(state, /work_rollover: normalizeWorkRollover/);
  const watchdog = await read("../src/runtime/work-watchdog.mjs");
  assert.doesNotMatch(watchdog, /FULL_CONFIRMED|work_rollover|conversationFull/);
});

test("relay rearm semantics remain independent of full rollover", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const rearmStart = runtime.indexOf("async function applyOwnerRelayRetryRearm");
  const rearmEnd = runtime.indexOf("async function applyOwnerWorkTarget", rearmStart);
  const rearm = runtime.slice(rearmStart, rearmEnd);
  assert.doesNotMatch(rearm, /work_rollover|WORK_CAPACITY/);
  assert.match(runtime, /RELAY HẾT LƯỢT THỬ/);
});

test("capacity/rollover events use metadata allowlist only", async () => {
  const events = await read("../src/runtime/lane-events.mjs");
  for (const value of [
    "WORK_FULL_EVIDENCE",
    "WORK_FULL_CONFIRMED",
    "WORK_FULL_AMBIGUOUS",
    "WORK_ROLLOVER_INTENT",
    "WORK_ROLLOVER_TARGET_PERSISTED",
    "WORK_ROLLOVER_DISPATCH_CONFIRMED"
  ]) {
    assert.match(events, new RegExp(value));
  }
  assert.doesNotMatch(events, /message_body|raw_dom|screenshot_path|cookie|token/);
});

test("RBT-006 runtime never creates or discovers a Brain target", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const dispatch = slice(runtime, "async function dispatchWork", "async function reconcileRelayInflight");
  assert.doesNotMatch(dispatch, /newChatPage[^\n]*BRAIN|create.*Brain|discover.*Brain/i);
  assert.doesNotMatch(dispatch, /brain_url\s*=/);
});

test("scheduler page budget and mutation singleton remain unchanged", async () => {
  const scheduler = await read("../src/runtime/browser-scheduler.mjs");
  assert.match(scheduler, /DEFAULT_CHATGPT_PAGE_BUDGET = 3/);
  assert.match(scheduler, /global browser mutation lease is already held/);
  assert.match(scheduler, /createPageUnderMutation/);
});
