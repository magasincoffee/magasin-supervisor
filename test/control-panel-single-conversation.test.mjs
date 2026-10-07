import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(rel) {
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

test("SC-007 forward Control Center requires only Source of Truth plus START STOP", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("function Show-SingleConversationControlPanel");
  const end = panel.indexOf("function Show-PlannerExecutorControlPanel", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const ui = panel.slice(start, end);

  assert.match(ui, /SOURCE OF TRUTH/);
  assert.match(ui, /KHỞI ĐỘNG ROBOT/);
  assert.match(ui, /DỪNG ROBOT/);
  assert.match(ui, /SINGLE_CONVERSATION_V1/);
  assert.match(ui, /\$generation/);
  assert.match(ui, /conversationStatus/);
  assert.match(ui, /source_of_truth_url/);
  assert.match(ui, /single-conversation-control\.v1/);
  assert.match(ui, /Owner không cần cung cấp link cuộc chat/);
  assert.match(ui, /BƯỚC HIỆN TẠI/);
  assert.match(ui, /ĐẾM NGƯỢC/);
  assert.match(ui, /WAIT_TASK_RECHECK/);
  assert.match(ui, /local-watchdog-status\.json/);
  assert.match(ui, /timer\.Interval = 1000/);
  assert.match(ui, /LỖI \/ CẢNH BÁO/);
  assert.match(ui, /OWNER CẦN LÀM GÌ/);
  assert.match(ui, /external_work/);
  assert.match(ui, /WAIT_EXTERNAL/);
  assert.match(ui, /AUTO_REPAIR/);
  assert.match(ui, /TRIGGER_EXTERNAL_RUN/);
  assert.match(ui, /ĐANG CHỜ GITHUB CI/);
  assert.match(ui, /ĐANG BATCH REPAIR/);
  assert.match(ui, /REPAIR LOOP — ĐANG ĐỔI CHIẾN LƯỢC/);
  assert.match(ui, /Batch failures:/);
  assert.match(ui, /Next check:/);
  assert.match(ui, /Run vừa lỗi/);
  assert.match(ui, /Lần tự sửa/);
  assert.match(ui, /Checkpoint/);
  assert.match(ui, /Trạng thái CI/);
  assert.match(ui, /STARTING_BROWSER/);
  assert.match(ui, /Đang kết nối Chrome \/ phục hồi cuộc chat/);
  assert.match(ui, /\$externalActive/);
  assert.match(ui, /\$externalActive -and \$externalDecision -eq 'WAIT_EXTERNAL'/);
  assert.match(ui, /REPLACE_CHAT/);
  assert.match(ui, /Cuộc chat cũ đã đầy \/ lỗi, Robot đang chuyển sang chat mới/);
  assert.match(ui, /CONVERSATION_FULL_IN_FLIGHT/);
  assert.match(ui, /không gửi lại lệnh thực thi cũ/);
  assert.match(ui, /WATCHDOG: /);
  assert.match(ui, /ĐANG PHỤC HỒI/);
  assert.match(ui, /Gửi /);
  assert.match(ui, /Trả lời xong/);
  assert.match(ui, /Chat full/);
  assert.match(ui, /Chat mới sẵn sàng|Chat mới/);
  assert.match(ui, /\$milestoneValue/);
  assert.match(ui, /MỐC HOẠT ĐỘNG/);
  assert.match(ui, /Format-OwnerClock/);
  assert.match(ui, /SỰ KIỆN PHỤC HỒI/);
  assert.match(ui, /ĐANG TỰ PHỤC HỒI CHAT/);
  assert.doesNotMatch(ui, /\$timerValue\.Text \+= \[Environment\]::NewLine/);

  assert.doesNotMatch(ui, /Planner URL|Executor URL|LINK CHAT PLANNER|LINK CHAT EXECUTOR/);
  assert.doesNotMatch(ui, /MỞ PLANNER|MỞ EXECUTOR/);
  assert.doesNotMatch(ui, /Save-PlannerExecutorTargets|Initialize-LinkOnlyPlannerExecutorSession/);
});

test("SC-007 production panel bypasses legacy Planner Executor unless rollback flag is explicit", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const forward = panel.indexOf("if ([string]$env:SUPERVISOR_CONTROL_PANEL_LEGACY -ne '1')");
  const legacySelector = panel.indexOf("$plannerExecutorPanelState = Read-JsonFile $plannerExecutorStateFile");
  assert.ok(forward >= 0);
  assert.ok(legacySelector > forward);
  assert.match(
    panel.slice(forward, legacySelector),
    /Show-SingleConversationControlPanel[\s\S]*exit 0/
  );
});

test("SC-007 START writes only Source of Truth control identity and no chat targets", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const start = panel.indexOf("function Show-SingleConversationControlPanel");
  const end = panel.indexOf("function Show-PlannerExecutorControlPanel", start);
  const ui = panel.slice(start, end);

  const writeStart = ui.indexOf("function Write-SingleConversationControl");
  const writeEnd = ui.indexOf("function Refresh-SingleConversationUi", writeStart);
  const write = ui.slice(writeStart, writeEnd);
  assert.match(write, /schema_version = 'single-conversation-control\.v1'/);
  assert.match(write, /mode = 'SINGLE_CONVERSATION_V1'/);
  assert.match(write, /source_of_truth_url = \$source/);
  assert.doesNotMatch(write, /planner|executor|chat_url|conversation_url/i);

  const clickStart = ui.indexOf("$startButton.Add_Click({");
  const clickEnd = ui.indexOf("$stopButton.Add_Click", clickStart);
  const handler = ui.slice(clickStart, clickEnd);
  assert.match(handler, /Write-SingleConversationControl/);
  assert.match(handler, /start-supervisor\.ps1|\$startScript/);
  assert.doesNotMatch(handler, /planner|executor/i);
});

test("SC-007 wrapper and lifecycle select SINGLE_CONVERSATION_V1 from forward control", async () => {
  const run = await read("../windows/run-supervisor.ps1");
  const lifecycle = await read("../windows/lifecycle-truth.ps1");

  assert.match(run, /single-conversation-control\.json/);
  assert.match(run, /SINGLE_CONVERSATION_V1/);
  assert.match(run, /src\/runtime\/single-conversation-cli\.mjs/);
  assert.match(run, /--source-of-truth/);
  assert.match(run, /--state/);

  assert.match(lifecycle, /single-conversation-control\.json/);
  assert.match(lifecycle, /Get-LifecycleSingleConversationProcess/);
  assert.match(lifecycle, /single_conversation_alive/);
  assert.match(lifecycle, /return 'SINGLE_CONVERSATION_V1'/);
});


test("SC-009 production wrapper does not require legacy target.json for SINGLE_CONVERSATION_V1", async () => {
  const run = await read("../windows/run-supervisor.ps1");
  const gateStart = run.indexOf("target.json belongs only to legacy target-bound runtimes");
  const gateEnd = run.indexOf('Write-Host "Supervisor entry point:', gateStart);
  assert.ok(gateStart >= 0);
  assert.ok(gateEnd > gateStart);
  const gate = run.slice(gateStart, gateEnd);

  assert.match(
    gate,
    /\$runtimeMode -notin @\('SINGLE_CONVERSATION_V1','PLANNER_EXECUTOR_V1','THREE_LANE_V1','BRAIN_WORKER_V1'\)/
  );
  assert.match(run, /if \(-not \$DryRun\) \{ \$nodeArgs \+= '--execute' \}/);
});


test("SC-013 production wrapper pauses durable BLOCKED state except one bounded exact-once task-send recovery", async () => {
  const run = await read("../windows/run-supervisor.ps1");
  const blocked = run.indexOf("SINGLE_CONVERSATION_BLOCKED_PAUSE=True");
  const cdpRecovery = run.indexOf("$nodeExitCode -eq 75", blocked);
  assert.ok(blocked >= 0);
  assert.ok(cdpRecovery > blocked);
  const guard = run.slice(Math.max(0, blocked - 3600), cdpRecovery);
  assert.match(guard, /\$runtimeMode -eq 'SINGLE_CONVERSATION_V1'/);
  assert.match(guard, /\$singleAutomationAfterRun -eq 'BLOCKED'/);
  assert.match(guard, /\$recoverableTechnicalSend/);
  assert.match(guard, /TASK_STATUS_CHECK','TASK_EXECUTION/);
  assert.match(guard, /state -eq 'ENQUEUED'/);
  assert.match(guard, /retry_count -lt 1/);
  assert.match(guard, /last_error_code -eq 'EXACT_ONCE_FAILED'/);
  assert.match(guard, /SINGLE_CONVERSATION_TECHNICAL_SEND_RECOVERY=True/);
  assert.match(guard, /exact-once retry budget remains authoritative/);
  assert.match(guard, /SINGLE_CONVERSATION_BLOCKED_PAUSE=True/);
  assert.match(guard, /break/);
});
