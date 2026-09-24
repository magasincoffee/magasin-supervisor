import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
