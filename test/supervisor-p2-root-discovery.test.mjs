import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harnessPath = resolve(repoRoot, ".github", "scripts", "supervisor-p2-live-isolated.ps1");
const harness = readFileSync(harnessPath, "utf8");

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
