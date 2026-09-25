import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cliPath = path.join(repoRoot, "src", "runtime", "reset-all-projects-cli.mjs");
const controlPanelPath = path.join(repoRoot, "windows", "control-panel.ps1");
const resetPsPath = path.join(repoRoot, "windows", "reset-all-projects.ps1");

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("reset-all helper replaces all three projects with clean disabled canonical state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-reset-all-"));
  try {
    await fs.writeFile(path.join(root, "lanes.json"), JSON.stringify({
      schema_version: "three-lane-config.v1",
      mode: "THREE_LANE_V1",
      lanes: [
        { lane_id: "lane-1", project_name: "OLD-1", brain_url: "https://chatgpt.com/c/old-1", work_url: "https://chatgpt.com/c/work-1", enabled: true },
        { lane_id: "lane-2", project_name: "OLD-2", brain_url: "https://chatgpt.com/c/old-2", work_url: "https://chatgpt.com/c/work-2", enabled: true },
        { lane_id: "lane-3", project_name: "OLD-3", brain_url: "https://chatgpt.com/c/old-3", work_url: "https://chatgpt.com/c/work-3", enabled: true }
      ]
    }), "utf8");
    await fs.writeFile(path.join(root, "lane-registry.json"), JSON.stringify({
      lanes: {
        "lane-1": { task_id: "TASK-OLD", dispatch_inflight: { dispatch_id: "old" }, awaiting_work: true }
      }
    }), "utf8");
    await fs.writeFile(path.join(root, "lane-status.json"), "stale", "utf8");
    await fs.writeFile(path.join(root, "lane-events.ndjson"), "{\"event_type\":\"OLD\"}\n", "utf8");
    await fs.mkdir(path.join(root, "lane-evidence"), { recursive: true });
    await fs.writeFile(path.join(root, "lane-evidence", "old.png"), "old", "utf8");
    await fs.mkdir(path.join(root, "browser_profile"), { recursive: true });
    await fs.writeFile(path.join(root, "browser_profile", "login-preserved.txt"), "keep", "utf8");

    const result = await runNode([cliPath, "--root", root]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /RESET_ALL_PROJECTS_LANES_DISABLED=True/);
    assert.match(result.stdout, /RESET_ALL_PROJECTS_TASK_STATE_CLEARED=True/);
    assert.match(result.stdout, /RESET_ALL_PROJECTS_BROWSER_PROFILE_PRESERVED=True/);

    const config = JSON.parse(await fs.readFile(path.join(root, "lanes.json"), "utf8"));
    assert.equal(config.lanes.length, 3);
    for (const [index, lane] of config.lanes.entries()) {
      assert.equal(lane.lane_id, `lane-${index + 1}`);
      assert.equal(lane.project_name, `Dự án ${index + 1}`);
      assert.equal(lane.enabled, false);
      assert.equal(lane.brain_url, "");
      assert.equal(lane.work_url, "");
      assert.equal(lane.brain_url_revision, 0);
      assert.equal(lane.work_url_revision, 0);
    }

    const registry = JSON.parse(await fs.readFile(path.join(root, "lane-registry.json"), "utf8"));
    for (const laneId of ["lane-1", "lane-2", "lane-3"]) {
      const lane = registry.lanes[laneId];
      assert.equal(lane.task_id, null);
      assert.equal(lane.dispatch_inflight, null);
      assert.equal(lane.relay_inflight, null);
      assert.equal(lane.brain_request_inflight, null);
      assert.equal(lane.awaiting_work, false);
      assert.equal(lane.pending_work_url, "");
      assert.equal(lane.work_generation, 0);
      assert.equal(lane.brain_target_health.state, "UNKNOWN");
      assert.equal(lane.work_target_health.state, "UNKNOWN");
    }

    await assert.rejects(fs.stat(path.join(root, "lane-status.json")));
    assert.equal((await fs.stat(path.join(root, "lane-events.ndjson"))).size, 0);
    await assert.rejects(fs.stat(path.join(root, "lane-evidence")));
    assert.equal(
      await fs.readFile(path.join(root, "browser_profile", "login-preserved.txt"), "utf8"),
      "keep"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Owner reset wrapper is fail-closed and preserves installation/login authority", async () => {
  const source = await fs.readFile(resetPsPath, "utf8");
  assert.match(source, /param\(\s*\[switch\]\$Confirmed/);
  assert.match(source, /if \(-not \$Confirmed\)/);
  assert.match(source, /stop-supervisor\.ps1/);
  assert.match(source, /reset-all-projects-cli\.mjs/);
  assert.match(source, /browser_profile/);
  assert.doesNotMatch(source, /Remove-Item\s+\$profile\b/i);
  assert.match(source, /STOP/);
  assert.match(source, /AUTOSTART_DISABLED/);
  assert.match(source, /RESET_ALL_PROJECTS_OWNER_STOP_PRESERVED=True/);
  assert.match(source, /RESET_ALL_PROJECTS_RUNNER_UNCHANGED=True/);
  assert.match(source, /RESET_ALL_PROJECTS_RUNTIME_INSTALL_UNCHANGED=True/);
});

test("Control Panel exposes double-confirmed reset-all control and Runner auto-detection", async () => {
  const source = await fs.readFile(controlPanelPath, "utf8");
  assert.match(source, /LÀM SẠCH TẤT CẢ DỰ ÁN/);
  assert.match(source, /XÁC NHẬN LẦN CUỐI/);
  assert.match(source, /reset-all-projects\.ps1/);
  assert.match(source, /-File \$resetAllProjectsScript -Confirmed/);
  assert.match(source, /Refresh-Ui/);
  assert.match(source, /C:\\actions-runner-magasin-supervisor\\actions-runner/);
  assert.match(source, /Runner\.Listener\.exe/);
  assert.match(source, /Split-Path \$binDir -Parent/);
  assert.match(source, /\$env:SUPERVISOR_RUNNER_ROOT = \$runnerRoot/);
});
