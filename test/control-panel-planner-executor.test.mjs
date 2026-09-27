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
  assert.match(panel, /TẠO PROFILE MỚI/);
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
  assert.match(panel, /1 ACTIVE PROJECT/);
  assert.match(panel, /ChatGPT tabs:/);
});

test("stopped projects may be parked with in-flight state while Source changes stay fail-closed", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /function Assert-SafeProjectMutation/);
  assert.match(panel, /Hãy STOP ROBOT trước khi chuyển project active/);
  assert.match(panel, /A stopped project may be parked with an in-flight assignment\/result/);
  assert.match(panel, /Park the current project exactly as-is/);
  assert.match(panel, /Switching active projects is not a project reset/);
  assert.match(panel, /Bạn đang sửa SOURCE của project ACTIVE/);
  assert.match(panel, /Nếu đây là dự án khác, bấm TẠO PROFILE MỚI/);
  assert.match(panel, /\$oldPlannerRevision/);
  assert.match(panel, /\$oldExecutorRevision/);
  assert.match(panel, /previous_target/);
  assert.match(panel, /\$safeToSwitch=\[bool\]\(\$robotStopped\)/);
  assert.match(panel, /\$sourceSafeToEdit=\[bool\]\(\$robotStopped -and -not \$hasTransfer\)/);
  assert.match(panel, /\$loadProjectButton\.Enabled=\[bool\]\(\$safeToSwitch/);
});

test("profile editor can create and inspect inactive projects without being clobbered by active runtime refresh", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /function Set-ProjectProfileEditor/);
  assert.match(panel, /function Begin-NewProjectProfileDraft/);
  assert.match(panel, /SelectionChangeCommitted/);
  assert.match(panel, /TẠO PROFILE MỚI/);
  assert.match(panel, /if \(\$editingActiveProfile -and -not \$profileEditor\.Dirty\) \{/);
  assert.match(panel, /\$editorPlannerReady=Test-ChatConversationUrl \(\$plannerBox\.Text\.Trim\(\)\)/);
  assert.match(panel, /DỰ ÁN KHÁC: bấm TẠO PROFILE MỚI/);
  assert.match(panel, /function Prompt-NewProjectProfileId/);
  assert.match(panel, /PROJECT ID MỚI/);
  assert.match(panel, /\$projectSelector\.SelectedIndex = -1/);
  assert.match(panel, /Draft mới không được ghi đè profile hiện có/);
});

test("Source of Truth change re-arms bootstrap while project switch preserves generation and pending state", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /project_generation/);
  assert.match(panel, /project_context_bootstrap/);
  assert.match(panel, /New-ProjectContextBootstrap/);
  assert.match(panel, /strict_correlation = \$false/);
  assert.match(panel, /Planner sẽ đọc lại Source of Truth ở câu lệnh đầu tiên/);

  const switchStart = panel.indexOf("function Switch-PlannerExecutorProject");
  const switchEnd = panel.indexOf("function Show-PlannerExecutorControlPanel", switchStart);
  const switchBody = panel.slice(switchStart, switchEnd);
  assert.doesNotMatch(switchBody, /project_generation = \[int\]\$state\.project_generation \+ 1/);
  assert.doesNotMatch(switchBody, /last_seen_assistant_turn_id = \$null/);
  assert.match(switchBody, /Save-ActiveProjectSnapshot/);
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

test("production START activates the selected saved profile, then validates Source and Chat targets", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("$startButton.Add_Click({");
  const end = panel.indexOf("$stopButton.Add_Click", start);
  const handler = panel.slice(start, end);

  assert.match(handler, /Profile đang có thay đổi chưa lưu/);
  assert.match(handler, /Get-PlannerExecutorProjectProfile/);
  assert.match(handler, /if \(\$selectedId -ne \$activeId\)/);
  assert.match(handler, /Switch-PlannerExecutorProject \$selectedId/);
  assert.match(handler, /ConvertTo-CanonicalSourceOfTruthUrl/);
  assert.match(handler, /Test-ChatConversationUrl \$planner/);
  assert.match(handler, /Test-ChatConversationUrl \$executor/);
  assert.match(handler, /'-Hidden'/);
  assert.doesNotMatch(handler, /'-Recovery'/);

  const refreshStart = panel.indexOf("function Refresh-PlannerExecutorUi");
  const refreshEnd = panel.indexOf("$projectSelector.Add_SelectionChangeCommitted", refreshStart);
  const refresh = panel.slice(refreshStart, refreshEnd);
  assert.match(refresh, /\$savedSelectionReady/);
  assert.match(refresh, /START sẽ tự NẠP profile này/);
  assert.match(refresh, /\$startButton\.Enabled=\[bool\]\(\$robotStopped -and \$savedSelectionReady/);
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
