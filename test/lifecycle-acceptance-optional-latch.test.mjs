import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const helperPath = fileURLToPath(
  new URL("../../../.github/scripts/supervisor-integrity-registry.ps1", import.meta.url)
);
const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/supervisor-lifecycle-acceptance.yml", import.meta.url)
);

function powershellCommand() {
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}

async function runLifecycleLatchAudit(registry) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "magasin-lifecycle-latch-"));
  const registryPath = path.join(root, "lane-registry.json");
  const runnerPath = path.join(root, "run.ps1");
  await fsp.writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");

  const runner = [
    "param([string]$HelperPath,[string]$RegistryPath)",
    "$ErrorActionPreference = 'Stop'",
    "Set-StrictMode -Version Latest",
    ". $HelperPath",
    "$registry = Get-Content $RegistryPath -Raw -Encoding UTF8 | ConvertFrom-Json",
    "$registryLanes = Get-OptionalPropertyValue -InputObject $registry -Name 'lanes'",
    "foreach ($laneId in @('lane-1','lane-2','lane-3')) {",
    "  $laneState = Get-OptionalPropertyValue -InputObject $registryLanes -Name $laneId",
    "  if ($null -eq $laneState) { throw \"J failed: missing registry lane $laneId\" }",
    "  $dispatchInflight = Get-OptionalPropertyValue -InputObject $laneState -Name 'dispatch_inflight'",
    "  $dispatchBlocked = [bool](Get-OptionalPropertyValue -InputObject $dispatchInflight -Name 'reconcile_blocked' -DefaultValue $false)",
    "  if ($dispatchBlocked) { throw 'D failed: blocked dispatch latch remains' }",
    "  $relayInflight = Get-OptionalPropertyValue -InputObject $laneState -Name 'relay_inflight'",
    "  $relayBlocked = [bool](Get-OptionalPropertyValue -InputObject $relayInflight -Name 'reconcile_blocked' -DefaultValue $false)",
    "  if ($relayBlocked) { throw 'D failed: blocked relay latch remains' }",
    "}",
    "Write-Output 'LIFECYCLE_DJ=PASS'",
    ""
  ].join("\n");
  await fsp.writeFile(runnerPath, runner, "utf8");

  const args = process.platform === "win32"
    ? ["-NoLogo","-NoProfile","-ExecutionPolicy","Bypass","-File",runnerPath,helperPath,registryPath]
    : ["-NoLogo","-NoProfile","-File",runnerPath,helperPath,registryPath];

  const result = spawnSync(powershellCommand(), args, {
    encoding: "utf8",
    timeout: 30_000
  });
  await fsp.rm(root, { recursive: true, force: true });
  return result;
}

function threeLaneRegistry(factory = () => ({})) {
  return {
    schema_version: "three-lane-registry.v1",
    mode: "THREE_LANE_V1",
    lanes: {
      "lane-1": factory("lane-1"),
      "lane-2": factory("lane-2"),
      "lane-3": factory("lane-3")
    }
  };
}

test("lifecycle D/J accepts null latches for all three lanes under StrictMode", async () => {
  const result = await runLifecycleLatchAudit(
    threeLaneRegistry(() => ({ dispatch_inflight: null, relay_inflight: null }))
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LIFECYCLE_DJ=PASS/);
});

test("lifecycle D/J accepts legacy latches missing reconcile_blocked for all three lanes", async () => {
  const result = await runLifecycleLatchAudit(
    threeLaneRegistry((laneId) => ({
      dispatch_inflight: { dispatch_id: "dispatch-" + laneId },
      relay_inflight: { relay_id: "relay-" + laneId }
    }))
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LIFECYCLE_DJ=PASS/);
});

test("lifecycle D/J accepts explicit reconcile_blocked=false for all three lanes", async () => {
  const result = await runLifecycleLatchAudit(
    threeLaneRegistry(() => ({
      dispatch_inflight: { reconcile_blocked: false },
      relay_inflight: { reconcile_blocked: false }
    }))
  );
  assert.equal(result.status, 0, result.stderr);
});

test("lifecycle D/J remains fail-closed for true blocked dispatch or relay on every lane", async () => {
  for (const laneId of ["lane-1","lane-2","lane-3"]) {
    for (const latchName of ["dispatch_inflight","relay_inflight"]) {
      const registry = threeLaneRegistry(() => ({
        dispatch_inflight: { reconcile_blocked: false },
        relay_inflight: { reconcile_blocked: false }
      }));
      registry.lanes[laneId][latchName].reconcile_blocked = true;
      const result = await runLifecycleLatchAudit(registry);
      assert.notEqual(result.status, 0, `${laneId} ${latchName} must fail closed`);
      assert.match(
        result.stderr,
        latchName === "dispatch_inflight"
          ? /blocked dispatch latch remains/
          : /blocked relay latch remains/
      );
    }
  }
});

test("lifecycle J still fails closed when any lane registry entry is missing", async () => {
  const registry = threeLaneRegistry();
  delete registry.lanes["lane-2"];
  const result = await runLifecycleLatchAudit(registry);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /J failed: missing registry lane lane-2/);
});

test("lifecycle latch audit output does not expose private registry values", async () => {
  const privateUrl = "https://chatgpt.com/c/private-lifecycle";
  const privateBody = "private message body";
  const secretToken = "secret-token-value";
  const result = await runLifecycleLatchAudit(
    threeLaneRegistry(() => ({
      work_url: privateUrl,
      dispatch_inflight: { token: secretToken },
      relay_inflight: { message_body: privateBody }
    }))
  );
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(output, /chatgpt\.com|private message body|secret-token-value/i);
});

test("lifecycle workflow reuses canonical optional accessor and preserves A-L/F/target invariants", async () => {
  const source = await fsp.readFile(workflowPath, "utf8");

  assert.match(source, /supervisor-integrity-registry\.ps1/);
  assert.match(source, /Get-OptionalPropertyValue -InputObject \$registryLanes -Name \$laneId/);
  assert.match(source, /Get-OptionalPropertyValue -InputObject \$dispatchInflight -Name "reconcile_blocked" -DefaultValue \$false/);
  assert.match(source, /Get-OptionalPropertyValue -InputObject \$relayInflight -Name "reconcile_blocked" -DefaultValue \$false/);
  assert.doesNotMatch(source, /dispatch_inflight\.reconcile_blocked/);
  assert.doesNotMatch(source, /relay_inflight\.reconcile_blocked/);

  assert.match(source, /foreach \(\$laneId in @\("lane-1","lane-2","lane-3"\)\)/);
  assert.match(source, /ACCEPTANCE_D=PASS/);
  assert.match(source, /ACCEPTANCE_J=PASS/);
  assert.match(source, /ACCEPTANCE_F=PASS/);
  assert.match(source, /TARGET_BRAIN_URLS_UNCHANGED=True/);
  assert.match(source, /OWNER_STOP_FAIL_CLOSED=True/);
  assert.match(source, /LIFECYCLE_ACCEPTANCE_A_TO_L=PASS/);
});
