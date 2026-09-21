import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIONS,
  OBSERVATIONS,
  decideContinuation
} from "../src/decision.mjs";

function state(overrides = {}) {
  return {
    project: "Example Project",
    current_phase: "P1",
    current_task: "WORK-003",
    status: "RUNNING",
    autonomy: "AUTO_CONTINUE",
    blocked: false,
    requires_user: false,
    next_task: "WORK-004",
    ...overrides
  };
}

test("continues only after completed response and allowed state", () => {
  const result = decideContinuation({
    projectState: state(),
    observation: OBSERVATIONS.RESPONSE_COMPLETE
  });
  assert.equal(result.action, ACTIONS.CONTINUE);
  assert.match(result.instruction, /explicit source-of-truth/);
});

test("waits while assistant is still running", () => {
  const result = decideContinuation({
    projectState: state(),
    observation: OBSERVATIONS.ASSISTANT_RUNNING
  });
  assert.equal(result.action, ACTIONS.WAIT);
});

test("hard-stops on authentication requirement", () => {
  const result = decideContinuation({
    projectState: state(),
    observation: OBSERVATIONS.AUTH_REQUIRED
  });
  assert.equal(result.action, ACTIONS.STOP_WAIT_USER);
});

test("hard-stops when project state requires owner", () => {
  const result = decideContinuation({
    projectState: state({ requires_user: true }),
    observation: OBSERVATIONS.RESPONSE_COMPLETE
  });
  assert.equal(result.action, ACTIONS.STOP_WAIT_USER);
});

test("retries a transient error within budget", () => {
  const result = decideContinuation({
    projectState: state(),
    observation: OBSERVATIONS.NETWORK_ERROR,
    retryCount: 0,
    maxRetries: 2
  });
  assert.equal(result.action, ACTIONS.RETRY);
  assert.equal(result.nextRetryCount, 1);
});

test("stops after transient retry budget is exhausted", () => {
  const result = decideContinuation({
    projectState: state(),
    observation: OBSERVATIONS.NETWORK_ERROR,
    retryCount: 2,
    maxRetries: 2
  });
  assert.equal(result.action, ACTIONS.STOP_WAIT_USER);
});

test("fails closed for unknown UI state", () => {
  const result = decideContinuation({
    projectState: state(),
    observation: OBSERVATIONS.UNKNOWN
  });
  assert.equal(result.action, ACTIONS.WAIT);
});

test("does not continue in MANUAL autonomy mode", () => {
  const result = decideContinuation({
    projectState: state({ autonomy: "MANUAL" }),
    observation: OBSERVATIONS.RESPONSE_COMPLETE
  });
  assert.equal(result.action, ACTIONS.WAIT);
});

test("PAUSED temporal gate suppresses repeated continuation without creating an Owner boundary", () => {
  const result = decideContinuation({
    projectState: state({
      current_task: "WORK-048",
      status: "READY",
      autonomy: "PAUSED",
      requires_user: false,
      next_task: null
    }),
    observation: OBSERVATIONS.RESPONSE_COMPLETE
  });
  assert.equal(result.action, ACTIONS.WAIT);
  assert.match(result.reason, /autonomy mode is PAUSED/);
});

test("stops cleanly when project is DONE", () => {
  const result = decideContinuation({
    projectState: state({ status: "DONE" }),
    observation: OBSERVATIONS.RESPONSE_COMPLETE
  });
  assert.equal(result.action, ACTIONS.STOP_DONE);
});


test("first idle continuation uses handoff reconciliation instruction", () => {
  const result = decideContinuation({
    projectState: state({
      current_phase: "PHASE-A",
      current_task: "WORK-029",
      current_task_title: "Example work item",
      instructions: {
        handoff: "PROJECT HANDOFF POLICY"
      }
    }),
    observation: OBSERVATIONS.RESPONSE_COMPLETE,
    handoff: true
  });

  assert.equal(result.action, ACTIONS.CONTINUE);
  assert.match(result.instruction, /PROJECT HANDOFF POLICY/);
  assert.match(result.reason, /reconcile live Owner\/chat context/);
});

test("normal continuation carries Five-Step and current repository task context", () => {
  const result = decideContinuation({
    projectState: state({
      current_phase: "PHASE-A",
      current_task: "WORK-029",
      current_task_title: "Example work item",
      instructions: {
        continue: "PROJECT CONTINUATION POLICY"
      }
    }),
    observation: OBSERVATIONS.RESPONSE_COMPLETE
  });

  assert.equal(result.action, ACTIONS.CONTINUE);
  assert.match(result.instruction, /PROJECT CONTINUATION POLICY/);
  assert.match(result.instruction, /WORK-029/);
  assert.match(result.instruction, /Example work item/);
});

test("waits when the latest visible message is still the Owner request", () => {
  const result = decideContinuation({
    projectState: state(),
    observation: OBSERVATIONS.USER_PENDING,
    handoff: true
  });

  assert.equal(result.action, ACTIONS.WAIT);
  assert.match(result.reason, /latest visible message is from Owner/);
});


test("Owner decision reconciliation may safely run while repository is WAIT_USER", () => {
  const result = decideContinuation({
    projectState: state({
      status: "WAIT_USER",
      autonomy: "MANUAL",
      requires_user: true,
      instructions: {
        owner_reconcile: "PROJECT OWNER RECONCILE POLICY"
      }
    }),
    observation: OBSERVATIONS.RESPONSE_COMPLETE,
    ownerReconcile: true
  });

  assert.equal(result.action, ACTIONS.CONTINUE);
  assert.match(result.instruction, /PROJECT OWNER RECONCILE POLICY/);
});

test("Owner reconciliation never bypasses a BLOCKED project state", () => {
  const result = decideContinuation({
    projectState: state({
      status: "BLOCKED",
      blocked: true,
      requires_user: true
    }),
    observation: OBSERVATIONS.RESPONSE_COMPLETE,
    ownerReconcile: true
  });

  assert.equal(result.action, ACTIONS.STOP_WAIT_USER);
  assert.match(result.reason, /blocked/i);
});

test("Owner reconciliation waits while the live decision exchange is running", () => {
  const result = decideContinuation({
    projectState: state({
      status: "WAIT_USER",
      autonomy: "MANUAL",
      requires_user: true
    }),
    observation: OBSERVATIONS.ASSISTANT_RUNNING,
    ownerReconcile: true
  });

  assert.equal(result.action, ACTIONS.WAIT);
});
