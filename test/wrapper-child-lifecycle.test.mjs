import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(rel) {
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

test("Three-Lane process truth only accepts the direct child of the authoritative wrapper", async () => {
  const lifecycle = await read("../windows/lifecycle-truth.ps1");

  assert.match(lifecycle, /function Get-LifecycleThreeLaneProcess\(\[string\]\$Root/);
  assert.match(lifecycle, /\$wrapper = Get-LifecycleSupervisorWrapper -Root \$Root/);
  assert.match(lifecycle, /\[int\]\$_\.ParentProcessId -eq \$wrapperPid/);
  assert.match(lifecycle, /Get-LifecycleThreeLaneProcess -Root \$Root/);
  assert.match(lifecycle, /function Get-LifecycleOrphanThreeLaneProcesses/);
});

test("wrapper reclaims orphan Three-Lane writers before launching its child", async () => {
  const wrapper = await read("../windows/run-supervisor.ps1");

  const cleanupFunction = wrapper.indexOf("function Stop-OrphanedThreeLaneProcesses");
  const cleanupCall = wrapper.indexOf("Stop-OrphanedThreeLaneProcesses", cleanupFunction + 1);
  const pidWrite = wrapper.indexOf("Set-Content -Path $pidFile -Value $PID");
  const nodeLaunch = wrapper.indexOf("& node @nodeArgs");

  assert.ok(cleanupFunction >= 0);
  assert.ok(cleanupCall > cleanupFunction);
  assert.ok(cleanupCall < pidWrite);
  assert.ok(cleanupCall < nodeLaunch);
  assert.match(wrapper, /Test-WrapperProcessForCurrentRoot/);
  assert.match(wrapper, /Stop-Process -Id \(\[int\]\$nodeProcess\.ProcessId\) -Force/);
  assert.match(wrapper, /--wrapper-pid', \[string\]\$PID/);
  assert.match(wrapper, /\$env:SUPERVISOR_STATE_ROOT = \$root/);
});

test("wrapper finally cleans only Three-Lane children owned by its own PID", async () => {
  const wrapper = await read("../windows/run-supervisor.ps1");

  assert.match(wrapper, /function Stop-CurrentWrapperThreeLaneChildren/);
  assert.match(wrapper, /\[int\]\$_\.ParentProcessId -eq \[int\]\$PID/);
  assert.match(
    wrapper,
    /finally \{\s*Stop-CurrentWrapperThreeLaneChildren\s*Remove-Item \$pidFile/
  );
});

test("Three-Lane runtime accepts wrapper PID and exits its loop after parent loss", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");

  assert.match(runtime, /wrapperPid: null/);
  assert.match(runtime, /--wrapper-pid/);
  assert.match(runtime, /function wrapperProcessAlive\(wrapperPid\)/);
  assert.match(runtime, /process\.kill\(wrapperPid, 0\)/);
  assert.match(runtime, /wrapper-pid must be a positive integer/);
  assert.match(
    runtime,
    /while \(true\) \{\s*if \(args\.wrapperPid && !wrapperProcessAlive\(args\.wrapperPid\)\)/
  );
  assert.match(runtime, /RUNTIME_WRAPPER_PARENT_MISSING/);
  assert.match(runtime, /function armWrapperParentMonitor\(wrapperPid\)/);
  assert.match(runtime, /process\.exit\(77\)/);
  assert.match(runtime, /const wrapperParentMonitor = armWrapperParentMonitor\(args\.wrapperPid\)/);
  assert.match(runtime, /if \(wrapperParentMonitor\) clearInterval\(wrapperParentMonitor\)/);
});

test("Control Panel automatically recovers GitHub Runner with bounded backoff", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /\$script:lastRunnerRecoveryRequestAt/);
  assert.match(panel, /\$script:runnerRecoveryBackoffSeconds = 5/);
  assert.match(panel, /function Request-RunnerRecovery/);
  assert.match(panel, /\[Math\]::Min\(\s*60,/);
  assert.match(panel, /\[void\]\(Request-RunnerRecovery\)/);
  assert.match(panel, /GITHUB ĐANG TỰ KẾT NỐI/);

  const refreshStart = panel.indexOf("function Refresh-Ui");
  const refresh = panel.slice(refreshStart);
  const get = refresh.indexOf("$runner = Get-RunnerProcess");
  const recover = refresh.indexOf("Request-RunnerRecovery", get);
  const render = refresh.indexOf("$runnerButton.Text", recover);
  assert.ok(get >= 0);
  assert.ok(recover > get);
  assert.ok(render > recover);
});
