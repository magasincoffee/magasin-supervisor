import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeRoot, statePath] = process.argv.slice(2);
if (!runtimeRoot || !statePath) throw new Error("runtimeRoot and statePath are required");

const mod = (rel) => import(pathToFileURL(path.join(runtimeRoot, ...rel.split("/"))).href);
const {
  readSingleConversationState,
  writeSingleConversationState
} = await mod("src/runtime/single-conversation-state.mjs");

const expected = {
  source_of_truth_url: "https://github.com/magasincoffee/OPS-WebApp/blob/main/SOURCE_OF_TRUTH.md?utm_source=chatgpt.com",
  generation: 2,
  runtime_id: "chat:67584144a078325f21e91c9d7f672a3f",
  automation_status: "BLOCKED",
  automation_reason: "EXACT_ONCE_FAILED",
  outbound_state: "ENQUEUED",
  outbound_kind: "TASK_STATUS_CHECK",
  message_id: "05059578-6bd3-45a3-bca1-a41e7446a952",
  message_digest: "d081a283515f6b6542723195291a73a08f60c2331db9326e7f4361bfc3badbb5",
  task_id: "OPS-022"
};

const state = await readSingleConversationState(statePath);
const failures = [];
if (String(state.source_of_truth?.url || "") !== expected.source_of_truth_url) failures.push("source_of_truth.url");
if (Number(state.conversation?.generation) !== expected.generation) failures.push("conversation.generation");
if (String(state.conversation?.runtime_id || "") !== expected.runtime_id) failures.push("conversation.runtime_id");
if (String(state.automation?.status || "") !== expected.automation_status) failures.push("automation.status");
if (String(state.automation?.reason || "") !== expected.automation_reason) failures.push("automation.reason");
if (String(state.outbound?.state || "") !== expected.outbound_state) failures.push("outbound.state");
if (String(state.outbound?.kind || "") !== expected.outbound_kind) failures.push("outbound.kind");
if (String(state.outbound?.message_id || "") !== expected.message_id) failures.push("outbound.message_id");
if (String(state.outbound?.message_digest || "") !== expected.message_digest) failures.push("outbound.message_digest");
const currentTaskId = String(state.outbound?.task_id || "").trim();
if (currentTaskId && currentTaskId !== expected.task_id) failures.push("outbound.task_id");

if (failures.length) {
  console.error("SC013_BACKFILL_GUARD_FAILED=" + failures.join(","));
  process.exit(2);
}

console.log("SC013_BACKFILL_GUARD_MATCH=True");
console.log("SC013_BACKFILL_MESSAGE_ID=" + expected.message_id);
console.log("SC013_BACKFILL_DIGEST_MATCH=True");
console.log("SC013_BACKFILL_TASK_ID_BEFORE=" + (currentTaskId || "NONE"));

if (!currentTaskId) {
  state.outbound.task_id = expected.task_id;
  await writeSingleConversationState(statePath, state);
  console.log("SC013_BACKFILL_MUTATED=True");
} else {
  console.log("SC013_BACKFILL_MUTATED=False");
}

const after = await readSingleConversationState(statePath);
if (String(after.outbound?.task_id || "") !== expected.task_id) {
  throw new Error("task_id backfill verification failed");
}
if (String(after.automation?.status || "") !== expected.automation_status ||
    String(after.automation?.reason || "") !== expected.automation_reason ||
    String(after.outbound?.state || "") !== expected.outbound_state ||
    String(after.outbound?.message_id || "") !== expected.message_id ||
    String(after.outbound?.message_digest || "") !== expected.message_digest) {
  throw new Error("backfill changed protected incident state");
}
console.log("SC013_BACKFILL_TASK_ID_AFTER=" + after.outbound.task_id);
console.log("SC013_BACKFILL_BLOCKED_PRESERVED=True");
console.log("SC013_BACKFILL_OUTBOUND_PRESERVED=True");
console.log("SC013_BACKFILL_STATUS=PASS");
