import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import { createNewChatAndBootstrap } from "../../src/runtime/single-conversation-bootstrap.mjs";
import { readSingleConversationState } from "../../src/runtime/single-conversation-state.mjs";

const stateRoot = String(process.argv[2] || "").trim();
const revision = String(process.argv[3] || process.env.GITHUB_SHA || "unknown").trim();
if (!stateRoot) throw new Error("state root is required");

const safeRevision = revision.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
const diagDir = path.join(stateRoot, "diagnostics", "sc003-live");
const statePath = path.join(diagDir, `${safeRevision}.state.json`);
const resultPath = path.join(diagDir, `${safeRevision}.result.json`);
const lockPath = path.join(diagDir, `${safeRevision}.lock`);
const sourceOfTruthUrl =
  "https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md";
const messageId = `SC003-LIVE-${safeRevision.slice(0, 16)}`;

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
      schema_version: "sc003-live-qualification.v1",
      revision: safeRevision,
      ...value
    }, null, 2) + "\n",
    "utf8"
  );
}

const prior = await readResult();
if (prior?.status === "PASS") {
  log("SC003_LIVE_PRIOR_PASS", "True");
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
      log("SC003_LIVE_SHARED_TARGET_PRIOR_PASS", "True");
      process.exit(0);
    }
    if (result?.status === "FAIL") {
      throw new Error("parallel SC-003 target attempt recorded FAIL");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("parallel SC-003 target attempt lock timed out");
}

const cdpUrl = String(process.env.SUPERVISOR_SC003_CDP_URL || "").trim();
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl)) {
  throw new Error("SUPERVISOR_SC003_CDP_URL must be a local dynamic CDP endpoint");
}

const adapter = new ChatGptUiAdapter({
  cdpUrl,
  settleMs: 500,
  actionTimeoutMs: 10_000,
  timeoutMs: 45_000
});

let qualificationPage = null;
const startedAt = new Date().toISOString();

try {
  await adapter.open();

  // Failed pre-send qualification attempts remain on the ChatGPT landing
  // surface because no matching user turn was ever observed. The legacy
  // production topology owns two conversation pages, so close only surplus
  // root landing pages before counting the live budget. Never close a
  // conversation-path page here.
  let currentPages = adapter.getChatGptPages();
  if (currentPages.length > 2) {
    let cleaned = 0;
    for (const candidate of currentPages) {
      let isLanding = false;
      try {
        const url = new URL(String(candidate.url() || ""));
        isLanding = url.origin === "https://chatgpt.com" && url.pathname === "/";
      } catch {}
      if (!isLanding) continue;
      await adapter.closePage(candidate).catch(() => {});
      cleaned += 1;
      if (adapter.getChatGptPageCount() <= 2) break;
    }
    if (cleaned > 0) {
      log("SC003_LIVE_SURPLUS_LANDING_PAGES_CLEANED", cleaned);
    }
  }

  const preexistingPages = adapter.getChatGptPageCount();
  log("SC003_LIVE_PREEXISTING_CHATGPT_PAGES", preexistingPages);
  if (preexistingPages > 3) {
    throw new Error(
      `SC-003 qualification refuses to exceed four-page budget; preexisting=${preexistingPages}`
    );
  }

  const result = await createNewChatAndBootstrap({
    adapter,
    statePath,
    sourceOfTruthUrl,
    projectId: "LIVE",
    messageId,
    qualificationOnly: true,
    forceNewPage: true,
    timeoutMs: 180_000,
    pollMs: 500,
    onPageAcquired: (page) => {
      qualificationPage = page;
    },
    onStage: (stage, evidence = {}) => {
      log("SC003_LIVE_STAGE", stage);
      if (evidence.message_length !== undefined) {
        log("SC003_LIVE_MESSAGE_LENGTH", evidence.message_length);
      }
      if (evidence.input_method) {
        log("SC003_LIVE_INPUT_METHOD", evidence.input_method);
      }
      if (evidence.send_method) {
        log("SC003_LIVE_SEND_METHOD", evidence.send_method);
      }
      if (evidence.rejection_class) {
        log("SC003_LIVE_REJECTION_CLASS", evidence.rejection_class);
      }
      if (evidence.user_turn_evidence) {
        log("SC003_LIVE_USER_TURN_EVIDENCE", evidence.user_turn_evidence);
      }
      if (evidence.conversation_turn_count !== undefined) {
        log("SC003_LIVE_CONVERSATION_TURN_COUNT", evidence.conversation_turn_count);
      }
      if (evidence.direct_user_count !== undefined) {
        log("SC003_LIVE_DIRECT_USER_COUNT", evidence.direct_user_count);
      }
      if (evidence.mismatch) {
        log("SC003_LIVE_MISMATCH_EXPECTED_LEN", evidence.mismatch.expected_len);
        log("SC003_LIVE_MISMATCH_ACTUAL_LEN", evidence.mismatch.actual_len);
        log("SC003_LIVE_MISMATCH_FIRST_DIFF", evidence.mismatch.first_diff);
        log("SC003_LIVE_MISMATCH_EXPECTED_CP", evidence.mismatch.expected_cp);
        log("SC003_LIVE_MISMATCH_ACTUAL_CP", evidence.mismatch.actual_cp);
      }
      if (evidence.after_enter) {
        log("SC003_LIVE_AFTER_ENTER_STILL_HOME", evidence.after_enter.still_home);
        log("SC003_LIVE_AFTER_ENTER_CONVERSATION_PATH", evidence.after_enter.conversation_path);
        log("SC003_LIVE_AFTER_ENTER_COMPOSER_PRESENT", evidence.after_enter.composer_present);
        log("SC003_LIVE_AFTER_ENTER_EXACT_PROMPT", evidence.after_enter.exact_prompt_present);
        log("SC003_LIVE_AFTER_ENTER_TURN_COUNT", evidence.after_enter.conversation_turn_count);
      }
      if (evidence.status) {
        log("SC003_LIVE_RESPONSE_STATUS", evidence.status);
      }
    }
  });
  qualificationPage = result.page;

  if (result.response?.status !== "RESPONSE_COMPLETE") {
    throw new Error(
      `SC-003 qualification response incomplete: ${result.response?.status || "UNKNOWN"}`
    );
  }

  const assistantText = String(result.response.assistant_turn?.text || "");
  if (!assistantText.includes(`MAGASIN_BOOTSTRAP_CORRELATION_V1 ${messageId}`)) {
    throw new Error("SC-003 assistant response missing exact bootstrap correlation");
  }
  if (!assistantText.includes("SINGLE_CONVERSATION_V1")) {
    throw new Error(
      "SC-003 assistant response did not report Source of Truth architecture generation"
    );
  }

  const durable = await readSingleConversationState(statePath);
  if (durable.outbound.state !== "RESPONSE_COMPLETE") {
    throw new Error("SC-003 durable state did not reach RESPONSE_COMPLETE");
  }
  if (durable.conversation.generation !== 1) {
    throw new Error(
      "SC-003 durable state did not create exactly one conversation generation"
    );
  }
  if (!/^chat:[0-9a-f]{32}$/.test(String(durable.conversation.runtime_id || ""))) {
    throw new Error(
      "SC-003 durable state missing opaque conversation runtime identity"
    );
  }

  const rawState = await fs.readFile(statePath, "utf8");
  if (/https:\/\/chatgpt\.com\/(?:c|g|project)\//i.test(rawState)) {
    throw new Error("SC-003 durable state leaked a conversation URL");
  }

  await writeResult({
    status: "PASS",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    source_of_truth_digest: sha(sourceOfTruthUrl),
    message_id_digest: sha(messageId),
    assistant_turn_digest: result.response.assistant_turn?.digest || null,
    preexisting_chatgpt_pages: preexistingPages,
    fresh_chat_created: true,
    matching_user_turn_required: true,
    response_complete: true,
    reported_architecture_generation: true,
    conversation_url_persisted: false,
    production_state_mutated: false,
    production_targets_mutated: false,
    external_system_mutation_requested: false
  });

  log("SC003_LIVE_STATUS", "PASS");
  log("SC003_LIVE_FRESH_CHAT_CREATED", "True");
  log("SC003_LIVE_MATCHING_USER_TURN_REQUIRED", "True");
  log("SC003_LIVE_RESPONSE_COMPLETE", "True");
  log("SC003_LIVE_ARCHITECTURE_GENERATION_CONFIRMED", "True");
  log("SC003_LIVE_CONVERSATION_URL_PERSISTED", "False");
  log("SC003_LIVE_PRODUCTION_STATE_MUTATED", "False");
  log("SC003_LIVE_EXTERNAL_SYSTEM_MUTATION_REQUESTED", "False");
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
  log("SC003_LIVE_STATUS", "FAIL");
  log("SC003_LIVE_ERROR_NAME", error?.name || "Error");
  log("SC003_LIVE_ERROR_DIGEST", sha(String(error?.message || error)));
  throw error;
} finally {
  if (qualificationPage && !qualificationPage.isClosed()) {
    await adapter.closePage(qualificationPage).catch(() => {});
  }
  await adapter.close().catch(() => {});
  await lock?.close().catch(() => {});
  await fs.rm(lockPath, { force: true }).catch(() => {});
}
