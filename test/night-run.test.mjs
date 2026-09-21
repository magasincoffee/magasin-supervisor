import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

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

const repoRoot = new URL("../../../", import.meta.url);
const readJson = async (relative) =>
  JSON.parse(await fs.readFile(new URL(relative, repoRoot), "utf8"));

async function canonical() {
  const [contract, registry, cursor] = await Promise.all([
    readJson("02_CORE/contracts/night-run-2026-09-18.v2.json"),
    readJson("02_CORE/contracts/business-os-project-registry.v1.json"),
    readJson("02_CORE/contracts/business-os-execution-cursor.v1.json")
  ]);
  return { contract, registry, cursor };
}

test("canonical night-run contract is bounded to the two approved projects", async () => {
  const { contract, registry, cursor } = await canonical();
  const result = validateNightRunContract({ contract, registry, cursor });

  assert.equal(result.id, "NIGHT_RUN_2026-09-18");
  assert.deepEqual(result.allowedProjectIds, [
    "magasin-business-os",
    "magasin-media-robot"
  ]);
  assert.equal(contract.hard_stop, true);
  assert.equal(registry.discovery_policy, "DENY_UNREGISTERED");
});

test("night-run deadline is deterministic and hard-stops at the boundary", async () => {
  const { contract } = await canonical();
  assert.equal(
    nightRunWindowState(contract, "2026-09-18T23:14:59+07:00"),
    "BEFORE"
  );
  assert.equal(
    nightRunWindowState(contract, "2026-09-18T23:15:00+07:00"),
    "ACTIVE"
  );
  assert.equal(
    shouldHardStop(contract, "2026-09-19T09:14:59+07:00"),
    false
  );
  assert.equal(
    shouldHardStop(contract, "2026-09-19T09:15:00+07:00"),
    true
  );
});

test("cursor lease prevents duplicate concurrent workers", async () => {
  const { cursor } = await canonical();
  const leased = acquireCursorLease(cursor, {
    holder: "worker-a",
    now: "2026-09-18T23:40:00+07:00",
    ttlMs: 60_000
  });

  assert.equal(leased.lease.holder, "worker-a");
  assert.throws(
    () =>
      acquireCursorLease(leased, {
        holder: "worker-b",
        now: "2026-09-18T23:40:30+07:00",
        ttlMs: 60_000
      }),
    NightRunLeaseBusyError
  );
});

test("checkpoint requires active lease ownership and release is explicit", async () => {
  const { cursor } = await canonical();
  const leased = acquireCursorLease(cursor, {
    holder: "worker-a",
    now: "2026-09-18T23:40:00+07:00"
  });

  assert.throws(
    () =>
      checkpointCursor(leased, {
        holder: "worker-b",
        projectId: "magasin-business-os",
        task: "TASK-038",
        microTask: "lease_test",
        checkpoint: "TESTED",
        lastCommit: "abc123",
        now: "2026-09-18T23:41:00+07:00"
      }),
    NightRunLeaseBusyError
  );

  const checkpointed = checkpointCursor(leased, {
    holder: "worker-a",
    projectId: "magasin-business-os",
    task: "TASK-038",
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

test("expired lease remains fail-closed until HEAD and CI are reconciled", async () => {
  const { cursor } = await canonical();
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
  assert.equal(waiting.cursor.lease.holder, "worker-a");

  const recovered = reconcileStaleCursorLease(leased, {
    now: "2026-09-18T23:42:00+07:00",
    headVerified: true,
    ciVerified: true
  });
  assert.equal(recovered.action, "STALE_LEASE_RELEASED");
  assert.equal(recovered.cursor.lease, null);
});

test("unregistered projects and missing safety rules are rejected", async () => {
  const { contract, registry, cursor } = await canonical();
  const badContract = structuredClone(contract);
  badContract.allowed_projects.push({
    id: "third-project",
    repository: "example/third"
  });
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


test("hard-stop workflow is GitHub-hosted and reconciles every canonical final-state surface", async () => {
  const workflow = await fs.readFile(
    new URL(".github/workflows/night-run-hard-stop.yml", repoRoot),
    "utf8"
  );

  assert.match(workflow, /cron:\s*"15 2 19 9 \*"/);
  assert.match(workflow, /2026-09-19T02:15:00Z/);
  assert.match(workflow, /2026-09-20T00:00:00Z/);
  assert.match(workflow, /now_epoch/);
  assert.match(workflow, /boundary_epoch/);
  assert.match(workflow, /day_end_epoch/);
  assert.doesNotMatch(workflow, /date -u \\+%Y-%m-%d/);
  assert.match(workflow, /runs-on:\s*ubuntu-latest/);
  assert.match(workflow, /NIGHT_WINDOW_COMPLETE/);
  assert.match(workflow, /state\["status"\]\s*=\s*"WAIT_USER"/);
  assert.match(workflow, /state\["autonomy"\]\s*=\s*"MANUAL"/);
  assert.match(workflow, /night\["hard_stop_pending"\]\s*=\s*False/);
  assert.match(workflow, /if night\.get\("status"\) == "NIGHT_WINDOW_COMPLETE":/);
  assert.match(workflow, /preserve subsequent Owner state/);
  assert.match(workflow, /raise SystemExit\(0\)/);
  assert.ok(
    workflow.indexOf('if night.get("status") == "NIGHT_WINDOW_COMPLETE":') <
      workflow.indexOf('completed_at = night.get("completed_at")'),
    "completed hard-stop guard must run before any final-state mutation"
  );
  assert.match(workflow, /night\.get\("completed_at"\) or datetime\.now/);
  assert.match(workflow, /night\.get\("hard_stop_enforced_by"\) or "GITHUB_HOSTED_WORKFLOW"/);
  assert.match(workflow, /cursor_already_complete/);
  assert.match(workflow, /cursor_updated_at = cursor\.get\("updated_at"\) if cursor_already_complete else completed_at/);
  assert.match(workflow, /if "NIGHT_WINDOW_COMPLETE" not in completed_operations:/);
  assert.match(workflow, /current_state_path\s*=\s*Path\("01_DOCS\/MAGASIN\/00_CURRENT_STATE\.md"\)/);
  assert.match(workflow, /task_queue_path\s*=\s*Path\("01_DOCS\/MAGASIN\/00_TASK_QUEUE\.md"\)/);
  assert.match(workflow, /architecture_path\s*=\s*Path\("01_DOCS\/MAGASIN\/00_ARCHITECTURE_5_STEP_RESET\.md"\)/);
  assert.match(workflow, /report_path\s*=\s*Path\("01_DOCS\/MAGASIN\/08_AUTONOMY\/NIGHT_RUN_REPORT_2026-09-19\.md"\)/);
  assert.match(workflow, /evidence_path\s*=\s*Path\("01_DOCS\/MAGASIN\/05_SYSTEM\/NIGHT_RUN_2026-09-18_EVIDENCE_V1\.md"\)/);
  assert.match(workflow, /owner_reprioritized = state\.get\("current_task"\) != "TASK-048"/);
  assert.match(workflow, /if not owner_reprioritized:/);
  assert.match(workflow, /owner_reprioritized_task_preserved/);
  assert.match(workflow, /preserved_task = state\.get\("current_task"\)/);
  assert.match(workflow, /assert state\.get\("current_task"\) == preserved_task/);
  assert.match(workflow, /BACKGROUND_HARD_STOP_COMPLETE/);
  assert.match(workflow, /LATER OWNER TASK PRESERVED/);
  assert.match(workflow, /01_DOCS\/MAGASIN\/05_SYSTEM\/NIGHT_RUN_2026-09-18_EVIDENCE_V1\.md/);
  assert.match(workflow, /FINAL_CHECKPOINT_IN_PROGRESS \/ PAUSED/);
  assert.match(workflow, /READY \/ PAUSED/);
  assert.match(workflow, /NIGHT_WINDOW_COMPLETE \/ WAIT_USER/);
  assert.match(workflow, /later explicit Owner reprioritization remains authoritative/);
  assert.doesNotMatch(workflow, /if not report_path\.exists\(\):/);
  assert.doesNotMatch(workflow, /runs-on:\s*self-hosted/);
});
