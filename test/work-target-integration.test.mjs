import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(rel) {
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

function functionSlice(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, "start needle missing: " + startNeedle);
  assert.ok(end > start, "end needle missing: " + endNeedle);
  return source.slice(start, end);
}

test("RBT-003 Work-target invariants remain intact after v60 Brain planning bump", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const applyWork = functionSlice(
    runtime,
    "async function applyOwnerWorkTarget",
    "async function applyPendingWorkTargetAtSafeBoundary"
  );

  assert.match(runtime, /SUPERVISOR_RUNTIME_VERSION = "2026-09-20\.60"/);
  assert.match(applyWork, /acceptOwnerWorkTargetRevision/);
  assert.match(applyWork, /WORK_TARGET_PENDING/);
  for (const forbidden of [
    /clearRelayInflight\(registryLane\)/,
    /registryLane\.task_id\s*=/,
    /registryLane\.dispatch_inflight\s*=/,
    /registryLane\.relay_inflight\s*=/,
    /registryLane\.awaiting_work\s*=/,
    /registryLane\.last_result_relay_id\s*=/
  ]) {
    assert.doesNotMatch(applyWork, forbidden);
  }
});

test("pending Work target is re-evaluated at the next bounded turn after old latch or relay reconciliation", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const processLaneTurn = functionSlice(
    runtime,
    "async function processLaneTurn",
    "async function processLane(args)"
  );

  const safeBoundary = processLaneTurn.indexOf("applyPendingWorkTargetAtSafeBoundary");
  const relayBranch = processLaneTurn.indexOf("if (registryLane.relay_inflight)");
  const dispatchBranch = processLaneTurn.indexOf("if (registryLane.dispatch_inflight)");
  const awaitingBranch = processLaneTurn.indexOf("if (registryLane.awaiting_work)");
  assert.ok(safeBoundary >= 0);
  assert.ok(relayBranch > safeBoundary);
  assert.ok(dispatchBranch > relayBranch);
  assert.ok(awaitingBranch > dispatchBranch);

  // Each latch reconciliation returns/yields. The next round re-enters the
  // safe-boundary guard, where RBT-003 active predicates decide whether the
  // pending target may apply.
  const relaySlice = processLaneTurn.slice(relayBranch, dispatchBranch);
  const dispatchSlice = processLaneTurn.slice(dispatchBranch, awaitingBranch);
  assert.match(relaySlice, /return laneStatus/);
  assert.match(dispatchSlice, /return laneStatus/);

  const relayCall = processLaneTurn.indexOf("relayWorkResult", awaitingBranch);
  assert.ok(relayCall > awaitingBranch);
  const tailAfterRelay = processLaneTurn.slice(relayCall);
  assert.match(tailAfterRelay, /return laneStatus/);
  assert.doesNotMatch(
    tailAfterRelay.slice(0, tailAfterRelay.indexOf("return laneStatus") + 200),
    /applyPendingWorkTargetAtSafeBoundary/
  );
});

test("Work target save preserves deterministic dispatch and relay exact-once contracts", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");

  assert.match(runtime, /const coreDispatchDigest = sha256\(JSON\.stringify/);
  assert.match(runtime, /const dispatchId = existingDispatchLatch\?\.dispatch_id \|\| sha256\(\[/);
  assert.match(runtime, /workDispatchMarker\(dispatchId\)/);
  assert.match(runtime, /registryLane\.dispatch_inflight = latch/);
  assert.match(runtime, /dispatch_identity_digest: dispatchIdentityDigest/);
  assert.match(runtime, /planning_contract_version: 1/);
  assert.match(runtime, /work_target_digest: targetDigest/);
  assert.match(runtime, /work_generation: Number\(registryLane\.work_generation/);
  assert.match(runtime, /finalizeConfirmedDispatch/);
  assert.match(runtime, /relayMarker\(relayId\)/);
  assert.match(runtime, /registryLane\.last_result_relay_id = latch\.relay_id/);
  assert.match(runtime, /finalizeConfirmedRelay/);
});

test("inaccessible Owner Work remains fail-closed instead of being auto-replaced", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");

  assert.match(runtime, /Work này không mở được trong Chrome Robot/);
  assert.match(runtime, /Work conversation is missing; automatic replacement is denied/);
  assert.match(runtime, /openExactConversation\(adapter, registryLane\.work_url/);
  assert.match(runtime, /brain: false/);
  assert.match(runtime, /targetRevision: Number\(registryLane\.applied_work_url_revision/);
  assert.doesNotMatch(
    functionSlice(runtime, "async function applyOwnerWorkTarget", "async function applyPendingWorkTargetAtSafeBoundary"),
    /createWorkConversation/
  );
});

test("Control Panel explicit Work save is canonical, atomic, no-churn, active-safe and Brain-independent", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const save = functionSlice(panel, "function Save-WorkTarget", "function Save-BrainTarget");

  assert.match(panel, /\$openWork\.Text = 'MỞ WORK'/);
  assert.match(panel, /\$saveWork\.Text = 'LƯU WORK'/);
  assert.match(panel, /\$resetWork\.Text = 'TỰ TẠO WORK'/);
  assert.match(save, /ConvertTo-CanonicalChatConversationUrl \$WorkUrl/);
  assert.match(save, /\$currentWorkUrl -eq \$newWorkUrl/);
  assert.match(save, /Changed = \$false/);
  assert.match(save, /work_url_saved_at/);
  assert.match(save, /Write-JsonAtomic \$configFile \$config/);
  assert.match(panel, /\$ui\.Work\.Enabled = \$true/);
  assert.match(panel, /\$ui\.SaveWork\.Enabled = \$true/);
  assert.match(panel, /\$ui\.ResetWork\.Enabled = \$true/);
  assert.match(panel, /ĐÃ LƯU WORK · revision/);
  assert.match(panel, /ĐANG CHỜ ÁP DỤNG/);

  const sameGuard = save.indexOf("$currentWorkUrl -eq $newWorkUrl");
  const revisionIncrement = save.indexOf("$lane.work_url_revision = [int]$lane.work_url_revision + 1");
  assert.ok(sameGuard >= 0 && revisionIncrement > sameGuard);

  assert.doesNotMatch(save, /brain_url\s*=/);
  assert.doesNotMatch(save, /brain_url_revision\s*=/);
  assert.doesNotMatch(save, /Start-Process/);
  assert.doesNotMatch(save, /Request-LifecycleRecovery/);
});

test("Control Panel invalid Work validation happens before target persistence", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const handler = functionSlice(
    panel,
    "$saveWork.Add_Click({",
    "$saveWork.Tag = $currentLaneId"
  );
  const validation = handler.indexOf("Test-ChatConversationUrl");
  const save = handler.indexOf("Save-WorkTarget");
  assert.ok(validation >= 0);
  assert.ok(save > validation);
  assert.match(handler, /LINK WORK không hợp lệ/);
});

test("maintenance reset is explicitly separated from ordinary Work target revision", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const workflow = await read("../../../.github/workflows/supervisor-state-maintenance.yml");

  const reset = functionSlice(
    runtime,
    "async function applyOwnerWorkStateReset",
    "async function applyOwnerWorkTarget"
  );
  assert.match(reset, /clearRelayInflight/);
  assert.match(reset, /applied_work_state_reset_revision/);
  assert.match(workflow, /work_state_reset_revision/);
  assert.match(workflow, /applied_work_state_reset_revision/);
  assert.doesNotMatch(workflow, /\$lane\.work_url_revision\s*=\s*\$newRevision/);
});

test("Work target operational events are metadata-only", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const events = await read("../src/runtime/lane-events.mjs");
  const emitter = functionSlice(
    runtime,
    "async function emitWorkTargetTransition",
    "async function applyOwnerWorkStateReset"
  );

  assert.match(events, /WORK_TARGET_SAVED/);
  assert.match(events, /WORK_TARGET_PENDING/);
  assert.match(events, /WORK_TARGET_APPLIED/);
  assert.match(events, /"work_url_revision"/);
  assert.doesNotMatch(emitter, /work_url:/);
  assert.doesNotMatch(emitter, /brain_url:/);
  assert.doesNotMatch(emitter, /instruction:/);
});

test("installed production acceptance runs fixture through exact runtime CLI without target mutation", async () => {
  const workflow = await read("../../../.github/workflows/supervisor-autostart-install.yml");
  const runtime = await read("../src/runtime/three-lane-cli.mjs");

  assert.match(runtime, /--work-target-fixture/);
  assert.match(runtime, /import\("\.\/work-target-acceptance-cli\.mjs"\)/);
  assert.match(workflow, /node \$runtimeCli --work-target-fixture/);
  assert.match(workflow, /WORK_TARGET_RUNTIME_ARTIFACT_FIXTURE=True/);
  assert.match(workflow, /WORK_TARGET_PRODUCTION_CONFIG_UNCHANGED=True/);
  assert.match(workflow, /WORK_TARGET_RUNTIME_PID_UNCHANGED=True/);
});

test("release workflows and repair derive runtime version from canonical source", async () => {
  const install = await read("../../../.github/workflows/supervisor-autostart-install.yml");
  const lifecycle = await read("../../../.github/workflows/supervisor-lifecycle-acceptance.yml");
  const repair = await read("../windows/repair-supervisor.ps1");

  for (const source of [install, lifecycle, repair]) {
    assert.match(source, /Get-SupervisorRuntimeVersion/);
    assert.doesNotMatch(source, /2026-09-19\.51/);
  }
  assert.match(install, /SUPERVISOR_RUNTIME_VERSION_MATCH=True/);
  assert.match(lifecycle, /LIFECYCLE_ACCEPTANCE_RUNTIME_VERSION_MATCH=True/);
});
