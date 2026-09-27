import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  composerInstructionDigest,
  inspectComposerDraftDigest
} from "../src/ui/actions.mjs";
import {
  defaultPlannerExecutorState,
  parseMachineFrame,
  runPlannerExecutorStep,
  writePlannerExecutorState
} from "../src/runtime/planner-executor.mjs";

process.env.MAGASIN_SUBMIT_DEBUG = "off";

async function tempStatePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-pe001-"));
  return path.join(dir, "planner-executor-state.json");
}

function makeHarness() {
  const plannerPage = { role: "planner" };
  const executorPage = { role: "executor" };
  const turns = {
    planner: { assistant: null, user: null },
    executor: { assistant: null, user: null }
  };
  const sends = [];

  const captureTurn = async (page, role) =>
    turns[page.role]?.[role] || null;

  const inspectDraft = async () => ({
    ready: true,
    has_text: false,
    digest: null
  });

  const sendInstruction = async (page, message) => {
    sends.push({ role: page.role, message });
    return {
      executed: true,
      user_turn_evidence: "matching-user-turn-observed"
    };
  };

  return {
    plannerPage,
    executorPage,
    turns,
    sends,
    captureTurn,
    inspectDraft,
    sendInstruction
  };
}

test("PE-001 happy path persists before send and completes assign -> report -> accept_assign in three sends", async () => {
  const statePath = await tempStatePath();
  const h = makeHarness();
  const persistChecks = [];

  const sendInstruction = async (page, message) => {
    const durable = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (page.role === "executor" && h.sends.length === 0) {
      assert.equal(durable.assignment.task_id, "UI2-012");
      assert.equal(durable.assignment.assignment_id, "A001");
      assert.ok(durable.assignment.send_attempted_at);
      persistChecks.push("assignment-before-send");
    } else if (page.role === "planner") {
      assert.equal(durable.result.result_id, "R001");
      assert.ok(durable.result.send_attempted_at);
      persistChecks.push("result-before-relay");
    } else if (page.role === "executor" && h.sends.length === 2) {
      assert.equal(durable.last_completed.task_id, "UI2-012");
      assert.equal(durable.assignment.task_id, "UI2-013");
      assert.equal(durable.assignment.assignment_id, "A002");
      persistChecks.push("accept-assign-before-next-send");
    }

    h.sends.push({ role: page.role, message });
    return {
      executed: true,
      user_turn_evidence: "matching-user-turn-observed"
    };
  };

  h.turns.planner.assistant = {
    turn_id: "planner-turn-1",
    text: [
      "Implement the bounded UI2-012 outcome and return evidence only.",
      '@M {"v":1,"a":"assign","t":"UI2-012","i":"A001"}'
    ].join("\n")
  };

  const first = await runPlannerExecutorStep({
    statePath,
    projectId: "UI2",
    plannerPage: h.plannerPage,
    executorPage: h.executorPage,
    captureTurn: h.captureTurn,
    inspectDraft: h.inspectDraft,
    sendInstruction
  });
  assert.equal(first.phase, "PLANNER_ASSIGN");
  assert.equal(first.outcome.status, "CONFIRMED");

  h.turns.executor.assistant = {
    turn_id: "executor-turn-1",
    text: [
      "UI2-012 completed. Tests and evidence are attached in this report.",
      '@M {"v":1,"a":"report","t":"UI2-012","i":"A001","r":"R001","s":"pass"}'
    ].join("\n")
  };

  const second = await runPlannerExecutorStep({
    statePath,
    projectId: "UI2",
    plannerPage: h.plannerPage,
    executorPage: h.executorPage,
    captureTurn: h.captureTurn,
    inspectDraft: h.inspectDraft,
    sendInstruction
  });
  assert.equal(second.phase, "EXECUTOR_REPORT");
  assert.equal(second.outcome.status, "CONFIRMED");

  h.turns.planner.assistant = {
    turn_id: "planner-turn-2",
    text: [
      "UI2-012 accepted. Execute UI2-013 next with the bounded canonical scope.",
      '@M {"v":1,"a":"accept_assign","t":"UI2-012","r":"R001","n":"UI2-013","i":"A002"}'
    ].join("\n")
  };

  const third = await runPlannerExecutorStep({
    statePath,
    projectId: "UI2",
    plannerPage: h.plannerPage,
    executorPage: h.executorPage,
    captureTurn: h.captureTurn,
    inspectDraft: h.inspectDraft,
    sendInstruction
  });
  assert.equal(third.phase, "PLANNER_ACCEPT_ASSIGN");
  assert.equal(third.outcome.status, "CONFIRMED");

  assert.deepEqual(
    h.sends.map((item) => item.role),
    ["executor", "planner", "executor"]
  );
  assert.equal(h.sends.length, 3);
  assert.deepEqual(persistChecks, [
    "assignment-before-send",
    "result-before-relay",
    "accept-assign-before-next-send"
  ]);

  const durable = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(durable.mode, "PLANNER_EXECUTOR_V1");
  assert.equal(durable.last_completed.task_id, "UI2-012");
  assert.equal(durable.active_task_id, "UI2-013");
  assert.equal(durable.assignment.assignment_id, "A002");
  assert.equal(durable.result, null);

  // Simulated restart with the same durable state must not duplicate the
  // confirmed next assignment.
  const fourth = await runPlannerExecutorStep({
    statePath,
    projectId: "UI2",
    plannerPage: h.plannerPage,
    executorPage: h.executorPage,
    captureTurn: h.captureTurn,
    inspectDraft: h.inspectDraft,
    sendInstruction
  });
  assert.equal(fourth.phase, "WAIT_EXECUTOR_REPORT");
  assert.equal(h.sends.length, 3);
});

test("PE-001 recovers a populated Robot-owned unsent draft by exact digest", async () => {
  const statePath = await tempStatePath();
  const h = makeHarness();
  const message = [
    "Task UI2-099 · assignment A099",
    "",
    "Do the bounded task."
  ].join("\n");
  const state = defaultPlannerExecutorState({ projectId: "UI2" });
  state.active_task_id = "UI2-099";
  state.assignment = {
    task_id: "UI2-099",
    assignment_id: "A099",
    source_turn_id: "planner-99",
    planner_body: "Do the bounded task.",
    message,
    message_digest: composerInstructionDigest(message),
    persisted_at: "2026-09-27T00:00:00.000Z",
    send_attempted_at: "2026-09-27T00:00:01.000Z",
    send_confirmed_at: null,
    send_evidence: null,
    blocked_reason: null
  };
  await writePlannerExecutorState(statePath, state);

  let sendCount = 0;
  const result = await runPlannerExecutorStep({
    statePath,
    projectId: "UI2",
    plannerPage: h.plannerPage,
    executorPage: h.executorPage,
    captureTurn: async () => null,
    inspectDraft: async () => ({
      ready: true,
      has_text: true,
      digest: composerInstructionDigest(message)
    }),
    sendInstruction: async () => {
      sendCount += 1;
      return {
        executed: true,
        user_turn_evidence: "matching-user-turn-observed"
      };
    }
  });

  assert.equal(result.phase, "ASSIGNMENT_SEND_RECOVERY");
  assert.equal(result.outcome.status, "CONFIRMED");
  assert.equal(sendCount, 1);

  const durable = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.ok(durable.assignment.send_confirmed_at);
});

test("PE-001 preserves foreign or Owner-authored drafts instead of overwriting them", async () => {
  const statePath = await tempStatePath();
  const h = makeHarness();
  const message = "Task UI2-100 · assignment A100";
  const state = defaultPlannerExecutorState({ projectId: "UI2" });
  state.active_task_id = "UI2-100";
  state.assignment = {
    task_id: "UI2-100",
    assignment_id: "A100",
    source_turn_id: "planner-100",
    planner_body: "Do the bounded task.",
    message,
    message_digest: composerInstructionDigest(message),
    persisted_at: "2026-09-27T00:00:00.000Z",
    send_attempted_at: null,
    send_confirmed_at: null,
    send_evidence: null,
    blocked_reason: null
  };
  await writePlannerExecutorState(statePath, state);

  let sendCount = 0;
  const result = await runPlannerExecutorStep({
    statePath,
    projectId: "UI2",
    plannerPage: h.plannerPage,
    executorPage: h.executorPage,
    captureTurn: async () => null,
    inspectDraft: async () => ({
      ready: true,
      has_text: true,
      digest: composerInstructionDigest("Owner draft that must survive")
    }),
    sendInstruction: async () => {
      sendCount += 1;
      return { executed: true };
    }
  });

  assert.equal(result.outcome.status, "BLOCKED_FOREIGN_DRAFT");
  assert.equal(sendCount, 0);
});

test("PE-001 restart is fail-closed when a previous send outcome is ambiguous", async () => {
  const statePath = await tempStatePath();
  const h = makeHarness();
  const message = "Task UI2-101 · assignment A101";
  const state = defaultPlannerExecutorState({ projectId: "UI2" });
  state.active_task_id = "UI2-101";
  state.assignment = {
    task_id: "UI2-101",
    assignment_id: "A101",
    source_turn_id: "planner-101",
    planner_body: "Do the bounded task.",
    message,
    message_digest: composerInstructionDigest(message),
    persisted_at: "2026-09-27T00:00:00.000Z",
    send_attempted_at: "2026-09-27T00:00:01.000Z",
    send_confirmed_at: null,
    send_evidence: null,
    blocked_reason: null
  };
  await writePlannerExecutorState(statePath, state);

  let sendCount = 0;
  const result = await runPlannerExecutorStep({
    statePath,
    projectId: "UI2",
    plannerPage: h.plannerPage,
    executorPage: h.executorPage,
    captureTurn: async () => null,
    inspectDraft: async () => ({
      ready: true,
      has_text: false,
      digest: null
    }),
    sendInstruction: async () => {
      sendCount += 1;
      return { executed: true };
    }
  });

  assert.equal(result.outcome.status, "UNCERTAIN_NO_DUPLICATE");
  assert.equal(sendCount, 0);
});

test("@M parser reads only the final machine line and ignores additive fields", () => {
  const parsed = parseMachineFrame([
    "One bounded task.",
    '@M {"v":1,"a":"assign","t":"UI2-1","i":"A1","future":"ignored"}'
  ].join("\n"));
  assert.equal(parsed.body, "One bounded task.");
  assert.deepEqual(parsed.frame, {
    v: 1,
    a: "assign",
    t: "UI2-1",
    i: "A1"
  });

  assert.throws(
    () => parseMachineFrame('@M {"v":2,"a":"assign","t":"UI2-1","i":"A1"}'),
    /unsupported/
  );
  assert.throws(
    () => parseMachineFrame("No machine frame"),
    /missing final @M/
  );
});

test("composer draft identity helper exposes only normalized digest metadata", async () => {
  let text = "  pending instruction\r\n";
  const composer = {
    first() { return this; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async isEditable() { return true; },
    async inputValue() { return text; }
  };
  const page = {
    locator() { return composer; },
    async waitForTimeout() {}
  };

  const snapshot = await inspectComposerDraftDigest(page);
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.has_text, true);
  assert.equal(
    snapshot.digest,
    composerInstructionDigest("pending instruction")
  );
  assert.equal(Object.hasOwn(snapshot, "text"), false);

  text = "";
  const empty = await inspectComposerDraftDigest(page);
  assert.equal(empty.has_text, false);
  assert.equal(empty.digest, null);
});

test("latest-turn observation implementation does not call historical capture helpers", async () => {
  const source = await fs.readFile(
    new URL("../src/ui/latest-turn.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /captureLatestRoleTurn/);
  assert.match(source, /Reverse-walk from the end/);
  assert.doesNotMatch(source, /captureConversationTurns/);
  assert.doesNotMatch(source, /captureRecentConversationTurns/);
  assert.doesNotMatch(source, /limit:\s*120/);
});


test("Planner/Executor forward runtime has no scheduler or ChatGPT Work mode dependency", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/planner-executor.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /browser-scheduler/i);
  assert.doesNotMatch(source, /three-lane/i);
  assert.doesNotMatch(source, /ChatGPT Work/i);
  assert.doesNotMatch(source, /MAGASIN_WORK_DISPATCH_V1/);
  assert.match(source, /plannerPage/);
  assert.match(source, /executorPage/);
});


test("project-aware Planner frame persists Source-of-Truth progress and anchors Executor message", async () => {
  const statePath = await tempStatePath();
  const h = makeHarness();
  const state = defaultPlannerExecutorState({
    projectId: "UI2",
    plannerTarget: "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",
    executorTarget: "https://chatgpt.com/c/22222222-2222-2222-2222-222222222222"
  });
  state.project_generation = 4;
  state.project_name = "UI2";
  state.project_context = {
    source_of_truth_url: "https://github.com/example/ui2/blob/main/SOURCE_OF_TRUTH.md",
    strict_correlation: true
  };
  await writePlannerExecutorState(statePath, state);

  h.turns.planner.assistant = {
    turn_id: "planner-project-turn-1",
    text: [
      "Implement UI2-018 from canonical project truth.",
      '@M {"v":1,"a":"assign","p":"UI2","g":4,"t":"UI2-018","i":"A018","pc":17,"pt":24}'
    ].join("\n")
  };

  const first = await runPlannerExecutorStep({
    statePath,
    projectId: "UI2",
    plannerPage: h.plannerPage,
    executorPage: h.executorPage,
    captureTurn: h.captureTurn,
    inspectDraft: h.inspectDraft,
    sendInstruction: h.sendInstruction
  });

  assert.equal(first.phase, "PLANNER_ASSIGN");
  assert.equal(first.state.project_progress.known, true);
  assert.equal(first.state.project_progress.completed_tasks, 17);
  assert.equal(first.state.project_progress.total_tasks, 24);
  assert.equal(first.state.project_progress.percent, 71);
  assert.match(h.sends[0].message, /Project: UI2/);
  assert.match(h.sends[0].message, /Project generation: 4/);
  assert.match(h.sends[0].message, /Canonical Source of Truth:/);
  assert.match(h.sends[0].message, /"p":"UI2","g":4/);
});

test("strict project correlation rejects a stale frame from another project generation", async () => {
  const statePath = await tempStatePath();
  const h = makeHarness();
  const state = defaultPlannerExecutorState({ projectId: "UI2" });
  state.project_generation = 5;
  state.project_context = {
    source_of_truth_url: "https://example.com/ui2-source",
    strict_correlation: true
  };
  await writePlannerExecutorState(statePath, state);

  h.turns.planner.assistant = {
    turn_id: "stale-project-turn",
    text: [
      "stale",
      '@M {"v":1,"a":"assign","p":"UI2","g":4,"t":"UI2-999","i":"A999","pc":1,"pt":10}'
    ].join("\n")
  };

  await assert.rejects(
    runPlannerExecutorStep({
      statePath,
      projectId: "UI2",
      plannerPage: h.plannerPage,
      executorPage: h.executorPage,
      captureTurn: h.captureTurn,
      inspectDraft: h.inspectDraft,
      sendInstruction: h.sendInstruction
    }),
    /project_generation correlation mismatch/
  );
  assert.equal(h.sends.length, 0);
});

test("Planner may declare a freshly bootstrapped project already complete before assignment", async () => {
  const statePath = await tempStatePath();
  const h = makeHarness();
  const state = defaultPlannerExecutorState({ projectId: "DONEPROJ" });
  state.project_generation = 2;
  state.project_context = {
    source_of_truth_url: "https://example.com/done",
    strict_correlation: true
  };
  await writePlannerExecutorState(statePath, state);

  h.turns.planner.assistant = {
    turn_id: "done-project-turn",
    text: [
      "Source of Truth shows every task complete.",
      '@M {"v":1,"a":"done","p":"DONEPROJ","g":2,"pc":12,"pt":12}'
    ].join("\n")
  };

  const result = await runPlannerExecutorStep({
    statePath,
    projectId: "DONEPROJ",
    plannerPage: h.plannerPage,
    executorPage: h.executorPage,
    captureTurn: h.captureTurn,
    inspectDraft: h.inspectDraft,
    sendInstruction: h.sendInstruction
  });
  assert.equal(result.phase, "PLANNER_DONE");
  assert.equal(result.state.project_progress.percent, 100);
  assert.equal(h.sends.length, 0);
});
