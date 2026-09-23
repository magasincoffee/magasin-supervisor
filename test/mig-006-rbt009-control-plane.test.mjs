import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const workflow = fs.readFileSync(new URL("../.github/workflows/supervisor-rbt009-soak.yml", import.meta.url), "utf8");
const controller = fs.readFileSync(new URL("../.github/scripts/supervisor-mig006-tierb.ps1", import.meta.url), "utf8");
const release = JSON.parse(fs.readFileSync(new URL("../docs/MIG_006_RELEASE_REQUEST.json", import.meta.url), "utf8"));
const lifecycle = fs.readFileSync(new URL("../.github/workflows/supervisor-lifecycle-acceptance.yml", import.meta.url), "utf8");
const autostart = fs.readFileSync(new URL("../.github/workflows/supervisor-autostart-install.yml", import.meta.url), "utf8");

const RUNTIME = "218f330ee86eea4f0fb79ef9293bd43cf96a45de";
const OWNER_RELEASE = "fac10cff7fc1c5f05ce9b80d101ebd53b3331190";

function gitBlob(path) {
  const out = spawnSync("git", ["hash-object", path], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr || "git hash-object failed");
  return out.stdout.trim();
}

test("MIG-006 release request locks owner release and runtime certification target", () => {
  assert.equal(release.owner_release_source_sha, OWNER_RELEASE);
  assert.equal(release.runtime_candidate_sha, RUNTIME);
  assert.equal(release.runtime_candidate_redefinition_allowed, false);
  assert.equal(release.required_continuous_minutes, 480);
  assert.equal(release.sample_seconds, 120);
  assert.equal(release.start_from_zero, true);
  assert.equal(release.historical_partial_credit_allowed, false);
  assert.equal(release.state_root, "%LOCALAPPDATA%\\MAGASIN\\Supervisor");
  assert.equal(release.runtime_mode, "ALL_DISABLED_QUIESCENT");
});

test("locked candidate monitor and library stay byte-identical to MIG-005 runtime candidate", () => {
  assert.equal(gitBlob(".github/scripts/supervisor-rbt009-soak.ps1"), "1400d0e290a9213e9db5953ca74e229e90fe95f2");
  assert.equal(gitBlob(".github/scripts/supervisor-rbt009-soak-lib.ps1"), "7bf45add750544d9e42720e503230f87ed7d39a5");
});

test("Tier B checks out exact runtime candidate separately from exact control-plane head", () => {
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, new RegExp("ref: " + RUNTIME));
  assert.match(workflow, /path: \.mig006-runtime-candidate/);
  assert.match(workflow, /MIG006_CONTROL_PLANE_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(controller, /MIG006_CONTROL_PLANE_CHECKOUT_MISMATCH/);
  assert.match(controller, /MIG006_ISOLATED_CANDIDATE_CHECKOUT_MISMATCH/);
  assert.match(controller, /MIG006_RUNTIME_CANDIDATE_MARKER_MISMATCH/);
  assert.match(controller, /MIG006_INSTALLED_RUNTIME_FILE_IDENTITY_MISMATCH/);
});

test("Tier B forces platform state root despite stale runner environment", () => {
  assert.match(controller, /Join-Path \(\[string\]\$env:LOCALAPPDATA\) 'MAGASIN\\Supervisor'/);
  assert.match(controller, /\$env:SUPERVISOR_STATE_ROOT = \[IO\.Path\]::GetFullPath/);
  assert.match(controller, /MIG006_LEGACY_STATE_ROOT_FORBIDDEN/);
  assert.match(controller, /MIG_006_EXPLICIT_PLATFORM_STATE_ROOT=True/);
});

test("all-disabled production ownership remains quiescent and Owner STOP authoritative", () => {
  assert.match(controller, /enabled_lane_count -ne 0/);
  assert.match(controller, /MIG006_RUNTIME_AUTHORITY_MUST_BE_OFF/);
  assert.match(controller, /MIG006_OWNER_STOP_ACTIVE_BEFORE_TIMER/);
  assert.match(controller, /MIG006_OWNER_STOP_OBSERVED/);
  assert.match(controller, /MIG_006_RUNTIME_MODE=ALL_DISABLED_QUIESCENT/);
  assert.match(controller, /MIG_006_RUNTIME_AUTHORITY_INSTANCES=0/);
  assert.match(controller, /MIG_006_OWNERSHIP_AUTHORITY_INSTANCES=1/);
  assert.doesNotMatch(controller, /-File[^\n]*start-supervisor\.ps1/i);
  assert.doesNotMatch(controller, /Clear-LifecycleOwnerStopLatches/);
});

test("MIG-006 canonical evidence never converts legacy Chrome/CDP marker into a health claim", () => {
  assert.doesNotMatch(workflow, /SOAK_CHROME_CDP_HEALTH=True/);
  assert.match(workflow, /SOAK_CHROME_CDP_STATUS=NOT_APPLICABLE_ALL_DISABLED/);
  assert.match(controller, /chrome_cdp_status = 'NOT_APPLICABLE_ALL_DISABLED'/);
  assert.match(controller, /RedirectStandardOutput \$candidateStdout/);
  assert.match(controller, /Remove-Item \$path -Force/);
});

test("runner, power, reboot and ownership gates precede timer start", () => {
  const startPos = controller.indexOf("MIG_006_TIER_B_STARTED=True");
  for (const token of [
    "MIG006_RUNNER_NAME_MISMATCH",
    "MIG006_PENDING_REBOOT",
    "MIG006_SLEEP_TIMEOUT_NOT_NEVER",
    "MIG006_UPDATE_REBOOT_SCHEDULED_WITHIN_WINDOW",
    "MIG006_NEW_AUTOSTART_OWNERSHIP_MISSING",
    "Assert-ExactRuntimeIdentity",
  ]) {
    const pos = controller.indexOf(token);
    assert.ok(pos >= 0 && pos < startPos, token + " must be checked before timer");
  }
  assert.match(workflow, /runs-on: \[self-hosted, Windows, X64\]/);
  assert.match(workflow, /DESKTOP-4K7IM13/);
});

test("480-minute attempt starts from zero and interruptions receive zero credit", () => {
  assert.match(controller, /DurationMinutes -ne 480/);
  assert.match(controller, /SampleSeconds -ne 120/);
  assert.match(controller, /duration_seconds -lt 28800/);
  assert.match(controller, /historical_partial_credit_seconds = 0/);
  assert.match(controller, /MIG_006_PARTIAL_DURATION_CREDIT_SECONDS=0/);
  assert.match(controller, /qualification = 'NON_QUALIFYING'/);
  assert.match(workflow, /timeout-minutes: 510/);
  assert.match(workflow, /cancel-in-progress: true/);
});

test("target and latch state are fingerprinted and enforced for the full all-disabled window", () => {
  assert.match(controller, /\$configFingerprint = Get-FileSha256 \$configFile/);
  assert.match(controller, /\$registryLatchFingerprint = Get-FileSha256 \$registryFile/);
  assert.match(controller, /MIG006_TARGET_CONFIG_CHANGED/);
  assert.match(controller, /MIG006_REGISTRY_LATCH_CHANGED/);
  assert.match(controller, /target_fingerprint_equal = \$true/);
  assert.match(controller, /registry_latch_fingerprint_equal = \$true/);
});

test("event validation is window-scoped and zero-growth passes without fabricated events", () => {
  assert.match(controller, /\$eventStartLength/);
  assert.match(controller, /Read-Rbt009BoundedTextDelta/);
  assert.match(controller, /EVENT_STREAM_ROTATED_OR_TRUNCATED/);
  assert.match(controller, /\$eventWindowEmpty = \(\$eventWindowBytes -eq 0\)/);
  assert.match(controller, /event_duplicate_dispatch = \$false/);
  assert.match(controller, /event_duplicate_relay = \$false/);
  assert.match(controller, /event_order_valid = \$true/);
  assert.match(controller, /supervisor-release-event-validator\.mjs/);
});

test("only sanitized summary is eligible for artifact upload", () => {
  assert.match(workflow, /Upload sanitized qualification summary only/);
  assert.match(workflow, /SOAK_ARTIFACT_PRIVACY_SAFE=True/);
  assert.match(controller, /raw_state_in_artifact = \$false/);
  assert.match(controller, /raw_events_in_artifact = \$false/);
  assert.match(controller, /screenshot_in_artifact = \$false/);
  assert.match(controller, /browser_profile_in_artifact = \$false/);
  assert.doesNotMatch(controller, /brain_url\s*=/i);
  assert.doesNotMatch(controller, /work_url\s*=/i);
});

test("Tier B depends on exact-head normal gates and production-mutating sibling jobs stay disabled", () => {
  for (const name of [
    "Supervisor Tests",
    "Supervisor Integrity",
    "Supervisor Autostart Install",
    "Supervisor Lifecycle Acceptance",
  ]) assert.match(workflow, new RegExp(name));
  assert.match(workflow, /MIG-006 Locked Candidate Diagnostic/);
  assert.match(workflow, /needs: preflight/);
  assert.match(lifecycle, /if: \$\{\{ false \}\} # MIG-004: production\/self-hosted lifecycle remains hard-disabled/);
  assert.match(autostart, /if: \$\{\{ false \}\} # MIG-004: production\/self-hosted install remains hard-disabled/);
});


test("reboot continuity scan is global, read-only and fail-closed without exact UpdateOrchestrator path dependency", () => {
  assert.match(controller, /Get-ScheduledTask -ErrorAction Stop/);
  assert.doesNotMatch(controller, /Get-ScheduledTask -TaskPath '\\Microsoft\\Windows\\UpdateOrchestrator\\'/);
  assert.match(controller, /TaskPath -match '\(\?i\)UpdateOrchestrator'/);
  assert.match(controller, /TaskName -match '\(\?i\)reboot\|restart'/);
  assert.match(controller, /State -ne 'Disabled'/);
  assert.match(controller, /MIG006_UPDATE_REBOOT_SCHEDULED_WITHIN_WINDOW/);
  assert.match(controller, /MIG006_UPDATE_REBOOT_QUERY_UNPROVEN/);
  assert.match(controller, /MIG_006_UPDATE_REBOOT_WINDOW_CLEAR=True/);
});
