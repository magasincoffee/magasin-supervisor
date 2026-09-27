import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  migrateLegacyLaneToPlannerExecutor,
  migrateLegacyPlannerExecutorJson,
  parseLegacyPlannerExecutorSource,
  readLegacyPlannerExecutorCandidate
} from "../src/runtime/planner-executor-legacy-migration.mjs";

const PLANNER = "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111";
const EXECUTOR = "https://chatgpt.com/c/22222222-2222-2222-2222-222222222222";
const EXECUTOR_NEXT = "https://chatgpt.com/c/33333333-3333-3333-3333-333333333333";

function lane(id, index) {
  return {
    lane_id: id,
    project_name: `Project ${index}`,
    brain_url: "",
    brain_url_revision: 0,
    work_url: "",
    work_url_revision: 0,
    work_url_saved_at: null,
    work_mode: "AUTO",
    enabled: false
  };
}

function registryLane(id) {
  return {
    lane_id: id,
    brain_url: "",
    applied_brain_url_revision: 0,
    work_url: "",
    work_generation: 0,
    applied_work_url_revision: 0,
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
      plan_known: false,
      tasks: []
    },
    task_timing: {
      schema_version: "task-timing.v1",
      task_id: null
    }
  };
}

function fixture() {
  const ids = ["lane-1", "lane-2", "lane-3"];
  const config = {
    schema_version: "three-lane-config.v1",
    mode: "THREE_LANE_V1",
    lanes: ids.map((id, index) => lane(id, index + 1))
  };
  const registry = {
    schema_version: "three-lane-registry.v1",
    mode: "THREE_LANE_V1",
    lanes: Object.fromEntries(ids.map((id) => [id, registryLane(id)]))
  };

  const cfg = config.lanes[0];
  Object.assign(cfg, {
    project_name: "UI2",
    brain_url: PLANNER,
    brain_url_revision: 7,
    work_url: EXECUTOR,
    work_url_revision: 9,
    work_mode: "OWNER",
    enabled: true
  });

  Object.assign(registry.lanes["lane-1"], {
    brain_url: PLANNER,
    applied_brain_url_revision: 7,
    work_url: EXECUTOR,
    work_generation: 4,
    applied_work_url_revision: 9
  });

  return { config, registry };
}

test("PE-005 safe idle legacy lane maps to Planner/Executor state without mutation", () => {
  const { config, registry } = fixture();
  const beforeConfig = structuredClone(config);
  const beforeRegistry = structuredClone(registry);

  const migrated = migrateLegacyLaneToPlannerExecutor({
    legacyConfig: config,
    legacyRegistry: registry,
    laneId: "lane-1",
    ownerStop: {
      stop_present: false,
      autostart_disabled_present: false
    }
  });

  assert.equal(migrated.schema_version, "planner-executor-migration-candidate.v1");
  assert.equal(migrated.source_lane_id, "lane-1");
  assert.equal(migrated.cutover_ready, true);
  assert.deepEqual(migrated.blockers, []);

  assert.equal(migrated.state.mode, "PLANNER_EXECUTOR_V1");
  assert.equal(migrated.state.project_id, "lane-1");
  assert.equal(migrated.state.project_name, "UI2");
  assert.equal(migrated.state.planner.target, PLANNER);
  assert.equal(migrated.state.planner.target_revision, 7);
  assert.equal(migrated.state.executor.target, EXECUTOR);
  assert.equal(migrated.state.executor.target_revision, 9);
  assert.equal(migrated.state.active_task_id, null);
  assert.equal(migrated.state.owner_stop.blocked, false);
  assert.equal(migrated.state.legacy_migration.executor_generation, 4);

  assert.deepEqual(config, beforeConfig);
  assert.deepEqual(registry, beforeRegistry);
});

test("PE-005 preserves active task and exact-once identities but blocks unsafe live cutover", () => {
  const { config, registry } = fixture();
  const reg = registry.lanes["lane-1"];
  Object.assign(reg, {
    task_id: "UI2-014",
    awaiting_work: true,
    last_dispatch_id: "A-legacy-014",
    last_result_relay_id: "R-legacy-013",
    instruction_digest: "instruction-digest",
    last_brain_directive_digest: "planner-digest",
    last_work_result_digest: "executor-result-digest",
    last_result_verdict: {
      task_id: "UI2-013",
      relay_id: "R-legacy-013",
      verdict: "ACCEPT"
    },
    relay_inflight: {
      relay_id: "R-inflight-014",
      response_digest: "response-digest",
      text_digest: "text-digest"
    }
  });

  const migrated = migrateLegacyLaneToPlannerExecutor({
    legacyConfig: config,
    legacyRegistry: registry,
    laneId: "lane-1"
  });

  assert.equal(migrated.state.active_task_id, "UI2-014");
  assert.deepEqual(
    migrated.state.identity_history.assignment_ids,
    ["A-legacy-014"]
  );
  assert.deepEqual(
    migrated.state.identity_history.result_ids,
    ["R-legacy-013", "R-inflight-014"]
  );
  assert.equal(migrated.state.legacy_migration.awaiting_executor, true);
  assert.deepEqual(
    migrated.state.legacy_migration.result_relay_inflight,
    reg.relay_inflight
  );
  assert.equal(migrated.cutover_ready, false);
  assert.ok(migrated.blockers.includes("ACTIVE_LEGACY_TASK"));
  assert.ok(migrated.blockers.includes("LEGACY_AWAITING_EXECUTOR"));
  assert.ok(migrated.blockers.includes("LEGACY_RESULT_RELAY_INFLIGHT"));
});

test("PE-005 preserves inflight assignment and Planner request as blockers instead of translating them unsafely", () => {
  const { config, registry } = fixture();
  const reg = registry.lanes["lane-1"];
  reg.dispatch_inflight = {
    task_id: "UI2-015",
    dispatch_id: "A-inflight-015",
    instruction_digest: "digest"
  };
  reg.brain_request_inflight = {
    digest: "request-digest",
    marker: "request-marker"
  };

  const migrated = migrateLegacyLaneToPlannerExecutor({
    legacyConfig: config,
    legacyRegistry: registry,
    laneId: "lane-1"
  });

  assert.ok(
    migrated.state.identity_history.assignment_ids.includes("A-inflight-015")
  );
  assert.deepEqual(
    migrated.state.legacy_migration.assignment_inflight,
    reg.dispatch_inflight
  );
  assert.deepEqual(
    migrated.state.legacy_migration.planner_request_inflight,
    reg.brain_request_inflight
  );
  assert.ok(migrated.blockers.includes("LEGACY_ASSIGNMENT_INFLIGHT"));
  assert.ok(migrated.blockers.includes("LEGACY_PLANNER_REQUEST_INFLIGHT"));
  assert.equal(migrated.cutover_ready, false);
});

test("PE-005 pending target revisions are preserved and block cutover", () => {
  const { config, registry } = fixture();
  const cfg = config.lanes[0];
  const reg = registry.lanes["lane-1"];

  cfg.work_url = EXECUTOR_NEXT;
  cfg.work_url_revision = 10;
  reg.pending_work_url = EXECUTOR_NEXT;
  reg.pending_work_url_revision = 10;

  const migrated = migrateLegacyLaneToPlannerExecutor({
    legacyConfig: config,
    legacyRegistry: registry,
    laneId: "lane-1"
  });

  assert.equal(migrated.state.executor.target, EXECUTOR);
  assert.equal(migrated.state.executor.target_revision, 9);
  assert.equal(
    migrated.state.legacy_migration.executor_requested_target,
    EXECUTOR_NEXT
  );
  assert.equal(
    migrated.state.legacy_migration.pending_executor_target,
    EXECUTOR_NEXT
  );
  assert.ok(migrated.blockers.includes("PENDING_EXECUTOR_TARGET_REVISION"));
  assert.equal(migrated.cutover_ready, false);
});

test("PE-005 Owner STOP and AUTOSTART_DISABLED are preserved as durable blocking truth", () => {
  const { config, registry } = fixture();
  const migrated = migrateLegacyLaneToPlannerExecutor({
    legacyConfig: config,
    legacyRegistry: registry,
    laneId: "lane-1",
    ownerStop: {
      stop_present: true,
      autostart_disabled_present: true
    }
  });

  assert.deepEqual(migrated.state.owner_stop, {
    stop_present: true,
    autostart_disabled_present: true,
    blocked: true
  });
  assert.ok(migrated.blockers.includes("OWNER_STOP"));
  assert.equal(migrated.cutover_ready, false);
});

test("PE-005 explicit lane selection and schema/identity conflicts fail closed", () => {
  const { config, registry } = fixture();

  assert.throws(
    () => migrateLegacyLaneToPlannerExecutor({
      legacyConfig: config,
      legacyRegistry: registry
    }),
    /explicitly set/
  );

  const badSchema = structuredClone(config);
  badSchema.schema_version = "three-lane-config.v2";
  assert.throws(
    () => migrateLegacyLaneToPlannerExecutor({
      legacyConfig: badSchema,
      legacyRegistry: registry,
      laneId: "lane-1"
    }),
    /unsupported legacy lanes.json/
  );

  const conflict = structuredClone(registry);
  conflict.lanes["lane-1"].brain_url =
    "https://chatgpt.com/c/44444444-4444-4444-4444-444444444444";
  assert.throws(
    () => migrateLegacyLaneToPlannerExecutor({
      legacyConfig: config,
      legacyRegistry: conflict,
      laneId: "lane-1"
    }),
    /Planner target identity conflicts/
  );
});

test("PE-005 JSON adapter is deterministic and does not auto-select a lane", () => {
  const { config, registry } = fixture();
  assert.throws(
    () => migrateLegacyPlannerExecutorJson({
      configText: JSON.stringify(config),
      registryText: JSON.stringify(registry)
    }),
    /explicitly set/
  );

  const migrated = migrateLegacyPlannerExecutorJson({
    configText: JSON.stringify(config),
    registryText: JSON.stringify(registry),
    laneId: "lane-1"
  });
  assert.equal(migrated.source_lane_id, "lane-1");
  assert.equal(migrated.cutover_ready, true);

  const parsed = parseLegacyPlannerExecutorSource({
    configText: JSON.stringify(config),
    registryText: JSON.stringify(registry),
    laneId: "lane-1"
  });
  assert.equal(parsed.configLane.project_name, "UI2");
});

test("PE-005 reader is read-only and preserves STOP files and legacy state bytes", async () => {
  const { config, registry } = fixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-pe005-"));
  const configPath = path.join(root, "lanes.json");
  const registryPath = path.join(root, "lane-registry.json");
  const stopPath = path.join(root, "STOP");
  const autostartPath = path.join(root, "AUTOSTART_DISABLED");

  const configText = JSON.stringify(config, null, 2) + "\n";
  const registryText = JSON.stringify(registry, null, 2) + "\n";
  await fs.writeFile(configPath, configText, "utf8");
  await fs.writeFile(registryPath, registryText, "utf8");
  await fs.writeFile(stopPath, "owner-stop\n", "utf8");
  await fs.writeFile(autostartPath, "disabled\n", "utf8");

  const beforeNames = (await fs.readdir(root)).sort();
  const migrated = await readLegacyPlannerExecutorCandidate({
    root,
    laneId: "lane-1"
  });

  assert.equal(migrated.state.owner_stop.blocked, true);
  assert.equal(migrated.cutover_ready, false);
  assert.equal(await fs.readFile(configPath, "utf8"), configText);
  assert.equal(await fs.readFile(registryPath, "utf8"), registryText);
  assert.equal(await fs.readFile(stopPath, "utf8"), "owner-stop\n");
  assert.equal(await fs.readFile(autostartPath, "utf8"), "disabled\n");
  assert.deepEqual((await fs.readdir(root)).sort(), beforeNames);
});

test("PE-005 migration module contains no persistence, browser, process, or Work-mode activation path", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/planner-executor-legacy-migration.mjs", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(source, /writeFile|appendFile|rename\(|unlink\(|atomicJsonWrite/);
  assert.doesNotMatch(source, /playwright|connectOverCDP|child_process|spawn\(|exec\(/);
  assert.doesNotMatch(source, /ChatGPT Work/);
  assert.doesNotMatch(source, /run-supervisor|planner-executor-cli/);
});
