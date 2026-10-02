import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  acquireBlankNewChatSurface,
  bootstrapFailureRecoveryReason,
  buildSingleConversationBootstrap,
  canRecoverCorrelatedPreparedBootstrapDelivery,
  createNewChatAndBootstrap,
  recoverCorrelatedPreparedBootstrapDelivery,
  sendFreshChatBootstrapInstruction,
  waitForBootstrapResponse
} from "../src/runtime/single-conversation-bootstrap.mjs";
import {
  ensureSingleConversationState,
  readSingleConversationState,
  writeSingleConversationState
} from "../src/runtime/single-conversation-state.mjs";
import { composerInstructionDigest } from "../src/ui/actions.mjs";

async function tempStatePath() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-sc003-"));
  return {
    root,
    statePath: path.join(root, "single-conversation-state.json")
  };
}

function blankSnapshot(overrides = {}) {
  return {
    pathKind: "home",
    conversationPath: false,
    composerReady: true,
    userMessageCount: 0,
    assistantMessageCount: 0,
    loginRequired: false,
    hasCaptcha: false,
    conversationAccessDenied: false,
    conversationMissing: false,
    responseRunning: false,
    hasContinueControl: false,
    hasNetworkError: false,
    hasTransientError: false,
    ...overrides
  };
}

function fakePage(initialUrl = "https://chatgpt.com/") {
  let currentUrl = initialUrl;
  return {
    url() { return currentUrl; },
    setUrl(value) { currentUrl = value; },
    async waitForTimeout() {}
  };
}

test("SC-013 correlated PREPARED bootstrap delivery reconciles without resend", async () => {
  const { root, statePath } = await tempStatePath();
  const sourceOfTruthUrl = "https://example.com/SOURCE_OF_TRUTH.md";
  const messageId = "bootstrap-correlation-recovery";
  const message = buildSingleConversationBootstrap({
    sourceOfTruthUrl,
    messageId
  });
  const page = fakePage("https://chatgpt.com/c/correlated-bootstrap");
  let correlationChecks = 0;
  let responseWaits = 0;

  try {
    await ensureSingleConversationState(statePath, {
      sourceOfTruthUrl,
      projectId: "LIVE",
      sessionId: "correlated-bootstrap-test"
    });
    const state = await readSingleConversationState(statePath);
    state.conversation = {
      ...state.conversation,
      generation: 2,
      status: "ACTIVE",
      runtime_id: null,
      created_at: state.updated_at,
      last_seen_at: state.updated_at
    };
    state.outbound = {
      ...state.outbound,
      state: "PREPARED",
      kind: "SOURCE_OF_TRUTH_BOOTSTRAP",
      message_id: messageId,
      message_digest: composerInstructionDigest(message),
      retry_count: 1,
      last_error_code: "SEND_NOT_ACTUATED",
      prepared_at: state.updated_at
    };
    state.automation.status = "BLOCKED";
    state.automation.phase = "BOOTSTRAP_FAILED";
    state.automation.reason = "SEND_NOT_ACTUATED";
    await writeSingleConversationState(statePath, state);

    assert.equal(canRecoverCorrelatedPreparedBootstrapDelivery(state), true);

    const adapter = {
      getActivePage: () => page,
      getChatGptPages: () => [page],
      async probePage() {
        return {
          snapshot: {
            conversationPath: true,
            loginRequired: false,
            hasCaptcha: false,
            hasNetworkError: false,
            hasTransientError: false,
            conversationMissing: false,
            conversationAccessDenied: false
          }
        };
      }
    };

    const result = await recoverCorrelatedPreparedBootstrapDelivery({
      adapter,
      statePath,
      sourceOfTruthUrl,
      captureCorrelation: async () => {
        correlationChecks += 1;
        return {
          confirmed: true,
          turn_id: "user:correlated-bootstrap",
          evidence: "correlated-modern-bootstrap-user-turn",
          match_count: 1,
          total_count: 1
        };
      },
      waitForResponse: async () => {
        responseWaits += 1;
        const delivered = await readSingleConversationState(statePath);
        assert.equal(delivered.outbound.state, "DELIVERED");
        assert.equal(delivered.automation.status, "RUNNING");
        assert.equal(delivered.automation.phase, "WAIT_RESPONSE");
        assert.equal(delivered.automation.reason, null);
        assert.equal(delivered.outbound.retry_count, 1);
        assert.ok(delivered.conversation.runtime_id);
        return {
          status: "RESPONSE_COMPLETE",
          assistant_turn: {
            turn_id: "assistant:correlated-bootstrap",
            text: "ready"
          }
        };
      }
    });

    assert.equal(result.recovered, true);
    assert.equal(result.user_turn_evidence, "correlated-modern-bootstrap-user-turn");
    assert.equal(correlationChecks, 1);
    assert.equal(responseWaits, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-013 correlated bootstrap recovery searches Recent sidebar after open-tab miss", async () => {
  const { root, statePath } = await tempStatePath();
  const sourceOfTruthUrl = "https://example.com/SOURCE_OF_TRUTH.md";
  const messageId = "bootstrap-sidebar-recovery";
  const message = buildSingleConversationBootstrap({
    sourceOfTruthUrl,
    messageId
  });
  const home = fakePage("https://chatgpt.com/");
  const miss = fakePage("https://chatgpt.com/c/sidebar-miss");
  const match = fakePage("https://chatgpt.com/c/sidebar-match");
  const recentByUrl = new Map([
    [miss.url(), miss],
    [match.url(), match]
  ]);
  const correlationAttempts = new Map();
  const reopened = [];
  const closed = [];
  let responseWaits = 0;

  try {
    await ensureSingleConversationState(statePath, {
      sourceOfTruthUrl,
      projectId: "LIVE",
      sessionId: "sidebar-bootstrap-test"
    });
    const state = await readSingleConversationState(statePath);
    state.conversation = {
      ...state.conversation,
      generation: 2,
      status: "ACTIVE",
      runtime_id: null,
      created_at: state.updated_at,
      last_seen_at: state.updated_at
    };
    state.outbound = {
      ...state.outbound,
      state: "PREPARED",
      kind: "SOURCE_OF_TRUTH_BOOTSTRAP",
      message_id: messageId,
      message_digest: composerInstructionDigest(message),
      retry_count: 1,
      last_error_code: "SEND_NOT_ACTUATED",
      prepared_at: state.updated_at
    };
    state.automation.status = "BLOCKED";
    state.automation.phase = "BOOTSTRAP_FAILED";
    state.automation.reason = "SEND_NOT_ACTUATED";
    await writeSingleConversationState(statePath, state);

    let active = home;
    const adapter = {
      getActivePage: () => active,
      setActivePage(page) {
        active = page;
        return page;
      },
      getChatGptPages: () => [home],
      async listRecentConversationUrls() {
        return [miss.url(), match.url()];
      },
      async reopenTargetPage(url) {
        reopened.push(url);
        return recentByUrl.get(url) || null;
      },
      async invalidateTargetRecoveryPage(url, { page, close } = {}) {
        if (close && page) closed.push(url);
        return true;
      },
      async probePage(page) {
        return {
          snapshot: {
            conversationPath: page !== home,
            loginRequired: false,
            hasCaptcha: false,
            hasNetworkError: false,
            hasTransientError: false,
            conversationMissing: false,
            conversationAccessDenied: false
          }
        };
      }
    };

    const result = await recoverCorrelatedPreparedBootstrapDelivery({
      adapter,
      statePath,
      sourceOfTruthUrl,
      recentHydrationAttempts: 3,
      recentHydrationPollMs: 1,
      sleep: async () => {},
      captureCorrelation: async (page) => {
        const count = Number(correlationAttempts.get(page) || 0) + 1;
        correlationAttempts.set(page, count);
        if (page === match && count >= 2) {
          return {
            confirmed: true,
            turn_id: "user:sidebar-bootstrap",
            evidence: "correlated-modern-bootstrap-user-turn",
            match_count: 1,
            total_count: 1
          };
        }
        return {
          confirmed: false,
          turn_id: null,
          evidence: "correlated-bootstrap-user-turn-not-observed",
          match_count: 0,
          total_count: 0
        };
      },
      waitForResponse: async () => {
        responseWaits += 1;
        const delivered = await readSingleConversationState(statePath);
        assert.equal(delivered.outbound.state, "DELIVERED");
        assert.equal(delivered.automation.status, "RUNNING");
        assert.equal(delivered.automation.phase, "WAIT_RESPONSE");
        assert.ok(delivered.conversation.runtime_id);
        return {
          status: "RESPONSE_COMPLETE",
          assistant_turn: {
            turn_id: "assistant:sidebar-bootstrap",
            text: "ready"
          }
        };
      }
    });

    assert.equal(result.recovered, true);
    assert.equal(result.page, match);
    assert.equal(result.user_turn_evidence, "correlated-modern-bootstrap-user-turn");
    assert.equal(responseWaits, 1);
    assert.deepEqual(reopened, [miss.url(), match.url()]);
    assert.deepEqual(closed, [miss.url()]);
    assert.equal(active, match);
    assert.equal(correlationAttempts.get(match), 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-013 correlated bootstrap recovery remains fail-closed without a unique correlated turn", async () => {
  const candidate = {
    conversation: { status: "ACTIVE" },
    automation: {
      status: "BLOCKED",
      phase: "BOOTSTRAP_FAILED",
      reason: "SEND_NOT_ACTUATED"
    },
    outbound: {
      state: "PREPARED",
      kind: "SOURCE_OF_TRUTH_BOOTSTRAP",
      message_id: "bootstrap-correlation-candidate",
      message_digest: "digest",
      retry_count: 1,
      last_error_code: "SEND_NOT_ACTUATED"
    }
  };
  assert.equal(canRecoverCorrelatedPreparedBootstrapDelivery(candidate), true);
  assert.equal(
    canRecoverCorrelatedPreparedBootstrapDelivery({
      ...candidate,
      outbound: { ...candidate.outbound, retry_count: 2 }
    }),
    false
  );
  assert.equal(
    canRecoverCorrelatedPreparedBootstrapDelivery({
      ...candidate,
      outbound: { ...candidate.outbound, kind: "TASK_EXECUTION" }
    }),
    false
  );
});

test("SC-003 bootstrap prompt carries sole Source of Truth and unique correlation", () => {
  const message = buildSingleConversationBootstrap({
    sourceOfTruthUrl: "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md",
    messageId: "msg-001"
  });

  assert.match(message, /^MAGASIN_SINGLE_CONVERSATION_BOOTSTRAP_V1/m);
  assert.match(message, /id=msg-001/);
  assert.match(
    message,
    /SOT=https:\/\/github\.com\/magasincoffee\/magasin-supervisor\/blob\/main\/SOURCE_OF_TRUTH\.md/
  );
  assert.match(message, /sole project authority/i);
  assert.match(message, /Read SOT from the beginning/i);
  assert.match(message, /authoritative next executable task ID/i);
  assert.match(message, /MAGASIN_TASK_CONTROL_V1/);
  assert.match(message, /^[\x20-\x7E]+$/);
  assert.match(message, /MAGASIN_BOOTSTRAP_CORRELATION_V1 msg-001/);
  assert.doesNotMatch(message, /Planner|Executor|Brain|Work mode/i);
});

test("SC-003 bootstrap prompt remains printable ASCII for reliable remote composer typing", () => {
  for (const qualificationOnly of [false, true]) {
    const message = buildSingleConversationBootstrap({
      sourceOfTruthUrl: "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md",
      messageId: qualificationOnly ? "qual-ascii" : "prod-ascii",
      qualificationOnly
    });
    assert.equal(/^[\x20-\x7E]*$/.test(message), true);
  }
});

test("SC-003 qualification prompt is read-only and correlation-bound", () => {
  const message = buildSingleConversationBootstrap({
    sourceOfTruthUrl: "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md",
    messageId: "qual-001",
    qualificationOnly: true
  });

  assert.match(message, /QUALIFICATION ONLY/);
  assert.match(message, /read-only web access/i);
  assert.match(message, /do not write to external systems/i);
  assert.match(message, /Architecture generation/);
  assert.match(message, /MAGASIN_BOOTSTRAP_CORRELATION_V1 qual-001/);
  assert.doesNotMatch(message, /one bounded next unit allowed by SOT/i);
});

test("SC-003 fresh sender falls back to native keyboard when fill is inert", async () => {
  const instruction = "MAGASIN_SINGLE_CONVERSATION_BOOTSTRAP_V1 id=test SOT=https://example.com/SOURCE_OF_TRUTH.md";
  let composerText = "";
  let sent = false;
  let typed = 0;

  const composer = {
    first() { return this; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async fill() {
      // Simulate the real ChatGPT failure: fill resolves but editor stays empty.
    },
    async inputValue() { return composerText; },
    async click() {},
    async press(key) {
      if (key === "Enter" && composerText === instruction) {
        sent = true;
        composerText = "";
      }
    },
    locator() {
      return {
        first() { return this; },
        async isVisible() { return false; }
      };
    }
  };

  const page = {
    url() { return sent ? "https://chatgpt.com/c/test" : "https://chatgpt.com/"; },
    locator(selector) {
      if (selector.includes("send-button") || selector.includes("submit")) {
        return {
          first() { return this; },
          async isVisible() { return false; },
          async isEnabled() { return false; }
        };
      }
      return composer;
    },
    async bringToFront() {},
    async waitForTimeout() {},
    async evaluate(fn) {
      if (String(fn).includes("conversation-turn-")) {
        return sent
          ? {
              turn_id: "conversation-turn-0",
              conversation_turn_count: 1,
              evidence: "exact-fresh-conversation-turn"
            }
          : {
              turn_id: null,
              conversation_turn_count: 0,
              evidence: "exact-fresh-user-turn-not-observed"
            };
      }
      return null;
    },
    keyboard: {
      async press(key) {
        if (key === "Backspace") composerText = "";
      },
      async type(value) {
        typed += 1;
        composerText = value;
      }
    }
  };

  const result = await sendFreshChatBootstrapInstruction(
    page,
    instruction,
    { dryRun: false }
  );

  assert.equal(result.executed, true);
  assert.equal(result.input_method, "native-keyboard-type");
  assert.equal(result.send_method, "composer-enter");
  assert.equal(result.user_turn_id, "conversation-turn-0");
  assert.equal(typed, 1);
});

test("SC-010 fresh bootstrap tolerates delayed composer hydration", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-bootstrap.mjs", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /findFreshChatComposer\(page, timeoutMs = 30_000\)/
  );
  assert.match(
    source,
    /const composer = await findFreshChatComposer\(page, 30_000\)/
  );
  assert.match(
    source,
    /await new Promise\(\(resolve\) => setTimeout\(resolve, 150\)\)/
  );
  assert.doesNotMatch(
    source.match(/async function findFreshChatComposer[\s\S]*?return null;\n}/)?.[0] || "",
    /page\.waitForTimeout/
  );
});

test("SC-010 observes delivery when Enter throws after composer rerender", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-bootstrap.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /locator\.press\(\) can throw while the browser has already consumed Enter/);
  assert.match(source, /Otherwise fall through to\s*\/\/ delivery observation/);
  assert.doesNotMatch(
    source,
    /reason: "fresh ChatGPT composer changed before Enter recovery"/
  );
});

test("SC-010 retries explicit Send only after positive blank-home non-delivery evidence", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-bootstrap.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /positive non-delivery evidence/);
  assert.match(source, /finalStillHome &&/);
  assert.match(source, /finalTurnCount === 0/);
  assert.match(source, /finalDirectUserCount === 0/);
  assert.match(source, /composer-enter\+restored-safe-direct-control/);
  assert.match(source, /waitForExactFreshUserTurn\(page, instruction, \{\s*timeoutMs: 30_000/);
});

test("SC-013 bootstrap send checks correlation identity before SEND_NOT_ACTUATED failure", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-bootstrap.mjs", import.meta.url),
    "utf8"
  );
  const send = source.indexOf("let sendResult = await sendInstruction");
  const correlate = source.indexOf(
    "captureCorrelatedBootstrapUserTurnEvidence",
    send
  );
  const throwGate = source.indexOf(
    "bootstrap send was not confirmed",
    correlate
  );

  assert.ok(send >= 0);
  assert.ok(correlate > send);
  assert.ok(throwGate > correlate);
  const body = source.slice(send, throwGate);
  assert.match(body, /correlation_reconciled: true/);
  assert.match(body, /user_turn_id: correlated\.turn_id/);
});

test("SC-013 bootstrap delegates to hardened sender only after positive fresh-chat non-delivery", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-bootstrap.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /captureMatchingUserTurnEvidence/);
  assert.match(source, /sendComposerInstruction/);

  const gate = source.indexOf(
    "SC-013: the generic conversation sender has newer ChatGPT submit"
  );
  const positive = source.indexOf(
    "finalStillHome &&",
    gate
  );
  const zeroTurns = source.indexOf(
    "finalTurnCount === 0",
    positive
  );
  const zeroDirect = source.indexOf(
    "finalDirectUserCount === 0",
    zeroTurns
  );
  const sharedSend = source.indexOf(
    "sendComposerInstruction(page, instruction",
    zeroDirect
  );
  const exactTurn = source.indexOf(
    "captureMatchingUserTurnEvidence(page, instruction)",
    sharedSend
  );

  assert.ok(gate >= 0);
  assert.ok(positive > gate);
  assert.ok(zeroTurns > positive);
  assert.ok(zeroDirect > zeroTurns);
  assert.ok(sharedSend > zeroDirect);
  assert.ok(exactTurn > sharedSend);

  const body = source.slice(gate, exactTurn + 200);
  assert.match(body, /dryRun: false/);
  assert.match(body, /if \(shared\?\.executed\)/);
  assert.match(body, /if \(exact\?\.confirmed\)/);
});

test("SC-008 fresh bootstrap reacquires composer when locator Enter detaches", async () => {
  const instruction = "MAGASIN_SINGLE_CONVERSATION_BOOTSTRAP_V1 id=cold-enter SOT=https://example.com/SOURCE_OF_TRUTH.md";
  let composerText = instruction;
  let sent = false;
  let pageEnter = 0;

  const composer = {
    first() { return this; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async fill(value) { composerText = value; },
    async inputValue() { return composerText; },
    async click() {},
    async press(key) {
      if (key === "Enter") throw new Error("detached from document");
    },
    locator() {
      return {
        first() { return this; },
        async isVisible() { return false; }
      };
    }
  };

  const page = {
    url() { return sent ? "https://chatgpt.com/c/cold-enter" : "https://chatgpt.com/"; },
    locator(selector) {
      if (selector.includes("send-button") || selector.includes("submit")) {
        return {
          first() { return this; },
          async isVisible() { return false; },
          async isEnabled() { return false; }
        };
      }
      return composer;
    },
    async bringToFront() {},
    async waitForTimeout() {},
    async evaluate(fn) {
      if (String(fn).includes("conversation-turn-")) {
        return sent
          ? {
              turn_id: "conversation-turn-cold",
              conversation_turn_count: 1,
              evidence: "exact-fresh-conversation-turn"
            }
          : {
              turn_id: null,
              conversation_turn_count: 0,
              evidence: "exact-fresh-user-turn-not-observed"
            };
      }
      return null;
    },
    keyboard: {
      async press(key) {
        if (key === "Enter" && composerText === instruction) {
          pageEnter += 1;
          sent = true;
          composerText = "";
        }
      },
      async type(value) { composerText = value; }
    }
  };

  const result = await sendFreshChatBootstrapInstruction(
    page,
    instruction,
    { dryRun: false }
  );

  assert.equal(result.executed, true);
  assert.equal(result.send_method, "composer-enter");
  assert.equal(result.user_turn_id, "conversation-turn-cold");
  assert.equal(pageEnter, 1);
});

test("SC-003 forceNewPage never reuses a pre-existing home page", async () => {
  const oldHome = fakePage();
  const fresh = fakePage();
  let newPages = 0;
  const adapter = {
    async open() {},
    getActivePage() { return oldHome; },
    async newChatPage(url) {
      newPages += 1;
      assert.equal(url, "https://chatgpt.com/");
      return fresh;
    },
    async probePage(candidate) {
      assert.equal(candidate, fresh);
      return { snapshot: blankSnapshot() };
    }
  };

  const result = await acquireBlankNewChatSurface(adapter, {
    forceNewPage: true
  });
  assert.equal(result.page, fresh);
  assert.equal(result.created, true);
  assert.equal(result.reused_home, false);
  assert.equal(newPages, 1);
});

test("SC-003 reuses an authenticated blank ChatGPT home as New Chat", async () => {
  const page = fakePage();
  let newPages = 0;
  const adapter = {
    async open() {},
    getActivePage() { return page; },
    async probePage(candidate) {
      assert.equal(candidate, page);
      return { snapshot: blankSnapshot() };
    },
    async newChatPage() {
      newPages += 1;
      return fakePage();
    }
  };

  const result = await acquireBlankNewChatSurface(adapter);
  assert.equal(result.page, page);
  assert.equal(result.created, false);
  assert.equal(result.reused_home, true);
  assert.equal(newPages, 0);
});

test("SC-003 refuses to reuse an old conversation and opens a blank New Chat", async () => {
  const oldPage = fakePage("https://chatgpt.com/c/old");
  const newPage = fakePage();
  let newPages = 0;
  const adapter = {
    async open() {},
    getActivePage() { return oldPage; },
    async newChatPage(url) {
      newPages += 1;
      assert.equal(url, "https://chatgpt.com/");
      return newPage;
    },
    async probePage(candidate) {
      assert.equal(candidate, newPage);
      return { snapshot: blankSnapshot() };
    }
  };

  const result = await acquireBlankNewChatSurface(adapter);
  assert.equal(result.page, newPage);
  assert.equal(result.created, true);
  assert.equal(result.reused_home, false);
  assert.equal(newPages, 1);
});

test("SC-003 login and CAPTCHA boundaries fail before any send", async () => {
  for (const snapshot of [
    blankSnapshot({ composerReady: false, loginRequired: true }),
    blankSnapshot({ composerReady: false, hasCaptcha: true })
  ]) {
    const page = fakePage();
    const adapter = {
      async open() {},
      getActivePage() { return page; },
      async probePage() { return { snapshot }; },
      async newChatPage() { return page; }
    };

    await assert.rejects(
      acquireBlankNewChatSurface(adapter),
      /login is required|CAPTCHA/
    );
  }
});

test("SC-003 persists PREPARED before send, confirms user turn, then records response complete", async () => {
  const { root, statePath } = await tempStatePath();
  const page = fakePage();
  let sent = false;
  let waitProbe = 0;

  const adapter = {
    async open() {},
    getActivePage() { return page; },
    async newChatPage() {
      throw new Error("blank home should be reused");
    },
    async probePage() {
      if (!sent) return { snapshot: blankSnapshot() };
      waitProbe += 1;
      if (waitProbe === 1) {
        return {
          snapshot: blankSnapshot({
            pathKind: "conversation",
            conversationPath: true,
            userMessageCount: 1,
            responseRunning: true
          })
        };
      }
      return {
        snapshot: blankSnapshot({
          pathKind: "conversation",
          conversationPath: true,
          userMessageCount: 1,
          assistantMessageCount: 1,
          responseRunning: false
        })
      };
    }
  };

  const captureTurn = async (_page, role) => {
    if (!sent) return null;
    if (role === "user") {
      return {
        role: "user",
        turn_id: "conversation-turn-1",
        text: "bootstrap",
        digest: "user-digest"
      };
    }
    if (role === "assistant" && waitProbe >= 2) {
      return {
        role: "assistant",
        turn_id: "conversation-turn-2",
        text: "Bootstrap response\nMAGASIN_BOOTSTRAP_CORRELATION_V1 msg-002",
        digest: "assistant-digest"
      };
    }
    return null;
  };

  try {
    const result = await createNewChatAndBootstrap({
      adapter,
      statePath,
      sourceOfTruthUrl: "https://example.com/SOURCE_OF_TRUTH.md",
      messageId: "msg-002",
      captureTurn,
      sendInstruction: async (_page, message, options) => {
        assert.equal(options.dryRun, false);
        const durableBeforeSend = await readSingleConversationState(statePath);
        assert.equal(durableBeforeSend.outbound.state, "PREPARED");
        assert.equal(durableBeforeSend.outbound.message_id, "msg-002");
        assert.equal(durableBeforeSend.source_of_truth.sync_status, "SYNCING");
        assert.match(message, /MAGASIN_SINGLE_CONVERSATION_BOOTSTRAP_V1/);
        sent = true;
        page.setUrl("https://chatgpt.com/c/new-conversation");
        return {
          executed: true,
          user_turn_evidence: "matching-user-turn-observed"
        };
      },
      timeoutMs: 5_000,
      pollMs: 1,
      now: () => "2026-09-28T12:00:00.000Z"
    });

    assert.equal(result.response.status, "RESPONSE_COMPLETE");
    assert.equal(result.response.assistant_turn.turn_id, "conversation-turn-2");

    const durable = await readSingleConversationState(statePath);
    assert.equal(durable.conversation.generation, 1);
    assert.equal(durable.conversation.status, "ACTIVE");
    assert.match(durable.conversation.runtime_id, /^chat:[0-9a-f]{32}$/);
    assert.equal(durable.outbound.state, "RESPONSE_COMPLETE");
    assert.equal(durable.outbound.delivered_user_turn_id, "conversation-turn-1");
    assert.equal(durable.automation.phase, "BOOTSTRAP_RESPONSE_COMPLETE");

    const raw = await fs.readFile(statePath, "utf8");
    assert.doesNotMatch(raw, /chatgpt\.com\/c\/new-conversation/);
    assert.doesNotMatch(raw, /planner_url|executor_url/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-011 persists final conversation identity after delayed URL assignment", async () => {
  const { root, statePath } = await tempStatePath();
  const page = fakePage();
  let sent = false;
  let probeCount = 0;

  const adapter = {
    async open() {},
    getActivePage() { return page; },
    async newChatPage() {
      throw new Error("blank home should be reused");
    },
    async probePage() {
      if (!sent) return { snapshot: blankSnapshot() };
      probeCount += 1;
      if (probeCount === 1) {
        return {
          snapshot: blankSnapshot({
            pathKind: "conversation",
            conversationPath: true,
            userMessageCount: 1,
            responseRunning: true
          })
        };
      }
      page.setUrl("https://chatgpt.com/c/delayed-identity");
      return {
        snapshot: blankSnapshot({
          pathKind: "conversation",
          conversationPath: true,
          userMessageCount: 1,
          assistantMessageCount: 1,
          responseRunning: false
        })
      };
    }
  };

  const captureTurn = async (_page, role) => {
    if (!sent || role === "user") return null;
    if (probeCount >= 2) {
      return {
        role: "assistant",
        turn_id: "assistant-delayed",
        text: "ready\nMAGASIN_BOOTSTRAP_CORRELATION_V1 delayed-id",
        digest: "assistant-delayed-digest"
      };
    }
    return null;
  };

  try {
    await createNewChatAndBootstrap({
      adapter,
      statePath,
      sourceOfTruthUrl: "https://example.com/source",
      messageId: "delayed-id",
      captureTurn,
      sendInstruction: async () => {
        sent = true;
        return {
          executed: true,
          user_turn_id: "user-delayed",
          user_turn_evidence: "exact-fresh-conversation-turn"
        };
      },
      timeoutMs: 5_000,
      pollMs: 1
    });

    const durable = await readSingleConversationState(statePath);
    assert.match(durable.conversation.runtime_id, /^chat:[0-9a-f]{32}$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-003 trusts exact fresh-turn send proof without a second role-selector capture", async () => {
  const { root, statePath } = await tempStatePath();
  const page = fakePage();
  let waitProbe = 0;

  const adapter = {
    async open() {},
    getActivePage() { return page; },
    async newChatPage() {
      throw new Error("blank home should be reused");
    },
    async probePage() {
      if (waitProbe === 0) return { snapshot: blankSnapshot() };
      if (waitProbe === 1) {
        waitProbe = 2;
        return {
          snapshot: blankSnapshot({
            pathKind: "conversation",
            conversationPath: true,
            userMessageCount: 1,
            responseRunning: true
          })
        };
      }
      return {
        snapshot: blankSnapshot({
          pathKind: "conversation",
          conversationPath: true,
          userMessageCount: 1,
          assistantMessageCount: 1,
          responseRunning: false
        })
      };
    }
  };

  const captureTurn = async (_page, role) => {
    if (role === "user") return null;
    if (waitProbe >= 2) {
      return {
        role: "assistant",
        turn_id: "conversation-turn-2",
        text: "done\nMAGASIN_BOOTSTRAP_CORRELATION_V1 msg-direct-proof",
        digest: "assistant-digest"
      };
    }
    return null;
  };

  try {
    const result = await createNewChatAndBootstrap({
      adapter,
      statePath,
      sourceOfTruthUrl: "https://example.com/source",
      messageId: "msg-direct-proof",
      captureTurn,
      sendInstruction: async () => {
        waitProbe = 1;
        page.setUrl("https://chatgpt.com/c/direct-proof");
        return {
          executed: true,
          user_turn_id: "conversation-turn-1",
          user_turn_evidence: "exact-fresh-conversation-turn",
          conversation_turn_count: 1
        };
      },
      timeoutMs: 5_000,
      pollMs: 1
    });

    assert.equal(result.send.user_turn_id, "conversation-turn-1");
    const durable = await readSingleConversationState(statePath);
    assert.equal(
      durable.outbound.delivered_user_turn_id,
      "conversation-turn-1"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-003 does not mark a partial response complete when Continue is required", async () => {
  const { root, statePath } = await tempStatePath();
  const page = fakePage();
  let sent = false;

  const adapter = {
    async open() {},
    getActivePage() { return page; },
    async newChatPage() { return page; },
    async probePage() {
      if (!sent) return { snapshot: blankSnapshot() };
      return {
        snapshot: blankSnapshot({
          pathKind: "conversation",
          conversationPath: true,
          userMessageCount: 1,
          assistantMessageCount: 1,
          hasContinueControl: true
        })
      };
    }
  };

  const captureTurn = async (_page, role) => {
    if (!sent) return null;
    if (role === "user") {
      return { turn_id: "user-1", text: "bootstrap", digest: "u1" };
    }
    return {
      turn_id: "assistant-partial",
      text: "partial",
      digest: "a1"
    };
  };

  try {
    const result = await createNewChatAndBootstrap({
      adapter,
      statePath,
      sourceOfTruthUrl: "https://example.com/source",
      messageId: "msg-continue",
      captureTurn,
      sendInstruction: async () => {
        sent = true;
        page.setUrl("https://chatgpt.com/c/partial");
        return { executed: true, user_turn_evidence: "matching-user-turn-observed" };
      },
      timeoutMs: 1_000,
      pollMs: 1
    });

    assert.equal(result.response.status, "CONTINUE_REQUIRED");
    const durable = await readSingleConversationState(statePath);
    assert.notEqual(durable.outbound.state, "RESPONSE_COMPLETE");
    assert.notEqual(durable.automation.phase, "BOOTSTRAP_RESPONSE_COMPLETE");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-003 qualification waits through false-idle partial assistant text until correlation appears", async () => {
  const { root, statePath } = await tempStatePath();
  let captureCount = 0;
  const page = {
    async waitForTimeout() {}
  };
  const adapter = {
    async probePage() {
      return {
        snapshot: blankSnapshot({
          pathKind: "conversation",
          conversationPath: true,
          userMessageCount: 1,
          assistantMessageCount: 1,
          responseRunning: false
        })
      };
    }
  };
  const marker = "MAGASIN_BOOTSTRAP_CORRELATION_V1 qual-false-idle";

  try {
    await ensureSingleConversationState(statePath, {
      sourceOfTruthUrl: "https://example.com/source"
    });

    const response = await waitForBootstrapResponse({
      adapter,
      page,
      statePath,
      expectedAssistantMarker: marker,
      assistantSettleMs: 10_000,
      captureTurn: async (_page, role) => {
        assert.equal(role, "assistant");
        captureCount += 1;
        if (captureCount === 1) {
          return {
            role: "assistant",
            turn_id: "assistant-live",
            text: "Architecture generation: SINGLE_CONVERSATION_V1",
            digest: "partial-digest"
          };
        }
        return {
          role: "assistant",
          turn_id: "assistant-live",
          text:
            "Architecture generation: SINGLE_CONVERSATION_V1\n" +
            marker,
          digest: "complete-digest"
        };
      },
      timeoutMs: 1_000,
      pollMs: 1
    });

    assert.equal(captureCount, 2);
    assert.equal(response.status, "RESPONSE_COMPLETE");
    assert.equal(response.marker_confirmed, true);
    assert.match(response.assistant_turn.text, /qual-false-idle/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-003 confirmed-send failure is persisted as bounded bootstrap failure", async () => {
  const { root, statePath } = await tempStatePath();
  const page = fakePage();
  const adapter = {
    async open() {},
    getActivePage() { return page; },
    async newChatPage() { return page; },
    async probePage() { return { snapshot: blankSnapshot() }; }
  };

  try {
    await assert.rejects(
      createNewChatAndBootstrap({
        adapter,
        statePath,
        sourceOfTruthUrl: "https://example.com/source",
        messageId: "msg-fail",
        captureTurn: async () => null,
        sendInstruction: async () => ({
          executed: false,
          reason: "composer did not send",
          rejection_class: "SEND_NOT_ACTUATED"
        }),
        timeoutMs: 100,
        pollMs: 1
      }),
      /composer did not send/
    );

    const durable = await readSingleConversationState(statePath);
    assert.equal(durable.automation.status, "BLOCKED");
    assert.equal(durable.automation.phase, "BOOTSTRAP_FAILED");
    assert.equal(durable.outbound.last_error_code, "SEND_NOT_ACTUATED");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-013 bootstrap recovery persists consumed retry budget before submit", async () => {
  const { root, statePath } = await tempStatePath();
  const page = fakePage();
  const adapter = {
    async open() {},
    getActivePage() { return page; },
    async newChatPage() { return page; },
    async probePage() { return { snapshot: blankSnapshot() }; }
  };

  try {
    await assert.rejects(
      createNewChatAndBootstrap({
        adapter,
        statePath,
        sourceOfTruthUrl: "https://example.com/source",
        messageId: "bootstrap-retry-budget",
        initialRetryCount: 1,
        captureTurn: async () => null,
        sendInstruction: async () => ({
          executed: false,
          reason: "retry submit did not actuate",
          rejection_class: "SEND_NOT_ACTUATED"
        }),
        timeoutMs: 100,
        pollMs: 1
      }),
      /retry submit did not actuate/
    );

    const durable = await readSingleConversationState(statePath);
    assert.equal(durable.outbound.state, "PREPARED");
    assert.equal(durable.outbound.retry_count, 1);
    assert.equal(durable.outbound.last_error_code, "SEND_NOT_ACTUATED");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-003 live qualification bounds CDP cleanup and exits explicitly", async () => {
  const source = await fs.readFile(
    new URL("../.github/scripts/supervisor-sc003-live-qualification.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /boundedCleanup/);
  assert.match(source, /SC003_LIVE_CLEANUP_TIMEOUT_/);
  assert.match(source, /process\.exit\(finalExitCode\)/);
  assert.doesNotMatch(
    source,
    /log\("SC003_LIVE_ERROR_DIGEST"[\s\S]{0,120}throw error/
  );
});

test("SC-003 live qualification treats an already-exited paused runtime as success", async () => {
  const source = await fs.readFile(
    new URL("../.github/scripts/supervisor-sc003-live-qualification.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /SC003_QUAL_RUNTIME_ALREADY_PAUSED_PID/);
  assert.match(source, /Get-Process -Id \$runtimePid -ErrorAction SilentlyContinue/);
  assert.match(source, /runtime process remained alive after pause request/);
});

test("SC-003 CLI requires Source of Truth/CDP but never a chat URL", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-bootstrap-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /--source-of-truth/);
  assert.match(source, /--cdp-url/);
  assert.match(source, /--execute/);
  assert.match(source, /--qualification-only/);
  assert.match(source, /--force-new-page/);
  assert.match(source, /SC003_CHAT_URL_REQUIRED=False/);
  assert.doesNotMatch(source, /--planner-url|--executor-url|--chat-url/);
});


test("SC-013 transient bootstrap response failure stays autonomous and requests disposable recovery", async () => {
  const { root, statePath } = await tempStatePath();
  const page = fakePage();
  let sent = false;
  const adapter = {
    async open() {},
    getActivePage() { return page; },
    async newChatPage() { return page; },
    async probePage() {
      if (!sent) return { snapshot: blankSnapshot() };
      return {
        snapshot: blankSnapshot({
          pathKind: "conversation",
          conversationPath: true,
          userMessageCount: 1,
          hasTransientError: true,
          responseRunning: false
        })
      };
    }
  };

  try {
    await assert.rejects(
      createNewChatAndBootstrap({
        adapter,
        statePath,
        sourceOfTruthUrl: "https://example.com/source",
        messageId: "bootstrap-transient-recovery",
        sendInstruction: async () => {
          sent = true;
          page.setUrl("https://chatgpt.com/c/bootstrap-transient");
          return {
            executed: true,
            user_turn_id: "conversation-turn-user-1",
            user_turn_evidence: "exact-fresh-conversation-turn",
            conversation_turn_count: 1
          };
        },
        timeoutMs: 100,
        pollMs: 1
      }),
      /transient error during bootstrap/
    );

    const durable = await readSingleConversationState(statePath);
    assert.equal(durable.outbound.state, "DELIVERED");
    assert.equal(durable.outbound.last_error_code, "TRANSIENT_ERROR");
    assert.equal(durable.automation.status, "RUNNING");
    assert.equal(durable.automation.phase, "BOOTSTRAP_RECOVERY_REQUIRED");
    assert.equal(durable.automation.reason, "BOOTSTRAP_TRANSIENT_FAILURE");
    assert.equal(
      bootstrapFailureRecoveryReason(
        Object.assign(new Error("ChatGPT transient error during bootstrap"), {
          code: "TRANSIENT_ERROR"
        }),
        durable
      ),
      "BOOTSTRAP_TRANSIENT_FAILURE"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-013 bootstrap recovery remains fail-closed before delivery and for Owner auth", () => {
  const preDelivery = {
    outbound: {
      state: "PREPARED",
      kind: "SOURCE_OF_TRUTH_BOOTSTRAP"
    }
  };
  assert.equal(
    bootstrapFailureRecoveryReason(
      Object.assign(new Error("ChatGPT transient error during bootstrap"), {
        code: "TRANSIENT_ERROR"
      }),
      preDelivery
    ),
    null
  );

  const delivered = {
    outbound: {
      state: "DELIVERED",
      kind: "SOURCE_OF_TRUTH_BOOTSTRAP"
    }
  };
  assert.equal(
    bootstrapFailureRecoveryReason(
      Object.assign(new Error("ChatGPT login is required"), {
        code: "AUTH_REQUIRED"
      }),
      delivered
    ),
    null
  );
});
