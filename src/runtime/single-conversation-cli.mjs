import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { ChatGptUiAdapter } from "../ui/playwright-adapter.mjs";
import { captureLatestRoleTurn } from "../ui/latest-turn.mjs";
import {
  createNewChatAndBootstrap,
  opaqueRuntimeIdentity
} from "./single-conversation-bootstrap.mjs";
import {
  buildSingleConversationNextInstruction,
  buildSingleConversationTaskDiscoveryInstruction,
  buildSingleConversationTaskInstruction,
  parseTaskControl,
  waitForSingleConversationResponse
} from "./single-conversation-loop.mjs";
import {
  recoverDisposableConversationIfNeeded
} from "./single-conversation-rollover.mjs";
import {
  ensureSingleConversationState,
  readSingleConversationState
} from "./single-conversation-state.mjs";
import {
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
    // SC-011: allow one direct ChatGPT turn to remain observable for long E2E work.
    responseTimeoutMs: 5_400_000,
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

export async function waitForNextCycleDelay(
  delayMs,
  { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}
) {
  const ms = Math.max(0, Number(delayMs) || 0);
  if (ms <= 0) return;
  await sleep(ms);
}

export async function boundedRuntimeStep(
  label,
  operation,
  {
    timeoutMs = 15_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = {}
) {
  if (typeof operation !== "function") {
    throw new TypeError("operation is required");
  }
  const stage = String(label || "RUNTIME_UI_STEP").trim() || "RUNTIME_UI_STEP";
  const budget = Math.max(1, Number(timeoutMs) || 15_000);
  let timer = null;

  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimer(() => {
          const error = Object.assign(
            new Error(`runtime UI/CDP step timed out: ${stage}`),
            {
              code: "CDP_RECOVERY_REQUIRED",
              runtime_stage: stage
            }
          );
          reject(error);
        }, budget);
      })
    ]);
  } finally {
    if (timer) clearTimer(timer);
  }
}

async function boundedRuntimeCleanup(action, timeoutMs = 1_500) {
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise((resolve) => {
        timer = setTimeout(resolve, Math.max(1, Number(timeoutMs) || 1_500));
        timer.unref?.();
      })
    ]);
  } catch {
    // Cleanup must never prevent deterministic wrapper recovery.
  } finally {
    if (timer) clearTimeout(timer);
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


function safeRebindOutboundState(state) {
  return ["RESPONSE_COMPLETE", "VERIFIED"].includes(
    String(state?.outbound?.state || "").toUpperCase()
  );
}

async function probeReusableConversationPage(adapter, page) {
  if (!page) return null;
  const probe = await adapter.probePage(page).catch(() => null);
  const snapshot = probe?.snapshot || {};
  if (
    !probe ||
    snapshot.loginRequired ||
    snapshot.hasCaptcha ||
    snapshot.conversationMissing ||
    snapshot.conversationAccessDenied ||
    snapshot.pageClosed
  ) {
    return null;
  }
  return probe;
}

function runtimeIdMatchesPage(page, expected) {
  try {
    return opaqueRuntimeIdentity(page?.url?.()) === expected;
  } catch {
    return false;
  }
}

function isBlankHomePage(page) {
  try {
    const url = new URL(String(page?.url?.() || ""));
    return url.origin === "https://chatgpt.com" && url.pathname === "/";
  } catch {
    return false;
  }
}

async function recoverConversationFromRecentSidebar({
  adapter,
  expected,
  discoveryPage,
  retries = 60,
  pollMs = 500
} = {}) {
  if (
    !discoveryPage ||
    typeof adapter?.listRecentConversationUrls !== "function" ||
    typeof adapter?.reopenTargetPage !== "function"
  ) {
    return null;
  }

  for (let attempt = 0; attempt < Math.max(1, Number(retries) || 1); attempt += 1) {
    const urls = await adapter
      .listRecentConversationUrls(discoveryPage, { limit: 50 })
      .catch(() => []);
    const matches = [...new Set(
      (Array.isArray(urls) ? urls : []).filter(
        (url) => opaqueRuntimeIdentity(url) === expected
      )
    )];

    if (matches.length > 1) return null;
    if (matches.length === 1) {
      const recovered = await adapter.reopenTargetPage(matches[0]).catch(() => null);
      if (!recovered || !runtimeIdMatchesPage(recovered, expected)) return null;
      return recovered;
    }

    if (attempt + 1 < Math.max(1, Number(retries) || 1)) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(50, Number(pollMs) || 500))
      );
    }
  }

  return null;
}

export async function resumeExistingConversationPage({
  adapter,
  state,
  recoveryRetries = 60,
  recoveryPollMs = 500
} = {}) {
  if (!adapter || !state) return null;
  if (String(state?.conversation?.status || "").toUpperCase() !== "ACTIVE") {
    return null;
  }
  if (!safeRebindOutboundState(state)) return null;

  const expected = String(state?.conversation?.runtime_id || "").trim();
  if (!expected) return null;

  const pages = typeof adapter.getChatGptPages === "function"
    ? adapter.getChatGptPages()
    : [];
  const matches = pages.filter((candidate) =>
    runtimeIdMatchesPage(candidate, expected)
  );

  let page = null;
  let recoveredFrom = null;
  let discoveryPage = null;

  if (matches.length === 1) {
    page = matches[0];
    recoveredFrom = "OPEN_PAGE";
  } else if (matches.length > 1) {
    return null;
  } else {
    discoveryPage = typeof adapter.getActivePage === "function"
      ? adapter.getActivePage()
      : pages.at(-1) || null;
    page = await recoverConversationFromRecentSidebar({
      adapter,
      expected,
      discoveryPage,
      retries: recoveryRetries,
      pollMs: recoveryPollMs
    });
    if (!page) return null;
    recoveredFrom = "RECENT_SIDEBAR";
  }

  const selected = typeof adapter.setActivePage === "function"
    ? adapter.setActivePage(page)
    : page;
  if (!(await probeReusableConversationPage(adapter, selected))) return null;

  if (
    recoveredFrom === "RECENT_SIDEBAR" &&
    discoveryPage &&
    discoveryPage !== selected &&
    isBlankHomePage(discoveryPage) &&
    typeof adapter.closePage === "function"
  ) {
    await adapter.closePage(discoveryPage).catch(() => {});
  }

  return {
    page: selected,
    runtime_id: expected,
    generation: Number(state.conversation?.generation || 0),
    recovered_from: recoveredFrom
  };
}

async function captureProtocolBaselines(page) {
  const baselineUser = await boundedRuntimeStep(
    "TASK_CAPTURE_USER",
    () => captureLatestRoleTurn(page, "user"),
    { timeoutMs: 10_000 }
  ).catch((error) => {
    if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
    return null;
  });
  const baselineAssistant = await boundedRuntimeStep(
    "TASK_CAPTURE_ASSISTANT",
    () => captureLatestRoleTurn(page, "assistant"),
    { timeoutMs: 10_000 }
  ).catch((error) => {
    if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
    return null;
  });
  return { baselineUser, baselineAssistant };
}

async function sendProtocolMessage({
  adapter,
  page,
  statePath,
  message,
  messageId,
  kind,
  responseTimeoutMs,
  pollMs
}) {
  const { baselineUser, baselineAssistant } =
    await captureProtocolBaselines(page);

  await prepareExactOnceOutbound(statePath, {
    messageId,
    message,
    kind,
    baselineUserTurnId: baselineUser?.turn_id || null
  });

  // PREPARED is the only correct state before first reconciliation. The
  // reconciler persists ENQUEUED immediately before browser actuation, which
  // preserves exact-once crash safety without making a fresh transaction look
  // like an ambiguous prior send.
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

  return settleTransactionResponse({
    adapter,
    page,
    statePath,
    messageId,
    message,
    baselineAssistantTurnId: baselineAssistant?.turn_id || null,
    timeoutMs: responseTimeoutMs,
    pollMs: Math.min(750, Math.max(100, pollMs))
  });
}

async function discoverTaskControl({
  adapter,
  page,
  statePath,
  sourceOfTruthUrl,
  responseTimeoutMs,
  pollMs
}) {
  const messageId = randomUUID();
  const message = buildSingleConversationTaskDiscoveryInstruction({
    sourceOfTruthUrl,
    messageId
  });
  const response = await sendProtocolMessage({
    adapter,
    page,
    statePath,
    message,
    messageId,
    kind: "SOURCE_OF_TRUTH_TASK_DISCOVERY",
    responseTimeoutMs,
    pollMs
  });
  return parseTaskControl(response.assistant_turn?.text);
}

export async function runSingleConversationRuntime({
  adapter,
  statePath,
  sourceOfTruthUrl,
  execute = false,
  qualificationOnly = false,
  pollMs = 2_000,
  responseTimeoutMs = 5_400_000,
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
  let bootstrapResponse = null;

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
    bootstrapResponse = bootstrap.response;
  } else {
    const rebound = await resumeExistingConversationPage({
      adapter,
      state: current
    });
    if (rebound?.page) {
      page = rebound.page;
    } else {
      // Restart continuity must fail closed. Missing runtime identity evidence
      // is not proof that the active conversation is unusable, so never retire,
      // close, or replace it merely because Chrome/sidebar recovery has not
      // re-established the exact opaque identity yet. The wrapper may retry
      // this read-only rebind path; replacement remains reserved for positive
      // unusable/full/error evidence detected by the normal recovery probe.
      throw Object.assign(
        new Error("active conversation identity could not be verified after runtime restart"),
        { code: "RUNTIME_RESTART_IDENTITY_NOT_VERIFIED" }
      );
    }
  }

  let cycles = 0;

  if (qualificationOnly) {
    while (maxCycles <= 0 || cycles < maxCycles) {
      const recovery = await boundedRuntimeStep(
        "NEXT_WORK_RECOVERY_PROBE",
        () => recoverDisposableConversationIfNeeded({
          adapter,
          page,
          statePath,
          sourceOfTruthUrl,
          projectId: "LIVE",
          qualificationOnly: true,
          timeoutMs: responseTimeoutMs,
          pollMs: Math.min(750, Math.max(100, pollMs))
        }),
        { timeoutMs: 15_000 }
      );
      page = recovery.page;

      const before = await readSingleConversationState(statePath);
      const messageId = randomUUID();
      const message = buildSingleConversationNextInstruction({
        sourceOfTruthUrl: before.source_of_truth.url,
        messageId,
        qualificationOnly: true
      });
      await sendProtocolMessage({
        adapter,
        page,
        statePath,
        message,
        messageId,
        kind: "SOURCE_OF_TRUTH_NEXT_WORK",
        responseTimeoutMs,
        pollMs
      });
      cycles += 1;
      await waitForNextCycleDelay(pollMs);
    }

    const finalState = await readSingleConversationState(statePath);
    return {
      status: "MAX_CYCLES",
      cycles,
      generation: finalState.conversation.generation
    };
  }

  let control = null;
  if (bootstrapResponse?.assistant_turn?.text) {
    control = parseTaskControl(bootstrapResponse.assistant_turn.text);
  } else {
    const latestAssistant = await captureLatestRoleTurn(page, "assistant")
      .catch(() => null);
    try {
      control = parseTaskControl(latestAssistant?.text);
    } catch (error) {
      if (error?.code !== "TASK_PROTOCOL_INVALID") throw error;
      control = await discoverTaskControl({
        adapter,
        page,
        statePath,
        sourceOfTruthUrl,
        responseTimeoutMs,
        pollMs
      });
      cycles += 1;
    }
  }

  while (maxCycles <= 0 || cycles < maxCycles) {
    if (control.status === "DONE") {
      return {
        status: "DONE",
        cycles,
        generation: (await readSingleConversationState(statePath)).conversation.generation
      };
    }
    if (control.status === "BLOCKED") {
      return {
        status: "WAIT_OWNER",
        cycles,
        generation: (await readSingleConversationState(statePath)).conversation.generation
      };
    }

    const recovery = await boundedRuntimeStep(
      "TASK_RECOVERY_PROBE",
      () => recoverDisposableConversationIfNeeded({
        adapter,
        page,
        statePath,
        sourceOfTruthUrl,
        projectId: "LIVE",
        qualificationOnly: false,
        timeoutMs: responseTimeoutMs,
        pollMs: Math.min(750, Math.max(100, pollMs))
      }),
      { timeoutMs: 15_000 }
    );
    page = recovery.page;
    if (recovery.recovered) {
      control = parseTaskControl(
        recovery.result?.response?.assistant_turn?.text
      );
      continue;
    }

    const checkOnly = control.status === "RUNNING";
    const taskId = checkOnly
      ? control.task_id
      : control.next_task_id;
    if (!taskId) {
      throw Object.assign(
        new Error("task protocol did not provide an executable task id"),
        { code: "TASK_PROTOCOL_INVALID" }
      );
    }

    if (checkOnly) {
      await waitForNextCycleDelay(control.check_after_seconds * 1000);
    }

    const messageId = randomUUID();
    const message = buildSingleConversationTaskInstruction({
      sourceOfTruthUrl,
      taskId,
      messageId,
      checkOnly
    });
    const response = await sendProtocolMessage({
      adapter,
      page,
      statePath,
      message,
      messageId,
      kind: checkOnly ? "TASK_STATUS_CHECK" : "TASK_EXECUTION",
      responseTimeoutMs,
      pollMs
    });
    cycles += 1;
    control = parseTaskControl(response.assistant_turn?.text);

    if (!checkOnly) {
      await waitForNextCycleDelay(pollMs);
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
      maxCycles: args.maxCycles
    });
    console.log("SINGLE_CONVERSATION_RUNTIME_STATUS=" + result.status);
    console.log("SINGLE_CONVERSATION_CHAT_URL_REQUIRED=False");
    if (result.generation !== undefined) {
      console.log("SINGLE_CONVERSATION_GENERATION=" + result.generation);
    }
    if (["DONE", "WAIT_OWNER"].includes(result.status)) {
      finalExitCode = 76;
    }
  } catch (error) {
    const code = String(error?.code || "");
    const stage = String(error?.runtime_stage || "");
    console.error("SINGLE_CONVERSATION_RUNTIME_ERROR=" + (code || error?.name || "Error"));
    if (stage) {
      console.error("SINGLE_CONVERSATION_RUNTIME_ERROR_STAGE=" + stage);
    }
    finalExitCode =
      code === "CDP_RECOVERY_REQUIRED"
        ? 75
        : code === "TASK_PROTOCOL_INVALID"
          ? 76
          : 1;
  } finally {
    await boundedRuntimeCleanup(() => adapter.close(), 1_500);
  }
  process.exit(finalExitCode);
}
