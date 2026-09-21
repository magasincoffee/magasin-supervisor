import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("installer stops existing dedicated Supervisor before replacing runtime", async () => {
  const source = await fs.readFile(
    new URL("../windows/install-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /supervisor\.pid/);
  assert.match(source, /taskkill\.exe \/PID \$pidValue \/T \/F/);
  assert.match(source, /for \(\$i = 0; \$i -lt 8; \$i\+\+\)/);
  assert.match(source, /Remove-Item \$runtime -Recurse -Force/);
});


test("installer closes an existing control panel before replacing runtime", async () => {
  const source = await fs.readFile(
    new URL("../windows/install-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /control-panel\.ps1/);
  assert.match(source, /Get-CimInstance Win32_Process/);
  assert.match(source, /Stop-Process -Id \$_\.ProcessId -Force/);
  assert.match(source, /\$shortcut\.WorkingDirectory = \$root/);
});


test("installer stops orphaned Supervisor loops even when pid file is stale", async () => {
  const source = await fs.readFile(
    new URL("../windows/install-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /run-supervisor\.ps1/);
  assert.match(source, /supervisor-loop-cli\|brain-worker-cli/);
  assert.match(source, /Stopping orphaned Supervisor wrapper PID/);
  assert.match(source, /Stopping orphaned Supervisor Node PID/);
});
