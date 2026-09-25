import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const read = (name) =>
  fs.readFile(new URL(`../windows/${name}`, import.meta.url), "utf8");

test("autostart bootstrap resumes canonical runner and Supervisor only when Owner STOP latch is absent", async () => {
  const source = await read("autostart-bootstrap.ps1");
  assert.match(source, /AUTOSTART_DISABLED/);
  assert.match(source, /SUPERVISOR_RUNNER_ROOT/);
  assert.match(source, /C:\\actions-runner-magasin-supervisor\\actions-runner/);
  assert.match(source, /C:\\actions-runner-business\\actions-runner/);
  assert.match(source, /Runner\.Listener\.exe/);
  assert.match(source, /Split-Path \(\[string\]\$listener\.ExecutablePath\) -Parent/);
  assert.match(source, /RUNNER_TRACKING_ID = 'MAGASIN_RUNNER_PERSISTENT'/);
  assert.match(source, /start-supervisor\.ps1/);
  assert.match(source, /SUPERVISOR_ONLINE/);
});

test("autostart installer registers HKCU Run and never bypasses Windows login", async () => {
  const source = await read("install-autostart.ps1");
  assert.match(source, /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run/);
  assert.match(source, /MAGASINBusinessOSAutostart/);
  assert.match(source, /windows_session_required = \$true/);
  assert.match(source, /bypass_windows_login = \$false/);
  assert.match(source, /AUTOSTART_DISABLED/);
});

test("manual STOP disables reboot resume while START re-enables it", async () => {
  const [start, stop] = await Promise.all([
    read("start-supervisor.ps1"),
    read("stop-supervisor.ps1")
  ]);

  assert.match(stop, /Set-Content -Path \$autostartDisabled -Value 'OWNER_STOP'/);
  assert.match(start, /Clear-LifecycleOwnerStopLatches -Root \$root/);
});

test("power-loss recovery keeps the dedicated browser boundary", async () => {
  const source = await read("run-supervisor.ps1");
  assert.match(source, /browser_profile/);
  assert.match(source, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(source, /Supervisor requested dedicated Chrome restart/);
});
