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
    id: "NIGHT-RUN-DEMO",
    start_at: "2026-09-18T23:15:00+07:00",
    stop_at: "2026-09-19T09:15:00+07:00",
    hard_stop: true,
    allowed_projects: [
      { id: "project-a", repository: "example/project-a" },
      { id: "project-b", repository: "example/project-b" }
    ],
    execution: [
      { order: 1, task: "WORK-A", start_at: "2026-09-18T23:15:00+07:00", stop_at: "2026-09-19T01:15:00+07:00" },
      { order: 2, task: "WORK-B", start_at: "2026-09-19T01:15:00+07:00", stop_at: "2026-09-19T03:15:00+07:00" }
    ],
    forbidden: [
      "SECRET_EXPOSURE","MFA_BYPASS","CAPTCHA_BYPASS","DESTRUCTIVE_PRODUCTION_DB",
      "LIVE_SAYDIVOICE_GENERATE","LIVE_SAYDIVOICE_DOWNLOAD","THIRD_PROJECT_EXECUTION"
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
    night_run_id: contract.id,
    project_id: "project-a",
    task: "WORK-A",
    lease: null
  };
  return { contract, registry, cursor };
}

test("generic night-run contract validates explicit project registry and cursor", () => {
  const { contract, registry, cursor } = canonical();
  const result = validateNightRunContract({ contract, registry, cursor });
  assert.equal(result.id, "NIGHT-RUN-DEMO");
  assert.deepEqual(result.allowedProjectIds, ["project-a", "project-b"]);
});

test("legacy Business OS schema aliases remain readable for compatibility", () => {
  const { contract, registry, cursor } = canonical();
  registry.schema_version = "business-os-project-registry.v1";
  cursor.schema_version = "business-os-execution-cursor.v1";
  assert.doesNotThrow(() => validateNightRunContract({ contract, registry, cursor }));
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
  const leased = acquireCursorLease(cursor, { holder: "worker-a", now: "2026-09-18T23:40:00+07:00", ttlMs: 60_000 });
  assert.equal(leased.lease.holder, "worker-a");
  assert.throws(() => acquireCursorLease(leased, { holder: "worker-b", now: "2026-09-18T23:40:30+07:00", ttlMs: 60_000 }), NightRunLeaseBusyError);
});

test("checkpoint and stale-lease reconciliation remain fail-closed", () => {
  const { cursor } = canonical();
  const leased = acquireCursorLease(cursor, { holder: "worker-a", now: "2026-09-18T23:40:00+07:00", ttlMs: 60_000 });
  assert.throws(() => checkpointCursor(leased, {
    holder: "worker-b", projectId: "project-a", task: "WORK-A", microTask: "lease",
    checkpoint: "TESTED", lastCommit: "abc123", now: "2026-09-18T23:41:00+07:00"
  }), NightRunLeaseBusyError);
  const waiting = reconcileStaleCursorLease(leased, { now: "2026-09-18T23:42:00+07:00", headVerified: true, ciVerified: false });
  assert.equal(waiting.action, "WAIT_RECONCILE_HEAD_CI");
  const recovered = reconcileStaleCursorLease(leased, { now: "2026-09-18T23:42:00+07:00", headVerified: true, ciVerified: true });
  assert.equal(recovered.action, "STALE_LEASE_RELEASED");
  assert.equal(recovered.cursor.lease, null);
});

test("unregistered projects and missing safety rules are rejected", () => {
  const { contract, registry, cursor } = canonical();
  const bad = structuredClone(contract);
  bad.allowed_projects.push({ id: "project-c", repository: "example/project-c" });
  assert.throws(() => validateNightRunContract({ contract: bad, registry, cursor }), NightRunContractError);

  const unsafe = structuredClone(contract);
  unsafe.forbidden = unsafe.forbidden.filter((x) => x !== "THIRD_PROJECT_EXECUTION");
  assert.throws(() => validateNightRunContract({ contract: unsafe, registry, cursor }), NightRunContractError);
});

test("lease release is explicit and holder-bound", () => {
  const { cursor } = canonical();
  const leased = acquireCursorLease(cursor, { holder: "worker-a", now: "2026-09-18T23:40:00+07:00" });
  assert.throws(() => releaseCursorLease(leased, { holder: "worker-b" }), NightRunLeaseBusyError);
  const released = releaseCursorLease(leased, { holder: "worker-a", now: "2026-09-18T23:42:00+07:00" });
  assert.equal(released.lease, null);
});
