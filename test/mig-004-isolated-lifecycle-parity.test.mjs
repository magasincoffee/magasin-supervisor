import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const ps = (...parts) => path.join(repoRoot, ...parts);
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";

function runPowerShell(script, env = {}) {
  const args = process.platform === "win32"
    ? ["-NoLogo","-NoProfile","-ExecutionPolicy","Bypass","-Command",script]
    : ["-NoLogo","-NoProfile","-Command",script];
  return spawnSync(powershell, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30000
  });
}

async function makeRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "magasin-mig004-"));
  const config = {
    schema_version: "three-lane.v1",
    mode: "THREE_LANE_V1",
    lanes: [
      { lane_id:"lane-1", enabled:true, brain_url:"opaque-brain-1", brain_url_revision:4, work_url:"opaque-work-1", work_url_revision:7 },
      { lane_id:"lane-2", enabled:false, brain_url:"opaque-brain-2", brain_url_revision:2, work_url:"", work_url_revision:0 },
      { lane_id:"lane-3", enabled:false, brain_url:"opaque-brain-3", brain_url_revision:1, work_url:"", work_url_revision:0 }
    ]
  };
  await fsp.writeFile(path.join(root, "lanes.json"), JSON.stringify(config, null, 2) + "\n");
  await fsp.writeFile(path.join(root, "lane-registry.json"), JSON.stringify({
    schema_version:"three-lane-registry.v1",
    mode:"THREE_LANE_V1",
    lanes:{
      "lane-1":{dispatch_inflight:{dispatch_id:"opaque-dispatch",reconcile_blocked:false},relay_inflight:null},
      "lane-2":{dispatch_inflight:null,relay_inflight:null},
      "lane-3":{dispatch_inflight:null,relay_inflight:null}
    }
  }, null, 2) + "\n");
  return root;
}

async function fingerprint(root) {
  const data = await fsp.readFile(path.join(root, "lanes.json"));
  return crypto.createHash("sha256").update(data).digest("hex");
}

test("MIG-004 isolated root resolves explicitly and never falls back to production root", async () => {
  const root = await makeRoot();
  try {
    const script = [
      '. "./windows/state-root.ps1"',
      '$resolved = Get-SupervisorStateRoot -Compatibility "legacy-preserve"',
      'Write-Output $resolved'
    ].join("; ");
    const result = runPowerShell(script, { SUPERVISOR_STATE_ROOT: root });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(path.resolve(result.stdout.trim()).toLowerCase(), path.resolve(root).toLowerCase());
  } finally {
    await fsp.rm(root, { recursive:true, force:true });
  }
});

test("MIG-004 lifecycle Owner STOP semantics are proven inside isolated root with target preservation", async () => {
  const root = await makeRoot();
  try {
    await fsp.writeFile(path.join(root, "STOP"), "STOP\n");
    await fsp.writeFile(path.join(root, "AUTOSTART_DISABLED"), "OWNER_STOP\n");
    const before = await fingerprint(root);
    const script = [
      '. "./windows/lifecycle-truth.ps1"',
      '$before = Get-LifecycleOwnerStopState -Root $env:SUPERVISOR_STATE_ROOT',
      'if (-not $before.blocked) { throw "Owner STOP not detected" }',
      '$enabled = Get-EnabledLaneCount -Root $env:SUPERVISOR_STATE_ROOT',
      'if ($enabled -ne 1) { throw "Enabled lane count mismatch" }',
      '$truth = Get-LifecycleProcessTruth -Root $env:SUPERVISOR_STATE_ROOT',
      'if ($truth.healthy) { throw "Synthetic isolated root must not report a healthy production process" }',
      '$after = Clear-LifecycleOwnerStopLatches -Root $env:SUPERVISOR_STATE_ROOT',
      'if ($after.blocked) { throw "Explicit Owner START latch-clear contract failed in fixture" }',
      'Write-Output "MIG004_ISOLATED_OWNER_STOP=PASS"'
    ].join("; ");
    const result = runPowerShell(script, { SUPERVISOR_STATE_ROOT: root });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MIG004_ISOLATED_OWNER_STOP=PASS/);
    const after = await fingerprint(root);
    assert.equal(after, before, "lifecycle latch operations must preserve lane target configuration");
    await assert.rejects(fsp.access(path.join(root, "STOP")));
    await assert.rejects(fsp.access(path.join(root, "AUTOSTART_DISABLED")));
  } finally {
    await fsp.rm(root, { recursive:true, force:true });
  }
});

test("MIG-004 install/start/stop/repair contracts retain explicit state-root boundary and do not reset lane truth", async () => {
  const [install,start,stop,repair,autostart] = await Promise.all([
    fsp.readFile(ps("windows","install-supervisor.ps1"),"utf8"),
    fsp.readFile(ps("windows","start-supervisor.ps1"),"utf8"),
    fsp.readFile(ps("windows","stop-supervisor.ps1"),"utf8"),
    fsp.readFile(ps("windows","repair-supervisor.ps1"),"utf8"),
    fsp.readFile(ps("windows","install-autostart.ps1"),"utf8")
  ]);
  for (const source of [install,start,stop,repair,autostart]) {
    assert.match(source, /Get-SupervisorStateRoot/);
  }
  assert.match(install, /Remove-Item \$runtime -Recurse -Force/);
  assert.doesNotMatch(install, /Remove-Item .*lanes\.json/i);
  assert.doesNotMatch(install, /Remove-Item .*lane-registry\.json/i);
  assert.match(start, /Clear-LifecycleOwnerStopLatches -Root \$root/);
  assert.match(stop, /AUTOSTART_DISABLED/);
  assert.match(repair, /OWNER_STOP_PRESERVED=True/);
  assert.match(autostart, /OWNER_STOP_PRESERVED_DURING_AUTOSTART_INSTALL=True/);
});

test("MIG-004 production-capable workflows remain fail-closed while hosted parity is active", async () => {
  const [life,auto,state,panel,rbt,integrity] = await Promise.all([
    fsp.readFile(ps(".github","workflows","supervisor-lifecycle-acceptance.yml"),"utf8"),
    fsp.readFile(ps(".github","workflows","supervisor-autostart-install.yml"),"utf8"),
    fsp.readFile(ps(".github","workflows","supervisor-state-maintenance.yml"),"utf8"),
    fsp.readFile(ps(".github","workflows","supervisor-open-control-panel.yml"),"utf8"),
    fsp.readFile(ps(".github","workflows","supervisor-rbt009-soak.yml"),"utf8"),
    fsp.readFile(ps(".github","workflows","supervisor-integrity.yml"),"utf8")
  ]);
  assert.match(life, /lifecycle-parity-hosted/);
  assert.match(life, /lifecycle-acceptance:\n\s+if: \$\{\{ false \}\}/);
  assert.match(auto, /installer-autostart-parity-hosted/);
  assert.match(auto, /install:\n\s+if: \$\{\{ false \}\}/);
  assert.match(state, /maintenance:\n\s+if: \$\{\{ false \}\}/);
  assert.match(panel, /open-robot:\n\s+if: \$\{\{ false \}\}/);
  assert.match(integrity, /runtime-audit:\n[\s\S]*?if: \$\{\{ false \}\}/);
  assert.match(rbt, /tier-a-isolated-integration/);
  assert.match(rbt, /tier-b:\n\s+if: \$\{\{ false \}\}/);
  assert.match(rbt, /DurationMinutes 480/);
});

test("MIG-004 state-maintenance safety regression is purely contract/read-only on hosted validation", async () => {
  const script = fsp.readFile(ps(".github","scripts","supervisor-state-maintenance-regression.ps1"),"utf8");
  const workflow = fsp.readFile(ps(".github","workflows","supervisor-state-maintenance.yml"),"utf8");
  const [s,w] = await Promise.all([script,workflow]);
  assert.match(s, /STATE_MAINTENANCE_AUDIT_READ_ONLY=PASS/);
  assert.match(s, /STATE_MAINTENANCE_VERSION_PREFLIGHT=PASS/);
  assert.match(s, /STATE_MAINTENANCE_TRUE_BLOCKED_FAIL_CLOSED=PASS/);
  assert.match(s, /STATE_MAINTENANCE_TARGET_PRESERVATION=PASS/);
  assert.match(s, /STATE_MAINTENANCE_PRIVACY=PASS/);
  assert.doesNotMatch(w, /^\s{2}push:/m);
});
