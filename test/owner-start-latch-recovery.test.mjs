import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const read = (relative) =>
  fsp.readFile(new URL(relative, import.meta.url), "utf8");

function findPowerShell() {
  const candidates = process.platform === "win32"
    ? ["powershell.exe", "pwsh.exe"]
    : ["pwsh", "powershell"];
  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate,
      ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
      { encoding: "utf8" }
    );
    if (probe.status === 0) return candidate;
  }
  return null;
}

const powershell = findPowerShell();

function psQuote(value) {
  return String(value).replaceAll("'", "''");
}

function runPowerShell(script) {
  return spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8" }
  );
}

test(
  "Owner START latch helper clears STOP plus AUTOSTART_DISABLED deterministically and idempotently",
  { skip: !powershell },
  async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "magasin-owner-start-"));
    const helper = fileURLToPath(
      new URL("../windows/lifecycle-truth.ps1", import.meta.url)
    );
    try {
      await fsp.writeFile(path.join(root, "STOP"), "STOP");
      await fsp.writeFile(path.join(root, "AUTOSTART_DISABLED"), "OWNER_STOP");

      const command = [
        "$ErrorActionPreference = 'Stop'",
        `. '${psQuote(helper)}'`,
        `Clear-LifecycleOwnerStopLatches -Root '${psQuote(root)}' | Out-Null`,
        `$state = Get-LifecycleOwnerStopState -Root '${psQuote(root)}'`,
        "if ($state.blocked) { throw 'blocked after explicit clear' }"
      ].join("; ");
      const first = runPowerShell(command);
      assert.equal(
        first.status,
        0,
        `first clear failed:\n${first.stdout}\n${first.stderr}`
      );
      assert.equal(fs.existsSync(path.join(root, "STOP")), false);
      assert.equal(fs.existsSync(path.join(root, "AUTOSTART_DISABLED")), false);

      const second = runPowerShell(command);
      assert.equal(
        second.status,
        0,
        `idempotent clear failed:\n${second.stdout}\n${second.stderr}`
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }
);

test(
  "Owner START latch helper fails closed when a latch cannot be removed",
  { skip: !powershell },
  async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "magasin-owner-start-fail-"));
    const helper = fileURLToPath(
      new URL("../windows/lifecycle-truth.ps1", import.meta.url)
    );
    const stopDir = path.join(root, "STOP");
    try {
      await fsp.mkdir(stopDir);
      await fsp.writeFile(path.join(stopDir, "guard.txt"), "not removable without recurse");
      const command = [
        "$ErrorActionPreference = 'Stop'",
        `. '${psQuote(helper)}'`,
        `Clear-LifecycleOwnerStopLatches -Root '${psQuote(root)}' | Out-Null`
      ].join("; ");
      const result = runPowerShell(command);
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(stopDir), true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }
);

test("explicit Owner START authority runs before every already-running shortcut", async () => {
  const start = await read("../windows/start-supervisor.ps1");
  const clearIndex = start.indexOf("Clear-LifecycleOwnerStopLatches -Root $root");
  const wrapperIndex = start.indexOf("$existingWrapper = Get-LifecycleSupervisorWrapper");
  const pidIndex = start.indexOf("if (Test-Path $pidFile)");

  assert.ok(clearIndex >= 0);
  assert.ok(wrapperIndex > clearIndex);
  assert.ok(pidIndex > clearIndex);
  assert.match(start, /OWNER_START_LATCH_CLEAR=True/);
  assert.match(start, /OWNER_START_EXISTING_WRAPPER_REUSED=True/);
  assert.match(start, /Explicit Owner START refused success because Owner STOP remains active/);
});

test("Recovery START checks Owner STOP before wrapper/PID shortcuts and never clears latches", async () => {
  const start = await read("../windows/start-supervisor.ps1");
  const recoveryStart = start.indexOf("if ($Recovery)");
  const explicitElse = start.indexOf("} else {", recoveryStart);
  const wrapperIndex = start.indexOf("$existingWrapper = Get-LifecycleSupervisorWrapper");
  const recovery = start.slice(recoveryStart, explicitElse);

  assert.ok(recoveryStart >= 0 && explicitElse > recoveryStart);
  assert.ok(wrapperIndex > explicitElse);
  assert.match(recovery, /Get-LifecycleOwnerStopState -Root \$root/);
  assert.match(recovery, /RECOVERY_START_BLOCKED_OWNER_STOP=True/);
  assert.doesNotMatch(recovery, /Clear-LifecycleOwnerStopLatches|Remove-Item \$stop|Remove-Item \$autostartDisabled/);
});

test("stale PID reuse cannot bypass latch authority or kill unrelated process", async () => {
  const start = await read("../windows/start-supervisor.ps1");
  assert.match(start, /Get-CimInstance Win32_Process -Filter "ProcessId=\$parsedPid"/);
  assert.match(start, /STALE_SUPERVISOR_PID_IGNORED=True/);
  const pidBranch = start.slice(
    start.indexOf("if (Test-Path $pidFile)"),
    start.indexOf("# Prevent GitHub Actions orphan-process cleanup")
  );
  assert.doesNotMatch(pidBranch, /Stop-Process|taskkill\.exe/);
});

test("STOP classifies taskkill child-exit race by root process truth and refuses false success", async () => {
  const stop = await read("../windows/stop-supervisor.ps1");
  assert.match(stop, /function Stop-DedicatedProcessTree/);
  assert.match(stop, /STOP_TASKKILL_RACE_RESOLVED=True/);
  assert.match(stop, /Test-ProcessAlive \$ProcessId/);
  assert.match(stop, /still alive after bounded force-stop/);
  assert.match(stop, /Supervisor STOP refused success because wrapper PID/);
});

test("Control Panel runtime-start button invokes explicit Owner START, not Recovery", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const startButton = panel.slice(
    panel.indexOf("$runtimeStartButton.Add_Click"),
    panel.indexOf("$content.Controls.Add($runtimeStartButton)")
  );
  assert.match(startButton, /\$startScript/);
  assert.match(startButton, /'-Hidden'/);
  assert.doesNotMatch(startButton, /-Recovery/);
});

test("Lifecycle technical cleanup classifies taskkill race from root process truth", async () => {
  const workflow = await read("../../../.github/workflows/supervisor-lifecycle-acceptance.yml");
  const start = workflow.indexOf("function Stop-TechnicalProcessTree");
  const end = workflow.indexOf("function Stop-RuntimeTechnical", start);
  assert.ok(start >= 0 && end > start);
  const helper = workflow.slice(start, end);
  assert.match(helper, /taskkill\.exe \/PID \$ProcessId \/T \/F/);
  assert.match(helper, /Get-Process -Id \$ProcessId/);
  assert.match(helper, /LIFECYCLE_TECHNICAL_TASKKILL_RACE_RESOLVED=True/);
  assert.match(helper, /\$global:LASTEXITCODE = 0/);
  const proofIndex = helper.indexOf("if (-not (Get-Process -Id $ProcessId");
  const resetIndex = helper.indexOf("$global:LASTEXITCODE = 0");
  assert.ok(proofIndex >= 0 && resetIndex > proofIndex);
  assert.match(helper, /still alive/);
});

test("Lifecycle acceptance keeps final Owner STOP assertion and verifies clear before healthy wait", async () => {
  const workflow = await read("../../../.github/workflows/supervisor-lifecycle-acceptance.yml");
  const explicitStart = workflow.indexOf("-File $startScript -Hidden");
  const immediateTruth = workflow.indexOf("$ownerStartTruth = Get-LifecycleOwnerStopState", explicitStart);
  const healthy = workflow.indexOf("Wait-Healthy 60", immediateTruth);

  assert.ok(explicitStart >= 0);
  assert.ok(immediateTruth > explicitStart);
  assert.ok(healthy > immediateTruth);
  assert.match(workflow, /OWNER_START_LATCHES_CLEARED=True/);
  assert.match(workflow, /OWNER_START_SINGLE_WRAPPER=True/);
  assert.match(workflow, /Acceptance left an Owner STOP latch behind/);
  assert.match(workflow, /LIFECYCLE_ACCEPTANCE_A_TO_L=PASS/);
});

test("Lifecycle residue migration is one-time historical and still uses explicit Owner START", async () => {
  const workflow = await read("../../../.github/workflows/supervisor-lifecycle-acceptance.yml");
  const start = workflow.indexOf("function Test-KnownRbt006BResidue");
  const end = workflow.indexOf("$initialConfig =", start);
  const residue = workflow.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(residue, /2026-09-21T00:34:30Z/);
  assert.match(residue, /2026-09-21T00:35:10Z/);
  assert.match(residue, /RBT006B_KNOWN_ACCEPTANCE_RESIDUE_DETECTED=True/);
  assert.match(residue, /RBT006B_KNOWN_ACCEPTANCE_RESIDUE_RECOVERED=True/);
  assert.match(residue, /-File \$startScript -Hidden/);
  assert.match(residue, /Pre-existing Owner STOP is active\. Acceptance refuses to clear an Owner latch/);
  assert.doesNotMatch(residue, /Remove-Item.*STOP|Remove-Item.*AUTOSTART_DISABLED/);
});

test("lifecycle START/STOP does not reset target, task, latch, pending Work or quarantine state", async () => {
  const [start, stop] = await Promise.all([
    read("../windows/start-supervisor.ps1"),
    read("../windows/stop-supervisor.ps1")
  ]);
  for (const source of [start, stop]) {
    assert.doesNotMatch(source, /lane-registry\.json[\s\S]{0,160}Remove-Item/);
    assert.doesNotMatch(source, /lanes\.json[\s\S]{0,160}Remove-Item/);
    assert.doesNotMatch(source, /brain_target_health\s*=/);
    assert.doesNotMatch(source, /work_target_health\s*=/);
  }
});

test("TASK-RBT-006B remains canonical after Supervisor runtime v60 planning bump", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  assert.match(runtime, /SUPERVISOR_RUNTIME_VERSION = "2026-09-20\.60"/);
});
