import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const transfer = readFileSync(new URL("../windows/mig-005-state-transfer.ps1", import.meta.url), "utf8");
const handoff = readFileSync(new URL("../windows/mig-005-old-handoff.ps1", import.meta.url), "utf8");

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
