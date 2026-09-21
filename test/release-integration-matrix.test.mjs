import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BrowserScheduler } from "../src/runtime/browser-scheduler.mjs";
import {
  defaultWorkWatchdog,
  evaluateWorkWatchdog,
  beginWatchdogReloadIntent,
  markWatchdogReloaded,
  WORK_WATCHDOG_DECISIONS
} from "../src/runtime/work-watchdog.mjs";
import {
  acceptOwnerWorkTargetRevision,
  applyPendingWorkTargetIfSafe
} from "../src/runtime/work-target-state.mjs";
import {
  defaultTargetHealth,
  targetHealthIdentity,
  quarantineTarget,
  isTargetQuarantined,
  TARGET_HEALTH_REASONS
} from "../src/runtime/target-health.mjs";
import { evaluateBrainVerdictTransition } from "../src/runtime/brain-planning.mjs";
import { validateReleaseEvents } from "../../../.github/scripts/supervisor-release-event-validator.mjs";

const iso = (minutes) => new Date(Date.parse("2026-09-21T00:00:00.000Z") + minutes * 60_000).toISOString();

class FakePage {
  constructor(id) { this.id = id; this.closed = false; }
  isClosed() { return this.closed; }
  async close() { this.closed = true; }
}
class FakeAdapter {
  constructor() { this.pages = []; }
  getChatGptPages() { return this.pages.filter((p) => !p.closed); }
  async hasNonPersistedComposerArtifact() { return false; }
  async closePage(page) { await page.close(); }
}

test("RBT-009 Tier A: 1/2/3 lane round-robin fairness and mutation singleton", () => {
  const scheduler = new BrowserScheduler({ adapter: new FakeAdapter(), pageBudget: 3 });
  for (const count of [1, 2, 3]) {
    const lanes = ["lane-1","lane-2","lane-3"].map((lane_id, i) => ({ lane_id, enabled: i < count }));
    const seen = new Map();
    for (let i = 0; i < count * 4; i += 1) {
      const turn = scheduler.nextEnabledTurn(lanes);
      seen.set(turn.lane_id, (seen.get(turn.lane_id) || 0) + 1);
    }
    assert.equal(seen.size, count);
    for (const n of seen.values()) assert.ok(n >= 4);
  }

  const release = scheduler.acquireMutationLease({ laneId: "lane-1", role: "WORK" });
  assert.throws(() => scheduler.acquireMutationLease({ laneId: "lane-2", role: "WORK" }), /already held/);
  assert.equal(scheduler.snapshot().mutation_lease_active, true);
  release();
  assert.equal(scheduler.snapshot().mutation_lease_active, false);
});

test("RBT-009 Tier A: global resident page budget never exceeds 3", async () => {
  const adapter = new FakeAdapter();
  const scheduler = new BrowserScheduler({ adapter, pageBudget: 3 });
  for (let i = 0; i < 3; i += 1) {
    const page = new FakePage(i);
    adapter.pages.push(page);
    scheduler.registerPage(page, { laneId: "lane-" + ((i % 3) + 1), role: "WORK" });
    scheduler.releaseObservation(page, { evictable: true });
  }
  assert.equal(scheduler.snapshot().resident_chatgpt_pages, 3);
  await scheduler.ensureCapacity(1);
  assert.ok(scheduler.snapshot().resident_chatgpt_pages <= 2);
});

test("RBT-009 Tier A: active >30m does not false-reload and other lanes still receive turns", () => {
  const state = defaultWorkWatchdog();
  const out = evaluateWorkWatchdog({
    now: iso(36),
    awaitingWork: true,
    dispatchConfirmed: true,
    taskId: "TASK-LONG",
    workGeneration: 1,
    workUrlRevision: 1,
    timing: { started_at: iso(0), last_activity_at: iso(35), completed_at: null },
    observation: { response_running: true },
    watchdog: state
  });
  assert.equal(out.decision, WORK_WATCHDOG_DECISIONS.WORKING_LONG);
  assert.equal(out.state.reload_count, 0);

  const scheduler = new BrowserScheduler({ adapter: new FakeAdapter(), pageBudget: 3 });
  const lanes = ["lane-1","lane-2","lane-3"].map((lane_id) => ({ lane_id, enabled: true }));
  const turns = Array.from({ length: 9 }, () => scheduler.nextEnabledTurn(lanes).lane_id);
  assert.deepEqual(turns, ["lane-1","lane-2","lane-3","lane-1","lane-2","lane-3","lane-1","lane-2","lane-3"]);
});

test("RBT-009 Tier A: inactive >30m persists one reload intent per epoch and becomes stalled", () => {
  let watchdog = defaultWorkWatchdog();
  const base = {
    awaitingWork: true,
    dispatchConfirmed: true,
    taskId: "TASK-STALLED",
    workGeneration: 2,
    workUrlRevision: 4,
    timing: { started_at: iso(0), last_activity_at: iso(20), completed_at: null },
    observation: { response_running: false }
  };
  let out = evaluateWorkWatchdog({ ...base, now: iso(36), watchdog });
  assert.equal(out.decision, WORK_WATCHDOG_DECISIONS.STALL_CHECK);
  watchdog = out.state;

  out = evaluateWorkWatchdog({ ...base, now: iso(36), watchdog });
  assert.equal(out.decision, WORK_WATCHDOG_DECISIONS.RELOAD_ELIGIBLE);
  watchdog = beginWatchdogReloadIntent(out.state, { now: iso(36) });
  assert.equal(watchdog.reload_count, 1);

  const restarted = structuredClone(watchdog);
  out = evaluateWorkWatchdog({ ...base, now: iso(37), watchdog: restarted });
  assert.notEqual(out.decision, WORK_WATCHDOG_DECISIONS.RELOAD_ELIGIBLE);
  assert.equal(out.state.reload_count, 1);

  watchdog = markWatchdogReloaded(watchdog, { now: iso(37) });
  out = evaluateWorkWatchdog({ ...base, now: iso(43), watchdog });
  assert.equal(out.decision, WORK_WATCHDOG_DECISIONS.POSSIBLY_STALLED);
  assert.equal(out.state.reload_count, 1);
});

test("RBT-009 Tier A: active Owner Work hot-save remains pending until safe boundary", () => {
  const lane = {
    work_url: "https://chatgpt.com/c/old",
    applied_work_mode: "OWNER",
    applied_work_url_revision: 1,
    applied_work_saved_at: iso(0),
    work_generation: 7,
    awaiting_work: true,
    dispatch_inflight: null,
    relay_inflight: null,
    last_result_relay_id: null,
    task_timing: { completed_at: null, relay_confirmed_at: null },
    pending_work_url: "",
    pending_work_url_revision: 0,
    pending_work_saved_at: null,
    pending_work_mode: null
  };
  const pending = acceptOwnerWorkTargetRevision(lane, {
    url: "https://chatgpt.com/c/new", mode: "OWNER", revision: 2, saved_at: iso(1)
  });
  assert.equal(pending.status, "PENDING");
  assert.equal(lane.work_url, "https://chatgpt.com/c/old");
  assert.equal(lane.work_generation, 7);

  lane.awaiting_work = false;
  const applied = applyPendingWorkTargetIfSafe(lane);
  assert.equal(applied.status, "APPLIED");
  assert.equal(lane.work_url, "https://chatgpt.com/c/new");
  assert.equal(lane.work_generation, 8);

  const same = acceptOwnerWorkTargetRevision(lane, {
    url: "https://chatgpt.com/c/new", mode: "OWNER", revision: 3, saved_at: iso(2)
  });
  assert.equal(same.status, "ACKNOWLEDGED");
  assert.equal(lane.work_generation, 8);
});

test("RBT-009 Tier A: stale target quarantine suppresses 100 future reopen decisions and survives normalize-style reuse", () => {
  const digest = crypto.createHash("sha256").update("synthetic-target").digest("hex");
  const identity = targetHealthIdentity({
    role: "WORK", targetDigest: digest, targetRevision: 5, workGeneration: 9
  });
  const q = quarantineTarget(defaultTargetHealth(), identity, {
    reasonCode: TARGET_HEALTH_REASONS.CONVERSATION_MISSING,
    at: iso(0)
  });
  for (let i = 0; i < 100; i += 1) assert.equal(isTargetQuarantined(q.health, identity), true);
  const sameDigestNewRevision = targetHealthIdentity({
    role: "WORK", targetDigest: digest, targetRevision: 6, workGeneration: 10
  });
  assert.equal(isTargetQuarantined(q.health, sameDigestNewRevision), true);
});

test("RBT-009 Tier A: Brain ACCEPT/REJECT correlation and unrelated correction block", () => {
  const relay = "a".repeat(32);
  const lane = { task_id: "TASK-1", last_result_relay_id: relay, last_result_verdict: null };
  const accept = evaluateBrainVerdictTransition(lane, {
    action: "WORK",
    task_id: "TASK-2",
    previous_result: { task_id: "TASK-1", relay_id: relay, verdict: "ACCEPT" }
  });
  assert.equal(accept.record.verdict, "ACCEPT");

  assert.throws(() => evaluateBrainVerdictTransition(lane, {
    action: "WORK",
    task_id: "TASK-UNRELATED",
    previous_result: { task_id: "TASK-1", relay_id: relay, verdict: "REJECT" }
  }), /unrelated/);

  const correction = evaluateBrainVerdictTransition(lane, {
    action: "WORK",
    task_id: "TASK-1-FIX",
    previous_result: { task_id: "TASK-1", relay_id: relay, verdict: "REJECT" },
    correction_of: { task_id: "TASK-1", relay_id: relay }
  });
  assert.equal(correction.record.verdict, "REJECT");
});

test("RBT-009 Tier A: metadata event validator enforces exact-once and transition order", () => {
  const dispatch = "d".repeat(32);
  const relay = "e".repeat(32);
  const events = [
    { event_type:"BRAIN_TASK_ASSIGNED", lane_id:"lane-1", task_id:"TASK-X", work_generation:1 },
    { event_type:"WORK_DISPATCH_CONFIRMED", lane_id:"lane-1", task_id:"TASK-X", work_generation:1, dispatch_id:dispatch },
    { event_type:"WORK_STARTED", lane_id:"lane-1", task_id:"TASK-X", work_generation:1 },
    { event_type:"WORK_ACTIVITY", lane_id:"lane-1", task_id:"TASK-X", work_generation:1 },
    { event_type:"WORK_COMPLETED", lane_id:"lane-1", task_id:"TASK-X", work_generation:1 },
    { event_type:"RESULT_RELAY_CONFIRMED", lane_id:"lane-1", task_id:"TASK-X", work_generation:1, relay_id:relay },
    { event_type:"BRAIN_RESULT_ACCEPTED", lane_id:"lane-1", task_id:"TASK-X", work_generation:1, relay_id:relay }
  ];
  const ok = validateReleaseEvents(events);
  assert.equal(ok.dispatch_confirmed, 1);
  assert.equal(ok.relay_confirmed, 1);
  assert.throws(() => validateReleaseEvents([...events, events[1]]), /duplicate confirmed dispatch/);
  assert.throws(() => validateReleaseEvents([events[0], events[1], events[5]]), /before work completion/);
});


test("RBT-009 Tier A: rollback/install contract preserves local lane authority state", async () => {
  const source = await fs.readFile(new URL("../windows/install-supervisor.ps1", import.meta.url), "utf8");
  assert.match(source, /Remove-Item \$runtime -Recurse -Force/);
  assert.match(source, /OWNER_STOP_PRESERVED_DURING_INSTALL=True/);
  assert.doesNotMatch(source, /Remove-Item \$root\s+-Recurse/);
  assert.doesNotMatch(source, /Remove-Item .*lanes\.json/i);
  assert.doesNotMatch(source, /Remove-Item .*lane-registry\.json/i);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbt009-rollback-"));
  try {
    const runtime = path.join(root, "runtime");
    await fs.mkdir(runtime);
    await fs.writeFile(path.join(runtime, "old-runtime.txt"), "old");
    const lanes = JSON.stringify({ lanes: [{ lane_id: "lane-1", brain_url: "opaque-brain", work_url: "opaque-work" }] });
    const registry = JSON.stringify({ lanes: { "lane-1": { pending_work_url: "opaque-next", work_target_health: { state: "QUARANTINED" } } } });
    await fs.writeFile(path.join(root, "lanes.json"), lanes);
    await fs.writeFile(path.join(root, "lane-registry.json"), registry);
    await fs.writeFile(path.join(root, "STOP"), "owner-stop");

    await fs.rm(runtime, { recursive: true, force: true });
    await fs.mkdir(runtime);
    await fs.writeFile(path.join(runtime, "previous-release-restored.txt"), "restored");

    assert.equal(await fs.readFile(path.join(root, "lanes.json"), "utf8"), lanes);
    assert.equal(await fs.readFile(path.join(root, "lane-registry.json"), "utf8"), registry);
    assert.equal(await fs.readFile(path.join(root, "STOP"), "utf8"), "owner-stop");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
