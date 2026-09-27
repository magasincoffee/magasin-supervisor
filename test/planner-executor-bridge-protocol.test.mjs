import test from "node:test";
import assert from "node:assert/strict";

import {
  createPlannerExecutorBridgeProtocolController,
  BridgeProtocolIntegrationError
} from "../src/runtime/planner-executor-bridge-protocol.mjs";
import {
  createPlannerExecutorBridgeTransportStateMachine,
  BRIDGE_TRANSPORT_PHASES
} from "../src/runtime/planner-executor-bridge-transport.mjs";

function binding() {
  return {
    schema_version: "chatgpt-bridge-binding.v1",
    page_count: 2,
    exact_page_set: true,
    planner: {
      role: "planner",
      chat_url: "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",
      canonical_target: "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",
      page_id: "planner_pid",
      page_url: "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",
      title: "Planner"
    },
    executor: {
      role: "executor",
      chat_url: "https://chatgpt.com/c/22222222-2222-2222-2222-222222222222",
      canonical_target: "https://chatgpt.com/c/22222222-2222-2222-2222-222222222222",
      page_id: "executor_pid",
      page_url: "https://chatgpt.com/c/22222222-2222-2222-2222-222222222222",
      title: "Executor"
    },
    unrelated_page_ids: []
  };
}

function fixture({ strict = false } = {}) {
  const calls = [];
  const adapter = {
    async send(pageId, message) {
      calls.push({ pageId, message });
      return { ok: true, page_id: pageId, cmd_id: "cmd-" + calls.length };
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
    projectId: "LIVE",
    projectGeneration: 1,
    strictProjectCorrelation: strict,
    buildExecutorMessage: ({ frame, body, kind }) =>
      kind + ":" + (frame.n || frame.t || "") + ":" + (frame.i || "") + ":" + body,
    buildPlannerMessage: ({ frame, body }) =>
      "report:" + frame.t + ":" + frame.i + ":" + frame.r + ":" + body
  });
  return { calls, transport, controller };
}

test("canonical parser drives assign -> report -> accept_assign through Bridge transport", async () => {
  const { calls, transport, controller } = fixture();

  await controller.consumePlannerTurn(
    "Do task\n@M {\"v\":1,\"a\":\"assign\",\"t\":\"T1\",\"i\":\"A1\"}",
    { turnId: "p1" }
  );
  assert.equal(transport.snapshot().phase, BRIDGE_TRANSPORT_PHASES.WAIT_EXECUTOR);

  await controller.consumeExecutorTurn(
    "PASS\n@M {\"v\":1,\"a\":\"report\",\"t\":\"T1\",\"i\":\"A1\",\"r\":\"R1\",\"s\":\"pass\"}",
    { turnId: "e1" }
  );
  assert.equal(transport.snapshot().phase, BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER_DECISION);

  await controller.consumePlannerTurn(
    "Next\n@M {\"v\":1,\"a\":\"accept_assign\",\"t\":\"T1\",\"r\":\"R1\",\"n\":\"T2\",\"i\":\"A2\"}",
    { turnId: "p2" }
  );
  assert.equal(transport.snapshot().phase, BRIDGE_TRANSPORT_PHASES.WAIT_EXECUTOR);
  assert.deepEqual(calls.map(c => c.pageId), [
    "executor_pid",
    "planner_pid",
    "executor_pid"
  ]);
  assert.equal(controller.snapshot().current_task_id, "T2");
});

test("malformed frame fails closed before any Bridge mutation", async () => {
  const { calls, controller } = fixture();
  await assert.rejects(
    () => controller.consumePlannerTurn("no frame", { turnId: "p1" }),
    (error) => error instanceof BridgeProtocolIntegrationError &&
      error.code === "INVALID_MACHINE_FRAME"
  );
  assert.equal(calls.length, 0);
});

test("mismatched Executor report fails closed before relay", async () => {
  const { calls, controller } = fixture();
  await controller.consumePlannerTurn(
    "Task\n@M {\"v\":1,\"a\":\"assign\",\"t\":\"T1\",\"i\":\"A1\"}",
    { turnId: "p1" }
  );
  await assert.rejects(
    () => controller.consumeExecutorTurn(
      "Bad\n@M {\"v\":1,\"a\":\"report\",\"t\":\"OTHER\",\"i\":\"A1\",\"r\":\"R1\",\"s\":\"pass\"}",
      { turnId: "e1" }
    ),
    (error) => error instanceof BridgeProtocolIntegrationError &&
      error.code === "FRAME_CORRELATION_MISMATCH"
  );
  assert.equal(calls.length, 1);
});

test("duplicate turn and assignment identities fail closed", async () => {
  const { calls, controller } = fixture();
  const assign =
    "Task\n@M {\"v\":1,\"a\":\"assign\",\"t\":\"T1\",\"i\":\"A1\"}";
  await controller.consumePlannerTurn(assign, { turnId: "p1" });
  await assert.rejects(
    () => controller.consumePlannerTurn(assign, { turnId: "p1" }),
    (error) => error instanceof BridgeProtocolIntegrationError &&
      error.code === "DUPLICATE_TURN"
  );
  assert.equal(calls.length, 1);
});

test("strict project identity rejects wrong project/generation before send", async () => {
  const { calls, controller } = fixture({ strict: true });
  await assert.rejects(
    () => controller.consumePlannerTurn(
      "Task\n@M {\"v\":1,\"a\":\"assign\",\"p\":\"OTHER\",\"g\":1,\"t\":\"T1\",\"i\":\"A1\"}",
      { turnId: "p1" }
    ),
    (error) => error instanceof BridgeProtocolIntegrationError &&
      error.code === "PROJECT_CORRELATION_MISMATCH"
  );
  assert.equal(calls.length, 0);
});

test("reject without bounded correction enters BLOCKED without Executor send", async () => {
  const { calls, transport, controller } = fixture();
  await controller.consumePlannerTurn(
    "Task\n@M {\"v\":1,\"a\":\"assign\",\"t\":\"T1\",\"i\":\"A1\"}",
    { turnId: "p1" }
  );
  await controller.consumeExecutorTurn(
    "FAIL\n@M {\"v\":1,\"a\":\"report\",\"t\":\"T1\",\"i\":\"A1\",\"r\":\"R1\",\"s\":\"fail\"}",
    { turnId: "e1" }
  );
  const before = calls.length;
  await controller.consumePlannerTurn(
    "@M {\"v\":1,\"a\":\"reject\",\"t\":\"T1\",\"r\":\"R1\"}",
    { turnId: "p2" }
  );
  assert.equal(calls.length, before);
  assert.equal(transport.snapshot().phase, BRIDGE_TRANSPORT_PHASES.BLOCKED);
});

test("reject with correction requires fresh assignment id and routes correction", async () => {
  const { calls, controller, transport } = fixture();
  await controller.consumePlannerTurn(
    "Task\n@M {\"v\":1,\"a\":\"assign\",\"t\":\"T1\",\"i\":\"A1\"}",
    { turnId: "p1" }
  );
  await controller.consumeExecutorTurn(
    "FAIL\n@M {\"v\":1,\"a\":\"report\",\"t\":\"T1\",\"i\":\"A1\",\"r\":\"R1\",\"s\":\"fail\"}",
    { turnId: "e1" }
  );
  await controller.consumePlannerTurn(
    "Fix this\n@M {\"v\":1,\"a\":\"reject\",\"t\":\"T1\",\"r\":\"R1\",\"i\":\"A2\"}",
    { turnId: "p2" }
  );
  assert.equal(calls.at(-1).pageId, "executor_pid");
  assert.equal(transport.snapshot().phase, BRIDGE_TRANSPORT_PHASES.WAIT_EXECUTOR);
});

test("impossible role phase fails closed before transport mutation", async () => {
  const { calls, controller } = fixture();
  await assert.rejects(
    () => controller.consumeExecutorTurn(
      "PASS\n@M {\"v\":1,\"a\":\"report\",\"t\":\"T1\",\"i\":\"A1\",\"r\":\"R1\",\"s\":\"pass\"}",
      { turnId: "e1" }
    ),
    (error) => error instanceof BridgeProtocolIntegrationError &&
      error.code === "IMPOSSIBLE_PHASE"
  );
  assert.equal(calls.length, 0);
});
