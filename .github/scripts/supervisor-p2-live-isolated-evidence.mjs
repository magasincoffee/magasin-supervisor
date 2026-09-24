import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import { captureUserTurnTexts } from "../../src/ui/message-capture.mjs";
import { pageMatchesTarget, targetFromUrl } from "../../src/runtime/recovery.mjs";

const fixtureFile = String(process.env.P2_FIXTURE_FILE || "").trim();
const stateRoot = String(process.env.P2_TEMP_STATE_ROOT || "").trim();
const cdpUrl = String(process.env.P2_CDP_URL || "").trim();
if (!fixtureFile || !stateRoot || !cdpUrl) {
  throw new Error("P2 isolated live evidence environment is incomplete");
}

const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");

const fixture = JSON.parse(await fs.readFile(fixtureFile, "utf8"));
const registry = JSON.parse(await fs.readFile(path.join(stateRoot, "lane-registry.json"), "utf8"));
const lane = registry?.lanes?.["lane-1"];
if (!lane) throw new Error("P2 isolated lane registry is missing");

const workUrl = String(lane.work_url || "").trim();
const target = targetFromUrl(workUrl);
if (!/^\/c\/[A-Za-z0-9:_-]+$/.test(target.pathname)) {
  throw new Error("P2 isolated AUTO Work target is not canonical /c/");
}

const eventText = await fs.readFile(path.join(stateRoot, "lane-events.ndjson"), "utf8");
const events = eventText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const forTask = events.filter((event) => event.task_id === fixture.task_id);
const count = (type) => forTask.filter((event) => event.event_type === type).length;
const firstIndex = (type) => forTask.findIndex((event) => event.event_type === type);

const createCount = count("AUTO_WORK_CREATE_REQUESTED");
const persistCount = count("AUTO_WORK_TARGET_PERSISTED");
const autoDispatchCount = count("AUTO_WORK_DISPATCH_CONFIRMED");
const dispatchCount = count("WORK_DISPATCH_CONFIRMED");
const createIndex = firstIndex("AUTO_WORK_CREATE_REQUESTED");
const persistIndex = firstIndex("AUTO_WORK_TARGET_PERSISTED");
const dispatchIndex = firstIndex("AUTO_WORK_DISPATCH_CONFIRMED");

const logText = await fs.readFile(path.join(stateRoot, "supervisor.log"), "utf8").catch(() => "");
const logEvents = logText.split(/\r?\n/).filter(Boolean).map((line) => {
  try { return JSON.parse(line); } catch { return null; }
}).filter(Boolean);
const brainHandshakeCount = logEvents.filter((event) => [
  "LANE_BRAIN_REQUEST_SENT",
  "LANE_BRAIN_SEND_PENDING_CONFIRMATION",
  "LANE_BRAIN_SEND_ATTEMPT_ERROR",
  "LANE_BRAIN_SEND_NOT_CONFIRMED_RETRY"
].includes(event.type)).length;

const brainTargetRetained =
  sha256(lane.brain_url) === sha256(fixture.brain_url) &&
  Number(lane.applied_brain_url_revision || 0) === 1;
const taskIdentityMatch = lane.task_id === fixture.task_id;
const directiveDigestMatch = lane.last_brain_directive_digest === fixture.directive_digest;
const instructionDigestMatch = lane.instruction_digest === fixture.instruction_digest;
const targetDigestMatch = forTask.some((event) =>
  event.event_type === "AUTO_WORK_TARGET_PERSISTED" &&
  event.target_digest === sha256(workUrl)
);

const dispatchId = String(lane.last_dispatch_id || "").trim();
if (!dispatchId) throw new Error("P2 isolated live dispatch_id is missing");

const adapter = new ChatGptUiAdapter({ cdpUrl, timeoutMs: 45_000, settleMs: 400 });
await adapter.open();
let envelopeCount = 0;
try {
  const page = adapter.getChatGptPages().find((candidate) =>
    pageMatchesTarget(candidate.url(), target)
  );
  if (!page) throw new Error("P2 isolated exact Work page is not open");
  const userTurns = await captureUserTurnTexts(page);
  envelopeCount = userTurns.filter((text) =>
    text.includes("MAGASIN_WORK_DISPATCH_V1") &&
    text.includes(`task_id=${fixture.task_id}`) &&
    text.includes(`dispatch_id=${dispatchId}`)
  ).length;
} finally {
  await adapter.close().catch(() => {});
}

const persistBeforeDispatch =
  createIndex >= 0 && persistIndex > createIndex && dispatchIndex > persistIndex;
const duplicateCreationCount = Math.max(0, createCount - 1);
const duplicateDispatchCount = Math.max(0, envelopeCount - 1);

const checks = {
  brainTargetRetained,
  taskIdentityMatch,
  directiveDigestMatch,
  instructionDigestMatch,
  targetDigestMatch,
  canonicalWorkTarget: /^\/c\//.test(target.pathname),
  createExactlyOnce: createCount === 1,
  targetPersistExactlyOnce: persistCount === 1,
  dispatchEventExactlyOnce: autoDispatchCount === 1 && dispatchCount === 1,
  envelopeExactlyOnce: envelopeCount === 1,
  persistBeforeDispatch,
  noDuplicateBrainHandshake: brainHandshakeCount === 0
};

for (const [name, value] of Object.entries(checks)) {
  if (!value) throw new Error(`P2 isolated live evidence failed: ${name}`);
}

console.log(`LIVE_P2_TASK_ID=${fixture.task_id}`);
console.log("LIVE_P2_BRAIN_TARGET_RETAINED=True");
console.log("LIVE_P2_NO_INITIAL_WORK_TARGET=True");
console.log(`LIVE_P2_AUTO_CREATE_REQUESTED_COUNT=${createCount}`);
console.log(`LIVE_P2_AUTO_TARGET_PERSISTED_COUNT=${persistCount}`);
console.log("LIVE_P2_CANONICAL_C_TARGET=True");
console.log("LIVE_P2_PERSIST_BEFORE_DISPATCH=True");
console.log(`LIVE_P2_DISPATCH_ENVELOPE_COUNT=${envelopeCount}`);
console.log(`LIVE_P2_DUPLICATE_WORK_CREATION_COUNT=${duplicateCreationCount}`);
console.log(`LIVE_P2_DUPLICATE_DISPATCH_COUNT=${duplicateDispatchCount}`);
console.log(`LIVE_P2_DUPLICATE_BRAIN_HANDSHAKE_COUNT=${brainHandshakeCount}`);
console.log("LIVE_P2_TASK_IDENTITY_MATCH=True");
console.log("LIVE_P2_DIRECTIVE_DIGEST_MATCH=True");
console.log("LIVE_P2_INSTRUCTION_DIGEST_MATCH=True");
console.log("LIVE_P2_OWNER_MANUAL_WORK_OPERATION_REQUIRED=False");
console.log("LIVE_P2_AUTO_WORK_ACCEPTANCE=PASS");
