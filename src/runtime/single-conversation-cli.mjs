import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { ChatGptUiAdapter } from "../ui/playwright-adapter.mjs";
import { captureLatestRoleTurn } from "../ui/latest-turn.mjs";
import { createNewChatAndBootstrap } from "./single-conversation-bootstrap.mjs";
import {
  buildSingleConversationNextInstruction,
  waitForSingleConversationResponse
} from "./single-conversation-loop.mjs";
import {
  recoverDisposableConversationIfNeeded,
  replaceDisposableConversation
} from "./single-conversation-rollover.mjs";
import {
  ensureSingleConversationState,
  readSingleConversationState
} from "./single-conversation-state.mjs";
import {
  markExactOnceEnqueued,
  markExactOnceResponseComplete,
  markExactOnceVerified,
  prepareExactOnceOutbound,
  reconcileExactOnceOutbound
} from "./single-conversation-transaction.mjs";

function parseArgs(argv) {
  const out = {
    statePath: null,
    sourceOfTruthUrl: null,
    cdpUrl: null,
    execute: false,
    qualificationOnly: false,
    pollMs: 2_000,
    responseTimeoutMs: 180_000,
    maxCycles: 0
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--state") out.statePath = argv[++i];
    else if (arg === "--source-of-truth") out.sourceOfTruthUrl = argv[++i];
    else if (arg === "--cdp-url") out.cdpUrl = argv[++i];
    else if (arg === "--poll-ms") out.pollMs = Number(argv[++i]);
    else if (arg === "--response-timeout-ms") out.responseTimeoutMs = Number(argv[++i]);
    else if (arg === "--max-cycles") out.maxCycles = Number(argv[++i]);
    else if (arg === "--qualification-only") out.qualificationOnly = true;
    else if (arg === "--execute") out.execute = true;
    else throw new Error("unknown argument: " + arg);
  }
  return out;
}

function terminalAnswer(text) {
  const value = String(text || "");
  if (/\b(?:WAIT_OWNER|OWNER_REQUIRED|BLOCKED)\b/i.test(value)) return "WAIT_OWNER";
  if (/\b(?:PROJECT_DONE|PROJECT_COMPLETE)\b/i.test(value)) return "DONE";
  return null;
}

export async function boundedRuntimeOperation(
  label,
  operation,
  { timeoutMs = 12_000 } = {}
) {
  if (typeof operation !== "function") {
    throw new TypeError("operation is required");
  }
  const limit = Math.max(1, Number(timeoutMs || 12_000));
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(
            new Error(`single-conversation runtime stalled during ${label}`),
            {
              code: "SINGLE_CONVERSATION_RUNTIME_STALL",
              stall_stage: String(label || "UNKNOWN")
            }
          ));
        }, limit);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runtimePollDelay(ms, {
  setTimeoutImpl = setTimeout
} = {}) {
  const delay = Math.max(0, Number(ms || 0));
  if (delay <= 0) return;
  await new Promise((resolve) => {
    setTimeoutImpl(resolve, delay);
  });
}

export async function captureBaselineTurnBounded(
  page,
  role,
  { timeoutMs = 10_000 } = {}
) {
  try {
    return await boundedRuntimeOperation(
      `CAPTURE_BASELINE_${String(role || "").toUpperCase()}`,
      () => captureLatestRoleTurn(page, role),
      { timeoutMs }
    );
  } catch (error) {
    if (error?.code === "SINGLE_CONVERSATION_RUNTIME_STALL") throw error;
    return null;
  }
}

async function settleTransactionResponse({
  adapter,
  page,
  statePath,
  messageId,
  message,
  baselineAssistantTurnId,
  timeoutMs,
  pollMs
}) {
  const response = await waitForSingleConversationResponse({
    adapter,
    page,
    statePath,
    baselineAssistantTurnId,
    expectedAssistantMarker: `MAGASIN_CYCLE_CORRELATION_V1 ${messageId}`,
    timeoutMs,
    pollMs,
    maxContinueClicks: 8
  });
  if (response?.status !== "RESPONSE_COMPLETE") {
    throw new Error("single-conversation response did not complete");
  }
  await markExactOnceResponseComplete(statePath, {
    messageId,
    message,
    assistantTurnId: response.assistant_turn?.turn_id || null
  });
  await markExactOnceVerified(statePath, { messageId, message });
  return response;
}

export async function runSingleConversationRuntime({
  adapter,
  statePath,
  sourceOfTruthUrl,
  execute = false,
  qualificationOnly = false,
  pollMs = 2_000,
  responseTimeoutMs = 180_000,
  maxCycles = 0
} = {}) {
  if (!adapter) throw new Error("adapter is required");
  if (!statePath) throw new Error("statePath is required");
  if (!sourceOfTruthUrl) throw new Error("sourceOfTruthUrl is required");

  const state = await ensureSingleConversationState(statePath, {
    sourceOfTruthUrl,
    projectId: "LIVE"
  });
  if (!execute) {
    return {
      status: "READY",
      mode: state.mode,
      chat_url_required: false
    };
  }

  await adapter.open();
  let page = adapter.getActivePage();
  let current = await readSingleConversationState(statePath);

  if (current.conversation.status !== "ACTIVE") {
    const bootstrap = await createNewChatAndBootstrap({
      adapter,
      statePath,
      sourceOfTruthUrl,
      projectId: "LIVE",
      qualificationOnly,
      forceNewPage: true,
      timeoutMs: responseTimeoutMs,
      pollMs: Math.min(750, Math.max(100, pollMs))
    });
    page = bootstrap.page;
  } else {
    // Durable conversation identity intentionally contains no URL. On process
    // restart, a browser page cannot be authoritatively rebound from local
    // state alone. Fail-safe replacement rehydrates from SOT before new work.
    const replacement = await replaceDisposableConversation({
      adapter,
      page,
      statePath,
      reason: "RUNTIME_RESTART_AMBIGUOUS_PAGE_IDENTITY",
      sourceOfTruthUrl,
      projectId: "LIVE",
      qualificationOnly,
      timeoutMs: responseTimeoutMs,
      pollMs: Math.min(750, Math.max(100, pollMs))
    });
    page = replacement.page;
  }

  let cycles = 0;
  while (maxCycles <= 0 || cycles < maxCycles) {
    const recovery = await recoverDisposableConversationIfNeeded({
      adapter,
      page,
      statePath,
      sourceOfTruthUrl,
      projectId: "LIVE",
      probeTimeoutMs: Math.min(12_000, Math.max(3_000, responseTimeoutMs)),
      timeoutMs: responseTimeoutMs,
      pollMs: Math.min(750, Math.max(100, pollMs))
    });
    page = recovery.page;

    const before = await readSingleConversationState(statePath);
    const messageId = randomUUID();
    const message = buildSingleConversationNextInstruction({
      sourceOfTruthUrl: before.source_of_truth.url,
      messageId,
      qualificationOnly
    });
    const baselineUser = await captureBaselineTurnBounded(page, "user");
    const baselineAssistant = await captureBaselineTurnBounded(page, "assistant");

    await prepareExactOnceOutbound(statePath, {
      messageId,
      message,
      kind: "SOURCE_OF_TRUTH_NEXT_WORK",
      baselineUserTurnId: baselineUser?.turn_id || null
    });
    await markExactOnceEnqueued(statePath, { messageId, message });

    const delivery = await reconcileExactOnceOutbound({
      statePath,
      page,
      messageId,
      message,
      maxSafeRetries: 1,
      reconciliationProbes: 4,
      reconciliationPollMs: Math.min(500, Math.max(100, pollMs))
    });
    if (!["SEND", "SAFE_RETRY_SENT", "NO_SEND"].includes(delivery.action)) {
      throw new Error("single-conversation transaction did not reach delivery evidence");
    }

    const response = await settleTransactionResponse({
      adapter,
      page,
      statePath,
      messageId,
      message,
      baselineAssistantTurnId: baselineAssistant?.turn_id || null,
      timeoutMs: responseTimeoutMs,
      pollMs: Math.min(750, Math.max(100, pollMs))
    });
    cycles += 1;

    const terminal = terminalAnswer(response.assistant_turn?.text);
    if (terminal) {
      return {
        status: terminal,
        cycles,
        generation: (await readSingleConversationState(statePath)).conversation.generation
      };
    }

    // NEXT_WORK pacing must not depend on a live Playwright Page. A wedged
    // page/CDP transport previously left durable state at VERIFIED/NEXT_WORK
    // forever even though the Node process remained alive.
    await runtimePollDelay(pollMs);
  }

  const finalState = await readSingleConversationState(statePath);
  return {
    status: "MAX_CYCLES",
    cycles,
    generation: finalState.conversation.generation
  };
}

const isMain =
  process.argv[1] &&
  import.meta.url === new URL("file://" + path.resolve(process.argv[1]).replace(/\\/g, "/")).href;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.statePath) throw new Error("--state is required");
  if (!args.sourceOfTruthUrl) throw new Error("--source-of-truth is required");
  if (!args.cdpUrl) throw new Error("--cdp-url is required");

  const adapter = new ChatGptUiAdapter({
    cdpUrl: args.cdpUrl,
    settleMs: 400,
    actionTimeoutMs: 10_000,
    timeoutMs: 45_000
  });

  let exitCode = 0;
  try {
    const result = await runSingleConversationRuntime({
      adapter,
      statePath: path.resolve(args.statePath),
      sourceOfTruthUrl: args.sourceOfTruthUrl,
      execute: args.execute,
      qualificationOnly: args.qualificationOnly,
      pollMs: args.pollMs,
      responseTimeoutMs: args.responseTimeoutMs,
      maxCycles: args.maxCycles
    });
    console.log("SINGLE_CONVERSATION_RUNTIME_STATUS=" + result.status);
    console.log("SINGLE_CONVERSATION_CHAT_URL_REQUIRED=False");
    if (result.generation !== undefined) {
      console.log("SINGLE_CONVERSATION_GENERATION=" + result.generation);
    }
  } catch (error) {
    const code = String(error?.code || "");
    console.error("SINGLE_CONVERSATION_RUNTIME_ERROR=" + (code || error?.name || "Error"));
    if (error?.stall_stage) {
      console.error("SINGLE_CONVERSATION_RUNTIME_STALL_STAGE=" + error.stall_stage);
    }
    exitCode = [
      "SINGLE_CONVERSATION_RUNTIME_STALL",
      "DISPOSABLE_CONVERSATION_PROBE_TIMEOUT"
    ].includes(code) ? 75 : 1;
  } finally {
    await adapter.close().catch(() => {});
  }

  if (exitCode !== 0) {
    // Exit explicitly because a wedged CDP command may otherwise retain an
    // attached Playwright transport handle. Exit 75 asks the Windows wrapper
    // to restart only the dedicated Supervisor Chrome and rehydrate safely.
    process.exit(exitCode);
  }
}
