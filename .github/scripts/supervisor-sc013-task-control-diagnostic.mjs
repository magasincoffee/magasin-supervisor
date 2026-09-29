import path from "node:path";
import process from "node:process";

import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import { captureLatestRoleTurn } from "../../src/ui/latest-turn.mjs";
import {
  parseTaskControl
} from "../../src/runtime/single-conversation-loop.mjs";
import {
  resumeExistingConversationPage
} from "../../src/runtime/single-conversation-cli.mjs";
import {
  readSingleConversationState
} from "../../src/runtime/single-conversation-state.mjs";

const root = String(process.argv[2] || "").trim();
if (!root) throw new Error("state root is required");
const cdpUrl = String(process.env.SUPERVISOR_SC013_CDP_URL || "").trim();
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl)) {
  throw new Error("SUPERVISOR_SC013_CDP_URL must be a local CDP endpoint");
}

const statePath = path.join(root, "single-conversation-state.json");
const state = await readSingleConversationState(statePath);

function log(key, value) {
  console.log(String(key) + "=" + String(value));
}

log("SC013_STATE_GENERATION", state.conversation?.generation ?? "");
log("SC013_STATE_CONVERSATION_STATUS", state.conversation?.status ?? "");
log("SC013_STATE_OUTBOUND", state.outbound?.state ?? "");
log("SC013_STATE_AUTOMATION", state.automation?.status ?? "");
log("SC013_STATE_PHASE", state.automation?.phase ?? "");
log("SC013_RUNTIME_ID_PRESENT", Boolean(state.conversation?.runtime_id));

const adapter = new ChatGptUiAdapter({
  cdpUrl,
  settleMs: 400,
  actionTimeoutMs: 10_000,
  timeoutMs: 45_000
});

let exitCode = 0;
try {
  await adapter.open();
  const rebound = await resumeExistingConversationPage({ adapter, state });
  if (!rebound?.page) {
    log("SC013_REBIND", "FAIL");
    throw Object.assign(
      new Error("production conversation could not be rebound read-only"),
      { code: "READ_ONLY_REBIND_FAILED" }
    );
  }
  log("SC013_REBIND", "PASS");
  log("SC013_REBIND_FROM", rebound.recovered_from || "");

  const assistant = await captureLatestRoleTurn(rebound.page, "assistant")
    .catch(() => null);
  if (!assistant?.text) {
    throw Object.assign(
      new Error("latest production assistant turn is unavailable"),
      { code: "ASSISTANT_TURN_UNAVAILABLE" }
    );
  }

  const text = String(assistant.text);
  log("SC013_ASSISTANT_TEXT_LENGTH", text.length);
  log("SC013_HAS_TASK_HEADER", text.includes("MAGASIN_TASK_CONTROL_V1"));
  log("SC013_HAS_TASK_FOOTER", text.includes("END_MAGASIN_TASK_CONTROL_V1"));
  log(
    "SC013_HAS_BOOTSTRAP_CORRELATION",
    /MAGASIN_BOOTSTRAP_CORRELATION_V1\s+[0-9a-f-]{16,}/i.test(text)
  );

  const block = text.match(
    /MAGASIN_TASK_CONTROL_V1[\s\S]*?END_MAGASIN_TASK_CONTROL_V1/
  )?.[0] || "";
  if (block) {
    // Only emit the protocol block, never arbitrary assistant prose.
    log("SC013_PROTOCOL_BLOCK_BEGIN", "True");
    console.log(block.slice(0, 2000));
    log("SC013_PROTOCOL_BLOCK_END", "True");
  }

  try {
    const parsed = parseTaskControl(text);
    log("SC013_PARSE", "PASS");
    log("SC013_STATUS", parsed.status);
    log("SC013_TASK_ID", parsed.task_id || "NONE");
    log("SC013_NEXT_TASK_ID", parsed.next_task_id || "NONE");
    log("SC013_CHECK_AFTER_SECONDS", parsed.check_after_seconds);
  } catch (error) {
    log("SC013_PARSE", "FAIL");
    log("SC013_PARSE_CODE", error?.code || "");
    log("SC013_PARSE_MESSAGE", String(error?.message || "").slice(0, 240));
    exitCode = 2;
  }
} catch (error) {
  log("SC013_DIAG_ERROR_CODE", error?.code || error?.name || "Error");
  log("SC013_DIAG_ERROR_MESSAGE", String(error?.message || "").slice(0, 240));
  exitCode = exitCode || 3;
} finally {
  await Promise.race([
    adapter.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1500))
  ]);
}

process.exit(exitCode);
