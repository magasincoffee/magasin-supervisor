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

test("TASK-RBT-006A quarantine remains canonical after v60 Brain planning contract bump", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  assert.match(runtime, /SUPERVISOR_RUNTIME_VERSION = "2026-09-20\.60"/);
});

test("quarantine is checked before scheduler acquire/reopen in exact-target helper", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const open = slice(runtime, "async function openExactConversation", "async function runBrowserMutation");
  const gate = open.indexOf("isTargetQuarantined");
  const acquire = open.indexOf("scheduler.acquireExactPage");
  const reopen = open.indexOf("adapter.reopenTargetPage");
  assert.ok(gate >= 0);
  assert.ok(acquire > gate);
  assert.ok(reopen > gate);
});

test("process lane short-circuits quarantined targets before any ensure Brain page", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const turn = slice(runtime, "async function processLaneTurn", "async function processLane(args)");
  const brainGate = turn.indexOf("currentTargetIsQuarantined(registryLane, { brain: true })");
  const workGate = turn.indexOf("currentTargetIsQuarantined(registryLane, { brain: false })");
  const ensureBrain = turn.indexOf("const ensureBrainPage");
  assert.ok(brainGate >= 0 && brainGate < ensureBrain);
  assert.ok(workGate >= 0 && workGate < ensureBrain);
  assert.match(turn, /"WAIT_OWNER"/);
});

test("deterministic unavailable target is persisted before dead page cleanup", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const persist = slice(runtime, "async function persistTargetQuarantine", "async function markExactTargetHealthyOnce");
  const write = persist.indexOf("atomicJsonWrite");
  const invalidate = persist.indexOf("invalidateExactPage");
  assert.ok(write >= 0 && invalidate > write);
  assert.match(persist, /TARGET_QUARANTINED/);
});

test("same URL save cannot clear quarantine; clear is tied to different target digest", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const helper = slice(runtime, "function adoptCurrentTargetHealth", "async function emitTargetQuarantineCleared");
  assert.match(helper, /before\.target_digest !== identity\.target_digest/);
  assert.match(helper, /adoptTargetHealthIdentity/);
});

test("Work state reset does not clear target quarantine", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const reset = slice(runtime, "async function applyOwnerWorkStateReset", "async function emitRelayRearmLifecycleEvent");
  assert.doesNotMatch(reset, /work_target_health\s*=/);
  assert.doesNotMatch(reset, /defaultTargetHealth/);
});

test("watchdog refuses to reload a quarantined Work", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const watchdog = slice(runtime, "async function executeWatchdogReload", "async function processLaneTurn");
  const gate = watchdog.indexOf("currentTargetIsQuarantined(registryLane, { brain: false })");
  const reload = watchdog.indexOf("workPage.reload");
  assert.ok(gate >= 0 && reload > gate);
  assert.match(watchdog, /TARGET_QUARANTINED/);
});

test("Brain relay/rearm cannot reach exact Brain page when Brain target is quarantined", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const turn = slice(runtime, "async function processLaneTurn", "async function processLane(args)");
  const gate = turn.indexOf("currentTargetIsQuarantined(registryLane, { brain: true })");
  const relay = turn.indexOf("registryLane.relay_inflight");
  const ensure = turn.indexOf("await ensureBrainPage()", relay);
  assert.ok(gate >= 0);
  assert.ok(ensure > gate);
});

test("adapter and scheduler expose dead target cache/page invalidation", async () => {
  const adapter = await read("../src/ui/playwright-adapter.mjs");
  const scheduler = await read("../src/runtime/browser-scheduler.mjs");
  assert.match(adapter, /invalidateTargetRecoveryPage/);
  assert.match(adapter, /targetRecoveryPages\.delete/);
  assert.match(scheduler, /invalidateExactPage/);
  assert.match(scheduler, /ACTIVE_MUTATION/);
  assert.match(scheduler, /hasNonPersistedComposerArtifact/);
  assert.match(scheduler, /PAGE_LEASE_STATES\.CLOSED/);
});

test("RBT-006 missing signal remains a capacity guard rather than FULL evidence", async () => {
  const capacity = await read("../src/runtime/work-capacity.mjs");
  assert.match(capacity, /CONVERSATION_MISSING_GUARD/);
  assert.match(capacity, /conversation_missing/);
});

test("quarantine events are metadata-only and URL-free", async () => {
  const events = await read("../src/runtime/lane-events.mjs");
  assert.match(events, /TARGET_QUARANTINED/);
  assert.match(events, /target_role/);
  assert.match(events, /target_digest/);
  assert.match(events, /target_revision/);
  const keys = slice(events, "const EVENT_KEYS", "const ACTORS");
  assert.doesNotMatch(
    keys,
    /"url"|"message_body"|"raw_dom"|"cookie"|"token"/i
  );
});

test("RBT-006 installed fixture binds every rollover target digest explicitly", async () => {
  const fixture = await read("../src/runtime/work-full-acceptance-cli.mjs");
  assert.ok((fixture.match(/oldWorkTargetDigest: oldTargetDigest/g) || []).length >= 2);
  assert.ok((fixture.match(/newWorkTargetDigest: newTargetDigest/g) || []).length >= 2);
  assert.doesNotMatch(fixture, /\n\s*oldWorkTargetDigest,\n/);
  assert.doesNotMatch(fixture, /\n\s*newWorkTargetDigest,\n/);
  assert.doesNotMatch(fixture, /\n\s*oldTargetDigest,\n/);
});
