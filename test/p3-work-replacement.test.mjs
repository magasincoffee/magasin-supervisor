import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  WORK_ROLLOVER_REASONS,
  WORK_ROLLOVER_STAGES,
  beginWorkRollover,
  markBlankTargetCreating,
  markRolloverTargetPersisted,
  normalizeWorkRollover
} from "../src/runtime/work-rollover.mjs";

async function read(rel) {
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

const TASK = "SUP-SELFHEAL-P3-FIXTURE";
const DIRECTIVE = "a".repeat(64);
const INSTRUCTION = "b".repeat(64);
const OLD = "c".repeat(64);
const NEW = "d".repeat(64);
const T0 = "2026-09-24T13:45:00.000Z";

function replacement(reason = WORK_ROLLOVER_REASONS.UNUSABLE_TARGET) {
  return beginWorkRollover({
    reason,
    taskId: TASK,
    directiveDigest: DIRECTIVE,
    directiveInstructionDigest: INSTRUCTION,
    oldWorkGeneration: 4,
    oldWorkUrlRevision: 7,
    oldWorkTargetDigest: OLD,
    capacityEvidenceCodes: ["TARGET_CONVERSATION_MISSING"],
    at: T0
  });
}

test("P3 unusable and stalled replacements start with durable intent already persisted", () => {
  for (const reason of [
    WORK_ROLLOVER_REASONS.UNUSABLE_TARGET,
    WORK_ROLLOVER_REASONS.POSSIBLY_STALLED,
    WORK_ROLLOVER_REASONS.IDENTITY_FAILURE
  ]) {
    const state = replacement(reason);
    assert.equal(state.stage, WORK_ROLLOVER_STAGES.INTENT_PERSISTED);
    assert.equal(state.reason, reason);
    assert.equal(state.task_id, TASK);
    assert.equal(state.directive_digest, DIRECTIVE);
    assert.equal(state.directive_instruction_digest, INSTRUCTION);
    assert.equal(state.old_work_generation, 4);
    assert.equal(state.intent_persisted_at, T0);
  }
});

test("P3 replacement increments generation exactly once and survives restart", () => {
  let state = replacement();
  state = markBlankTargetCreating(state, { at: T0 });
  state = markRolloverTargetPersisted(state, {
    newWorkGeneration: 5,
    newWorkTargetDigest: NEW,
    at: T0
  });
  assert.equal(state.new_work_generation, 5);
  assert.deepEqual(
    normalizeWorkRollover(JSON.parse(JSON.stringify(state))),
    state
  );
});

test("P3 active replacement recovers exact Brain directive and rejects newer user intervention", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const start = runtime.indexOf("async function recoverActiveWorkDirective");
  const end = runtime.indexOf("async function findBrainDirectiveForLatch", start);
  assert.ok(start >= 0 && end > start);
  const helper = runtime.slice(start, end);

  assert.match(helper, /directive\.task_id !== registryLane\.task_id/);
  assert.match(helper, /directive\.digest !== registryLane\.last_brain_directive_digest/);
  assert.match(helper, /directive\.instruction_digest !== registryLane\.instruction_digest/);
  assert.match(helper, /newerUserTurn/);
  assert.match(helper, /if \(newerUserTurn\) return null/);
});

test("P3 replacement intent preserves unresolved task state and uses old target digest", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const start = runtime.indexOf("async function beginActiveWorkReplacement");
  const end = runtime.indexOf("async function findBrainDirectiveForLatch", start);
  assert.ok(start >= 0 && end > start);
  const helper = runtime.slice(start, end);

  assert.match(helper, /registryLane\.awaiting_work/);
  assert.match(helper, /registryLane\.relay_inflight/);
  assert.match(helper, /oldWorkGeneration: Number\(registryLane\.work_generation/);
  assert.match(helper, /oldWorkTargetDigest: registryLane\.work_url/);
  assert.match(helper, /WORK_ROLLOVER_INTENT/);
  assert.doesNotMatch(helper, /registryLane\.awaiting_work\s*=\s*false/);
  assert.doesNotMatch(helper, /registryLane\.task_id\s*=/);
});

test("P3 deterministic target quarantine and bounded watchdog stall both enter replacement path", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  assert.match(runtime, /currentTargetIsQuarantined\(registryLane, \{ brain: false \}\)/);
  assert.match(runtime, /reason: WORK_ROLLOVER_REASONS\.UNUSABLE_TARGET/);
  assert.match(runtime, /WORK_WATCHDOG_DECISIONS\.POSSIBLY_STALLED/);
  assert.match(runtime, /reason: WORK_ROLLOVER_REASONS\.POSSIBLY_STALLED/);
});

test("P3 live quarantine fixture binds evidence to the active Work URL identity", async () => {
  const harness = await read("../.github/scripts/supervisor-p2-live-isolated.ps1");
  assert.match(harness, /function Get-Sha256Hex/);
  assert.match(harness, /\$oldTargetDigest = Get-Sha256Hex \$oldWorkUrl/);
  assert.match(
    harness,
    /target_revision = \[int\]\(Get-OptionalPropertyValue \$beforeLane "applied_work_url_revision"\)/
  );
  assert.match(harness, /LIVE_P3_QUARANTINE_IDENTITY_MATCHES_ACTIVE_URL=True/);
});

test("P3 replacement continuation still rechecks Owner STOP before browser mutation", async () => {
  const runtime = await read("../src/runtime/three-lane-cli.mjs");
  const start = runtime.indexOf("async function dispatchWork");
  const end = runtime.indexOf("async function reconcileRelayInflight", start);
  const dispatch = runtime.slice(start, end);

  assert.match(dispatch, /replacementContinuation/);
  assert.match(dispatch, /isLaneMutationAllowed/);
  assert.match(dispatch, /createBlankWorkTarget/);
  assert.ok(
    dispatch.indexOf("isLaneMutationAllowed") <
    dispatch.indexOf("createBlankWorkTarget")
  );
});
