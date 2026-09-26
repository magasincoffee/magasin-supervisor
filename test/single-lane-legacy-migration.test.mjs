import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  migrateLegacyLaneToSingleLane,
  migrateLegacyThreeLaneJson,
  parseLegacyThreeLaneConfig,
  parseLegacyThreeLaneRegistry,
  readLegacyThreeLaneState
} from "../src/runtime/single-lane-legacy-migration.mjs";

function digest(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function configLane(laneId, index) {
  return {
    lane_id: laneId,
    project_name: `Project ${index}`,
    brain_url: "",
    brain_url_revision: 0,
    work_url: "",
    work_url_revision: 0,
    work_url_saved_at: null,
    work_mode: "AUTO",
    work_state_reset_revision: 0,
    relay_retry_rearm_revision: 0,
    relay_retry_rearm_requested_at: null,
    resume_revision: 0,
    resume_requested_at: null,
    enabled: false
  };
}

function targetHealth() {
  return {
    schema_version: "target-health.v1",
    state: "UNKNOWN",
    reason_code: "NONE",
    role: null,
    target_digest: null,
    target_revision: 0,
    work_generation: 0,
    first_detected_at: null,
    last_checked_at: null,
    quarantined_at: null
  };
}

function registryLane(laneId) {
  return {
    lane_id: laneId,
    brain_url: "",
    applied_brain_url_revision: 0,
    work_url: "",
    work_generation: 0,
    applied_work_mode: "AUTO",
    applied_work_saved_at: null,
    pending_work_url: "",
    pending_work_url_revision: 0,
    pending_work_saved_at: null,
    pending_work_mode: null,
    applied_work_state_reset_revision: 0,
    applied_work_url_revision: 0,
    task_id: null,
    instruction_digest: null,
    last_brain_directive_digest: null,
    last_work_result_digest: null,
    last_result_relay_id: null,
    last_result_verdict: null,
    last_dispatch_id: null,
    dispatch_inflight: null,
    relay_inflight: null,
    applied_relay_retry_rearm_revision: 0,
    applied_resume_revision: 0,
    brain_resume_recovery_version: 1,
    brain_request_inflight: null,
    brain_request_sent: false,
    project_plan_bootstrap_retries: 0,
    brain_idle_recheck_retries: 0,
    awaiting_work: false,
    task_timing: {
      schema_version: "task-timing.v1",
      task_id: null,
      directive_digest: null,
      assigned_at: null,
      started_at: null,
      last_activity_at: null,
      completed_at: null,
      relay_confirmed_at: null,
      last_activity_event_at: null,
      last_observation: null
    },
    project_progress: {
      schema_version: "project-progress.v1",
      plan_known: false,
      plan_digest: null,
      tasks: [],
      updated_at: null
    },
    work_watchdog: {
      schema_version: "work-watchdog.v1",
      task_id: null,
      work_generation: 0,
      work_url_revision: 0,
      phase: "IDLE",
      recovery_epoch: 0,
      reload_count: 0,
      continue_count: 0,
      stall_check_at: null,
      reload_intent_at: null,
      reloaded_at: null,
      last_reload_at: null,
      post_reload_probe_at: null,
      continue_intent_at: null,
      continued_at: null,
      last_continue_at: null,
      post_continue_probe_at: null,
      fresh_progress_at: null,
      rearmed_at: null,
      long_event_emitted_at: null,
      possibly_stalled_at: null
    },
    work_rollover: null,
    brain_target_health: targetHealth(),
    work_target_health: targetHealth()
  };
}

function fixture() {
  const lanes = ["lane-1", "lane-2", "lane-3"];
  const config = {
    schema_version: "three-lane-config.v1",
    mode: "THREE_LANE_V1",
    lanes: lanes.map((laneId, index) => configLane(laneId, index + 1))
  };
  const registry = {
    schema_version: "three-lane-registry.v1",
    mode: "THREE_LANE_V1",
    lanes: Object.fromEntries(lanes.map((laneId) => [laneId, registryLane(laneId)]))
  };

  const cfg = config.lanes[1];
  Object.assign(cfg, {
    project_name: "Selected Project",
    brain_url: "https://chatgpt.com/c/brain-2",
    brain_url_revision: 4,
    work_url: "https://chatgpt.com/c/work-owner-2",
    work_url_revision: 9,
    work_url_saved_at: "2026-09-26T10:00:00.000Z",
    work_mode: "OWNER",
    work_state_reset_revision: 3,
    relay_retry_rearm_revision: 5,
    relay_retry_rearm_requested_at: "2026-09-26T10:01:00.000Z",
    resume_revision: 7,
    resume_requested_at: "2026-09-26T10:02:00.000Z",
    enabled: true
  });

  const reg = registry.lanes["lane-2"];
  Object.assign(reg, {
    brain_url: cfg.brain_url,
    applied_brain_url_revision: 4,
    work_url: cfg.work_url,
    work_generation: 6,
    applied_work_mode: "OWNER",
    applied_work_saved_at: cfg.work_url_saved_at,
    applied_work_state_reset_revision: 3,
    applied_work_url_revision: 9,
    task_id: "SL3-P1-A2",
    instruction_digest: "instruction-digest",
    last_brain_directive_digest: "brain-directive-digest",
    last_work_result_digest: "work-result-digest",
    last_result_relay_id: "abcdef0123456789abcdef0123456789",
    last_result_verdict: {
      task_id: "SL3-P1-A1",
      relay_id: "1111111111111111aaaaaaaaaaaaaaaa",
      verdict: "ACCEPT",
      reason_code: "ACCEPT_EVIDENCE_VERIFIED",
      recorded_at: "2026-09-26T09:55:00.000Z"
    },
    last_dispatch_id: "2222222222222222bbbbbbbbbbbbbbbb",
    applied_relay_retry_rearm_revision: 5,
    applied_resume_revision: 7,
    brain_resume_recovery_version: 1,
    brain_request_sent: true,
    project_plan_bootstrap_retries: 1,
    brain_idle_recheck_retries: 2
  });
  reg.task_timing.task_id = "SL3-P1-A2";
  reg.task_timing.directive_digest = "brain-directive-digest";
  reg.project_progress.plan_known = true;
  reg.project_progress.plan_digest = "plan-digest";
  reg.project_progress.tasks = [{ task_id: "SL3-P1-A2", title: "Migration", state: "ACTIVE", completed_at: null }];
  reg.work_watchdog.task_id = "SL3-P1-A2";
  reg.work_watchdog.work_generation = 6;
  reg.work_watchdog.work_url_revision = 9;
  reg.work_watchdog.phase = "WORKING";
  reg.brain_target_health = {
    ...targetHealth(),
    role: "BRAIN",
    target_digest: digest(reg.brain_url),
    target_revision: 4
  };
  reg.work_target_health = {
    ...targetHealth(),
    role: "WORK",
    target_digest: digest(reg.work_url),
    target_revision: 9,
    work_generation: 6
  };
  return { config, registry };
}

test("explicit selected legacy lane maps field-for-field into A1 Single-Lane V3 contracts", () => {
  const { config, registry } = fixture();
  const migrated = migrateLegacyLaneToSingleLane({ legacyConfig: config, legacyRegistry: registry, laneId: "lane-2" });

  assert.equal(migrated.source_lane_id, "lane-2");
  assert.equal(migrated.config.schema_version, "single-lane-config.v1");
  assert.equal(migrated.config.mode, "SINGLE_LANE_V3");
  assert.equal(migrated.config.project_name, "Selected Project");
  assert.equal(migrated.config.brain_url_revision, 4);
  assert.equal(migrated.config.work_url_revision, 9);
  assert.equal(migrated.config.work_state_reset_revision, 3);
  assert.equal(migrated.config.relay_retry_rearm_revision, 5);
  assert.equal(migrated.config.resume_revision, 7);

  assert.equal(migrated.registry.schema_version, "single-lane-registry.v1");
  assert.equal(migrated.registry.mode, "SINGLE_LANE_V3");
  assert.equal(migrated.registry.work_generation, 6);
  assert.equal(migrated.registry.task_id, "SL3-P1-A2");
  assert.equal(migrated.registry.last_result_relay_id, "abcdef0123456789abcdef0123456789");
  assert.deepEqual(migrated.registry.last_result_verdict, registry.lanes["lane-2"].last_result_verdict);
  assert.deepEqual(migrated.registry.project_progress, registry.lanes["lane-2"].project_progress);
  assert.deepEqual(migrated.registry.work_watchdog, registry.lanes["lane-2"].work_watchdog);
  assert.deepEqual(migrated.registry.brain_target_health, registry.lanes["lane-2"].brain_target_health);
  assert.deepEqual(migrated.registry.work_target_health, registry.lanes["lane-2"].work_target_health);
  assert.equal(Object.hasOwn(migrated.config, "lane_id"), false);
  assert.equal(Object.hasOwn(migrated.registry, "lane_id"), false);
  assert.equal(Object.hasOwn(migrated.registry, "lanes"), false);
});

test("dispatch exact-once latch is preserved before task authority flips", () => {
  const { config, registry } = fixture();
  const reg = registry.lanes["lane-2"];
  reg.task_id = "SL3-P1-A1";
  reg.task_timing.task_id = "SL3-P1-A2";
  reg.work_watchdog.task_id = null;
  reg.work_watchdog.phase = "IDLE";
  reg.last_dispatch_id = "3333333333333333cccccccccccccccc";
  reg.dispatch_inflight = {
    task_id: "SL3-P1-A2",
    dispatch_id: "4444444444444444dddddddddddddddd",
    instruction_digest: "5555555555555555eeeeeeeeeeeeeeee",
    directive_digest: "6666666666666666ffffffffffffffff",
    work_generation: 6,
    work_url_revision: 9,
    work_target_digest: digest(reg.work_url),
    send_state: "PERSISTED_NOT_SENT",
    send_attempted_at: null
  };

  const migrated = migrateLegacyLaneToSingleLane({ legacyConfig: config, legacyRegistry: registry, laneId: "lane-2" });
  assert.deepEqual(migrated.registry.dispatch_inflight, reg.dispatch_inflight);
  assert.equal(migrated.registry.task_id, "SL3-P1-A1");
});

test("relay exact-once latch and durable request recovery state are preserved", () => {
  const { config, registry } = fixture();
  const reg = registry.lanes["lane-2"];
  reg.awaiting_work = true;
  reg.relay_inflight = {
    relay_id: "7777777777777777aaaaaaaaaaaaaaaa",
    response_digest: "response-digest",
    text_digest: "text-digest",
    attempt_count: 1,
    retry_not_before: null,
    retry_exhausted: false,
    last_attempt_state: "READY"
  };
  reg.brain_request_sent = false;
  reg.brain_request_inflight = { digest: "request-digest", marker: "brain_request_id=abc" };

  const migrated = migrateLegacyLaneToSingleLane({ legacyConfig: config, legacyRegistry: registry, laneId: "lane-2" });
  assert.deepEqual(migrated.registry.relay_inflight, reg.relay_inflight);
  assert.deepEqual(migrated.registry.brain_request_inflight, reg.brain_request_inflight);
  assert.equal(migrated.registry.awaiting_work, true);
});

test("pending Owner Work target identity is preserved without changing active target", () => {
  const { config, registry } = fixture();
  const cfg = config.lanes[1];
  const reg = registry.lanes["lane-2"];
  cfg.work_url_revision = 10;
  cfg.work_url = "https://chatgpt.com/c/work-owner-next";
  cfg.work_url_saved_at = "2026-09-26T10:05:00.000Z";
  reg.pending_work_url = cfg.work_url;
  reg.pending_work_url_revision = 10;
  reg.pending_work_saved_at = cfg.work_url_saved_at;
  reg.pending_work_mode = "OWNER";

  const migrated = migrateLegacyLaneToSingleLane({ legacyConfig: config, legacyRegistry: registry, laneId: "lane-2" });
  assert.equal(migrated.registry.work_url, "https://chatgpt.com/c/work-owner-2");
  assert.equal(migrated.registry.applied_work_url_revision, 9);
  assert.equal(migrated.registry.pending_work_url, cfg.work_url);
  assert.equal(migrated.registry.pending_work_url_revision, 10);
});



test("rollover and bounded durable recovery counters are preserved", () => {
  const { config, registry } = fixture();
  const reg = registry.lanes["lane-2"];
  reg.work_rollover = {
    schema_version: "work-rollover.v1",
    stage: "TARGET_PERSISTED",
    reason: "FULL_CONFIRMED",
    task_id: "SL3-P1-A2",
    directive_digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    directive_instruction_digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    old_work_generation: 5,
    old_work_url_revision: 8,
    old_work_target_digest: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    new_work_generation: 6,
    new_work_target_digest: digest(reg.work_url),
    dispatch_id: null,
    instruction_digest: null,
    capacity_evidence_codes: ["FULL_COMPOSER_BLOCKED"],
    created_at: "2026-09-26T09:50:00.000Z",
    intent_persisted_at: "2026-09-26T09:51:00.000Z",
    blank_target_creating_at: "2026-09-26T09:52:00.000Z",
    target_persisted_at: "2026-09-26T09:53:00.000Z",
    dispatch_latch_persisted_at: null,
    dispatch_confirmed_at: null
  };

  const migrated = migrateLegacyLaneToSingleLane({ legacyConfig: config, legacyRegistry: registry, laneId: "lane-2" });
  assert.deepEqual(migrated.registry.work_rollover, reg.work_rollover);
  assert.equal(migrated.registry.applied_relay_retry_rearm_revision, 5);
  assert.equal(migrated.registry.applied_resume_revision, 7);
  assert.equal(migrated.registry.brain_resume_recovery_version, 1);
  assert.equal(migrated.registry.project_plan_bootstrap_retries, 1);
  assert.equal(migrated.registry.brain_idle_recheck_retries, 2);
  assert.deepEqual(migrated.registry.task_timing, reg.task_timing);
});

test("JSON parser path is deterministic and does not auto-select a lane", () => {
  const { config, registry } = fixture();
  assert.throws(() => migrateLegacyThreeLaneJson({ configText: JSON.stringify(config), registryText: JSON.stringify(registry) }), /explicitly set/);
  const migrated = migrateLegacyThreeLaneJson({ configText: JSON.stringify(config), registryText: JSON.stringify(registry), laneId: "lane-2" });
  assert.equal(migrated.source_lane_id, "lane-2");
});

test("malformed or unsupported legacy schemas fail closed", () => {
  assert.throws(() => parseLegacyThreeLaneConfig("{"), /malformed JSON/);
  const { config, registry } = fixture();
  assert.throws(() => parseLegacyThreeLaneConfig(JSON.stringify({ ...config, schema_version: "three-lane-config.v2" })), /schema_version/);
  assert.throws(() => parseLegacyThreeLaneRegistry(JSON.stringify({ ...registry, mode: "SINGLE_LANE_V3" })), /mode/);
});

test("absent/ambiguous lane identity and missing authority fail closed", () => {
  const { config, registry } = fixture();
  config.lanes[2].lane_id = "lane-2";
  assert.throws(() => migrateLegacyLaneToSingleLane({ legacyConfig: config, legacyRegistry: registry, laneId: "lane-2" }), /absent or ambiguous/);

  const f = fixture();
  delete f.registry.lanes["lane-2"].work_generation;
  assert.throws(() => migrateLegacyLaneToSingleLane({ legacyConfig: f.config, legacyRegistry: f.registry, laneId: "lane-2" }), /missing required field: work_generation/);
});

test("identity conflicts and impossible revision relationships fail closed", () => {
  const a = fixture();
  a.registry.lanes["lane-2"].brain_url = "https://chatgpt.com/c/conflict";
  a.registry.lanes["lane-2"].brain_target_health.target_digest = digest(a.registry.lanes["lane-2"].brain_url);
  assert.throws(() => migrateLegacyLaneToSingleLane({ legacyConfig: a.config, legacyRegistry: a.registry, laneId: "lane-2" }), /Brain identity conflicts/);

  const b = fixture();
  b.registry.lanes["lane-2"].applied_resume_revision = 8;
  assert.throws(() => migrateLegacyLaneToSingleLane({ legacyConfig: b.config, legacyRegistry: b.registry, laneId: "lane-2" }), /applied resume revision exceeds/);
});

test("invalid exact-once latch relationships fail closed", () => {
  const a = fixture();
  const reg = a.registry.lanes["lane-2"];
  reg.dispatch_inflight = {
    task_id: "SL3-P1-A2",
    dispatch_id: "8888888888888888bbbbbbbbbbbbbbbb",
    instruction_digest: "9999999999999999cccccccccccccccc",
    work_generation: 99,
    work_url_revision: 9,
    work_target_digest: digest(reg.work_url)
  };
  assert.throws(() => migrateLegacyLaneToSingleLane({ legacyConfig: a.config, legacyRegistry: a.registry, laneId: "lane-2" }), /generation conflicts/);

  const b = fixture();
  b.registry.lanes["lane-2"].brain_request_sent = true;
  b.registry.lanes["lane-2"].brain_request_inflight = { digest: "x", marker: "y" };
  assert.throws(() => migrateLegacyLaneToSingleLane({ legacyConfig: b.config, legacyRegistry: b.registry, laneId: "lane-2" }), /both sent and inflight/);
});

test("multi-lane-only and process-liveness fields are never promoted", () => {
  const { config, registry } = fixture();
  registry.scheduler = { cursor: 2 };
  assert.throws(() => migrateLegacyLaneToSingleLane({ legacyConfig: config, legacyRegistry: registry, laneId: "lane-2" }), /unsupported legacy lane-registry.json field: scheduler/);

  const f = fixture();
  f.registry.lanes["lane-2"].process_alive = true;
  assert.throws(() => migrateLegacyLaneToSingleLane({ legacyConfig: f.config, legacyRegistry: f.registry, laneId: "lane-2" }), /unsupported legacy registry lane-2 field: process_alive/);

  const nested = fixture();
  nested.registry.lanes["lane-2"].task_timing.last_observation = { runtime_alive: true };
  assert.throws(() => migrateLegacyLaneToSingleLane({ legacyConfig: nested.config, legacyRegistry: nested.registry, laneId: "lane-2" }), /forbidden process-liveness authority runtime_alive/);
});

test("read-only reader reads exact legacy filenames and does not mutate persisted state", async () => {
  const { config, registry } = fixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sl3-a2-"));
  const configPath = path.join(root, "lanes.json");
  const registryPath = path.join(root, "lane-registry.json");
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  const registryText = `${JSON.stringify(registry, null, 2)}\n`;
  await fs.writeFile(configPath, configText, "utf8");
  await fs.writeFile(registryPath, registryText, "utf8");

  const migrated = await readLegacyThreeLaneState({ root, laneId: "lane-2" });
  assert.equal(migrated.source_lane_id, "lane-2");
  assert.equal(await fs.readFile(configPath, "utf8"), configText);
  assert.equal(await fs.readFile(registryPath, "utf8"), registryText);
  assert.deepEqual((await fs.readdir(root)).sort(), ["lane-registry.json", "lanes.json"]);
});

test("pure adapter does not mutate source objects and returns detached V3 state", () => {
  const { config, registry } = fixture();
  const configBefore = structuredClone(config);
  const registryBefore = structuredClone(registry);
  const migrated = migrateLegacyLaneToSingleLane({ legacyConfig: config, legacyRegistry: registry, laneId: "lane-2" });

  assert.deepEqual(config, configBefore);
  assert.deepEqual(registry, registryBefore);

  registry.lanes["lane-2"].project_progress.tasks[0].state = "DONE";
  registry.lanes["lane-2"].work_target_health.state = "QUARANTINED";
  assert.equal(migrated.registry.project_progress.tasks[0].state, "ACTIVE");
  assert.equal(migrated.registry.work_target_health.state, "UNKNOWN");
});

test("reader module contains no persistence or runtime activation path", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-lane-legacy-migration.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /writeFile|appendFile|rename\(|unlink\(|atomicJsonWrite|createWriteStream/);
  assert.doesNotMatch(source, /playwright|connectOverCDP|child_process|spawn\(|exec\(|run-supervisor|three-lane-cli/);
});
