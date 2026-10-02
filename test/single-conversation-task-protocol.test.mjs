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


test("SC-011 restart recovers the exact conversation from recent sidebar after Chrome restart", async () => {
  const targetUrl = "https://chatgpt.com/c/recover-me";
  const home = {
    isClosed: () => false,
    url: () => "https://chatgpt.com/"
  };
  const recoveredPage = {
    isClosed: () => false,
    url: () => targetUrl
  };

  let reopenedUrl = null;
  let selected = null;
  let closedHome = false;
  const adapter = {
    getChatGptPages: () => [home],
    getActivePage: () => home,
    listRecentConversationUrls: async () => [
      "https://chatgpt.com/c/other",
      targetUrl
    ],
    reopenTargetPage: async (url) => {
      reopenedUrl = url;
      return recoveredPage;
    },
    setActivePage: (page) => {
      selected = page;
      return page;
    },
    closePage: async (page) => {
      if (page === home) closedHome = true;
      return true;
    },
    probePage: async () => ({
      snapshot: {
        composerReady: true,
        loginRequired: false,
        hasCaptcha: false,
        conversationMissing: false,
        conversationAccessDenied: false,
        pageClosed: false
      }
    })
  };
  const state = {
    conversation: {
      status: "ACTIVE",
      generation: 9,
      runtime_id: opaqueRuntimeIdentity(targetUrl)
    },
    outbound: { state: "RESPONSE_COMPLETE" }
  };

  const rebound = await resumeExistingConversationPage({ adapter, state });
  assert.equal(reopenedUrl, targetUrl);
  assert.equal(rebound?.page, recoveredPage);
  assert.equal(rebound?.generation, 9);
  assert.equal(rebound?.runtime_id, state.conversation.runtime_id);
  assert.equal(rebound?.recovered_from, "RECENT_SIDEBAR");
  assert.equal(selected, recoveredPage);
  assert.equal(closedHome, true);
});

test("SC-011 restart does not replace chat when recent sidebar has no matching runtime identity", async () => {
  const home = {
    isClosed: () => false,
    url: () => "https://chatgpt.com/"
  };
  let reopenCalls = 0;
  const adapter = {
    getChatGptPages: () => [home],
    getActivePage: () => home,
    listRecentConversationUrls: async () => [
      "https://chatgpt.com/c/not-the-target"
    ],
    reopenTargetPage: async () => {
      reopenCalls += 1;
      return null;
    }
  };
  const state = {
    conversation: {
      status: "ACTIVE",
      generation: 9,
      runtime_id: opaqueRuntimeIdentity("https://chatgpt.com/c/missing-target")
    },
    outbound: { state: "VERIFIED" }
  };

  const rebound = await resumeExistingConversationPage({
    adapter,
    state,
    recoveryRetries: 1,
    recoveryPollMs: 0
  });
  assert.equal(rebound, null);
  assert.equal(reopenCalls, 0);
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


test("SC-011 restart identity uncertainty stays fail closed outside the SC-013 proven pre-actuation exception", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const startup = source.slice(
    source.indexOf("export async function runSingleConversationRuntime"),
    source.indexOf("let cycles = 0;")
  );

  assert.match(startup, /RUNTIME_RESTART_IDENTITY_NOT_VERIFIED/);
  assert.match(startup, /const pendingPreActuation = canResumePreActuationDiscovery\(current\)/);
  assert.match(
    startup,
    /else if \(pendingPreActuation\)[\s\S]*RUNTIME_RESTART_IDENTITY_NOT_VERIFIED_PRE_ACTUATION/
  );
  assert.match(
    startup,
    /replaceDisposableConversation\([\s\S]*RUNTIME_RESTART_IDENTITY_NOT_VERIFIED_PRE_ACTUATION/
  );

  const fallbackStart = startup.indexOf(
    "// Restart continuity remains fail closed for every case without positive"
  );
  assert.ok(fallbackStart >= 0);
  const fallback = startup.slice(fallbackStart);
  assert.match(fallback, /fail closed/i);
  assert.match(fallback, /code: "RUNTIME_RESTART_IDENTITY_NOT_VERIFIED"/);
  assert.doesNotMatch(fallback, /replaceDisposableConversation/);
});


test("SC-013 parses READY control when ChatGPT DOM collapses visible line breaks to whitespace", () => {
  const parsed = parseTaskControl(
    "Theo SOT hien tai, SCHED-UI-006 la task duy nhat READY. " +
    "MAGASIN_TASK_CONTROL_V1 " +
    "STATUS=READY TASK_ID=NONE NEXT_TASK_ID=SCHED-UI-006 CHECK_AFTER_SECONDS=0 " +
    "END_MAGASIN_TASK_CONTROL_V1 " +
    "MAGASIN_CYCLE_CORRELATION_V1 5f02196a-d9b6-40fd-a30f-3719fd45409a"
  );

  assert.deepEqual(parsed, {
    status: "READY",
    task_id: null,
    next_task_id: "SCHED-UI-006",
    check_after_seconds: 0
  });
});

test("SC-013 rendered-whitespace fallback rejects prose inside the machine block", () => {
  assert.throws(
    () => parseTaskControl(
      "MAGASIN_TASK_CONTROL_V1 STATUS=READY unexpected-prose " +
      "TASK_ID=NONE NEXT_TASK_ID=SCHED-UI-006 CHECK_AFTER_SECONDS=0 " +
      "END_MAGASIN_TASK_CONTROL_V1"
    ),
    (error) => error?.code === "TASK_PROTOCOL_INVALID"
  );
});
