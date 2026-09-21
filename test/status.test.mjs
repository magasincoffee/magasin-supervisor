import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  buildRuntimeStatus,
  defaultRuntimeStatusPath
} from "../src/runtime/status.mjs";

function project(overrides = {}) {
  return {
    project: "Example Project",
    repository: "example/project",
    current_phase: "BUILD",
    current_task: "PLATFORM-009",
    current_task_title: "Platform contract review",
    next_task: "PLATFORM-010",
    autonomy: "AUTO_CONTINUE",
    status: "READY",
    requires_user: false,
    blocked: false,
    ...overrides
  };
}

test("runtime status exposes project/task/action metadata without private content", () => {
  const payload = buildRuntimeStatus({
    projectState: project(),
    status: "RUNNING",
    uiState: "RUNNING",
    observation: "ASSISTANT_RUNNING",
    decision: { action: "WAIT", reason: "assistant is still running" },
    execution: { executed: false },
    retryCount: 1
  });

  assert.equal(payload.project, "Example Project");
  assert.equal(payload.repository, "example/project");
  assert.equal(payload.current_task, "PLATFORM-009");
  assert.equal(payload.project_status, "READY");
  assert.equal(payload.status, "RUNNING");
  assert.equal(payload.decision_action, "WAIT");
  assert.equal(payload.retry_count, 1);

  const keys = Object.keys(payload).join(" ");
  assert.doesNotMatch(keys, /cookie|token|credential|message_body|prompt/i);
});

test("runtime status has neutral defaults when project identity is absent", () => {
  const payload = buildRuntimeStatus({});
  assert.equal(payload.project, "Supervisor Project");
  assert.equal(payload.repository, null);
});

test("runtime status path preserves legacy root by compatibility default", () => {
  const file = defaultRuntimeStatusPath({
    LOCALAPPDATA: path.join("C:", "Users", "Owner", "AppData", "Local")
  });
  assert.match(file, /MAGASIN[\\/]BusinessOS[\\/]supervisor[\\/]runtime-status\.json$/);
});

test("runtime status path honors explicit platform state-root config", () => {
  const env = {
    MAGASIN_SUPERVISOR_STATE_ROOT: path.join("D:", "SupervisorState")
  };
  const file = defaultRuntimeStatusPath(env);
  assert.match(file, /SupervisorState[\\/]runtime-status\.json$/);
  assert.doesNotMatch(file, /BusinessOS/);
});

test("runtime status exposes why an action did not execute", () => {
  const payload = buildRuntimeStatus({
    projectState: project(),
    status: "READY",
    decision: { action: "CONTINUE", reason: "assistant response completed" },
    execution: { executed: false, reason: "awaiting observable assistant progress" }
  });
  assert.equal(payload.execution_executed, false);
  assert.equal(payload.execution_reason, "awaiting observable assistant progress");
});

test("runtime status preserves safe WAIT_USER boundary metadata", () => {
  const payload = buildRuntimeStatus({
    projectState: project({
      current_task: "PLATFORM-035",
      status: "WAIT_USER",
      autonomy: "MANUAL",
      requires_user: true,
      owner_boundary: { pending: [] },
      activation_boundary: {
        reason: "EXTERNAL_CREDENTIALS_REQUIRED",
        pending: ["CREDENTIAL_REFERENCE"]
      }
    })
  });

  assert.equal(payload.schema_version, 2);
  assert.deepEqual(payload.owner_boundary_pending, []);
  assert.equal(payload.activation_boundary_reason, "EXTERNAL_CREDENTIALS_REQUIRED");
  assert.deepEqual(payload.activation_boundary_pending, ["CREDENTIAL_REFERENCE"]);
});
