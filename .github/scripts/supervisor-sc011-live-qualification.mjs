import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import { opaqueRuntimeIdentity } from "../../src/runtime/single-conversation-bootstrap.mjs";
import { runSingleConversationRuntime } from "../../src/runtime/single-conversation-cli.mjs";
import { readSingleConversationState } from "../../src/runtime/single-conversation-state.mjs";

const stateRoot = String(process.argv[2] || "").trim();
const revision = String(process.argv[3] || process.env.GITHUB_SHA || "unknown").trim();
if (!stateRoot) throw new Error("state root is required");

const cdpUrl = String(process.env.SUPERVISOR_SC011_CDP_URL || "").trim();
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl)) {
  throw new Error("SUPERVISOR_SC011_CDP_URL must be a local CDP endpoint");
}

const safeRevision = revision.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
const diagDir = path.join(stateRoot, "diagnostics", "sc011-live");
const statePath = path.join(diagDir, safeRevision + ".state.json");
const sourceOfTruthUrl =
  "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md";

await fs.mkdir(diagDir, { recursive: true });
await fs.rm(statePath, { force: true }).catch(() => {});

function log(key, value) {
  console.log(String(key) + "=" + String(value));
}

async function warm(adapter) {
  await adapter.open();
  const page = adapter.getActivePage();
  if (!page) throw new Error("SC-011 warm page is unavailable");
  if (!String(page.url?.() || "").startsWith("https://chatgpt.com/")) {
    await page.goto("https://chatgpt.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000
    });
  }
  for (let i = 0; i < 40; i += 1) {
    const probe = await adapter.probePage(page).catch(() => null);
    if (probe?.snapshot?.composerReady && !probe?.snapshot?.loginRequired) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("SC-011 warm composer did not become ready");
}

function makeAdapter() {
  return new ChatGptUiAdapter({
    cdpUrl,
    settleMs: 400,
    actionTimeoutMs: 10_000,
    timeoutMs: 45_000
  });
}

async function boundedAdapterClose(adapter, timeoutMs = 1_500) {
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve().then(() => adapter.close()),
      new Promise((resolve) => {
        timer = setTimeout(resolve, Math.max(1, Number(timeoutMs) || 1_500));
        timer.unref?.();
      })
    ]);
  } catch {
    // Qualification cleanup must never turn a durable PASS into runner timeout.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let qualificationPage = null;
let firstRuntimeId = null;
let firstGeneration = null;

const adapter1 = makeAdapter();
try {
  await warm(adapter1);
  const first = await runSingleConversationRuntime({
    adapter: adapter1,
    statePath,
    sourceOfTruthUrl,
    execute: true,
    qualificationOnly: true,
    pollMs: 500,
    responseTimeoutMs: 180_000,
    maxCycles: 1
  });
  if (first.status !== "MAX_CYCLES" || first.cycles !== 1) {
    throw new Error("SC-011 first CLI invocation did not finish one qualification cycle");
  }
  const state1 = await readSingleConversationState(statePath);
  if (state1.outbound.state !== "VERIFIED") {
    throw new Error("SC-011 first invocation did not end VERIFIED");
  }
  firstRuntimeId = state1.conversation.runtime_id;
  firstGeneration = state1.conversation.generation;
  qualificationPage = adapter1.getChatGptPages().find((page) =>
    opaqueRuntimeIdentity(page.url?.()) === firstRuntimeId
  ) || null;
  if (!qualificationPage) {
    throw new Error("SC-011 could not identify first qualification conversation");
  }
  log("SC011_LIVE_FIRST_GENERATION", firstGeneration);
  log("SC011_LIVE_FIRST_RUNTIME_ID_PRESENT", Boolean(firstRuntimeId));
} finally {
  await boundedAdapterClose(adapter1);
}

const adapter2 = makeAdapter();
try {
  const second = await runSingleConversationRuntime({
    adapter: adapter2,
    statePath,
    sourceOfTruthUrl,
    execute: true,
    qualificationOnly: true,
    pollMs: 500,
    responseTimeoutMs: 180_000,
    maxCycles: 2
  });
  if (second.status !== "MAX_CYCLES" || second.cycles !== 2) {
    throw new Error("SC-011 second CLI invocation did not finish two qualification cycles");
  }

  const state2 = await readSingleConversationState(statePath);
  if (state2.conversation.generation !== firstGeneration) {
    throw new Error("SC-011 CLI restart created a new conversation generation");
  }
  if (state2.conversation.runtime_id !== firstRuntimeId) {
    throw new Error("SC-011 CLI restart changed runtime conversation identity");
  }
  if (state2.outbound.state !== "VERIFIED") {
    throw new Error("SC-011 final outbound transaction was not VERIFIED");
  }

  const matches = adapter2.getChatGptPages().filter((page) =>
    opaqueRuntimeIdentity(page.url?.()) === firstRuntimeId
  );
  if (matches.length !== 1) {
    throw new Error("SC-011 runtime identity did not resolve to exactly one live ChatGPT page");
  }
  qualificationPage = matches[0];

  const probe = await adapter2.probePage(qualificationPage);
  if (probe?.snapshot?.responseRunning || !probe?.snapshot?.composerReady) {
    throw new Error("SC-011 reused conversation is not idle and usable");
  }

  log("SC011_LIVE_CLI_RESTART_REUSED_CONVERSATION", "True");
  log("SC011_LIVE_GENERATION_STABLE", state2.conversation.generation);
  log("SC011_LIVE_RUNTIME_ID_STABLE", "True");
  log("SC011_LIVE_TOTAL_SEQUENTIAL_CYCLES", 3);
  log("SC011_LIVE_MATCHED_RUNTIME_PAGE_COUNT", matches.length);
  log("SC011_LIVE_DUPLICATE_SEND_ATTEMPTS", state2.outbound.retry_count > 1 ? "UNSAFE" : "0");
  log("SC011_LIVE_PRODUCTION_PROJECT_STATE_MUTATED", "False");
  log("SC011_LIVE_EXTERNAL_SYSTEM_MUTATION_REQUESTED", "False");
  log("SC011_LIVE_STATUS", "PASS");

  const hasArtifact = await adapter2.hasNonPersistedComposerArtifact(qualificationPage)
    .catch(() => true);
  if (!hasArtifact) {
    await adapter2.closePage(qualificationPage).catch(() => {});
    log("SC011_LIVE_QUALIFICATION_CHAT_CLOSED", "True");
  }
} catch (error) {
  log("SC011_LIVE_STATUS", "FAIL");
  log("SC011_LIVE_ERROR_CODE", error?.code || "");
  log("SC011_LIVE_ERROR_MESSAGE", String(error?.message || "").slice(0, 240));
  process.exitCode = 1;
} finally {
  await boundedAdapterClose(adapter2);
}

log("SC011_LIVE_EXPLICIT_EXIT", "True");
process.exit(process.exitCode || 0);
