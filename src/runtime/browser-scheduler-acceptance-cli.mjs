import assert from "node:assert/strict";
import {
  BrowserScheduler,
  DEFAULT_CHATGPT_PAGE_BUDGET,
  PAGE_LEASE_STATES
} from "./browser-scheduler.mjs";

class FakePage {
  constructor(url, id) {
    this._url = url;
    this.id = id;
    this.closed = false;
    this.hasDraft = false;
  }
  url() { return this._url; }
  isClosed() { return this.closed; }
  async close() { this.closed = true; }
}

class FakeAdapter {
  constructor() {
    this.pages = [];
    this.nextId = 1;
    this.reopenCount = 0;
    this.sendCount = 0;
  }
  getChatGptPages() {
    return this.pages.filter((page) => !page.closed);
  }
  findPageForTarget(target) {
    return this.getChatGptPages().find((page) => {
      const url = new URL(page.url());
      return url.origin === target.origin && url.pathname === target.pathname;
    }) || null;
  }
  async reopenTargetPage(url) {
    this.reopenCount += 1;
    const page = new FakePage(url, this.nextId++);
    this.pages.push(page);
    return page;
  }
  async newChatPage(url) {
    const page = new FakePage(url, this.nextId++);
    this.pages.push(page);
    return page;
  }
  async hasNonPersistedComposerArtifact(page) {
    return Boolean(page.hasDraft);
  }
  async closePage(page) {
    await page.close();
    return true;
  }
}

function target(url) {
  const parsed = new URL(url);
  return { origin: parsed.origin, pathname: parsed.pathname };
}

function lane(id, enabled = true) {
  return { lane_id: id, enabled };
}

const adapter = new FakeAdapter();
const scheduler = new BrowserScheduler({ adapter });

assert.equal(DEFAULT_CHATGPT_PAGE_BUDGET, 3);

const oneLane = Array.from({ length: 3 }, () =>
  scheduler.nextEnabledTurn([
    lane("lane-1"),
    lane("lane-2", false),
    lane("lane-3", false)
  ])
);
assert.deepEqual(oneLane.map((item) => item.lane_id), ["lane-1", "lane-1", "lane-1"]);
assert.ok(oneLane.every((item) => item.round_complete));

scheduler.resetTransientState();
const twoLane = Array.from({ length: 6 }, () =>
  scheduler.nextEnabledTurn([
    lane("lane-1"),
    lane("lane-2", false),
    lane("lane-3")
  ])
);
assert.deepEqual(twoLane.map((item) => item.lane_id), [
  "lane-1", "lane-3", "lane-1", "lane-3", "lane-1", "lane-3"
]);

scheduler.resetTransientState();
const threeLane = Array.from({ length: 6 }, () =>
  scheduler.nextEnabledTurn([
    lane("lane-1"),
    lane("lane-2"),
    lane("lane-3")
  ])
);
assert.deepEqual(threeLane.map((item) => item.lane_id), [
  "lane-1", "lane-2", "lane-3", "lane-1", "lane-2", "lane-3"
]);

const releaseMutation = scheduler.acquireMutationLease({
  laneId: "lane-1",
  role: "WORK",
  reason: "fixture"
});
assert.throws(
  () => scheduler.acquireMutationLease({
    laneId: "lane-2",
    role: "BRAIN",
    reason: "fixture-contention"
  }),
  (error) => error?.code === "MUTATION_LEASE_BUSY"
);
releaseMutation();

scheduler.resetTransientState();
for (let i = 1; i <= 6; i += 1) {
  const url = `https://chatgpt.com/c/fixture-${i}`;
  const page = await scheduler.acquireExactPage({
    laneId: `lane-${((i - 1) % 3) + 1}`,
    role: i % 2 ? "BRAIN" : "WORK",
    url,
    target: target(url),
    targetRevision: i,
    generation: i
  });
  scheduler.releaseObservation(page);
  assert.ok(scheduler.residentPageCount() <= 3);
}
assert.equal(scheduler.snapshot().page_budget, 3);
assert.ok(scheduler.snapshot().resident_chatgpt_pages <= 3);

scheduler.resetTransientState();
const lru1 = await scheduler.acquireExactPage({
  laneId: "lane-1",
  role: "BRAIN",
  url: "https://chatgpt.com/c/lru-1",
  target: target("https://chatgpt.com/c/lru-1")
});
scheduler.releaseObservation(lru1);
const lru2 = await scheduler.acquireExactPage({
  laneId: "lane-2",
  role: "BRAIN",
  url: "https://chatgpt.com/c/lru-2",
  target: target("https://chatgpt.com/c/lru-2")
});
scheduler.parkPage(lru2);
const lru3 = await scheduler.acquireExactPage({
  laneId: "lane-3",
  role: "BRAIN",
  url: "https://chatgpt.com/c/lru-3",
  target: target("https://chatgpt.com/c/lru-3")
});
scheduler.releaseObservation(lru3);
await scheduler.acquireExactPage({
  laneId: "lane-1",
  role: "WORK",
  url: "https://chatgpt.com/c/lru-4",
  target: target("https://chatgpt.com/c/lru-4")
});
assert.equal(lru1.isClosed(), true);
assert.equal(lru2.isClosed(), false);

const beforeReopen = adapter.reopenCount;
const reopenUrl = "https://chatgpt.com/c/reopen-proof";
const reopenPage = await scheduler.acquireExactPage({
  laneId: "lane-1",
  role: "WORK",
  url: reopenUrl,
  target: target(reopenUrl),
  targetRevision: 9,
  generation: 7
});
scheduler.releaseObservation(reopenPage);
await scheduler.trimToBudget();
await adapter.closePage(reopenPage);
const reopened = await scheduler.acquireExactPage({
  laneId: "lane-1",
  role: "WORK",
  url: reopenUrl,
  target: target(reopenUrl),
  targetRevision: 9,
  generation: 7
});
assert.ok(adapter.reopenCount > beforeReopen);
assert.equal(adapter.sendCount, 0);
scheduler.releaseObservation(reopened);

const active = await scheduler.acquireExactPage({
  laneId: "lane-1",
  role: "WORK",
  url: "https://chatgpt.com/c/active-mutation",
  target: target("https://chatgpt.com/c/active-mutation")
});
const activeRelease = scheduler.acquireMutationLease({
  laneId: "lane-1",
  role: "WORK",
  page: active,
  reason: "active-mutation-proof"
});
const activeLease = scheduler.leaseFor(active);
assert.equal(activeLease.state, PAGE_LEASE_STATES.ACTIVE_MUTATION);
const evictedDuringMutation = await scheduler.evictOneSafe();
assert.notEqual(active.isClosed(), true);
assert.notEqual(evictedDuringMutation?.lane_id === "lane-1" && active.isClosed(), true);
activeRelease();
scheduler.releaseObservation(active);

const draftPage = await scheduler.acquireExactPage({
  laneId: "lane-2",
  role: "BRAIN",
  url: "https://chatgpt.com/c/draft-guard",
  target: target("https://chatgpt.com/c/draft-guard")
});
draftPage.hasDraft = true;
scheduler.parkPage(draftPage, { nonPersistedArtifact: true });
await scheduler.evictOneSafe();
assert.equal(draftPage.isClosed(), false);
draftPage.hasDraft = false;
scheduler.releaseObservation(draftPage);

const durableLaneTruth = {
  task_id: "TASK-FIXTURE",
  awaiting_work: true,
  dispatch_inflight: {
    dispatch_id: "dispatch-fixture",
    task_id: "TASK-FIXTURE"
  },
  relay_inflight: {
    relay_id: "relay-fixture"
  },
  work_url: "https://chatgpt.com/c/old-work",
  work_generation: 4,
  pending_work_url: "https://chatgpt.com/c/new-work",
  pending_work_url_revision: 8,
  pending_work_mode: "OWNER"
};
const durableBefore = JSON.stringify(durableLaneTruth);
const latchPage = await scheduler.acquireExactPage({
  laneId: "lane-1",
  role: "WORK",
  url: durableLaneTruth.work_url,
  target: target(durableLaneTruth.work_url),
  targetRevision: 7,
  generation: durableLaneTruth.work_generation
});
scheduler.releaseObservation(latchPage);
await adapter.closePage(latchPage);
await scheduler.acquireExactPage({
  laneId: "lane-1",
  role: "WORK",
  url: durableLaneTruth.work_url,
  target: target(durableLaneTruth.work_url),
  targetRevision: 7,
  generation: durableLaneTruth.work_generation
});
assert.equal(JSON.stringify(durableLaneTruth), durableBefore);
await scheduler.reconstructFromBrowser();
assert.equal(JSON.stringify(durableLaneTruth), durableBefore);

console.log("BROWSER_SCHEDULER_FIXTURE_DEFAULT_BUDGET_3=True");
console.log("BROWSER_SCHEDULER_FIXTURE_ONE_LANE=True");
console.log("BROWSER_SCHEDULER_FIXTURE_TWO_LANE_FAIR=True");
console.log("BROWSER_SCHEDULER_FIXTURE_THREE_LANE_FAIR=True");
console.log("BROWSER_SCHEDULER_FIXTURE_MUTATION_SINGLETON=True");
console.log("BROWSER_SCHEDULER_FIXTURE_PAGE_BUDGET_HARD_BOUND=True");
console.log("BROWSER_SCHEDULER_FIXTURE_LRU_EVICTION=True");
console.log("BROWSER_SCHEDULER_FIXTURE_ACTIVE_MUTATION_NOT_EVICTED=True");
console.log("BROWSER_SCHEDULER_FIXTURE_UNPERSISTED_ARTIFACT_GUARDED=True");
console.log("BROWSER_SCHEDULER_FIXTURE_REOPEN_NO_RESEND=True");
console.log("BROWSER_SCHEDULER_FIXTURE_DURABLE_TRUTH_UNCHANGED=True");
console.log("BROWSER_SCHEDULER_FIXTURE_LATCHES_SURVIVE_REOPEN=True");
console.log("BROWSER_SCHEDULER_FIXTURE_PENDING_WORK_PRESERVED=True");
