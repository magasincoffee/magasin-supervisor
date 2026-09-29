import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  buildSingleConversationTaskDiscoveryInstruction,
  buildSingleConversationTaskInstruction,
  parseTaskControl
} from "../src/runtime/single-conversation-loop.mjs";
import { opaqueRuntimeIdentity } from "../src/runtime/single-conversation-bootstrap.mjs";
import { resumeExistingConversationPage } from "../src/runtime/single-conversation-cli.mjs";

test("SC-011 parses authoritative READY task id", () => {
  const parsed = parseTaskControl(`
some explanation
MAGASIN_TASK_CONTROL_V1
STATUS=READY
TASK_ID=NONE
NEXT_TASK_ID=OPS-004-007
CHECK_AFTER_SECONDS=0
END_MAGASIN_TASK_CONTROL_V1
MAGASIN_CYCLE_CORRELATION_V1 demo
`);
  assert.deepEqual(parsed, {
    status: "READY",
    task_id: null,
    next_task_id: "OPS-004-007",
    check_after_seconds: 0
  });
});

test("SC-011 RUNNING keeps the same task and bounded check delay", () => {
  const parsed = parseTaskControl(`
MAGASIN_TASK_CONTROL_V1
STATUS=RUNNING
TASK_ID=E2E-030
NEXT_TASK_ID=NONE
CHECK_AFTER_SECONDS=300
END_MAGASIN_TASK_CONTROL_V1
`);
  assert.equal(parsed.status, "RUNNING");
  assert.equal(parsed.task_id, "E2E-030");
  assert.equal(parsed.next_task_id, null);
  assert.equal(parsed.check_after_seconds, 300);
});

test("SC-011 rejects free text and repeated COMPLETE id", () => {
  assert.throws(
    () => parseTaskControl("BLOCKED is mentioned only in prose"),
    (error) => error?.code === "TASK_PROTOCOL_INVALID"
  );
  assert.throws(
    () => parseTaskControl(`
MAGASIN_TASK_CONTROL_V1
STATUS=COMPLETE
TASK_ID=SC011-003
NEXT_TASK_ID=SC011-003
CHECK_AFTER_SECONDS=0
END_MAGASIN_TASK_CONTROL_V1
`),
    (error) => error?.code === "TASK_PROTOCOL_INVALID"
  );
});

test("SC-011 task messages execute or check one exact id", () => {
  const execute = buildSingleConversationTaskInstruction({
    sourceOfTruthUrl: "https://example.com/SOURCE_OF_TRUTH.md",
    taskId: "OPS-004-007",
    messageId: "m1"
  });
  assert.match(execute, /MAGASIN_EXECUTE_TASK_V1/);
  assert.match(execute, /TASK_ID=OPS-004-007/);
  assert.match(execute, /execute this task now/i);
  assert.match(execute, /STATUS=RUNNING/);
  assert.match(execute, /durable external job\/run/i);

  const check = buildSingleConversationTaskInstruction({
    sourceOfTruthUrl: "https://example.com/SOURCE_OF_TRUTH.md",
    taskId: "OPS-004-007",
    messageId: "m2",
    checkOnly: true
  });
  assert.match(check, /MAGASIN_CHECK_TASK_V1/);
  assert.match(check, /same TASK_ID/i);

  const discover = buildSingleConversationTaskDiscoveryInstruction({
    sourceOfTruthUrl: "https://example.com/SOURCE_OF_TRUTH.md",
    messageId: "m3"
  });
  assert.match(discover, /Do not execute project work in this turn/);
  assert.match(discover, /NEXT_TASK_ID/);
});

test("SC-011 restart rebinds exactly one verified existing conversation", async () => {
  const page = {
    isClosed: () => false,
    url: () => "https://chatgpt.com/c/abc123"
  };
  const other = {
    isClosed: () => false,
    url: () => "https://chatgpt.com/"
  };
  let selected = null;
  const adapter = {
    getChatGptPages: () => [other, page],
    setActivePage: (value) => {
      selected = value;
      return value;
    },
    probePage: async () => ({
      snapshot: {
        composerReady: true,
        loginRequired: false,
        hasCaptcha: false,
        conversationMissing: false,
        conversationAccessDenied: false
      }
    })
  };
  const state = {
    conversation: {
      status: "ACTIVE",
      generation: 4,
      runtime_id: opaqueRuntimeIdentity(page.url())
    },
    outbound: { state: "VERIFIED" }
  };

  const rebound = await resumeExistingConversationPage({ adapter, state });
  assert.equal(rebound?.page, page);
  assert.equal(rebound?.generation, 4);
  assert.equal(selected, page);

  const unsafe = structuredClone(state);
  unsafe.outbound.state = "ENQUEUED";
  assert.equal(
    await resumeExistingConversationPage({ adapter, state: unsafe }),
    null
  );
});

test("SC-011 production CLI pauses terminal/protocol states and allows long responses", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /responseTimeoutMs: 5_400_000/);
  assert.match(source, /\["DONE", "WAIT_OWNER"\]\.includes\(result\.status\)/);
  assert.match(source, /code === "TASK_PROTOCOL_INVALID"[\s\S]*\? 76/);
  assert.doesNotMatch(source, /terminalAnswer\(response\.assistant_turn/);
});


test("SC-011 long response polling uses native timers instead of page RPC sleeps", async () => {
  const loop = await fs.readFile(
    new URL("../src/runtime/single-conversation-loop.mjs", import.meta.url),
    "utf8"
  );
  const bootstrap = await fs.readFile(
    new URL("../src/runtime/single-conversation-bootstrap.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(loop, /page\.waitForTimeout\(pollMs\)/);
  assert.doesNotMatch(bootstrap, /page\.waitForTimeout\(pollMs\)/);
});
