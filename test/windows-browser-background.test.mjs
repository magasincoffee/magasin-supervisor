import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const readWindows = (name) =>
  fs.readFile(new URL(`../windows/${name}`, import.meta.url), "utf8");

test("automatic Supervisor boot and CDP recovery keep the dedicated real Chrome UI minimized/background", async () => {
  const [run, start, bootstrap] = await Promise.all([
    readWindows("run-supervisor.ps1"),
    readWindows("start-supervisor.ps1"),
    readWindows("autostart-bootstrap.ps1")
  ]);

  assert.match(run, /\$profile = Join-Path \$root 'browser_profile'/);
  assert.match(run, /Start-Process -FilePath \$chrome -WindowStyle Minimized -ArgumentList @\(/);
  assert.match(run, /'--start-minimized'/);
  assert.match(run, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(run, /--remote-debugging-port=\$cdpPort/);
  assert.match(run, /CommandLine -like "\*\$profile\*"/);
  assert.doesNotMatch(run, /--headless/);

  assert.match(start, /\[switch\]\$Hidden/);
  assert.match(start, /Start-Process powershell\.exe -WindowStyle Hidden/);
  assert.match(bootstrap, /start-supervisor\.ps1/);
  assert.match(bootstrap, /-File \$startSupervisor -Hidden/);
});

test("manual ChatGPT launcher reuses the same Supervisor profile and restores only its window", async () => {
  const [run, open] = await Promise.all([
    readWindows("run-supervisor.ps1"),
    readWindows("open-supervisor-chat.ps1")
  ]);

  assert.match(run, /\$profile = Join-Path \$root 'browser_profile'/);
  assert.match(open, /\$profile = Join-Path \$root 'browser_profile'/);
  assert.match(open, /Get-DedicatedChromeProcesses/);
  assert.match(open, /CommandLine -like "\*\$profile\*"/);
  assert.match(open, /MagasinSupervisorChromeWindow/);
  assert.match(open, /ShowWindowAsync\(\$process\.MainWindowHandle, 9\)/);
  assert.match(open, /SetForegroundWindow\(\$process\.MainWindowHandle\)/);
  assert.match(open, /Show-DedicatedChromeWindow \| Out-Null/);
  assert.match(open, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(open, /--user-data-dir=/);
  assert.doesNotMatch(open, /--headless/);

  const existingBranch = open.indexOf("if ($existing)");
  const existingLaunch = open.indexOf("Start-Process -FilePath $chrome", existingBranch);
  const existingFocus = open.indexOf("Show-DedicatedChromeWindow | Out-Null", existingLaunch);
  assert.ok(existingBranch >= 0);
  assert.ok(existingLaunch > existingBranch);
  assert.ok(existingFocus > existingLaunch);
});
