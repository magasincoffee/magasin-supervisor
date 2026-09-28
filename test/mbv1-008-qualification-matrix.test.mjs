import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  ChatGptBridgeAdapter,
  bridgeResponseBaseline
} from "../src/runtime/chatgpt-bridge-adapter.mjs";
import {
  bindPlannerExecutorBridgePages,
  reacquirePlannerExecutorBridgePages
} from "../src/runtime/chatgpt-bridge-binding.mjs";
import {
  createPlannerExecutorBridgeTransportStateMachine,
  BRIDGE_TRANSPORT_PHASES
} from "../src/runtime/planner-executor-bridge-transport.mjs";
import {
  createPlannerExecutorBridgeProtocolController,
  BridgeProtocolIntegrationError
} from "../src/runtime/planner-executor-bridge-protocol.mjs";
import {
  buildBridgeProjectContextBootstrapMessage
} from "../src/runtime/planner-executor-bridge-bootstrap.mjs";
import {
  patchPinnedBridgeUserscript
} from "../src/runtime/chatgpt-bridge-page-runtime.mjs";

const PLANNER_URL = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const EXECUTOR_URL = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";

function page(page_id, url) {
  return {
    page_id,
    url,
    title: page_id,
    alive: true,
    is_generating: false,
    assistant_count: 0,
    last_msg: "",
    last_poll_ago: 0
  };
}

function binding({ planner = "planner", executor = "executor" } = {}) {
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

function protocolFixture() {
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
    strictProjectCorrelation: true,
    requirePlannerProgress: true,
    buildExecutorMessage: ({ body }) => body || "executor",
    buildPlannerMessage: ({ body }) => body || "planner"
  });
  return { calls, transport, controller };
}

test("MBV1-008/01 HAPPY_PATH_DONE", async () => {
  const { controller, transport } = protocolFixture();
  await controller.consumePlannerTurn(
    'Do T1\n@M {"v":1,"a":"assign","p":"LIVE","g":1,"t":"T1","i":"A1","pc":7,"pt":8}',
    { turnId: "p1" }
  );
  await controller.consumeExecutorTurn(
    'PASS\n@M {"v":1,"a":"report","p":"LIVE","g":1,"t":"T1","i":"A1","r":"R1","s":"pass"}',
    { turnId: "e1" }
  );
  await controller.consumePlannerTurn(
    '@M {"v":1,"a":"done","p":"LIVE","g":1,"t":"T1","r":"R1","pc":8,"pt":8}',
    { turnId: "p2" }
  );
  assert.equal(transport.snapshot().phase, BRIDGE_TRANSPORT_PHASES.DONE);
});

test("MBV1-008/02 FAIL_REJECT_CORRECTION_PASS_DONE", async () => {
  const { controller, transport } = protocolFixture();
  await controller.consumePlannerTurn(
    'Do T1\n@M {"v":1,"a":"assign","p":"LIVE","g":1,"t":"T1","i":"A1","pc":7,"pt":8}',
    { turnId: "p1" }
  );
  await controller.consumeExecutorTurn(
    'FAIL\n@M {"v":1,"a":"report","p":"LIVE","g":1,"t":"T1","i":"A1","r":"R1","s":"fail"}',
    { turnId: "e1" }
  );
  await controller.consumePlannerTurn(
    'Correct it\n@M {"v":1,"a":"reject","p":"LIVE","g":1,"t":"T1","r":"R1","i":"A2","pc":7,"pt":8}',
    { turnId: "p2" }
  );
  await controller.consumeExecutorTurn(
    'PASS\n@M {"v":1,"a":"report","p":"LIVE","g":1,"t":"T1","i":"A2","r":"R2","s":"pass"}',
    { turnId: "e2" }
  );
  await controller.consumePlannerTurn(
    '@M {"v":1,"a":"done","p":"LIVE","g":1,"t":"T1","r":"R2","pc":8,"pt":8}',
    { turnId: "p3" }
  );
  assert.equal(transport.snapshot().phase, BRIDGE_TRANSPORT_PHASES.DONE);
});

test("MBV1-008/03 BLOCKED", async () => {
  const { controller, transport } = protocolFixture();
  await controller.consumePlannerTurn(
    '@M {"v":1,"a":"blocked","p":"LIVE","g":1,"pc":7,"pt":8}',
    { turnId: "p1" }
  );
  assert.equal(transport.snapshot().phase, BRIDGE_TRANSPORT_PHASES.BLOCKED);
});

test("MBV1-008/04 DUPLICATE_MACHINE_FRAME", async () => {
  const { controller } = protocolFixture();
  const text = 'Do\n@M {"v":1,"a":"assign","p":"LIVE","g":1,"t":"T1","i":"A1","pc":7,"pt":8}';
  await controller.consumePlannerTurn(text, { turnId: "p1" });
  await assert.rejects(
    () => controller.consumePlannerTurn(text, { turnId: "p1" }),
    (error) => error instanceof BridgeProtocolIntegrationError &&
      error.code === "DUPLICATE_TURN"
  );
});

test("MBV1-008/05 STALE_RESULT_ID", async () => {
  const { controller } = protocolFixture();
  await controller.consumePlannerTurn(
    'Do\n@M {"v":1,"a":"assign","p":"LIVE","g":1,"t":"T1","i":"A1","pc":7,"pt":8}',
    { turnId: "p1" }
  );
  await controller.consumeExecutorTurn(
    'PASS\n@M {"v":1,"a":"report","p":"LIVE","g":1,"t":"T1","i":"A1","r":"R1","s":"pass"}',
    { turnId: "e1" }
  );
  await assert.rejects(
    () => controller.consumePlannerTurn(
      '@M {"v":1,"a":"done","p":"LIVE","g":1,"t":"T1","r":"STALE","pc":8,"pt":8}',
      { turnId: "p2" }
    ),
    (error) => error instanceof BridgeProtocolIntegrationError &&
      error.code === "FRAME_CORRELATION_MISMATCH"
  );
});

test("MBV1-008/06 WRONG_ASSIGNMENT_ID", async () => {
  const { controller } = protocolFixture();
  await controller.consumePlannerTurn(
    'Do\n@M {"v":1,"a":"assign","p":"LIVE","g":1,"t":"T1","i":"A1","pc":7,"pt":8}',
    { turnId: "p1" }
  );
  await assert.rejects(
    () => controller.consumeExecutorTurn(
      'PASS\n@M {"v":1,"a":"report","p":"LIVE","g":1,"t":"T1","i":"WRONG","r":"R1","s":"pass"}',
      { turnId: "e1" }
    ),
    (error) => error instanceof BridgeProtocolIntegrationError &&
      error.code === "FRAME_CORRELATION_MISMATCH"
  );
});

test("MBV1-008/07 PLANNER_RELOAD", async () => {
  const first = await bindPlannerExecutorBridgePages({
    async listPages() {
      return [page("planner_old", PLANNER_URL), page("executor", EXECUTOR_URL)];
    }
  }, { plannerUrl: PLANNER_URL, executorUrl: EXECUTOR_URL });

  const next = await reacquirePlannerExecutorBridgePages({
    async listPages() {
      return [page("planner_new", PLANNER_URL), page("executor", EXECUTOR_URL)];
    }
  }, first);

  assert.equal(next.reacquired.planner, true);
  assert.equal(next.planner.page_id, "planner_new");
});

test("MBV1-008/08 EXECUTOR_RELOAD", async () => {
  const first = await bindPlannerExecutorBridgePages({
    async listPages() {
      return [page("planner", PLANNER_URL), page("executor_old", EXECUTOR_URL)];
    }
  }, { plannerUrl: PLANNER_URL, executorUrl: EXECUTOR_URL });

  const next = await reacquirePlannerExecutorBridgePages({
    async listPages() {
      return [page("planner", PLANNER_URL), page("executor_new", EXECUTOR_URL)];
    }
  }, first);

  assert.equal(next.reacquired.executor, true);
  assert.equal(next.executor.page_id, "executor_new");
});

test("MBV1-008/09 BRIDGE_RESTART", async () => {
  let calls = 0;
  let sends = 0;
  const adapter = {
    async listPages() {
      calls += 1;
      if (calls < 3) {
        const error = new Error("restart");
        error.code = "BRIDGE_UNREACHABLE";
        throw error;
      }
      return [page("planner_new", PLANNER_URL), page("executor_new", EXECUTOR_URL)];
    },
    async send() {
      sends += 1;
      return { ok: true };
    }
  };
  const machine = createPlannerExecutorBridgeTransportStateMachine({
    adapter,
    binding: binding(),
    reacquireAttempts: 3,
    reacquireBackoffMs: 1,
    sleepImpl: async () => {}
  });
  const result = await machine.recoverBinding();
  assert.equal(result.recovery.attempt, 3);
  assert.equal(sends, 0);
});

test("MBV1-008/10 RESET_ROBOT preserves transport infrastructure selector", async () => {
  const panel = await fs.readFile(
    new URL("../windows/control-panel.ps1", import.meta.url),
    "utf8"
  );
  const start = panel.indexOf("function Reset-LinkOnlyPlannerExecutorSession");
  assert.ok(start >= 0);
  const end = panel.indexOf("function New-ProjectContextBootstrap", start);
  const body = panel.slice(start, end);
  assert.equal(body.includes("planner-executor-transport.json"), false);
  assert.match(body, /New-LinkOnlyPlannerExecutorShell/);
});

test("MBV1-008/11 NEW_SOURCE_OF_TRUTH_SESSION", () => {
  const first = buildBridgeProjectContextBootstrapMessage({
    sourceOfTruthUrl: "https://example.com/project-a.md",
    projectId: "LIVE",
    projectGeneration: 1
  });
  const second = buildBridgeProjectContextBootstrapMessage({
    sourceOfTruthUrl: "https://example.com/project-b.md",
    projectId: "LIVE",
    projectGeneration: 1
  });
  assert.notEqual(first, second);
  assert.match(second, /source_of_truth=https:\/\/example\.com\/project-b\.md/);
  assert.match(second, /project_generation=1/);
});

test("MBV1-008/12 LONG_GENERATION_NO_PREMATURE_PARSE", async () => {
  const snapshots = [
    { count: 4, generating: true, assistant: "partial" },
    { count: 4, generating: true, assistant: "still partial" },
    { count: 4, generating: false, assistant: "final @M frame" }
  ];
  let index = 0;
  let now = 0;
  const adapter = new ChatGptBridgeAdapter({
    nowImpl: () => now,
    sleepImpl: async (ms) => { now += ms; },
    fetchImpl: async () => {
      const value = snapshots[Math.min(index++, snapshots.length - 1)];
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            site: "chatgpt",
            url: PLANNER_URL,
            title: "Planner",
            hasEditor: true,
            editorText: "",
            assistantCount: value.count,
            isGenerating: value.generating,
            recentTurns: [{ role: "assistant", text: value.assistant }],
            lastAssistant: value.assistant
          });
        }
      };
    }
  });
  const baseline = {
    page_id: "planner",
    ...bridgeResponseBaseline({
      site: "chatgpt",
      url: PLANNER_URL,
      title: "Planner",
      has_editor: true,
      editor_text: "",
      assistant_count: 3,
      is_generating: false,
      recent_turns: [{ role: "assistant", text: "old" }],
      last_assistant: "old"
    })
  };
  const result = await adapter.waitResponse("planner", baseline, {
    timeoutMs: 1000,
    pollIntervalMs: 10
  });
  assert.equal(result.snapshot.is_generating, false);
  assert.equal(result.snapshot.last_assistant, "final @M frame");
});

test("MBV1-008 cutover wiring is explicit and rollback-safe", async () => {
  const [wrapper, installer, selector, bridgeCli] = await Promise.all([
    fs.readFile(new URL("../windows/run-supervisor.ps1", import.meta.url), "utf8"),
    fs.readFile(new URL("../windows/install-supervisor.ps1", import.meta.url), "utf8"),
    fs.readFile(new URL("../windows/set-planner-executor-transport.ps1", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/runtime/planner-executor-bridge-cli.mjs", import.meta.url), "utf8")
  ]);

  assert.match(wrapper, /planner-executor-bridge-cli\.mjs/);
  assert.match(wrapper, /DIRECT_DOM_V1/);
  assert.match(wrapper, /CHATGPT_BRIDGE_V1/);
  assert.match(installer, /Install-ChatGptBridgeRuntime/);
  assert.match(selector, /fallback = 'DIRECT_DOM_V1'/);
  assert.match(bridgeCli, /runPlannerExecutorStep/);
  assert.equal(bridgeCli.includes("sendComposerInstruction"), false);
  assert.match(bridgeCli, /bridge-new-assistant-response-observed/);
});

test("MBV1-008 userscript patch preserves upstream Bridge and widens evidence plus send-control compatibility", () => {
  const patched = patchPinnedBridgeUserscript(
    "// ChatGPT Bridge\n" +
    "const x = a.slice(-600); const y = b.slice(-1000); const z = c.slice(0, 200);\n" +
    "const sendBtns = ['button[data-testid=\"send-button\"]', 'button[aria-label=\"发送\"]', 'button[aria-label=\"Send\"]', 'form button[type=\"submit\"]'];"
  );
  assert.match(patched, /MAGASIN_BRIDGE_USERSCRIPT_PATCH_V1/);
  assert.match(patched, /slice\(-12000\)/);
  assert.match(patched, /slice\(-20000\)/);
  assert.match(patched, /slice\(0, 12000\)/);
  assert.match(patched, /composer-submit-button/);
  assert.match(patched, /composer-send-button/);
  assert.match(patched, /aria-label\*="Send" i/);
});


test("MBV1-008 userscript patch observes current ChatGPT message DOM", () => {
  const patched = patchPinnedBridgeUserscript(
    "// ChatGPT Bridge\n" +
    "  function countAssistant() {\n" +
    "    return document.querySelectorAll('[data-message-author-role=\\\"assistant\\\"]').length;\n" +
    "  }\n"
  );
  assert.match(patched, /chatGptMessageRecords/);
  assert.match(patched, /text-size-chat\.whitespace-pre-wrap/);
  assert.match(patched, /MarkdownRoot-/);
  assert.match(
    patched,
    /chatGptMessageRecords\(\)\.filter\(\(item\) => item\.role === 'assistant'\)\.length/
  );
});
