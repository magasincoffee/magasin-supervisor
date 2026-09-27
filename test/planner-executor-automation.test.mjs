import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  defaultPlannerExecutorState,
  runPlannerExecutorStep,
  writePlannerExecutorState
} from "../src/runtime/planner-executor.mjs";
import {
  isPlannerExecutorTerminalPhase,
  plannerExecutorFailureIncident,
  recordPlannerExecutorIncident
} from "../src/runtime/planner-executor-automation.mjs";

async function tempPath(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-pe006-"));
  return path.join(dir, name);
}

function decisionReadyState() {
  const state = defaultPlannerExecutorState({ projectId: "UI2" });
  state.active_task_id = "UI2-020";
  state.assignment = {
    task_id: "UI2-020",
    assignment_id: "A020",
    send_confirmed_at: "2026-09-27T00:00:00.000Z"
  };
  state.result = {
    task_id: "UI2-020",
    assignment_id: "A020",
    result_id: "R020",
    status: "fail",
    send_confirmed_at: "2026-09-27T00:00:01.000Z",
    relay_confirmed_at: "2026-09-27T00:00:01.000Z"
  };
  state.identity_history.assignment_ids = ["A020"];
  state.identity_history.result_ids = ["R020"];
  return state;
}

test("PE-006 reject fast path assigns one bounded correction without another Planner round trip", async () => {
  const statePath = await tempPath("state.json");
  const state = decisionReadyState();
  await writePlannerExecutorState(statePath, state);

  const sends = [];
  const captureTurn = async (page, role) => {
    if (page.role === "planner" && role === "assistant") {
      return {
        turn_id: "planner-reject-1",
        text: [
          "Fix only the failed acceptance assertion, rerun the focused test, and report evidence.",
          '@M {"v":1,"a":"reject","t":"UI2-020","r":"R020","i":"A021"}'
        ].join("\n")
      };
    }
    return null;
  };

  const result = await runPlannerExecutorStep({
    statePath,
    projectId: "UI2",
    plannerPage: { role: "planner" },
    executorPage: { role: "executor" },
    captureTurn,
    inspectDraft: async () => ({
      ready: true,
      has_text: false,
      digest: null
    }),
    sendInstruction: async (page, message) => {
      sends.push({ role: page.role, message });
      return {
        executed: true,
        user_turn_evidence: "matching-user-turn-observed"
      };
    }
  });

  assert.equal(result.phase, "PLANNER_REJECT_CORRECTION");
  assert.equal(result.outcome.status, "CONFIRMED");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].role, "executor");
  assert.match(sends[0].message, /assignment A021/);
  assert.match(sends[0].message, /Fix only the failed acceptance assertion/);

  const durable = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(durable.assignment.task_id, "UI2-020");
  assert.equal(durable.assignment.assignment_id, "A021");
  assert.equal(durable.assignment.correction_of_result_id, "R020");
  assert.equal(durable.result, null);
  assert.equal(durable.automation.status, "RUNNING");
});

test("PE-006 reject without a bounded correction fails closed instead of looping", async () => {
  const statePath = await tempPath("state.json");
  await writePlannerExecutorState(statePath, decisionReadyState());

  const result = await runPlannerExecutorStep({
    statePath,
    projectId: "UI2",
    plannerPage: { role: "planner" },
    executorPage: { role: "executor" },
    captureTurn: async (page, role) => (
      page.role === "planner" && role === "assistant"
        ? {
            turn_id: "planner-reject-no-correction",
            text: [
              "Result is rejected but no safe correction is specified.",
              '@M {"v":1,"a":"reject","t":"UI2-020","r":"R020"}'
            ].join("\n")
          }
        : null
    ),
    inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
    sendInstruction: async () => {
      throw new Error("must not send");
    }
  });

  assert.equal(result.phase, "PLANNER_REJECT_BLOCKED");
  assert.equal(result.state.automation.status, "BLOCKED");
  assert.equal(result.state.automation.reason, "reject-missing-bounded-correction");
});

test("PE-006 blocked state waits for explicit resume and preserves task identity", async () => {
  const statePath = await tempPath("state.json");
  await writePlannerExecutorState(statePath, decisionReadyState());

  let assistant = {
    turn_id: "planner-blocked",
    text: [
      "Owner input is required before any safe correction.",
      '@M {"v":1,"a":"blocked","t":"UI2-020","r":"R020"}'
    ].join("\n")
  };

  const captureTurn = async (page, role) =>
    page.role === "planner" && role === "assistant" ? assistant : null;

  const blocked = await runPlannerExecutorStep({
    statePath,
    projectId: "UI2",
    plannerPage: { role: "planner" },
    executorPage: { role: "executor" },
    captureTurn,
    inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
    sendInstruction: async () => ({ executed: true })
  });
  assert.equal(blocked.phase, "PLANNER_BLOCKED");
  assert.equal(blocked.state.automation.status, "BLOCKED");

  assistant = {
    turn_id: "planner-resume",
    text: [
      "Owner dependency is now satisfied.",
      '@M {"v":1,"a":"resume","t":"UI2-020"}'
    ].join("\n")
  };

  const resumed = await runPlannerExecutorStep({
    statePath,
    projectId: "UI2",
    plannerPage: { role: "planner" },
    executorPage: { role: "executor" },
    captureTurn,
    inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
    sendInstruction: async () => ({ executed: true })
  });

  assert.equal(resumed.phase, "PLANNER_RESUMED");
  assert.equal(resumed.state.automation.status, "RUNNING");
  assert.equal(resumed.state.active_task_id, "UI2-020");
});

test("PE-006 done is terminal and records the accepted final result", async () => {
  const statePath = await tempPath("state.json");
  const state = decisionReadyState();
  state.result.status = "pass";
  await writePlannerExecutorState(statePath, state);

  const result = await runPlannerExecutorStep({
    statePath,
    projectId: "UI2",
    plannerPage: { role: "planner" },
    executorPage: { role: "executor" },
    captureTurn: async (page, role) => (
      page.role === "planner" && role === "assistant"
        ? {
            turn_id: "planner-done",
            text: [
              "All planned work is complete.",
              '@M {"v":1,"a":"done","t":"UI2-020","r":"R020"}'
            ].join("\n")
          }
        : null
    ),
    inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
    sendInstruction: async () => ({ executed: true })
  });

  assert.equal(result.phase, "PLANNER_DONE");
  assert.equal(result.state.automation.status, "DONE");
  assert.equal(result.state.active_task_id, null);
  assert.equal(result.state.last_completed.result_id, "R020");
  assert.equal(isPlannerExecutorTerminalPhase(result.phase), true);
});

test("PE-006 incident log is failure-only and excludes message bodies and URLs", async () => {
  assert.equal(
    plannerExecutorFailureIncident({
      phase: "PLANNER_ASSIGN",
      outcome: { status: "CONFIRMED" },
      state: { project_id: "UI2" }
    }),
    null
  );

  const incident = plannerExecutorFailureIncident({
    phase: "ASSIGNMENT_SEND_RECOVERY",
    outcome: {
      status: "SEND_NOT_CONFIRMED",
      detail: {
        rejection_class: "SEND_NOT_ACTUATED",
        reason: "button inert"
      }
    },
    state: {
      project_id: "UI2",
      active_task_id: "UI2-020",
      assignment: { assignment_id: "A020" },
      result: null
    }
  });
  assert.equal(incident.reason_code, "SEND_NOT_ACTUATED");

  const incidentPath = await tempPath("incidents.ndjson");
  await recordPlannerExecutorIncident(incidentPath, {
    ...incident,
    url: "https://chatgpt.com/c/private",
    message: "private body"
  });

  const text = await fs.readFile(incidentPath, "utf8");
  assert.match(text, /SEND_NOT_ACTUATED/);
  assert.doesNotMatch(text, /chatgpt\.com/);
  assert.doesNotMatch(text, /private body/);
  assert.doesNotMatch(text, /"url"/);
  assert.doesNotMatch(text, /"message"/);
});

test("PE-006 CLI contains bounded health recovery and terminal-stop wiring", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/planner-executor-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /recoverPlannerExecutorWarmTabs/);
  assert.match(source, /planner-executor-incidents\.ndjson/);
  assert.match(source, /isPlannerExecutorTerminalPhase/);
  assert.match(source, /PLANNER_EXECUTOR_HEALTH_RECOVERY/);
});
