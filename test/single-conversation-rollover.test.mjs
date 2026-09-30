import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  classifyDisposableConversation,
  recoverDisposableConversationIfNeeded,
  replaceDisposableConversation
} from "../src/runtime/single-conversation-rollover.mjs";
import {
  beginConversationGeneration,
  ensureSingleConversationState,
  readSingleConversationState,
  writeSingleConversationState
} from "../src/runtime/single-conversation-state.mjs";

async function tempState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-sc005-"));
  const statePath = path.join(root, "single-conversation-state.json");
  await ensureSingleConversationState(statePath, {
    sourceOfTruthUrl: "https://example.com/SOURCE_OF_TRUTH.md",
    sessionId: "sc005-session"
  });
  await beginConversationGeneration(statePath, {
    runtimeId: "chat:old",
    pageId: "page:old"
  });
  return { root, statePath };
}

function snapshot(overrides = {}) {
  return {
    conversationPath: true,
    composerReady: true,
    responseRunning: false,
    loginRequired: false,
    hasCaptcha: false,
    conversationMissing: false,
    conversationAccessDenied: false,
    conversationFull: false,
    hasNetworkError: false,
    hasTransientError: false,
    ...overrides
  };
}

test("SC-005 classifies conversation-specific failures for replacement", () => {
  assert.deepEqual(
    classifyDisposableConversation(snapshot({ conversationMissing: true })),
    { action: "REPLACE_CHAT", reason: "CONVERSATION_MISSING" }
  );
  assert.deepEqual(
    classifyDisposableConversation(snapshot({ conversationFull: true })),
    { action: "REPLACE_CHAT", reason: "CONVERSATION_FULL" }
  );
  assert.deepEqual(
    classifyDisposableConversation(snapshot({ composerReady: false })),
    { action: "REPLACE_CHAT", reason: "COMPOSER_UNAVAILABLE" }
  );
  assert.equal(
    classifyDisposableConversation(
      snapshot({ hasNetworkError: true }),
      { consecutiveTransientFailures: 2, transientFailureThreshold: 3 }
    ).action,
    "KEEP_CHAT"
  );
  assert.deepEqual(
    classifyDisposableConversation(
      snapshot({ hasNetworkError: true }),
      { consecutiveTransientFailures: 3, transientFailureThreshold: 3 }
    ),
    { action: "REPLACE_CHAT", reason: "REPEATED_NETWORK_FAILURE" }
  );
});

test("SC-005 classifies stale and ambiguous page identity for replacement", () => {
  assert.deepEqual(
    classifyDisposableConversation(snapshot({ pageClosed: true })),
    { action: "REPLACE_CHAT", reason: "STALE_OR_CLOSED_PAGE" }
  );
  assert.deepEqual(
    classifyDisposableConversation(snapshot({ unrecoverableStalePage: true })),
    { action: "REPLACE_CHAT", reason: "STALE_OR_CLOSED_PAGE" }
  );
  assert.deepEqual(
    classifyDisposableConversation(snapshot({ pageIdentityAmbiguous: true })),
    { action: "REPLACE_CHAT", reason: "AMBIGUOUS_PAGE_IDENTITY" }
  );
});

test("SC-005 auth and CAPTCHA do not cause disposable-chat churn", () => {
  assert.deepEqual(
    classifyDisposableConversation(snapshot({ loginRequired: true })),
    { action: "WAIT_OWNER", reason: "AUTH_REQUIRED" }
  );
  assert.deepEqual(
    classifyDisposableConversation(snapshot({ hasCaptcha: true })),
    { action: "WAIT_OWNER", reason: "CAPTCHA_REQUIRED" }
  );
});

test("SC-005 refuses to close a conversation with an unowned composer draft", async () => {
  const { root, statePath } = await tempState();
  const page = {
    isClosed() { return false; },
    locator() {
      const composer = {
        first() { return this; },
        async isVisible() { return true; },
        async isEnabled() { return true; },
        async isEditable() { return true; },
        async inputValue() { return "owner draft"; },
        async click() {},
        async press() {}
      };
      return composer;
    },
    async waitForTimeout() {}
  };
  let closed = 0;
  try {
    await assert.rejects(
      replaceDisposableConversation({
        adapter: {
          async closePage() { closed += 1; return true; }
        },
        page,
        statePath,
        reason: "CONVERSATION_MISSING"
      }),
      (error) => error?.code === "UNOWNED_DRAFT_PRESENT"
    );
    assert.equal(closed, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-005 preserves prior transaction evidence across replacement", async () => {
  const { root, statePath } = await tempState();
  try {
    const state = await readSingleConversationState(statePath);
    state.outbound.state = "DELIVERED";
    state.outbound.message_id = "prior-msg";
    state.outbound.message_digest = "a".repeat(64);
    state.outbound.kind = "SOURCE_OF_TRUTH_NEXT_WORK";
    state.outbound.cmd_id = "ui:prior-msg";
    state.outbound.delivered_user_turn_id = "u-prior";
    state.outbound.last_error_code = "AMBIGUOUS_ENQUEUED_OUTCOME";
    state.outbound.last_error_stage = "SEND_WORK";
    state.outbound.last_pre_actuation_error_code = "COMPOSER_NOT_READY";
    state.outbound.last_pre_actuation_error_stage = "SET_COMPOSER_TEXT";
    await writeSingleConversationState(statePath, state);

    let closed = false;
    const lifecycle = [];
    const oldPage = {
      isClosed() { return closed; },
      locator() {
        return {
          first() { return this; },
          async isVisible() { return false; },
          async isEnabled() { return false; },
          async isEditable() { return false; }
        };
      },
      async waitForTimeout() {}
    };
    const newPage = {
      isClosed() { return false; },
      url() { return "https://chatgpt.com/c/new"; },
      async waitForTimeout() {}
    };

    let sent = false;
    let waitProbe = 0;
    const adapter = {
      async closePage(candidate) {
        assert.equal(candidate, oldPage);
        lifecycle.push("close-old");
        closed = true;
        return true;
      },
      async open() {},
      getActivePage() { return oldPage; },
      async newChatPage() {
        lifecycle.push("new-page");
        return newPage;
      },
      async probePage(candidate) {
        if (candidate === newPage && !sent) {
          return { snapshot: snapshot({
            conversationPath: false,
            composerReady: true
          }) };
        }
        waitProbe += 1;
        return { snapshot: snapshot({
          userMessageCount: sent ? 1 : 0,
          assistantMessageCount: sent && waitProbe > 1 ? 1 : 0,
          responseRunning: sent && waitProbe === 1
        }) };
      }
    };

    const captureTurn = async (_page, role) => {
      if (!sent) return null;
      if (role === "user") {
        return { turn_id: "u-new", text: "bootstrap", digest: "u-new" };
      }
      if (waitProbe > 1) {
        return { turn_id: "a-new", text: "ready", digest: "a-new" };
      }
      return null;
    };

    const result = await replaceDisposableConversation({
      adapter,
      page: oldPage,
      statePath,
      reason: "CONVERSATION_FULL",
      messageId: "rehydrate-1",
      captureTurn,
      sendInstruction: async () => {
        sent = true;
        return {
          executed: true,
          user_turn_evidence: "matching-user-turn-observed"
        };
      },
      pollMs: 1
    });

    assert.equal(result.replaced_generation, 1);
    assert.equal(result.active_generation, 2);
    assert.equal(closed, true);
    assert.deepEqual(
      lifecycle,
      ["new-page", "close-old"],
      "replacement page must exist before the retired/last Chrome page closes"
    );

    const durable = await readSingleConversationState(statePath);
    assert.equal(durable.conversation.generation, 2);
    assert.equal(durable.conversation.status, "ACTIVE");
    assert.equal(durable.recovery.retired_generation, 1);
    assert.equal(durable.recovery.reason, "CONVERSATION_FULL");
    assert.equal(durable.recovery.prior_outbound.message_id, "prior-msg");
    assert.equal(durable.recovery.prior_outbound.cmd_id, "ui:prior-msg");
    assert.equal(
      durable.recovery.prior_outbound.last_pre_actuation_error_code,
      "COMPOSER_NOT_READY"
    );
    assert.equal(
      durable.recovery.prior_outbound.last_pre_actuation_error_stage,
      "SET_COMPOSER_TEXT"
    );
    assert.equal(durable.recovery.rehydrated_generation, 2);
    assert.equal(durable.outbound.state, "RESPONSE_COMPLETE");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-005 recovery helper replaces an already-closed page without probing it", async () => {
  const { root, statePath } = await tempState();
  const oldPage = {
    isClosed() { return true; }
  };
  const newPage = {
    isClosed() { return false; },
    url() { return "https://chatgpt.com/c/recovered-closed"; },
    async waitForTimeout() {}
  };
  let sent = false;
  let phase = 0;
  let oldProbed = 0;
  try {
    const adapter = {
      async open() {},
      getActivePage() { return oldPage; },
      async closePage() { throw new Error("closed page must not be closed again"); },
      async newChatPage() { return newPage; },
      async probePage(candidate) {
        if (candidate === oldPage) {
          oldProbed += 1;
          throw new Error("closed page must not be probed");
        }
        if (!sent) {
          return { snapshot: snapshot({
            conversationPath: false,
            composerReady: true
          }) };
        }
        phase += 1;
        return { snapshot: snapshot({
          responseRunning: phase === 1,
          userMessageCount: 1,
          assistantMessageCount: phase > 1 ? 1 : 0
        }) };
      }
    };

    const result = await recoverDisposableConversationIfNeeded({
      adapter,
      page: oldPage,
      statePath,
      messageId: "recover-closed",
      qualificationOnly: true,
      sendInstruction: async () => {
        sent = true;
        return { executed: true };
      },
      captureTurn: async (_page, role) => {
        if (!sent) return null;
        if (role === "user") return { turn_id: "u-closed", text: "b", digest: "u-closed" };
        if (phase > 1) {
          return {
            turn_id: "a-closed",
            text:
              "SINGLE_CONVERSATION_V1 MAGASIN_BOOTSTRAP_CORRELATION_V1 recover-closed",
            digest: "a-closed"
          };
        }
        return null;
      },
      pollMs: 1
    });

    assert.equal(oldProbed, 0);
    assert.equal(result.recovered, true);
    assert.equal(result.classification.reason, "STALE_OR_CLOSED_PAGE");
    assert.equal(result.result.active_generation, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-005 recovery helper replaces a missing conversation automatically", async () => {
  const { root, statePath } = await tempState();
  let oldClosed = false;
  const oldPage = {
    isClosed() { return oldClosed; },
    locator() {
      return {
        first() { return this; },
        async isVisible() { return false; },
        async isEnabled() { return false; },
        async isEditable() { return false; }
      };
    },
    async waitForTimeout() {}
  };
  const newPage = {
    isClosed() { return false; },
    url() { return "https://chatgpt.com/c/recovered"; },
    async waitForTimeout() {}
  };
  let sent = false;
  let phase = 0;
  try {
    const adapter = {
      async open() {},
      getActivePage() { return oldPage; },
      async closePage() { oldClosed = true; return true; },
      async newChatPage() { return newPage; },
      async probePage(candidate) {
        if (candidate === oldPage) {
          return { snapshot: snapshot({ conversationMissing: true }) };
        }
        if (!sent) {
          return { snapshot: snapshot({
            conversationPath: false,
            composerReady: true
          }) };
        }
        phase += 1;
        return { snapshot: snapshot({
          responseRunning: phase === 1,
          userMessageCount: 1,
          assistantMessageCount: phase > 1 ? 1 : 0
        }) };
      }
    };
    const result = await recoverDisposableConversationIfNeeded({
      adapter,
      page: oldPage,
      statePath,
      messageId: "recover-2",
      sendInstruction: async () => {
        sent = true;
        return { executed: true };
      },
      captureTurn: async (_page, role) => {
        if (!sent) return null;
        if (role === "user") return { turn_id: "u2", text: "b", digest: "u2" };
        if (phase > 1) return { turn_id: "a2", text: "ok", digest: "a2" };
        return null;
      },
      pollMs: 1
    });

    assert.equal(result.recovered, true);
    assert.equal(result.classification.reason, "CONVERSATION_MISSING");
    assert.equal(result.result.active_generation, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("SC-010 converts probe-close race into disposable rollover", async () => {
  const { root, statePath } = await tempState();
  let closed = false;
  const oldPage = {
    isClosed() { return closed; }
  };
  const newPage = {
    isClosed() { return false; },
    url() { return "https://chatgpt.com/c/recovered-race"; },
    async waitForTimeout() {}
  };
  let sent = false;
  let phase = 0;

  try {
    const adapter = {
      async open() {},
      getActivePage() { return oldPage; },
      async closePage() {
        throw new Error("race-closed page must not be closed again");
      },
      async newChatPage() { return newPage; },
      async probePage(candidate) {
        if (candidate === oldPage) {
          closed = true;
          throw new Error("page is required");
        }
        if (!sent) {
          return { snapshot: snapshot({
            conversationPath: false,
            composerReady: true
          }) };
        }
        phase += 1;
        return { snapshot: snapshot({
          responseRunning: phase === 1,
          userMessageCount: 1,
          assistantMessageCount: phase > 1 ? 1 : 0
        }) };
      }
    };

    const result = await recoverDisposableConversationIfNeeded({
      adapter,
      page: oldPage,
      statePath,
      messageId: "recover-race",
      qualificationOnly: true,
      sendInstruction: async () => {
        sent = true;
        return { executed: true };
      },
      captureTurn: async (_page, role) => {
        if (!sent) return null;
        if (role === "user") {
          return { turn_id: "u-race", text: "b", digest: "u-race" };
        }
        if (phase > 1) {
          return {
            turn_id: "a-race",
            text:
              "SINGLE_CONVERSATION_V1 MAGASIN_BOOTSTRAP_CORRELATION_V1 recover-race",
            digest: "a-race"
          };
        }
        return null;
      },
      pollMs: 1
    });

    assert.equal(result.recovered, true);
    assert.equal(result.classification.reason, "STALE_OR_CLOSED_PAGE");
    assert.equal(result.result.active_generation, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
