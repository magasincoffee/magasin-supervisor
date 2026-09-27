import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { composerInstructionDigest } from "../src/ui/actions.mjs";
import {
  defaultPlannerExecutorState,
  runPlannerExecutorStep,
  writePlannerExecutorState
} from "../src/runtime/planner-executor.mjs";

async function tempStatePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-pe004-"));
  return path.join(dir, "planner-executor-state.json");
}

function pages() {
  return {
    plannerPage: { role: "planner" },
    executorPage: { role: "executor" }
  };
}

function assignmentState({
  message = "same outbound message",
  attempted = null,
  confirmed = null,
  baselineUserTurnId = "user:old"
} = {}) {
  const state = defaultPlannerExecutorState({ projectId: "P1" });
  state.active_task_id = "T1";
  state.assignment = {
    task_id: "T1",
    assignment_id: "A1",
    source_turn_id: "planner:1",
    planner_body: "Do T1.",
    message,
    message_digest: composerInstructionDigest(message),
    persisted_at: "2026-09-27T00:00:00.000Z",
    send_attempted_at: attempted,
    send_confirmed_at: confirmed,
    send_evidence: confirmed ? "matching-user-turn-observed" : null,
    blocked_reason: null,
    baseline_captured: true,
    baseline_user_turn_id: baselineUserTurnId,
    baseline_user_turn_digest: baselineUserTurnId
      ? composerInstructionDigest(message)
      : null
  };
  state.identity_history.assignment_ids.push("A1");
  return state;
}

test("PE-004 identical historical user text cannot falsely confirm a new outbound intent", async () => {
  const statePath = await tempStatePath();
  const { plannerPage, executorPage } = pages();
  const message = "same outbound message";
  const state = assignmentState({ message, attempted: null });
  await writePlannerExecutorState(statePath, state);

  let sends = 0;
  const result = await runPlannerExecutorStep({
    statePath,
    projectId: "P1",
    plannerPage,
    executorPage,
    captureTurn: async (page, role) => {
      if (page === executorPage && role === "user") {
        return {
          turn_id: "user:old",
          text: message,
          digest: "same-visible-text"
        };
      }
      return null;
    },
    inspectDraft: async () => ({
      ready: true,
      has_text: false,
      digest: null
    }),
    sendInstruction: async () => {
      sends += 1;
      return {
        executed: true,
        user_turn_evidence: "matching-user-turn-observed"
      };
    }
  });

  assert.equal(result.phase, "ASSIGNMENT_SEND_RECOVERY");
  assert.equal(result.outcome.status, "CONFIRMED");
  assert.equal(result.outcome.sent, true);
  assert.equal(sends, 1);
});

test("PE-004 a new matching user turn confirms an attempted send after restart without resend", async () => {
  const statePath = await tempStatePath();
  const { plannerPage, executorPage } = pages();
  const message = "recover this exact send";
  const state = assignmentState({
    message,
    attempted: "2026-09-27T00:00:01.000Z",
    baselineUserTurnId: "user:before"
  });
  await writePlannerExecutorState(statePath, state);

  let sends = 0;
  const result = await runPlannerExecutorStep({
    statePath,
    projectId: "P1",
    plannerPage,
    executorPage,
    captureTurn: async (page, role) => {
      if (page === executorPage && role === "user") {
        return {
          turn_id: "user:after",
          text: message,
          digest: "after"
        };
      }
      return null;
    },
    inspectDraft: async () => ({
      ready: true,
      has_text: false,
      digest: null
    }),
    sendInstruction: async () => {
      sends += 1;
      return { executed: true };
    }
  });

  assert.equal(result.outcome.status, "CONFIRMED");
  assert.equal(result.outcome.reconciled, true);
  assert.equal(result.outcome.sent, false);
  assert.equal(sends, 0);

  const durable = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.ok(durable.assignment.send_confirmed_at);
  assert.equal(
    durable.assignment.send_evidence,
    "latest-matching-user-turn"
  );
});

test("PE-004 result relay crash after send confirmation advances durable relay without duplicate send", async () => {
  const statePath = await tempStatePath();
  const { plannerPage, executorPage } = pages();
  const state = assignmentState({
    message: "assignment",
    confirmed: "2026-09-27T00:00:02.000Z"
  });
  state.result = {
    task_id: "T1",
    assignment_id: "A1",
    result_id: "R1",
    status: "pass",
    source_turn_id: "executor:1",
    executor_body: "PASS",
    message: "review R1",
    message_digest: composerInstructionDigest("review R1"),
    persisted_at: "2026-09-27T00:00:03.000Z",
    send_attempted_at: "2026-09-27T00:00:04.000Z",
    send_confirmed_at: "2026-09-27T00:00:05.000Z",
    relay_confirmed_at: null,
    blocked_reason: null,
    baseline_captured: true,
    baseline_user_turn_id: "planner:user:before",
    baseline_user_turn_digest: null
  };
  state.identity_history.result_ids.push("R1");
  await writePlannerExecutorState(statePath, state);

  let sends = 0;
  const result = await runPlannerExecutorStep({
    statePath,
    projectId: "P1",
    plannerPage,
    executorPage,
    captureTurn: async () => null,
    inspectDraft: async () => ({
      ready: true,
      has_text: false,
      digest: null
    }),
    sendInstruction: async () => {
      sends += 1;
      return { executed: true };
    }
  });

  assert.equal(result.phase, "RESULT_RELAY_RECOVERY");
  assert.equal(result.outcome.status, "CONFIRMED");
  assert.equal(result.outcome.sent, false);
  assert.equal(sends, 0);

  const durable = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(
    durable.result.relay_confirmed_at,
    "2026-09-27T00:00:05.000Z"
  );
});

test("PE-004 exact draft still recovers once after crash between type and submit", async () => {
  const statePath = await tempStatePath();
  const { plannerPage, executorPage } = pages();
  const message = "draft survived crash";
  const state = assignmentState({
    message,
    attempted: "2026-09-27T00:00:01.000Z"
  });
  await writePlannerExecutorState(statePath, state);

  let sends = 0;
  const result = await runPlannerExecutorStep({
    statePath,
    projectId: "P1",
    plannerPage,
    executorPage,
    captureTurn: async () => null,
    inspectDraft: async () => ({
      ready: true,
      has_text: true,
      digest: composerInstructionDigest(message)
    }),
    sendInstruction: async () => {
      sends += 1;
      return {
        executed: true,
        user_turn_evidence: "matching-user-turn-observed"
      };
    }
  });

  assert.equal(result.outcome.status, "CONFIRMED");
  assert.equal(sends, 1);
});

test("PE-004 reused assignment identity is rejected before any next-task send", async () => {
  const statePath = await tempStatePath();
  const { plannerPage, executorPage } = pages();
  const state = assignmentState({
    message: "assignment",
    confirmed: "2026-09-27T00:00:02.000Z"
  });
  state.result = {
    task_id: "T1",
    assignment_id: "A1",
    result_id: "R1",
    status: "pass",
    source_turn_id: "executor:1",
    executor_body: "PASS",
    message: "review R1",
    message_digest: composerInstructionDigest("review R1"),
    persisted_at: "2026-09-27T00:00:03.000Z",
    send_attempted_at: "2026-09-27T00:00:04.000Z",
    send_confirmed_at: "2026-09-27T00:00:05.000Z",
    relay_confirmed_at: "2026-09-27T00:00:05.000Z",
    blocked_reason: null,
    baseline_captured: true,
    baseline_user_turn_id: null,
    baseline_user_turn_digest: null
  };
  state.identity_history.result_ids.push("R1");
  state.planner.last_seen_assistant_turn_id = "planner:old";
  await writePlannerExecutorState(statePath, state);

  let sends = 0;
  await assert.rejects(
    runPlannerExecutorStep({
      statePath,
      projectId: "P1",
      plannerPage,
      executorPage,
      captureTurn: async (page, role) => {
        if (page === plannerPage && role === "assistant") {
          return {
            turn_id: "planner:new",
            digest: "new",
            text: [
              "Next task body.",
              '@M {"v":1,"a":"accept_assign","t":"T1","r":"R1","n":"T2","i":"A1"}'
            ].join("\n")
          };
        }
        return null;
      },
      inspectDraft: async () => ({
        ready: true,
        has_text: false,
        digest: null
      }),
      sendInstruction: async () => {
        sends += 1;
        return { executed: true };
      }
    }),
    /assignment_id reuse is not allowed/
  );
  assert.equal(sends, 0);
});

test("PE-004 reused result identity is rejected before relay", async () => {
  const statePath = await tempStatePath();
  const { plannerPage, executorPage } = pages();
  const state = assignmentState({
    message: "assignment",
    confirmed: "2026-09-27T00:00:02.000Z"
  });
  state.identity_history.result_ids.push("R-old");
  state.executor.last_seen_assistant_turn_id = "executor:old";
  await writePlannerExecutorState(statePath, state);

  let sends = 0;
  await assert.rejects(
    runPlannerExecutorStep({
      statePath,
      projectId: "P1",
      plannerPage,
      executorPage,
      captureTurn: async (page, role) => {
        if (page === executorPage && role === "assistant") {
          return {
            turn_id: "executor:new",
            digest: "new",
            text: [
              "PASS.",
              '@M {"v":1,"a":"report","t":"T1","i":"A1","r":"R-old","s":"pass"}'
            ].join("\n")
          };
        }
        return null;
      },
      inspectDraft: async () => ({
        ready: true,
        has_text: false,
        digest: null
      }),
      sendInstruction: async () => {
        sends += 1;
        return { executed: true };
      }
    }),
    /result_id reuse is not allowed/
  );
  assert.equal(sends, 0);
});

test("PE-004 persists outbound user-turn baseline before first send", async () => {
  const statePath = await tempStatePath();
  const { plannerPage, executorPage } = pages();
  const state = defaultPlannerExecutorState({ projectId: "P1" });
  await writePlannerExecutorState(statePath, state);

  let sends = 0;
  const result = await runPlannerExecutorStep({
    statePath,
    projectId: "P1",
    plannerPage,
    executorPage,
    captureTurn: async (page, role) => {
      if (page === plannerPage && role === "assistant") {
        return {
          turn_id: "planner:assign",
          digest: "assign",
          text: [
            "Do T1.",
            '@M {"v":1,"a":"assign","t":"T1","i":"A1"}'
          ].join("\n")
        };
      }
      if (page === executorPage && role === "user") {
        return {
          turn_id: "executor:user:before",
          digest: "before",
          text: "historical text"
        };
      }
      return null;
    },
    inspectDraft: async () => ({
      ready: true,
      has_text: false,
      digest: null
    }),
    sendInstruction: async () => {
      const durable = JSON.parse(await fs.readFile(statePath, "utf8"));
      assert.equal(durable.assignment.baseline_captured, true);
      assert.equal(
        durable.assignment.baseline_user_turn_id,
        "executor:user:before"
      );
      assert.ok(durable.assignment.send_attempted_at);
      sends += 1;
      return {
        executed: true,
        user_turn_evidence: "matching-user-turn-observed"
      };
    }
  });

  assert.equal(result.phase, "PLANNER_ASSIGN");
  assert.equal(sends, 1);

  const durable = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.deepEqual(durable.identity_history.assignment_ids, ["A1"]);
  assert.equal(durable.planner.last_seen_assistant_turn_id, "planner:assign");
});
