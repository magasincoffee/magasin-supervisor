import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(rel) {
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

test("Control Panel selects a single-project Planner/Executor surface in production mode", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /planner-executor-state\.json/);
  assert.match(panel, /planner-executor-status\.json/);
  assert.match(panel, /function Show-PlannerExecutorControlPanel/);
  assert.match(panel, /PLANNER \/ EXECUTOR\s+•\s+1 DỰ ÁN\s+•\s+2 CHATGPT THƯỜNG/);
  assert.match(panel, /ChatGPT Work mode: 0/);
  assert.match(panel, /MỞ PLANNER/);
  assert.match(panel, /MỞ EXECUTOR/);
  assert.match(panel, /START ROBOT/);
  assert.match(panel, /STOP ROBOT/);
  assert.match(panel, /TASK ĐANG HOẠT ĐỘNG/);
  assert.match(panel, /PHA RUNTIME/);
  assert.match(panel, /ChatGPT Work mode invocations/);
});

test("Planner/Executor production panel is selected before legacy Three-Lane UI construction", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const selector = panel.indexOf("$plannerExecutorPanelState = Read-JsonFile $plannerExecutorStateFile");
  const legacyForm = panel.indexOf("$form = New-Object Windows.Forms.Form", selector + 1);

  assert.ok(selector >= 0);
  assert.ok(legacyForm > selector);
  assert.match(
    panel.slice(selector, legacyForm),
    /mode -eq 'PLANNER_EXECUTOR_V1'[\s\S]*Show-PlannerExecutorControlPanel[\s\S]*exit 0/
  );
});

test("legacy three-lane Control Panel remains available only as rollback-compatible UI", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /for \(\$i = 0; \$i -lt 3; \$i\+\+\)/);
  assert.match(panel, /THREE_LANE_V1/);
  assert.match(panel, /Legacy 3-lane UI chỉ xuất hiện khi rollback về THREE_LANE_V1/);
});

test("production panel opens exact durable Planner and Executor targets", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("function Show-PlannerExecutorControlPanel");
  const end = panel.indexOf("$plannerExecutorPanelState =", start);
  const productionPanel = panel.slice(start, end);

  assert.match(productionPanel, /Open-RobotUrl/);
  assert.match(productionPanel, /Get-OptionalPropertyValue \$planner 'target'/);
  assert.match(productionPanel, /Get-OptionalPropertyValue \$executor 'target'/);
  assert.doesNotMatch(productionPanel, /Save-BrainTarget|Save-WorkTarget|TỰ TẠO WORK/);
});

test("production START is explicit Owner START and STOP covers Planner/Executor orphans", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const stop = await read("../windows/stop-supervisor.ps1");

  const start = panel.indexOf("function Show-PlannerExecutorControlPanel");
  const end = panel.indexOf("$plannerExecutorPanelState =", start);
  const productionPanel = panel.slice(start, end);

  assert.match(productionPanel, /start-supervisor\.ps1/);
  assert.match(productionPanel, /'-Hidden'/);
  assert.doesNotMatch(productionPanel, /'-Recovery'/);
  assert.match(productionPanel, /stop-supervisor\.ps1/);
  assert.match(stop, /planner-executor-cli/);
});

test("production panel refresh uses Planner/Executor lifecycle truth, not legacy lane status", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("function Refresh-PlannerExecutorUi");
  const end = panel.indexOf("$startButton.Add_Click", start);
  const refresh = panel.slice(start, end);

  assert.match(refresh, /Get-LifecycleProcessTruth/);
  assert.match(refresh, /runtime_mode -eq 'PLANNER_EXECUTOR_V1'/);
  assert.match(refresh, /planner_executor_alive/);
  assert.match(refresh, /chatgpt_tabs/);
  assert.match(refresh, /chatgpt_work_mode_invocations/);
  assert.doesNotMatch(refresh, /lane-status\.json|lane-registry\.json|brain_url|work_url/);
});
