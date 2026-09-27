import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildPe001PlannerQualificationPrompt,
  runPe001LiveQualification
} from "../src/runtime/planner-executor-qualification.mjs";

async function tempStatePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-pe001-live-"));
  return path.join(dir, "state.json");
}

test("PE-001 live qualification prompt uses normal chats and compact @M assignment", () => {
  const prompt = buildPe001PlannerQualificationPrompt();
  assert.match(prompt, /Planner role/);
  assert.match(prompt, /temporary normal ChatGPT conversation/);
  assert.match(prompt, /Do not use tools, apps, connectors, or ChatGPT Work mode/);
  assert.match(
    prompt,
    /@M \{"v":1,"a":"assign","t":"PE001-QUAL-1","i":"A001"\}$/
  );
});

test("PE-001 live qualification core proves assign -> report -> accept_assign without external tools", async () => {
  const statePath = await tempStatePath();
  const plannerPage = { role: "planner" };
  const executorPage = { role: "executor" };
  const queues = {
    planner: {
      assistant: [
        {
          turn_id: "planner-assignment",
          text: [
            "Task PE001-QUAL-1 · assignment A001",
            "",
            "Perform a harmless qualification check and return PASS.",
            '@M {"v":1,"a":"assign","t":"PE001-QUAL-1","i":"A001"}'
          ].join("\n")
        },
        {
          turn_id: "planner-decision",
          text: [
            "ACCEPT PE001-QUAL-1. Perform the second harmless check.",
            '@M {"v":1,"a":"accept_assign","t":"PE001-QUAL-1","r":"R001","n":"PE001-QUAL-2","i":"A002"}'
          ].join("\n")
        }
      ],
      user: []
    },
    executor: {
      assistant: [
        {
          turn_id: "executor-report",
          text: [
            "PASS — harmless qualification check completed.",
            '@M {"v":1,"a":"report","t":"PE001-QUAL-1","i":"A001","r":"R001","s":"pass"}'
          ].join("\n")
        }
      ],
      user: []
    }
  };
  const visible = {
    planner: { assistant: null, user: null },
    executor: { assistant: null, user: null }
  };
  const sends = [];

  const captureTurn = async (page, role) => visible[page.role][role];

  const sendInstruction = async (page, message) => {
    sends.push({ role: page.role, message });
    visible[page.role].user = {
      turn_id: `${page.role}-user-${sends.length}`,
      text: message
    };
    return {
      executed: true,
      user_turn_evidence: "matching-user-turn-observed"
    };
  };

  const waitForTurn = async (page, previousTurnId) => {
    const next = queues[page.role].assistant.shift();
    assert.ok(next, `missing fake assistant response for ${page.role}`);
    assert.notEqual(next.turn_id, previousTurnId);
    visible[page.role].assistant = next;
    return next;
  };

  const inspectDraft = async () => ({
    ready: true,
    has_text: false,
    digest: null
  });

  const result = await runPe001LiveQualification({
    statePath,
    plannerPage,
    executorPage,
    captureTurn,
    sendInstruction,
    waitForTurn,
    inspectDraft
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.task_cycle.completed_task_id, "PE001-QUAL-1");
  assert.equal(result.task_cycle.result_id, "R001");
  assert.equal(result.task_cycle.next_task_id, "PE001-QUAL-2");
  assert.equal(result.task_cycle.next_assignment_id, "A002");
  assert.equal(result.task_cycle.send_count, 3);
  assert.equal(result.gates.normal_chat_conversations, 2);
  assert.equal(result.gates.chatgpt_work_mode_invocations, 0);

  // Bootstrap + exactly three sends for one complete task cycle.
  assert.equal(sends.length, 4);
  assert.deepEqual(
    sends.map((item) => item.role),
    ["planner", "executor", "planner", "executor"]
  );
});

test("live qualification CLI is explicit opt-in and refuses hidden automatic execution", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/planner-executor-qualification-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /--execute/);
  assert.match(source, /MAGASIN_PE001_LIVE_QUALIFICATION/);
  assert.match(source, /LIVE_SUPERVISOR_ACTIVE/);
  assert.match(source, /supervisor\.pid/);
  assert.match(source, /production_cutover: false/);
  assert.doesNotMatch(source, /workflow_dispatch/);
});
