import test from "node:test";
import assert from "node:assert/strict";

import {
  BridgeProjectBootstrapError,
  buildBridgeProjectContextBootstrapMessage,
  classifyBridgeBootstrapSnapshot,
  startBridgeLinkOnlyProjectSession
} from "../src/runtime/planner-executor-bridge-bootstrap.mjs";
import {
  BRIDGE_TRANSPORT_PHASES
} from "../src/runtime/planner-executor-bridge-transport.mjs";
import {
  BridgeProtocolIntegrationError
} from "../src/runtime/planner-executor-bridge-protocol.mjs";

function adapterFixture() {
  const calls = [];
  const pages = [
    {
      page_id: "planner_pid",
      title: "Planner",
      url: "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",
      alive: true,
      is_generating: false
    },
    {
      page_id: "executor_pid",
      title: "Executor",
      url: "https://chatgpt.com/c/22222222-2222-2222-2222-222222222222",
      alive: true,
      is_generating: false
    }
  ];
  return {
    calls,
    adapter: {
      async listPages() { return pages; },
      async getSnapshot(pageId) {
        const page = pages.find(p => p.page_id === pageId);
        return {
          site: "chatgpt",
          url: page.url,
          title: page.title,
          has_editor: true,
          editor_text: "",
          assistant_count: 0,
          is_generating: false,
          recent_turns: [],
          last_assistant: ""
        };
      },
      async send(pageId, message) {
        calls.push({ pageId, message });
        return { ok: true, page_id: pageId, cmd_id: "cmd-" + calls.length };
      }
    }
  };
}

const inputs = {
  sourceOfTruthUrl: "https://github.com/magasincoffee/magasin-supervisor/blob/main/docs/SUPERVISOR_PLANNER_EXECUTOR_V1_SOURCE_OF_TRUTH.md",
  plannerUrl: "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",
  executorUrl: "https://chatgpt.com/c/22222222-2222-2222-2222-222222222222"
};

test("Bridge bootstrap message is link-only, Source-of-Truth anchored, and mention-safe", () => {
  const message = buildBridgeProjectContextBootstrapMessage(inputs);
  assert.match(message, /MAGASIN_PROJECT_BOOTSTRAP_V1/);
  assert.match(message, /project_id=LIVE/);
  assert.match(message, /project_generation=1/);
  assert.match(message, /source_of_truth=https:\/\/github\.com\//);
  assert.match(message, /<AT>M/);
  assert.equal(message.includes("\n@M "), false);
});

test("link-only START binds exact roles and bootstraps Planner only", async () => {
  const fixture = adapterFixture();
  const session = await startBridgeLinkOnlyProjectSession(
    fixture.adapter,
    inputs
  );

  assert.equal(session.mode, "LINK_ONLY_EPHEMERAL");
  assert.equal(session.binding.planner.page_id, "planner_pid");
  assert.equal(session.binding.executor.page_id, "executor_pid");
  assert.equal(
    session.transport.snapshot().phase,
    BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER
  );
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].pageId, "planner_pid");
  assert.match(fixture.calls[0].message, /MAGASIN_PROJECT_BOOTSTRAP_V1/);
});

test("first Planner assignment must include strict p/g and Source-of-Truth pc/pt", async () => {
  const fixture = adapterFixture();
  const session = await startBridgeLinkOnlyProjectSession(
    fixture.adapter,
    inputs
  );

  await session.protocol.consumePlannerTurn(
    [
      "Execute next task",
      '@M {"v":1,"a":"assign","p":"LIVE","g":1,"t":"MBV1-007","i":"A001","pc":5,"pt":8}'
    ].join("\n"),
    { turnId: "planner-turn-1" }
  );

  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[1].pageId, "executor_pid");
  const snapshot = session.protocol.snapshot();
  assert.equal(snapshot.project_completed_tasks, 5);
  assert.equal(snapshot.project_total_tasks, 8);
  assert.equal(snapshot.current_task_id, "MBV1-007");
});

test("Planner frame missing pc/pt fails closed before Executor send", async () => {
  const fixture = adapterFixture();
  const session = await startBridgeLinkOnlyProjectSession(
    fixture.adapter,
    inputs
  );

  await assert.rejects(
    () => session.protocol.consumePlannerTurn(
      [
        "Execute next task",
        '@M {"v":1,"a":"assign","p":"LIVE","g":1,"t":"T1","i":"A1"}'
      ].join("\n"),
      { turnId: "planner-turn-1" }
    ),
    (error) => error instanceof BridgeProtocolIntegrationError &&
      error.code === "PROJECT_PROGRESS_REQUIRED"
  );
  assert.equal(fixture.calls.length, 1);
});

test("wrong project generation fails closed before Executor send", async () => {
  const fixture = adapterFixture();
  const session = await startBridgeLinkOnlyProjectSession(
    fixture.adapter,
    inputs
  );

  await assert.rejects(
    () => session.protocol.consumePlannerTurn(
      [
        "Execute next task",
        '@M {"v":1,"a":"assign","p":"LIVE","g":2,"t":"T1","i":"A1","pc":0,"pt":1}'
      ].join("\n"),
      { turnId: "planner-turn-1" }
    ),
    (error) => error instanceof BridgeProtocolIntegrationError &&
      error.code === "PROJECT_CORRELATION_MISMATCH"
  );
  assert.equal(fixture.calls.length, 1);
});

test("Planner done with pc=pt ends session without Executor send", async () => {
  const fixture = adapterFixture();
  const session = await startBridgeLinkOnlyProjectSession(
    fixture.adapter,
    inputs
  );

  await session.protocol.consumePlannerTurn(
    '@M {"v":1,"a":"done","p":"LIVE","g":1,"pc":8,"pt":8}',
    { turnId: "planner-turn-1" }
  );
  assert.equal(
    session.transport.snapshot().phase,
    BRIDGE_TRANSPORT_PHASES.DONE
  );
  assert.equal(fixture.calls.length, 1);
  assert.equal(session.protocol.snapshot().project_completed_tasks, 8);
});

test("non-HTTPS Source of Truth is rejected before Bridge mutation", async () => {
  const fixture = adapterFixture();
  await assert.rejects(
    () => startBridgeLinkOnlyProjectSession(fixture.adapter, {
      ...inputs,
      sourceOfTruthUrl: "http://example.test/source.md"
    }),
    (error) => error instanceof BridgeProjectBootstrapError &&
      error.code === "INVALID_SOURCE_OF_TRUTH_URL"
  );
  assert.equal(fixture.calls.length, 0);
});

test("ambiguous bootstrap send does not enter WAIT_PLANNER or retry automatically", async () => {
  const fixture = adapterFixture();
  fixture.adapter.send = async (pageId, message) => {
    fixture.calls.push({ pageId, message });
    throw new Error("timeout after enqueue");
  };

  await assert.rejects(
    () => startBridgeLinkOnlyProjectSession(fixture.adapter, inputs),
    (error) => error instanceof BridgeProjectBootstrapError &&
      error.code === "BOOTSTRAP_SEND_AMBIGUOUS"
  );
  assert.equal(fixture.calls.length, 1);
});


test("ambiguous bootstrap restart reconciles only exact user turn followed by assistant", () => {
  const message = buildBridgeProjectContextBootstrapMessage(inputs);
  const digest = (value) => {
    let h = 2166136261;
    for (const ch of String(value || "")) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    return String(h >>> 0);
  };
  const expected = digest(message);

  const confirmed = classifyBridgeBootstrapSnapshot({
    is_generating: false,
    recent_turns: [
      { role: "assistant", text: "older" },
      { role: "user", text: message },
      { role: "assistant", text: "new planner response" }
    ]
  }, expected, digest);
  assert.equal(confirmed.state, "CONFIRMED_RESPONSE");

  const noResponse = classifyBridgeBootstrapSnapshot({
    is_generating: false,
    recent_turns: [
      { role: "user", text: message }
    ]
  }, expected, digest);
  assert.equal(noResponse.state, "MATCHING_USER_NO_RESPONSE");

  const missing = classifyBridgeBootstrapSnapshot({
    is_generating: false,
    recent_turns: [
      { role: "user", text: "different message" },
      { role: "assistant", text: "response" }
    ]
  }, expected, digest);
  assert.equal(missing.state, "NO_MATCHING_USER_TURN");
});
