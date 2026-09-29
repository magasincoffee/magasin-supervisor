import fs from "node:fs/promises";
import path from "node:path";

import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import { createNewChatAndBootstrap } from "../../src/runtime/single-conversation-bootstrap.mjs";
import {
  runSingleConversationCycles,
  waitForSingleConversationResponse
} from "../../src/runtime/single-conversation-loop.mjs";
import { replaceDisposableConversation } from "../../src/runtime/single-conversation-rollover.mjs";
import {
  ensureSingleConversationState,
  beginConversationGeneration,
  readSingleConversationState,
  writeSingleConversationState
} from "../../src/runtime/single-conversation-state.mjs";
import {
  prepareExactOnceOutbound,
  markExactOnceEnqueued,
  markExactOnceDelivered,
  reconcileExactOnceOutbound
} from "../../src/runtime/single-conversation-transaction.mjs";

const stateRoot = String(process.argv[2] || "").trim();
const revision = String(process.argv[3] || process.env.GITHUB_SHA || "unknown").trim();
if (!stateRoot) throw new Error("state root is required");

const safeRevision = revision.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
const diagDir = path.join(stateRoot, "diagnostics", "sc008-live");
const statePath = path.join(diagDir, safeRevision + ".state.json");
const sourceOfTruthUrl =
  "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md";
const bootstrapId = "SC008-BOOT-" + safeRevision.slice(0, 16);
const cycleIds = [1, 2].map((n) => "SC008-CYCLE-" + n + "-" + safeRevision.slice(0, 16));
const rolloverId = "SC008-ROLLOVER-" + safeRevision.slice(0, 16);
const postRolloverId = "SC008-POST-" + safeRevision.slice(0, 16);

await fs.mkdir(diagDir, { recursive: true });

function log(key, value) {
  console.log(String(key) + "=" + String(value));
}

async function cleanupOtherChatGptPages(adapter, keepPage) {
  for (const candidate of adapter.getChatGptPages()) {
    if (candidate === keepPage || candidate.isClosed?.()) continue;
    await adapter.closePage(candidate).catch(() => {});
  }
}

async function runContinueProbe() {
  const probeRoot = path.join(diagDir, "continue-" + safeRevision);
  const probeState = path.join(probeRoot, "state.json");
  await fs.mkdir(probeRoot, { recursive: true });
  try {
    await ensureSingleConversationState(probeState, {
      sourceOfTruthUrl,
      sessionId: "sc008-continue"
    });
    await beginConversationGeneration(probeState, {
      runtimeId: "chat:continue",
      pageId: "page:continue"
    });

    let probes = 0;
    let clicks = 0;
    const result = await waitForSingleConversationResponse({
      adapter: {
        async probePage() {
          probes += 1;
          if (probes === 1) {
            return {
              snapshot: {
                composerReady: true,
                responseRunning: false,
                hasContinueControl: true
              }
            };
          }
          return {
            snapshot: {
              composerReady: true,
              responseRunning: false,
              hasContinueControl: false
            }
          };
        }
      },
      page: { async waitForTimeout() {} },
      statePath: probeState,
      baselineAssistantTurnId: "assistant-old",
      captureTurn: async () => ({
        turn_id: "assistant-new",
        text: "continued response complete",
        digest: "continued"
      }),
      executeUiDecision: async ({ decision }) => {
        if (decision.action !== "CONTINUE") {
          throw new Error("SC-008 Continue probe received wrong action");
        }
        clicks += 1;
        return {
          executed: true,
          target: "SAFE_CONTINUE_CONTROL"
        };
      },
      timeoutMs: 2_000,
      pollMs: 1,
      maxContinueClicks: 2
    });
    if (clicks !== 1 || result.continue_clicks !== 1) {
      throw new Error("SC-008 Continue probe did not actuate exactly one safe Continue");
    }
  } finally {
    await fs.rm(probeRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function makeTxState(name) {
  const root = path.join(diagDir, "tx-" + name + "-" + safeRevision);
  const state = path.join(root, "state.json");
  await fs.mkdir(root, { recursive: true });
  await ensureSingleConversationState(state, {
    sourceOfTruthUrl,
    sessionId: "sc008-" + name
  });
  await beginConversationGeneration(state, {
    runtimeId: "chat:" + name,
    pageId: "page:" + name
  });
  return { root, state };
}

async function runRestartExactOnceProbe() {
  const counters = {
    prepared: 0,
    enqueued: 0,
    delivered: 0,
    wait_response: 0
  };

  // PREPARED restart: positive non-delivery allows exactly one send.
  {
    const { root, state } = await makeTxState("prepared");
    const message = "SC008_PREPARED_RESTART";
    try {
      await prepareExactOnceOutbound(state, {
        messageId: "prepared",
        message,
        kind: "SC008"
      });
      let sent = false;
      const result = await reconcileExactOnceOutbound({
        statePath: state,
        page: { async waitForTimeout() {} },
        messageId: "prepared",
        message,
        reconciliationProbes: 1,
        inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
        captureTurn: async () => sent ? { turn_id: "u1", text: message } : null,
        sendInstruction: async () => {
          counters.prepared += 1;
          sent = true;
          return { executed: true };
        }
      });
      if (result.action !== "SEND" || counters.prepared !== 1) {
        throw new Error("SC-008 PREPARED restart was not exactly-once");
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ENQUEUED restart: matching delivered turn must reconcile with zero resend.
  {
    const { root, state } = await makeTxState("enqueued");
    const message = "SC008_ENQUEUED_RESTART";
    try {
      await prepareExactOnceOutbound(state, {
        messageId: "enqueued",
        message,
        kind: "SC008",
        baselineUserTurnId: "u0"
      });
      await markExactOnceEnqueued(state, { messageId: "enqueued", message });
      const result = await reconcileExactOnceOutbound({
        statePath: state,
        page: { async waitForTimeout() {} },
        messageId: "enqueued",
        message,
        reconciliationProbes: 1,
        inspectDraft: async () => ({ ready: true, has_text: false, digest: null }),
        captureTurn: async () => ({ turn_id: "u1", text: message }),
        sendInstruction: async () => {
          counters.enqueued += 1;
          return { executed: true };
        }
      });
      if (result.action !== "NO_SEND" || counters.enqueued !== 0) {
        throw new Error("SC-008 ENQUEUED restart duplicated a send");
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  // DELIVERED restart: terminal delivery evidence must never resend.
  {
    const { root, state } = await makeTxState("delivered");
    const message = "SC008_DELIVERED_RESTART";
    try {
      await prepareExactOnceOutbound(state, {
        messageId: "delivered",
        message,
        kind: "SC008"
      });
      await markExactOnceEnqueued(state, { messageId: "delivered", message });
      await markExactOnceDelivered(state, {
        messageId: "delivered",
        message,
        userTurnId: "u1"
      });
      const result = await reconcileExactOnceOutbound({
        statePath: state,
        page: { async waitForTimeout() {} },
        messageId: "delivered",
        message,
        sendInstruction: async () => {
          counters.delivered += 1;
          return { executed: true };
        }
      });
      if (result.action !== "NO_SEND" || counters.delivered !== 0) {
        throw new Error("SC-008 DELIVERED restart duplicated a send");
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  // WAIT_RESPONSE / RESPONSE_RUNNING restart: no resend while response is active.
  {
    const { root, state } = await makeTxState("wait-response");
    const message = "SC008_WAIT_RESPONSE_RESTART";
    try {
      await prepareExactOnceOutbound(state, {
        messageId: "wait-response",
        message,
        kind: "SC008"
      });
      await markExactOnceEnqueued(state, { messageId: "wait-response", message });
      await markExactOnceDelivered(state, {
        messageId: "wait-response",
        message,
        userTurnId: "u1"
      });
      const durable = await readSingleConversationState(state);
      durable.outbound.state = "RESPONSE_RUNNING";
      durable.outbound.response_running_at = new Date().toISOString();
      durable.automation.phase = "WAIT_RESPONSE";
      await writeSingleConversationState(state, durable);

      const result = await reconcileExactOnceOutbound({
        statePath: state,
        page: { async waitForTimeout() {} },
        messageId: "wait-response",
        message,
        sendInstruction: async () => {
          counters.wait_response += 1;
          return { executed: true };
        }
      });
      if (result.action !== "NO_SEND" || counters.wait_response !== 0) {
        throw new Error("SC-008 WAIT_RESPONSE restart duplicated a send");
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  return counters;
}

const cdpUrl = String(process.env.SUPERVISOR_SC008_CDP_URL || "").trim();
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl)) {
  throw new Error("SUPERVISOR_SC008_CDP_URL must be a local CDP endpoint");
}

const adapter = new ChatGptUiAdapter({
  cdpUrl,
  settleMs: 500,
  actionTimeoutMs: 10_000,
  timeoutMs: 45_000
});

let activePage = null;
try {
  await adapter.open();

  const bootstrap = await createNewChatAndBootstrap({
    adapter,
    statePath,
    sourceOfTruthUrl,
    projectId: "LIVE",
    messageId: bootstrapId,
    qualificationOnly: true,
    forceNewPage: true,
    timeoutMs: 180_000,
    pollMs: 500
  });
  activePage = bootstrap.page;

  if (bootstrap.response?.status !== "RESPONSE_COMPLETE") {
    throw new Error("SC-008 bootstrap did not complete");
  }
  const bootstrapText = String(bootstrap.response.assistant_turn?.text || "");
  if (!bootstrapText.includes("MAGASIN_BOOTSTRAP_CORRELATION_V1 " + bootstrapId)) {
    throw new Error("SC-008 bootstrap correlation missing");
  }
  if (!bootstrapText.includes("SINGLE_CONVERSATION_V1")) {
    throw new Error("SC-008 bootstrap did not read authoritative architecture generation");
  }
  log("SC008_MATRIX_1_COLD_START_AUTHENTICATED_PROFILE", "PASS");
  log("SC008_MATRIX_2_FRESH_NEW_CHAT_AUTOMATIC", "PASS");
  log("SC008_MATRIX_3_BOOTSTRAP_DELIVERED_ANSWERED", "PASS");

  await cleanupOtherChatGptPages(adapter, activePage);
  if (adapter.getChatGptPageCount() !== 1) {
    throw new Error("SC-008 steady state did not converge to exactly one ChatGPT page");
  }

  await runContinueProbe();
  log("SC008_MATRIX_4_CONTINUE_GENERATING", "PASS");

  const cycles = await runSingleConversationCycles({
    cycles: 2,
    adapter,
    page: activePage,
    statePath,
    qualificationOnly: true,
    messageIdFactory: (index) => cycleIds[index],
    timeoutMs: 180_000,
    pollMs: 500,
    maxContinueClicks: 8
  });
  if (cycles.length !== 2 || cycles.some((x) => x.response?.status !== "RESPONSE_COMPLETE")) {
    throw new Error("SC-008 sequential cycles did not complete");
  }
  log("SC008_MATRIX_5_MULTIPLE_SEQUENTIAL_CYCLES", "PASS");

  const beforeRollover = await readSingleConversationState(statePath);
  const oldPage = activePage;

  // Keep Chrome itself alive while intentionally breaking the conversation.
  // Closing the last browser tab on Windows exits Chrome and tests browser
  // process recovery instead of disposable-conversation rollover. A blank
  // landing surface is not an active conversation and is closed again after
  // replacement.
  const browserSurvivalPage = await adapter.newChatPage("https://chatgpt.com/");
  await oldPage.close();
  if (!oldPage.isClosed()) throw new Error("SC-008 intentional chat break did not close page");

  const replacement = await replaceDisposableConversation({
    adapter,
    page: oldPage,
    statePath,
    reason: "SC008_INTENTIONAL_BROKEN_CHAT",
    sourceOfTruthUrl,
    projectId: "LIVE",
    messageId: rolloverId,
    qualificationOnly: true,
    timeoutMs: 180_000,
    pollMs: 500
  });
  activePage = replacement.page;
  if (browserSurvivalPage && !browserSurvivalPage.isClosed?.()) {
    await adapter.closePage(browserSurvivalPage).catch(() => {});
  }
  const afterRollover = await readSingleConversationState(statePath);
  if (afterRollover.conversation.generation !== beforeRollover.conversation.generation + 1) {
    throw new Error("SC-008 rollover did not advance generation exactly once");
  }
  if (afterRollover.conversation.runtime_id === beforeRollover.conversation.runtime_id) {
    throw new Error("SC-008 rollover reused runtime conversation identity");
  }

  const post = await runSingleConversationCycles({
    cycles: 1,
    adapter,
    page: activePage,
    statePath,
    qualificationOnly: true,
    messageIdFactory: () => postRolloverId,
    timeoutMs: 180_000,
    pollMs: 500
  });
  if (post[0]?.response?.status !== "RESPONSE_COMPLETE") {
    throw new Error("SC-008 post-rollover cycle did not complete");
  }
  log("SC008_MATRIX_6_BROKEN_CHAT_AUTOMATIC_ROLLOVER", "PASS");

  const restartCounters = await runRestartExactOnceProbe();
  log("SC008_MATRIX_7_RESTART_PHASES", "PASS");
  if (
    restartCounters.prepared !== 1 ||
    restartCounters.enqueued !== 0 ||
    restartCounters.delivered !== 0 ||
    restartCounters.wait_response !== 0
  ) {
    throw new Error("SC-008 exact-once restart counters are unsafe");
  }
  log("SC008_MATRIX_8_NO_DUPLICATE_UNSAFE_MUTATION", "PASS");

  const raw = await fs.readFile(statePath, "utf8");
  if (/https:\/\/chatgpt\.com\/(?:c|g|project)\//i.test(raw)) {
    throw new Error("SC-008 persisted a ChatGPT conversation URL");
  }
  if (/planner_url|executor_url/i.test(raw)) {
    throw new Error("SC-008 persisted Planner/Executor URLs");
  }
  log("SC008_MATRIX_9_NO_OWNER_CHAT_URL_REQUIRED", "PASS");

  await cleanupOtherChatGptPages(adapter, activePage);
  if (adapter.getChatGptPageCount() !== 1 || activePage.isClosed()) {
    throw new Error("SC-008 did not end with exactly one active Robot ChatGPT conversation");
  }
  log("SC008_MATRIX_10_EXACTLY_ONE_ACTIVE_CONVERSATION", "PASS");

  log("SC008_LIVE_STATUS", "PASS");
  log("SC008_LIVE_PRODUCTION_PROJECT_STATE_MUTATED", "False");
  log("SC008_LIVE_EXTERNAL_SYSTEM_MUTATION_REQUESTED", "False");
} catch (error) {
  log("SC008_LIVE_STATUS", "FAIL");
  log("SC008_LIVE_ERROR_NAME", error?.name || "Error");
  throw error;
} finally {
  if (activePage && !activePage.isClosed?.()) {
    await adapter.closePage(activePage).catch(() => {});
  }
  await adapter.close().catch(() => {});
}
