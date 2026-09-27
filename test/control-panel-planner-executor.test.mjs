import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(rel) {
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

test("production Control Panel exposes Source of Truth, profiles, progress, Planner and Executor", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /planner-executor-projects\.json/);
  assert.match(panel, /planner-executor-projects/);
  assert.match(panel, /function Show-PlannerExecutorControlPanel/);
  assert.match(panel, /MULTI-PROJECT PROFILES/);
  assert.match(panel, /SOURCE OF TRUTH/);
  assert.match(panel, /NẠP DỰ ÁN/);
  assert.match(panel, /LƯU PROFILE/);
  assert.match(panel, /TIẾN ĐỘ DỰ ÁN/);
  assert.match(panel, /ProgressBar/);
  assert.match(panel, /MỞ PLANNER/);
  assert.match(panel, /MỞ EXECUTOR/);
  assert.match(panel, /START ROBOT/);
  assert.match(panel, /STOP ROBOT/);
  assert.match(panel, /ChatGPT Work mode: 0/);
});

test("project profiles keep one active project while preserving per-project state snapshots", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /schema_version='planner-executor-projects\.v1'/);
  assert.match(panel, /active_project_id/);
  assert.match(panel, /Get-ProjectProfileStatePath/);
  assert.match(panel, /Save-ActiveProjectSnapshot/);
  assert.match(panel, /Switch-PlannerExecutorProject/);
  assert.match(panel, /state_file/);
  assert.match(panel, /1 active project \/ 2 normal ChatGPT tabs/);
});

test("project switch and active-profile mutation are fail-closed around Robot or in-flight transfer", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /function Assert-SafeProjectMutation/);
  assert.match(panel, /Hãy STOP ROBOT trước khi lưu hoặc chuyển dự án/);
  assert.match(panel, /assignment\/result đang mở/);
  assert.match(panel, /Project đang active còn assignment\/result mở/);
  assert.match(panel, /\$loadProjectButton\.Enabled=\$safeToSwitch/);
});

test("Source of Truth change and project switch re-arm Planner bootstrap with generation", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /project_generation/);
  assert.match(panel, /project_context_bootstrap/);
  assert.match(panel, /New-ProjectContextBootstrap/);
  assert.match(panel, /strict_correlation = \$false/);
  assert.match(panel, /Planner sẽ đọc lại Source of Truth ở câu lệnh đầu tiên/);
});

test("project progress is rendered from durable Planner/Executor project_progress", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("function Refresh-PlannerExecutorUi");
  const end = panel.indexOf("$saveProjectButton.Add_Click", start);
  const refresh = panel.slice(start, end);

  assert.match(refresh, /project_progress/);
  assert.match(refresh, /completed_tasks/);
  assert.match(refresh, /total_tasks/);
  assert.match(refresh, /percent/);
  assert.match(refresh, /\$progressBar\.Value=\$percent/);
});

test("production START requires Source of Truth plus two valid normal ChatGPT targets", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("$startButton.Add_Click({");
  const end = panel.indexOf("$stopButton.Add_Click", start);
  const handler = panel.slice(start, end);

  assert.match(handler, /ConvertTo-CanonicalSourceOfTruthUrl/);
  assert.match(handler, /Test-ChatConversationUrl \$planner/);
  assert.match(handler, /Test-ChatConversationUrl \$executor/);
  assert.match(handler, /'-Hidden'/);
  assert.doesNotMatch(handler, /'-Recovery'/);
});

test("legacy Three-Lane UI remains rollback-compatible but is bypassed in Planner/Executor mode", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const selector = panel.indexOf("$plannerExecutorPanelState = Read-JsonFile $plannerExecutorStateFile");
  const legacyForm = panel.indexOf("$form = New-Object Windows.Forms.Form", selector + 1);

  assert.ok(selector >= 0);
  assert.ok(legacyForm > selector);
  assert.match(
    panel.slice(selector, legacyForm),
    /mode -eq 'PLANNER_EXECUTOR_V1'[\s\S]*Show-PlannerExecutorControlPanel[\s\S]*exit 0/
  );
  assert.match(panel, /for \(\$i = 0; \$i -lt 3; \$i\+\+\)/);
  assert.match(panel, /THREE_LANE_V1/);
});
