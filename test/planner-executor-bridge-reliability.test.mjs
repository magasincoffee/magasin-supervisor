import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  createPlannerExecutorBridgeTransportStateMachine,
  BRIDGE_TRANSPORT_PHASES,
  BridgeTransportStateError
} from "../src/runtime/planner-executor-bridge-transport.mjs";
import {
  createPlannerExecutorBridgeProtocolController,
  BridgeProtocolIntegrationError
} from "../src/runtime/planner-executor-bridge-protocol.mjs";

const PLANNER_URL = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const EXECUTOR_URL = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";

function binding({ planner = "planner_old", executor = "executor_old" } = {}) {
  return {
    schema_version: "chatgpt-bridge-binding.v1",
    page_count: 2,
    exact_page_set: true,
    planner: {
      role: "planner",
      chat_url: PLANNER_URL,
      canonical_target: PLANNER_URL,
      page_id: planner,
      page_url: PLANNER_URL,
      title: "Planner"
    },
    executor: {
      role: "executor",
      chat_url: EXECUTOR_URL,
      canonical_target: EXECUTOR_URL,
      page_id: executor,
      page_url: EXECUTOR_URL,
      title: "Executor"
    },
    unrelated_page_ids: []
  };
}

function page(page_id, url) {
  return {
    page_id,
    title: "",
    url,
    alive: true,
    is_generating: false,
    assistant_count: 0,
    last_msg: "",
    last_poll_ago: 0
  };
}

test("pre-send role loss reacquires same canonical Executor and sends once to new page_id", async () => {
  const sends = [];
  let listCalls = 0;
  const adapter = {
    async getState(pageId) {
      if (pageId === "executor_old") {
        const error = new Error("missing");
        error.code = "PAGE_NOT_FOUND";
        throw error;
      }
      return { page_id: pageId, alive: true };
    },
    async listPages() {
      listCalls += 1;
      return [
        page("planner_old", PLANNER_URL),
        page("executor_new", EXECUTOR_URL)
      ];
    },
    async send(pageId, message) {
      sends.push({ pageId, message });
      return { ok: true, page_id: pageId, cmd_id: "cmd-1" };
    }
  };

  const machine = createPlannerExecutorBridgeTransportStateMachine({
    adapter,
    binding: binding(),
    reacquireAttempts: 2,
    reacquireBackoffMs: 1,
    sleepImpl: async () => {}
  });
  machine.start();
  machine.plannerBootstrapDispatched();

  await machine.plannerEvent({ action: "assign", message: "task" });

  assert.equal(listCalls, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].pageId, "executor_new");
  assert.equal(machine.snapshot().executor_page_id, "executor_new");
  assert.equal(machine.snapshot().phase, BRIDGE_TRANSPORT_PHASES.WAIT_EXECUTOR);
});

test("Bridge restart recovery retries observation only and never sends during reacquisition", async () => {
  let listCalls = 0;
  let sleepCalls = 0;
  const sends = [];
  const adapter = {
    async listPages() {
      listCalls += 1;
      if (listCalls < 3) {
        const error = new Error("bridge restarting");
        error.code = "BRIDGE_UNREACHABLE";
        throw error;
      }
      return [
        page("planner_new", PLANNER_URL),
        page("executor_new", EXECUTOR_URL)
      ];
    },
    async send(pageId, message) {
      sends.push({ pageId, message });
      return { ok: true, page_id: pageId, cmd_id: "unexpected" };
    }
  };

  const machine = createPlannerExecutorBridgeTransportStateMachine({
    adapter,
    binding: binding(),
    reacquireAttempts: 3,
    reacquireBackoffMs: 1,
    sleepImpl: async () => { sleepCalls += 1; }
  });

  const recovered = await machine.recoverBinding();

  assert.equal(recovered.recovery.status, "REACQUIRED");
  assert.equal(recovered.recovery.attempt, 3);
  assert.equal(sleepCalls, 2);
  assert.equal(sends.length, 0);
  assert.equal(machine.snapshot().planner_page_id, "planner_new");
  assert.equal(machine.snapshot().executor_page_id, "executor_new");
});

test("bounded reacquisition failure does not mutate phase or enqueue any message", async () => {
  let attempts = 0;
  const adapter = {
    async listPages() {
      attempts += 1;
      const error = new Error("offline");
      error.code = "BRIDGE_UNREACHABLE";
      throw error;
    },
    async send() {
      throw new Error("must not send");
    }
  };

  const machine = createPlannerExecutorBridgeTransportStateMachine({
    adapter,
    binding: binding(),
    reacquireAttempts: 2,
    reacquireBackoffMs: 1,
    sleepImpl: async () => {}
  });
  machine.start();
  machine.plannerBootstrapDispatched();

  await assert.rejects(
    () => machine.recoverBinding(),
    (error) => error instanceof BridgeTransportStateError &&
      error.code === "BINDING_REACQUIRE_FAILED"
  );
  assert.equal(attempts, 2);
  assert.equal(machine.snapshot().phase, BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER);
});

test("send ambiguity after enqueue remains BLOCKED and is never retried by recovery", async () => {
  let sends = 0;
  const adapter = {
    async getState(pageId) {
      return { page_id: pageId, alive: true };
    },
    async send() {
      sends += 1;
      const error = new Error("timeout after enqueue");
      error.code = "RESPONSE_TIMEOUT";
      throw error;
    }
  };

  const machine = createPlannerExecutorBridgeTransportStateMachine({
    adapter,
    binding: binding()
  });
  machine.start();
  machine.plannerBootstrapDispatched();

  await assert.rejects(
    () => machine.plannerEvent({ action: "assign", message: "task" }),
    (error) => error instanceof BridgeTransportStateError &&
      error.code === "TRANSPORT_SEND_AMBIGUOUS_BLOCKED"
  );
  assert.equal(sends, 1);
  assert.equal(machine.snapshot().phase, BRIDGE_TRANSPORT_PHASES.BLOCKED);
});

test("restored identity history blocks duplicate assignment and result identities after restart", async () => {
  const sends = [];
  const adapter = {
    async send(pageId, message) {
      sends.push({ pageId, message });
      return { ok: true, page_id: pageId, cmd_id: "cmd-" + sends.length };
    }
  };
  const transport = createPlannerExecutorBridgeTransportStateMachine({
    adapter,
    binding: binding()
  });
  transport.start();
  transport.plannerBootstrapDispatched();

  const controller = createPlannerExecutorBridgeProtocolController({
    transport,
    identityHistory: {
      assignment_ids: ["A-old"],
      result_ids: ["R-old"],
      turn_ids: ["turn-old"]
    },
    buildExecutorMessage: ({ body }) => body || "task",
    buildPlannerMessage: ({ body }) => body || "report"
  });

  const snap = controller.snapshot();
  assert.deepEqual(snap.identity_history.assignment_ids, ["A-old"]);
  assert.deepEqual(snap.identity_history.result_ids, ["R-old"]);
  assert.deepEqual(snap.identity_history.turn_ids, ["turn-old"]);

  await assert.rejects(
    () => controller.consumePlannerTurn(
      'Task\n@M {"v":1,"a":"assign","t":"T1","i":"A-old"}',
      { turnId: "turn-new" }
    ),
    (error) => error instanceof BridgeProtocolIntegrationError &&
      error.code === "DUPLICATE_ASSIGNMENT_ID"
  );
  assert.equal(sends.length, 0);

  await assert.rejects(
    () => controller.consumePlannerTurn(
      'Task\n@M {"v":1,"a":"assign","t":"T1","i":"A-new"}',
      { turnId: "turn-old" }
    ),
    (error) => error instanceof BridgeProtocolIntegrationError &&
      error.code === "DUPLICATE_TURN"
  );
  assert.equal(sends.length, 0);
});

test("identity history input is bounded and fails closed on invalid restore data", () => {
  const adapter = { async send() { return { ok: true }; } };
  const transport = createPlannerExecutorBridgeTransportStateMachine({
    adapter,
    binding: binding()
  });

  assert.throws(
    () => createPlannerExecutorBridgeProtocolController({
      transport,
      identityHistory: { assignment_ids: new Array(257).fill("A") }
    }),
    (error) => error instanceof BridgeProtocolIntegrationError &&
      error.code === "INVALID_IDENTITY_HISTORY"
  );
});


test("Bridge runtime status reports measured ChatGPT topology and overwrites stale success on startup failure", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/planner-executor-bridge-cli.mjs", import.meta.url),
    "utf8"
  );

  const statusStart = source.indexOf("async function persistStatus");
  const statusEnd = source.indexOf("async function ensureBridgeProjectBootstrap", statusStart);
  assert.ok(statusStart >= 0 && statusEnd > statusStart);
  const statusBlock = source.slice(statusStart, statusEnd);
  assert.match(statusBlock, /measuredChatGptTabs/);
  assert.doesNotMatch(statusBlock, /chatgpt_tabs:\s*2/);

  assert.match(source, /chatgpt_tabs:\s*browser\.getChatGptPageCount\(\)/);
  assert.match(source, /persistStatus\(statusPath, state, "STARTUP_FAILED"/);
  assert.match(source, /startup_failure_stage:\s*startupStage/);
});
