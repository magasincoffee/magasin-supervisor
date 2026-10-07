import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseExternalRunControl,
  reconcileExternalRunState,
  reconcileTaskControlWithExternalRun
} from "../src/runtime/external-run-control.mjs";
import {
  ensureSingleConversationState,
  readSingleConversationState,
  writeSingleConversationState
} from "../src/runtime/single-conversation-state.mjs";
import {
  reconcileExternalRunResponse
} from "../src/runtime/single-conversation-cli.mjs";

function evidence(overrides = {}) {
  return {
    task_id: "OPS-074",
    checkpoint_id: "074-C01",
    repo: "magasincoffee/OPS-WebApp",
    commit_sha: "7ca5f478eab3a2d09b8c5400e5217bef3821579e",
    workflow_run_id: "37167270115",
    workflow_name: "Database_Migrations_CI",
    workflow_status: "in_progress",
    workflow_conclusion: null,
    failure_signature: null,
    failure_count: 0,
    last_action: "CHECK_CI",
    next_action: "CHECK_CI",
    last_progress_at: "2026-10-04T04:00:00.000Z",
    owner_required: false,
    ...overrides
  };
}

function runningControl() {
  return {
    status: "RUNNING",
    task_id: "OPS-074",
    next_task_id: null,
    check_after_seconds: 120
  };
}

function reconcile(previous, nextEvidence, sourceKind = "TASK_STATUS_CHECK") {
  const state = reconcileExternalRunState({
    previous,
    evidence: nextEvidence,
    sourceKind,
    maxRepairAttempts: 3,
    now: () => "2026-10-04T05:00:00.000Z"
  });
  return {
    ...state,
    taskControl: reconcileTaskControlWithExternalRun({
      taskControl: runningControl(),
      evidence: nextEvidence,
      externalWork: state.external_work,
      expectedTaskId: "OPS-074"
    })
  };
}

test("SC-013 external CI in_progress remains RUNNING with bounded polling", () => {
  const result = reconcile(null, evidence());
  assert.equal(result.decision, "WAIT_EXTERNAL");
  assert.equal(result.taskControl.status, "RUNNING");
  assert.equal(result.taskControl.task_id, "OPS-074");
  assert.equal(result.taskControl.check_after_seconds, 20);
  assert.equal(result.external_work.poll_attempt, 1);
  assert.equal(result.external_work.next_check_seconds, 20);
});

test("SC-013 completed success stops waiting and returns same task for verification/advance", () => {
  const result = reconcile(null, evidence({
    workflow_status: "completed",
    workflow_conclusion: "success",
    last_action: "CI_COMPLETED",
    next_action: "VERIFY_CHECKPOINT"
  }));
  assert.equal(result.decision, "VERIFY_EXTERNAL_SUCCESS");
  assert.deepEqual(result.taskControl, {
    status: "READY",
    task_id: null,
    next_task_id: "OPS-074",
    check_after_seconds: 0
  });
});

test("SC-013 completed failure enters AUTO_REPAIR and never RUNNING wait", () => {
  const failed = evidence({
    workflow_status: "completed",
    workflow_conclusion: "failure",
    failure_signature: "ops074_db_ci_permission_queue_sql",
    failure_count: 3,
    last_action: "READ_FAILURE",
    next_action: "AUTO_REPAIR"
  });
  const result = reconcile(null, failed);
  assert.equal(result.decision, "AUTO_REPAIR");
  assert.equal(result.external_work.repair_attempt, 1);
  assert.deepEqual(result.taskControl, {
    status: "READY",
    task_id: null,
    next_task_id: "OPS-074",
    check_after_seconds: 0
  });
});

test("SC-013 repeated CHECK of the same completed failed run does not poll or consume another attempt", () => {
  const failed = evidence({
    workflow_status: "completed",
    workflow_conclusion: "failure",
    failure_signature: "ops074_db_ci_permission_queue_sql",
    failure_count: 3,
    last_action: "READ_FAILURE",
    next_action: "AUTO_REPAIR"
  });
  const first = reconcile(null, failed);
  const second = reconcile(first.external_work, failed, "TASK_STATUS_CHECK");
  assert.equal(second.decision, "AUTO_REPAIR");
  assert.equal(second.external_work.repair_attempt, 1);
  assert.equal(second.taskControl.status, "READY");
  assert.equal(second.taskControl.check_after_seconds, 0);
});

test("SC-013 repeated execution with no concrete progress consumes repair budget", () => {
  const failed = evidence({
    workflow_status: "completed",
    workflow_conclusion: "failure",
    failure_signature: "ops074_db_ci_permission_queue_sql",
    failure_count: 3,
    last_action: "READ_FAILURE",
    next_action: "AUTO_REPAIR"
  });
  const first = reconcile(null, failed, "TASK_STATUS_CHECK");
  const second = reconcile(first.external_work, failed, "TASK_EXECUTION");
  assert.equal(second.external_work.repair_attempt, 2);
  assert.equal(second.taskControl.status, "READY");
});

test("SC-013 repair commit tracks the new run instead of the completed failed run", () => {
  const failed = evidence({
    workflow_status: "completed",
    workflow_conclusion: "failure",
    failure_signature: "ops074_db_ci_permission_queue_sql",
    failure_count: 3
  });
  const first = reconcile(null, failed);
  const nextRun = evidence({
    commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    workflow_run_id: "37170000001",
    workflow_status: "in_progress",
    workflow_conclusion: null,
    failure_signature: null,
    failure_count: 0,
    last_action: "COMMIT_NEW_FIX",
    next_action: "WAIT_EXTERNAL",
    last_progress_at: "2026-10-04T05:05:00.000Z"
  });
  const repaired = reconcile(first.external_work, nextRun, "TASK_EXECUTION");
  assert.equal(repaired.decision, "WAIT_EXTERNAL");
  assert.equal(repaired.external_work.commit_sha, nextRun.commit_sha);
  assert.equal(repaired.external_work.workflow_run_id, "37170000001");
  assert.equal(repaired.taskControl.status, "RUNNING");
});

test("SC-013 obsolete external run does not override terminal COMPLETE next-task advancement", () => {
  const terminal = {
    status: "COMPLETE",
    task_id: "XSTORE-019H",
    next_task_id: "XSTORE-019J",
    check_after_seconds: 0
  };
  const staleEvidence = {
    ...evidence(),
    task_id: "XSTORE-019H",
    workflow_status: "completed",
    workflow_conclusion: "success"
  };
  const reconciled = reconcileTaskControlWithExternalRun({
    taskControl: terminal,
    evidence: staleEvidence,
    externalWork: { decision: "OBSOLETE_EXTERNAL" },
    expectedTaskId: "XSTORE-019H"
  });
  assert.deepEqual(reconciled, terminal);
});

test("SC-013 obsolete external run still returns the same task when control is non-terminal", () => {
  const staleEvidence = {
    ...evidence(),
    task_id: "XSTORE-019H"
  };
  const reconciled = reconcileTaskControlWithExternalRun({
    taskControl: {
      status: "RUNNING",
      task_id: "XSTORE-019H",
      next_task_id: null,
      check_after_seconds: 120
    },
    evidence: staleEvidence,
    externalWork: { decision: "OBSOLETE_EXTERNAL" },
    expectedTaskId: "XSTORE-019H"
  });
  assert.deepEqual(reconciled, {
    status: "READY",
    task_id: null,
    next_task_id: "XSTORE-019H",
    check_after_seconds: 0
  });
});

test("SC-013 no workflow run is TRIGGER_EXTERNAL_RUN, not indefinite RUNNING", () => {
  const missing = evidence({
    workflow_run_id: null,
    workflow_status: "not_found",
    workflow_conclusion: null,
    failure_signature: "NO_RUN_DATABASE_MIGRATIONS",
    failure_count: 0,
    last_action: "LOOKUP_RUN",
    next_action: "TRIGGER_WORKFLOW"
  });
  const result = reconcile(null, missing);
  assert.equal(result.decision, "TRIGGER_EXTERNAL_RUN");
  assert.equal(result.taskControl.status, "READY");
  assert.equal(result.taskControl.next_task_id, "OPS-074");
  assert.equal(result.taskControl.check_after_seconds, 0);
});

test("SC-013 repeated identical failure blocks only after three repair attempts with evidence history", () => {
  let previous = null;
  for (let index = 1; index <= 4; index += 1) {
    const failed = evidence({
      commit_sha: String(index).repeat(40),
      workflow_run_id: String(37167270114 + index),
      workflow_status: "completed",
      workflow_conclusion: "failure",
      failure_signature: "same_failure_signature",
      failure_count: 1,
      last_action: "CI_COMPLETED",
      next_action: "AUTO_REPAIR",
      last_progress_at: `2026-10-04T05:0${Math.min(index,9)}:00.000Z`
    });
    const result = reconcile(
      previous,
      failed,
      index === 1 ? "TASK_STATUS_CHECK" : "TASK_EXECUTION"
    );
    previous = result.external_work;
    if (index <= 3) {
      assert.equal(result.decision, "AUTO_REPAIR");
      assert.equal(result.taskControl.status, "READY");
    } else {
      assert.equal(result.decision, "BLOCKED_REPAIR_LIMIT");
      assert.equal(result.taskControl.status, "BLOCKED");
    }
    assert.equal(previous.repair_attempt, index);
  }
  assert.equal(previous.history.length, 4);
  assert.deepEqual(
    previous.history.map((item) => item.workflow_run_id),
    ["37167270115", "37167270116", "37167270117", "37167270118"]
  );
});

test("SC-013 AUTO_REPAIR continuity survives Robot restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc013-external-restart-"));
  const statePath = path.join(root, "single-conversation-state.json");
  try {
    let state = await ensureSingleConversationState(statePath, {
      sourceOfTruthUrl: "https://github.com/magasincoffee/OPS-WebApp/blob/main/SOURCE_OF_TRUTH.md",
      sessionId: "external-restart",
      now: () => "2026-10-04T05:00:00.000Z"
    });
    const failed = evidence({
      workflow_status: "completed",
      workflow_conclusion: "failure",
      failure_signature: "ops074_db_ci_permission_queue_sql",
      failure_count: 3,
      last_action: "READ_FAILURE",
      next_action: "AUTO_REPAIR"
    });
    const reconciled = reconcileExternalRunState({
      previous: state.external_work,
      evidence: failed,
      sourceKind: "TASK_STATUS_CHECK",
      now: () => "2026-10-04T05:00:05.000Z"
    });
    state.external_work = reconciled.external_work;
    await writeSingleConversationState(statePath, state, {
      now: () => "2026-10-04T05:00:05.000Z"
    });

    const restarted = await readSingleConversationState(statePath);
    assert.equal(restarted.external_work.task_id, "OPS-074");
    assert.equal(restarted.external_work.checkpoint_id, "074-C01");
    assert.equal(restarted.external_work.workflow_run_id, "37167270115");
    assert.equal(restarted.external_work.repair_attempt, 1);
    assert.equal(restarted.external_work.decision, "AUTO_REPAIR");
    assert.equal(restarted.external_work.failure_signature, "ops074_db_ci_permission_queue_sql");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-013 tracked external task cannot return RUNNING without fresh external evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc013-missing-external-evidence-"));
  const statePath = path.join(root, "single-conversation-state.json");
  try {
    let state = await ensureSingleConversationState(statePath, {
      sourceOfTruthUrl: "https://github.com/magasincoffee/OPS-WebApp/blob/main/SOURCE_OF_TRUTH.md",
      sessionId: "missing-external-evidence",
      now: () => "2026-10-04T05:00:00.000Z"
    });
    const failed = evidence({
      workflow_status: "completed",
      workflow_conclusion: "failure",
      failure_signature: "ops074_db_ci_permission_queue_sql",
      failure_count: 3
    });
    state.external_work = reconcileExternalRunState({
      previous: state.external_work,
      evidence: failed,
      sourceKind: "TASK_STATUS_CHECK",
      now: () => "2026-10-04T05:00:01.000Z"
    }).external_work;
    await writeSingleConversationState(statePath, state, {
      now: () => "2026-10-04T05:00:01.000Z"
    });

    const control = await reconcileExternalRunResponse({
      statePath,
      text: "No fresh external evidence in this response.",
      taskControl: runningControl(),
      expectedTaskId: "OPS-074",
      sourceKind: "TASK_STATUS_CHECK",
      now: () => "2026-10-04T05:00:02.000Z"
    });
    assert.deepEqual(control, {
      status: "READY",
      task_id: null,
      next_task_id: "OPS-074",
      check_after_seconds: 0
    });
    const durable = await readSingleConversationState(statePath);
    assert.equal(durable.automation.phase, "AUTO_REPAIR");
    assert.equal(durable.automation.reason, "EXTERNAL_EVIDENCE_MISSING");
    assert.equal(durable.external_work.last_action, "EXTERNAL_EVIDENCE_MISSING");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("OPS-074 regression fixture: run 37167270115 completed failure becomes repair-ready with three failures", () => {
  const text = `
MAGASIN_EXTERNAL_RUN_V1
TASK_ID=OPS-074
CHECKPOINT_ID=074-C01
REPO=magasincoffee/OPS-WebApp
COMMIT_SHA=7ca5f478eab3a2d09b8c5400e5217bef3821579e
WORKFLOW_RUN_ID=37167270115
WORKFLOW_NAME=Database_Migrations_CI
WORKFLOW_STATUS=completed
WORKFLOW_CONCLUSION=failure
FAILURE_SIGNATURE=ops074_permission_queue_sql
FAILURE_COUNT=3
LAST_ACTION=READ_FAILURE
NEXT_ACTION=AUTO_REPAIR
LAST_PROGRESS_AT=2026-10-04T04:30:00.000Z
OWNER_REQUIRED=false
END_MAGASIN_EXTERNAL_RUN_V1
`;
  const parsed = parseExternalRunControl(text);
  const result = reconcile(null, parsed);
  assert.equal(parsed.workflow_status, "completed");
  assert.equal(parsed.workflow_conclusion, "failure");
  assert.equal(parsed.failure_count, 3);
  assert.equal(result.decision, "AUTO_REPAIR");
  assert.equal(result.taskControl.status, "READY");
  assert.equal(result.taskControl.next_task_id, "OPS-074");
  assert.equal(result.taskControl.check_after_seconds, 0);
});
