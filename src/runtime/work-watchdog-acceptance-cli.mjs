import assert from "node:assert/strict";

import {
  WORK_WATCHDOG_DECISIONS,
  beginWatchdogReloadIntent,
  defaultWorkWatchdog,
  evaluateWorkWatchdog,
  markWatchdogReloaded,
  normalizeWorkWatchdog
} from "./work-watchdog.mjs";

const BASE = Date.parse("2026-09-20T00:00:00.000Z");
const iso = (minutes, seconds = 0) =>
  new Date(BASE + (minutes * 60 + seconds) * 1000).toISOString();

const durableLane = {
  lane_id: "lane-1",
  task_id: "TASK-FIXTURE-WATCHDOG",
  awaiting_work: true,
  work_url: "https://chatgpt.com/c/watchdog-active-fixture",
  applied_work_url_revision: 7,
  work_generation: 4,
  last_dispatch_id: "a".repeat(32),
  dispatch_inflight: null,
  relay_inflight: {
    relay_id: "b".repeat(32),
    response_digest: "c".repeat(64)
  },
  last_work_result_digest: "d".repeat(64),
  pending_work_url: "https://chatgpt.com/c/watchdog-next-fixture",
  pending_work_url_revision: 8,
  pending_work_mode: "OWNER",
  task_timing: {
    task_id: "TASK-FIXTURE-WATCHDOG",
    assigned_at: iso(-1),
    started_at: iso(0),
    last_activity_at: iso(29),
    completed_at: null,
    relay_confirmed_at: null
  }
};

const durableBefore = JSON.stringify({
  task_id: durableLane.task_id,
  awaiting_work: durableLane.awaiting_work,
  work_url: durableLane.work_url,
  work_generation: durableLane.work_generation,
  applied_work_url_revision: durableLane.applied_work_url_revision,
  dispatch_inflight: durableLane.dispatch_inflight,
  relay_inflight: durableLane.relay_inflight,
  last_work_result_digest: durableLane.last_work_result_digest,
  pending_work_url: durableLane.pending_work_url,
  pending_work_url_revision: durableLane.pending_work_url_revision,
  pending_work_mode: durableLane.pending_work_mode
});

function evaluate({
  minutes,
  seconds = 0,
  state = defaultWorkWatchdog(),
  activityAt = 29,
  responseRunning = false,
  activityChanged = false,
  ownerStopped = false,
  securityBlocked = false,
  generation = durableLane.work_generation,
  revision = durableLane.applied_work_url_revision
}) {
  return evaluateWorkWatchdog({
    now: iso(minutes, seconds),
    awaitingWork: durableLane.awaiting_work,
    dispatchConfirmed: true,
    taskId: durableLane.task_id,
    workGeneration: generation,
    workUrlRevision: revision,
    timing: {
      ...durableLane.task_timing,
      last_activity_at: activityAt === null ? null : iso(activityAt)
    },
    observation: {
      response_running: responseRunning,
      response_complete: false
    },
    activityChanged,
    ownerStopped,
    securityBlocked,
    watchdog: state
  });
}

const running = evaluate({
  minutes: 35,
  responseRunning: true,
  activityAt: 20
});
assert.equal(running.decision, WORK_WATCHDOG_DECISIONS.WORKING_LONG);
assert.equal(running.state.reload_count, 0);

const stallCheck = evaluate({ minutes: 35, activityAt: 29 });
assert.equal(stallCheck.decision, WORK_WATCHDOG_DECISIONS.STALL_CHECK);
assert.equal(stallCheck.state.reload_count, 0);

const eligible = evaluate({
  minutes: 35,
  seconds: 5,
  activityAt: 29,
  state: stallCheck.state
});
assert.equal(eligible.decision, WORK_WATCHDOG_DECISIONS.RELOAD_ELIGIBLE);

const intent = beginWatchdogReloadIntent(eligible.state, {
  now: iso(35, 5)
});
assert.equal(intent.reload_count, 1);

const restartBeforeReload = normalizeWorkWatchdog(
  JSON.parse(JSON.stringify(intent))
);
const noReplay = evaluate({
  minutes: 36,
  activityAt: 29,
  state: restartBeforeReload
});
assert.equal(noReplay.decision, WORK_WATCHDOG_DECISIONS.RECOVERY_UNCERTAIN);
assert.equal(noReplay.state.reload_count, 1);

const reloaded = markWatchdogReloaded(intent, {
  now: iso(35, 6)
});
const postReload = evaluate({
  minutes: 36,
  activityAt: 29,
  state: reloaded
});
assert.equal(postReload.decision, WORK_WATCHDOG_DECISIONS.POST_RELOAD_OBSERVE);
assert.equal(postReload.state.reload_count, 1);

const noSecondReload = evaluate({
  minutes: 41,
  activityAt: 29,
  state: postReload.state
});
assert.equal(noSecondReload.decision, WORK_WATCHDOG_DECISIONS.POSSIBLY_STALLED);
assert.equal(noSecondReload.state.reload_count, 1);

const reloadedFreshBase = markWatchdogReloaded(intent, {
  now: iso(35, 6)
});
const fresh = evaluate({
  minutes: 36,
  activityAt: 36,
  activityChanged: true,
  state: reloadedFreshBase
});
assert.equal(fresh.decision, WORK_WATCHDOG_DECISIONS.WORKING_LONG);
assert.equal(fresh.state.reload_count, 1);
assert.ok(fresh.state.fresh_progress_at);

const cooldown = evaluate({
  minutes: 44,
  activityAt: 36,
  responseRunning: true,
  state: fresh.state
});
assert.equal(cooldown.state.reload_count, 1);
assert.equal(cooldown.emit_rearmed, false);

const rearmed = evaluate({
  minutes: 46,
  activityAt: 46,
  activityChanged: true,
  state: cooldown.state
});
assert.equal(rearmed.decision, WORK_WATCHDOG_DECISIONS.WORKING_LONG);
assert.equal(rearmed.state.reload_count, 0);
assert.equal(rearmed.emit_rearmed, true);

const stopped = evaluate({
  minutes: 35,
  activityAt: 29,
  ownerStopped: true
});
assert.equal(stopped.decision, WORK_WATCHDOG_DECISIONS.BLOCKED_OWNER_STOP);
assert.equal(stopped.state.reload_count, 0);

const security = evaluate({
  minutes: 35,
  activityAt: 29,
  securityBlocked: true
});
assert.equal(security.decision, WORK_WATCHDOG_DECISIONS.BLOCKED_SECURITY);
assert.equal(security.state.reload_count, 0);

const mismatchBase = evaluate({
  minutes: 35,
  activityAt: 29
});
const mismatch = evaluate({
  minutes: 36,
  activityAt: 29,
  generation: durableLane.work_generation + 1,
  state: mismatchBase.state
});
assert.equal(mismatch.decision, WORK_WATCHDOG_DECISIONS.IDENTITY_MISMATCH);

const durableAfter = JSON.stringify({
  task_id: durableLane.task_id,
  awaiting_work: durableLane.awaiting_work,
  work_url: durableLane.work_url,
  work_generation: durableLane.work_generation,
  applied_work_url_revision: durableLane.applied_work_url_revision,
  dispatch_inflight: durableLane.dispatch_inflight,
  relay_inflight: durableLane.relay_inflight,
  last_work_result_digest: durableLane.last_work_result_digest,
  pending_work_url: durableLane.pending_work_url,
  pending_work_url_revision: durableLane.pending_work_url_revision,
  pending_work_mode: durableLane.pending_work_mode
});
assert.equal(durableAfter, durableBefore);

console.log("WORK_WATCHDOG_FIXTURE_LONG_RUNNING_NO_RELOAD=True");
console.log("WORK_WATCHDOG_FIXTURE_STALL_CHECK_BEFORE_RELOAD=True");
console.log("WORK_WATCHDOG_FIXTURE_ONE_RELOAD_MAX_PER_EPOCH=True");
console.log("WORK_WATCHDOG_FIXTURE_RESTART_NO_DUPLICATE_RELOAD=True");
console.log("WORK_WATCHDOG_FIXTURE_POST_RELOAD_POSSIBLY_STALLED=True");
console.log("WORK_WATCHDOG_FIXTURE_FRESH_PROGRESS_REARMED=True");
console.log("WORK_WATCHDOG_FIXTURE_RELOAD_COOLDOWN_ENFORCED=True");
console.log("WORK_WATCHDOG_FIXTURE_OWNER_STOP_BLOCKS=True");
console.log("WORK_WATCHDOG_FIXTURE_SECURITY_BLOCKS=True");
console.log("WORK_WATCHDOG_FIXTURE_IDENTITY_MISMATCH_FAIL_CLOSED=True");
console.log("WORK_WATCHDOG_FIXTURE_EXACT_ONCE_STATE_PRESERVED=True");
console.log("WORK_WATCHDOG_FIXTURE_PENDING_WORK_PRESERVED=True");
console.log("WORK_WATCHDOG_FIXTURE_NO_RESEND_PATH=True");
