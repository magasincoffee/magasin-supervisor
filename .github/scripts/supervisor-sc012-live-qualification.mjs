import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import { opaqueRuntimeIdentity } from "../../src/runtime/single-conversation-bootstrap.mjs";
import { runSingleConversationRuntime } from "../../src/runtime/single-conversation-cli.mjs";
import {
  readSingleConversationState,
  writeSingleConversationState
} from "../../src/runtime/single-conversation-state.mjs";

const stateRoot = String(process.argv[2] || "").trim();
const revision = String(process.argv[3] || process.env.GITHUB_SHA || "unknown").trim();
if (!stateRoot) throw new Error("state root is required");

const cdpUrl = String(process.env.SUPERVISOR_SC012_CDP_URL || "").trim();
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl)) {
  throw new Error("SUPERVISOR_SC012_CDP_URL must be a local CDP endpoint");
}

const safeRevision = revision.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
const diagDir = path.join(stateRoot, "diagnostics", "sc012-live");
const statePath = path.join(diagDir, safeRevision + ".state.json");
const sourceOfTruthUrl =
  "https://github.com/magasincoffee/magasin-supervisor/blob/sc012-restart-replacement-regression/SOURCE_OF_TRUTH.md";

await fs.mkdir(diagDir, { recursive: true });
await fs.rm(statePath, { force: true }).catch(() => {});

function log(key, value) {
  console.log(String(key) + "=" + String(value));
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
    // Cleanup must never convert durable qualification evidence into timeout.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertCdpHealthy() {
  const response = await fetch(cdpUrl.replace(/\/+$/, "") + "/json/version", {
    cache: "no-store"
  });
  if (!response.ok) throw new Error("SC-012 CDP health endpoint failed");
  const payload = await response.json();
  if (!payload?.webSocketDebuggerUrl) {
    throw new Error("SC-012 CDP endpoint lost browser websocket");
  }
}

let firstGeneration = 0;
let firstRuntimeId = null;

const adapter1 = makeAdapter();
try {
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
    throw new Error("SC-012 initial qualification cycle did not complete");
  }

  const state1 = await readSingleConversationState(statePath);
  if (state1.outbound.state !== "VERIFIED") {
    throw new Error("SC-012 initial transaction was not VERIFIED");
  }
  firstGeneration = Number(state1.conversation.generation || 0);
  firstRuntimeId = String(state1.conversation.runtime_id || "");
  if (!firstRuntimeId) throw new Error("SC-012 initial runtime identity is missing");

  log("SC012_LIVE_FIRST_GENERATION", firstGeneration);
  log("SC012_LIVE_FIRST_RUNTIME_ID_PRESENT", "True");
} finally {
  await boundedAdapterClose(adapter1);
}

const adapter2 = makeAdapter();
try {
  await adapter2.open();

  // Prepare the exact production regression boundary: one blank/home page,
  // safe VERIFIED durable state, but an opaque runtime identity that cannot be
  // reconciled after restart. This forces disposable replacement without
  // mutating production project state.
  const home = await adapter2.newChatPage("https://chatgpt.com/");
  for (const candidate of adapter2.getChatGptPages()) {
    if (candidate === home || candidate.isClosed?.()) continue;
    const hasArtifact = await adapter2
      .hasNonPersistedComposerArtifact(candidate)
      .catch(() => true);
    if (hasArtifact) {
      throw new Error("SC-012 refused to close a page with a non-persisted artifact");
    }
    await adapter2.closePage(candidate);
  }
  adapter2.setActivePage(home);

  const prepared = await readSingleConversationState(statePath);
  prepared.conversation.runtime_id = "chat:" + "f".repeat(32);
  prepared.conversation.status = "ACTIVE";
  if (!["VERIFIED", "RESPONSE_COMPLETE"].includes(String(prepared.outbound.state))) {
    throw new Error("SC-012 restart fixture is not at a safe outbound boundary");
  }
  await writeSingleConversationState(statePath, prepared);

  const pages = adapter2.getChatGptPages();
  if (pages.length !== 1 || pages[0] !== home) {
    throw new Error("SC-012 restart fixture did not reach exactly one home page");
  }

  log("SC012_LIVE_RESTART_FIXTURE_ONE_HOME_PAGE", "True");
  log("SC012_LIVE_FORCED_IDENTITY_MISS", "True");
} finally {
  await boundedAdapterClose(adapter2);
}

const adapter3 = makeAdapter();
try {
  const second = await runSingleConversationRuntime({
    adapter: adapter3,
    statePath,
    sourceOfTruthUrl,
    execute: true,
    qualificationOnly: true,
    pollMs: 500,
    responseTimeoutMs: 180_000,
    maxCycles: 1
  });
  if (second.status !== "MAX_CYCLES" || second.cycles !== 1) {
    throw new Error("SC-012 replacement qualification cycle did not complete");
  }

  await assertCdpHealthy();
  const state2 = await readSingleConversationState(statePath);
  if (Number(state2.conversation.generation) !== firstGeneration + 1) {
    throw new Error(
      "SC-012 replacement generation was not bounded to exactly one increment"
    );
  }
  if (state2.outbound.state !== "VERIFIED") {
    throw new Error("SC-012 replacement transaction was not VERIFIED");
  }

  const activeRuntimeId = String(state2.conversation.runtime_id || "");
  const matches = adapter3.getChatGptPages().filter(
    (page) => opaqueRuntimeIdentity(page.url?.()) === activeRuntimeId
  );
  if (matches.length !== 1) {
    throw new Error("SC-012 replacement did not leave exactly one active runtime page");
  }
  if (adapter3.getChatGptPages().length !== 1) {
    throw new Error("SC-012 replacement left more than one ChatGPT page");
  }

  log("SC012_LIVE_REPLACEMENT_BEFORE_CLOSE", "PASS");
  log("SC012_LIVE_CDP_SURVIVED_REPLACEMENT", "True");
  log("SC012_LIVE_GENERATION_ADVANCED_EXACTLY_ONCE", state2.conversation.generation);
  log("SC012_LIVE_ACTIVE_CHATGPT_PAGE_COUNT", adapter3.getChatGptPages().length);
  log("SC012_LIVE_FINAL_OUTBOUND_VERIFIED", "True");
  log("SC012_LIVE_PRODUCTION_PROJECT_STATE_MUTATED", "False");
  log("SC012_LIVE_EXTERNAL_SYSTEM_MUTATION_REQUESTED", "False");
  log("SC012_LIVE_STATUS", "PASS");
} catch (error) {
  log("SC012_LIVE_STATUS", "FAIL");
  log("SC012_LIVE_ERROR_CODE", error?.code || "");
  log("SC012_LIVE_ERROR_MESSAGE", String(error?.message || "").slice(0, 320));
  process.exitCode = 1;
} finally {
  await boundedAdapterClose(adapter3);
}

log("SC012_LIVE_EXPLICIT_EXIT", "True");
process.exit(process.exitCode || 0);
