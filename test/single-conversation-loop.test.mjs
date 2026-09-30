import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildSingleConversationNextInstruction,
  runSingleConversationCycle,
  runSingleConversationCycles,
  waitForSingleConversationResponse
} from "../src/runtime/single-conversation-loop.mjs";
import {
  beginConversationGeneration,
  ensureSingleConversationState,
  readSingleConversationState
} from "../src/runtime/single-conversation-state.mjs";

async function tempState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-sc004-"));
  const statePath = path.join(root, "single-conversation-state.json");
  await ensureSingleConversationState(statePath, {
    sourceOfTruthUrl: "https://example.com/SOURCE_OF_TRUTH.md",
    sessionId: "sc004-session"
  });
  await beginConversationGeneration(statePath, {
    runtimeId: "chat:test",
    pageId: "page:test"
  });
  return { root, statePath };
}

function baseSnapshot(overrides = {}) {
  return {
    responseRunning: false,
    hasContinueControl: false,
    loginRequired: false,
    hasCaptcha: false,
    conversationAccessDenied: false,
    conversationMissing: false,
    conversationFull: false,
    hasNetworkError: false,
    hasTransientError: false,
    ...overrides
  };
}

test("SC-004 live qualification retries only pre-mutation CDP attach", async () => {
  const source = await fs.readFile(
    new URL("../.github/scripts/supervisor-sc004-live-qualification.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /openAdapterWithBoundedRetry/);
  assert.match(source, /SC004_LIVE_CDP_ATTACH_ATTEMPT/);
  assert.match(source, /attempt <= 2/);
  assert.match(
    source,
    /async function openAdapterWithBoundedRetry\(\)[\s\S]*?await adapter\.open\(\)/
  );
  assert.match(
    source,
    /try \{\s*await openAdapterWithBoundedRetry\(\);\s*let currentPages/
  );
  assert.doesNotMatch(
    source,
    /async function openAdapterWithBoundedRetry\(\)[\s\S]{0,500}await openAdapterWithBoundedRetry\(\)/
  );
});

test("SC-004 qualification maps pre-mutation CDP failure to one dedicated Chrome recovery", async () => {
  const [nodeSource, psSource] = await Promise.all([
    fs.readFile(
      new URL("../.github/scripts/supervisor-sc004-live-qualification.mjs", import.meta.url),
      "utf8"
    ),
    fs.readFile(
      new URL("../.github/scripts/supervisor-sc004-live-qualification.ps1", import.meta.url),
      "utf8"
    )
  ]);

  assert.match(nodeSource, /CDP_ATTACH_RECOVERY_REQUIRED/);
  assert.match(nodeSource, /finalExitCode = 75/);
  assert.match(psSource, /if \(\$nodeExit -eq 75\)/);
  assert.match(psSource, /Restart-QualificationDedicatedChrome/);
  assert.match(psSource, /SC004_QUAL_CDP_RECOVERY_RESTART=True/);
  assert.match(psSource, /browser_profile/);
  assert.match(psSource, /SC004_QUAL_CDP_RECOVERY_RETRY_EXIT/);
});

test("SC-004 qualification instruction is read-only and correlation-bound", () => {
  const message = buildSingleConversationNextInstruction({
    sourceOfTruthUrl: "https://example.com/SOURCE_OF_TRUTH.md",
    messageId: "qual-cycle",
    qualificationOnly: true
  });
  assert.match(message, /QUALIFICATION ONLY/);
  assert.match(message, /read-only web access/i);
  assert.match(message, /do not write to external systems/i);
  assert.match(message, /Architecture generation/);
  assert.match(message, /End exactly: MAGASIN_CYCLE_CORRELATION_V1 qual-cycle/);
  assert.doesNotMatch(message, /Do exactly one bounded next unit/);
});

test("SC-004 next instruction re-syncs Source of Truth before next work", () => {
  const message = buildSingleConversationNextInstruction({
    sourceOfTruthUrl: "https://example.com/SOURCE_OF_TRUTH.md",
    messageId: "cycle-1"
  });
  assert.match(message, /^MAGASIN_SINGLE_CONVERSATION_NEXT_V1/);
  assert.match(message, /SOT=https:\/\/example\.com\/SOURCE_OF_TRUTH\.md/);
  assert.match(message, /Re-read SOT from the beginning/);
  assert.match(message, /sole project authority/);
  assert.match(message, /one bounded next unit/);
  assert.match(message, /MAGASIN_CYCLE_CORRELATION_V1 cycle-1/);
});

test("SC-004 clicks explicit Continue generating before accepting completion", async () => {
  const { root, statePath } = await tempState();
  let probe = 0;
  let continueClicks = 0;
  try {
    const adapter = {
      async probePage() {
        probe += 1;
        if (probe === 1) return { snapshot: baseSnapshot({ hasContinueControl: true }) };
        if (probe === 2) return { snapshot: baseSnapshot({ responseRunning: true }) };
        return { snapshot: baseSnapshot() };
      }
    };
    const response = await waitForSingleConversationResponse({
      adapter,
      page: { async waitForTimeout() {} },
      statePath,
      baselineAssistantTurnId: "assistant-old",
      captureTurn: async (_page, role) => role === "assistant" && probe >= 3
        ? { turn_id: "assistant-new", text: "done", digest: "a-new" }
        : null,
      executeUiDecision: async ({ decision, dryRun }) => {
        assert.equal(decision.action, "CONTINUE");
        assert.equal(dryRun, false);
        continueClicks += 1;
        return { executed: true, target: "SAFE_CONTINUE_CONTROL" };
      },
      pollMs: 1
    });

    assert.equal(response.status, "RESPONSE_COMPLETE");
    assert.equal(response.continue_clicks, 1);
    assert.equal(continueClicks, 1);
    const durable = await readSingleConversationState(statePath);
    assert.equal(durable.automation.continue_click_count, 1);
    assert.equal(durable.outbound.state, "RESPONSE_COMPLETE");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-004 never sends new work while prior response still needs Continue", async () => {
  const { root, statePath } = await tempState();
  let probe = 0;
  let sentAtProbe = null;
  try {
    const adapter = {
      async probePage() {
        probe += 1;
        if (probe <= 2) return { snapshot: baseSnapshot({ hasContinueControl: true }) };
        if (probe === 3) return { snapshot: baseSnapshot({ responseRunning: true }) };
        return { snapshot: baseSnapshot() };
      }
    };
    let assistantCaptureCount = 0;
    const result = await runSingleConversationCycle({
      adapter,
      page: { async waitForTimeout() {} },
      statePath,
      messageId: "cycle-safe-order",
      captureTurn: async (_page, role) => {
        if (role === "assistant") {
          assistantCaptureCount += 1;
          if (probe >= 4) {
            const afterSend = sentAtProbe !== null;
            return {
              turn_id: afterSend ? "new-final" : "prior-final",
              text: afterSend
                ? "assistant MAGASIN_CYCLE_CORRELATION_V1 cycle-safe-order"
                : "assistant",
              digest: afterSend ? "a-new" : "a-prior"
            };
          }
          return null;
        }
        if (role === "user" && sentAtProbe !== null) {
          return { turn_id: "user-new", text: "sent", digest: "u1" };
        }
        return null;
      },
      executeUiDecision: async () => ({
        executed: true,
        target: "SAFE_CONTINUE_CONTROL"
      }),
      sendInstruction: async () => {
        sentAtProbe = probe;
        return {
          executed: true,
          user_turn_evidence: "matching-user-turn-observed"
        };
      },
      pollMs: 1,
      timeoutMs: 1_000
    });
    assert.ok(sentAtProbe >= 4);
    assert.equal(result.send.executed, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-004 performs multiple sequential cycles in one active conversation", async () => {
  const { root, statePath } = await tempState();
  let sendCount = 0;
  let userTurn = 0;
  let assistantTurn = 0;
  let waitingForResponse = false;
  try {
    const adapter = {
      async probePage() {
        if (waitingForResponse) {
          waitingForResponse = false;
          return {
            snapshot: baseSnapshot({
              responseRunning: true
            })
          };
        }
        return {
          snapshot: baseSnapshot({
            responseRunning: false
          })
        };
      }
    };
    const captureTurn = async (_page, role) => {
      if (role === "user") {
        return userTurn
          ? { turn_id: "u-" + userTurn, text: "user", digest: "u" + userTurn }
          : null;
      }
      if (!waitingForResponse && userTurn > assistantTurn) {
        assistantTurn += 1;
      }
      return assistantTurn
        ? {
            turn_id: "a-" + assistantTurn,
            text:
              "assistant MAGASIN_CYCLE_CORRELATION_V1 cycle-" +
              assistantTurn,
            digest: "a" + assistantTurn
          }
        : null;
    };

    const results = await runSingleConversationCycles({
      cycles: 3,
      adapter,
      page: { async waitForTimeout() {} },
      statePath,
      captureTurn,
      messageIdFactory: (index) => "cycle-" + (index + 1),
      sendInstruction: async () => {
        sendCount += 1;
        userTurn += 1;
        waitingForResponse = true;
        return {
          executed: true,
          user_turn_evidence: "matching-user-turn-observed"
        };
      },
      pollMs: 1,
      timeoutMs: 1_000
    });

    assert.equal(results.length, 3);
    assert.equal(sendCount, 3);
    const durable = await readSingleConversationState(statePath);
    assert.equal(durable.conversation.generation, 1);
    assert.equal(durable.conversation.status, "ACTIVE");
    assert.equal(durable.outbound.state, "RESPONSE_COMPLETE");
    assert.equal(durable.source_of_truth.sync_status, "VERIFIED");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-004 waits through false-idle partial assistant text until cycle correlation appears", async () => {
  const { root, statePath } = await tempState();
  let captures = 0;
  try {
    const response = await waitForSingleConversationResponse({
      adapter: {
        async probePage() {
          return { snapshot: baseSnapshot({ responseRunning: false }) };
        }
      },
      page: { async waitForTimeout() {} },
      statePath,
      baselineAssistantTurnId: "assistant-old",
      expectedAssistantMarker: "MAGASIN_CYCLE_CORRELATION_V1 cycle-false-idle",
      assistantSettleMs: 10_000,
      captureTurn: async (_page, role) => {
        assert.equal(role, "assistant");
        captures += 1;
        if (captures === 1) {
          return {
            turn_id: "assistant-live",
            text: "Architecture generation: SINGLE_CONVERSATION_V1",
            digest: "partial"
          };
        }
        return {
          turn_id: "assistant-live",
          text:
            "Architecture generation: SINGLE_CONVERSATION_V1\n" +
            "MAGASIN_CYCLE_CORRELATION_V1 cycle-false-idle",
          digest: "complete"
        };
      },
      pollMs: 1,
      timeoutMs: 1_000
    });
    assert.equal(captures, 2);
    assert.equal(response.status, "RESPONSE_COMPLETE");
    assert.equal(response.marker_confirmed, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-013 stable intermediate assistant text without cycle marker stays in-flight", async () => {
  const { root, statePath } = await tempState();
  try {
    await assert.rejects(
      waitForSingleConversationResponse({
        adapter: {
          async probePage() {
            return { snapshot: baseSnapshot({ responseRunning: false }) };
          }
        },
        page: { async waitForTimeout() {} },
        statePath,
        baselineAssistantTurnId: "assistant-old",
        expectedAssistantMarker: "MAGASIN_CYCLE_CORRELATION_V1 sc013-long-task",
        assistantSettleMs: 1,
        captureTurn: async () => ({
          turn_id: "assistant-working",
          text: "I am still working with GitHub and Supabase.",
          digest: "stable-intermediate"
        }),
        pollMs: 1,
        timeoutMs: 25
      }),
      (error) => error?.code === "RESPONSE_TIMEOUT"
    );

    const durable = await readSingleConversationState(statePath);
    assert.notEqual(durable.outbound.state, "RESPONSE_COMPLETE");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-008 correlated response wins over a stale transient banner", async () => {
  const { root, statePath } = await tempState();
  try {
    const marker = "MAGASIN_CYCLE_CORRELATION_V1 sc008-stale-banner";
    let probes = 0;
    const response = await waitForSingleConversationResponse({
      adapter: {
        async probePage() {
          probes += 1;
          return {
            snapshot: baseSnapshot({
              responseRunning: false,
              hasTransientError: true
            })
          };
        }
      },
      page: { async waitForTimeout() {} },
      statePath,
      baselineAssistantTurnId: "assistant-old",
      expectedAssistantMarker: marker,
      captureTurn: async () => ({
        turn_id: "assistant-new",
        text: "Architecture generation: SINGLE_CONVERSATION_V1\n" + marker,
        digest: "correlated-complete"
      }),
      transientFailureThreshold: 3,
      pollMs: 1,
      timeoutMs: 1_000
    });

    assert.equal(response.status, "RESPONSE_COMPLETE");
    assert.equal(response.marker_confirmed, true);
    assert.equal(response.stale_transient_banner_ignored, true);
    assert.equal(probes, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-008 response wait tolerates bounded transient snapshots but fails when repeated", async () => {
  const { root, statePath } = await tempState();
  try {
    let probes = 0;
    const recovered = await waitForSingleConversationResponse({
      adapter: {
        async probePage() {
          probes += 1;
          if (probes <= 2) {
            return {
              snapshot: baseSnapshot({
                responseRunning: false,
                hasTransientError: true
              })
            };
          }
          return { snapshot: baseSnapshot({ responseRunning: false }) };
        }
      },
      page: { async waitForTimeout() {} },
      statePath,
      baselineAssistantTurnId: "assistant-old",
      captureTurn: async () => ({
        turn_id: "assistant-new",
        text: "complete after transient",
        digest: "done"
      }),
      transientFailureThreshold: 3,
      pollMs: 1,
      timeoutMs: 1_000
    });
    assert.equal(recovered.status, "RESPONSE_COMPLETE");
    assert.equal(probes, 3);

    await assert.rejects(
      waitForSingleConversationResponse({
        adapter: {
          async probePage() {
            return {
              snapshot: baseSnapshot({
                responseRunning: false,
                hasTransientError: true
              })
            };
          }
        },
        page: { async waitForTimeout() {} },
        statePath,
        transientFailureThreshold: 3,
        pollMs: 1,
        timeoutMs: 1_000
      }),
      (error) => error?.code === "TRANSIENT_ERROR"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-004 auth/captcha boundary blocks without a new send", async () => {
  const { root, statePath } = await tempState();
  let sends = 0;
  try {
    await assert.rejects(
      runSingleConversationCycle({
        adapter: {
          async probePage() {
            return { snapshot: baseSnapshot({ hasCaptcha: true }) };
          }
        },
        page: { async waitForTimeout() {} },
        statePath,
        sendInstruction: async () => {
          sends += 1;
          return { executed: true };
        }
      }),
      /CAPTCHA/
    );
    assert.equal(sends, 0);
    const durable = await readSingleConversationState(statePath);
    assert.equal(durable.automation.status, "BLOCKED");
    assert.equal(durable.automation.reason, "CAPTCHA_REQUIRED");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
