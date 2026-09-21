import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("Windows STOP uses cooperative sentinel then bounded forced process-tree kill", async () => {
  const source = await fs.readFile(
    new URL("../windows/stop-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /Set-Content -Path \$stop/);
  assert.match(source, /for \(\$i = 0; \$i -lt 5; \$i\+\+\)/);
  assert.match(source, /function Stop-DedicatedProcessTree/);
  assert.match(source, /taskkill\.exe \/PID \$ProcessId \/T \/F/);
  assert.match(source, /STOP_TASKKILL_RACE_RESOLVED=True/);
  assert.match(source, /still alive after bounded force-stop/);
  assert.match(source, /Remove-Item \$pidFile/);
});


test("Windows STOP also clears orphaned wrappers and loop nodes", async () => {
  const source = await fs.readFile(
    new URL("../windows/stop-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /Stopping orphaned Supervisor wrapper PID/);
  assert.match(source, /Stopping orphaned Supervisor Node PID/);
  assert.match(source, /run-supervisor\.ps1/);
  assert.match(source, /supervisor-loop-cli\|brain-worker-cli/);
});
