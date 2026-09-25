import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(rel) {
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

test("RBT-007 observability remains canonical after runtime v60 planning bump", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  assert.match(runtime, /SUPERVISOR_RUNTIME_VERSION = "2026-09-20\.60"/);
  assert.match(runtime, /projectLaneOperationalStatus/);
  const laneStatusStart = runtime.indexOf("function laneStatus");
  const laneStatusEnd = runtime.indexOf("async function writeLaneStatus", laneStatusStart);
  const laneStatus = runtime.slice(laneStatusStart, laneStatusEnd);
  assert.match(laneStatus, /task_elapsed_ms|projectLaneOperationalStatus/);
  assert.doesNotMatch(laneStatus, /taskTimingMetrics\(/);
});

test("status schema remains additive v1 with scheduler snapshot", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const writeStart = runtime.indexOf("async function writeLaneStatus");
  const writeEnd = runtime.indexOf("async function assertConversationSafe", writeStart);
  const write = runtime.slice(writeStart, writeEnd);
  assert.match(write, /schema_version: "three-lane-status\.v1"/);
  assert.match(write, /scheduler: scheduler \? scheduler\.snapshot\(\) : null/);
  assert.match(write, /truth_order: \["PROCESS_TRUTH", "LANE_TRUTH", "PERSISTED_RECOVERY_STATE"\]/);
});

test("Control Panel never reads full lane-events file", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const helper = await read("../windows/control-panel-observability.ps1");
  assert.match(panel, /Read-BoundedLaneEventTail/);
  assert.doesNotMatch(panel, /Get-Content\s+\$eventFile/);
  assert.match(helper, /FileStream/);
  assert.match(helper, /Seek\(/);
  assert.match(helper, /MaxBytes = 262144/);
  assert.match(helper, /FileShare\]::ReadWrite/);
});

test("Control Panel timeline renders newest bounded event first", async () => {
  const panel = await fs.readFile(new URL("../windows/control-panel.ps1", import.meta.url), "utf8");
  const start = panel.indexOf("function Refresh-Timeline");
  const end = panel.indexOf("function Refresh-Ui", start);
  const timeline = panel.slice(start, end);

  assert.match(timeline, /for \(\$eventIndex = \$events\.Count - 1; \$eventIndex -ge 0; \$eventIndex--\)/);
  assert.match(timeline, /\$event = \$events\[\$eventIndex\]/);
});

test("Control Panel timeline render path contains no URL or opaque correlation columns", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("function Refresh-Timeline");
  const end = panel.indexOf("function Refresh-Ui", start);
  const timeline = panel.slice(start, end);
  assert.match(timeline, /event\.label/);
  assert.match(timeline, /event\.task_id/);
  assert.doesNotMatch(timeline, /brain_url|work_url|target_digest|dispatch_id|relay_id|cookie|token|screenshot/);
});

test("process truth composition precedes lane status rendering", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("function Refresh-Ui");
  const end = panel.indexOf("$timer = New-Object Windows.Forms.Timer", start);
  const refresh = panel.slice(start, end);
  const truth = refresh.indexOf("Get-LifecycleProcessTruth");
  const effective = refresh.indexOf("Get-ControlPanelEffectiveLaneState");
  const statusRender = refresh.indexOf("$ui.Status.Text");
  assert.ok(truth >= 0);
  assert.ok(effective > truth);
  assert.ok(statusRender > effective);
});

test("resource summary consumes local scheduler snapshot only", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("function Refresh-Ui");
  const end = panel.indexOf("$timer = New-Object Windows.Forms.Timer", start);
  const refresh = panel.slice(start, end);
  assert.match(refresh, /Get-ControlPanelResourceSummary/);
  assert.match(refresh, /TRANG CHATGPT:/);
  assert.doesNotMatch(refresh, /Invoke-RestMethod|reopenTargetPage|newChatPage|open-supervisor-chat/);
});

test("lane cards expose task phase elapsed activity revisions health watchdog and rollover", async () => {
  const panel = await read("../windows/control-panel.ps1");
  for (const needle of [
    "TASK:",
    "PHA:",
    "THỜI GIAN:",
    "HOẠT ĐỘNG CUỐI:",
    "WATCHDOG:",
    "cấu hình r",
    "áp dụng r",
    "pending r",
    "Get-ControlPanelTargetHealthText",
    "Get-ControlPanelRolloverText"
  ]) {
    assert.match(panel, new RegExp(needle));
  }
});

test("long and stalled states remain explicit, relay rearm remains Owner action", async () => {
  const panel = await read("../windows/control-panel.ps1");
  for (const state of ["WORKING_LONG","STALL_CHECK","POSSIBLY_STALLED"]) {
    assert.match(panel, new RegExp(state));
  }
  assert.match(panel, /THỬ LẠI RELAY/);
  assert.match(panel, /Request-RelayRetryRearm/);
});

test("viewport remains scrollable with critical controls and timeline inside logical canvas", async () => {
  const panel = await read("../windows/control-panel.ps1");
  assert.match(panel, /LogicalCanvasSize/);
  assert.match(panel, /AutoScrollMinSize/);
  assert.match(panel, /lane3_stop_bottom = 1047/);
  assert.match(panel, /timeline_bottom = 1485/);
  assert.match(panel, /critical_controls_scroll_reachable/);
});

test("observability probe is read-only and contains no target URL fields", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("if ($ObservabilityProbe)");
  const end = panel.indexOf("function Write-JsonAtomic", start);
  const probe = panel.slice(start, end);
  assert.match(probe, /Read-BoundedLaneEventTail/);
  assert.match(probe, /Get-LifecycleProcessTruth/);
  assert.doesNotMatch(probe, /Start-Process|Open-RobotUrl|Write-JsonAtomic|brain_url|work_url|target_digest/);
});

test("Autostart Work-target step has no cross-step Control Panel variable dependency", async () => {
  const workflow = await read("../.github/workflows/supervisor-autostart-install.yml");
  const start = workflow.indexOf("Verify Work target hot-swap fixture without production mutation");
  const end = workflow.indexOf("Verify browser scheduler fixture and live page budget without production mutation", start);
  assert.ok(start >= 0 && end > start);
  const block = workflow.slice(start, end);
  assert.doesNotMatch(block, /\$panelScript|\$panelFixture/);
});

test("Autostart release gate runs installed Control Panel fixture and read-only production probe", async () => {
  const workflow = await read("../.github/workflows/supervisor-autostart-install.yml");
  assert.match(workflow, /control-panel-observability-fixture\.ps1/);
  assert.match(workflow, /-ObservabilityProbe/);
  assert.match(workflow, /CONTROL_PANEL_PRODUCTION_TARGETS_UNCHANGED=True/);
  assert.match(workflow, /CONTROL_PANEL_PRODUCTION_TRUTH_UNCHANGED=True/);
  assert.match(workflow, /CONTROL_PANEL_RUNTIME_PID_UNCHANGED=True/);
  assert.match(workflow, /CONTROL_PANEL_NO_BROWSER_MUTATION=True/);
  assert.match(workflow, /Get-ControlPanelTruthFingerprint/);
  assert.match(workflow, /brain_target_health/);
  assert.match(workflow, /work_target_health/);
});
