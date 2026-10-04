import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildSingleConversationTaskDiscoveryInstruction,
  buildSingleConversationTaskInstruction,
  parseTaskControl
} from "../src/runtime/single-conversation-loop.mjs";
import { opaqueRuntimeIdentity } from "../src/runtime/single-conversation-bootstrap.mjs";
import {
  canRebindEnqueuedTaskDiscovery,
  clearTaskRecheckWait,
  persistTaskRecheckWait,
  resumeExistingConversationPage,
  runSingleConversationRuntime
} from "../src/runtime/single-conversation-cli.mjs";
import {
  ensureSingleConversationState,
  readSingleConversationState
} from "../src/runtime/single-conversation-state.mjs";

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

test("Owner countdown metadata persists while a RUNNING task waits for recheck", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc013-owner-countdown-"));
  const statePath = path.join(dir, "single-conversation-state.json");
  try {
    await ensureSingleConversationState(statePath, {
      sourceOfTruthUrl: "https://example.com/source",
      sessionId: "countdown-session",
      now: () => "2026-10-03T14:00:00.000Z"
    });

    await persistTaskRecheckWait(statePath, {
      taskId: "SCHED-UI-016",
      seconds: 190,
      now: () => "2026-10-03T14:00:10.000Z"
    });

    let state = await readSingleConversationState(statePath);
    assert.equal(state.automation.status, "RUNNING");
    assert.equal(state.automation.phase, "WAIT_TASK_RECHECK");
    assert.equal(state.automation.wait_kind, "TASK_RECHECK");
    assert.equal(state.automation.wait_task_id, "SCHED-UI-016");
    assert.equal(state.automation.wait_seconds_total, 190);
    assert.equal(state.automation.wait_started_at, "2026-10-03T14:00:10.000Z");
    assert.equal(state.automation.wait_until, "2026-10-03T14:03:20.000Z");
    assert.match(state.automation.wait_label, /SCHED-UI-016/);

    await clearTaskRecheckWait(statePath, {
      now: () => "2026-10-03T14:03:20.000Z"
    });
    state = await readSingleConversationState(statePath);
    assert.equal(state.automation.phase, "NEXT_WORK");
    assert.equal(state.automation.wait_kind, null);
    assert.equal(state.automation.wait_until, null);
    assert.equal(state.automation.wait_seconds_total, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SC-013 pre-bootstrap CDP startup failure is recoverable and visible", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc013-startup-"));
  const statePath = path.join(dir, "single-conversation-state.json");
  const adapter = {
    open: async () => {
      throw new Error("connectOverCDP socket hang up");
    },
    getActivePage: () => null
  };

  await assert.rejects(
    runSingleConversationRuntime({
      adapter,
      statePath,
      sourceOfTruthUrl: "https://example.com/SOURCE_OF_TRUTH.md",
      execute: true
    }),
    (error) =>
      error?.code === "CDP_RECOVERY_REQUIRED" &&
      error?.runtime_stage === "RUNTIME_OPEN_CDP"
  );

  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(state.automation.status, "RUNNING");
  assert.equal(state.automation.phase, "CDP_RECOVERY_REQUIRED");
  assert.equal(state.automation.reason, "CDP_RECOVERY_REQUIRED");
  assert.equal(state.outbound.last_error_code, "CDP_RECOVERY_REQUIRED");
  assert.equal(state.outbound.last_error_stage, "RUNTIME_OPEN_CDP");
});

test("SC-013 non-CDP startup failure records an exact pre-bootstrap stage", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc013-startup-hard-"));
  const statePath = path.join(dir, "single-conversation-state.json");
  const adapter = {
    open: async () => {
      throw new Error("unexpected startup contract failure");
    },
    getActivePage: () => null
  };

  await assert.rejects(
    runSingleConversationRuntime({
      adapter,
      statePath,
      sourceOfTruthUrl: "https://example.com/SOURCE_OF_TRUTH.md",
      execute: true
    }),
    /unexpected startup contract failure/
  );

  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(state.automation.status, "BLOCKED");
  assert.equal(state.automation.phase, "BOOTSTRAP_FAILED");
  assert.equal(state.automation.reason, "RUNTIME_START_FAILED");
  assert.equal(state.outbound.last_error_code, "RUNTIME_START_FAILED");
  assert.equal(state.outbound.last_error_stage, "RUNTIME_OPEN_CDP");
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

test("SC-013 parses OPS-074 discovery control when rendered DOM adds spaces around equals", () => {
  const parsed = parseTaskControl(
    "MAGASIN_TASK_CONTROL_V1 " +
    "STATUS = READY TASK_ID = NONE NEXT_TASK_ID = OPS-074 CHECK_AFTER_SECONDS = 0 " +
    "END_MAGASIN_TASK_CONTROL_V1 " +
    "MAGASIN_CYCLE_CORRELATION_V1 8903ab33-5938-48f0-9297-25a4c9d76113"
  );

  assert.deepEqual(parsed, {
    status: "READY",
    task_id: null,
    next_task_id: "OPS-074",
    check_after_seconds: 0
  });
});

test("SC-013 newline task-control parser tolerates presentation spaces around equals", () => {
  const parsed = parseTaskControl(
    "MAGASIN_TASK_CONTROL_V1\n" +
    "STATUS = READY\n" +
    "TASK_ID = NONE\n" +
    "NEXT_TASK_ID = OPS-074\n" +
    "CHECK_AFTER_SECONDS = 0\n" +
    "END_MAGASIN_TASK_CONTROL_V1"
  );

  assert.deepEqual(parsed, {
    status: "READY",
    task_id: null,
    next_task_id: "OPS-074",
    check_after_seconds: 0
  });
});

test("SC-013 rendered equals tolerance still rejects prose or extra fields", () => {
  assert.throws(
    () => parseTaskControl(
      "MAGASIN_TASK_CONTROL_V1 " +
      "STATUS = READY unexpected-prose TASK_ID = NONE " +
      "NEXT_TASK_ID = OPS-074 CHECK_AFTER_SECONDS = 0 " +
      "END_MAGASIN_TASK_CONTROL_V1"
    ),
    (error) => error?.code === "TASK_PROTOCOL_INVALID"
  );

  assert.throws(
    () => parseTaskControl(
      "MAGASIN_TASK_CONTROL_V1 " +
      "STATUS = READY TASK_ID = NONE EXTRA = X " +
      "NEXT_TASK_ID = OPS-074 CHECK_AFTER_SECONDS = 0 " +
      "END_MAGASIN_TASK_CONTROL_V1"
    ),
    (error) => error?.code === "TASK_PROTOCOL_INVALID"
  );
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


test("SC-013 restart permits exact identity rebind for ENQUEUED discovery after SEND_NOT_ACTUATED", async () => {
  const targetUrl = "https://chatgpt.com/c/discovery-rebind";
  const home = {
    isClosed: () => false,
    url: () => "https://chatgpt.com/"
  };
  const recoveredPage = {
    isClosed: () => false,
    url: () => targetUrl
  };
  let reopenedUrl = null;
  const state = {
    conversation: {
      status: "ACTIVE",
      generation: 1,
      runtime_id: opaqueRuntimeIdentity(targetUrl)
    },
    outbound: {
      state: "ENQUEUED",
      kind: "SOURCE_OF_TRUTH_TASK_DISCOVERY",
      message_id: "3f968d68-bab1-46c5-9d25-d77de7524ad2",
      message_digest: "a".repeat(64),
      retry_count: 0,
      last_error_code: "SEND_NOT_ACTUATED"
    }
  };
  const adapter = {
    getChatGptPages: () => [home],
    getActivePage: () => home,
    listRecentConversationUrls: async () => [],
    listBrowserHistoryChatGptUrls: async () => [targetUrl],
    reopenTargetPage: async (url) => {
      reopenedUrl = url;
      return recoveredPage;
    },
    setActivePage: (page) => page,
    closePage: async () => true,
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

  assert.equal(canRebindEnqueuedTaskDiscovery(state), true);
  const rebound = await resumeExistingConversationPage({
    adapter,
    state,
    recoveryRetries: 1,
    recoveryPollMs: 0
  });
  assert.equal(reopenedUrl, targetUrl);
  assert.equal(rebound?.runtime_id, state.conversation.runtime_id);
  assert.equal(rebound?.recovered_from, "BROWSER_HISTORY");

  const unsafe = structuredClone(state);
  unsafe.outbound.last_error_code = "AMBIGUOUS_ENQUEUED_OUTCOME";
  assert.equal(canRebindEnqueuedTaskDiscovery(unsafe), false);
  assert.equal(
    await resumeExistingConversationPage({
      adapter,
      state: unsafe,
      recoveryRetries: 1,
      recoveryPollMs: 0
    }),
    null
  );
});

test("SC-013 startup routes rebound ENQUEUED discovery through exact-once reconciliation", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const predicate = source.indexOf("canRebindEnqueuedTaskDiscovery(current)");
  const resume = source.indexOf("resumeEnqueuedTaskDiscoveryAfterRebind({", predicate);
  const reconciler = source.indexOf("reconcileExactOnceOutbound({", source.indexOf("async function resumeEnqueuedTaskDiscoveryAfterRebind"));

  assert.ok(predicate >= 0);
  assert.ok(resume > predicate);
  assert.ok(reconciler >= 0);
  const helper = source.slice(
    source.indexOf("async function resumeEnqueuedTaskDiscoveryAfterRebind"),
    source.indexOf("async function resumeEnqueuedTaskMessageAfterRebind")
  );
  assert.match(helper, /maxSafeRetries:\s*1/);
  assert.match(helper, /SAFE_RETRY_SENT/);
  assert.doesNotMatch(helper, /sendComposerInstruction\(/);
});


test("SC-013 task-control parser ignores invisible ChatGPT rendering characters", () => {
  const parsed = parseTaskControl(
    "MAGASIN_TASK_\u200BCONTROL_V1\n" +
    "STA\u2060TUS=READY\n" +
    "TASK_ID=NONE\n" +
    "NEXT_TASK_ID=SCHED-UI-013\n" +
    "CHECK_AFTER_SECONDS=0\n" +
    "END_MAGASIN_TASK_CONTROL_V1"
  );

  assert.deepEqual(parsed, {
    status: "READY",
    task_id: null,
    next_task_id: "SCHED-UI-013",
    check_after_seconds: 0
  });
});

test("SC-013 task-control parser normalizes NBSP but still rejects prose in block", () => {
  const parsed = parseTaskControl(
    "MAGASIN_TASK_CONTROL_V1\u00A0" +
    "STATUS=RUNNING\u00A0TASK_ID=SCHED-UI-012\u00A0" +
    "NEXT_TASK_ID=NONE\u00A0CHECK_AFTER_SECONDS=180\u00A0" +
    "END_MAGASIN_TASK_CONTROL_V1"
  );
  assert.equal(parsed.status, "RUNNING");
  assert.equal(parsed.task_id, "SCHED-UI-012");
  assert.equal(parsed.check_after_seconds, 180);

  assert.throws(
    () => parseTaskControl(
      "MAGASIN_TASK_CONTROL_V1\u00A0" +
      "STATUS=READY\u00A0unexpected-prose\u00A0" +
      "TASK_ID=NONE\u00A0NEXT_TASK_ID=SCHED-UI-013\u00A0" +
      "CHECK_AFTER_SECONDS=0\u00A0END_MAGASIN_TASK_CONTROL_V1"
    ),
    (error) => error?.code === "TASK_PROTOCOL_INVALID"
  );
});


test("SC-013 parses a task-control block when rendered field boundaries collapse completely", () => {
  const parsed = parseTaskControl(
    "prefix " +
    "MAGASIN_TASK_CONTROL_V1" +
    "STATUS=RUNNING" +
    "TASK_ID=SCHED-UI-012" +
    "NEXT_TASK_ID=NONE" +
    "CHECK_AFTER_SECONDS=180" +
    "END_MAGASIN_TASK_CONTROL_V1" +
    " suffix"
  );

  assert.deepEqual(parsed, {
    status: "RUNNING",
    task_id: "SCHED-UI-012",
    next_task_id: null,
    check_after_seconds: 180
  });
});

test("SC-013 compact task-control fallback still rejects prose inside the machine block", () => {
  assert.throws(
    () => parseTaskControl(
      "MAGASIN_TASK_CONTROL_V1" +
      "STATUS=READY" +
      "unexpected-prose" +
      "TASK_ID=NONE" +
      "NEXT_TASK_ID=SCHED-UI-013" +
      "CHECK_AFTER_SECONDS=0" +
      "END_MAGASIN_TASK_CONTROL_V1"
    ),
    (error) => error?.code === "TASK_PROTOCOL_INVALID"
  );
});


test("SC-013 normalizes BLOCKED discovery that advertises the blocked gate in NEXT_TASK_ID", () => {
  const parsed = parseTaskControl(
    "MAGASIN_TASK_CONTROL_V1\n" +
    "STATUS=BLOCKED\n" +
    "TASK_ID=NONE\n" +
    "NEXT_TASK_ID=SCHED-UI-016\n" +
    "CHECK_AFTER_SECONDS=0\n" +
    "END_MAGASIN_TASK_CONTROL_V1"
  );

  assert.deepEqual(parsed, {
    status: "BLOCKED",
    task_id: "SCHED-UI-016",
    next_task_id: null,
    check_after_seconds: 0
  });
});

test("SC-013 discovery contract makes BLOCKED gate semantics explicit", () => {
  const message = buildSingleConversationTaskDiscoveryInstruction({
    sourceOfTruthUrl: "https://github.com/magasincoffee/project/blob/main/SOURCE_OF_TRUTH.md",
    messageId: "sc013-blocked-contract-test"
  });

  assert.match(
    message,
    /Use STATUS=BLOCKED only when no executable task can proceed without Owner input/
  );
  assert.match(
    message,
    /BLOCKED => TASK_ID=<blocked SOT gate id or NONE> and NEXT_TASK_ID=NONE/
  );
});
