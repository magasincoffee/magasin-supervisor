import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const guardian = fs.readFileSync('windows/supervisor-guardian.ps1', 'utf8');
const wrapper = fs.readFileSync('windows/run-supervisor.ps1', 'utf8');
const launcher = fs.readFileSync('windows/start-supervisor-guardian.ps1', 'utf8');
const installer = fs.readFileSync('windows/install-supervisor.ps1', 'utf8');
const autostart = fs.readFileSync('windows/install-autostart.ps1', 'utf8');
const watchdogWorkflow = fs.readFileSync('.github/workflows/sc013-runtime-watchdog.yml', 'utf8');
const sot = fs.readFileSync('SOURCE_OF_TRUTH.md', 'utf8');

test('SC-013 guardian is bounded and fail-closed', () => {
  assert.match(sot, /DESKTOP-H4A16IL/);
  assert.match(sot, /at most five starts per hour/);
  assert.match(sot, /MUST NOT clear STOP or AUTOSTART_DISABLED/);

  assert.match(guardian, /MaxWrapperRestartsPerHour = 5/);
  assert.match(guardian, /WrapperRestartCooldownSeconds = 90/);
  assert.match(guardian, /guardian-recovery\.json/);
  assert.match(guardian, /Load-RestartHistory/);
  assert.match(guardian, /Save-RestartHistory/);
  assert.match(guardian, /Persist the recovery attempt before process creation/);
  assert.match(guardian, /Test-OwnerStop/);
  assert.match(guardian, /TASK_STATUS_CHECK','TASK_EXECUTION/);
  assert.match(guardian, /EXACT_ONCE_FAILED/);
  assert.match(guardian, /retry_count -lt 1/);
  assert.match(guardian, /The rebound runtime's exact-once reconciler/);
  assert.match(guardian, /run-supervisor\.ps1/);
  assert.match(wrapper, /SINGLE_CONVERSATION_TECHNICAL_SEND_RECOVERY=True/);
  assert.match(wrapper, /TASK_STATUS_CHECK','TASK_EXECUTION/);
  assert.match(wrapper, /exact-once retry budget remains authoritative/);
  assert.doesNotMatch(guardian, /Clear-LifecycleOwnerStopLatches/);
  assert.doesNotMatch(guardian, /(?:Set-Content|Add-Content|Move-Item|Remove-Item)[^\n]*\$statePath/);
  assert.doesNotMatch(guardian, /composer|keyboard|click|submit/i);
});

test('guardian is installed and autostarted with the runtime', () => {
  assert.match(launcher, /SUPERVISOR_GUARDIAN_HEARTBEAT_FRESH=True/);
  assert.match(installer, /Stopping existing Supervisor guardian PID/);
  assert.match(installer, /SUPERVISOR_GUARDIAN_INSTALLED_RUNNING=True/);
  assert.match(autostart, /MAGASINSupervisorGuardian/);
  assert.match(autostart, /start-supervisor-guardian\.ps1/);
  assert.match(watchdogWorkflow, /DESKTOP-H4A16IL/);
  assert.match(watchdogWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(watchdogWorkflow, /schedule:/);
});