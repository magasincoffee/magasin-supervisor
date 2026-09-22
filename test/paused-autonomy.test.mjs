import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("Three-Lane recovery start fail-closes on local Owner STOP instead of repository business pause", async () => {
  const source = await fs.readFile(
    new URL("../windows/start-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /\[switch\]\$Recovery/);
  assert.match(source, /Get-LifecycleOwnerStopState/);
  assert.match(source, /RECOVERY_START_BLOCKED_OWNER_STOP=True/);
  assert.match(source, /Explicit Owner START is the sole normal authority/);
  assert.match(source, /Clear-LifecycleOwnerStopLatches -Root \$root/);
  assert.doesNotMatch(source, /\$projectState\.autonomy -eq 'PAUSED'/);
});

test("legacy supervisor-loop still publishes PAUSED and exits before connecting to ChatGPT", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/supervisor-loop-cli.mjs", import.meta.url),
    "utf8"
  );

  const pauseIndex = source.indexOf('projectState.autonomy === "PAUSED"');
  const connectIndex = source.indexOf("const adapter = await session.connect();");

  assert.ok(pauseIndex >= 0);
  assert.ok(connectIndex > pauseIndex);
  assert.match(source.slice(pauseIndex, connectIndex), /status: "PAUSED"/);
  assert.match(source.slice(pauseIndex, connectIndex), /process\.exitCode = 76/);
  assert.match(source.slice(pauseIndex, connectIndex), /AUTONOMY_PAUSED/);
});

test("Windows wrapper closes dedicated Chrome and stops on legacy pause exit code 76", async () => {
  const source = await fs.readFile(
    new URL("../windows/run-supervisor.ps1", import.meta.url),
    "utf8"
  );

  const pauseIndex = source.indexOf("$nodeExitCode -eq 76");
  assert.ok(pauseIndex >= 0);
  assert.match(source.slice(pauseIndex, pauseIndex + 800), /Stop-DedicatedChrome/);
  assert.match(source.slice(pauseIndex, pauseIndex + 800), /break/);
});

test("MIG-004 deployment parity separates hosted contract validation from production lifecycle authority", async () => {
  const source = await fs.readFile(
    new URL("../.github/workflows/supervisor-autostart-install.yml", import.meta.url),
    "utf8"
  );

  const safeStart = source.indexOf("  safe-validation:");
  const productionStart = source.indexOf("\n  install:", safeStart);
  assert.ok(safeStart >= 0 && productionStart > safeStart);
  const safeValidation = source.slice(safeStart, productionStart);

  assert.match(safeValidation, /runs-on: windows-latest/);
  assert.match(safeValidation, /MIG_004_INSTALL_CONTRACT_ONLY=True/);
  assert.match(safeValidation, /MIG_004_AUTOSTART_CONTRACT_ONLY=True/);
  assert.match(safeValidation, /MIG_004_HKCU_PRODUCTION_WRITE=False/);
  assert.match(source.slice(productionStart), /if: \$\{\{ false \}\}/);
  assert.doesNotMatch(safeValidation, /powershell[^\n]+-File "windows\/install-supervisor\.ps1"/);
  assert.doesNotMatch(safeValidation, /powershell[^\n]+-File "windows\/install-autostart\.ps1"/);
});

test("deployment workflow does not mutate lane intent to manufacture an executable queue", async () => {
  const source = await fs.readFile(
    new URL("../.github/workflows/supervisor-autostart-install.yml", import.meta.url),
    "utf8"
  );

  assert.match(source, /PROJECT_ADAPTER_LOCAL_CHECK=True/);
  assert.match(source, /TARGET_URLS_UNCHANGED=True/);
  assert.doesNotMatch(source, /lane1Config\.enabled = \$true/);
  assert.doesNotMatch(source, /LIVE_LANE1_RESUMED_BY_SHELL/);
  assert.doesNotMatch(source, /prepared_execution_queue\.status -match/);
  assert.doesNotMatch(source, /current_task is not part of an Owner-released queue/);
});
