import test from "node:test";
import assert from "node:assert/strict";

import {
  BRIDGE_TRANSPORT_PHASES,
  BridgeTransportStateError,
  createPlannerExecutorBridgeTransportStateMachine
} from "../src/runtime/planner-executor-bridge-transport.mjs";

function binding({
  plannerPage = "planner_pid",
  executorPage = "executor_pid"
} = {}) {
  return {
    schema_version: "chatgpt-bridge-binding.v1",
    page_count: 2,
    exact_page_set: true,
    planner: {
      role: "planner",
      chat_url: "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",
      canonical_target: "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",
      page_id: plannerPage,
      page_url: "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",
      title: "Planner"
    },
    executor: {
      role: "executor",
      chat_url: "https://chatgpt.com/c/22222222-2222-2222-2222-222222222222",
      canonical_target: "https://chatgpt.com/c/22222222-2222-2222-2222-222222222222",
      page_id: executorPage,
      page_url: "https://chatgpt.com/c/22222222-2222-2222-2222-222222222222",
      title: "Executor"
    },
    unrelated_page_ids: []
  };
}

function adapterFixture() {
  const calls = [];
  return {
    calls,
    adapter: {
      async send(pageId, message, options) {
        calls.push({ pageId, message, options });
        return {
          ok: true,
          page_id: pageId,
          cmd_id: "cmd-" + calls.length,
          snapshot: { last_assistant: "reply-" + calls.length },
          evidence: { response_changed: true }
        };
      }
    }
  };
}

test("Bridge transport happy path is Planner -> Executor -> Planner -> next Executor", async () => {
  const fixture = adapterFixture();
  const machine = createPlannerExecutorBridgeTransportStateMachine({
    adapter: fixture.adapter,
    binding: binding()
  });

  assert.equal(machine.snapshot().phase, BRIDGE_TRANSPORT_PHASES.IDLE);
  machine.start();
  assert.equal(machine.snapshot().phase, BRIDGE_TRANSPORT_PHASES.BOOTSTRAP_PLANNER);
  machine.plannerBootstrapDispatched();
  assert.equal(machine.snapshot().phase, BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER);

  await machine.plannerEvent({ action: "assign", message: "task A001" });
  assert.equal(machine.snapshot().phase, BRIDGE_TRANSPORT_PHASES.WAIT_EXECUTOR);
  assert.equal(fixture.calls[0].pageId, "executor_pid");

  await machine.executorEvent({ action: "report", message: "result R001" });
  assert.equal(machine.snapshot().phase, BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER_DECISION);
  assert.equal(fixture.calls[1].pageId, "planner_pid");

  await machine.plannerEvent({
    action: "accept_assign",
    message: "task A002"
  });
  assert.equal(machine.snapshot().phase, BRIDGE_TRANSPORT_PHASES.WAIT_EXECUTOR);
  assert.equal(fixture.calls[2].pageId, "executor_pid");
  assert.deepEqual(
    fixture.calls.map((call) => call.pageId),
    ["executor_pid", "planner_pid", "executor_pid"]
  );
});

test("reject correction routes one bounded correction back to Executor", async () => {
  const fixture = adapterFixture();
  const machine = createPlannerExecutorBridgeTransportStateMachine({
    adapter: fixture.adapter,
    binding: binding()
  });
  machine.start();
  machine.plannerBootstrapDispatched();
  await machine.plannerEvent({ action: "assign", message: "task" });
  await machine.executorEvent({ action: "report", message: "failed result" });

  await machine.plannerEvent({
    action: "reject",
    message: "bounded correction"
  });

  assert.equal(machine.snapshot().phase, BRIDGE_TRANSPORT_PHASES.WAIT_EXECUTOR);
  assert.equal(fixture.calls.at(-1).pageId, "executor_pid");
});

test("blocked and done are terminal transport decisions without Bridge sends", async () => {
  const blockedFixture = adapterFixture();
  const blocked = createPlannerExecutorBridgeTransportStateMachine({
    adapter: blockedFixture.adapter,
    binding: binding()
  });
  blocked.start();
  blocked.plannerBootstrapDispatched();
  await blocked.plannerEvent({ action: "blocked" });
  assert.equal(blocked.snapshot().phase, BRIDGE_TRANSPORT_PHASES.BLOCKED);
  assert.equal(blockedFixture.calls.length, 0);

  blocked.resumePlanner();
  assert.equal(blocked.snapshot().phase, BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER);

  const doneFixture = adapterFixture();
  const done = createPlannerExecutorBridgeTransportStateMachine({
    adapter: doneFixture.adapter,
    binding: binding()
  });
  done.start();
  done.plannerBootstrapDispatched();
  await done.plannerEvent({ action: "done" });
  assert.equal(done.snapshot().phase, BRIDGE_TRANSPORT_PHASES.DONE);
  assert.equal(doneFixture.calls.length, 0);
});

test("invalid phase transitions fail closed before transport mutation", async () => {
  const fixture = adapterFixture();
  const machine = createPlannerExecutorBridgeTransportStateMachine({
    adapter: fixture.adapter,
    binding: binding()
  });

  await assert.rejects(
    () => machine.executorEvent({ action: "report", message: "nope" }),
    (error) => error instanceof BridgeTransportStateError && error.code === "INVALID_PHASE"
  );
  assert.equal(fixture.calls.length, 0);
});

test("ambiguous send failure blocks transport and prevents resendable progress", async () => {
  const adapter = {
    async send() {
      throw new Error("bridge unavailable");
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
  const snapshot = machine.snapshot();
  assert.equal(snapshot.phase, BRIDGE_TRANSPORT_PHASES.BLOCKED);
  assert.equal(snapshot.last_transport.status, "AMBIGUOUS_SEND_FAILURE");
  assert.equal(snapshot.last_transport.from_role, "planner");
  assert.equal(snapshot.last_transport.to_role, "executor");
});

test("binding reacquisition may replace page_id only when canonical role identity is unchanged", () => {
  const fixture = adapterFixture();
  const machine = createPlannerExecutorBridgeTransportStateMachine({
    adapter: fixture.adapter,
    binding: binding()
  });

  const rebound = binding({
    plannerPage: "planner_reloaded",
    executorPage: "executor_reloaded"
  });
  machine.replaceBinding(rebound);
  assert.equal(machine.snapshot().planner_page_id, "planner_reloaded");
  assert.equal(machine.snapshot().executor_page_id, "executor_reloaded");

  const changed = binding();
  changed.planner.canonical_target =
    "https://chatgpt.com/c/33333333-3333-3333-3333-333333333333";
  assert.throws(
    () => machine.replaceBinding(changed),
    (error) => error instanceof BridgeTransportStateError &&
      error.code === "ROLE_IDENTITY_CHANGED"
  );
});

test("transport state machine contains no project or protocol parser authority", async () => {
  const fixture = adapterFixture();
  const machine = createPlannerExecutorBridgeTransportStateMachine({
    adapter: fixture.adapter,
    binding: binding()
  });
  machine.start();
  machine.plannerBootstrapDispatched();

  await assert.rejects(
    () => machine.plannerEvent({ action: "unexpected_protocol_action", message: "x" }),
    (error) => error instanceof BridgeTransportStateError && error.code === "INVALID_EVENT"
  );
  assert.equal(fixture.calls.length, 0);
});
