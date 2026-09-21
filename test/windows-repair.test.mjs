import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("repair derives and verifies the current Three-Lane runtime version", async () => {
  const source = await fs.readFile(
    new URL("../windows/repair-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /git -C \$repoRoot pull --ff-only origin main/);
  assert.match(source, /Node\.js 20\+/);
  assert.match(source, /Get-SupervisorRuntimeVersion/);
  assert.match(source, /SUPERVISOR_RUNTIME_VERSION\\s\*=\\s\*/);
  assert.match(source, /\$expectedRuntimeVersion = Get-SupervisorRuntimeVersion -Path \$sourceThreeLane/);
  assert.doesNotMatch(source, /\$expectedRuntimeVersion = '2026-/);
  assert.match(source, /three-lane-cli\.mjs/);
  assert.match(source, /THREE_LANE_V1/);
  assert.match(source, /Stop-OrphanedSupervisorLoops/);
  assert.match(source, /RUNTIME_BOOT\.\*version=/);
  assert.match(source, /REPAIR_RESULT=PASS/);
  assert.match(source, /REPAIR_RESULT=FAIL/);
});

test("repair stops all known Supervisor node entry points", async () => {
  const source = await fs.readFile(
    new URL("../windows/repair-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /supervisor-loop-cli/);
  assert.match(source, /brain-worker-cli/);
  assert.match(source, /three-lane-cli/);
});

test("repair refuses dirty or non-main repositories", async () => {
  const source = await fs.readFile(
    new URL("../windows/repair-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /current branch is/);
  assert.match(source, /Repository has local changes/);
  assert.match(source, /--ff-only/);
});

test("repair script remains ASCII-only for Windows PowerShell 5.1", async () => {
  const source = await fs.readFile(
    new URL("../windows/repair-supervisor.ps1", import.meta.url)
  );
  const nonAscii = [...source].filter((byte) => byte > 0x7f);
  assert.deepEqual(nonAscii, []);
});
