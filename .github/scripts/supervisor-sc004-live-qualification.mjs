import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import { createNewChatAndBootstrap } from "../../src/runtime/single-conversation-bootstrap.mjs";
import { runSingleConversationCycles } from "../../src/runtime/single-conversation-loop.mjs";
import { readSingleConversationState } from "../../src/runtime/single-conversation-state.mjs";

const stateRoot = String(process.argv[2] || "").trim();
const revision = String(process.argv[3] || process.env.GITHUB_SHA || "unknown").trim();
if (!stateRoot) throw new Error("state root is required");

const safeRevision = revision.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
const diagDir = path.join(stateRoot, "diagnostics", "sc004-live");
const statePath = path.join(diagDir, `${safeRevision}.state.json`);
const resultPath = path.join(diagDir, `${safeRevision}.result.json`);
const lockPath = path.join(diagDir, `${safeRevision}.lock`);
const sourceOfTruthUrl =
  "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md";
const bootstrapId = `SC004-BOOT-${safeRevision.slice(0, 16)}`;
const cycleIds = [1, 2].map(
  (index) => `SC004-CYCLE-${index}-${safeRevision.slice(0, 16)}`
);

await fs.mkdir(diagDir, { recursive: true });

function sha(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function log(key, value) {
  const safe = String(value ?? "").replace(/[\r\n|]+/g, " ").slice(0, 500);
  console.log(`${key}=${safe}`);
}

async function readResult() {
  try {
    return JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch {
    return null;
  }
}

async function writeResult(value) {
  await fs.writeFile(
    resultPath,
    JSON.stringify({
      schema_version: "sc004-live-qualification.v1",
      revision: safeRevision,
      ...value
    }, null, 2) + "\n",
    "utf8"
  );
}

const prior = await readResult();
if (prior?.status === "PASS") {
  log("SC004_LIVE_PRIOR_PASS", "True");
  process.exit(0);
}

let lock = null;
try {
  lock = await fs.open(lockPath, "wx");
  await lock.writeFile(
    JSON.stringify({
      revision: safeRevision,
      pid: process.pid,
      started_at: new Date().toISOString()
    }) + "\n",
    "utf8"
  );
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
  const deadline = Date.now() + 240_000;
  while (Date.now() <= deadline) {
    const result = await readResult();
    if (result?.status === "PASS") {
      log("SC004_LIVE_SHARED_TARGET_PRIOR_PASS", "True");
      process.exit(0);
    }
    if (result?.status === "FAIL") {
      throw new Error("parallel SC-004 target attempt recorded FAIL");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("parallel SC-004 target attempt lock timed out");
}

const cdpUrl = String(process.env.SUPERVISOR_SC004_CDP_URL || "").trim();
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl)) {
  throw new Error("SUPERVISOR_SC004_CDP_URL must be a local dynamic CDP endpoint");
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
      log("SC004_LIVE_CDP_ATTACH_ATTEMPT", attempt);
      await openAdapterWithBoundedRetry();
      log("SC004_LIVE_CDP_ATTACH_PASS", attempt);
      return;
    } catch (error) {
      lastError = error;
      log("SC004_LIVE_CDP_ATTACH_ERROR_NAME", error?.name || "Error");
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    }
  }
  throw lastError || new Error("SC-004 CDP attach failed");
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
          log(`SC004_LIVE_CLEANUP_TIMEOUT_${label}`, "True");
          resolve();
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
  } catch (error) {
    log(`SC004_LIVE_CLEANUP_ERROR_${label}`, error?.name || "Error");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

try {
  await adapter.open();

  let currentPages = adapter.getChatGptPages();
  if (currentPages.length > 2) {
    for (const candidate of currentPages) {
      let isLanding = false;
      try {
        const url = new URL(String(candidate.url() || ""));
        isLanding = url.origin === "https://chatgpt.com" && url.pathname === "/";
      } catch {}
      if (!isLanding) continue;
      await boundedCleanup("SURPLUS_LANDING_CLOSE", () => adapter.closePage(candidate), 1_500);
      if (adapter.getChatGptPageCount() <= 2) break;
    }
  }

  const preexistingPages = adapter.getChatGptPageCount();
  log("SC004_LIVE_PREEXISTING_CHATGPT_PAGES", preexistingPages);
  if (preexistingPages > 3) {
    throw new Error(
      `SC-004 qualification refuses to exceed four-page budget; preexisting=${preexistingPages}`
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
    onPageAcquired: (page) => {
      qualificationPage = page;
    }
  });
  qualificationPage = bootstrap.page;

  if (bootstrap.response?.status !== "RESPONSE_COMPLETE") {
    throw new Error("SC-004 prerequisite bootstrap did not complete");
  }
  const bootstrapText = String(bootstrap.response.assistant_turn?.text || "");
  if (!bootstrapText.includes(`MAGASIN_BOOTSTRAP_CORRELATION_V1 ${bootstrapId}`)) {
    throw new Error("SC-004 prerequisite bootstrap missing correlation");
  }
  if (!bootstrapText.includes("SINGLE_CONVERSATION_V1")) {
    throw new Error("SC-004 prerequisite bootstrap missing architecture generation");
  }

  const afterBootstrap = await readSingleConversationState(statePath);
  if (afterBootstrap.conversation.generation !== 1) {
    throw new Error("SC-004 bootstrap did not establish generation 1");
  }
  const runtimeId = String(afterBootstrap.conversation.runtime_id || "");
  if (!/^chat:[0-9a-f]{32}$/.test(runtimeId)) {
    throw new Error("SC-004 bootstrap missing opaque runtime conversation identity");
  }

  log("SC004_LIVE_BOOTSTRAP_PASS", "True");
  log("SC004_LIVE_CONVERSATION_GENERATION", afterBootstrap.conversation.generation);

  const cycles = await runSingleConversationCycles({
    cycles: 2,
    adapter,
    page: qualificationPage,
    statePath,
    qualificationOnly: true,
    messageIdFactory: (index) => cycleIds[index],
    timeoutMs: 180_000,
    pollMs: 500,
    maxContinueClicks: 8
  });

  if (cycles.length !== 2) {
    throw new Error("SC-004 qualification did not run exactly two work cycles");
  }

  for (let index = 0; index < cycles.length; index += 1) {
    const result = cycles[index];
    const id = cycleIds[index];
    if (result.response?.status !== "RESPONSE_COMPLETE") {
      throw new Error(`SC-004 cycle ${index + 1} did not complete`);
    }
    const text = String(result.response.assistant_turn?.text || "");
    if (!text.includes(`MAGASIN_CYCLE_CORRELATION_V1 ${id}`)) {
      throw new Error(`SC-004 cycle ${index + 1} missing exact correlation`);
    }
    if (!text.includes("SINGLE_CONVERSATION_V1")) {
      throw new Error(`SC-004 cycle ${index + 1} missing architecture generation`);
    }
    if (result.response.marker_confirmed !== true) {
      throw new Error(`SC-004 cycle ${index + 1} did not confirm response marker`);
    }
    log("SC004_LIVE_CYCLE_PASS", index + 1);
    log("SC004_LIVE_CYCLE_CONTINUE_CLICKS", result.response.continue_clicks || 0);
  }

  const durable = await readSingleConversationState(statePath);
  if (durable.conversation.generation !== 1) {
    throw new Error("SC-004 created an unexpected additional conversation generation");
  }
  if (String(durable.conversation.runtime_id || "") !== runtimeId) {
    throw new Error("SC-004 changed runtime conversation identity between cycles");
  }
  if (durable.outbound.state !== "RESPONSE_COMPLETE") {
    throw new Error("SC-004 durable state did not finish RESPONSE_COMPLETE");
  }
  if (durable.source_of_truth.sync_status !== "VERIFIED") {
    throw new Error("SC-004 did not verify Source of Truth after final cycle");
  }

  await writeResult({
    status: "PASS",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    source_of_truth_digest: sha(sourceOfTruthUrl),
    bootstrap_id_digest: sha(bootstrapId),
    cycle_count: 2,
    conversation_generation: durable.conversation.generation,
    single_runtime_identity_preserved: true,
    response_complete: true,
    source_of_truth_verified: true,
    production_state_mutated: false,
    production_targets_mutated: false,
    external_system_mutation_requested: false
  });

  log("SC004_LIVE_STATUS", "PASS");
  log("SC004_LIVE_TWO_CYCLES_COMPLETE", "True");
  log("SC004_LIVE_SINGLE_CONVERSATION_GENERATION", "True");
  log("SC004_LIVE_RUNTIME_IDENTITY_PRESERVED", "True");
  log("SC004_LIVE_SOURCE_OF_TRUTH_VERIFIED", "True");
  log("SC004_LIVE_PRODUCTION_STATE_MUTATED", "False");
  log("SC004_LIVE_EXTERNAL_SYSTEM_MUTATION_REQUESTED", "False");
} catch (error) {
  await writeResult({
    status: "FAIL",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    error_name: String(error?.name || "Error"),
    error_digest: sha(String(error?.message || error)),
    production_state_mutated: false,
    production_targets_mutated: false
  }).catch(() => {});
  log("SC004_LIVE_STATUS", "FAIL");
  log("SC004_LIVE_ERROR_NAME", error?.name || "Error");
  log("SC004_LIVE_ERROR_DIGEST", sha(String(error?.message || error)));
  finalExitCode = 1;
} finally {
  if (qualificationPage && !qualificationPage.isClosed()) {
    await boundedCleanup("PAGE_CLOSE", () => adapter.closePage(qualificationPage));
  }
  await boundedCleanup("ADAPTER_CLOSE", () => adapter.close(), 1_000);
  await boundedCleanup("LOCK_CLOSE", () => lock?.close(), 1_000);
  await fs.rm(lockPath, { force: true }).catch(() => {});
}

process.exit(finalExitCode);
