import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/supervisor-mig005-preflight.yml", import.meta.url), "utf8");

test("MIG-005 preflight is read-only and cannot cut over production", () => {
  for (const forbidden of [
    "stop-supervisor.ps1",
    "start-supervisor.ps1",
    "install-supervisor.ps1",
    "install-autostart.ps1",
    "repair-supervisor.ps1",
    "Clear-LifecycleOwnerStopLatches",
    "Set-ItemProperty -Path $runKey",
    "Remove-Item $stop",
    "Remove-Item $autostartDisabled",
    "taskkill.exe",
    "Stop-Process"
  ]) {
    assert.equal(workflow.includes(forbidden), false, `forbidden mutation token present: ${forbidden}`);
  }
  assert.match(workflow, /MIG_005_READ_ONLY_PROBE=True/);
  assert.match(workflow, /ZERO_PRODUCTION_MUTATION=True/);
  assert.match(workflow, /RBT009_TIER_B_480M=NOT_RUN/);
});

test("MIG-005 preflight classifies active authority separately from new-ready candidate", () => {
  assert.match(workflow, /OLD_ACTIVE_AUTHORITY/);
  assert.match(workflow, /NEW_READY_CANDIDATE/);
  assert.match(workflow, /UNKNOWN_BLOCKED/);
  assert.match(workflow, /lane-registry\.json/);
  assert.match(workflow, /MAGASINBusinessOSAutostart/);
});
