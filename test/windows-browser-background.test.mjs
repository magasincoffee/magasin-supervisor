import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const readWindows = (name) =>
  fs.readFile(new URL(`../windows/${name}`, import.meta.url), "utf8");

test("automatic SINGLE_CONVERSATION_V1 boot and CDP recovery keep the dedicated real Chrome UI isolated", async () => {
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
  assert.match(run, /src\/runtime\/single-conversation-cli\.mjs/);
  assert.doesNotMatch(run, /three-lane-cli|planner-executor|brain-worker|--headless/);

  assert.match(start, /\[switch\]\$Hidden/);
  assert.match(start, /FilePath = 'powershell\.exe'/);
  assert.match(start, /WindowStyle = 'Hidden'/);
  assert.match(start, /Start-Process @startParams/);
  assert.match(bootstrap, /start-supervisor\.ps1/);
  assert.match(bootstrap, /-File \$startSupervisor -Hidden/);
});
