import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import { createNewChatAndBootstrap } from "../../src/runtime/single-conversation-bootstrap.mjs";
import { runSingleConversationCycle } from "../../src/runtime/single-conversation-loop.mjs";
import { recoverDisposableConversationIfNeeded } from "../../src/runtime/single-conversation-rollover.mjs";
import { readSingleConversationState } from "../../src/runtime/single-conversation-state.mjs";

const stateRoot = String(process.argv[2] || "").trim();
const revision = String(process.argv[3] || process.env.GITHUB_SHA || "unknown").trim();
if (!stateRoot) throw new Error("state root is required");

const safeRevision = revision.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
const diagDir = path.join(stateRoot, "diagnostics", "sc005-live");
const statePath = path.join(diagDir, `${safeRevision}.state.json`);
const resultPath = path.join(diagDir, `${safeRevision}.result.json`);
const lockPath = path.join(diagDir, `${safeRevision}.lock`);
const sourceOfTruthUrl =
  "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md";
const bootstrapId = `SC005-BOOT-${safeRevision.slice(0, 16)}`;
const rehydrateId = `SC005-REHYDRATE-${safeRevision.slice(0, 16)}`;
const resumeId = `SC005-RESUME-${safeRevision.slice(0, 16)}`;

await fs.mkdir(diagDir, { recursive: true });

function sha(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}
function log(key, value) {
  const safe = String(value ?? "").replace(/[\r\n|]+/g, " ").slice(0, 500);
  console.log(`${key}=${safe}`);
}
async function readResult() {
  try { return JSON.parse(await fs.readFile(resultPath, "utf8")); }
  catch { return null; }
}
async function writeResult(value) {
  await fs.writeFile(
    resultPath,
    JSON.stringify({
      schema_version: "sc005-live-qualification.v1",
      revision: safeRevision,
      ...value
    }, null, 2) + "\n",
    "utf8"
  );
}

const prior = await readResult();
if (prior?.status === "PASS") {
  log("SC005_LIVE_PRIOR_PASS", "True");
  process.exit(0);
}

let lock = null;
try {
  lock = await fs.open(lockPath, "wx");
  await lock.writeFile(
    JSON.stringify({ revision: safeRevision, pid: process.pid, started_at: new Date().toISOString() }) + "\n",
    "utf8"
  );
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
  const deadline = Date.now() + 300_000;
  while (Date.now() <= deadline) {
    const result = await readResult();
    if (result?.status === "PASS") {
      log("SC005_LIVE_SHARED_TARGET_PRIOR_PASS", "True");
      process.exit(0);
    }
    if (result?.status === "FAIL") {
      throw new Error("parallel SC-005 target attempt recorded FAIL");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("parallel SC-005 target attempt lock timed out");
}

const cdpUrl = String(process.env.SUPERVISOR_SC005_CDP_URL || "").trim();
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl)) {
  throw new Error("SUPERVISOR_SC005_CDP_URL must be a local dynamic CDP endpoint");
}

const adapter = new ChatGptUiAdapter({
  cdpUrl,
  settleMs: 500,
  actionTimeoutMs: 10_000,
  timeoutMs: 45_000
});

async function openAdapterWithBoundedRetry() {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      log("SC005_LIVE_CDP_ATTACH_ATTEMPT", attempt);
      await adapter.open();
      log("SC005_LIVE_CDP_ATTACH_PASS", attempt);
      return;
    } catch (error) {
      lastError = error;
      log("SC005_LIVE_CDP_ATTACH_ERROR_NAME", error?.name || "Error");
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    }
  }
  const recovery = new Error("SC-005 CDP attach recovery required before UI mutation");
  recovery.code = "CDP_ATTACH_RECOVERY_REQUIRED";
  recovery.cause = lastError;
  throw recovery;
}

let qualificationPage = null;
let finalExitCode = 0;
const startedAt = new Date().toISOString();

async function boundedCleanup(label, action, timeoutMs = 2_500) {
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          log(`SC005_LIVE_CLEANUP_TIMEOUT_${label}`, "True");
          resolve();
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
  } catch (error) {
    log(`SC005_LIVE_CLEANUP_ERROR_${label}`, error?.name || "Error");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

try {
  await openAdapterWithBoundedRetry();

  let currentPages = adapter.getChatGptPages();
  if (currentPages.length > 2) {
    for (const candidate of currentPages) {
      let landing = false;
      try {
        const url = new URL(String(candidate.url() || ""));
        landing = url.origin === "https://chatgpt.com" && url.pathname === "/";
      } catch {}
      if (!landing) continue;
      await boundedCleanup("SURPLUS_LANDING_CLOSE", () => adapter.closePage(candidate), 1_500);
      if (adapter.getChatGptPageCount() <= 2) break;
    }
  }

  const preexistingPages = adapter.getChatGptPageCount();
  log("SC005_LIVE_PREEXISTING_CHATGPT_PAGES", preexistingPages);
  if (preexistingPages > 3) {
    throw new Error(
      `SC-005 qualification refuses to exceed four-page budget; preexisting=${preexistingPages}`
    );
  }

  const bootstrap = await createNewChatAndBootstrap({
    adapter,
    statePath,
    sourceOfTruthUrl,
    projectId: "LIVE",
    messageId: bootstrapId,
    qualificationOnly: true,
    forceNewPage: true,
    timeoutMs: 180_000,
    pollMs: 500,
    onPageAcquired: (page) => { qualificationPage = page; }
  });
  qualificationPage = bootstrap.page;

  const bootstrapText = String(bootstrap.response?.assistant_turn?.text || "");
  if (
    bootstrap.response?.status !== "RESPONSE_COMPLETE" ||
    !bootstrapText.includes(`MAGASIN_BOOTSTRAP_CORRELATION_V1 ${bootstrapId}`) ||
    !bootstrapText.includes("SINGLE_CONVERSATION_V1")
  ) {
    throw new Error("SC-005 prerequisite bootstrap did not complete with exact correlation");
  }

  const generationOne = await readSingleConversationState(statePath);
  if (generationOne.conversation.generation !== 1) {
    throw new Error("SC-005 prerequisite bootstrap did not establish generation 1");
  }
  const runtimeOne = String(generationOne.conversation.runtime_id || "");
  if (!/^chat:[0-9a-f]{32}$/.test(runtimeOne)) {
    throw new Error("SC-005 generation 1 missing opaque runtime identity");
  }
  log("SC005_LIVE_GENERATION_ONE_READY", "True");

  // Intentionally break only the qualification chat. Closing this page is the
  // deterministic live fault; recovery must not depend on reopening its URL.
  await adapter.closePage(qualificationPage);
  if (!qualificationPage.isClosed()) {
    throw new Error("SC-005 qualification could not close generation 1 page");
  }
  log("SC005_LIVE_GENERATION_ONE_PAGE_CLOSED", "True");

  const recovery = await recoverDisposableConversationIfNeeded({
    adapter,
    page: qualificationPage,
    statePath,
    messageId: rehydrateId,
    qualificationOnly: true,
    timeoutMs: 180_000,
    pollMs: 500,
    onPageAcquired: (page) => { qualificationPage = page; }
  });
  qualificationPage = recovery.page;

  if (!recovery.recovered) {
    throw new Error("SC-005 did not replace the intentionally closed conversation");
  }
  if (recovery.classification?.reason !== "STALE_OR_CLOSED_PAGE") {
    throw new Error("SC-005 classified the closed page with an unexpected reason");
  }

  const rehydrateText = String(
    recovery.result?.response?.assistant_turn?.text || ""
  );
  if (
    recovery.result?.response?.status !== "RESPONSE_COMPLETE" ||
    !rehydrateText.includes(`MAGASIN_BOOTSTRAP_CORRELATION_V1 ${rehydrateId}`) ||
    !rehydrateText.includes("SINGLE_CONVERSATION_V1")
  ) {
    throw new Error("SC-005 rehydration bootstrap did not complete with exact correlation");
  }

  const generationTwo = await readSingleConversationState(statePath);
  if (generationTwo.conversation.generation !== 2) {
    throw new Error("SC-005 replacement did not advance exactly to generation 2");
  }
  const runtimeTwo = String(generationTwo.conversation.runtime_id || "");
  if (!/^chat:[0-9a-f]{32}$/.test(runtimeTwo) || runtimeTwo === runtimeOne) {
    throw new Error("SC-005 did not establish a new opaque runtime identity");
  }
  if (
    generationTwo.recovery?.retired_generation !== 1 ||
    generationTwo.recovery?.rehydrated_generation !== 2 ||
    generationTwo.recovery?.reason !== "STALE_OR_CLOSED_PAGE"
  ) {
    throw new Error("SC-005 durable recovery evidence is incomplete");
  }
  log("SC005_LIVE_REHYDRATED_GENERATION_TWO", "True");

  const resumed = await runSingleConversationCycle({
    adapter,
    page: qualificationPage,
    statePath,
    messageId: resumeId,
    qualificationOnly: true,
    timeoutMs: 180_000,
    pollMs: 500,
    maxContinueClicks: 8
  });
  const resumeText = String(resumed.response?.assistant_turn?.text || "");
  if (
    resumed.response?.status !== "RESPONSE_COMPLETE" ||
    resumed.response?.marker_confirmed !== true ||
    !resumeText.includes(`MAGASIN_CYCLE_CORRELATION_V1 ${resumeId}`) ||
    !resumeText.includes("SINGLE_CONVERSATION_V1")
  ) {
    throw new Error("SC-005 post-rollover cycle did not resume in generation 2");
  }

  const durable = await readSingleConversationState(statePath);
  if (
    durable.conversation.generation !== 2 ||
    String(durable.conversation.runtime_id || "") !== runtimeTwo ||
    durable.source_of_truth.sync_status !== "VERIFIED"
  ) {
    throw new Error("SC-005 post-rollover durable state is not verified generation 2");
  }

  const raw = await fs.readFile(statePath, "utf8");
  if (/https:\/\/chatgpt\.com\/(?:c|g|project)\//i.test(raw)) {
    throw new Error("SC-005 durable state leaked a conversation URL");
  }

  await writeResult({
    status: "PASS",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    source_of_truth_digest: sha(sourceOfTruthUrl),
    generation_one: 1,
    generation_two: 2,
    closed_page_replaced: true,
    new_runtime_identity: true,
    rehydrated_from_source_of_truth: true,
    post_rollover_cycle_complete: true,
    conversation_url_persisted: false,
    production_state_mutated: false,
    production_targets_mutated: false,
    external_system_mutation_requested: false
  });

  log("SC005_LIVE_STATUS", "PASS");
  log("SC005_LIVE_CLOSED_PAGE_REPLACED", "True");
  log("SC005_LIVE_GENERATION_ADVANCED_1_TO_2", "True");
  log("SC005_LIVE_NEW_RUNTIME_IDENTITY", "True");
  log("SC005_LIVE_REHYDRATED_FROM_SOURCE_OF_TRUTH", "True");
  log("SC005_LIVE_POST_ROLLOVER_CYCLE_COMPLETE", "True");
  log("SC005_LIVE_CONVERSATION_URL_PERSISTED", "False");
  log("SC005_LIVE_PRODUCTION_STATE_MUTATED", "False");
  log("SC005_LIVE_EXTERNAL_SYSTEM_MUTATION_REQUESTED", "False");
} catch (error) {
  const cdpRecoveryRequired =
    String(error?.code || "") === "CDP_ATTACH_RECOVERY_REQUIRED";
  await writeResult({
    status: cdpRecoveryRequired ? "RETRYABLE_CDP_ATTACH" : "FAIL",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    error_name: String(error?.name || "Error"),
    error_code: String(error?.code || ""),
    error_digest: sha(String(error?.message || error)),
    production_state_mutated: false,
    production_targets_mutated: false
  }).catch(() => {});
  if (cdpRecoveryRequired) {
    log("SC005_LIVE_CDP_RECOVERY_REQUIRED", "True");
    log("SC005_LIVE_CDP_RECOVERY_CAUSE", error?.cause?.name || "Unknown");
    finalExitCode = 75;
  } else {
    log("SC005_LIVE_STATUS", "FAIL");
    log("SC005_LIVE_ERROR_NAME", error?.name || "Error");
    log("SC005_LIVE_ERROR_DIGEST", sha(String(error?.message || error)));
    finalExitCode = 1;
  }
} finally {
  if (qualificationPage && !qualificationPage.isClosed()) {
    await boundedCleanup("PAGE_CLOSE", () => adapter.closePage(qualificationPage));
  }
  await boundedCleanup("ADAPTER_CLOSE", () => adapter.close(), 1_000);
  await boundedCleanup("LOCK_CLOSE", () => lock?.close(), 1_000);
  await fs.rm(lockPath, { force: true }).catch(() => {});
}
process.exit(finalExitCode);
