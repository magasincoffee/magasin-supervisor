import test from "node:test";
import assert from "node:assert/strict";

import { projectLaneOperationalStatus } from "../src/runtime/status-projection.mjs";

const NOW = "2026-09-21T02:00:00.000Z";

function config(overrides = {}) {
  return {
    lane_id: "lane-1",
    work_url_revision: 7,
    work_url_saved_at: "2026-09-21T01:40:00.000Z",
    work_mode: "OWNER",
    relay_retry_rearm_revision: 3,
    ...overrides
  };
}

function registry(overrides = {}) {
  return {
    work_generation: 5,
    applied_work_url_revision: 6,
    pending_work_url_revision: 7,
    applied_work_mode: "OWNER",
    applied_relay_retry_rearm_revision: 2,
    task_timing: {
      schema_version: "task-timing.v1",
      task_id: "TASK-UX",
      directive_digest: "a".repeat(64),
      assigned_at: "2026-09-21T01:00:00.000Z",
      started_at: "2026-09-21T01:02:00.000Z",
      last_activity_at: "2026-09-21T01:55:00.000Z",
      completed_at: null,
      relay_confirmed_at: null,
      last_activity_event_at: null,
      last_observation: null
    },
    work_watchdog: {
      schema_version: "work-watchdog.v1",
      phase: "WORKING_LONG"
    },
    work_rollover: null,
    brain_target_health: {
      schema_version: "target-health.v1",
      state: "HEALTHY",
      reason_code: "NONE",
      role: "BRAIN",
      target_digest: "b".repeat(64)
    },
    work_target_health: {
      schema_version: "target-health.v1",
      state: "HEALTHY",
      reason_code: "NONE",
      role: "WORK",
      target_digest: "c".repeat(64)
    },
    relay_inflight: null,
    ...overrides
  };
}

test("active elapsed comes only from canonical task timing", () => {
  const out = projectLaneOperationalStatus(
    config(),
    registry(),
    "WORKING_LONG",
    {},
    { now: NOW }
  );
  assert.equal(out.task_elapsed_ms, 3_600_000);
  assert.equal(out.task_queue_time_ms, 120_000);
  assert.equal(out.task_execution_time_ms, null);
  assert.equal(out.last_activity_at, "2026-09-21T01:55:00.000Z");
  assert.equal(out.phase, "WORKING_LONG");
});

test("completed elapsed freezes at canonical completed_at", () => {
  const state = registry();
  state.task_timing.completed_at = "2026-09-21T01:30:00.000Z";
  state.task_timing.last_activity_at = "2026-09-21T01:30:00.000Z";
  const first = projectLaneOperationalStatus(
    config(), state, "READY", {}, { now: NOW }
  );
  const later = projectLaneOperationalStatus(
    config(), state, "READY", {}, { now: "2026-09-22T02:00:00.000Z" }
  );
  assert.equal(first.task_elapsed_ms, 1_800_000);
  assert.equal(later.task_elapsed_ms, first.task_elapsed_ms);
  assert.equal(first.task_execution_time_ms, 1_680_000);
});

test("missing timing stays null and does not invent timestamps", () => {
  const state = registry({ task_timing: null });
  const out = projectLaneOperationalStatus(
    config(), state, "READY", {}, { now: NOW }
  );
  assert.equal(out.task_elapsed_ms, null);
  assert.equal(out.assigned_at, null);
  assert.equal(out.last_activity_at, null);
});

test("quarantined target outranks stale WORKING phase projection", () => {
  const state = registry({
    work_watchdog: null,
    work_target_health: {
      schema_version: "target-health.v1",
      state: "QUARANTINED",
      reason_code: "CONVERSATION_MISSING",
      role: "WORK",
      target_digest: "d".repeat(64),
      quarantined_at: "2026-09-21T01:50:00.000Z"
    }
  });
  const out = projectLaneOperationalStatus(
    config(), state, "WORKING", {}, { now: NOW }
  );
  assert.equal(out.phase, "WORK_TARGET_QUARANTINED");
  assert.deepEqual(out.work_target_health, {
    state: "QUARANTINED",
    reason_code: "CONVERSATION_MISSING"
  });
  assert.equal("target_digest" in out.work_target_health, false);
});

test("relay exhaustion and pending Owner rearm are structured", () => {
  const out = projectLaneOperationalStatus(
    config({ relay_retry_rearm_revision: 9 }),
    registry({
      relay_inflight: { retry_exhausted: true },
      applied_relay_retry_rearm_revision: 8,
      work_watchdog: null
    }),
    "WAIT_OWNER",
    {},
    { now: NOW }
  );
  assert.equal(out.phase, "RELAY_EXHAUSTED");
  assert.equal(out.relay_retry_exhausted, true);
  assert.equal(out.relay_rearm_pending, true);
});

test("rollover stage projects deterministic phase without changing state", () => {
  const rollover = {
    schema_version: "work-rollover.v1",
    stage: "TARGET_PERSISTED",
    reason: "FULL_CONFIRMED",
    task_id: "TASK-UX",
    directive_digest: "e".repeat(64),
    directive_instruction_digest: null,
    old_work_generation: 5,
    old_work_url_revision: 6,
    old_work_target_digest: "f".repeat(64),
    new_work_generation: 6,
    new_work_target_digest: "1".repeat(64),
    dispatch_id: null,
    instruction_digest: null,
    capacity_evidence_codes: [],
    created_at: "2026-09-21T01:00:00.000Z",
    intent_persisted_at: "2026-09-21T01:01:00.000Z",
    blank_target_creating_at: "2026-09-21T01:02:00.000Z",
    target_persisted_at: "2026-09-21T01:03:00.000Z",
    dispatch_latch_persisted_at: null,
    dispatch_confirmed_at: null
  };
  const state = registry({ work_rollover: rollover, work_watchdog: null });
  const before = JSON.stringify(state.work_rollover);
  const out = projectLaneOperationalStatus(
    config(), state, "STARTING", {}, { now: NOW }
  );
  assert.equal(out.phase, "WORK_ROLLOVER_TARGET_PERSISTED");
  assert.equal(out.rollover_phase, "TARGET_PERSISTED");
  assert.equal(JSON.stringify(state.work_rollover), before);
});

test("Work revisions and mode are visibly distinct in additive projection", () => {
  const out = projectLaneOperationalStatus(
    config(), registry(), "WORKING", {}, { now: NOW }
  );
  assert.equal(out.configured_work_url_revision, 7);
  assert.equal(out.applied_work_url_revision, 6);
  assert.equal(out.pending_work_url_revision, 7);
  assert.equal(out.work_mode, "OWNER");
  assert.equal(out.work_url_saved_at, "2026-09-21T01:40:00.000Z");
});

test("projection contains no URL, message body, cookie, token or screenshot fields", () => {
  const out = projectLaneOperationalStatus(
    config(), registry(), "WORKING", {}, { now: NOW }
  );
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /https?:\/\//i);
  for (const forbidden of [
    "brain_url","work_url","message_body","cookie","token",
    "screenshot_path","target_digest","dispatch_id","relay_id"
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(out, forbidden), false);
  }
});
