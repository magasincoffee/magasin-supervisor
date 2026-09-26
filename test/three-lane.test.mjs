import test from "node:test";
import assert from "node:assert/strict";

import {
  THREE_LANE_MODE,
  LANE_IDS,
  normalizeChatGptConversationUrl,
  parseLaneDirective,
  defaultLaneConfig,
  normalizeLaneConfig,
  defaultLaneRegistry,
  normalizeLaneRegistry,
  buildWorkDispatchInstruction,
  workDispatchMarker,
  buildLaneResultRelay
} from "../src/runtime/three-lane.mjs";

test("Three-Lane contract has exactly three fixed isolated lane IDs", () => {
  assert.equal(THREE_LANE_MODE, "THREE_LANE_V1");
  assert.deepEqual(LANE_IDS, ["lane-1", "lane-2", "lane-3"]);
  assert.equal(defaultLaneConfig().lanes.length, 3);
  assert.equal(Object.keys(defaultLaneRegistry().lanes).length, 3);
});

test("Brain and Work targets require explicit ChatGPT conversation URLs", () => {
  assert.equal(
    normalizeChatGptConversationUrl("https://chatgpt.com/c/abc?foo=bar"),
    "https://chatgpt.com/c/abc"
  );
  assert.equal(
    normalizeChatGptConversationUrl("https://chatgpt.com/project/xyz"),
    "https://chatgpt.com/project/xyz"
  );
  assert.throws(
    () => normalizeChatGptConversationUrl("https://chatgpt.com/"),
    /specific ChatGPT conversation/
  );
  assert.throws(
    () => normalizeChatGptConversationUrl("https://example.com/c/abc"),
    /specific ChatGPT conversation/
  );
});

test("lane directive accepts WORK and IDLE only", () => {
  const work = parseLaneDirective(
    'prefix\n<<<MAGASIN_LANE_DIRECTIVE_V1>>>\n{"action":"WORK","task_id":"TASK-1","instruction":"Do the bounded task"}\n<<<END_MAGASIN_LANE_DIRECTIVE_V1>>>'
  );
  assert.equal(work.action, "WORK");
  assert.equal(work.task_id, "TASK-1");
  assert.equal(work.instruction, "Do the bounded task");
  assert.ok(work.instruction_digest);

  const idle = parseLaneDirective(
    '<<<MAGASIN_LANE_DIRECTIVE_V1>>>\n{"action":"IDLE"}\n<<<END_MAGASIN_LANE_DIRECTIVE_V1>>>'
  );
  assert.equal(idle.action, "IDLE");

  assert.throws(
    () => parseLaneDirective(
      '<<<MAGASIN_LANE_DIRECTIVE_V1>>>\n{"action":"CREATE_BRAIN"}\n<<<END_MAGASIN_LANE_DIRECTIVE_V1>>>'
    ),
    /unsupported lane directive/
  );
});

test("config normalization preserves exactly three lanes and Owner fields", () => {
  const config = normalizeLaneConfig({
    lanes: [
      { lane_id: "lane-2", project_name: "Media", brain_url: "https://chatgpt.com/c/media", enabled: true },
      { lane_id: "lane-9", project_name: "Ignored", brain_url: "x", enabled: true }
    ]
  });
  assert.equal(config.lanes.length, 3);
  assert.equal(config.lanes[1].project_name, "Media");
  assert.equal(config.lanes[1].enabled, true);
  assert.equal(config.lanes.some((lane) => lane.lane_id === "lane-9"), false);
});

test("registry normalization keeps Work state separate per lane", () => {
  const registry = normalizeLaneRegistry({
    lanes: {
      "lane-1": { work_url: "https://chatgpt.com/c/work1", awaiting_work: true, task_id: "A" },
      "lane-2": { work_url: "https://chatgpt.com/c/work2", awaiting_work: false, task_id: "B" }
    }
  });
  assert.equal(registry.lanes["lane-1"].work_url, "https://chatgpt.com/c/work1");
  assert.equal(registry.lanes["lane-2"].work_url, "https://chatgpt.com/c/work2");
  assert.equal(registry.lanes["lane-1"].awaiting_work, true);
  assert.equal(registry.lanes["lane-2"].awaiting_work, false);
});

test("result relay is deterministic and includes full Work text", () => {
  const a = buildLaneResultRelay({
    laneId: "lane-1",
    projectName: "Business OS",
    taskId: "TASK-123",
    generation: 2,
    responseText: "FULL RESULT BODY"
  });
  const b = buildLaneResultRelay({
    laneId: "lane-1",
    projectName: "Business OS",
    taskId: "TASK-123",
    generation: 2,
    responseText: "FULL RESULT BODY"
  });
  assert.equal(a.relay_id, b.relay_id);
  assert.match(a.text, /FULL RESULT BODY/);
  assert.match(a.text, /Ảnh đính kèm/);
});


test("Three-Lane normalizes transient WEB Work URLs from existing registry state", () => {
  const uuid = "6b744b22-161a-4125-80b8-d12f747a72a9";
  assert.equal(
    normalizeChatGptConversationUrl(`https://chatgpt.com/c/WEB:${uuid}`),
    `https://chatgpt.com/c/${uuid}`
  );

  const registry = normalizeLaneRegistry({
    lanes: {
      "lane-1": {
        work_url: `https://chatgpt.com/c/WEB:${uuid}`,
        awaiting_work: true,
        task_id: "TASK-049/THREE-LANE-E2E-01"
      }
    }
  });
  assert.equal(
    registry.lanes["lane-1"].work_url,
    `https://chatgpt.com/c/${uuid}`
  );
});



test("lane config carries revisioned Owner Brain URL", () => {
  const config = normalizeLaneConfig({
    lanes: [{
      lane_id: "lane-1",
      project_name: "Business OS",
      brain_url: "https://chatgpt.com/c/brain-new",
      brain_url_revision: 5,
      work_url: "",
      enabled: true
    }]
  });

  assert.equal(config.lanes[0].brain_url, "https://chatgpt.com/c/brain-new");
  assert.equal(config.lanes[0].brain_url_revision, 5);
});

test("legacy saved Brain URL is migrated to revision 1", () => {
  const config = normalizeLaneConfig({
    lanes: [{
      lane_id: "lane-1",
      brain_url: "https://chatgpt.com/c/legacy-brain"
    }]
  });
  assert.equal(config.lanes[0].brain_url_revision, 1);
});

test("lane resume revision is durable and legacy registries request one migration resync", () => {
  const config = normalizeLaneConfig({
    lanes: [{
      lane_id: "lane-1",
      resume_revision: 4,
      resume_requested_at: "2026-09-26T01:00:00.000Z"
    }]
  });
  assert.equal(config.lanes[0].resume_revision, 4);
  assert.equal(config.lanes[0].resume_requested_at, "2026-09-26T01:00:00.000Z");

  const legacy = normalizeLaneRegistry({
    lanes: { "lane-1": {} }
  });
  assert.equal(legacy.lanes["lane-1"].applied_resume_revision, -1);
  assert.equal(legacy.lanes["lane-1"].brain_resume_recovery_version, 0);

  const current = normalizeLaneRegistry(defaultLaneRegistry());
  assert.equal(current.lanes["lane-1"].applied_resume_revision, 0);
  assert.equal(current.lanes["lane-1"].brain_resume_recovery_version, 1);
});

test("lane registry tracks the applied Owner Brain URL revision", () => {
  const registry = normalizeLaneRegistry({
    lanes: {
      "lane-1": {
        brain_url: "https://chatgpt.com/c/brain-new",
        applied_brain_url_revision: 8
      }
    }
  });
  assert.equal(registry.lanes["lane-1"].brain_url, "https://chatgpt.com/c/brain-new");
  assert.equal(registry.lanes["lane-1"].applied_brain_url_revision, 8);
});

test("lane config carries optional Owner Work URL revision", () => {
  const config = normalizeLaneConfig({
    lanes: [{
      lane_id: "lane-1",
      project_name: "Business OS",
      brain_url: "https://chatgpt.com/c/brain",
      work_url: "https://chatgpt.com/c/work",
      work_url_revision: 4,
      work_url_saved_at: "2026-09-20T01:02:03.000Z",
      work_mode: "OWNER",
      enabled: false
    }]
  });

  assert.equal(config.lanes[0].work_url, "https://chatgpt.com/c/work");
  assert.equal(config.lanes[0].work_url_revision, 4);
  assert.equal(config.lanes[0].work_url_saved_at, "2026-09-20T01:02:03.000Z");
  assert.equal(config.lanes[0].work_mode, "OWNER");
});

test("lane config and registry normalize dedicated maintenance reset revision", () => {
  const config = normalizeLaneConfig({
    lanes: [{ lane_id: "lane-1", work_state_reset_revision: 6 }]
  });
  const registry = normalizeLaneRegistry({
    lanes: { "lane-1": { applied_work_state_reset_revision: 5 } }
  });

  assert.equal(config.lanes[0].work_state_reset_revision, 6);
  assert.equal(registry.lanes["lane-1"].applied_work_state_reset_revision, 5);
});

test("lane registry tracks the applied Owner Work URL revision", () => {
  const registry = normalizeLaneRegistry({
    lanes: {
      "lane-1": {
        work_url: "https://chatgpt.com/c/work",
        applied_work_url_revision: 7,
        applied_work_mode: "OWNER",
        pending_work_url: "https://chatgpt.com/c/next",
        pending_work_url_revision: 8,
        pending_work_saved_at: "2026-09-20T01:03:00.000Z",
        pending_work_mode: "OWNER"
      }
    }
  });
  assert.equal(registry.lanes["lane-1"].applied_work_url_revision, 7);
  assert.equal(registry.lanes["lane-1"].applied_work_mode, "OWNER");
  assert.equal(registry.lanes["lane-1"].pending_work_url, "https://chatgpt.com/c/next");
  assert.equal(registry.lanes["lane-1"].pending_work_url_revision, 8);
  assert.equal(registry.lanes["lane-1"].pending_work_mode, "OWNER");
});

test("legacy Work target state infers mode without fabricating a pending revision", () => {
  const registry = normalizeLaneRegistry({
    lanes: {
      "lane-1": {
        work_url: "https://chatgpt.com/c/legacy",
        work_generation: 3
      }
    }
  });
  assert.equal(registry.lanes["lane-1"].applied_work_mode, "OWNER");
  assert.equal(registry.lanes["lane-1"].pending_work_url_revision, 0);
  assert.equal(registry.lanes["lane-1"].pending_work_mode, null);
});


test("Work dispatch envelope carries deterministic machine marker without changing task body", () => {
  const dispatchId = "abc123";
  const text = buildWorkDispatchInstruction({
    taskId: "TASK-049/TEST",
    dispatchId,
    instruction: "Do one safe thing."
  });

  assert.match(text, /MAGASIN_WORK_DISPATCH_V1/);
  assert.match(text, /task_id=TASK-049\/TEST/);
  assert.match(text, /dispatch_id=abc123/);
  assert.match(text, /Do one safe thing\./);
  assert.equal(workDispatchMarker(dispatchId), "dispatch_id=abc123");
});
