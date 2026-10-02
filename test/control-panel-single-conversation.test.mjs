import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(rel) {
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

test("Control Center is SINGLE_CONVERSATION_V1 only", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /function Show-SingleConversationControlPanel/);
  assert.match(panel, /SOURCE OF TRUTH/);
  assert.match(panel, /START ROBOT/);
  assert.match(panel, /STOP ROBOT/);
  assert.match(panel, /OPEN CHATGPT/);
  assert.match(panel, /single-conversation-control\.v1/);
  assert.match(panel, /mode='SINGLE_CONVERSATION_V1'/);
  assert.match(panel, /source_of_truth_url=\$source/);
  assert.match(panel, /generation=/);
  assert.match(panel, /AUTOMATION:/);
  assert.match(panel, /LOCAL WATCHDOG:/);

  assert.doesNotMatch(panel, /THREE_LANE_V1/);
  assert.doesNotMatch(panel, /PLANNER_EXECUTOR_V1/);
  assert.doesNotMatch(panel, /BRAIN_WORKER_V1/);
  assert.doesNotMatch(panel, /lane-[123]/);
  assert.doesNotMatch(panel, /Planner URL|Executor URL|Brain URL|Work URL/i);
});

test("START writes only Source of Truth control identity", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("function Write-SingleConversationControl");
  const end = panel.indexOf("if($ViewportProbe)", start);
  const write = panel.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(write, /schema_version='single-conversation-control\.v1'/);
  assert.match(write, /mode='SINGLE_CONVERSATION_V1'/);
  assert.match(write, /source_of_truth_url=\$source/);
  assert.doesNotMatch(write, /planner|executor|brain_url|work_url|conversation_url/i);
});

test("wrapper and lifecycle expose only SINGLE_CONVERSATION_V1", async () => {
  const run = await read("../windows/run-supervisor.ps1");
  const lifecycle = await read("../windows/lifecycle-truth.ps1");

  assert.match(run, /src\/runtime\/single-conversation-cli\.mjs/);
  assert.match(run, /--source-of-truth/);
  assert.match(run, /--state/);
  assert.match(run, /SINGLE_CONVERSATION_BLOCKED_PAUSE=True/);
  assert.doesNotMatch(run, /three-lane|planner-executor|brain-worker|supervisor-loop/i);

  assert.match(lifecycle, /Get-LifecycleSingleConversationProcess/);
  assert.match(lifecycle, /single_conversation_alive/);
  assert.match(lifecycle, /return 'SINGLE_CONVERSATION_V1'/);
  assert.doesNotMatch(lifecycle, /Get-LifecycleThreeLane|Get-LifecyclePlannerExecutor/);
});
