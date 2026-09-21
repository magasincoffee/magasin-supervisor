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

function fixture({
  registrySchema = "supervisor-project-registry.v1",
  cursorSchema = "supervisor-execution-cursor.v1"
} = {}) {
  const contract = {
    schema_version: "night-run.v2",
    id: "PLATFORM_NIGHT_RUN_01",
    start_at: "2026-09-18T23:15:00+07:00",
    stop_at: "2026-09-19T09:15:00+07:00",
    hard_stop: true,
    allowed_projects: [
      { id: "project-alpha", repository: "example/alpha" },
      { id: "project-beta", repository: "example/beta" }
    ],
    execution: [
      {
        order: 1,
        task: "PLATFORM-038",
        start_at: "2026-09-18T23:15:00+07:00",
        stop_at: "2026-09-19T01:00:00+07:00"
      },
      {
        order: 2,
        task: "PLATFORM-039",
        start_at: "2026-09-19T01:00:00+07:00",
        stop_at: "2026-09-19T02:00:00+07:00"
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
    schema_version: registrySchema,
    discovery_policy: "DENY_UNREGISTERED",
    projects: [
      { id: "project-alpha", enabled: true },
      { id: "project-beta", enabled: true }
    ]
  };
  const cursor = {
    schema_version: cursorSchema,
    night_run_id: contract.id,
    project_id: "project-alpha",
    task: "PLATFORM-038",
    status: "READY",
    lease: null
  };
  return { contract, registry, cursor };
}

test("night-run contract validates project-neutral registry/cursor schemas", () => {
  const { contract, registry, cursor } = fixture();
  const result = validateNightRunContract({ contract, registry, cursor });
  assert.equal(result.id, "PLATFORM_NIGHT_RUN_01");
  assert.deepEqual(result.allowedProjectIds, ["project-alpha", "project-beta"]);
});

test("legacy Business OS registry/cursor schemas remain accepted as compatibility inputs", () => {
  const { contract, registry, cursor } = fixture({
    registrySchema: "business-os-project-registry.v1",
    cursorSchema: "business-os-execution-cursor.v1"
  });
  assert.doesNotThrow(() => validateNightRunContract({ contract, registry, cursor }));
});

test("night-run deadline is deterministic and hard-stops at the boundary", () => {
  const { contract } = fixture();
  assert.equal(nightRunWindowState(contract, "2026-09-18T23:14:59+07:00"), "BEFORE");
  assert.equal(nightRunWindowState(contract, "2026-09-18T23:15:00+07:00"), "ACTIVE");
  assert.equal(shouldHardStop(contract, "2026-09-19T09:14:59+07:00"), false);
  assert.equal(shouldHardStop(contract, "2026-09-19T09:15:00+07:00"), true);
});

test("cursor lease prevents duplicate concurrent workers", () => {
  const { cursor } = fixture();
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

test("checkpoint requires active lease ownership and release is explicit", () => {
  const { cursor } = fixture();
  const leased = acquireCursorLease(cursor, {
    holder: "worker-a",
    now: "2026-09-18T23:40:00+07:00"
  });
  assert.throws(
    () => checkpointCursor(leased, {
      holder: "worker-b",
      projectId: "project-alpha",
      task: "PLATFORM-038",
      microTask: "lease_test",
      checkpoint: "TESTED",
      lastCommit: "abc123",
      now: "2026-09-18T23:41:00+07:00"
    }),
    NightRunLeaseBusyError
  );
  const checkpointed = checkpointCursor(leased, {
    holder: "worker-a",
    projectId: "project-alpha",
    task: "PLATFORM-038",
    microTask: "lease_test",
    checkpoint: "TESTED",
    lastCommit: "abc123",
    now: "2026-09-18T23:41:00+07:00"
  });
  assert.equal(checkpointed.checkpoint, "TESTED");
  const released = releaseCursorLease(checkpointed, {
    holder: "worker-a",
    now: "2026-09-18T23:42:00+07:00"
  });
  assert.equal(released.lease, null);
});

test("expired lease remains fail-closed until HEAD and CI are reconciled", () => {
  const { cursor } = fixture();
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
  const { contract, registry, cursor } = fixture();
  const badContract = structuredClone(contract);
  badContract.allowed_projects.push({ id: "third-project", repository: "example/third" });
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
