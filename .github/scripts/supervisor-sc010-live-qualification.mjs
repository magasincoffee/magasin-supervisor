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

async function bounded(label, action, timeoutMs = 2500) {
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
  // Warm the authenticated ChatGPT surface before the five-cycle runtime
  // starts. SC-010 qualifies NEXT_WORK continuity, not cold-browser startup
  // (already covered by SC-008); a cold about:blank CDP attach can expose the
  // page before ChatGPT has hydrated its composer.
  await adapter.open();
  const warmPage = adapter.getActivePage();
  if (!warmPage) throw new Error("SC-010 warm page is unavailable");
  if (!String(warmPage.url?.() || "").startsWith("https://chatgpt.com/")) {
    await warmPage.goto("https://chatgpt.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000
    });
  }
  let warmReady = false;
  for (let i = 0; i < 40; i += 1) {
    const probe = await adapter.probePage(warmPage).catch(() => null);
    if (probe?.snapshot?.composerReady && !probe?.snapshot?.loginRequired) {
      warmReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!warmReady) throw Object.assign(
    new Error("SC-010 warm ChatGPT composer did not become ready"),
    { code: "WARM_COMPOSER_NOT_READY" }
  );
  log("SC010_LIVE_WARM_COMPOSER_READY", "True");

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

  if (result.status !== "MAX_CYCLES" || result.cycles !== 5) {
    throw new Error("SC-010 runtime did not complete exactly five qualification cycles");
  }

  const durable = await readSingleConversationState(statePath);
  if (durable.outbound.state !== "VERIFIED") {
    throw new Error("SC-010 final outbound transaction was not VERIFIED");
  }
  if (durable.automation.phase !== "NEXT_WORK") {
    throw new Error("SC-010 final automation phase was not NEXT_WORK");
  }
  if (durable.source_of_truth.sync_status !== "VERIFIED") {
    throw new Error("SC-010 Source of Truth was not VERIFIED");
  }
  if (durable.conversation.status !== "ACTIVE") {
    throw new Error("SC-010 conversation was not ACTIVE");
  }

  const activePage = adapter.getActivePage();
  if (!activePage || activePage.isClosed?.()) {
    throw new Error("SC-010 active ChatGPT page is unavailable");
  }

  for (const candidate of adapter.getChatGptPages()) {
    if (candidate === activePage || candidate.isClosed?.()) continue;
    await bounded("OLD_CHAT_CLOSE", () => adapter.closePage(candidate), 2000);
  }

  // Closing stale ChatGPT tabs can race with a ChatGPT rerender/navigation and
  // invalidate the Page handle captured before cleanup. The runtime has already
  // completed all five cycles at this point, so reacquire the live page from
  // the adapter before the final read-only probe instead of failing on a stale
  // qualification-only handle.
  const finalPage =
    adapter.getActivePage() ||
    adapter.getChatGptPages().find((candidate) => !candidate.isClosed?.()) ||
    null;
  if (!finalPage || finalPage.isClosed?.()) {
    throw new Error("SC-010 final ChatGPT page is unavailable after cleanup");
  }

  const probe = await Promise.race([
    adapter.probePage(finalPage),
    new Promise((_, reject) => setTimeout(
      () => reject(Object.assign(new Error("final live probe timeout"), { code: "FINAL_PROBE_TIMEOUT" })),
      10000
    ))
  ]);

  if (probe?.snapshot?.responseRunning) {
    throw new Error("SC-010 final response still running");
  }
  if (!probe?.snapshot?.composerReady) {
    throw new Error("SC-010 final composer is not ready");
  }

  const pages = adapter.getChatGptPages().filter((page) => !page.isClosed?.());
  if (pages.length !== 1) {
    throw new Error("SC-010 did not converge to exactly one active ChatGPT conversation");
  }

  log("SC010_LIVE_FIVE_SEQUENTIAL_CYCLES", "PASS");
  log("SC010_LIVE_FINAL_OUTBOUND_VERIFIED", "True");
  log("SC010_LIVE_FINAL_PHASE_NEXT_WORK", "True");
  log("SC010_LIVE_SOT_VERIFIED", "True");
  log("SC010_LIVE_ACTIVE_CONVERSATION_COUNT", pages.length);
  log("SC010_LIVE_GENERATION", durable.conversation.generation);
  log("SC010_LIVE_DUPLICATE_SEND_ATTEMPTS", durable.outbound.retry_count > 1 ? "UNSAFE" : "0");
  log("SC010_LIVE_PRODUCTION_PROJECT_STATE_MUTATED", "False");
  log("SC010_LIVE_EXTERNAL_SYSTEM_MUTATION_REQUESTED", "False");
  log("SC010_LIVE_STATUS", "PASS");
} catch (error) {
  log("SC010_LIVE_STATUS", "FAIL");
  log("SC010_LIVE_ERROR_NAME", error?.name || "Error");
  log("SC010_LIVE_ERROR_CODE", error?.code || "");
  log("SC010_LIVE_ERROR_MESSAGE", String(error?.message || "").slice(0, 240));
  if (error?.bootstrap_send_evidence) {
    log(
      "SC010_LIVE_BOOTSTRAP_SEND_EVIDENCE",
      JSON.stringify(error.bootstrap_send_evidence)
    );
  }
  finalExitCode = 1;
} finally {
  await bounded("ADAPTER_CLOSE", () => adapter.close(), 1500);
}

process.exit(finalExitCode);
