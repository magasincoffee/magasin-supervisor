import test from "node:test";
import assert from "node:assert/strict";

import {
  NightRunContractError,
  NightRunLeaseBusyError,
  acquireCursorLease,
  checkpointCursor,
  nightRunWindowState,
  reconcileStaleCursorLease,
  releaseCursorLease,
  shouldHardStop,
  validateNightRunContract
} from "../src/runtime/night-run.mjs";

function fixture() {
  const contract = {
    schema_version: "night-run.v2",
    id: "RUN-001",
    start_at: "2026-09-21T20:00:00Z",
    stop_at: "2026-09-21T22:00:00Z",
    hard_stop: true,
    allowed_projects: [
      { id: "project-a", repository: "example/project-a" },
      { id: "project-b", repository: "example/project-b" }
    ],
    execution: [
      {
        order: 1,
        task: "PLATFORM-001",
        start_at: "2026-09-21T20:00:00Z",
        stop_at: "2026-09-21T21:00:00Z"
      },
      {
        order: 2,
        task: "PLATFORM-002",
        start_at: "2026-09-21T21:00:00Z",
        stop_at: "2026-09-21T22:00:00Z"
      }
    ],
    forbidden: [
      "SECRET_EXPOSURE",
      "MFA_BYPASS",
      "CAPTCHA_BYPASS",
      "DESTRUCTIVE_PRODUCTION_ACTION",
      "UNREGISTERED_PROJECT_EXECUTION"
    ]
  };
  const registry = {
    schema_version: "supervisor-project-registry.v1",
    discovery_policy: "DENY_UNREGISTERED",
    projects: [
      { id: "project-a", enabled: true },
      { id: "project-b", enabled: true }
    ]
  };
  const cursor = {
    schema_version: "supervisor-execution-cursor.v1",
    night_run_id: "RUN-001",
    project_id: "project-a",
    task: "PLATFORM-001",
    micro_task: "bootstrap",
    checkpoint: "READY",
    last_commit: "abc123",
    status: "IN_PROGRESS",
    lease: null
  };
  return { contract, registry, cursor };
}

test("generic night-run contract is bounded to explicitly registered projects", () => {
  const { contract, registry, cursor } = fixture();
  const result = validateNightRunContract({ contract, registry, cursor });
  assert.equal(result.id, "RUN-001");
  assert.deepEqual(result.allowedProjectIds, ["project-a", "project-b"]);
});

test("night-run deadline is deterministic and hard-stops at the boundary", () => {
  const { contract } = fixture();
  assert.equal(nightRunWindowState(contract, "2026-09-21T19:59:59Z"), "BEFORE");
  assert.equal(nightRunWindowState(contract, "2026-09-21T20:00:00Z"), "ACTIVE");
  assert.equal(shouldHardStop(contract, "2026-09-21T21:59:59Z"), false);
  assert.equal(shouldHardStop(contract, "2026-09-21T22:00:00Z"), true);
});

test("cursor lease prevents duplicate concurrent workers", () => {
  const { cursor } = fixture();
  const leased = acquireCursorLease(cursor, {
    holder: "worker-a",
    now: "2026-09-21T20:10:00Z",
    ttlMs: 60_000
  });
  assert.throws(
    () => acquireCursorLease(leased, {
      holder: "worker-b",
      now: "2026-09-21T20:10:30Z",
      ttlMs: 60_000
    }),
    NightRunLeaseBusyError
  );
});

test("checkpoint requires active lease ownership and release is explicit", () => {
  const { cursor } = fixture();
  const leased = acquireCursorLease(cursor, {
    holder: "worker-a",
    now: "2026-09-21T20:10:00Z"
  });
  assert.throws(
    () => checkpointCursor(leased, {
      holder: "worker-b",
      projectId: "project-a",
      task: "PLATFORM-001",
      microTask: "lease-test",
      checkpoint: "TESTED",
      lastCommit: "abc123",
      now: "2026-09-21T20:11:00Z"
    }),
    NightRunLeaseBusyError
  );
  const checkpointed = checkpointCursor(leased, {
    holder: "worker-a",
    projectId: "project-a",
    task: "PLATFORM-001",
    microTask: "lease-test",
    checkpoint: "TESTED",
    lastCommit: "abc123",
    now: "2026-09-21T20:11:00Z"
  });
  const released = releaseCursorLease(checkpointed, {
    holder: "worker-a",
    now: "2026-09-21T20:12:00Z"
  });
  assert.equal(released.lease, null);
});

test("expired lease remains fail-closed until HEAD and CI are reconciled", () => {
  const { cursor } = fixture();
  const leased = acquireCursorLease(cursor, {
    holder: "worker-a",
    now: "2026-09-21T20:10:00Z",
    ttlMs: 60_000
  });
  const waiting = reconcileStaleCursorLease(leased, {
    now: "2026-09-21T20:12:00Z",
    headVerified: true,
    ciVerified: false
  });
  assert.equal(waiting.action, "WAIT_RECONCILE_HEAD_CI");
  const recovered = reconcileStaleCursorLease(leased, {
    now: "2026-09-21T20:12:00Z",
    headVerified: true,
    ciVerified: true
  });
  assert.equal(recovered.action, "STALE_LEASE_RELEASED");
  assert.equal(recovered.cursor.lease, null);
});

test("unregistered projects and missing generic safety rules are rejected", () => {
  const { contract, registry, cursor } = fixture();
  const bad = structuredClone(contract);
  bad.allowed_projects.push({ id: "project-c" });
  assert.throws(
    () => validateNightRunContract({ contract: bad, registry, cursor }),
    NightRunContractError
  );

  const unsafe = structuredClone(contract);
  unsafe.forbidden = unsafe.forbidden.filter(
    (item) => item !== "UNREGISTERED_PROJECT_EXECUTION"
  );
  assert.throws(
    () => validateNightRunContract({ contract: unsafe, registry, cursor }),
    NightRunContractError
  );
});
