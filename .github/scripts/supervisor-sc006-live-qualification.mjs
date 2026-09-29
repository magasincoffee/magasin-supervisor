import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import { createNewChatAndBootstrap } from "../../src/runtime/single-conversation-bootstrap.mjs";
import {
  buildSingleConversationNextInstruction,
  waitForSingleConversationResponse
} from "../../src/runtime/single-conversation-loop.mjs";
import {
  markExactOnceEnqueued,
  markExactOnceVerified,
  prepareExactOnceOutbound,
  reconcileExactOnceOutbound
} from "../../src/runtime/single-conversation-transaction.mjs";
import { readSingleConversationState } from "../../src/runtime/single-conversation-state.mjs";
import { sendComposerInstruction } from "../../src/ui/actions.mjs";
import { captureLatestRoleTurn } from "../../src/ui/latest-turn.mjs";

const stateRoot = String(process.argv[2] || "").trim();
const revision = String(process.argv[3] || process.env.GITHUB_SHA || "unknown").trim();
if (!stateRoot) throw new Error("state root is required");

const safeRevision = revision.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
const diagDir = path.join(stateRoot, "diagnostics", "sc006-live");
const statePath = path.join(diagDir, `${safeRevision}.state.json`);
const resultPath = path.join(diagDir, `${safeRevision}.result.json`);
const lockPath = path.join(diagDir, `${safeRevision}.lock`);
const sourceOfTruthUrl =
  "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md";
const bootstrapId = `SC006-BOOT-${safeRevision.slice(0, 16)}`;
const safeRetryId = `SC006-SAFE-RETRY-${safeRevision.slice(0, 16)}`;
const reconcileId = `SC006-NO-RESEND-${safeRevision.slice(0, 16)}`;

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
      schema_version: "sc006-live-qualification.v1",
      revision: safeRevision,
      ...value
    }, null, 2) + "\n",
    "utf8"
  );
}

const prior = await readResult();
if (prior?.status === "PASS") {
  log("SC006_LIVE_PRIOR_PASS", "True");
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
      log("SC006_LIVE_SHARED_TARGET_PRIOR_PASS", "True");
      process.exit(0);
    }
    if (result?.status === "FAIL") {
      throw new Error("parallel SC-006 target attempt recorded FAIL");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("parallel SC-006 target attempt lock timed out");
}

const cdpUrl = String(process.env.SUPERVISOR_SC006_CDP_URL || "").trim();
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl)) {
  throw new Error("SUPERVISOR_SC006_CDP_URL must be a local dynamic CDP endpoint");
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
      log("SC006_LIVE_CDP_ATTACH_ATTEMPT", attempt);
      await adapter.open();
      log("SC006_LIVE_CDP_ATTACH_PASS", attempt);
      return;
    } catch (error) {
      lastError = error;
      log("SC006_LIVE_CDP_ATTACH_ERROR_NAME", error?.name || "Error");
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    }
  }
  const recovery = new Error("SC-006 CDP attach recovery required before UI mutation");
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
          log(`SC006_LIVE_CLEANUP_TIMEOUT_${label}`, "True");
          resolve();
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
  } catch (error) {
    log(`SC006_LIVE_CLEANUP_ERROR_${label}`, error?.name || "Error");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function completeAndVerifyTransaction({
  messageId,
  message,
  baselineAssistantTurnId
}) {
  const response = await waitForSingleConversationResponse({
    adapter,
    page: qualificationPage,
    statePath,
    baselineAssistantTurnId,
    expectedAssistantMarker: `MAGASIN_CYCLE_CORRELATION_V1 ${messageId}`,
    timeoutMs: 180_000,
    pollMs: 500,
    maxContinueClicks: 8
  });
  if (
    response?.status !== "RESPONSE_COMPLETE" ||
    response?.marker_confirmed !== true
  ) {
    throw new Error(`SC-006 transaction ${messageId} response did not complete with correlation`);
  }
  const assistantText = String(response.assistant_turn?.text || "");
  if (
    !assistantText.includes("SINGLE_CONVERSATION_V1") ||
    !assistantText.includes(`MAGASIN_CYCLE_CORRELATION_V1 ${messageId}`)
  ) {
    throw new Error(`SC-006 transaction ${messageId} response evidence is incomplete`);
  }
  await markExactOnceVerified(statePath, { messageId, message });
  const durable = await readSingleConversationState(statePath);
  if (
    durable.outbound.state !== "VERIFIED" ||
    durable.source_of_truth.sync_status !== "VERIFIED"
  ) {
    throw new Error(`SC-006 transaction ${messageId} did not reach VERIFIED`);
  }
  return durable;
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
  log("SC006_LIVE_PREEXISTING_CHATGPT_PAGES", preexistingPages);
  if (preexistingPages > 3) {
    throw new Error(
      `SC-006 qualification refuses to exceed four-page budget; preexisting=${preexistingPages}`
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
    throw new Error("SC-006 prerequisite bootstrap did not complete with exact correlation");
  }
  log("SC006_LIVE_BOOTSTRAP_PASS", "True");

  // Scenario A: durable ENQUEUED exists but no UI actuation occurred.
  // Reconciliation has positive non-delivery evidence and may issue exactly
  // one bounded retry.
  const baselineUserA = await captureLatestRoleTurn(qualificationPage, "user").catch(() => null);
  const baselineAssistantA = await captureLatestRoleTurn(qualificationPage, "assistant").catch(() => null);
  const messageA = buildSingleConversationNextInstruction({
    sourceOfTruthUrl,
    messageId: safeRetryId,
    qualificationOnly: true
  });

  await prepareExactOnceOutbound(statePath, {
    messageId: safeRetryId,
    message: messageA,
    kind: "SC006_QUAL_SAFE_RETRY",
    baselineUserTurnId: baselineUserA?.turn_id || null
  });
  await markExactOnceEnqueued(statePath, {
    messageId: safeRetryId,
    message: messageA
  });

  const retryResult = await reconcileExactOnceOutbound({
    statePath,
    page: qualificationPage,
    messageId: safeRetryId,
    message: messageA,
    maxSafeRetries: 1,
    reconciliationProbes: 3,
    reconciliationPollMs: 250
  });
  if (
    retryResult.action !== "SAFE_RETRY_SENT" ||
    retryResult.retry_count !== 1
  ) {
    throw new Error("SC-006 positive non-delivery did not produce exactly one safe retry");
  }

  const verifiedA = await completeAndVerifyTransaction({
    messageId: safeRetryId,
    message: messageA,
    baselineAssistantTurnId: baselineAssistantA?.turn_id || null
  });
  if (
    verifiedA.outbound.retry_count !== 1 ||
    !String(verifiedA.outbound.cmd_id || "").startsWith("ui:")
  ) {
    throw new Error("SC-006 safe retry durable receipt evidence is incomplete");
  }
  log("SC006_LIVE_SAFE_RETRY_ON_POSITIVE_NON_DELIVERY", "True");
  log("SC006_LIVE_SAFE_RETRY_COUNT", verifiedA.outbound.retry_count);

  // Scenario B: UI send succeeds after ENQUEUED, then the process is treated
  // as if it crashed before DELIVERED could be persisted. Reconciliation must
  // discover the matching user turn and never call sendInstruction again.
  const baselineUserB = await captureLatestRoleTurn(qualificationPage, "user").catch(() => null);
  const baselineAssistantB = await captureLatestRoleTurn(qualificationPage, "assistant").catch(() => null);
  const messageB = buildSingleConversationNextInstruction({
    sourceOfTruthUrl,
    messageId: reconcileId,
    qualificationOnly: true
  });

  await prepareExactOnceOutbound(statePath, {
    messageId: reconcileId,
    message: messageB,
    kind: "SC006_QUAL_DELIVERED_RECONCILE",
    baselineUserTurnId: baselineUserB?.turn_id || null
  });
  await markExactOnceEnqueued(statePath, {
    messageId: reconcileId,
    message: messageB
  });

  const directSend = await sendComposerInstruction(
    qualificationPage,
    messageB,
    { dryRun: false }
  );
  if (!directSend?.executed) {
    throw new Error("SC-006 simulated pre-DELIVERED crash send was not actuated");
  }

  let duplicateSendAttempts = 0;
  const recovered = await reconcileExactOnceOutbound({
    statePath,
    page: qualificationPage,
    messageId: reconcileId,
    message: messageB,
    reconciliationProbes: 3,
    reconciliationPollMs: 250,
    sendInstruction: async () => {
      duplicateSendAttempts += 1;
      throw new Error("SC-006 duplicate send path must not be invoked");
    }
  });

  if (
    recovered.action !== "NO_SEND" ||
    recovered.reason !== "matching-user-turn-reconciled" ||
    duplicateSendAttempts !== 0
  ) {
    throw new Error("SC-006 delivered-turn reconciliation attempted a duplicate send");
  }

  const deliveredB = await readSingleConversationState(statePath);
  if (
    deliveredB.outbound.state !== "DELIVERED" ||
    deliveredB.outbound.retry_count !== 0
  ) {
    throw new Error("SC-006 reconciled delivery durable state is incorrect");
  }

  const verifiedB = await completeAndVerifyTransaction({
    messageId: reconcileId,
    message: messageB,
    baselineAssistantTurnId: baselineAssistantB?.turn_id || null
  });
  if (verifiedB.outbound.retry_count !== 0) {
    throw new Error("SC-006 delivered reconciliation unexpectedly consumed retry budget");
  }
  log("SC006_LIVE_DELIVERED_RECONCILED_WITHOUT_RESEND", "True");
  log("SC006_LIVE_DUPLICATE_SEND_ATTEMPTS", duplicateSendAttempts);

  const raw = await fs.readFile(statePath, "utf8");
  if (/https:\/\/chatgpt\.com\/(?:c|g|project)\//i.test(raw)) {
    throw new Error("SC-006 durable state leaked a conversation URL");
  }

  await writeResult({
    status: "PASS",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    source_of_truth_digest: sha(sourceOfTruthUrl),
    positive_non_delivery_safe_retry: true,
    safe_retry_count: 1,
    delivered_reconciled_without_resend: true,
    duplicate_send_attempts: 0,
    verified_terminal_state: true,
    conversation_url_persisted: false,
    production_state_mutated: false,
    production_targets_mutated: false,
    external_system_mutation_requested: false
  });

  log("SC006_LIVE_STATUS", "PASS");
  log("SC006_LIVE_PREPARED_ENQUEUED_DURABLE", "True");
  log("SC006_LIVE_POSITIVE_NON_DELIVERY_SAFE_RETRY", "True");
  log("SC006_LIVE_DELIVERED_NO_RESEND", "True");
  log("SC006_LIVE_VERIFIED_TERMINAL_STATE", "True");
  log("SC006_LIVE_CONVERSATION_URL_PERSISTED", "False");
  log("SC006_LIVE_PRODUCTION_STATE_MUTATED", "False");
  log("SC006_LIVE_EXTERNAL_SYSTEM_MUTATION_REQUESTED", "False");
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
    log("SC006_LIVE_CDP_RECOVERY_REQUIRED", "True");
    log("SC006_LIVE_CDP_RECOVERY_CAUSE", error?.cause?.name || "Unknown");
    finalExitCode = 75;
  } else {
    log("SC006_LIVE_STATUS", "FAIL");
    log("SC006_LIVE_ERROR_NAME", error?.name || "Error");
    log("SC006_LIVE_ERROR_DIGEST", sha(String(error?.message || error)));
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
