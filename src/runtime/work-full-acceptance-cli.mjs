import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  WORK_CAPACITY_STATES,
  evaluateWorkCapacity
} from "./work-capacity.mjs";
import {
  WORK_ROLLOVER_STAGES,
  beginWorkRollover,
  markBlankTargetCreating,
  markRolloverDispatchConfirmed,
  markRolloverDispatchLatchPersisted,
  markRolloverIntentPersisted,
  markRolloverTargetPersisted,
  normalizeWorkRollover
} from "./work-rollover.mjs";
import {
  applyPendingWorkTargetIfSafe
} from "./work-target-state.mjs";
import {
  sha256
} from "./three-lane.mjs";

const base = (overrides = {}) => ({
  explicit_full_limit_ui: false,
  composer_capacity_blocked: false,
  send_rejection_capacity: false,
  legacy_conversation_full: false,
  response_running: false,
  incomplete_turn: false,
  network_error: false,
  security_blocked: false,
  transient_state: false,
  conversation_missing: false,
  ...overrides
});

const singleRegex = evaluateWorkCapacity({
  first: base({ legacy_conversation_full: true }),
  second: base({ legacy_conversation_full: true }),
  stableIdentity: true,
  stableProbeCount: 2
});
assert.equal(singleRegex.state, WORK_CAPACITY_STATES.AMBIGUOUS);

const multiSignal = evaluateWorkCapacity({
  first: base({
    legacy_conversation_full: true,
    composer_capacity_blocked: true
  }),
  second: base({
    legacy_conversation_full: true,
    composer_capacity_blocked: true
  }),
  stableIdentity: true,
  stableProbeCount: 2
});
assert.equal(multiSignal.state, WORK_CAPACITY_STATES.FULL_CONFIRMED);

const running = evaluateWorkCapacity({
  first: base({
    explicit_full_limit_ui: true,
    response_running: true
  }),
  second: base({ explicit_full_limit_ui: true }),
  stableIdentity: true,
  stableProbeCount: 2
});
assert.equal(running.state, WORK_CAPACITY_STATES.NOT_FULL);

const taskId = "TASK-RBT-006-FIXTURE";
const directiveDigest = "a".repeat(64);
const instructionDigest = "b".repeat(64);
const oldTargetDigest = "c".repeat(64);
const newTargetDigest = "d".repeat(64);
const dispatchId = sha256(["lane-1", taskId, directiveDigest].join("|")).slice(0, 32);
const outgoingDigest = "e".repeat(64);
const at = "2026-09-20T15:30:00.000Z";

let rollover = beginWorkRollover({
  reason: "FULL_CONFIRMED",
  taskId,
  directiveDigest,
  directiveInstructionDigest: instructionDigest,
  oldWorkGeneration: 11,
  oldWorkUrlRevision: 5,
  oldWorkTargetDigest: oldTargetDigest,
  capacityEvidenceCodes: multiSignal.evidence_codes,
  at
});
rollover = markRolloverIntentPersisted(rollover, { at });
rollover = markBlankTargetCreating(rollover, { at });

const crashBeforeTarget = normalizeWorkRollover(
  JSON.parse(JSON.stringify(rollover))
);
assert.equal(
  crashBeforeTarget.stage,
  WORK_ROLLOVER_STAGES.BLANK_TARGET_CREATING
);
assert.equal(crashBeforeTarget.new_work_generation, 0);

rollover = markRolloverTargetPersisted(rollover, {
  newWorkGeneration: 12,
  newWorkTargetDigest: newTargetDigest,
  at
});
assert.equal(rollover.new_work_generation, 12);
assert.throws(() => markRolloverTargetPersisted(rollover, {
  newWorkGeneration: 12,
  newWorkTargetDigest: newTargetDigest,
  at
}));

const crashAfterTarget = normalizeWorkRollover(
  JSON.parse(JSON.stringify(rollover))
);
assert.equal(crashAfterTarget.new_work_generation, 12);

rollover = markRolloverDispatchLatchPersisted(rollover, {
  dispatchId,
  instructionDigest: outgoingDigest,
  at
});
const crashAfterLatch = normalizeWorkRollover(
  JSON.parse(JSON.stringify(rollover))
);
assert.equal(crashAfterLatch.dispatch_id, dispatchId);

rollover = markRolloverDispatchConfirmed(rollover, {
  dispatchId,
  at
});
assert.equal(rollover.stage, WORK_ROLLOVER_STAGES.DISPATCH_CONFIRMED);

const pendingLane = {
  work_url: "https://chatgpt.com/c/old",
  applied_work_mode: "AUTO",
  applied_work_url_revision: 4,
  work_generation: 11,
  pending_work_url: "https://chatgpt.com/c/owner-next",
  pending_work_url_revision: 5,
  pending_work_saved_at: at,
  pending_work_mode: "OWNER",
  awaiting_work: false,
  dispatch_inflight: null,
  relay_inflight: null,
  task_timing: {},
  work_rollover: beginWorkRollover({
    reason: "FULL_CONFIRMED",
    taskId,
    directiveDigest,
    oldWorkGeneration: 11,
    oldWorkUrlRevision: 4,
    oldWorkTargetDigest: oldTargetDigest,
    capacityEvidenceCodes: ["LEGACY_FULL_TEXT", "COMPOSER_CAPACITY_BLOCKED"],
    at
  })
};
const ownerPrecedence = applyPendingWorkTargetIfSafe(pendingLane);
assert.equal(ownerPrecedence.status, "APPLIED");
assert.equal(pendingLane.work_url, "https://chatgpt.com/c/owner-next");

const runtime = await fs.readFile(
  new URL("./three-lane-cli.mjs", import.meta.url),
  "utf8"
);
const dispatchStart = runtime.indexOf("async function dispatchWork");
const dispatchEnd = runtime.indexOf("async function reconcileRelayInflight", dispatchStart);
const dispatchSource = runtime.slice(dispatchStart, dispatchEnd);
const blankStart = runtime.indexOf("async function createBlankWorkTarget");
const blankEnd = runtime.indexOf("async function dispatchWork", blankStart);
const blankSource = runtime.slice(blankStart, blankEnd);
const turnStart = runtime.indexOf("async function processLaneTurn");
const turnEnd = runtime.indexOf("async function processLane(args)", turnStart);
const turnSource = runtime.slice(turnStart, turnEnd);

assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart);
assert.ok(blankStart >= 0 && blankEnd > blankStart);
assert.doesNotMatch(blankSource, /sendComposerInstruction/);
assert.match(blankSource, /waitForConversationUrl/);
assert.doesNotMatch(runtime, /if \(probe\.snapshot\.conversationFull\)/);

const targetPersistIndex = dispatchSource.indexOf("markRolloverTargetPersisted");
const latchPersistIndex = dispatchSource.indexOf("markRolloverDispatchLatchPersisted");
const sendIndex = dispatchSource.indexOf("sendComposerInstruction");
assert.ok(targetPersistIndex >= 0);
assert.ok(latchPersistIndex > targetPersistIndex);
assert.ok(sendIndex > latchPersistIndex);
assert.match(dispatchSource, /hasUserTurnMarker\(page, workDispatchMarker\(dispatchId\)\)/);
assert.match(dispatchSource, /work_target_digest: targetDigest/);
assert.match(dispatchSource, /rollover_generation:/);
assert.match(dispatchSource, /send_attempted_at/);
assert.match(dispatchSource, /isLaneMutationAllowed/);
assert.doesNotMatch(dispatchSource, /brain_url\s*=/);

const pendingIndex = turnSource.indexOf("applyPendingWorkTargetAtSafeBoundary");
const dispatchIndex = turnSource.indexOf("dispatchWork({");
assert.ok(pendingIndex >= 0 && dispatchIndex > pendingIndex);

console.log("WORK_FULL_FIXTURE_SINGLE_REGEX_NO_ROLLOVER=True");
console.log("WORK_FULL_FIXTURE_MULTI_SIGNAL_CONFIRMED=True");
console.log("WORK_FULL_FIXTURE_RUNNING_RESPONSE_GUARDED=True");
console.log("WORK_FULL_FIXTURE_BLANK_TARGET_BEFORE_SEND=True");
console.log("WORK_FULL_FIXTURE_TARGET_PERSISTED_BEFORE_DISPATCH=True");
console.log("WORK_FULL_FIXTURE_GENERATION_ONCE=True");
console.log("WORK_FULL_FIXTURE_CRASH_RESUME=True");
console.log("WORK_FULL_FIXTURE_DISPATCH_EXACT_ONCE=True");
console.log("WORK_FULL_FIXTURE_PENDING_OWNER_TARGET_PRECEDENCE=True");
console.log("WORK_FULL_FIXTURE_NO_BRAIN_CHANGE=True");
