import test from "node:test";
import assert from "node:assert/strict";

import {
  RECOVERY_ACTIONS,
  SupervisorRecoveryController,
  canonicalConversationPathname,
  isConversationPathname,
  pageMatchesTarget,
  targetFromUrl,
  isPersistableConversationUrl
} from "../src/runtime/recovery.mjs";

test("recognizes supported ChatGPT conversation paths", () => {
  assert.equal(isConversationPathname("/c/abc"), true);
  assert.equal(isConversationPathname("/g/example/abc"), true);
  assert.equal(isConversationPathname("/project/example"), true);
  assert.equal(isConversationPathname("/"), false);
});

test("normalizes a ChatGPT conversation URL into a local target", () => {
  assert.deepEqual(
    targetFromUrl("https://chatgpt.com/c/abc?model=auto#x"),
    { origin: "https://chatgpt.com", pathname: "/c/abc" }
  );
  assert.equal(
    pageMatchesTarget("https://chatgpt.com/c/abc?model=auto", {
      origin: "https://chatgpt.com",
      pathname: "/c/abc"
    }),
    true
  );
});

test("only positive conversationFull evidence authorizes rollover", () => {
  const recovery = new SupervisorRecoveryController();
  assert.equal(
    recovery.observeProbe({
      snapshot: { conversationFull: true },
      classification: { observation: "RESPONSE_COMPLETE" }
    }),
    RECOVERY_ACTIONS.ROLLOVER_CONVERSATION_FULL
  );
});

test("missing target exhausts into WAIT_USER instead of creating a chat", () => {
  const recovery = new SupervisorRecoveryController({ targetMissThreshold: 2 });
  assert.equal(recovery.observeTarget({ matched: false }), RECOVERY_ACTIONS.WAIT_TARGET);
  assert.equal(
    recovery.observeTarget({ matched: false }),
    RECOVERY_ACTIONS.WAIT_USER_RECOVERY_EXHAUSTED
  );
  assert.equal(recovery.blocked, true);
});

test("conversation missing fails closed and never rolls over", () => {
  const recovery = new SupervisorRecoveryController();
  assert.equal(
    recovery.observeProbe({
      snapshot: { conversationMissing: true },
      classification: { observation: "UNKNOWN" }
    }),
    RECOVERY_ACTIONS.WAIT_USER_RECOVERY_EXHAUSTED
  );
  assert.equal(recovery.blocked, true);
});

test("stalled response reloads within budget then fails closed", () => {
  let now = 0;
  const recovery = new SupervisorRecoveryController({
    stallMs: 1000,
    reloadCooldownMs: 100,
    maxStallReloads: 2,
    now: () => now
  });
  const running = {
    snapshot: {
      conversationPath: true,
      composerReady: false,
      responseRunning: true,
      assistantMessageCount: 4,
      lastAssistantCharCount: 100
    },
    classification: { observation: "ASSISTANT_RUNNING" }
  };

  assert.equal(recovery.observeProbe(running), RECOVERY_ACTIONS.NONE);
  now = 1000;
  assert.equal(recovery.observeProbe(running), RECOVERY_ACTIONS.RELOAD_STALLED);
  recovery.record(RECOVERY_ACTIONS.RELOAD_STALLED);
  now = 1101;
  assert.equal(recovery.observeProbe(running), RECOVERY_ACTIONS.RELOAD_STALLED);
  recovery.record(RECOVERY_ACTIONS.RELOAD_STALLED);
  now = 1202;
  assert.equal(
    recovery.observeProbe(running),
    RECOVERY_ACTIONS.WAIT_USER_RECOVERY_EXHAUSTED
  );
});

test("unavailable conversation reloads within budget then fails closed", () => {
  let now = 0;
  const recovery = new SupervisorRecoveryController({
    unavailableGraceMs: 500,
    reloadCooldownMs: 100,
    maxUnavailableReloads: 1,
    now: () => now
  });
  const unavailable = {
    snapshot: {
      conversationPath: true,
      composerReady: false,
      responseRunning: false,
      loginRequired: false,
      hasCaptcha: false,
      hasNetworkError: false,
      hasTransientError: false
    },
    classification: { observation: "UNKNOWN" }
  };

  assert.equal(recovery.observeProbe(unavailable), RECOVERY_ACTIONS.NONE);
  now = 500;
  assert.equal(recovery.observeProbe(unavailable), RECOVERY_ACTIONS.RELOAD_UNAVAILABLE);
  recovery.record(RECOVERY_ACTIONS.RELOAD_UNAVAILABLE);
  now = 601;
  assert.equal(
    recovery.observeProbe(unavailable),
    RECOVERY_ACTIONS.WAIT_USER_RECOVERY_EXHAUSTED
  );
});

test("assistant text progress resets the stall clock instead of reloading active work", () => {
  let now = 0;
  const recovery = new SupervisorRecoveryController({
    stallMs: 1000,
    reloadCooldownMs: 100,
    now: () => now
  });
  const running = (chars) => ({
    snapshot: {
      conversationPath: true,
      composerReady: false,
      responseRunning: true,
      assistantMessageCount: 4,
      lastAssistantCharCount: chars
    },
    classification: { observation: "ASSISTANT_RUNNING" }
  });

  assert.equal(recovery.observeProbe(running(100)), RECOVERY_ACTIONS.NONE);
  now = 900;
  assert.equal(recovery.observeProbe(running(180)), RECOVERY_ACTIONS.NONE);
  now = 1700;
  assert.equal(recovery.observeProbe(running(260)), RECOVERY_ACTIONS.NONE);
  now = 2701;
  assert.equal(recovery.observeProbe(running(260)), RECOVERY_ACTIONS.RELOAD_STALLED);
});

test("successful full-confirmed rollover advances generation and clears counters", () => {
  const recovery = new SupervisorRecoveryController();
  recovery.record(RECOVERY_ACTIONS.ROLLOVER_CONVERSATION_FULL, { success: true });
  const status = recovery.status();
  assert.equal(status.conversation_generation, 1);
  assert.equal(status.rollover_failures, 0);
  assert.equal(status.blocked, false);
});

test("successful full rollover suppresses immediate duplicate rollover", () => {
  let now = 10_000;
  const recovery = new SupervisorRecoveryController({
    rolloverCooldownMs: 120_000,
    now: () => now
  });

  recovery.record(RECOVERY_ACTIONS.ROLLOVER_CONVERSATION_FULL, { success: true });
  assert.equal(
    recovery.observeProbe({
      snapshot: { conversationFull: true },
      classification: { observation: "RESPONSE_COMPLETE" }
    }),
    RECOVERY_ACTIONS.NONE
  );

  now += 120_001;
  assert.equal(
    recovery.observeProbe({
      snapshot: { conversationFull: true },
      classification: { observation: "RESPONSE_COMPLETE" }
    }),
    RECOVERY_ACTIONS.ROLLOVER_CONVERSATION_FULL
  );
});

test("repeated full rollovers without a healthy completion fail closed", () => {
  let now = 1_000;
  const recovery = new SupervisorRecoveryController({
    rolloverCooldownMs: 100,
    now: () => now
  });

  recovery.record(RECOVERY_ACTIONS.ROLLOVER_CONVERSATION_FULL, { success: true });
  now += 101;
  assert.equal(
    recovery.observeProbe({
      snapshot: { conversationFull: true },
      classification: { observation: "RESPONSE_COMPLETE" }
    }),
    RECOVERY_ACTIONS.ROLLOVER_CONVERSATION_FULL
  );
  recovery.record(RECOVERY_ACTIONS.ROLLOVER_CONVERSATION_FULL, { success: true });
  now += 101;
  assert.equal(
    recovery.observeProbe({
      snapshot: { conversationFull: true },
      classification: { observation: "UNKNOWN" }
    }),
    RECOVERY_ACTIONS.WAIT_USER_RECOVERY_EXHAUSTED
  );
});


test("canonicalizes transient ChatGPT WEB-prefixed conversation paths", () => {
  const uuid = "6b744b22-161a-4125-80b8-d12f747a72a9";
  assert.equal(
    canonicalConversationPathname(`/c/WEB:${uuid}`),
    `/c/${uuid}`
  );
  assert.deepEqual(
    targetFromUrl(`https://chatgpt.com/c/WEB:${uuid}`),
    { origin: "https://chatgpt.com", pathname: `/c/${uuid}` }
  );
  assert.equal(
    pageMatchesTarget(
      `https://chatgpt.com/c/${uuid}`,
      { origin: "https://chatgpt.com", pathname: `/c/WEB:${uuid}` }
    ),
    true
  );
});


test("transient WEB conversation routes are never persisted as canonical Work targets", () => {
  assert.equal(
    isPersistableConversationUrl("https://chatgpt.com/c/WEB:123e4567-e89b-12d3-a456-426614174000"),
    false
  );
  assert.equal(
    isPersistableConversationUrl("https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174000"),
    true
  );
  assert.equal(isPersistableConversationUrl("https://chatgpt.com/"), false);
});

test("Project/GPT conversation routes share one canonical conversation identity", () => {
  const uuid = "6ab6b646-4804-43ec-99dd-415b1f123456";
  const projectRoute =
    `https://chatgpt.com/g/g-p-6ab5e241a9108191b8c17331941aecf5-magasin-webapp/c/${uuid}`;
  const directRoute = `https://chatgpt.com/c/${uuid}`;

  assert.deepEqual(
    targetFromUrl(projectRoute),
    { origin: "https://chatgpt.com", pathname: `/c/${uuid}` }
  );
  assert.equal(
    pageMatchesTarget(projectRoute, targetFromUrl(directRoute)),
    true
  );
  assert.equal(
    pageMatchesTarget(directRoute, targetFromUrl(projectRoute)),
    true
  );
});

test("nested transient WEB conversation routes are not persistable", () => {
  const uuid = "6ab6b646-4804-43ec-99dd-415b1f123456";
  assert.equal(
    isPersistableConversationUrl(
      `https://chatgpt.com/g/g-p-project/c/WEB:${uuid}`
    ),
    false
  );
});

