import test from "node:test";
import assert from "node:assert/strict";
import {
  WORK_TARGET_MODES,
  acceptOwnerWorkTargetRevision,
  applyPendingWorkTargetIfSafe,
  hasActiveWorkTransaction
} from "../src/runtime/work-target-state.mjs";

function lane(overrides = {}) {
  return {
    lane_id: "lane-1",
    work_url: "https://chatgpt.com/c/old",
    work_generation: 4,
    applied_work_mode: WORK_TARGET_MODES.OWNER,
    applied_work_url_revision: 1,
    applied_work_saved_at: "2026-09-20T00:00:00.000Z",
    pending_work_url: "",
    pending_work_url_revision: 0,
    pending_work_saved_at: null,
    pending_work_mode: null,
    task_id: "TASK-A",
    instruction_digest: "instruction-a",
    last_brain_directive_digest: "directive-a",
    last_work_result_digest: null,
    last_result_relay_id: null,
    dispatch_inflight: null,
    relay_inflight: null,
    brain_request_inflight: null,
    awaiting_work: false,
    task_timing: {
      task_id: "TASK-A",
      completed_at: null,
      relay_confirmed_at: null
    },
    ...overrides
  };
}

const intent = (revision = 2, url = "https://chatgpt.com/c/new") => ({
  url,
  revision,
  saved_at: "2026-09-20T01:00:00.000Z",
  mode: WORK_TARGET_MODES.OWNER
});

test("idle Owner target applies immediately without clearing task/dedupe state", () => {
  const state = lane();
  const before = {
    task_id: state.task_id,
    instruction_digest: state.instruction_digest,
    last_brain_directive_digest: state.last_brain_directive_digest
  };
  const result = acceptOwnerWorkTargetRevision(state, intent());

  assert.equal(result.status, "APPLIED");
  assert.equal(state.work_url, "https://chatgpt.com/c/new");
  assert.equal(state.applied_work_url_revision, 2);
  assert.equal(state.work_generation, 5);
  assert.equal(state.task_id, before.task_id);
  assert.equal(state.instruction_digest, before.instruction_digest);
  assert.equal(state.last_brain_directive_digest, before.last_brain_directive_digest);
});

for (const [name, active] of [
  ["awaiting_work", { awaiting_work: true }],
  ["dispatch_inflight", { dispatch_inflight: { dispatch_id: "abc" } }],
  ["relay_inflight", { relay_inflight: { relay_id: "def" } }],
  ["completed result not relayed", {
    task_timing: {
      task_id: "TASK-A",
      completed_at: "2026-09-20T01:01:00.000Z",
      relay_confirmed_at: null
    }
  }]
]) {
  test(name + " stages pending target and preserves active execution state", () => {
    const state = lane(active);
    const snapshot = JSON.parse(JSON.stringify(state));
    const result = acceptOwnerWorkTargetRevision(state, intent());

    assert.equal(result.status, "PENDING");
    assert.equal(state.work_url, snapshot.work_url);
    assert.equal(state.work_generation, snapshot.work_generation);
    assert.equal(state.task_id, snapshot.task_id);
    assert.deepEqual(state.dispatch_inflight, snapshot.dispatch_inflight);
    assert.deepEqual(state.relay_inflight, snapshot.relay_inflight);
    assert.equal(state.awaiting_work, snapshot.awaiting_work);
    assert.equal(state.pending_work_url, "https://chatgpt.com/c/new");
    assert.equal(state.pending_work_url_revision, 2);
  });
}

test("safe boundary applies pending target exactly once", () => {
  const state = lane({ awaiting_work: true });
  acceptOwnerWorkTargetRevision(state, intent());
  state.awaiting_work = false;

  const applied = applyPendingWorkTargetIfSafe(state);
  const generation = state.work_generation;
  const second = applyPendingWorkTargetIfSafe(state);

  assert.equal(applied.status, "APPLIED");
  assert.equal(state.work_url, "https://chatgpt.com/c/new");
  assert.equal(state.applied_work_url_revision, 2);
  assert.equal(second.status, "NONE");
  assert.equal(state.work_generation, generation);
});

test("pending target survives JSON restart and old active target remains authoritative", () => {
  const state = lane({ awaiting_work: true });
  acceptOwnerWorkTargetRevision(state, intent());
  const restarted = JSON.parse(JSON.stringify(state));

  assert.equal(applyPendingWorkTargetIfSafe(restarted).status, "PENDING");
  assert.equal(restarted.work_url, "https://chatgpt.com/c/old");
  assert.equal(restarted.pending_work_url, "https://chatgpt.com/c/new");

  restarted.awaiting_work = false;
  assert.equal(applyPendingWorkTargetIfSafe(restarted).status, "APPLIED");
  assert.equal(restarted.work_url, "https://chatgpt.com/c/new");
});

test("newer revision resolving to same canonical target acknowledges without generation churn", () => {
  const state = lane();
  const result = acceptOwnerWorkTargetRevision(state, intent(2, state.work_url));

  assert.equal(result.status, "ACKNOWLEDGED");
  assert.equal(state.applied_work_url_revision, 2);
  assert.equal(state.work_generation, 4);
});

test("latest save can cancel an older pending target by returning to current target", () => {
  const state = lane({ awaiting_work: true });
  acceptOwnerWorkTargetRevision(state, intent(2, "https://chatgpt.com/c/new"));
  const result = acceptOwnerWorkTargetRevision(state, intent(3, state.work_url));

  assert.equal(result.status, "ACKNOWLEDGED");
  assert.equal(state.pending_work_url_revision, 0);
  assert.equal(state.applied_work_url_revision, 3);
  assert.equal(state.work_generation, 4);
});

test("AUTO mode applies idle and defers creation generation until dispatch creates real Work", () => {
  const state = lane();
  const result = acceptOwnerWorkTargetRevision(state, {
    url: "",
    mode: WORK_TARGET_MODES.AUTO,
    revision: 2,
    saved_at: "2026-09-20T01:00:00.000Z"
  });

  assert.equal(result.status, "APPLIED");
  assert.equal(state.work_url, "");
  assert.equal(state.applied_work_mode, WORK_TARGET_MODES.AUTO);
  assert.equal(state.work_generation, 4);
});

test("AUTO mode becomes pending while active and does not abandon current Work", () => {
  const state = lane({ awaiting_work: true });
  const result = acceptOwnerWorkTargetRevision(state, {
    url: "",
    mode: WORK_TARGET_MODES.AUTO,
    revision: 2,
    saved_at: "2026-09-20T01:00:00.000Z"
  });

  assert.equal(result.status, "PENDING");
  assert.equal(state.work_url, "https://chatgpt.com/c/old");
  assert.equal(state.pending_work_mode, WORK_TARGET_MODES.AUTO);
  assert.equal(state.pending_work_url, "");
});

test("three lane objects stay isolated", () => {
  const lanes = {
    "lane-1": lane({ lane_id: "lane-1" }),
    "lane-2": lane({ lane_id: "lane-2", work_url: "https://chatgpt.com/c/lane2" }),
    "lane-3": lane({ lane_id: "lane-3", work_url: "https://chatgpt.com/c/lane3" })
  };
  const before2 = JSON.stringify(lanes["lane-2"]);
  const before3 = JSON.stringify(lanes["lane-3"]);

  acceptOwnerWorkTargetRevision(lanes["lane-1"], intent());

  assert.equal(JSON.stringify(lanes["lane-2"]), before2);
  assert.equal(JSON.stringify(lanes["lane-3"]), before3);
});

test("legacy deterministic relay id is also a safe confirmed-result boundary", () => {
  assert.equal(hasActiveWorkTransaction(lane({
    last_result_relay_id: "relay-confirmed",
    task_timing: {
      completed_at: "2026-09-20T01:00:00.000Z",
      relay_confirmed_at: null
    }
  })), false);
});

test("active predicate includes unresolved completed result but not fully relayed history", () => {
  assert.equal(hasActiveWorkTransaction(lane({ awaiting_work: true })), true);
  assert.equal(hasActiveWorkTransaction(lane({
    task_timing: {
      completed_at: "2026-09-20T01:00:00.000Z",
      relay_confirmed_at: null
    }
  })), true);
  assert.equal(hasActiveWorkTransaction(lane({
    task_timing: {
      completed_at: "2026-09-20T01:00:00.000Z",
      relay_confirmed_at: "2026-09-20T01:01:00.000Z"
    }
  })), false);
});
