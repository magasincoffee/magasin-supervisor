import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildProductionPlannerBootstrap,
  preparePlannerExecutorProductionCutover
} from "../src/runtime/planner-executor-cutover.mjs";

const PLANNER = "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111";
const EXECUTOR = "https://chatgpt.com/c/22222222-2222-2222-2222-222222222222";

function legacyFixture() {
  return {
    config: {
      schema_version: "three-lane-config.v1",
      mode: "THREE_LANE_V1",
      lanes: [
        {
          lane_id: "lane-1",
          project_name: "UI2",
          brain_url: PLANNER,
          brain_url_revision: 4,
          work_url: EXECUTOR,
          work_url_revision: 5,
          work_url_saved_at: null,
          work_mode: "OWNER",
          enabled: true
        },
        {
          lane_id: "lane-2",
          project_name: "Project 2",
          brain_url: "",
          brain_url_revision: 0,
          work_url: "",
          work_url_revision: 0,
          work_url_saved_at: null,
          work_mode: "AUTO",
          enabled: false
        },
        {
          lane_id: "lane-3",
          project_name: "Project 3",
          brain_url: "",
          brain_url_revision: 0,
          work_url: "",
          work_url_revision: 0,
          work_url_saved_at: null,
          work_mode: "AUTO",
          enabled: false
        }
      ]
    },
    registry: {
      schema_version: "three-lane-registry.v1",
      mode: "THREE_LANE_V1",
      lanes: {
        "lane-1": {
          lane_id: "lane-1",
          brain_url: PLANNER,
          applied_brain_url_revision: 4,
          work_url: EXECUTOR,
          work_generation: 2,
          applied_work_url_revision: 5,
          pending_work_url: "",
          pending_work_url_revision: 0,
          task_id: null,
          instruction_digest: null,
          last_brain_directive_digest: null,
          last_work_result_digest: null,
          last_result_relay_id: null,
          last_result_verdict: null,
          last_dispatch_id: null,
          dispatch_inflight: null,
          relay_inflight: null,
          brain_request_inflight: null,
          brain_request_sent: false,
          awaiting_work: false,
          project_progress: {
            schema_version: "project-progress.v1",
            plan_known: true,
            tasks: []
          },
          task_timing: {
            schema_version: "task-timing.v1",
            task_id: null
          }
        },
        "lane-2": {
          lane_id: "lane-2",
          brain_url: "",
          applied_brain_url_revision: 0,
          work_url: "",
          work_generation: 0,
          applied_work_url_revision: 0,
          pending_work_url: "",
          pending_work_url_revision: 0,
          task_id: null,
          dispatch_inflight: null,
          relay_inflight: null,
          brain_request_inflight: null,
          brain_request_sent: false,
          awaiting_work: false
        },
        "lane-3": {
          lane_id: "lane-3",
          brain_url: "",
          applied_brain_url_revision: 0,
          work_url: "",
          work_generation: 0,
          applied_work_url_revision: 0,
          pending_work_url: "",
          pending_work_url_revision: 0,
          task_id: null,
          dispatch_inflight: null,
          relay_inflight: null,
          brain_request_inflight: null,
          brain_request_sent: false,
          awaiting_work: false
        }
      }
    }
  };
}

async function writeLegacyRoot({ activeTask = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-pe007-cutover-"));
  const fixture = legacyFixture();
  if (activeTask) {
    fixture.registry.lanes["lane-1"].task_id = activeTask;
    fixture.registry.lanes["lane-1"].awaiting_work = true;
  }
  await fs.writeFile(
    path.join(root, "lanes.json"),
    JSON.stringify(fixture.config, null, 2) + "\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "lane-registry.json"),
    JSON.stringify(fixture.registry, null, 2) + "\n",
    "utf8"
  );
  return root;
}

test("PE-007 cutover candidate is ready only for an idle qualified legacy lane", async () => {
  const root = await writeLegacyRoot();
  const candidate = await preparePlannerExecutorProductionCutover({
    root,
    laneId: "lane-1",
    authorizedAt: "2026-09-27T11:55:00+07:00",
    sourceRevision: "abc123"
  });

  assert.equal(candidate.cutover_ready, true);
  assert.deepEqual(candidate.blockers, []);
  assert.equal(candidate.state.mode, "PLANNER_EXECUTOR_V1");
  assert.equal(candidate.state.project_name, "UI2");
  assert.equal(candidate.state.planner.target, PLANNER);
  assert.equal(candidate.state.executor.target, EXECUTOR);
  assert.equal(candidate.state.production_cutover.authorized, true);
  assert.equal(
    candidate.state.production_cutover.source_lane_id,
    "lane-1"
  );
  assert.equal(candidate.state.cutover_bootstrap.required, true);
  assert.ok(candidate.state.cutover_bootstrap.message_digest);
  assert.match(
    candidate.state.cutover_bootstrap.message,
    /Planner\/Executor V1/
  );
  assert.match(
    candidate.state.cutover_bootstrap.message,
    /Không dùng ChatGPT Work mode/
  );
  assert.match(
    candidate.state.cutover_bootstrap.message,
    /@M \{"v":1,"a":"assign"/
  );
});

test("PE-007 cutover preserves PE-005 fail-closed blockers for an active legacy task", async () => {
  const root = await writeLegacyRoot({ activeTask: "UI2-015" });
  const candidate = await preparePlannerExecutorProductionCutover({
    root,
    laneId: "lane-1",
    authorizedAt: "2026-09-27T11:55:00+07:00",
    sourceRevision: "abc123"
  });

  assert.equal(candidate.cutover_ready, false);
  assert.ok(candidate.blockers.includes("ACTIVE_LEGACY_TASK"));
  assert.ok(candidate.blockers.includes("LEGACY_AWAITING_EXECUTOR"));
});

test("production bootstrap is compact, role-specific, and never invokes Work mode", () => {
  const message = buildProductionPlannerBootstrap({
    projectName: "UI2",
    sourceLaneId: "lane-1"
  });
  assert.match(message, /Bạn là Planner/);
  assert.match(message, /giao đúng MỘT task/);
  assert.match(message, /Không dùng ChatGPT Work mode/);
  assert.doesNotMatch(message, /MAGASIN_WORK_DISPATCH_V1/);
});

test("Planner bootstrap runs only after execute-mode dry-run exit", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/planner-executor-cli.mjs", import.meta.url),
    "utf8"
  );
  const dryRunIndex = source.indexOf("if (!args.execute)");
  const bootstrapIndex = source.indexOf("await ensureProductionPlannerBootstrap({");
  assert.ok(dryRunIndex >= 0);
  assert.ok(bootstrapIndex > dryRunIndex);
  assert.match(source.slice(dryRunIndex, bootstrapIndex), /process\.exit\(0\)/);
});

test("production wrapper routes explicit Planner/Executor state before legacy project-adapter mode", async () => {
  const source = await fs.readFile(
    new URL("../windows/run-supervisor.ps1", import.meta.url),
    "utf8"
  );
  assert.match(source, /planner-executor-state\.json/);
  assert.match(source, /PLANNER_EXECUTOR_V1/);
  assert.match(source, /planner-executor-cli\.mjs/);
  assert.match(source, /--state/);
  assert.match(
    source,
    /runtimeMode -ne 'PLANNER_EXECUTOR_V1'/
  );
});

test("lifecycle truth recognizes Planner/Executor as the active production runtime", async () => {
  const source = await fs.readFile(
    new URL("../windows/lifecycle-truth.ps1", import.meta.url),
    "utf8"
  );
  assert.match(source, /Get-LifecyclePlannerExecutorProcess/);
  assert.match(source, /planner_executor_alive/);
  assert.match(source, /runtime_mode/);
  assert.match(source, /PLANNER_EXECUTOR_V1/);
});

test("production cutover script has rollback, double preflight, and explicit target authority", async () => {
  const source = await fs.readFile(
    new URL(
      "../.github/scripts/supervisor-pe007-production-cutover.ps1",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(source, /DESKTOP-4K7IM13/);
  assert.match(source, /owner_cutover_authorization/);
  assert.match(source, /Write-Candidate/);
  assert.match(source, /Stop-SupervisorTechnical/);
  assert.match(source, /New-RollbackSnapshot/);
  assert.match(source, /Restore-RollbackSnapshot/);
  assert.match(source, /PE007_PRODUCTION_CUTOVER=PASS/);
  assert.match(source, /planner-executor-status\.json/);
  assert.match(source, /chatgpt_work_mode_invocations/);
});
