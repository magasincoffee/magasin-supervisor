import test from "node:test";
import assert from "node:assert/strict";

import {
  WORK_WATCHDOG_DECISIONS,
  WORK_WATCHDOG_PHASES,
  beginWatchdogReloadIntent,
  defaultWorkWatchdog,
  evaluateWorkWatchdog,
  markWatchdogReloaded,
  normalizeWorkWatchdog
} from "../src/runtime/work-watchdog.mjs";

const BASE = Date.parse("2026-09-20T00:00:00.000Z");
const iso = (minutes, seconds = 0) =>
  new Date(BASE + (minutes * 60 + seconds) * 1000).toISOString();

function timing({
  started = 0,
  activity = 0,
  completed = null
} = {}) {
  return {
    task_id: "TASK-WATCHDOG",
    assigned_at: iso(-1),
    started_at: started === null ? null : iso(started),
    last_activity_at: activity === null ? null : iso(activity),
    completed_at: completed === null ? null : iso(completed)
  };
}

function evaluate({
  minutes,
  seconds = 0,
  state = defaultWorkWatchdog(),
  taskTiming = timing(),
  responseRunning = false,
  activityChanged = false,
  ownerStopped = false,
  securityBlocked = false,
  taskId = "TASK-WATCHDOG",
  generation = 4,
  revision = 8
} = {}) {
  return evaluateWorkWatchdog({
    now: iso(minutes, seconds),
    awaitingWork: true,
    dispatchConfirmed: true,
    taskId,
    workGeneration: generation,
    workUrlRevision: revision,
    timing: taskTiming,
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

test("<25m remains WORKING with no watchdog action", () => {
  const result = evaluate({ minutes: 24 });
  assert.equal(result.decision, WORK_WATCHDOG_DECISIONS.WORKING);
  assert.equal(result.emit_long_running, false);
  assert.equal(result.state.reload_count, 0);
});

test("crossing 25m emits long-running exactly once and never reloads in 25-30m band", () => {
  const first = evaluate({ minutes: 25 });
  assert.equal(first.decision, WORK_WATCHDOG_DECISIONS.WORKING_LONG);
  assert.equal(first.emit_long_running, true);
  assert.ok(first.state.long_event_emitted_at);

  const repeated = evaluate({ minutes: 27, state: first.state });
  assert.equal(repeated.decision, WORK_WATCHDOG_DECISIONS.WORKING_LONG);
  assert.equal(repeated.emit_long_running, false);
  assert.equal(repeated.state.reload_count, 0);
});

test(">30m responseRunning=true stays WORKING_LONG without reload", () => {
  const result = evaluate({
    minutes: 35,
    responseRunning: true,
    taskTiming: timing({ activity: 0 })
  });
  assert.equal(result.decision, WORK_WATCHDOG_DECISIONS.WORKING_LONG);
  assert.equal(result.state.reload_count, 0);
});

test(">30m recent activity under 5m stays WORKING_LONG", () => {
  const result = evaluate({
    minutes: 32,
    taskTiming: timing({ activity: 29 })
  });
  assert.equal(result.decision, WORK_WATCHDOG_DECISIONS.WORKING_LONG);
});

test(">30m changed safe progress stays WORKING_LONG", () => {
  const result = evaluate({
    minutes: 35,
    activityChanged: true,
    taskTiming: timing({ activity: 35 })
  });
  assert.equal(result.decision, WORK_WATCHDOG_DECISIONS.WORKING_LONG);
});

test(">=30m + >=5m inactivity enters STALL_CHECK first, not reload", () => {
  const result = evaluate({
    minutes: 35,
    taskTiming: timing({ activity: 29 })
  });
  assert.equal(result.decision, WORK_WATCHDOG_DECISIONS.STALL_CHECK);
  assert.equal(result.state.phase, WORK_WATCHDOG_PHASES.STALL_CHECK);
  assert.equal(result.state.reload_count, 0);
  assert.equal(result.emit_stall_check, true);
});

test("second eligible turn becomes RELOAD_ELIGIBLE and intent consumes epoch budget before mutation", () => {
  const checked = evaluate({
    minutes: 35,
    taskTiming: timing({ activity: 29 })
  });
  const eligible = evaluate({
    minutes: 35,
    seconds: 5,
    taskTiming: timing({ activity: 29 }),
    state: checked.state
  });
  assert.equal(eligible.decision, WORK_WATCHDOG_DECISIONS.RELOAD_ELIGIBLE);

  const intent = beginWatchdogReloadIntent(eligible.state, {
    now: iso(35, 5)
  });
  assert.equal(intent.reload_count, 1);
  assert.equal(intent.phase, WORK_WATCHDOG_PHASES.RECOVERY_INTENT);
  assert.ok(intent.reload_intent_at);
});

test("same no-progress recovery epoch cannot reload a second time", () => {
  const checked = evaluate({
    minutes: 35,
    taskTiming: timing({ activity: 29 })
  });
  const intent = beginWatchdogReloadIntent(checked.state, { now: iso(35, 1) });
  const reloaded = markWatchdogReloaded(intent, { now: iso(35, 2) });

  const post = evaluate({
    minutes: 36,
    state: reloaded,
    taskTiming: timing({ activity: 29 })
  });
  assert.equal(post.decision, WORK_WATCHDOG_DECISIONS.POST_RELOAD_OBSERVE);
  assert.equal(post.state.reload_count, 1);

  const stalled = evaluate({
    minutes: 41,
    state: post.state,
    taskTiming: timing({ activity: 29 })
  });
  assert.equal(stalled.decision, WORK_WATCHDOG_DECISIONS.POSSIBLY_STALLED);
  assert.equal(stalled.state.reload_count, 1);
});

test("restart with persisted reload intent does not replay mutation", () => {
  const checked = evaluate({
    minutes: 35,
    taskTiming: timing({ activity: 29 })
  });
  const intent = beginWatchdogReloadIntent(checked.state, { now: iso(35) });
  const restarted = normalizeWorkWatchdog(JSON.parse(JSON.stringify(intent)));

  const uncertain = evaluate({
    minutes: 36,
    state: restarted,
    taskTiming: timing({ activity: 29 })
  });
  assert.equal(uncertain.decision, WORK_WATCHDOG_DECISIONS.RECOVERY_UNCERTAIN);
  assert.equal(uncertain.state.reload_count, 1);

  const later = evaluate({
    minutes: 41,
    state: uncertain.state,
    taskTiming: timing({ activity: 29 })
  });
  assert.equal(later.decision, WORK_WATCHDOG_DECISIONS.POSSIBLY_STALLED);
  assert.equal(later.state.reload_count, 1);
});

test("fresh progress after reload returns WORKING_LONG and only re-arms after >=10m cooldown", () => {
  const checked = evaluate({
    minutes: 35,
    taskTiming: timing({ activity: 29 })
  });
  const intent = beginWatchdogReloadIntent(checked.state, { now: iso(35) });
  const reloaded = markWatchdogReloaded(intent, { now: iso(35, 1) });

  const fresh = evaluate({
    minutes: 36,
    state: reloaded,
    taskTiming: timing({ activity: 36 }),
    activityChanged: true
  });
  assert.equal(fresh.decision, WORK_WATCHDOG_DECISIONS.WORKING_LONG);
  assert.equal(fresh.state.reload_count, 1);
  assert.ok(fresh.state.fresh_progress_at);
  assert.equal(fresh.emit_rearmed, false);

  const tooSoon = evaluate({
    minutes: 44,
    state: fresh.state,
    taskTiming: timing({ activity: 36 }),
    responseRunning: true
  });
  assert.equal(tooSoon.state.reload_count, 1);
  assert.equal(tooSoon.emit_rearmed, false);

  const rearmed = evaluate({
    minutes: 46,
    state: tooSoon.state,
    taskTiming: timing({ activity: 46 }),
    activityChanged: true
  });
  assert.equal(rearmed.decision, WORK_WATCHDOG_DECISIONS.WORKING_LONG);
  assert.equal(rearmed.state.reload_count, 0);
  assert.equal(rearmed.emit_rearmed, true);
  assert.ok(rearmed.state.rearmed_at);
});

test("reload cooldown is enforced even after a rearmed epoch", () => {
  let state = defaultWorkWatchdog();
  state.task_id = "TASK-WATCHDOG";
  state.work_generation = 4;
  state.work_url_revision = 8;
  state.phase = WORK_WATCHDOG_PHASES.STALL_CHECK;
  state.recovery_epoch = 2;
  state.last_reload_at = iso(30);
  state.reload_count = 0;

  const result = evaluate({
    minutes: 35,
    state,
    taskTiming: timing({ activity: 29 })
  });
  assert.equal(result.decision, WORK_WATCHDOG_DECISIONS.STALL_CHECK_COOLDOWN);
  assert.equal(result.state.reload_count, 0);
});

test("exact task/work generation/revision mismatch cancels recovery fail-closed", () => {
  const first = evaluate({
    minutes: 35,
    taskTiming: timing({ activity: 29 })
  });
  const mismatch = evaluate({
    minutes: 36,
    state: first.state,
    taskTiming: timing({ activity: 29 }),
    generation: 5
  });
  assert.equal(mismatch.decision, WORK_WATCHDOG_DECISIONS.IDENTITY_MISMATCH);
  assert.equal(mismatch.state.reload_count, 0);
});

test("Owner STOP blocks watchdog reload eligibility", () => {
  const result = evaluate({
    minutes: 35,
    ownerStopped: true,
    taskTiming: timing({ activity: 29 })
  });
  assert.equal(result.decision, WORK_WATCHDOG_DECISIONS.BLOCKED_OWNER_STOP);
  assert.equal(result.state.reload_count, 0);
});

test("auth/MFA/CAPTCHA/security ambiguity blocks watchdog recovery", () => {
  const result = evaluate({
    minutes: 35,
    securityBlocked: true,
    taskTiming: timing({ activity: 29 })
  });
  assert.equal(result.decision, WORK_WATCHDOG_DECISIONS.BLOCKED_SECURITY);
  assert.equal(result.state.reload_count, 0);
});

test("legacy missing started_at/activity timestamps remain unknown and do not invent stall history", () => {
  const noStart = evaluate({
    minutes: 90,
    taskTiming: timing({ started: null, activity: null })
  });
  assert.equal(noStart.decision, WORK_WATCHDOG_DECISIONS.OBSERVE);
  assert.equal(noStart.elapsed_ms, null);

  const unknownActivity = evaluate({
    minutes: 90,
    taskTiming: timing({ started: 0, activity: null })
  });
  assert.equal(unknownActivity.decision, WORK_WATCHDOG_DECISIONS.WORKING_LONG);
  assert.equal(unknownActivity.inactivity_ms, null);
  assert.equal(unknownActivity.state.reload_count, 0);
});

test("completed task is outside execution watchdog domain", () => {
  const result = evaluate({
    minutes: 50,
    taskTiming: timing({ activity: 40, completed: 45 })
  });
  assert.equal(result.decision, WORK_WATCHDOG_DECISIONS.OBSERVE);
  assert.equal(result.state.phase, WORK_WATCHDOG_PHASES.IDLE);
});
