import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const helperPath = fileURLToPath(
  new URL("../.github/scripts/supervisor-integrity-registry.ps1", import.meta.url)
);
const workflowPath = fileURLToPath(
  new URL("../.github/workflows/supervisor-integrity.yml", import.meta.url)
);

function powershellCommand() {
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}

async function makeHarness() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "magasin-integrity-"));
  const evidenceDir = path.join(root, "lane-evidence");
  await fsp.mkdir(evidenceDir, { recursive: true });
  const registryPath = path.join(root, "lane-registry.json");
  const runnerPath = path.join(root, "run-audit.ps1");
  const runner = [
    "param(",
    "  [string]$HelperPath,",
    "  [string]$RegistryPath,",
    "  [string]$EvidenceDir,",
    "  [string]$Mode",
    ")",
    "$ErrorActionPreference = 'Stop'",
    "Set-StrictMode -Version Latest",
    ". $HelperPath",
    "$registry = $null",
    "if ($RegistryPath -and (Test-Path $RegistryPath)) {",
    "  $registry = Get-Content $RegistryPath -Raw -Encoding UTF8 | ConvertFrom-Json",
    "}",
    "try {",
    "  if ($Mode -eq 'assert') {",
    "    $audit = Assert-SupervisorLatchIntegrity -Registry $registry -EvidenceDir $EvidenceDir",
    "  } else {",
    "    $audit = Get-SupervisorLatchIntegrityAudit -Registry $registry -EvidenceDir $EvidenceDir",
    "  }",
    "  $audit | ConvertTo-Json -Compress",
    "  exit 0",
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
    ""
  ].join("\n");
  await fsp.writeFile(runnerPath, runner, "utf8");
  return { root, evidenceDir, registryPath, runnerPath };
}

async function runAudit({ registry, files = [], mode = "get" }) {
  const harness = await makeHarness();
  try {
    for (const name of files) {
      await fsp.writeFile(path.join(harness.evidenceDir, name), "png", "utf8");
    }
    if (registry !== undefined) {
      await fsp.writeFile(
        harness.registryPath,
        JSON.stringify(registry, null, 2) + "\n",
        "utf8"
      );
    }

    const args = process.platform === "win32"
      ? [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          harness.runnerPath,
          helperPath,
          registry === undefined ? "" : harness.registryPath,
          harness.evidenceDir,
          mode
        ]
      : [
          "-NoLogo",
          "-NoProfile",
          "-File",
          harness.runnerPath,
          helperPath,
          registry === undefined ? "" : harness.registryPath,
          harness.evidenceDir,
          mode
        ];

    const result = spawnSync(powershellCommand(), args, {
      encoding: "utf8",
      timeout: 30_000
    });
    return { ...result, harness };
  } finally {
    // Tests needing the evidence path must fully construct registry before calling.
  }
}

function registryWithLane1(lane1 = {}) {
  return {
    schema_version: "three-lane-registry.v1",
    mode: "THREE_LANE_V1",
    lanes: {
      "lane-1": lane1,
      "lane-2": {},
      "lane-3": {}
    }
  };
}

test("runtime integrity optional latch audit handles null latches under StrictMode", async () => {
  const result = await runAudit({
    registry: registryWithLane1({
      relay_inflight: null,
      dispatch_inflight: null
    })
  });
  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(result.stdout.trim());
  assert.equal(audit.blocked_relay_count, 0);
  assert.equal(audit.blocked_dispatch_count, 0);
  assert.equal(audit.orphan_evidence_count, 0);
  await fsp.rm(result.harness.root, { recursive: true, force: true });
});

test("legacy valid latches may omit reconcile_blocked and screenshot_path", async () => {
  const result = await runAudit({
    registry: registryWithLane1({
      relay_inflight: { relay_id: "relay-legacy" },
      dispatch_inflight: { dispatch_id: "dispatch-legacy" }
    })
  });
  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(result.stdout.trim());
  assert.equal(audit.blocked_relay_count, 0);
  assert.equal(audit.blocked_dispatch_count, 0);
  await fsp.rm(result.harness.root, { recursive: true, force: true });
});

test("explicit reconcile_blocked=false remains healthy", async () => {
  const result = await runAudit({
    registry: registryWithLane1({
      relay_inflight: { reconcile_blocked: false },
      dispatch_inflight: { reconcile_blocked: false }
    }),
    mode: "assert"
  });
  assert.equal(result.status, 0, result.stderr);
  await fsp.rm(result.harness.root, { recursive: true, force: true });
});

test("explicit reconcile_blocked=true remains fail-closed", async () => {
  const dispatch = await runAudit({
    registry: registryWithLane1({
      dispatch_inflight: { reconcile_blocked: true }
    }),
    mode: "assert"
  });
  assert.notEqual(dispatch.status, 0);
  assert.match(dispatch.stderr, /dispatch_inflight latch remains reconcile_blocked/);
  await fsp.rm(dispatch.harness.root, { recursive: true, force: true });

  const relay = await runAudit({
    registry: registryWithLane1({
      relay_inflight: { reconcile_blocked: true }
    }),
    mode: "assert"
  });
  assert.notEqual(relay.status, 0);
  assert.match(relay.stderr, /relay_inflight latch remains reconcile_blocked/);
  await fsp.rm(relay.harness.root, { recursive: true, force: true });
});

test("orphan evidence semantics are unchanged while optional screenshot_path is safe", async () => {
  const harness = await makeHarness();
  try {
    const activePath = path.join(harness.evidenceDir, "active.png");
    const orphanPath = path.join(harness.evidenceDir, "orphan.png");
    await fsp.writeFile(activePath, "png", "utf8");
    await fsp.writeFile(orphanPath, "png", "utf8");
    await fsp.writeFile(
      harness.registryPath,
      JSON.stringify(
        registryWithLane1({
          relay_inflight: { relay_id: "relay-active", screenshot_path: activePath }
        }),
        null,
        2
      ) + "\n",
      "utf8"
    );

    const baseArgs = process.platform === "win32"
      ? ["-NoLogo","-NoProfile","-ExecutionPolicy","Bypass","-File",harness.runnerPath,helperPath,harness.registryPath,harness.evidenceDir,"assert"]
      : ["-NoLogo","-NoProfile","-File",harness.runnerPath,helperPath,harness.registryPath,harness.evidenceDir,"assert"];

    const failed = spawnSync(powershellCommand(), baseArgs, {
      encoding: "utf8",
      timeout: 30_000
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Orphan relay evidence remains after runtime startup cleanup/);

    await fsp.rm(orphanPath, { force: true });
    const passed = spawnSync(powershellCommand(), baseArgs, {
      encoding: "utf8",
      timeout: 30_000
    });
    assert.equal(passed.status, 0, passed.stderr);
  } finally {
    await fsp.rm(harness.root, { recursive: true, force: true });
  }
});

test("audit output is metadata-only and workflow avoids unsafe optional latch dereference", async () => {
  const privateUrl = "https://chatgpt.com/c/private-conversation";
  const secretToken = "secret-token-should-not-appear";
  const privateBody = "private message body should not appear";
  const result = await runAudit({
    registry: registryWithLane1({
      work_url: privateUrl,
      relay_inflight: {
        relay_id: "relay-safe",
        token: secretToken,
        message_body: privateBody
      }
    })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /chatgpt\.com|secret-token|private message body/i);
  await fsp.rm(result.harness.root, { recursive: true, force: true });

  const workflow = await fsp.readFile(workflowPath, "utf8");
  assert.match(workflow, /Assert-SupervisorLatchIntegrity/);
  assert.doesNotMatch(workflow, /relay_inflight\.reconcile_blocked/);
  assert.doesNotMatch(workflow, /dispatch_inflight\.reconcile_blocked/);
  assert.doesNotMatch(workflow, /relay_inflight\.screenshot_path/);
});
