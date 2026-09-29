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
  readSingleConversationState,
  writeSingleConversationState
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
    uiStepTimeoutMs: 15_000,
    maxCycles: 0
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--state") out.statePath = argv[++i];
    else if (arg === "--source-of-truth") out.sourceOfTruthUrl = argv[++i];
    else if (arg === "--cdp-url") out.cdpUrl = argv[++i];
    else if (arg === "--poll-ms") out.pollMs = Number(argv[++i]);
    else if (arg === "--response-timeout-ms") out.responseTimeoutMs = Number(argv[++i]);
    else if (arg === "--ui-step-timeout-ms") out.uiStepTimeoutMs = Number(argv[++i]);
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

export function nativeRuntimeSleep(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export async function withRuntimeDeadline(label, action, timeoutMs = 15_000) {
  if (typeof action !== "function") throw new TypeError("action is required");
  const step = String(label || "RUNTIME_UI_STEP").trim() || "RUNTIME_UI_STEP";
  const limit = Math.max(100, Number(timeoutMs) || 15_000);
  let timer = null;
  return new Promise((resolve, reject) => {
    let settled = false;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`runtime UI step timed out: ${step}`);
      error.code = "RUNTIME_UI_STEP_TIMEOUT";
      error.step = step;
      reject(error);
    }, limit);

    Promise.resolve()
      .then(action)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      );
  });
}

async function captureBaselineTurn(page, role, timeoutMs) {
  try {
    return await withRuntimeDeadline(
      `NEXT_WORK_CAPTURE_${String(role).toUpperCase()}`,
      () => captureLatestRoleTurn(page, role),
      timeoutMs
    );
  } catch (error) {
    if (error?.code === "RUNTIME_UI_STEP_TIMEOUT") throw error;
    return null;
  }
}

async function markRuntimeRecoveryRequested(statePath, error) {
  const state = await readSingleConversationState(statePath);
  const at = new Date().toISOString();
  state.automation.status = "RUNNING";
  state.automation.phase = "RECOVERY_REQUESTED";
  state.automation.reason = [
    String(error?.code || "RUNTIME_RECOVERY"),
    String(error?.step || "")
  ].filter(Boolean).join(":").slice(0, 300);
  state.automation.updated_at = at;
  return writeSingleConversationState(statePath, state, { now: () => at });
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
  uiStepTimeoutMs = 15_000,
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
      timeoutMs: responseTimeoutMs,
      pollMs: Math.min(750, Math.max(100, pollMs)),
      probePage: (candidate) => withRuntimeDeadline(
        "NEXT_WORK_PROBE_PAGE",
        () => adapter.probePage(candidate),
        uiStepTimeoutMs
      )
    });
    page = recovery.page;

    const before = await readSingleConversationState(statePath);
    const messageId = randomUUID();
    const message = buildSingleConversationNextInstruction({
      sourceOfTruthUrl: before.source_of_truth.url,
      messageId,
      qualificationOnly
    });
    const baselineUser = await captureBaselineTurn(page, "user", uiStepTimeoutMs);
    const baselineAssistant = await captureBaselineTurn(page, "assistant", uiStepTimeoutMs);

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

    if (pollMs > 0) {
      await nativeRuntimeSleep(pollMs);
    }
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

  let finalExitCode = 0;
  try {
    const result = await runSingleConversationRuntime({
      adapter,
      statePath: path.resolve(args.statePath),
      sourceOfTruthUrl: args.sourceOfTruthUrl,
      execute: args.execute,
      qualificationOnly: args.qualificationOnly,
      pollMs: args.pollMs,
      responseTimeoutMs: args.responseTimeoutMs,
      uiStepTimeoutMs: args.uiStepTimeoutMs,
      maxCycles: args.maxCycles
    });
    console.log("SINGLE_CONVERSATION_RUNTIME_STATUS=" + result.status);
    console.log("SINGLE_CONVERSATION_CHAT_URL_REQUIRED=False");
    if (result.generation !== undefined) {
      console.log("SINGLE_CONVERSATION_GENERATION=" + result.generation);
    }
  } catch (error) {
    console.error("SINGLE_CONVERSATION_RUNTIME_ERROR_CODE=" + String(error?.code || "RUNTIME_ERROR"));
    console.error("SINGLE_CONVERSATION_RUNTIME_ERROR_STEP=" + String(error?.step || ""));
    if (error?.code === "RUNTIME_UI_STEP_TIMEOUT") {
      await markRuntimeRecoveryRequested(path.resolve(args.statePath), error).catch(() => {});
      console.error("SINGLE_CONVERSATION_RUNTIME_RECOVERY_REQUESTED=True");
      finalExitCode = 75;
    } else {
      finalExitCode = 1;
    }
  } finally {
    await withRuntimeDeadline("ADAPTER_CLOSE", () => adapter.close(), 1_500).catch(() => {});
  }
  process.exit(finalExitCode);
}
