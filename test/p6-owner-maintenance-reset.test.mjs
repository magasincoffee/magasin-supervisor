import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(rel) {
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

test("P6 UI exposes a dedicated BỎ TASK CŨ maintenance action distinct from AUTO Work", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /TỰ TẠO WORK/);
  assert.match(panel, /BỎ TASK CŨ/);
  assert.match(panel, /Request-OwnerWorkStateReset/);
  assert.match(panel, /RESET WORK STATE \/ BỎ TASK CŨ/);
  assert.match(panel, /Đây KHÔNG phải Work rollover bình thường/);
});

test("P6 Owner reset request mutates only lane config revision, never lane-registry", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("function Request-OwnerWorkStateReset");
  const end = panel.indexOf("function Request-RelayRetryRearm", start);
  assert.ok(start >= 0 && end > start);
  const fn = panel.slice(start, end);

  assert.match(fn, /Get-LaneConfig \$config \$LaneId/);
  assert.match(fn, /work_state_reset_revision/);
  assert.match(fn, /\+ 1/);
  assert.match(fn, /Write-JsonAtomic \$configFile \$config/);
  assert.doesNotMatch(fn, /registryFile|lane-registry|applied_work_state_reset_revision/);
  assert.doesNotMatch(fn, /brain_url\s*=|work_url\s*=|work_url_revision\s*=|brain_url_revision\s*=/);
});

test("P6 destructive maintenance requires two affirmative confirmations before revision increment", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("$abandonTaskButton.Add_Click({");
  const end = panel.indexOf("$retryRelayButton.Add_Click({", start);
  assert.ok(start >= 0 && end > start);
  const handler = panel.slice(start, end);

  assert.match(handler, /XÁC NHẬN BẢO TRÌ 1\/2/);
  assert.match(handler, /XÁC NHẬN BẢO TRÌ 2\/2/);
  assert.equal(
    [...handler.matchAll(/DialogResult\]::Yes/g)].length,
    2
  );
  const firstGuard = handler.indexOf("DialogResult]::Yes");
  const secondGuard = handler.indexOf("DialogResult]::Yes", firstGuard + 1);
  const request = handler.indexOf("Request-OwnerWorkStateReset");
  assert.ok(firstGuard >= 0 && secondGuard > firstGuard && request > secondGuard);
  assert.match(handler, /Brain URL và Work URL hiện tại sẽ được giữ nguyên/);
});

test("P6 pending reset revision disables duplicate destructive requests", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(
    panel,
    /\$ui\.AbandonTask\.Enabled = \[bool\]\(\$workResetRequested -le \$workResetApplied\)/
  );
  assert.match(panel, /WORK RESET requested r/);
  assert.match(panel, /applied r/);
});

test("P6 runtime reset retires obsolete execution state and allows a fresh Brain handshake", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const start = runtime.indexOf("async function applyOwnerWorkStateReset");
  const end = runtime.indexOf("async function emitRelayRearmLifecycleEvent", start);
  assert.ok(start >= 0 && end > start);
  const reset = runtime.slice(start, end);

  for (const fragment of [
    "await clearRelayInflight(registryLane)",
    "registryLane.task_id = null",
    "registryLane.instruction_digest = null",
    "registryLane.last_brain_directive_digest = null",
    "registryLane.last_work_result_digest = null",
    "registryLane.last_result_relay_id = null",
    "registryLane.last_result_verdict = null",
    "registryLane.last_dispatch_id = null",
    "registryLane.dispatch_inflight = null",
    "registryLane.brain_request_sent = false",
    "registryLane.brain_request_inflight = null",
    "registryLane.brain_directive_adopted = null",
    "registryLane.awaiting_work = false",
    "registryLane.work_rollover = null",
    "registryLane.pending_work_url = \"\"",
    "registryLane.pending_work_url_revision = 0",
    "registryLane.work_generation = Number(registryLane.work_generation || 0) + 1",
    "registryLane.applied_work_state_reset_revision = revision"
  ]) {
    assert.ok(reset.includes(fragment), `missing reset fragment: ${fragment}`);
  }

  assert.doesNotMatch(reset, /registryLane\.brain_url\s*=/);
  assert.doesNotMatch(reset, /registryLane\.work_url\s*=/);
  assert.doesNotMatch(reset, /registryLane\.applied_work_url_revision\s*=/);
  assert.doesNotMatch(reset, /registryLane\.brain_target_health\s*=/);
  assert.doesNotMatch(reset, /registryLane\.work_target_health\s*=/);
});

test("P6 reset application remains revision-gated and exact-once", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const start = runtime.indexOf("async function applyOwnerWorkStateReset");
  const end = runtime.indexOf("async function emitRelayRearmLifecycleEvent", start);
  const reset = runtime.slice(start, end);

  assert.match(
    reset,
    /if \(revision <= Number\(registryLane\.applied_work_state_reset_revision \|\| 0\)\) \{\s*return false;/
  );
  assert.match(reset, /registryLane\.applied_work_state_reset_revision = revision/);
  assert.match(reset, /LANE_OWNER_MAINTENANCE_WORK_STATE_RESET/);
});
