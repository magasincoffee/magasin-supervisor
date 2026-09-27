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


test("production panel exposes editable Planner and Executor URL inputs with guarded save", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("function Show-PlannerExecutorControlPanel");
  const end = panel.indexOf("$plannerExecutorPanelState =", start);
  const productionPanel = panel.slice(start, end);

  assert.match(panel, /function Save-PlannerExecutorTargets/);
  assert.match(productionPanel, /LINK CHAT PLANNER/);
  assert.match(productionPanel, /LINK CHAT EXECUTOR/);
  assert.match(productionPanel, /LƯU 2 LINK CHAT/);
  assert.match(productionPanel, /Save-PlannerExecutorTargets \$plannerBox\.Text\.Trim\(\) \$executorBox\.Text\.Trim\(\)/);
  assert.match(panel, /ConvertTo-CanonicalChatConversationUrl \$PlannerUrl/);
  assert.match(panel, /ConvertTo-CanonicalChatConversationUrl \$ExecutorUrl/);
  assert.match(panel, /Planner và Executor phải là hai cuộc trò chuyện ChatGPT khác nhau/);
});

test("target edits are fail-closed while Robot is running or transfer state is active", async () => {
  const panel = await read("../windows/control-panel.ps1");

  const saveStart = panel.indexOf("function Save-PlannerExecutorTargets");
  const saveEnd = panel.indexOf("function Show-PlannerExecutorControlPanel", saveStart);
  const save = panel.slice(saveStart, saveEnd);
  assert.match(save, /if \(\[bool\]\$truth\.wrapper_alive\)/);
  assert.match(save, /Hãy STOP ROBOT trước khi đổi link Planner\/Executor/);
  assert.match(save, /assignment/);
  assert.match(save, /result/);

  const refreshStart = panel.indexOf("function Refresh-PlannerExecutorUi");
  const refreshEnd = panel.indexOf("$startButton.Add_Click", refreshStart);
  const refresh = panel.slice(refreshStart, refreshEnd);
  assert.match(refresh, /\$safeToEditTargets/);
  assert.match(refresh, /\$plannerBox\.ReadOnly = -not \$safeToEditTargets/);
  assert.match(refresh, /\$executorBox\.ReadOnly = -not \$safeToEditTargets/);
  assert.match(refresh, /\$saveTargetsButton\.Enabled = \$safeToEditTargets/);
});

test("changing a target bumps only its revision and resets latest-turn cursor", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const saveStart = panel.indexOf("function Save-PlannerExecutorTargets");
  const saveEnd = panel.indexOf("function Show-PlannerExecutorControlPanel", saveStart);
  const save = panel.slice(saveStart, saveEnd);

  assert.match(save, /\$planner\.target_revision = \[int\].*\+ 1/);
  assert.match(save, /\$executor\.target_revision = \[int\].*\+ 1/);
  assert.match(save, /\$planner\.last_seen_assistant_turn_id = \$null/);
  assert.match(save, /\$executor\.last_seen_assistant_turn_id = \$null/);
  assert.match(save, /Write-JsonAtomic \$plannerExecutorStateFile \$state/);
});
