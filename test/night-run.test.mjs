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

function canonical() {
  const contract = {
    schema_version: "night-run.v2",
    id: "NIGHT-RUN-TEST",
    start_at: "2026-09-18T23:15:00+07:00",
    stop_at: "2026-09-19T09:15:00+07:00",
    hard_stop: true,
    allowed_projects: [
      { id: "project-a", repository: "example/project-a" },
      { id: "project-b", repository: "example/project-b" }
    ],
    execution: [
      {
        order: 1,
        project_id: "project-a",
        task: "WORK-A",
        start_at: "2026-09-18T23:15:00+07:00",
        stop_at: "2026-09-19T01:15:00+07:00"
      },
      {
        order: 2,
        project_id: "project-b",
        task: "WORK-B",
        start_at: "2026-09-19T01:15:00+07:00",
        stop_at: "2026-09-19T03:15:00+07:00"
      }
    ],
    forbidden: [
      "SECRET_EXPOSURE",
      "MFA_BYPASS",
      "CAPTCHA_BYPASS",
      "DESTRUCTIVE_PRODUCTION_DB",
      "LIVE_SAYDIVOICE_GENERATE",
      "LIVE_SAYDIVOICE_DOWNLOAD",
      "THIRD_PROJECT_EXECUTION"
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
    night_run_id: "NIGHT-RUN-TEST",
    project_id: "project-a",
    task: "WORK-A",
    micro_task: "bootstrap",
    checkpoint: "READY",
    last_commit: "abc123",
    status: "READY",
    lease: null,
    updated_at: "2026-09-18T23:15:00+07:00"
  };
  return { contract, registry, cursor };
}

test("night-run contract accepts explicit project-neutral registry and cursor inputs", () => {
  const { contract, registry, cursor } = canonical();
  const result = validateNightRunContract({ contract, registry, cursor });
  assert.equal(result.id, "NIGHT-RUN-TEST");
  assert.deepEqual(result.allowedProjectIds, ["project-a", "project-b"]);
});

test("night-run deadline is deterministic and hard-stops at the boundary", () => {
  const { contract } = canonical();
  assert.equal(nightRunWindowState(contract, "2026-09-18T23:14:59+07:00"), "BEFORE");
  assert.equal(nightRunWindowState(contract, "2026-09-18T23:15:00+07:00"), "ACTIVE");
  assert.equal(shouldHardStop(contract, "2026-09-19T09:14:59+07:00"), false);
  assert.equal(shouldHardStop(contract, "2026-09-19T09:15:00+07:00"), true);
});

test("cursor lease prevents duplicate concurrent workers", () => {
  const { cursor } = canonical();
  const leased = acquireCursorLease(cursor, {
    holder: "worker-a",
    now: "2026-09-18T23:40:00+07:00",
    ttlMs: 60_000
  });
  assert.equal(leased.lease.holder, "worker-a");
  assert.throws(
    () => acquireCursorLease(leased, {
      holder: "worker-b",
      now: "2026-09-18T23:40:30+07:00",
      ttlMs: 60_000
    }),
    NightRunLeaseBusyError
  );
});

test("checkpoint requires lease ownership and release is explicit", () => {
  const { cursor } = canonical();
  const leased = acquireCursorLease(cursor, {
    holder: "worker-a",
    now: "2026-09-18T23:40:00+07:00"
  });
  assert.throws(
    () => checkpointCursor(leased, {
      holder: "worker-b",
      projectId: "project-a",
      task: "WORK-A",
      microTask: "lease-test",
      checkpoint: "TESTED",
      lastCommit: "abc123",
      now: "2026-09-18T23:41:00+07:00"
    }),
    NightRunLeaseBusyError
  );
  const checkpointed = checkpointCursor(leased, {
    holder: "worker-a",
    projectId: "project-a",
    task: "WORK-A",
    microTask: "lease-test",
    checkpoint: "TESTED",
    lastCommit: "abc123",
    now: "2026-09-18T23:41:00+07:00"
  });
  assert.equal(checkpointed.checkpoint, "TESTED");
  assert.equal(releaseCursorLease(checkpointed, {
    holder: "worker-a",
    now: "2026-09-18T23:42:00+07:00"
  }).lease, null);
});

test("expired lease remains fail-closed until HEAD and CI are reconciled", () => {
  const { cursor } = canonical();
  const leased = acquireCursorLease(cursor, {
    holder: "worker-a",
    now: "2026-09-18T23:40:00+07:00",
    ttlMs: 60_000
  });
  const waiting = reconcileStaleCursorLease(leased, {
    now: "2026-09-18T23:42:00+07:00",
    headVerified: true,
    ciVerified: false
  });
  assert.equal(waiting.action, "WAIT_RECONCILE_HEAD_CI");
  const recovered = reconcileStaleCursorLease(leased, {
    now: "2026-09-18T23:42:00+07:00",
    headVerified: true,
    ciVerified: true
  });
  assert.equal(recovered.action, "STALE_LEASE_RELEASED");
  assert.equal(recovered.cursor.lease, null);
});

test("unregistered projects and missing safety rules are rejected", () => {
  const { contract, registry, cursor } = canonical();
  const badContract = structuredClone(contract);
  badContract.allowed_projects.push({ id: "project-c", repository: "example/project-c" });
  assert.throws(
    () => validateNightRunContract({ contract: badContract, registry, cursor }),
    NightRunContractError
  );

  const unsafeContract = structuredClone(contract);
  unsafeContract.forbidden = unsafeContract.forbidden.filter(
    (item) => item !== "THIRD_PROJECT_EXECUTION"
  );
  assert.throws(
    () => validateNightRunContract({ contract: unsafeContract, registry, cursor }),
    NightRunContractError
  );
});

test("legacy registry/cursor schema names remain compatibility aliases only", () => {
  const { contract, registry, cursor } = canonical();
  registry.schema_version = "business-os-project-registry.v1";
  cursor.schema_version = "business-os-execution-cursor.v1";
  assert.doesNotThrow(() => validateNightRunContract({ contract, registry, cursor }));
});
