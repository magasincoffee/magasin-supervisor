import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeRoot,statePath,expectedMessageId] = process.argv.slice(2);
if (!runtimeRoot || !statePath || !expectedMessageId) throw new Error("missing arguments");
const mod = (rel) => import(pathToFileURL(path.join(runtimeRoot, ...rel.split("/"))).href);
const { readSingleConversationState, writeSingleConversationState } =
  await mod("src/runtime/single-conversation-state.mjs");

const state = await readSingleConversationState(statePath);
const outbound = state.outbound || {};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

assert(outbound.message_id === expectedMessageId, "message id changed; refuse backfill");
assert(String(outbound.state || "").toUpperCase() === "ENQUEUED", "outbound no longer ENQUEUED");
assert(outbound.kind === "SOURCE_OF_TRUTH_TASK_DISCOVERY", "unexpected outbound kind");
assert(Number(outbound.retry_count || 0) === 0, "retry count changed");
assert(!outbound.delivered_at && !outbound.response_complete_at && !outbound.verified_at,
  "delivery/response evidence already exists");
assert(outbound.last_error_code === "AMBIGUOUS_ENQUEUED_OUTCOME",
  "unexpected current error; refuse legacy evidence backfill");
if (outbound.last_pre_actuation_error_code) {
  assert(
    outbound.last_pre_actuation_error_code === "COMPOSER_NOT_READY",
    "different pre-actuation evidence already exists"
  );
  assert(
    outbound.last_pre_actuation_error_stage ===
      "LEGACY_CONFIRMED_PRE_ACTUATION_RUN_36662422754",
    "different pre-actuation evidence stage already exists"
  );
} else {
  outbound.last_pre_actuation_error_code = "COMPOSER_NOT_READY";
  outbound.last_pre_actuation_error_stage =
    "LEGACY_CONFIRMED_PRE_ACTUATION_RUN_36662422754";
  await writeSingleConversationState(statePath, state);
}

const after = await readSingleConversationState(statePath);
console.log("SC013_BACKFILL_MESSAGE_ID=" + after.outbound.message_id);
console.log("SC013_BACKFILL_STATE=" + after.outbound.state);
console.log("SC013_BACKFILL_RETRY=" + after.outbound.retry_count);
console.log("SC013_BACKFILL_LAST_ERROR=" + after.outbound.last_error_code);
console.log("SC013_BACKFILL_PREACTUATION_CODE=" + after.outbound.last_pre_actuation_error_code);
console.log("SC013_BACKFILL_PREACTUATION_STAGE=" + after.outbound.last_pre_actuation_error_stage);
console.log("SC013_BACKFILL_STATUS=PASS");
