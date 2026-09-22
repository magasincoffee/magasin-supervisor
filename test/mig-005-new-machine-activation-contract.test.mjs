import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const activate = readFileSync(new URL("../windows/mig-005-new-machine-activate.ps1", import.meta.url), "utf8");

test("MIG-005 new-machine wrapper binds exact candidate and validates package before mutation", () => {
  const candidatePos = activate.indexOf("Assert-GitCandidate -Sha $CandidateSha");
  const hashPos = activate.indexOf("$actualPackageSha = Get-FileSha256 $PackageZip");
  const importPos = activate.indexOf("-Mode Import");
  const envPersistPos = activate.indexOf("SetEnvironmentVariable('SUPERVISOR_STATE_ROOT',$destinationRoot,'User')");
  assert.ok(candidatePos >= 0);
  assert.ok(hashPos > candidatePos);
  assert.ok(importPos > hashPos);
  assert.ok(envPersistPos > importPos);
  assert.match(activate, /package SHA256 mismatch; fail closed before mutation/);
});

test("MIG-005 selects independent platform-default state root and forbids legacy BusinessOS target", () => {
  assert.match(activate, /Compatibility 'platform-default'/);
  assert.match(activate, /MAGASIN\\Supervisor/);
  assert.match(activate, /Legacy BusinessOS state root is forbidden/);
  assert.match(activate, /MIG_005_SELECTED_STATE_ROOT_PLATFORM_DEFAULT=True/);
});

test("MIG-005 verifies import then continuity before persistent environment and runtime install", () => {
  const importPos = activate.indexOf("-Mode Import");
  const verifyPos = activate.indexOf("-Mode Verify");
  const continuityPos = activate.indexOf("Assert-StateContinuity -Root $destinationRoot", verifyPos);
  const envPos = activate.indexOf("SetEnvironmentVariable('SUPERVISOR_STATE_ROOT',$destinationRoot,'User')");
  const installPos = activate.indexOf("-File $install -SourceRoot $repoRoot");
  assert.ok(importPos >= 0);
  assert.ok(verifyPos > importPos);
  assert.ok(continuityPos > verifyPos);
  assert.ok(envPos > continuityPos);
  assert.ok(installPos > envPos);
  assert.match(activate, /enabled_lane_count must remain 0/);
  assert.match(activate, /expected preserved false/);
});

test("MIG-005 installs ownership without Owner START and proves all-disabled no-start", () => {
  const autostartPos = activate.indexOf("$installedAutostart");
  const bootstrapPos = activate.indexOf("-File $expectedBootstrap -DryRun");
  assert.ok(autostartPos >= 0);
  assert.ok(bootstrapPos > autostartPos);
  assert.equal(activate.includes("-StartNow"), false);
  assert.equal(activate.includes("Clear-LifecycleOwnerStopLatches"), false);
  assert.match(activate, /AUTOSTART_ALL_LANES_DISABLED/);
  assert.match(activate, /NEW_AUTHORITY_OWNERSHIP_ACTIVE_ALL_DISABLED_RUNTIME_QUIESCENT/);
  assert.match(activate, /MIG_005_NEW_RUNTIME_AUTHORITY_ACTIVE=False/);
});

test("MIG-005 preserves browser profiles, runner identity, targets/latches and Owner STOP false", () => {
  assert.match(activate, /Get-DirectoryFingerprint/);
  assert.match(activate, /MIG_005_NEW_BROWSER_PROFILE_UNTOUCHED=True/);
  assert.match(activate, /Get-RunnerProcessIds/);
  assert.match(activate, /MIG_005_GITHUB_RUNNER_UNTOUCHED=True/);
  assert.match(activate, /MIG_005_NEW_TARGET_FINGERPRINT_MATCH=True/);
  assert.match(activate, /MIG_005_NEW_LATCH_FINGERPRINT_MATCH=True/);
  assert.match(activate, /MIG_005_NEW_OWNER_STOP_BLOCKED=False/);
});

test("MIG-005 rollback removes new ownership and transaction artifacts without starting old host", () => {
  assert.match(activate, /Remove-NewAutostartOwnership/);
  assert.match(activate, /Remove-NewTransactionArtifacts/);
  assert.match(activate, /Restore-NewMachineUserEnvironment/);
  assert.match(activate, /MIG_005_OWNER_MUST_RESTORE_OLD_AUTHORITY_USING_PRESERVED_OLD_ROLLBACK_RECORD=True/);
  assert.equal(activate.includes("start-supervisor.ps1"), false);
  assert.equal(activate.includes("browser_profile','runtime"), false);
});

test("MIG-005 wrapper never runs final Tier B", () => {
  assert.match(activate, /RBT009_TIER_B_480M=NOT_RUN/);
});


test("MIG-005 separates package-export candidate from runtime/install candidate without weakening manifest validation", () => {
  assert.match(activate, /\[string\]\$PackageCandidateSha/);
  assert.match(activate, /Get-PackageManifestCandidate/);
  assert.match(activate, /Package manifest candidate SHA does not match PackageCandidateSha/);
  assert.match(activate, /Assert-PackageRuntimeProvenance -PackageSha \$PackageCandidateSha -RuntimeSha \$CandidateSha/);
  assert.match(activate, /-Mode Import[^\n]+-CandidateSha \$PackageCandidateSha/);
  assert.match(activate, /-Mode Verify[^\n]+-CandidateSha \$PackageCandidateSha/);
  assert.match(activate, /Assert-InstalledRuntimeExact -Root \$destinationRoot -Sha \$CandidateSha/);
});

test("MIG-005 provenance proof is fail-closed on ancestry or transfer-blob mismatch", () => {
  const packageHashPos = activate.indexOf("$actualPackageSha = Get-FileSha256 $PackageZip");
  const manifestPos = activate.indexOf("$manifestCandidateSha = Get-PackageManifestCandidate");
  const provenancePos = activate.indexOf("Assert-PackageRuntimeProvenance -PackageSha $PackageCandidateSha -RuntimeSha $CandidateSha");
  const destinationPos = activate.indexOf("$destinationRoot = Get-PlatformStateRoot");
  assert.ok(packageHashPos >= 0);
  assert.ok(manifestPos > packageHashPos);
  assert.ok(provenancePos > manifestPos);
  assert.ok(destinationPos > provenancePos);
  assert.match(activate, /merge-base --is-ancestor/);
  assert.match(activate, /PackageCandidateSha is not an ancestor of CandidateSha/);
  assert.match(activate, /Package\/runtime transfer blob identity mismatch/);
});

test("MIG-005 emits sanitized package-runtime provenance markers only", () => {
  for (const marker of [
    "MIG_005_PACKAGE_CANDIDATE_SHA_VERIFIED=True",
    "MIG_005_RUNTIME_CANDIDATE_SHA_VERIFIED=True",
    "MIG_005_PACKAGE_RUNTIME_ANCESTRY_VERIFIED=True",
    "MIG_005_TRANSFER_BLOB_IDENTITY_VERIFIED=True",
    "MIG_005_PACKAGE_RUNTIME_PROVENANCE_COMPATIBLE=True",
  ]) {
    assert.match(activate, new RegExp(marker));
  }
});
