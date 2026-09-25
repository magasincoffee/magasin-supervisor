import { setTimeout as delay } from "node:timers/promises";

export const DEFAULT_CHATGPT_PAGE_BUDGET = 3;

export const PAGE_LEASE_STATES = Object.freeze({
  ACTIVE_MUTATION: "ACTIVE_MUTATION",
  ACTIVE_OBSERVATION: "ACTIVE_OBSERVATION",
  PARKED: "PARKED",
  EVICTABLE: "EVICTABLE",
  CLOSED: "CLOSED"
});

const DEFAULT_LANE_ORDER = Object.freeze(["lane-1", "lane-2", "lane-3"]);

function clampBudget(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new TypeError("page budget must be a positive integer");
  }
  return number;
}

function laneIdOf(value) {
  return String(value || "").trim();
}

function roleOf(value) {
  const role = String(value || "").trim().toUpperCase();
  return role || "UNKNOWN";
}

function safeNow(now) {
  return typeof now === "function" ? now : () => Date.now();
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return number;
}

function safeSleep(sleep) {
  return typeof sleep === "function" ? sleep : delay;
}

function pageClosed(page) {
  return !page || (typeof page.isClosed === "function" && page.isClosed());
}

export class BrowserScheduler {
  constructor({
    adapter,
    pageBudget = DEFAULT_CHATGPT_PAGE_BUDGET,
    laneOrder = DEFAULT_LANE_ORDER,
    now = Date.now,
    mutationMinIntervalMs = 0,
    sleep = delay
  } = {}) {
    if (!adapter) throw new TypeError("browser scheduler requires adapter");
    this.adapter = adapter;
    this.pageBudget = clampBudget(pageBudget);
    this.laneOrder = [...laneOrder];
    this.now = safeNow(now);
    this.mutationMinIntervalMs = nonNegativeInteger(
      mutationMinIntervalMs,
      "mutationMinIntervalMs"
    );
    this.sleep = safeSleep(sleep);
    this.lastMutationAt = null;
    this.cursor = 0;
    this.turnCount = 0;
    this.roundCount = 0;
    this.mutationOwner = null;
    this.leases = new Map();
    this.sequence = 0;
  }

  resetTransientState() {
    this.cursor = 0;
    this.mutationOwner = null;
    this.leases.clear();
    this.sequence = 0;
  }

  enabledLaneIds(configLanes = []) {
    const enabled = new Set(
      configLanes
        .filter((lane) => Boolean(lane?.enabled))
        .map((lane) => laneIdOf(lane?.lane_id))
    );
    return this.laneOrder.filter((laneId) => enabled.has(laneId));
  }

  nextEnabledTurn(configLanes = []) {
    const enabled = new Set(this.enabledLaneIds(configLanes));
    if (!enabled.size) {
      return {
        lane_id: null,
        round_complete: true,
        turn_count: this.turnCount,
        round_count: this.roundCount
      };
    }

    let selectedIndex = -1;
    for (let offset = 0; offset < this.laneOrder.length; offset += 1) {
      const index = (this.cursor + offset) % this.laneOrder.length;
      if (enabled.has(this.laneOrder[index])) {
        selectedIndex = index;
        break;
      }
    }
    if (selectedIndex < 0) {
      return {
        lane_id: null,
        round_complete: true,
        turn_count: this.turnCount,
        round_count: this.roundCount
      };
    }

    const laneId = this.laneOrder[selectedIndex];
    let hasEnabledAfterWithoutWrap = false;
    for (let index = selectedIndex + 1; index < this.laneOrder.length; index += 1) {
      if (enabled.has(this.laneOrder[index])) {
        hasEnabledAfterWithoutWrap = true;
        break;
      }
    }
    const roundComplete = !hasEnabledAfterWithoutWrap;
    this.cursor = (selectedIndex + 1) % this.laneOrder.length;
    this.turnCount += 1;
    if (roundComplete) this.roundCount += 1;

    return {
      lane_id: laneId,
      round_complete: roundComplete,
      turn_count: this.turnCount,
      round_count: this.roundCount
    };
  }

  residentPages() {
    return [...this.leases.values()]
      .filter((lease) =>
        lease.state !== PAGE_LEASE_STATES.CLOSED &&
        !pageClosed(lease.page)
      );
  }

  residentPageCount() {
    if (typeof this.adapter.getChatGptPages === "function") {
      return this.adapter.getChatGptPages().length;
    }
    return this.residentPages().length;
  }

  async syncExistingPages() {
    const pages = typeof this.adapter.getChatGptPages === "function"
      ? this.adapter.getChatGptPages()
      : [];
    const live = new Set(pages);

    for (const [page, lease] of this.leases) {
      if (!live.has(page) || pageClosed(page)) {
        lease.state = PAGE_LEASE_STATES.CLOSED;
      }
    }

    for (const page of pages) {
      if (this.leases.has(page)) continue;
      const hasArtifact = typeof this.adapter.hasNonPersistedComposerArtifact === "function"
        ? await this.adapter.hasNonPersistedComposerArtifact(page).catch(() => true)
        : true;
      this.leases.set(page, {
        page,
        lane_id: null,
        role: "UNMANAGED",
        target_revision: 0,
        generation: 0,
        state: PAGE_LEASE_STATES.PARKED,
        non_persisted_artifact: Boolean(hasArtifact),
        last_used: ++this.sequence
      });
    }
    return this.residentPageCount();
  }

  leaseFor(page) {
    return this.leases.get(page) || null;
  }

  registerPage(page, {
    laneId = undefined,
    role = undefined,
    targetRevision = undefined,
    generation = undefined,
    state = PAGE_LEASE_STATES.PARKED,
    nonPersistedArtifact = false
  } = {}) {
    if (!page || pageClosed(page)) throw new Error("cannot lease a closed page");
    const current = this.leases.get(page) || {};
    const lease = {
      ...current,
      page,
      lane_id: laneId === undefined
        ? (current.lane_id ?? null)
        : (laneId ? laneIdOf(laneId) : null),
      role: role === undefined
        ? (current.role || "UNKNOWN")
        : roleOf(role),
      target_revision: targetRevision === undefined
        ? Number(current.target_revision || 0)
        : Number(targetRevision || 0),
      generation: generation === undefined
        ? Number(current.generation || 0)
        : Number(generation || 0),
      state,
      non_persisted_artifact: Boolean(nonPersistedArtifact),
      last_used: ++this.sequence
    };
    this.leases.set(page, lease);
    return lease;
  }

  async refreshArtifactGuard(lease) {
    if (!lease || pageClosed(lease.page)) return true;
    if (typeof this.adapter.hasNonPersistedComposerArtifact !== "function") {
      lease.non_persisted_artifact = true;
      return true;
    }
    lease.non_persisted_artifact = Boolean(
      await this.adapter.hasNonPersistedComposerArtifact(lease.page)
        .catch(() => true)
    );
    return lease.non_persisted_artifact;
  }

  evictionCandidates() {
    const priority = new Map([
      [PAGE_LEASE_STATES.EVICTABLE, 0],
      [PAGE_LEASE_STATES.PARKED, 1]
    ]);
    return this.residentPages()
      .filter((lease) =>
        priority.has(lease.state) &&
        !lease.non_persisted_artifact
      )
      .sort((a, b) => {
        const stateDiff = priority.get(a.state) - priority.get(b.state);
        return stateDiff || a.last_used - b.last_used;
      });
  }

  async evictOneSafe() {
    await this.syncExistingPages();
    for (const lease of this.residentPages()) {
      if (
        lease.state === PAGE_LEASE_STATES.EVICTABLE ||
        lease.state === PAGE_LEASE_STATES.PARKED
      ) {
        await this.refreshArtifactGuard(lease);
      }
    }

    const candidate = this.evictionCandidates()[0] || null;
    if (!candidate) return null;

    if (
      candidate.state === PAGE_LEASE_STATES.ACTIVE_MUTATION ||
      candidate.state === PAGE_LEASE_STATES.ACTIVE_OBSERVATION ||
      candidate.non_persisted_artifact
    ) {
      return null;
    }

    if (typeof this.adapter.closePage === "function") {
      await this.adapter.closePage(candidate.page);
    } else {
      await candidate.page.close();
    }
    candidate.state = PAGE_LEASE_STATES.CLOSED;
    candidate.last_used = ++this.sequence;
    return {
      lane_id: candidate.lane_id,
      role: candidate.role,
      state: PAGE_LEASE_STATES.CLOSED
    };
  }

  async ensureCapacity(required = 1) {
    const needed = Number(required || 0);
    if (!Number.isInteger(needed) || needed < 0) {
      throw new TypeError("required capacity must be a non-negative integer");
    }
    await this.syncExistingPages();
    while (this.residentPageCount() + needed > this.pageBudget) {
      const evicted = await this.evictOneSafe();
      if (!evicted) {
        const error = new Error("global ChatGPT page budget exhausted without a safe eviction candidate");
        error.code = "PAGE_BUDGET_EXHAUSTED_SAFE_EVICTION";
        throw error;
      }
    }
    return this.snapshot();
  }

  async trimToBudget() {
    await this.ensureCapacity(0);
    return this.snapshot();
  }

  async waitForMutationPacing() {
    if (
      this.mutationMinIntervalMs <= 0 ||
      this.lastMutationAt === null
    ) {
      return 0;
    }
    const elapsed = Math.max(0, this.now() - this.lastMutationAt);
    const remaining = Math.max(0, this.mutationMinIntervalMs - elapsed);
    if (remaining > 0) await this.sleep(remaining);
    return remaining;
  }

  markMutationStarted() {
    this.lastMutationAt = this.now();
  }

  acquireMutationLease({ laneId, role, page = null, reason = "UI_MUTATION" } = {}) {
    if (this.mutationOwner) {
      const error = new Error("global browser mutation lease is already held");
      error.code = "MUTATION_LEASE_BUSY";
      throw error;
    }
    const owner = {
      lane_id: laneId ? laneIdOf(laneId) : null,
      role: roleOf(role),
      reason: String(reason || "UI_MUTATION"),
      page
    };
    this.mutationOwner = owner;
    if (page) {
      this.registerPage(page, {
        laneId,
        role,
        state: PAGE_LEASE_STATES.ACTIVE_MUTATION
      });
    }

    let released = false;
    return ({ durable = true, nonPersistedArtifact = false } = {}) => {
      if (released) return;
      released = true;
      if (page && !pageClosed(page)) {
        const lease = this.leaseFor(page);
        if (lease) {
          lease.state = durable
            ? PAGE_LEASE_STATES.ACTIVE_OBSERVATION
            : PAGE_LEASE_STATES.PARKED;
          lease.non_persisted_artifact = Boolean(nonPersistedArtifact || !durable);
          lease.last_used = ++this.sequence;
        }
      }
      this.mutationOwner = null;
    };
  }

  async withMutationLease(meta, operation) {
    await this.waitForMutationPacing();
    const release = this.acquireMutationLease(meta);
    this.markMutationStarted();
    try {
      return await operation();
    } finally {
      release({ durable: true });
    }
  }

  async acquireExactPage({
    laneId,
    role,
    url,
    target,
    targetRevision = 0,
    generation = 0
  }) {
    if (!target?.origin || !target?.pathname) {
      throw new TypeError("exact target descriptor is required");
    }

    await this.syncExistingPages();
    let page = typeof this.adapter.findPageForTarget === "function"
      ? this.adapter.findPageForTarget(target)
      : null;

    if (!page) {
      await this.ensureCapacity(1);
      await this.waitForMutationPacing();
      const releaseMutation = this.acquireMutationLease({
        laneId,
        role,
        reason: "PAGE_REOPEN"
      });
      this.markMutationStarted();
      try {
        page = await this.adapter.reopenTargetPage(url);
        this.registerPage(page, {
          laneId,
          role,
          targetRevision,
          generation,
          state: PAGE_LEASE_STATES.ACTIVE_MUTATION
        });
      } finally {
        releaseMutation({ durable: true });
      }
    }

    this.registerPage(page, {
      laneId,
      role,
      targetRevision,
      generation,
      state: PAGE_LEASE_STATES.ACTIVE_OBSERVATION
    });
    return page;
  }

  async createPageUnderMutation({
    laneId,
    role,
    url = "https://chatgpt.com/",
    targetRevision = 0,
    generation = 0
  }, operation) {
    await this.ensureCapacity(1);
    await this.waitForMutationPacing();
    const releaseMutation = this.acquireMutationLease({
      laneId,
      role,
      reason: "CREATE_PAGE"
    });
    this.markMutationStarted();
    let page = null;
    try {
      page = await this.adapter.newChatPage(url, {
        allowTransientRetry: false
      });
      this.registerPage(page, {
        laneId,
        role,
        targetRevision,
        generation,
        state: PAGE_LEASE_STATES.ACTIVE_MUTATION
      });
      const result = await operation(page);
      releaseMutation({ durable: true });
      this.registerPage(page, {
        laneId,
        role,
        targetRevision,
        generation,
        state: PAGE_LEASE_STATES.ACTIVE_OBSERVATION
      });
      return { page, result };
    } catch (error) {
      releaseMutation({
        durable: Boolean(page),
        nonPersistedArtifact: !page
      });
      throw error;
    }
  }

  async invalidateExactPage({ page, url } = {}) {
    if (!page || pageClosed(page)) {
      if (typeof this.adapter.invalidateTargetRecoveryPage === "function") {
        await this.adapter.invalidateTargetRecoveryPage(url, {
          page,
          close: false
        }).catch(() => false);
      }
      return true;
    }

    const lease = this.leaseFor(page);
    if (lease?.state === PAGE_LEASE_STATES.ACTIVE_MUTATION) {
      return false;
    }

    const guarded = typeof this.adapter.hasNonPersistedComposerArtifact === "function"
      ? await this.adapter.hasNonPersistedComposerArtifact(page).catch(() => true)
      : true;
    if (guarded) {
      if (lease) {
        lease.non_persisted_artifact = true;
        lease.state = PAGE_LEASE_STATES.PARKED;
        lease.last_used = ++this.sequence;
      }
      return false;
    }

    if (typeof this.adapter.invalidateTargetRecoveryPage === "function") {
      await this.adapter.invalidateTargetRecoveryPage(url, {
        page,
        close: false
      }).catch(() => false);
    }

    if (typeof this.adapter.closePage === "function") {
      await this.adapter.closePage(page);
    } else {
      await page.close();
    }
    if (lease) {
      lease.state = PAGE_LEASE_STATES.CLOSED;
      lease.non_persisted_artifact = false;
      lease.last_used = ++this.sequence;
    }
    return true;
  }

  releaseObservation(page, {
    evictable = true,
    nonPersistedArtifact = false
  } = {}) {
    const lease = this.leaseFor(page);
    if (!lease || pageClosed(page)) return false;
    if (lease.state === PAGE_LEASE_STATES.ACTIVE_MUTATION) return false;
    lease.state = evictable
      ? PAGE_LEASE_STATES.EVICTABLE
      : PAGE_LEASE_STATES.PARKED;
    lease.non_persisted_artifact = Boolean(nonPersistedArtifact);
    lease.last_used = ++this.sequence;
    return true;
  }

  releaseLaneObservations(laneId) {
    const id = laneIdOf(laneId);
    let released = 0;
    for (const lease of this.residentPages()) {
      if (
        lease.lane_id === id &&
        lease.state === PAGE_LEASE_STATES.ACTIVE_OBSERVATION
      ) {
        lease.state = PAGE_LEASE_STATES.EVICTABLE;
        lease.non_persisted_artifact = false;
        lease.last_used = ++this.sequence;
        released += 1;
      }
    }
    return released;
  }

  parkPage(page, { nonPersistedArtifact = false } = {}) {
    const lease = this.leaseFor(page);
    if (!lease || pageClosed(page)) return false;
    if (lease.state === PAGE_LEASE_STATES.ACTIVE_MUTATION) return false;
    lease.state = PAGE_LEASE_STATES.PARKED;
    lease.non_persisted_artifact = Boolean(nonPersistedArtifact);
    lease.last_used = ++this.sequence;
    return true;
  }

  async reconstructFromBrowser() {
    this.resetTransientState();
    await this.syncExistingPages();
    await this.trimToBudget();
    return this.snapshot();
  }

  snapshot() {
    const states = Object.fromEntries(
      Object.values(PAGE_LEASE_STATES).map((state) => [state, 0])
    );
    for (const lease of this.residentPages()) {
      states[lease.state] = Number(states[lease.state] || 0) + 1;
    }
    return {
      schema_version: "browser-scheduler.v1",
      page_budget: this.pageBudget,
      resident_chatgpt_pages: this.residentPageCount(),
      mutation_lease_active: Boolean(this.mutationOwner),
      mutation_lane_id: this.mutationOwner?.lane_id || null,
      next_cursor: this.laneOrder[this.cursor] || this.laneOrder[0] || null,
      turn_count: this.turnCount,
      round_count: this.roundCount,
      lease_states: states
    };
  }
}
