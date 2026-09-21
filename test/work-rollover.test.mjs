import test from "node:test";
import assert from "node:assert/strict";

import {
  WORK_ROLLOVER_STAGES,
  beginWorkRollover,
  markBlankTargetCreating,
  markRolloverDispatchConfirmed,
  markRolloverDispatchLatchPersisted,
  markRolloverIntentPersisted,
  markRolloverTargetPersisted,
  normalizeWorkRollover,
  rolloverMatchesDirective
} from "../src/runtime/work-rollover.mjs";

const TASK = "TASK-RBT-006-FIXTURE";
const DIRECTIVE = "a".repeat(64);
const INSTRUCTION = "b".repeat(64);
const OLD_TARGET = "c".repeat(64);
const NEW_TARGET = "d".repeat(64);
const DISPATCH = "e".repeat(32);
const OUTGOING = "f".repeat(64);
const T0 = "2026-09-20T15:00:00.000Z";

function fresh() {
  return beginWorkRollover({
    reason: "FULL_CONFIRMED",
    taskId: TASK,
    directiveDigest: DIRECTIVE,
    directiveInstructionDigest: INSTRUCTION,
    oldWorkGeneration: 7,
    oldWorkUrlRevision: 4,
    oldWorkTargetDigest: OLD_TARGET,
    capacityEvidenceCodes: ["LEGACY_FULL_TEXT", "COMPOSER_CAPACITY_BLOCKED"],
    at: T0
  });
}

test("FULL_CONFIRMED starts restart-safe rollover without generation change", () => {
  const state = fresh();
  assert.equal(state.stage, WORK_ROLLOVER_STAGES.FULL_CONFIRMED);
  assert.equal(state.old_work_generation, 7);
  assert.equal(state.new_work_generation, 0);
  assert.equal(state.dispatch_id, null);
});

test("rollover stages advance in canonical order", () => {
  let state = fresh();
  state = markRolloverIntentPersisted(state, { at: T0 });
  assert.equal(state.stage, WORK_ROLLOVER_STAGES.INTENT_PERSISTED);
  state = markBlankTargetCreating(state, { at: T0 });
  assert.equal(state.stage, WORK_ROLLOVER_STAGES.BLANK_TARGET_CREATING);
  state = markRolloverTargetPersisted(state, {
    newWorkGeneration: 8,
    newWorkTargetDigest: NEW_TARGET,
    at: T0
  });
  assert.equal(state.stage, WORK_ROLLOVER_STAGES.TARGET_PERSISTED);
  assert.equal(state.new_work_generation, 8);
  state = markRolloverDispatchLatchPersisted(state, {
    dispatchId: DISPATCH,
    instructionDigest: OUTGOING,
    at: T0
  });
  assert.equal(state.stage, WORK_ROLLOVER_STAGES.DISPATCH_LATCH_PERSISTED);
  state = markRolloverDispatchConfirmed(state, {
    dispatchId: DISPATCH,
    at: T0
  });
  assert.equal(state.stage, WORK_ROLLOVER_STAGES.DISPATCH_CONFIRMED);
});

test("generation must increment exactly once at TARGET_PERSISTED", () => {
  let state = markBlankTargetCreating(
    markRolloverIntentPersisted(fresh(), { at: T0 }),
    { at: T0 }
  );
  assert.throws(
    () => markRolloverTargetPersisted(state, {
      newWorkGeneration: 7,
      newWorkTargetDigest: NEW_TARGET,
      at: T0
    }),
    /increment exactly once/
  );
  assert.throws(
    () => markRolloverTargetPersisted(state, {
      newWorkGeneration: 9,
      newWorkTargetDigest: NEW_TARGET,
      at: T0
    }),
    /increment exactly once/
  );
  state = markRolloverTargetPersisted(state, {
    newWorkGeneration: 8,
    newWorkTargetDigest: NEW_TARGET,
    at: T0
  });
  assert.equal(state.new_work_generation, 8);
  assert.throws(
    () => markRolloverTargetPersisted(state, {
      newWorkGeneration: 8,
      newWorkTargetDigest: NEW_TARGET,
      at: T0
    }),
    /BLANK_TARGET_CREATING/
  );
});

test("crash/restart normalization preserves every durable stage deterministically", () => {
  const stages = [];
  let state = fresh();
  stages.push(state);
  state = markRolloverIntentPersisted(state, { at: T0 });
  stages.push(state);
  state = markBlankTargetCreating(state, { at: T0 });
  stages.push(state);
  state = markRolloverTargetPersisted(state, {
    newWorkGeneration: 8,
    newWorkTargetDigest: NEW_TARGET,
    at: T0
  });
  stages.push(state);
  state = markRolloverDispatchLatchPersisted(state, {
    dispatchId: DISPATCH,
    instructionDigest: OUTGOING,
    at: T0
  });
  stages.push(state);
  state = markRolloverDispatchConfirmed(state, {
    dispatchId: DISPATCH,
    at: T0
  });
  stages.push(state);

  for (const before of stages) {
    const restarted = normalizeWorkRollover(
      JSON.parse(JSON.stringify(before))
    );
    assert.deepEqual(restarted, before);
  }
});

test("BLANK_TARGET_CREATING is idempotent across restart before target persistence", () => {
  let state = markRolloverIntentPersisted(fresh(), { at: T0 });
  state = markBlankTargetCreating(state, { at: T0 });
  const restarted = normalizeWorkRollover(JSON.parse(JSON.stringify(state)));
  const resumed = markBlankTargetCreating(restarted, {
    at: "2026-09-20T15:00:10.000Z"
  });
  assert.equal(resumed.stage, WORK_ROLLOVER_STAGES.BLANK_TARGET_CREATING);
  assert.equal(resumed.blank_target_creating_at, T0);
  assert.equal(resumed.new_work_generation, 0);
});

test("same deterministic dispatch identity is required for confirmation", () => {
  let state = markBlankTargetCreating(
    markRolloverIntentPersisted(fresh(), { at: T0 }),
    { at: T0 }
  );
  state = markRolloverTargetPersisted(state, {
    newWorkGeneration: 8,
    newWorkTargetDigest: NEW_TARGET,
    at: T0
  });
  state = markRolloverDispatchLatchPersisted(state, {
    dispatchId: DISPATCH,
    instructionDigest: OUTGOING,
    at: T0
  });
  assert.throws(
    () => markRolloverDispatchConfirmed(state, {
      dispatchId: "1".repeat(32),
      at: T0
    }),
    /identity mismatch/
  );
  assert.equal(
    markRolloverDispatchConfirmed(state, {
      dispatchId: DISPATCH,
      at: T0
    }).dispatch_id,
    DISPATCH
  );
});

test("rollover identity remains pinned to one Brain directive", () => {
  const state = fresh();
  assert.equal(
    rolloverMatchesDirective(state, {
      task_id: TASK,
      digest: DIRECTIVE
    }),
    true
  );
  assert.equal(
    rolloverMatchesDirective(state, {
      task_id: TASK,
      digest: "0".repeat(64)
    }),
    false
  );
});

test("rollover durable state stores target digests rather than raw URLs", () => {
  const text = JSON.stringify(fresh());
  assert.equal(text.includes("chatgpt.com"), false);
  assert.equal(text.includes("http"), false);
});
