import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(rel) {
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

test("legacy Planner Executor rollback panel retains historical link-only controls", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /function Show-PlannerExecutorControlPanel/);
  assert.match(panel, /SOURCE OF TRUTH \/ LIVE SESSION/);
  assert.match(panel, /TIẾN ĐỘ DỰ ÁN/);
  assert.match(panel, /ProgressBar/);
  assert.match(panel, /MỞ PLANNER/);
  assert.match(panel, /MỞ EXECUTOR/);
  assert.match(panel, /START ROBOT/);
  assert.match(panel, /STOP ROBOT/);
  assert.match(panel, /RESET ROBOT/);
  assert.match(panel, /LINK-ONLY:/);
  assert.match(panel, /Không cần LƯU\/NẠP profile/);
  assert.match(panel, /ChatGPT Work mode: 0/);

  const uiStart = panel.indexOf("function Show-PlannerExecutorControlPanel");
  const uiEnd = panel.indexOf("function Set-ProjectProfileEditor", uiStart);
  const ui = panel.slice(uiStart, uiEnd);
  assert.match(ui, /\$projectSelector\.Visible = \$false/);
  assert.match(ui, /\$loadProjectButton\.Visible = \$false/);
  assert.match(ui, /\$newProjectButton\.Visible = \$false/);
  assert.match(ui, /\$projectNameBox\.Visible = \$false/);
  assert.match(ui, /\$saveProjectButton\.Visible = \$false/);
});

test("Planner Executor Control Center uses a scrollable viewport so lower controls remain reachable", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("function Show-PlannerExecutorControlPanel");
  const end = panel.indexOf("function Set-ProjectProfileEditor", start);
  const ui = panel.slice(start, end);

  assert.match(ui, /\$scrollHost\.Dock = \[Windows\.Forms\.DockStyle\]::Fill/);
  assert.match(ui, /\$scrollHost\.AutoScroll = \$true/);
  assert.match(ui, /\$scrollHost\.AutoScrollMinSize = New-Object Drawing\.Size\(1020, 866\)/);
  assert.match(ui, /\$content\.Controls\.Add\(\$hero\)/);
  assert.match(ui, /\$content\.Controls\.Add\(\$overview\)/);
  assert.match(ui, /\$content\.Controls\.Add\(\$projectPanel\)/);
  assert.match(ui, /\$content\.Controls\.Add\(\$footer\)/);
});

test("legacy Planner Executor START still creates its historical three-link session", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /function Initialize-LinkOnlyPlannerExecutorSession/);
  const fnStart = panel.indexOf("function Initialize-LinkOnlyPlannerExecutorSession");
  const fnEnd = panel.indexOf("function Reset-LinkOnlyPlannerExecutorSession", fnStart);
  const init = panel.slice(fnStart, fnEnd);
  assert.match(init, /New-PlannerExecutorProjectState 'LIVE' 'LIVE SESSION'/);
  assert.match(init, /project_generation = 1/);
  assert.match(init, /New-ProjectContextBootstrap 1/);
  assert.match(init, /Remove-Item \$plannerExecutorProjectsFile/);
  assert.match(init, /Remove-Item \$plannerExecutorProjectsDir -Recurse/);
  assert.match(init, /Write-JsonAtomic \$plannerExecutorStateFile \$state/);

  const legacyUiStart = panel.indexOf("function Show-PlannerExecutorControlPanel");
  const start = panel.indexOf("$startButton.Add_Click({", legacyUiStart);
  const end = panel.indexOf("$stopButton.Add_Click", start);
  const handler = panel.slice(start, end);
  assert.match(handler, /\$source = \$sourceBox\.Text\.Trim\(\)/);
  assert.match(handler, /\$planner = \$plannerBox\.Text\.Trim\(\)/);
  assert.match(handler, /\$executor = \$executorBox\.Text\.Trim\(\)/);
  assert.match(handler, /Initialize-LinkOnlyPlannerExecutorSession \$source \$planner \$executor/);
  assert.doesNotMatch(handler, /Get-PlannerExecutorProjectProfile/);
  assert.doesNotMatch(handler, /Switch-PlannerExecutorProject/);
  assert.doesNotMatch(handler, /LƯU PROFILE/);
});

test("RESET ROBOT removes all project/session-local data and leaves only an empty mode shell", async () => {
  const panel = await read("../windows/control-panel.ps1");

  const resetStart = panel.indexOf("function Reset-LinkOnlyPlannerExecutorSession");
  const resetEnd = panel.indexOf("function New-ProjectContextBootstrap", resetStart);
  const reset = panel.slice(resetStart, resetEnd);

  assert.ok(resetStart >= 0);
  assert.ok(resetEnd > resetStart);
  assert.match(reset, /-File \$stopScript/);
  assert.match(reset, /Remove-Item \$plannerExecutorStateFile/);
  assert.match(reset, /Remove-Item \$plannerExecutorStatusFile/);
  assert.match(reset, /Remove-Item \$plannerExecutorStartupFailureFile/);
  assert.match(reset, /Remove-Item \$plannerExecutorProjectsFile/);
  assert.match(reset, /Remove-Item \$plannerExecutorProjectsDir -Recurse/);
  assert.match(reset, /planner-executor-incidents\.ndjson/);
  assert.match(reset, /diagnostics\\submit/);
  assert.match(reset, /New-LinkOnlyPlannerExecutorShell/);
  assert.match(reset, /Write-JsonAtomic \$plannerExecutorStateFile \$shell/);

  const shellStart = panel.indexOf("function New-LinkOnlyPlannerExecutorShell");
  const shellEnd = panel.indexOf("function Initialize-LinkOnlyPlannerExecutorSession", shellStart);
  const shell = panel.slice(shellStart, shellEnd);
  assert.match(shell, /source_of_truth_url=\$null/);
  assert.match(shell, /planner=\[ordered\]@\{ target=''/);
  assert.match(shell, /executor=\[ordered\]@\{ target=''/);
  assert.match(shell, /project_context_bootstrap=\$null/);
  assert.match(shell, /active_task_id=\$null/);
  assert.match(shell, /assignment=\$null/);
  assert.match(shell, /result=\$null/);

  assert.match(panel, /RESET ROBOT — XÓA TOÀN BỘ PHIÊN/);
  assert.match(panel, /Toàn bộ dữ liệu dự án\/phiên cục bộ đã bị xóa/);
});

test("Control Panel surfaces bootstrap retry and startup failure instead of appearing frozen", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /planner-executor-startup-failure\.json/);
  assert.match(panel, /BOOTSTRAP_RETRY/);
  assert.match(panel, /bootstrap_retry_attempt/);
  assert.match(panel, /Startup failure:/);
  assert.match(panel, /Bootstrap:/);
});

test("project progress is rendered from Planner pc/pt derived from Source of Truth", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("function Refresh-PlannerExecutorUi");
  const end = panel.indexOf("$projectSelector.Add_SelectionChangeCommitted", start);
  const refresh = panel.slice(start, end);

  assert.match(refresh, /project_progress/);
  assert.match(refresh, /completed_tasks/);
  assert.match(refresh, /total_tasks/);
  assert.match(refresh, /percent/);
  assert.match(refresh, /\$progressBar\.Value=\$percent/);
  assert.match(refresh, /Planner sẽ đọc Source of Truth, xác định pc\/pt rồi giao đúng một task/);
  assert.match(refresh, /Tiến độ hiển thị lấy từ pc\/pt do Planner đọc từ Source of Truth/);
});

test("link-only inputs remain editable while stopped and START needs no profile save", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("function Refresh-PlannerExecutorUi");
  const end = panel.indexOf("$projectSelector.Add_SelectionChangeCommitted", start);
  const refresh = panel.slice(start, end);

  assert.match(refresh, /\$linkSessionReady=\[bool\]\(\$editorPlannerReady -and \$editorExecutorReady -and \$editorSourceReady\)/);
  assert.match(refresh, /\$sourceBox\.ReadOnly=-not \$robotStopped/);
  assert.match(refresh, /\$plannerBox\.ReadOnly=-not \$robotStopped/);
  assert.match(refresh, /\$executorBox\.ReadOnly=-not \$robotStopped/);
  assert.match(refresh, /\$startButton\.Enabled=\[bool\]\(\$robotStopped -and \$linkSessionReady/);
  assert.doesNotMatch(refresh, /\$savedSelectionReady/);
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
