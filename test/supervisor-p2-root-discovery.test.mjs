import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harnessPath = resolve(repoRoot, ".github", "scripts", "supervisor-p2-live-isolated.ps1");
const harness = readFileSync(harnessPath, "utf8");
const brainFixturePath = resolve(repoRoot, ".github", "scripts", "supervisor-p2-live-brain-fixture.mjs");
const brainFixture = readFileSync(brainFixturePath, "utf8");

test("P2 inaccessible root probes are fail-closed and non-fatal", () => {
  assert.match(harness, /function Test-ReadableLeaf/);
  assert.match(harness, /function Read-JsonSafe/);
  assert.match(harness, /function Test-CanonicalSupervisorRootCandidate/);
  assert.match(harness, /Test-Path -LiteralPath \$Path -PathType Leaf -ErrorAction Stop/);
  assert.match(harness, /catch \{\s*return \$false\s*\}/m);
  assert.match(harness, /Where-Object \{ \$_ -and \(Test-CanonicalSupervisorRootCandidate \$_\) \}/);
  assert.match(harness, /if \(Test-CanonicalSupervisorRootCandidate \$fallback\)/);
  assert.doesNotMatch(
    harness,
    /Where-Object \{\s*\(Test-Path \(Join-Path \$_ "lanes\.json"\)\)/m
  );
});

test("P2 candidate acceptance requires readable canonical state and installed start script", () => {
  assert.match(harness, /Read-JsonSafe \(Join-Path \$full "lanes\.json"\)/);
  assert.match(harness, /Read-JsonSafe \(Join-Path \$full "lane-registry\.json"\)/);
  assert.match(harness, /runtime\\\\windows\\\\start-supervisor\.ps1/);
  assert.match(harness, /if \(-not \$lanes -or -not \$lanes\.lanes\) \{ return \$false \}/);
  assert.match(harness, /if \(-not \$registry -or -not \$registry\.lanes\) \{ return \$false \}/);
  assert.match(harness, /if \(-not \(Test-ReadableLeaf \$startScript\)\) \{ return \$false \}/);
});

test("P2 Chrome discovery tolerates zero matching processes under StrictMode and reaches fallback", { skip: process.platform !== "win32" }, () => {
  assert.match(harness, /\$chromeExe = ""/);
  assert.match(harness, /if \(\$null -ne \$existingChrome\)/);
  assert.match(harness, /\$existingChrome\.PSObject\.Properties\["ExecutablePath"\]/);
  assert.match(harness, /P2_LIVE_CHROME_NOT_FOUND/);

  const probe = [
    "Set-StrictMode -Version 2.0",
    "$existingChrome = $null",
    "$chromeExe = ''",
    "if ($null -ne $existingChrome) {",
    "  $executablePathProperty = $existingChrome.PSObject.Properties['ExecutablePath']",
    "  if ($executablePathProperty -and -not [string]::IsNullOrWhiteSpace([string]$executablePathProperty.Value)) {",
    "    $chromeExe = [string]$executablePathProperty.Value",
    "  }",
    "}",
    "if ([string]::IsNullOrWhiteSpace($chromeExe)) { $chromeExe = 'FALLBACK_REACHED' }",
    "if ($chromeExe -ne 'FALLBACK_REACHED') { throw 'fallback not reached' }",
    "Write-Output 'P2_NULL_CHROME_STRICTMODE_FALLBACK=PASS'"
  ].join("; ");

  const run = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", probe],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true }
  );

  assert.equal(run.status, 0, `PowerShell StrictMode regression failed:\n${run.stderr || run.stdout}`);
  assert.match(run.stdout, /P2_NULL_CHROME_STRICTMODE_FALLBACK=PASS/);
});

test("P2 Brain fixture shutdown is bounded after persisted success", () => {
  assert.match(brainFixture, /async function closeAdapterBounded\(timeoutMs = 2_000\)/);
  assert.match(brainFixture, /Promise\.race\(\[/);
  assert.match(brainFixture, /async function finishFixtureSuccess\(page, directive, reused\)/);
  assert.match(brainFixture, /await finishFixtureSuccess\(page, directive, true\)/);
  assert.match(brainFixture, /await finishFixtureSuccess\(page, directive, false\)/);
  assert.match(brainFixture, /finally \{\s*await closeAdapterBounded\(\);\s*\}/m);
  assert.doesNotMatch(brainFixture, /await adapter\.close\(\)\.catch\(\(\) => \{\}\);/);
});


test("P2 diagnostic error_name access is StrictMode-safe when property is absent", { skip: process.platform !== "win32" }, () => {
  assert.match(harness, /\$errorNameProperty = \$statusLane\.PSObject\.Properties\["error_name"\]/);
  assert.match(harness, /LIVE_P2_DIAG_LANE_ERROR_NAME=\$statusLaneErrorName/);

  const probe = [
    "Set-StrictMode -Version 2.0",
    "$statusLane = [pscustomobject]@{ status = 'STARTING' }",
    "$statusLaneErrorName = 'NONE'",
    "if ($statusLane) {",
    "  $errorNameProperty = $statusLane.PSObject.Properties['error_name']",
    "  if ($errorNameProperty -and -not [string]::IsNullOrWhiteSpace([string]$errorNameProperty.Value)) {",
    "    $statusLaneErrorName = [string]$errorNameProperty.Value",
    "  }",
    "}",
    "if ($statusLaneErrorName -ne 'NONE') { throw 'unexpected error_name value' }",
    "Write-Output 'P2_DIAG_ERROR_NAME_STRICTMODE=PASS'"
  ].join("; ");

  const run = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", probe],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true }
  );

  assert.equal(run.status, 0, `PowerShell StrictMode diagnostic regression failed:\n${run.stderr || run.stdout}`);
  assert.match(run.stdout, /P2_DIAG_ERROR_NAME_STRICTMODE=PASS/);
});


test("P2 rate-limit event scan is StrictMode-safe when optional fields are absent", { skip: process.platform !== "win32" }, () => {
  assert.match(harness, /\$reasonCodeProperty = \$safeEvent\.PSObject\.Properties\["reason_code"\]/);
  assert.match(harness, /\$reasonProperty = \$safeEvent\.PSObject\.Properties\["reason"\]/);

  const probe = [
    "Set-StrictMode -Version 2.0",
    "$safeEvent = [pscustomobject]@{ type = 'LANE_BRAIN_SEND_PENDING_CONFIRMATION' }",
    "$safeType = ''",
    "$safeReasonCode = ''",
    "$safeReason = ''",
    "$typeProperty = $safeEvent.PSObject.Properties['type']",
    "$reasonCodeProperty = $safeEvent.PSObject.Properties['reason_code']",
    "$reasonProperty = $safeEvent.PSObject.Properties['reason']",
    "if ($typeProperty) { $safeType = [string]$typeProperty.Value }",
    "if ($reasonCodeProperty) { $safeReasonCode = [string]$reasonCodeProperty.Value }",
    "if ($reasonProperty) { $safeReason = [string]$reasonProperty.Value }",
    "if ($safeType -eq 'LANE_CHATGPT_RATE_LIMIT_DETECTED' -or $safeReasonCode -eq 'CHATGPT_RATE_LIMITED' -or $safeReason -eq 'CHATGPT_RATE_LIMITED') { throw 'false rate limit' }",
    "Write-Output 'P2_RATE_LIMIT_EVENT_STRICTMODE=PASS'"
  ].join("; ");

  const run = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", probe],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true }
  );

  assert.equal(run.status, 0, `PowerShell StrictMode rate-limit regression failed:\n${run.stderr || run.stdout}`);
  assert.match(run.stdout, /P2_RATE_LIMIT_EVENT_STRICTMODE=PASS/);
});


test("P2 live diagnostic optional properties are uniformly StrictMode-safe", { skip: process.platform !== "win32" }, () => {
  assert.match(harness, /function Get-OptionalPropertyValue\(\$Object,\[string\]\$Name\)/);
  assert.match(harness, /Get-OptionalPropertyValue \$event "error_name"/);
  assert.match(harness, /Get-OptionalPropertyValue \$event "reason_code"/);
  assert.match(harness, /Get-OptionalPropertyValue \$event "reason"/);
  assert.match(harness, /Get-OptionalPropertyValue \$diagLane "work_url"/);
  assert.match(harness, /Get-OptionalPropertyValue \$diagLane "last_dispatch_id"/);
  assert.doesNotMatch(harness, /\$event\.(?:error_name|reason_code|reason)/);

  const probe = [
    "Set-StrictMode -Version 2.0",
    "function Get-OptionalPropertyValue($Object,[string]$Name) { if ($null -eq $Object) { return $null }; $property = $Object.PSObject.Properties[$Name]; if ($property) { return $property.Value }; return $null }",
    "$event = [pscustomobject]@{ type = 'LANE_AUTO_WORK_CREATE_REQUESTED' }",
    "$errorName = [string](Get-OptionalPropertyValue $event 'error_name')",
    "$reasonCode = [string](Get-OptionalPropertyValue $event 'reason_code')",
    "$reason = [string](Get-OptionalPropertyValue $event 'reason')",
    "if ($errorName -or $reasonCode -or $reason) { throw 'unexpected optional property value' }",
    "Write-Output 'P2_OPTIONAL_EVENT_PROPERTIES_STRICTMODE=PASS'"
  ].join("; ");

  const run = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", probe],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true }
  );

  assert.equal(run.status, 0, `PowerShell optional-property StrictMode regression failed:\n${run.stderr || run.stdout}`);
  assert.match(run.stdout, /P2_OPTIONAL_EVENT_PROPERTIES_STRICTMODE=PASS/);
});
