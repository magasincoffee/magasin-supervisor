import assert from "node:assert/strict";
import {
  WORK_TARGET_MODES,
  acceptOwnerWorkTargetRevision,
  applyPendingWorkTargetIfSafe
} from "./work-target-state.mjs";

const oldUrl = "https://chatgpt.com/c/fixture-old";
const newUrl = "https://chatgpt.com/c/fixture-new";
const lane = {
  lane_id: "lane-1",
  work_url: oldUrl,
  work_generation: 5,
  applied_work_mode: WORK_TARGET_MODES.OWNER,
  applied_work_url_revision: 1,
  applied_work_saved_at: "2026-09-20T00:00:00.000Z",
  pending_work_url: "",
  pending_work_url_revision: 0,
  pending_work_saved_at: null,
  pending_work_mode: null,
  task_id: "FIXTURE-TASK",
  instruction_digest: "instruction-digest",
  last_brain_directive_digest: "directive-digest",
  last_work_result_digest: null,
  last_result_relay_id: null,
  awaiting_work: true,
  dispatch_inflight: null,
  relay_inflight: null,
  task_timing: {
    task_id: "FIXTURE-TASK",
    started_at: "2026-09-20T00:01:00.000Z",
    completed_at: null,
    relay_confirmed_at: null
  }
};

const activeSnapshot = {
  task_id: lane.task_id,
  instruction_digest: lane.instruction_digest,
  last_brain_directive_digest: lane.last_brain_directive_digest,
  awaiting_work: lane.awaiting_work,
  dispatch_inflight: lane.dispatch_inflight,
  relay_inflight: lane.relay_inflight,
  work_url: lane.work_url,
  work_generation: lane.work_generation
};

const staged = acceptOwnerWorkTargetRevision(lane, {
  url: newUrl,
  mode: WORK_TARGET_MODES.OWNER,
  revision: 2,
  saved_at: "2026-09-20T00:02:00.000Z"
});
assert.equal(staged.status, "PENDING");
for (const [key, value] of Object.entries(activeSnapshot)) {
  assert.deepEqual(lane[key], value);
}

const restarted = JSON.parse(JSON.stringify(lane));
const stillPending = applyPendingWorkTargetIfSafe(restarted);
assert.equal(stillPending.status, "PENDING");
assert.equal(restarted.work_url, oldUrl);
assert.equal(restarted.pending_work_url, newUrl);

restarted.awaiting_work = false;
restarted.task_timing.completed_at = "2026-09-20T00:03:00.000Z";
restarted.task_timing.relay_confirmed_at = "2026-09-20T00:04:00.000Z";
const applied = applyPendingWorkTargetIfSafe(restarted);
assert.equal(applied.status, "APPLIED");
assert.equal(restarted.work_url, newUrl);
assert.equal(restarted.applied_work_url_revision, 2);
assert.equal(restarted.pending_work_url_revision, 0);
assert.equal(restarted.task_id, activeSnapshot.task_id);
assert.equal(
  restarted.last_brain_directive_digest,
  activeSnapshot.last_brain_directive_digest
);

const generationAfterApply = restarted.work_generation;
const secondApply = applyPendingWorkTargetIfSafe(restarted);
assert.equal(secondApply.status, "NONE");
assert.equal(restarted.work_generation, generationAfterApply);

const same = acceptOwnerWorkTargetRevision(restarted, {
  url: newUrl,
  mode: WORK_TARGET_MODES.OWNER,
  revision: 3,
  saved_at: "2026-09-20T00:05:00.000Z"
});
assert.equal(same.status, "ACKNOWLEDGED");
assert.equal(restarted.work_generation, generationAfterApply);

console.log("WORK_TARGET_FIXTURE_ACTIVE_PENDING=True");
console.log("WORK_TARGET_FIXTURE_RESTART_PENDING=True");
console.log("WORK_TARGET_FIXTURE_SAFE_BOUNDARY_APPLY_ONCE=True");
console.log("WORK_TARGET_FIXTURE_TASK_LATCH_PRESERVED=True");
console.log("WORK_TARGET_FIXTURE_SAME_TARGET_NO_GENERATION_CHURN=True");
console.log("WORK_TARGET_FIXTURE_BRAIN_DIRECTIVE_PRESERVED=True");
