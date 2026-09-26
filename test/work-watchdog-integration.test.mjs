import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(rel) {
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

function slice(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, "missing start: " + startNeedle);
  assert.ok(end > start, "missing end: " + endNeedle);
  return source.slice(start, end);
}

test("TASK-RBT-005 watchdog remains canonical after v60 Brain planning contract bump", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  assert.match(runtime, /SUPERVISOR_RUNTIME_VERSION = "2026-09-20\.60"/);
  assert.match(runtime, /from "\.\/work-watchdog\.mjs"/);
  assert.equal((runtime.match(/evaluateWorkWatchdog\(/g) || []).length, 1);
});

test("dispatch confirmation reload budget stays separate from execution watchdog reload budget", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const watchdog = await read("../src/runtime/work-watchdog.mjs");

  assert.match(runtime, /reconcile_reloaded/);
  assert.match(runtime, /reason: "WORK_RECONCILE_RELOAD"/);
  assert.match(runtime, /reason: "WATCHDOG_RECOVERY_RELOAD"/);
  assert.match(watchdog, /reload_count/);
  assert.match(watchdog, /recovery_epoch/);
  assert.doesNotMatch(watchdog, /reconcile_reloaded/);
  assert.doesNotMatch(watchdog, /dispatch_inflight\s*=/);
});

test("watchdog hard reload is behind global mutation lease and persists intent first", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const executor = slice(
    runtime,
    "async function executeWatchdogReload",
    "async function processLaneTurn"
  );

  const acquire = executor.indexOf("scheduler.acquireMutationLease");
  const intent = executor.indexOf("beginWatchdogReloadIntent");
  const persist = executor.indexOf("await atomicJsonWrite(registryPath, registry)", intent);
  const reload = executor.indexOf("await workPage.reload", persist);
  const release = executor.indexOf("releaseMutation?.({ durable: true })", reload);
  assert.ok(acquire >= 0);
  assert.ok(intent > acquire);
  assert.ok(persist > intent);
  assert.ok(reload > persist);
  assert.ok(release > reload);
  assert.match(executor, /reason: "WATCHDOG_RECOVERY_RELOAD"/);
});

test("watchdog re-verifies exact active task, target, applied revision and generation", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const identity = slice(runtime, "function watchdogIdentity(", "async function emitWatchdogDecisionEvents");
  assert.match(identity, /task_id: registryLane\.task_id/);
  assert.match(identity, /work_url: String\(registryLane\.work_url/);
  assert.match(identity, /work_generation: Number\(registryLane\.work_generation/);
  assert.match(identity, /work_url_revision: Number\(registryLane\.applied_work_url_revision/);

  const executor = slice(runtime, "async function executeWatchdogReload", "async function processLaneTurn");
  assert.ok((executor.match(/watchdogIdentityMatches/g) || []).length >= 3);
  assert.match(executor, /pageMatchesTarget\(workPage\.url\(\), exactTarget\)/);
});

test("Owner STOP and latest lane disable are re-read immediately before watchdog mutation", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const sharedGuard = slice(runtime, "async function isLaneMutationAllowed", "async function isWatchdogRecoveryAllowed");
  const watchdogGuard = slice(runtime, "async function isWatchdogRecoveryAllowed", "function watchdogIdentity");
  assert.match(sharedGuard, /isOwnerStopRequested\(stopPath\)/);
  assert.match(sharedGuard, /readJson\(configPath, defaultLaneConfig\(\)\)/);
  assert.match(sharedGuard, /Boolean\(lane\?\.enabled\)/);
  assert.match(watchdogGuard, /return isLaneMutationAllowed\(args\)/);

  const executor = slice(runtime, "async function executeWatchdogReload", "async function processLaneTurn");
  assert.ok((executor.match(/isWatchdogRecoveryAllowed/g) || []).length >= 2);
});

test("security/access guard occurs before execution watchdog decisions", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const safe = runtime.indexOf("const workProbe = await assertConversationSafe(adapter, workPage");
  const evaluate = runtime.indexOf("let watchdogDecision = await evaluateAndPersistWorkWatchdog", safe);
  assert.ok(safe >= 0);
  assert.ok(evaluate > safe);
  assert.match(runtime, /AUTH_REQUIRED/);
  assert.match(runtime, /MFA_REQUIRED/);
  assert.match(runtime, /CAPTCHA/);
});

test("one watchdog scheduler turn yields after STALL_CHECK, bounded reload, and bounded continue", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const turn = slice(runtime, "if (registryLane.awaiting_work)", "const captured = await captureCompletedAssistantTurn");
  assert.match(turn, /WORK_WATCHDOG_DECISIONS\.STALL_CHECK[\s\S]*?return laneStatus/);
  assert.match(turn, /executeWatchdogReload\([\s\S]*?return laneStatus/);
  assert.match(turn, /WORK_WATCHDOG_DECISIONS\.CONTINUE_ELIGIBLE[\s\S]*?executeWatchdogContinue\([\s\S]*?return laneStatus/);
});

test("post-reload continue persists exact-once intent before one safe UI mutation", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const executor = slice(
    runtime,
    "async function executeWatchdogContinue",
    "async function processLaneTurn"
  );

  const acquire = executor.indexOf("scheduler.acquireMutationLease");
  const marker = executor.indexOf("workDispatchMarker(registryLane.last_dispatch_id)");
  const intent = executor.indexOf("beginWatchdogContinueIntent");
  const persist = executor.indexOf(
    "await atomicJsonWrite(registryPath, registry)",
    intent
  );
  const mutate = executor.indexOf("await executeDecision", persist);
  const mark = executor.indexOf("markWatchdogContinued", mutate);
  const release = executor.indexOf("releaseMutation?.({ durable: true })", mark);

  assert.ok(acquire >= 0);
  assert.ok(marker > acquire);
  assert.ok(intent > marker);
  assert.ok(persist > intent);
  assert.ok(mutate > persist);
  assert.ok(mark > mutate);
  assert.ok(release > mark);
  assert.match(executor, /WATCHDOG_CONTINUE_INSTRUCTION/);
  assert.match(executor, /action: ACTIONS\.CONTINUE/);
  assert.match(executor, /SAFE_CONTINUE_CONTROL/);
  assert.match(runtime, /WATCHDOG_CONTINUE_INSTRUCTION = "Tiếp tục thực hiện\."/);
});

test("continue recovery re-verifies owner authority, exact target and task marker without resending the task", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const executor = slice(
    runtime,
    "async function executeWatchdogContinue",
    "async function processLaneTurn"
  );

  assert.ok((executor.match(/isWatchdogRecoveryAllowed/g) || []).length >= 2);
  assert.ok((executor.match(/watchdogIdentityMatches/g) || []).length >= 2);
  assert.match(executor, /pageMatchesTarget\(workPage\.url\(\), exactTarget\)/);
  assert.match(executor, /workDispatchMarker\(registryLane\.last_dispatch_id\)/);
  assert.doesNotMatch(executor, /buildWorkDispatchInstruction|WORK_DISPATCH_SEND/);
  assert.doesNotMatch(executor, /registryLane\.dispatch_inflight\s*=/);
  assert.doesNotMatch(executor, /registryLane\.task_id\s*=/);
});

test("watchdog does not clear/resend task, dispatch, relay, result or pending Work state", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const executor = slice(runtime, "async function executeWatchdogReload", "async function processLaneTurn");
  for (const forbidden of [
    /registryLane\.task_id\s*=/,
    /registryLane\.awaiting_work\s*=/,
    /registryLane\.dispatch_inflight\s*=/,
    /registryLane\.relay_inflight\s*=/,
    /registryLane\.pending_work_url\s*=/,
    /registryLane\.pending_work_url_revision\s*=/,
    /registryLane\.last_work_result_digest\s*=/,
    /sendComposerInstruction/,
    /sendComposerWithAttachment/,
    /createWorkConversation/
  ]) {
    assert.doesNotMatch(executor, forbidden);
  }
});

test("confirmed dispatch correlation is retained for post-reload marker reconciliation without resend", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  assert.match(runtime, /registryLane\.last_dispatch_id = latch\.dispatch_id/);
  const executor = slice(runtime, "async function executeWatchdogReload", "async function processLaneTurn");
  assert.match(executor, /workDispatchMarker\(registryLane\.last_dispatch_id\)/);
  assert.match(executor, /WATCHDOG_DISPATCH_MARKER_MISSING/);
  assert.doesNotMatch(executor, /WORK_DISPATCH_SEND/);
});

test("RBT-003 pending Work remains independent of watchdog state", async () => {
  const registry = await read("../src/runtime/three-lane.mjs");
  const watchdog = await read("../src/runtime/work-watchdog.mjs");
  assert.match(registry, /pending_work_url/);
  assert.match(registry, /pending_work_url_revision/);
  assert.match(registry, /work_watchdog/);
  assert.doesNotMatch(watchdog, /pending_work_url/);
  assert.doesNotMatch(watchdog, /work_url\s*:/);
});

test("RBT-004 page budget remains globally bounded at four and recovery uses existing scheduler page", async () => {
  const scheduler = await read("../src/runtime/browser-scheduler.mjs");
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  assert.match(scheduler, /DEFAULT_CHATGPT_PAGE_BUDGET = 4/);
  assert.match(runtime, /openExactConversation\(adapter, registryLane\.work_url/);
  assert.match(runtime, /scheduler,/);
  assert.match(runtime, /WATCHDOG_RECOVERY_RELOAD/);
  assert.doesNotMatch(
    slice(runtime, "async function executeWatchdogReload", "async function processLaneTurn"),
    /newChatPage|reopenTargetPage/
  );
});

test("safe activity extends retry/continue metadata without storing message body", async () => {
  const events = await read("../src/runtime/lane-events.mjs");
  assert.match(events, /continue_control/);
  assert.match(events, /retry_control/);
  assert.match(events, /CONTINUE_CONTROL_CHANGED/);
  assert.match(events, /RETRY_CONTROL_CHANGED/);
  const observation = slice(events, "export function buildSafeWorkObservation", "function activitySignals");
  assert.doesNotMatch(observation, /message_body|message_text|text_digest/);
});

test("watchdog event additions remain metadata-only", async () => {
  const events = await read("../src/runtime/lane-events.mjs");
  for (const type of [
    "WORK_LONG_RUNNING",
    "WATCHDOG_STALL_CHECK",
    "PAGE_RECOVERY_RELOAD",
    "WATCHDOG_CONTINUE_POKE",
    "WATCHDOG_PROGRESS_REARMED",
    "POSSIBLY_STALLED"
  ]) {
    assert.match(events, new RegExp(type));
  }
  const eventKeys = slice(events, "const EVENT_KEYS", "const ACTORS");
  assert.doesNotMatch(
    eventKeys,
    /"(?:brain_url|work_url|message_body|message_text|dom_text|cookie|token|screenshot_path)"/i
  );
});

test("TASK-RBT-005 introduces no Work-full detector or rollover semantics", async () => {
  const watchdog = await read("../src/runtime/work-watchdog.mjs");
  assert.doesNotMatch(watchdog, /FULL_CONFIRMED|conversationFull|rollover|createWork/i);
});
