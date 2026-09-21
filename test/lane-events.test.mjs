import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LANE_EVENT_SCHEMA_VERSION,
  LANE_EVENT_TYPES,
  appendLaneEvent,
  beginTaskAssignment,
  buildSafeWorkObservation,
  createLaneEventSink,
  defaultTaskTiming,
  markRelayConfirmed,
  markTaskCompleted,
  markTaskStarted,
  normalizeTaskTiming,
  observeWorkActivity,
  serializeLaneEvent,
  taskTimingMetrics
} from "../src/runtime/lane-events.mjs";
import {
  defaultLaneRegistry,
  normalizeLaneRegistry
} from "../src/runtime/three-lane.mjs";

const T0 = "2026-09-20T00:00:00.000Z";
const T1 = "2026-09-20T00:00:05.000Z";
const T2 = "2026-09-20T00:00:35.000Z";
const T3 = "2026-09-20T00:00:40.000Z";
const DISPATCH_ID = "a".repeat(32);
const RELAY_ID = "b".repeat(32);
const TASK_ID = "TASK-RBT-002/EVENT-TIMING-FOUNDATION-01";
const DIRECTIVE_DIGEST = "c".repeat(64);

function baseEvent(overrides = {}) {
  return {
    timestamp: T0,
    lane_id: "lane-1",
    actor: "BRAIN",
    event_type: LANE_EVENT_TYPES.BRAIN_TASK_ASSIGNED,
    task_id: TASK_ID,
    phase: "ASSIGNED",
    work_generation: 7,
    ...overrides
  };
}

test("append-only lane events are valid NDJSON and preserve append order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lane-events-"));
  const file = path.join(root, "lane-events.ndjson");
  try {
    await appendLaneEvent(file, baseEvent());
    await appendLaneEvent(file, baseEvent({
      timestamp: T1,
      actor: "SUPERVISOR",
      event_type: LANE_EVENT_TYPES.WORK_DISPATCH_CONFIRMED,
      phase: "STARTED",
      dispatch_id: DISPATCH_ID,
      queue_time_ms: 5000
    }));
    const lines = (await fs.readFile(file, "utf8")).trim().split(/\r?\n/);
    assert.equal(lines.length, 2);
    const events = lines.map(JSON.parse);
    assert.deepEqual(
      events.map((event) => event.event_type),
      ["BRAIN_TASK_ASSIGNED", "WORK_DISPATCH_CONFIRMED"]
    );
    assert.ok(events.every((event) => event.schema_version === LANE_EVENT_SCHEMA_VERSION));
    assert.ok(events.every((event) => event.timestamp.endsWith("Z")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Work target events expose revision metadata only and reject private targets", () => {
  for (const [eventType, phase, reasonCode] of [
    [LANE_EVENT_TYPES.WORK_TARGET_SAVED, "SAVED", "OWNER_WORK_REVISION"],
    [LANE_EVENT_TYPES.WORK_TARGET_PENDING, "PENDING", "ACTIVE_WORK_PRESERVED"],
    [LANE_EVENT_TYPES.WORK_TARGET_APPLIED, "APPLIED", "SAFE_BOUNDARY"]
  ]) {
    const event = serializeLaneEvent(baseEvent({
      actor: "SUPERVISOR",
      event_type: eventType,
      phase,
      reason_code: reasonCode,
      work_url_revision: 9
    }));
    assert.equal(event.work_url_revision, 9);
    const line = JSON.stringify(event);
    assert.equal(line.includes("chatgpt.com"), false);
    assert.equal(line.includes("work_url"), true);
    assert.equal(line.includes("work_url_revision"), true);
  }

  assert.throws(
    () => serializeLaneEvent({
      ...baseEvent(),
      actor: "SUPERVISOR",
      event_type: LANE_EVENT_TYPES.WORK_TARGET_SAVED,
      phase: "SAVED",
      reason_code: "OWNER_WORK_REVISION",
      work_url_revision: 9,
      work_url: "https://chatgpt.com/c/private"
    }),
    /not allowlisted/
  );
});

test("strict event allowlist rejects forbidden fields instead of serializing them", () => {
  const forbidden = [
    "url",
    "brain_url",
    "work_url",
    "text",
    "instruction",
    "response",
    "token",
    "cookie",
    "screenshot_path",
    "attachment_path",
    "path",
    "dom_text"
  ];
  for (const key of forbidden) {
    assert.throws(
      () => serializeLaneEvent({ ...baseEvent(), [key]: "PRIVATE_SECRET" }),
      /not allowlisted/
    );
  }
});

test("serialized event lines cannot carry private URL/token/body/path raw values", () => {
  const event = serializeLaneEvent(baseEvent({
    actor: "WORK",
    event_type: LANE_EVENT_TYPES.WORK_STARTED,
    phase: "STARTED",
    dispatch_id: DISPATCH_ID,
    queue_time_ms: 5000
  }));
  const line = JSON.stringify(event);
  for (const privateValue of [
    "https://chatgpt.com/c/private",
    "secret-token-123",
    "private message body",
    "C:\\private\\capture.png",
    "/private/attachment.pdf"
  ]) {
    assert.equal(line.includes(privateValue), false);
  }
  assert.throws(
    () => serializeLaneEvent(baseEvent({ task_id: "https://chatgpt.com/c/private" })),
    /safe operational identifier/
  );
  assert.throws(
    () => serializeLaneEvent(baseEvent({ task_id: "C:/private/capture.png" })),
    /safe operational identifier/
  );
});

test("fresh task timing computes queue, execution and total duration", () => {
  const timing = defaultTaskTiming();
  assert.equal(beginTaskAssignment(timing, {
    taskId: TASK_ID,
    directiveDigest: DIRECTIVE_DIGEST,
    at: T0
  }).changed, true);
  assert.equal(markTaskStarted(timing, {
    taskId: TASK_ID,
    directiveDigest: DIRECTIVE_DIGEST,
    at: T1
  }).changed, true);
  assert.equal(markTaskCompleted(timing, {
    taskId: TASK_ID,
    at: T2
  }).changed, true);
  assert.equal(markRelayConfirmed(timing, {
    taskId: TASK_ID,
    at: T3
  }).changed, true);

  assert.equal(timing.assigned_at, T0);
  assert.equal(timing.started_at, T1);
  assert.equal(timing.last_activity_at, T2);
  assert.equal(timing.completed_at, T2);
  assert.equal(timing.relay_confirmed_at, T3);
  assert.deepEqual(taskTimingMetrics(timing, { now: T3 }), {
    queue_time_ms: 5000,
    execution_time_ms: 30000,
    total_elapsed_ms: 35000
  });
});

test("legacy registry normalization does not fabricate historical timing", () => {
  const legacy = defaultLaneRegistry();
  delete legacy.lanes["lane-1"].task_timing;
  legacy.lanes["lane-1"].task_id = "TASK-LEGACY";
  legacy.lanes["lane-1"].awaiting_work = true;

  const normalized = normalizeLaneRegistry(legacy);
  const timing = normalized.lanes["lane-1"].task_timing;
  assert.equal(timing.task_id, null);
  assert.equal(timing.assigned_at, null);
  assert.equal(timing.started_at, null);
  assert.equal(timing.last_activity_at, null);
  assert.equal(timing.completed_at, null);
  assert.equal(timing.relay_confirmed_at, null);
});

test("repeated identical Work observation does not move activity timestamp or emit", () => {
  const timing = defaultTaskTiming();
  beginTaskAssignment(timing, {
    taskId: TASK_ID,
    directiveDigest: DIRECTIVE_DIGEST,
    at: T0
  });
  markTaskStarted(timing, {
    taskId: TASK_ID,
    directiveDigest: DIRECTIVE_DIGEST,
    at: T1
  });
  const observation = buildSafeWorkObservation({
    userMessageCount: 4,
    assistantMessageCount: 3,
    maxConversationTurnOrdinal: 7,
    responseRunning: true,
    lastAssistantCharCount: 500
  }, false);

  const baseline = observeWorkActivity(timing, observation, {
    at: "2026-09-20T00:00:06.000Z"
  });
  assert.equal(baseline.baseline_initialized, true);
  assert.equal(timing.last_activity_at, T1);

  const repeated = observeWorkActivity(timing, observation, {
    at: "2026-09-20T00:01:00.000Z"
  });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.event_due, false);
  assert.equal(timing.last_activity_at, T1);
});

test("one actual safe progress change updates last_activity_at exactly once", () => {
  const timing = defaultTaskTiming();
  markTaskStarted(timing, { taskId: TASK_ID, at: T1 });
  const baseline = buildSafeWorkObservation({
    userMessageCount: 1,
    assistantMessageCount: 0,
    maxConversationTurnOrdinal: 1,
    responseRunning: false,
    lastAssistantCharCount: 0
  }, false);
  observeWorkActivity(timing, baseline, {
    at: "2026-09-20T00:00:06.000Z"
  });

  const progress = { ...baseline, response_running: true };
  const first = observeWorkActivity(timing, progress, {
    at: "2026-09-20T00:00:07.000Z"
  });
  assert.equal(first.changed, true);
  assert.equal(first.event_due, true);
  assert.equal(first.reason_code, "RESPONSE_RUNNING_CHANGED");
  assert.equal(timing.last_activity_at, "2026-09-20T00:00:07.000Z");

  const duplicate = observeWorkActivity(timing, progress, {
    at: "2026-09-20T00:00:20.000Z"
  });
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.event_due, false);
  assert.equal(timing.last_activity_at, "2026-09-20T00:00:07.000Z");
});

test("assistant char-count activity is restart-safe and deterministically coalesced", () => {
  const timing = defaultTaskTiming();
  markTaskStarted(timing, { taskId: TASK_ID, at: T1 });
  const base = buildSafeWorkObservation({
    assistantMessageCount: 1,
    maxConversationTurnOrdinal: 2,
    responseRunning: true,
    lastAssistantCharCount: 100
  }, false);
  observeWorkActivity(timing, base, { at: "2026-09-20T00:00:06.000Z" });

  const first = observeWorkActivity(timing, {
    ...base,
    last_assistant_char_count: 120
  }, { at: "2026-09-20T00:00:10.000Z" });
  assert.equal(first.event_due, true);

  const restarted = normalizeTaskTiming(JSON.parse(JSON.stringify(timing)));
  const withinWindow = observeWorkActivity(restarted, {
    ...base,
    last_assistant_char_count: 140
  }, { at: "2026-09-20T00:00:20.000Z" });
  assert.equal(withinWindow.changed, true);
  assert.equal(withinWindow.event_due, false);
  assert.equal(restarted.last_activity_at, "2026-09-20T00:00:20.000Z");

  const afterWindow = observeWorkActivity(restarted, {
    ...base,
    last_assistant_char_count: 160
  }, { at: "2026-09-20T00:00:41.000Z" });
  assert.equal(afterWindow.event_due, true);
});

test("restart normalization preserves all known timing state", () => {
  const timing = defaultTaskTiming();
  beginTaskAssignment(timing, {
    taskId: TASK_ID,
    directiveDigest: DIRECTIVE_DIGEST,
    at: T0
  });
  markTaskStarted(timing, {
    taskId: TASK_ID,
    directiveDigest: DIRECTIVE_DIGEST,
    at: T1
  });
  markTaskCompleted(timing, { taskId: TASK_ID, at: T2 });
  markRelayConfirmed(timing, { taskId: TASK_ID, at: T3 });

  const restarted = normalizeTaskTiming(JSON.parse(JSON.stringify(timing)));
  assert.deepEqual(restarted, timing);
});

test("duplicate directive and dispatch reconciliation do not duplicate assignment/start transitions", () => {
  const timing = defaultTaskTiming();
  const assignment1 = beginTaskAssignment(timing, {
    taskId: TASK_ID,
    directiveDigest: DIRECTIVE_DIGEST,
    at: T0
  });
  const assignment2 = beginTaskAssignment(timing, {
    taskId: TASK_ID,
    directiveDigest: DIRECTIVE_DIGEST,
    at: "2026-09-20T00:00:01.000Z"
  });
  const start1 = markTaskStarted(timing, {
    taskId: TASK_ID,
    directiveDigest: DIRECTIVE_DIGEST,
    at: T1
  });
  const start2 = markTaskStarted(timing, {
    taskId: TASK_ID,
    directiveDigest: DIRECTIVE_DIGEST,
    at: "2026-09-20T00:00:08.000Z"
  });

  assert.equal(assignment1.changed, true);
  assert.equal(assignment2.changed, false);
  assert.equal(start1.changed, true);
  assert.equal(start2.changed, false);
  assert.equal(timing.assigned_at, T0);
  assert.equal(timing.started_at, T1);
});

test("duplicate completion and relay reconciliation do not duplicate transitions", () => {
  const timing = defaultTaskTiming();
  markTaskStarted(timing, { taskId: TASK_ID, at: T1 });
  const completion1 = markTaskCompleted(timing, { taskId: TASK_ID, at: T2 });
  const completion2 = markTaskCompleted(timing, {
    taskId: TASK_ID,
    at: "2026-09-20T00:00:36.000Z"
  });
  const relay1 = markRelayConfirmed(timing, { taskId: TASK_ID, at: T3 });
  const relay2 = markRelayConfirmed(timing, {
    taskId: TASK_ID,
    at: "2026-09-20T00:00:45.000Z"
  });

  assert.equal(completion1.changed, true);
  assert.equal(completion2.changed, false);
  assert.equal(relay1.changed, true);
  assert.equal(relay2.changed, false);
  assert.equal(timing.completed_at, T2);
  assert.equal(timing.relay_confirmed_at, T3);
});

test("lane-1 lane-2 lane-3 events remain isolated", () => {
  const lines = ["lane-1", "lane-2", "lane-3"].map((laneId, index) =>
    serializeLaneEvent(baseEvent({
      lane_id: laneId,
      task_id: `TASK-LANE-${index + 1}`,
      work_generation: index
    }))
  );
  assert.deepEqual(lines.map((event) => event.lane_id), [
    "lane-1",
    "lane-2",
    "lane-3"
  ]);
  assert.deepEqual(lines.map((event) => event.task_id), [
    "TASK-LANE-1",
    "TASK-LANE-2",
    "TASK-LANE-3"
  ]);
});

test("event sink failure is fail-safe and cannot reopen an idempotent timing transition", async () => {
  const errors = [];
  const sink = createLaneEventSink({
    filePath: "ignored.ndjson",
    append: async () => {
      throw new Error("private filesystem detail");
    },
    onError: async ({ code }) => {
      errors.push(code);
    }
  });

  const timing = defaultTaskTiming();
  beginTaskAssignment(timing, {
    taskId: TASK_ID,
    directiveDigest: DIRECTIVE_DIGEST,
    at: T0
  });
  const started = markTaskStarted(timing, {
    taskId: TASK_ID,
    directiveDigest: DIRECTIVE_DIGEST,
    at: T1
  });
  assert.equal(started.changed, true);

  const result = await sink.emit(baseEvent({
    timestamp: T1,
    actor: "WORK",
    event_type: LANE_EVENT_TYPES.WORK_STARTED,
    phase: "STARTED",
    dispatch_id: DISPATCH_ID
  }));
  assert.deepEqual(result, {
    ok: false,
    code: "EVENT_SINK_WRITE_FAILED"
  });
  assert.deepEqual(errors, ["EVENT_SINK_WRITE_FAILED"]);

  const duplicate = markTaskStarted(timing, {
    taskId: TASK_ID,
    directiveDigest: DIRECTIVE_DIGEST,
    at: "2026-09-20T00:00:06.000Z"
  });
  assert.equal(duplicate.changed, false);
  assert.equal(timing.started_at, T1);
});

test("runtime source integrates events only at durable exact-once boundaries", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /SUPERVISOR_RUNTIME_VERSION = "2026-09-20\.60"/);
  assert.match(source, /beginTaskAssignment/);
  assert.match(source, /finalizeConfirmedDispatch/);
  assert.match(source, /WORK_DISPATCH_CONFIRMED/);
  assert.match(source, /WORK_STARTED/);
  assert.match(source, /observeWorkActivity/);
  assert.match(source, /markTaskCompleted/);
  assert.match(source, /finalizeConfirmedRelay/);
  assert.match(source, /RESULT_RELAY_CONFIRMED/);
  assert.match(source, /BRAIN_RESULT_ACCEPTED/);
  assert.match(source, /BRAIN_RESULT_REJECTED/);
  assert.match(source, /lane-events\.ndjson/);
  assert.match(source, /LANE_EVENT_SINK_ERROR/);
});
