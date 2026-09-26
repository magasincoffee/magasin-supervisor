import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  SINGLE_LANE_MODE,
  SINGLE_LANE_CONFIG_SCHEMA,
  SINGLE_LANE_REGISTRY_SCHEMA,
  SINGLE_LANE_CONFIG_FILENAME,
  SINGLE_LANE_REGISTRY_FILENAME,
  LEGACY_THREE_LANE_CONFIG_FILENAME,
  LEGACY_THREE_LANE_REGISTRY_FILENAME,
  SINGLE_LANE_WORK_MODES,
  defaultSingleLaneConfig,
  normalizeSingleLaneConfig,
  defaultSingleLaneRegistry,
  normalizeSingleLaneRegistry
} from "../src/runtime/single-lane-state.mjs";

const MODULE_URL = new URL("../src/runtime/single-lane-state.mjs", import.meta.url);

function validConfig() {
  return {
    ...defaultSingleLaneConfig(),
    project_name: "MAGASIN",
    brain_url: "https://chatgpt.com/c/brain",
    brain_url_revision: 4,
    work_url: "https://chatgpt.com/c/work",
    work_url_revision: 7,
    work_url_saved_at: "2026-09-26T10:00:00.000Z",
    work_mode: "OWNER",
    work_state_reset_revision: 2,
    relay_retry_rearm_revision: 3,
    relay_retry_rearm_requested_at: "2026-09-26T10:01:00.000Z",
    resume_revision: 5,
    resume_requested_at: "2026-09-26T10:02:00.000Z",
    enabled: true
  };
}

function validRegistry() {
  const registry = defaultSingleLaneRegistry();
  registry.brain_url = "https://chatgpt.com/c/brain";
  registry.applied_brain_url_revision = 4;
  registry.work_url = "https://chatgpt.com/c/work";
  registry.work_generation = 8;
  registry.applied_work_mode = "OWNER";
  registry.applied_work_saved_at = "2026-09-26T10:00:00.000Z";
  registry.pending_work_url = "https://chatgpt.com/c/work-next";
  registry.pending_work_url_revision = 9;
  registry.pending_work_saved_at = "2026-09-26T10:03:00.000Z";
  registry.pending_work_mode = "AUTO";
  registry.applied_work_state_reset_revision = 2;
  registry.applied_work_url_revision = 7;
  registry.task_id = "SL3-P1-A1";
  registry.instruction_digest = "instruction-digest";
  registry.last_brain_directive_digest = "brain-directive-digest";
  registry.last_work_result_digest = "work-result-digest";
  registry.last_result_relay_id = "relay-identity";
  registry.last_result_verdict = {
    task_id: "SL3-P0-A4",
    relay_id: "relay-identity",
    verdict: "ACCEPT"
  };
  registry.last_dispatch_id = "dispatch-identity";
  registry.dispatch_inflight = {
    dispatch_id: "dispatch-identity",
    task_id: "SL3-P1-A1",
    state: "PERSISTED_NOT_SENT",
    instruction_digest: "instruction-digest"
  };
  registry.relay_inflight = {
    relay_id: "relay-identity",
    task_id: "SL3-P1-A1",
    response_digest: "response-digest",
    text_digest: "text-digest",
    state: "PERSISTED_NOT_SENT"
  };
  registry.applied_relay_retry_rearm_revision = 3;
  registry.applied_resume_revision = 5;
  registry.brain_resume_recovery_version = 1;
  registry.brain_request_inflight = {
    request_digest: "request-digest",
    state: "PERSISTED_NOT_SENT"
  };
  registry.brain_request_sent = true;
  registry.project_plan_bootstrap_retries = 1;
  registry.brain_idle_recheck_retries = 2;
  registry.awaiting_work = true;
  registry.task_timing.task_id = "SL3-P1-A1";
  registry.project_progress.plan_known = true;
  registry.project_progress.tasks.push({
    task_id: "SL3-P1-A1",
    title: "Define single-lane config and durable registry schema",
    state: "ACTIVE",
    completed_at: null
  });
  registry.work_watchdog.task_id = "SL3-P1-A1";
  registry.work_watchdog.work_generation = 8;
  registry.brain_target_health.role = "BRAIN";
  registry.brain_target_health.target_digest = "a".repeat(64);
  registry.brain_target_health.target_revision = 4;
  registry.work_target_health.role = "WORK";
  registry.work_target_health.target_digest = "b".repeat(64);
  registry.work_target_health.target_revision = 7;
  registry.work_target_health.work_generation = 8;
  return registry;
}

test("constants lock Single-Lane V3 schemas and isolated filenames", () => {
  assert.equal(SINGLE_LANE_MODE, "SINGLE_LANE_V3");
  assert.equal(SINGLE_LANE_CONFIG_SCHEMA, "single-lane-config.v1");
  assert.equal(SINGLE_LANE_REGISTRY_SCHEMA, "single-lane-registry.v1");
  assert.equal(SINGLE_LANE_CONFIG_FILENAME, "single-lane-config.json");
  assert.equal(SINGLE_LANE_REGISTRY_FILENAME, "single-lane-registry.json");
  assert.equal(LEGACY_THREE_LANE_CONFIG_FILENAME, "lanes.json");
  assert.equal(LEGACY_THREE_LANE_REGISTRY_FILENAME, "lane-registry.json");
  assert.notEqual(SINGLE_LANE_CONFIG_FILENAME, LEGACY_THREE_LANE_CONFIG_FILENAME);
  assert.notEqual(SINGLE_LANE_REGISTRY_FILENAME, LEGACY_THREE_LANE_REGISTRY_FILENAME);
  assert.deepEqual(SINGLE_LANE_WORK_MODES, { AUTO: "AUTO", OWNER: "OWNER" });
});

test("default config is exact, disabled Owner intent with no legacy topology", () => {
  assert.deepEqual(defaultSingleLaneConfig(), {
    schema_version: "single-lane-config.v1",
    mode: "SINGLE_LANE_V3",
    project_name: "",
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
  });
});

test("default registry is exact clean durable recovery state", () => {
  assert.deepEqual(defaultSingleLaneRegistry(), {
    schema_version: "single-lane-registry.v1",
    mode: "SINGLE_LANE_V3",
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
    brain_target_health: {
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
    },
    work_target_health: {
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
    }
  });
});

test("config and registry contain no lanes or lane_id topology", () => {
  for (const value of [defaultSingleLaneConfig(), defaultSingleLaneRegistry()]) {
    const text = JSON.stringify(value);
    assert.equal(Object.hasOwn(value, "lanes"), false);
    assert.equal(Object.hasOwn(value, "lane_id"), false);
    assert.doesNotMatch(text, /"lanes"\s*:|"lane_id"\s*:/);
  }
});

test("valid config roundtrips through strict normalization", () => {
  const input = validConfig();
  assert.deepEqual(normalizeSingleLaneConfig(input), input);
});

test("valid registry roundtrips and preserves durable state", () => {
  const input = validRegistry();
  assert.deepEqual(normalizeSingleLaneRegistry(input), input);
});

test("explicit wrong config or registry schema fails closed", () => {
  assert.throws(
    () => normalizeSingleLaneConfig({
      ...defaultSingleLaneConfig(),
      schema_version: "three-lane-config.v1"
    }),
    /schema_version/
  );
  assert.throws(
    () => normalizeSingleLaneRegistry({
      ...defaultSingleLaneRegistry(),
      schema_version: "three-lane-registry.v1"
    }),
    /schema_version/
  );
});

test("wrong Single-Lane mode fails closed", () => {
  assert.throws(
    () => normalizeSingleLaneConfig({
      ...defaultSingleLaneConfig(),
      mode: "THREE_LANE_V1"
    }),
    /mode/
  );
  assert.throws(
    () => normalizeSingleLaneRegistry({
      ...defaultSingleLaneRegistry(),
      mode: "THREE_LANE_V1"
    }),
    /mode/
  );
});

test("legacy three-lane config and registry inputs cannot auto-normalize to V3", () => {
  assert.throws(
    () => normalizeSingleLaneConfig({
      ...defaultSingleLaneConfig(),
      schema_version: "three-lane-config.v1",
      lanes: []
    }),
    /legacy topology|unsupported|schema_version/
  );
  assert.throws(
    () => normalizeSingleLaneRegistry({
      ...defaultSingleLaneRegistry(),
      schema_version: "three-lane-registry.v1",
      lanes: {}
    }),
    /legacy topology|unsupported|schema_version/
  );
  assert.throws(
    () => normalizeSingleLaneRegistry({
      ...defaultSingleLaneRegistry(),
      lane_id: "lane-1"
    }),
    /legacy topology/
  );
});

test("negative NaN and fractional revisions fail closed", () => {
  for (const bad of [-1, Number.NaN, 1.5]) {
    assert.throws(
      () => normalizeSingleLaneConfig({
        ...defaultSingleLaneConfig(),
        brain_url_revision: bad
      }),
      /non-negative integer/
    );
    assert.throws(
      () => normalizeSingleLaneRegistry({
        ...defaultSingleLaneRegistry(),
        work_generation: bad
      }),
      /non-negative integer/
    );
  }
});

test("invalid Work modes fail closed", () => {
  assert.throws(
    () => normalizeSingleLaneConfig({
      ...defaultSingleLaneConfig(),
      work_mode: "ROUND_ROBIN"
    }),
    /work_mode/
  );
  assert.throws(
    () => normalizeSingleLaneRegistry({
      ...defaultSingleLaneRegistry(),
      pending_work_mode: "LANE_2"
    }),
    /pending_work_mode/
  );
});

test("wrong primitive and nested-state types fail closed", () => {
  assert.throws(
    () => normalizeSingleLaneConfig({
      ...defaultSingleLaneConfig(),
      project_name: 42
    }),
    /project_name/
  );
  assert.throws(
    () => normalizeSingleLaneConfig({
      ...defaultSingleLaneConfig(),
      enabled: "false"
    }),
    /enabled/
  );
  assert.throws(
    () => normalizeSingleLaneRegistry({
      ...defaultSingleLaneRegistry(),
      awaiting_work: 0
    }),
    /awaiting_work/
  );
  assert.throws(
    () => normalizeSingleLaneRegistry({
      ...defaultSingleLaneRegistry(),
      task_timing: []
    }),
    /task_timing/
  );
  assert.throws(
    () => normalizeSingleLaneRegistry({
      ...defaultSingleLaneRegistry(),
      dispatch_inflight: "dispatch-id"
    }),
    /dispatch_inflight/
  );
});

test("valid dispatch_inflight identity survives normalization unchanged", () => {
  const input = validRegistry();
  const expected = structuredClone(input.dispatch_inflight);
  const out = normalizeSingleLaneRegistry(input);
  assert.deepEqual(out.dispatch_inflight, expected);
  assert.equal(out.last_dispatch_id, "dispatch-identity");
  assert.notStrictEqual(out.dispatch_inflight, input.dispatch_inflight);
});

test("valid relay_inflight and last relay identity survive normalization unchanged", () => {
  const input = validRegistry();
  const expected = structuredClone(input.relay_inflight);
  const out = normalizeSingleLaneRegistry(input);
  assert.deepEqual(out.relay_inflight, expected);
  assert.equal(out.last_result_relay_id, "relay-identity");
  assert.notStrictEqual(out.relay_inflight, input.relay_inflight);
});

test("target revisions and work generation survive normalization", () => {
  const input = validRegistry();
  const out = normalizeSingleLaneRegistry(input);
  assert.equal(out.applied_brain_url_revision, 4);
  assert.equal(out.work_generation, 8);
  assert.equal(out.pending_work_url_revision, 9);
  assert.equal(out.applied_work_state_reset_revision, 2);
  assert.equal(out.applied_work_url_revision, 7);
  assert.equal(out.brain_target_health.target_revision, 4);
  assert.equal(out.work_target_health.target_revision, 7);
  assert.equal(out.work_target_health.work_generation, 8);
});

test("task identity and exact-once latches are never silently cleared", () => {
  const input = validRegistry();
  const out = normalizeSingleLaneRegistry(input);
  assert.equal(out.task_id, "SL3-P1-A1");
  assert.equal(out.instruction_digest, "instruction-digest");
  assert.equal(out.last_result_relay_id, "relay-identity");
  assert.equal(out.last_dispatch_id, "dispatch-identity");
  assert.ok(out.dispatch_inflight);
  assert.ok(out.relay_inflight);
});

test("defaults do not share mutable nested references", () => {
  const a = defaultSingleLaneRegistry();
  const b = defaultSingleLaneRegistry();

  a.project_progress.tasks.push({ task_id: "MUTATED" });
  a.task_timing.last_observation = { response_running: true };
  a.work_watchdog.phase = "WORKING";
  a.brain_target_health.state = "HEALTHY";

  assert.deepEqual(b.project_progress.tasks, []);
  assert.equal(b.task_timing.last_observation, null);
  assert.equal(b.work_watchdog.phase, "IDLE");
  assert.equal(b.brain_target_health.state, "UNKNOWN");
});

test("normalization deep-clones mutable nested state", () => {
  const input = validRegistry();
  const out = normalizeSingleLaneRegistry(input);

  input.project_progress.tasks[0].state = "DONE";
  input.dispatch_inflight.state = "MUTATED";
  input.work_target_health.state = "QUARANTINED";

  assert.equal(out.project_progress.tasks[0].state, "ACTIVE");
  assert.equal(out.dispatch_inflight.state, "PERSISTED_NOT_SENT");
  assert.equal(out.work_target_health.state, "UNKNOWN");
});

test("generic nested state must remain on its explicit schema", () => {
  assert.throws(
    () => normalizeSingleLaneRegistry({
      ...defaultSingleLaneRegistry(),
      project_progress: { schema_version: "project-progress.v2" }
    }),
    /project_progress\.schema_version/
  );
  assert.throws(
    () => normalizeSingleLaneRegistry({
      ...defaultSingleLaneRegistry(),
      work_rollover: { schema_version: "work-rollover.v2" }
    }),
    /work_rollover\.schema_version/
  );
});

test("persisted registry does not claim live process/browser authority", () => {
  const registry = defaultSingleLaneRegistry();
  for (const forbidden of [
    "process_alive",
    "runtime_alive",
    "chrome_alive",
    "cdp_alive",
    "wrapper_alive"
  ]) {
    assert.equal(Object.hasOwn(registry, forbidden), false);
    assert.throws(
      () => normalizeSingleLaneRegistry({ ...registry, [forbidden]: true }),
      /unsupported single-lane registry field/
    );
  }
});

test("module is pure schema code with no file I/O or runtime/browser activation", async () => {
  const source = await fs.readFile(fileURLToPath(MODULE_URL), "utf8");
  assert.doesNotMatch(source, /node:fs|node:path|readFile|writeFile|appendFile|mkdir|unlink|rename/i);
  assert.doesNotMatch(source, /playwright|connectOverCDP|chrom(?:e|ium)|run-supervisor/i);
  assert.doesNotMatch(source, /child_process|spawn\(|exec\(|process\.env/i);
});

test("module has no dependency on Three-Lane or scheduler orchestration", async () => {
  const source = await fs.readFile(fileURLToPath(MODULE_URL), "utf8");
  assert.doesNotMatch(source, /three-lane(?:-cli)?\.mjs/i);
  assert.doesNotMatch(source, /browser-scheduler|round[-_ ]robin|lane-1|lane-2|lane-3/i);
  assert.doesNotMatch(source, /^\s*import\s/m);
});
