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


test("canonical desktop updater hotpatches source and restarts only Three-Lane when lanes are active", async () => {
  const source = await fs.readFile(
    new URL("../.github/scripts/update-latest-clean-old.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /ACTIVE_LANE_HOTPATCH_BEGIN=True/);
  assert.match(source, /Copy-Item \(Join-Path \$sourceSrc '\*'\) \$targetSrc -Recurse -Force/);
  assert.match(source, /HOTPATCH_ACTIONS_SHA256/);
  assert.match(source, /ParentProcessId -eq \$wrapperPid/);
  assert.match(source, /three-lane-cli\.mjs/);
  assert.match(source, /UPDATE_RESULT=HOTPATCH_ENABLED_LANES/);
  assert.match(source, /PROJECT_STATE_PRESERVED=True/);
  assert.match(source, /TARGET_FINGERPRINT_UNCHANGED=True/);
  assert.doesNotMatch(source, /UPDATE_RESULT=DEFERRED_ENABLED_LANES/);
});
