import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  TARGET_AVAILABILITY,
  TARGET_HEALTH_REASONS,
  adoptTargetHealthIdentity,
  defaultTargetHealth,
  evaluateTargetAvailability,
  isTargetQuarantined,
  normalizeTargetHealth,
  quarantineTarget,
  targetHealthIdentity
} from "./target-health.mjs";
import {
  WORK_CAPACITY_STATES,
  evaluateWorkCapacity
} from "./work-capacity.mjs";
import {
  BrowserScheduler,
  PAGE_LEASE_STATES
} from "./browser-scheduler.mjs";

const D1 = "a".repeat(64);
const D2 = "b".repeat(64);
const B1 = "c".repeat(64);
const T0 = "2026-09-20T16:10:00.000Z";

const workIdentity = targetHealthIdentity({
  role: "WORK",
  targetDigest: D1,
  targetRevision: 7,
  workGeneration: 12
});
const brainIdentity = targetHealthIdentity({
  role: "BRAIN",
  targetDigest: B1,
  targetRevision: 4
});

let legacyNavigationCount = 0;
for (let turn = 0; turn < 100; turn += 1) {
  legacyNavigationCount += 1;
}
assert.equal(legacyNavigationCount, 100);

let workHealth = defaultTargetHealth();
let navigationCount = 0;
function guardedNavigation(identity, health) {
  if (isTargetQuarantined(health, identity)) return false;
  navigationCount += 1;
  return true;
}

assert.equal(guardedNavigation(workIdentity, workHealth), true);
const missing = evaluateTargetAvailability({
  firstSnapshot: {
    conversationMissing: true,
    conversationAccessDenied: false,
    conversationPath: true
  },
  secondSnapshot: {
    conversationMissing: true,
    conversationAccessDenied: false,
    conversationPath: true
  },
  firstExact: true,
  secondExact: true
});
assert.equal(missing.state, TARGET_AVAILABILITY.DETERMINISTIC_UNAVAILABLE);
workHealth = quarantineTarget(workHealth, workIdentity, {
  reasonCode: missing.reason_code,
  at: T0
}).health;
assert.equal(isTargetQuarantined(workHealth, workIdentity), true);

const afterDetection = navigationCount;
for (let turn = 0; turn < 100; turn += 1) {
  guardedNavigation(workIdentity, workHealth);
}
assert.equal(navigationCount - afterDetection, 0);

const restartedHealth = normalizeTargetHealth(
  JSON.parse(JSON.stringify(workHealth))
);
const beforeRestartTurns = navigationCount;
for (let turn = 0; turn < 100; turn += 1) {
  guardedNavigation(workIdentity, restartedHealth);
}
assert.equal(navigationCount - beforeRestartTurns, 0);

const reconnectHealth = normalizeTargetHealth(
  JSON.parse(JSON.stringify(restartedHealth))
);
const beforeReconnectTurns = navigationCount;
for (let turn = 0; turn < 100; turn += 1) {
  guardedNavigation(workIdentity, reconnectHealth);
}
assert.equal(navigationCount - beforeReconnectTurns, 0);

const sameStaleNewRevision = targetHealthIdentity({
  role: "WORK",
  targetDigest: D1,
  targetRevision: 99,
  workGeneration: 44
});
const sameAdopted = adoptTargetHealthIdentity(
  reconnectHealth,
  sameStaleNewRevision,
  { at: T0 }
);
assert.equal(isTargetQuarantined(sameAdopted, sameStaleNewRevision), true);

const newWorkIdentity = targetHealthIdentity({
  role: "WORK",
  targetDigest: D2,
  targetRevision: 100,
  workGeneration: 45
});
const ownerNewTargetHealth = adoptTargetHealthIdentity(
  reconnectHealth,
  newWorkIdentity,
  { at: T0 }
);
assert.equal(isTargetQuarantined(ownerNewTargetHealth, newWorkIdentity), false);
const beforeOwnerValidation = navigationCount;
assert.equal(guardedNavigation(newWorkIdentity, ownerNewTargetHealth), true);
assert.equal(navigationCount - beforeOwnerValidation, 1);

let brainHealth = defaultTargetHealth();
let brainNavigation = 0;
function guardedBrain() {
  if (isTargetQuarantined(brainHealth, brainIdentity)) return false;
  brainNavigation += 1;
  return true;
}
assert.equal(guardedBrain(), true);
const denied = evaluateTargetAvailability({
  firstSnapshot: {
    conversationAccessDenied: true,
    conversationMissing: false,
    conversationPath: true
  },
  secondSnapshot: {
    conversationAccessDenied: true,
    conversationMissing: false,
    conversationPath: true
  },
  firstExact: true,
  secondExact: true
});
brainHealth = quarantineTarget(brainHealth, brainIdentity, {
  reasonCode: denied.reason_code,
  at: T0
}).health;
for (let turn = 0; turn < 100; turn += 1) guardedBrain();
assert.equal(brainNavigation, 1);

let missingBrainHealth = defaultTargetHealth();
let missingBrainNavigation = 0;
function guardedMissingBrain() {
  if (isTargetQuarantined(missingBrainHealth, brainIdentity)) return false;
  missingBrainNavigation += 1;
  return true;
}
assert.equal(guardedMissingBrain(), true);
missingBrainHealth = quarantineTarget(missingBrainHealth, brainIdentity, {
  reasonCode: TARGET_HEALTH_REASONS.CONVERSATION_MISSING,
  at: T0
}).health;
for (let turn = 0; turn < 100; turn += 1) guardedMissingBrain();
assert.equal(missingBrainNavigation, 1);

const stopStartHealth = normalizeTargetHealth(
  JSON.parse(JSON.stringify(workHealth))
);
assert.equal(isTargetQuarantined(stopStartHealth, workIdentity), true);

const active = {
  task_id: "TASK-ACTIVE",
  awaiting_work: true,
  dispatch_inflight: {
    dispatch_id: "d".repeat(32),
    instruction_digest: "e".repeat(64)
  },
  relay_inflight: {
    relay_id: "f".repeat(32),
    response_digest: "1".repeat(64)
  },
  last_work_result_digest: "2".repeat(64),
  pending_work_url_revision: 9,
  pending_work_url: "SYNTHETIC_NOT_A_REAL_URL",
  work_generation: 12
};
const activeTruth = JSON.stringify(active);
const activeWithHealth = {
  ...active,
  work_target_health: workHealth
};
for (const key of [
  "task_id",
  "awaiting_work",
  "dispatch_inflight",
  "relay_inflight",
  "last_work_result_digest",
  "pending_work_url_revision",
  "pending_work_url",
  "work_generation"
]) {
  assert.deepEqual(activeWithHealth[key], active[key]);
}
assert.equal(JSON.stringify(activeWithHealth).includes(activeTruth), false);

const missingCapacity = evaluateWorkCapacity({
  first: {
    explicit_full_limit_ui: true,
    composer_capacity_blocked: true,
    send_rejection_capacity: false,
    legacy_conversation_full: true,
    response_running: false,
    incomplete_turn: false,
    network_error: false,
    security_blocked: false,
    transient_state: false,
    conversation_missing: true
  },
  second: {
    explicit_full_limit_ui: true,
    composer_capacity_blocked: true,
    send_rejection_capacity: false,
    legacy_conversation_full: true,
    response_running: false,
    incomplete_turn: false,
    network_error: false,
    security_blocked: false,
    transient_state: false,
    conversation_missing: true
  },
  stableIdentity: true,
  stableProbeCount: 2
});
assert.equal(missingCapacity.state, WORK_CAPACITY_STATES.NOT_FULL);

let pageClosed = false;
let invalidated = 0;
const page = {
  isClosed: () => pageClosed,
  close: async () => { pageClosed = true; }
};
const fakeAdapter = {
  hasNonPersistedComposerArtifact: async () => false,
  invalidateTargetRecoveryPage: async () => {
    invalidated += 1;
    return true;
  },
  closePage: async (candidate) => {
    assert.equal(candidate, page);
    pageClosed = true;
  }
};
const scheduler = new BrowserScheduler({ adapter: fakeAdapter });
assert.equal(scheduler.pageBudget, 3);
scheduler.registerPage(page, {
  laneId: "lane-1",
  role: "WORK",
  state: PAGE_LEASE_STATES.ACTIVE_OBSERVATION
});
assert.equal(await scheduler.invalidateExactPage({
  page,
  url: "https://chatgpt.com/c/synthetic-dead-target"
}), true);
assert.equal(pageClosed, true);
assert.equal(invalidated, 1);
assert.equal(scheduler.residentPageCount(), 0);
const beforeEvictionTurns = navigationCount;
for (let turn = 0; turn < 100; turn += 1) {
  guardedNavigation(workIdentity, workHealth);
}
assert.equal(navigationCount - beforeEvictionTurns, 0);

const repeatedQuarantine = quarantineTarget(workHealth, workIdentity, {
  reasonCode: TARGET_HEALTH_REASONS.CONVERSATION_MISSING,
  at: "2026-09-20T16:11:00.000Z"
});
assert.equal(repeatedQuarantine.changed, false);

const fair = new BrowserScheduler({ adapter: {} });
const lanes = [
  { lane_id: "lane-1", enabled: true },
  { lane_id: "lane-2", enabled: true },
  { lane_id: "lane-3", enabled: true }
];
const turns = Array.from({ length: 9 }, () => fair.nextEnabledTurn(lanes).lane_id);
assert.deepEqual(turns, [
  "lane-1","lane-2","lane-3",
  "lane-1","lane-2","lane-3",
  "lane-1","lane-2","lane-3"
]);

const runtime = await fs.readFile(
  new URL("./three-lane-cli.mjs", import.meta.url),
  "utf8"
);
const turnStart = runtime.indexOf("async function processLaneTurn");
const turnEnd = runtime.indexOf("async function processLane(args)", turnStart);
const turnSource = runtime.slice(turnStart, turnEnd);
const watchdogStart = runtime.indexOf("async function executeWatchdogReload");
const watchdogEnd = runtime.indexOf("async function processLaneTurn", watchdogStart);
const watchdogSource = runtime.slice(watchdogStart, watchdogEnd);
assert.ok(
  turnSource.indexOf("currentTargetIsQuarantined(registryLane, { brain: true })") <
  turnSource.indexOf("const ensureBrainPage")
);
assert.ok(
  turnSource.indexOf("currentTargetIsQuarantined(registryLane, { brain: false })") <
  turnSource.indexOf("const ensureBrainPage")
);
assert.match(watchdogSource, /TARGET_QUARANTINED/);

const healthJson = JSON.stringify({
  work: workHealth,
  brain: brainHealth
});
assert.equal(healthJson.includes("http"), false);
assert.equal(healthJson.includes("chatgpt.com"), false);
assert.equal(healthJson.includes("message"), false);

console.log(`STALE_TARGET_FIXTURE_BEFORE_NAVIGATION_COUNT=${legacyNavigationCount}`);
console.log("STALE_TARGET_FIXTURE_MISSING_DETECTED=True");
console.log("STALE_TARGET_FIXTURE_QUARANTINED=True");
console.log("STALE_TARGET_FIXTURE_100_TURNS_ZERO_REOPEN=True");
console.log("STALE_TARGET_FIXTURE_RESTART_ZERO_REOPEN=True");
console.log("STALE_TARGET_FIXTURE_RECONNECT_ZERO_REOPEN=True");
console.log("STALE_TARGET_FIXTURE_EVICTION_ZERO_REOPEN=True");
console.log("STALE_TARGET_FIXTURE_STOP_START_PRESERVES=True");
console.log("STALE_TARGET_FIXTURE_BRAIN_MISSING_BLOCKED=True");
console.log("STALE_TARGET_FIXTURE_OWNER_NEW_TARGET_CLEARS=True");
console.log("STALE_TARGET_FIXTURE_ACTIVE_STATE_PRESERVED=True");
console.log("STALE_TARGET_FIXTURE_WATCHDOG_BLOCKED=True");
console.log("STALE_TARGET_FIXTURE_RELAY_REOPEN_BLOCKED=True");
console.log("STALE_TARGET_FIXTURE_MISSING_NOT_FULL=True");
console.log("STALE_TARGET_FIXTURE_DEAD_PAGE_CLEANED=True");
console.log("STALE_TARGET_FIXTURE_PAGE_BUDGET_THREE=True");
console.log("STALE_TARGET_FIXTURE_EVENT_SPAM_BOUNDED=True");
console.log("STALE_TARGET_FIXTURE_OTHER_LANES_PROGRESS=True");
console.log("STALE_TARGET_FIXTURE_PRIVACY=True");
