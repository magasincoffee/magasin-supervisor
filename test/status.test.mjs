import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRuntimeStatus,
  defaultRuntimeStatusPath
} from "../src/runtime/status.mjs";

test("runtime status exposes project/task/action metadata without private content", () => {
  const payload = buildRuntimeStatus({
    projectState: {
      project: "Example Project",
      repository: "example/project",
      current_phase: "P1",
      current_task: "WORK-009",
      current_task_title: "Store/product canonical model review",
      next_task: "WORK-010",
      autonomy: "AUTO_CONTINUE",
      status: "READY",
      requires_user: false,
      blocked: false
    },
    status: "RUNNING",
    uiState: "RUNNING",
    observation: "ASSISTANT_RUNNING",
    decision: { action: "WAIT", reason: "assistant is still running" },
    execution: { executed: false },
    retryCount: 1
  });

  assert.equal(payload.project, "Example Project");
  assert.equal(payload.current_task, "WORK-009");
  assert.equal(payload.project_status, "READY");
  assert.equal(payload.status, "RUNNING");
  assert.equal(payload.decision_action, "WAIT");
  assert.equal(payload.retry_count, 1);

  const keys = Object.keys(payload).join(" ");
  assert.doesNotMatch(keys, /cookie|token|credential|message_body|prompt/i);
});

test("runtime status path honors explicit platform state-root configuration", () => {
  const file = defaultRuntimeStatusPath({
    SUPERVISOR_STATE_ROOT: "/tmp/example-supervisor-root"
  });
  assert.match(file, /example-supervisor-root[\\/]runtime-status\.json$/);
});


test("runtime status exposes why an action did not execute", () => {
  const payload = buildRuntimeStatus({
    projectState: {
      project: "Example Project",
      repository: "example/project",
      current_phase: "P1",
      current_task: "WORK-009",
      current_task_title: "Store/product canonical model review",
      next_task: "WORK-010",
      autonomy: "AUTO_CONTINUE"
    },
    status: "READY",
    decision: { action: "CONTINUE", reason: "assistant response completed" },
    execution: { executed: false, reason: "awaiting observable assistant progress" }
  });

  assert.equal(payload.execution_executed, false);
  assert.equal(payload.execution_reason, "awaiting observable assistant progress");
});


test("runtime status exposes recovery state without conversation content", () => {
  const payload = buildRuntimeStatus({
    projectState: {
      project: "Example Project",
      repository: "example/project",
      current_phase: "P1",
      current_task: "WORK-009",
      current_task_title: "Store/product canonical model review",
      next_task: "WORK-010",
      autonomy: "AUTO_CONTINUE"
    },
    status: "RECOVERING",
    recovery: {
      action: "RELOAD_STALLED",
      reason: "ChatGPT response stayed running too long",
      stall_reloads: 1,
      unavailable_reloads: 0,
      target_misses: 0,
      rollover_failures: 0,
      conversation_generation: 2,
      blocked: false
    }
  });

  assert.equal(payload.recovery_action, "RELOAD_STALLED");
  assert.equal(payload.recovery_stall_reloads, 1);
  assert.equal(payload.conversation_generation, 2);
  assert.equal(payload.recovery_blocked, false);

  const keys = Object.keys(payload).join(" ");
  assert.doesNotMatch(keys, /cookie|token|credential|message_body|prompt|conversation_text/i);
});


test("runtime status preserves safe WAIT_USER boundary metadata", () => {
  const payload = buildRuntimeStatus({
    projectState: {
      project: "Example Project",
      repository: "example/project",
      current_task: "WORK-035",
      status: "WAIT_USER",
      autonomy: "MANUAL",
      requires_user: true,
      blocked: false,
      owner_boundary: {
        pending: []
      },
      activation_boundary: {
        reason: "GMAIL_OAUTH_CREDENTIALS_REQUIRED",
        pending: [
          "GMAIL_OAUTH_CLIENT_ID",
          "GMAIL_OAUTH_CLIENT_SECRET",
          "GMAIL_OAUTH_REFRESH_TOKEN"
        ]
      }
    }
  });

  assert.equal(payload.schema_version, 2);
  assert.deepEqual(payload.owner_boundary_pending, []);
  assert.equal(
    payload.activation_boundary_reason,
    "GMAIL_OAUTH_CREDENTIALS_REQUIRED"
  );
  assert.deepEqual(payload.activation_boundary_pending, [
    "GMAIL_OAUTH_CLIENT_ID",
    "GMAIL_OAUTH_CLIENT_SECRET",
    "GMAIL_OAUTH_REFRESH_TOKEN"
  ]);
});
