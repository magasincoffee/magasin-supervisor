import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(rel) {
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

test("Control Center exposes only SINGLE_CONVERSATION_V1", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /SOURCE OF TRUTH/);
  assert.match(panel, /START ROBOT/);
  assert.match(panel, /STOP ROBOT/);
  assert.match(panel, /SINGLE_CONVERSATION_V1/);
  assert.match(panel, /single-conversation-control\.v1/);
  assert.match(panel, /source_of_truth_url/);
  assert.match(panel, /generation=/);
  assert.match(panel, /AUTOMATION:/);
  assert.match(panel, /SOURCE OF TRUTH SYNC:/);

  assert.doesNotMatch(panel, /THREE_LANE_V1/);
  assert.doesNotMatch(panel, /PLANNER_EXECUTOR_V1/);
  assert.doesNotMatch(panel, /BRAIN_WORKER_V1/);
  assert.doesNotMatch(panel, /Show-PlannerExecutorControlPanel/);
  assert.doesNotMatch(panel, /lanes\.json/);
  assert.doesNotMatch(panel, /lane-registry\.json/);
  assert.doesNotMatch(panel, /planner-executor/i);
  assert.doesNotMatch(panel, /SUPERVISOR_CONTROL_PANEL_LEGACY/);
});

test("START writes only Source of Truth control identity and starts canonical wrapper", async () => {
  const panel = await read("../windows/control-panel.ps1");

  const writeStart = panel.indexOf("function Write-SingleConversationControl");
  const writeEnd = panel.indexOf("function Refresh-SingleConversationUi", writeStart);
  const write = panel.slice(writeStart, writeEnd);

  assert.match(write, /schema_version = 'single-conversation-control\.v1'/);
  assert.match(write, /mode = 'SINGLE_CONVERSATION_V1'/);
  assert.match(write, /source_of_truth_url = \$source/);
  assert.doesNotMatch(write, /planner|executor|lane|chat_url|conversation_url/i);

  const clickStart = panel.indexOf("$startButton.Add_Click({");
  const clickEnd = panel.indexOf("$stopButton.Add_Click", clickStart);
  const handler = panel.slice(clickStart, clickEnd);
  assert.match(handler, /Write-SingleConversationControl/);
  assert.match(handler, /\$startScript/);
  assert.match(handler, /'-Hidden'/);
});

test("wrapper and lifecycle have no legacy runtime selector", async () => {
  const run = await read("../windows/run-supervisor.ps1");
  const lifecycle = await read("../windows/lifecycle-truth.ps1");

  for (const source of [run, lifecycle]) {
    assert.match(source, /SINGLE_CONVERSATION_V1/);
    assert.doesNotMatch(source, /THREE_LANE_V1/);
    assert.doesNotMatch(source, /PLANNER_EXECUTOR_V1/);
    assert.doesNotMatch(source, /BRAIN_WORKER_V1/);
  }

  assert.match(run, /src\/runtime\/single-conversation-cli\.mjs/);
  assert.match(run, /--source-of-truth/);
  assert.match(run, /--state/);
  assert.match(lifecycle, /Get-LifecycleSingleConversationProcess/);
  assert.match(lifecycle, /single_conversation_alive/);
});

test("durable BLOCKED state pauses wrapper instead of relaunching chat", async () => {
  const run = await read("../windows/run-supervisor.ps1");
  const blocked = run.indexOf("SINGLE_CONVERSATION_BLOCKED_PAUSE=True");
  const cdpRecovery = run.indexOf("$nodeExitCode -eq 75", blocked);
  assert.ok(blocked >= 0);
  assert.ok(cdpRecovery > blocked);
  const guard = run.slice(Math.max(0, blocked - 1800), cdpRecovery);
  assert.match(guard, /\$singleAutomationAfterRun -eq 'BLOCKED'/);
  assert.match(guard, /break/);
});
