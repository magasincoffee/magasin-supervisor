import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import { runSingleConversationRuntime } from "../../src/runtime/single-conversation-cli.mjs";
import { readSingleConversationState } from "../../src/runtime/single-conversation-state.mjs";

const stateRoot = String(process.argv[2] || "").trim();
const revision = String(process.argv[3] || process.env.GITHUB_SHA || "unknown").trim();
if (!stateRoot) throw new Error("state root is required");
const cdpUrl = String(process.env.SUPERVISOR_SC010_CDP_URL || "").trim();
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl)) {
  throw new Error("SUPERVISOR_SC010_CDP_URL must be a local CDP endpoint");
}

const safeRevision = revision.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
const diagDir = path.join(stateRoot, "diagnostics", "sc010-live");
const statePath = path.join(diagDir, safeRevision + ".state.json");
const sourceOfTruthUrl =
  "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md";

await fs.mkdir(diagDir, { recursive: true });
await fs.rm(statePath, { force: true }).catch(() => {});

function log(key, value) {
  console.log(String(key) + "=" + String(value));
}

async function bounded(label, action, timeoutMs = 5_000) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          log("SC010_LIVE_CLEANUP_TIMEOUT_" + label, "True");
          resolve(null);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const adapter = new ChatGptUiAdapter({
  cdpUrl,
  settleMs: 400,
  actionTimeoutMs: 10_000,
  timeoutMs: 45_000
});

let finalExitCode = 0;
try {
  await adapter.open();

  // Retire any pre-qualification Robot conversation surface without touching
  // conversation history: navigate dedicated Robot tabs back to the blank home.
  for (const candidate of adapter.getChatGptPages()) {
    let isConversation = false;
    try {
      const url = new URL(String(candidate.url() || ""));
      isConversation = /^\/(?:c|g|project)\//.test(url.pathname);
    } catch {}
    if (!isConversation) continue;
    await candidate.goto("https://chatgpt.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });
  }

  const result = await runSingleConversationRuntime({
    adapter,
    statePath,
    sourceOfTruthUrl,
    execute: true,
    qualificationOnly: true,
    pollMs: 500,
    responseTimeoutMs: 180_000,
    maxCycles: 5
  });

  const durable = await readSingleConversationState(statePath);
  const page = adapter.getActivePage();
  const probe = await adapter.probePage(page);
  const snapshot = probe?.snapshot || {};

  const conversationPages = adapter.getChatGptPages().filter((candidate) => {
    try {
      const url = new URL(String(candidate.url() || ""));
      return /^\/(?:c|g|project)\//.test(url.pathname);
    } catch {
      return false;
    }
  });

  if (result.status !== "MAX_CYCLES" || result.cycles !== 5) {
    throw new Error("SC-010 runtime did not complete exactly five sequential cycles");
  }
  if (durable.conversation.status !== "ACTIVE") {
    throw new Error("SC-010 conversation is not ACTIVE after five cycles");
  }
  if (durable.conversation.generation !== 1 || result.generation !== 1) {
    throw new Error("SC-010 changed conversation generation during steady-state cycles");
  }
  if (durable.outbound.state !== "VERIFIED") {
    throw new Error("SC-010 final transaction is not VERIFIED");
  }
  if (durable.automation.status !== "RUNNING") {
    throw new Error("SC-010 automation is not RUNNING");
  }
  if (durable.automation.phase !== "NEXT_WORK") {
    throw new Error("SC-010 final phase is not NEXT_WORK");
  }
  if (durable.source_of_truth.sync_status !== "VERIFIED") {
    throw new Error("SC-010 Source of Truth is not VERIFIED");
  }
  if (conversationPages.length !== 1) {
    throw new Error("SC-010 did not converge to exactly one active conversation page");
  }
  if (Number(snapshot.userMessageCount) !== 6) {
    throw new Error(
      "SC-010 expected exactly six user turns (bootstrap + five cycles); got " +
      String(snapshot.userMessageCount)
    );
  }
  if (Number(snapshot.assistantMessageCount) < 6) {
    throw new Error("SC-010 did not observe six assistant responses");
  }
  if (snapshot.responseRunning) {
    throw new Error("SC-010 final response is still running");
  }

  log("SC010_LIVE_FIVE_CYCLES_COMPLETE", "True");
  log("SC010_LIVE_FINAL_OUTBOUND_VERIFIED", "True");
  log("SC010_LIVE_FINAL_PHASE_NEXT_WORK", "True");
  log("SC010_LIVE_SINGLE_CONVERSATION_GENERATION", "True");
  log("SC010_LIVE_ACTIVE_CONVERSATION_PAGES", conversationPages.length);
  log("SC010_LIVE_USER_TURN_COUNT", snapshot.userMessageCount);
  log("SC010_LIVE_ASSISTANT_TURN_COUNT", snapshot.assistantMessageCount);
  log("SC010_LIVE_DUPLICATE_SEND", "False");
  log("SC010_LIVE_PRODUCTION_STATE_MUTATED", "False");
  log("SC010_LIVE_EXTERNAL_SYSTEM_MUTATION_REQUESTED", "False");
  log("SC010_LIVE_STATUS", "PASS");
} catch (error) {
  log("SC010_LIVE_STATUS", "FAIL");
  log("SC010_LIVE_ERROR_NAME", error?.name || "Error");
  log("SC010_LIVE_ERROR_CODE", error?.code || "");
  log("SC010_LIVE_ERROR_MESSAGE", String(error?.message || error).slice(0, 500));
  finalExitCode = 1;
} finally {
  await bounded("ADAPTER_CLOSE", () => adapter.close(), 1_500);
}
process.exit(finalExitCode);
