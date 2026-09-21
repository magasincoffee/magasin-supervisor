import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("Windows wrapper force-restarts only dedicated Chrome after CDP restart exit code", async () => {
  const source = await fs.readFile(
    new URL("../windows/run-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /function Stop-DedicatedChrome/);
  assert.match(source, /CommandLine -like "\*\$profile\*"/);
  assert.match(source, /\$nodeExitCode = \$LASTEXITCODE/);
  assert.match(source, /\$nodeExitCode -eq 75/);
  assert.match(source, /Stop-DedicatedChrome[\s\S]*continue/);
});


test("Windows wrapper verifies port ownership and skips occupied ports", async () => {
  const source = await fs.readFile(
    new URL("../windows/run-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /function Get-FreeCdpPort/);
  assert.match(source, /9222\.\.9232/);
  assert.match(source, /Get-NetTCPConnection -State Listen -LocalPort \$candidate/);
  assert.match(source, /function Test-DedicatedCdpEndpoint/);
  assert.match(source, /OwningProcess/);
  assert.match(source, /CommandLine -notlike "\*\$profile\*"/);
  assert.match(source, /--cdp-url', \$cdpBaseUrl/);
});


test("Windows wrapper owns a named singleton mutex", async () => {
  const source = await fs.readFile(
    new URL("../windows/run-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /Local\\MAGASIN_BUSINESS_OS_SUPERVISOR/);
  assert.match(source, /WaitOne\(0, \$false\)/);
  assert.match(source, /ReleaseMutex/);
  assert.match(source, /Another MAGASIN Supervisor wrapper already owns the singleton mutex/);
});
