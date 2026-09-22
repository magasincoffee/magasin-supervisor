import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const transfer = readFileSync(new URL("../windows/mig-005-state-transfer.ps1", import.meta.url), "utf8");
const handoff = readFileSync(new URL("../windows/mig-005-old-handoff.ps1", import.meta.url), "utf8");
const bootstrap = readFileSync(new URL("../windows/autostart-bootstrap.ps1", import.meta.url), "utf8");

test("MIG-005 transfer tooling inventories canonical continuity state", () => {
  for (const required of [
    "lanes.json",
    "lane-registry.json",
    "lane-status.json",
    "lane-events.ndjson",
    "STOP",
    "AUTOSTART_DISABLED",
    "lane-evidence"
  ]) {
    assert.equal(transfer.includes(required), true, "missing continuity surface: " + required);
  }
  assert.match(transfer, /registry_continuity_fingerprint/);
  assert.match(transfer, /target_fingerprint/);
  assert.match(transfer, /ExpectedPackageSha256/);
  assert.match(transfer, /zero_authority_verified/);
});

test("MIG-005 transfer excludes machine runtime and auth surfaces from canonical payload", () => {
  for (const excluded of [
    "runtime/",
    "supervisor.pid",
    "runtime-status.json",
    "supervisor.log",
    "browser_profile/",
    "autostart-install-status.json"
  ]) {
    assert.equal(transfer.includes("'" + excluded + "'"), true, "missing exclusion: " + excluded);
  }
  assert.match(transfer, /cookies_tokens_browser_profile_in_package = \$false/);
});

test("MIG-005 import validates hashes before atomic destination finalization", () => {
  const validatePos = transfer.indexOf("Transfer payload hash mismatch");
  const finalPos = transfer.indexOf("Move-Item -Path (Join-Path $finalStage $name) -Destination $dest");
  assert.ok(validatePos >= 0);
  assert.ok(finalPos > validatePos);
  assert.match(transfer, /Destination state root contains non-bootstrap\/non-profile state/);
  assert.match(transfer, /MIG_005_MACHINE_LOCAL_BROWSER_PROFILE_PRESERVED=True/);
  assert.match(transfer, /MIG_005_BOOTSTRAP_BLOCKERS_RECONCILED=True/);
  assert.match(transfer, /MIG_005_IMPORT_ABORTED_FAIL_CLOSED=True/);
});

test("MIG-005 preserves semantic relay latch identity while rebasing only screenshot path", () => {
  assert.match(transfer, /Get-RegistryContinuityFingerprint/);
  assert.equal(transfer.includes('lane.relay_inflight.screenshot_path = "lane-evidence/$leaf"'), true);
  assert.match(transfer, /Rebase-RelayScreenshotPaths/);
  assert.match(transfer, /MIG_005_IMPORT_LATCH_FINGERPRINT_MATCH=True/);
});

test("MIG-005 old handoff enforces capture stop zero export ordering and rollback", () => {
  const capturePos = handoff.indexOf("'-Mode','Capture'");
  const stopPos = handoff.indexOf("-File $installedStop");
  const zeroPos = handoff.indexOf("MIG_005_AUTHORITY_COUNT_AFTER_OLD_STOP=0");
  const exportPos = handoff.indexOf("'-Mode','Export'");
  assert.ok(capturePos >= 0);
  assert.ok(stopPos > capturePos);
  assert.ok(zeroPos > stopPos);
  assert.ok(exportPos > zeroPos);
  assert.match(handoff, /MIG_005_ROLLBACK_ATTEMPTED=True/);
  assert.match(handoff, /MIG_005_ROLLBACK_SUCCEEDED=True/);
});

test("MIG-005 tooling never starts the new authority or runs Tier B", () => {
  assert.match(transfer, /MIG_005_NEW_AUTHORITY_STARTED=False/);
  assert.match(transfer, /RBT009_TIER_B_480M=NOT_RUN/);
  assert.match(handoff, /MIG_005_NEW_AUTHORITY_STARTED=False/);
  assert.match(handoff, /RBT009_TIER_B_480M=NOT_RUN/);
});


test("MIG-005 classifies all four old-authority pre-handoff modes fail-closed", () => {
  for (const mode of ["ACTIVE","OWNER_STOPPED","ALL_DISABLED_QUIESCENT","INVALID_INACTIVE"]) {
    assert.equal(handoff.includes("'" + mode + "'"), true, "missing mode: " + mode);
  }
  assert.match(handoff, /enabled_lane_count -eq 0/);
  assert.match(handoff, /lane_count -eq 3/);
  assert.match(handoff, /registry_lane_count -eq 3/);
  assert.match(handoff, /MIG_005_OLD_STOP=NOT_REQUIRED_ALL_DISABLED_QUIESCENT/);
});

test("MIG-005 transfers old autostart ownership only after export and retains reversible private rollback", () => {
  const exportPos = handoff.indexOf("MIG-005 final state export failed.");
  const rollbackRecordPos = handoff.indexOf("Write-AutostartRollbackRecord -Path");
  const removeAutostartPos = handoff.indexOf("Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction Stop");
  assert.ok(exportPos >= 0);
  assert.ok(rollbackRecordPos > exportPos);
  assert.ok(removeAutostartPos > rollbackRecordPos);
  assert.match(handoff, /Restore-OldAuthority/);
  assert.match(handoff, /MIG_005_OLD_AUTOSTART_REGISTRATION_RESTORED=True/);
  assert.match(handoff, /MIG_005_RAW_AUTOSTART_VALUE_LOGGED=False/);
});

test("independent autostart bootstrap stays inactive when every lane is disabled", () => {
  const countPos = bootstrap.indexOf("Get-EnabledLaneCount -Root $root");
  const disabledPos = bootstrap.indexOf("$enabledLaneCount -lt 1");
  const exitPos = bootstrap.indexOf("exit 0", disabledPos);
  const invokeStartPos = bootstrap.indexOf("& powershell.exe", disabledPos);
  assert.ok(countPos >= 0);
  assert.ok(disabledPos > countPos);
  assert.ok(exitPos > disabledPos);
  assert.ok(invokeStartPos < 0 || exitPos < invokeStartPos);
  assert.match(bootstrap, /AUTOSTART_ALL_LANES_DISABLED/);
});
