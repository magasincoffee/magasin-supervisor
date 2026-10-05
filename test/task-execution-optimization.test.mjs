import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  adaptiveExternalPollSeconds,
  classifyChangeImpact,
  deriveFailureFingerprint,
  deriveFailureRootKey,
  groupFailureEvidence,
  releaseGateDecision,
  executionOptimizationPolicyLines
} from "../src/runtime/task-execution-optimization.mjs";
import {
  reconcileExternalRunState,
  reconcileTaskControlWithExternalRun
} from "../src/runtime/external-run-control.mjs";
import {
  assertSingleConversationState,
  createSingleConversationState,
  readSingleConversationState,
  writeSingleConversationState
} from "../src/runtime/single-conversation-state.mjs";
import {
  buildSingleConversationTaskInstruction
} from "../src/runtime/single-conversation-loop.mjs";

function evidence(overrides = {}) {
  return {
    task_id: "XSTORE-019B",
    checkpoint_id: "XSTORE019B_RELEASE",
    repo: "magasincoffee/magasincoffee.github.io",
    commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    workflow_run_id: "37300000001",
    workflow_name: "XSTORE_019B_Direct_Calendar_Editing_QA",
    workflow_status: "in_progress",
    workflow_conclusion: null,
    failure_signature: null,
    failure_count: 0,
    last_action: "WAIT_EXTERNAL",
    next_action: "VERIFY_EXACT_HEAD_GATES",
    last_progress_at: "2026-10-05T10:00:00.000Z",
    owner_required: false,
    ...overrides
  };
}

function taskControl(status = "RUNNING", seconds = 300) {
  return {
    status,
    task_id: status === "RUNNING" ? "XSTORE-019B" : null,
    next_task_id: status === "READY" ? "XSTORE-019B" : null,
    check_after_seconds: seconds
  };
}

function reconcile(previous, ev, sourceKind = "TASK_STATUS_CHECK") {
  const result = reconcileExternalRunState({
    previous,
    evidence: ev,
    sourceKind,
    maxRepairAttempts: 3,
    now: () => "2026-10-05T10:30:00.000Z"
  });
  return {
    ...result,
    control: reconcileTaskControlWithExternalRun({
      taskControl: taskControl(),
      evidence: ev,
      externalWork: result.external_work,
      expectedTaskId: "XSTORE-019B"
    })
  };
}

test("1. narrow module change selects targeted QA before full regression", () => {
  const impact = classifyChangeImpact([
    "src/workforce/calendar/calendar-editor.tsx",
    "test/workforce/calendar-editor.test.mjs"
  ]);
  assert.equal(impact.fallback_broad, false);
  assert.ok(impact.matched_rules.includes("calendar-scheduling"));
  assert.ok(impact.targeted_qa.some((item) => /calendar\/scheduling/i.test(item)));

  const first = releaseGateDecision({
    targetedQaStatus: "PENDING",
    requiredRegressionStatus: "PENDING",
    exactMainStatus: "PENDING"
  });
  assert.equal(first.phase, "TARGETED_QA");
  assert.equal(first.may_complete, false);
});

test("2. related failures are grouped for one batch repair boundary", () => {
  const failures = [
    evidence({ failure_signature: "slot_layering", commit_sha: "a".repeat(40) }),
    evidence({ failure_signature: "slot_layering", commit_sha: "a".repeat(40), workflow_run_id: "37300000002" })
  ];
  const groups = groupFailureEvidence(failures);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].occurrences, 2);
  assert.equal(groups[0].commit_shas.length, 1);
});

test("3. superseding commit makes old run obsolete and stops waiting on it", () => {
  const first = reconcile(null, evidence(), "TASK_EXECUTION");
  const newer = reconcile(first.external_work, evidence({
    commit_sha: "b".repeat(40),
    workflow_run_id: "37300000003"
  }), "TASK_EXECUTION");
  assert.equal(newer.external_work.authoritative_sha, "b".repeat(40));

  const oldObservation = reconcile(newer.external_work, evidence({
    commit_sha: "a".repeat(40),
    workflow_run_id: "37300000001",
    workflow_status: "in_progress"
  }), "TASK_STATUS_CHECK");
  assert.equal(oldObservation.decision, "OBSOLETE_EXTERNAL");
  assert.equal(oldObservation.control.status, "READY");
  assert.equal(oldObservation.control.next_task_id, "XSTORE-019B");
  assert.ok(oldObservation.external_work.obsolete_runs.length >= 1);
});

test("4. queued/in-progress external job uses bounded adaptive CHECK_AFTER_SECONDS", () => {
  assert.equal(adaptiveExternalPollSeconds({ workflowStatus: "queued", pollAttempt: 1 }), 20);
  assert.equal(adaptiveExternalPollSeconds({ workflowStatus: "in_progress", pollAttempt: 2 }), 30);
  assert.equal(adaptiveExternalPollSeconds({ workflowStatus: "in_progress", pollAttempt: 3 }), 60);
  assert.equal(adaptiveExternalPollSeconds({ workflowStatus: "in_progress", pollAttempt: 4 }), 120);
  const result = reconcile(null, evidence({ workflow_status: "queued" }));
  assert.equal(result.control.status, "RUNNING");
  assert.equal(result.control.check_after_seconds, 20);
});

test("5. completed success never waits after result exists", () => {
  const result = reconcile(null, evidence({
    workflow_status: "completed",
    workflow_conclusion: "success"
  }));
  assert.equal(result.decision, "VERIFY_EXTERNAL_SUCCESS");
  assert.equal(result.control.status, "READY");
  assert.equal(result.control.check_after_seconds, 0);
});

test("6. completed failure is terminal repair evidence and is not polled again", () => {
  const failed = evidence({
    workflow_status: "completed",
    workflow_conclusion: "failure",
    failure_signature: "accessible_slot_layering",
    failure_count: 2
  });
  const first = reconcile(null, failed);
  const second = reconcile(first.external_work, failed, "TASK_STATUS_CHECK");
  assert.equal(first.decision, "AUTO_REPAIR");
  assert.equal(second.decision, "AUTO_REPAIR");
  assert.equal(second.external_work.repair_attempt, first.external_work.repair_attempt);
  assert.equal(second.control.status, "READY");
  assert.equal(second.control.check_after_seconds, 0);
});

test("7. multi-failure evidence is retained for batch repair", () => {
  const result = reconcile(null, evidence({
    workflow_status: "completed",
    workflow_conclusion: "failure",
    failure_signature: "calendar_accessibility_batch",
    failure_count: 5
  }));
  assert.equal(result.external_work.last_failure_batch_count, 5);
  assert.equal(result.external_work.last_failure_batch_signature, "calendar_accessibility_batch");
  assert.equal(result.external_work.last_failure_batch_run_id, "37300000001");
  assert.equal(result.external_work.execution_phase, "BATCH_REPAIR");
});

test("8. same root failure across new SHAs triggers loop detection", () => {
  let previous = null;
  for (let index = 0; index < 3; index += 1) {
    const sha = String(index + 1).repeat(40);
    const result = reconcile(previous, evidence({
      commit_sha: sha,
      workflow_run_id: String(37300000100 + index),
      workflow_status: "completed",
      workflow_conclusion: "failure",
      failure_signature: "same_root_slot_layering",
      failure_count: 1
    }), index === 0 ? "TASK_STATUS_CHECK" : "TASK_EXECUTION");
    previous = result.external_work;
  }
  assert.equal(previous.failure_occurrence_count, 3);
  assert.equal(previous.loop_detected, true);
  assert.equal(previous.execution_phase, "REPAIR_STRATEGY_CHANGE");
  assert.notEqual(previous.failure_fingerprint, previous.failure_root_key);
  assert.match(previous.failure_fingerprint, /333333333333/);
});

test("9. internal checkpoint evidence never replaces authoritative TASK_ID", () => {
  const result = reconcile(null, evidence({
    checkpoint_id: "C4_HARD_CONFLICT"
  }));
  assert.equal(result.external_work.task_id, "XSTORE-019B");
  assert.equal(result.external_work.checkpoint_id, "C4_HARD_CONFLICT");
  assert.equal(result.control.task_id, "XSTORE-019B");
});

test("10. final required regression and exact-main are mandatory before COMPLETE eligibility", () => {
  assert.deepEqual(
    releaseGateDecision({
      targetedQaStatus: "GREEN",
      requiredRegressionStatus: "GREEN",
      exactMainStatus: "PENDING"
    }),
    { phase: "EXACT_MAIN_VERIFY", may_complete: false }
  );
  assert.deepEqual(
    releaseGateDecision({
      targetedQaStatus: "GREEN",
      requiredRegressionStatus: "GREEN",
      exactMainStatus: "GREEN"
    }),
    { phase: "COMPLETE_ELIGIBLE", may_complete: true }
  );
});

test("11. restart restores checkpoint, authoritative SHA, gate and repair metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-throughput-restart-"));
  const statePath = path.join(root, "state.json");
  try {
    let state = createSingleConversationState({
      sourceOfTruthUrl: "https://github.com/magasincoffee/magasincoffee.github.io/blob/main/SOURCE_OF_TRUTH.md",
      sessionId: "throughput-restart"
    });
    state.external_work = reconcileExternalRunState({
      previous: state.external_work,
      evidence: evidence({
        workflow_status: "completed",
        workflow_conclusion: "failure",
        failure_signature: "restart_failure",
        failure_count: 3
      }),
      sourceKind: "TASK_STATUS_CHECK",
      now: () => "2026-10-05T10:10:00.000Z"
    }).external_work;
    await writeSingleConversationState(statePath, state, {
      now: () => "2026-10-05T10:10:01.000Z"
    });
    const restored = await readSingleConversationState(statePath);
    assert.equal(restored.external_work.task_id, "XSTORE-019B");
    assert.equal(restored.external_work.checkpoint_id, "XSTORE019B_RELEASE");
    assert.equal(restored.external_work.authoritative_sha, "a".repeat(40));
    assert.equal(restored.external_work.current_gate, "XSTORE_019B_Direct_Calendar_Editing_QA");
    assert.equal(restored.external_work.last_failure_batch_count, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("12. old runtime state without new optimization fields is upgraded safely", () => {
  const state = createSingleConversationState({
    sourceOfTruthUrl: "https://github.com/magasincoffee/magasincoffee.github.io/blob/main/SOURCE_OF_TRUTH.md",
    sessionId: "old-state"
  });
  delete state.external_work.failure_root_key;
  delete state.external_work.authoritative_sha;
  delete state.external_work.obsolete_runs;
  delete state.external_work.next_check_seconds;
  const normalized = assertSingleConversationState(state);
  assert.equal(normalized.external_work.failure_root_key, null);
  assert.equal(normalized.external_work.authoritative_sha, null);
  assert.deepEqual(normalized.external_work.obsolete_runs, []);
  assert.equal(normalized.external_work.next_check_seconds, 0);
});

test("13. chat generation replacement preserves task execution state", () => {
  const state = createSingleConversationState({
    sourceOfTruthUrl: "https://github.com/magasincoffee/magasincoffee.github.io/blob/main/SOURCE_OF_TRUTH.md",
    sessionId: "chat-restart"
  });
  state.external_work = reconcileExternalRunState({
    previous: state.external_work,
    evidence: evidence(),
    sourceKind: "TASK_EXECUTION",
    now: () => "2026-10-05T10:15:00.000Z"
  }).external_work;
  state.conversation.generation = 8;
  state.conversation.status = "ACTIVE";
  const normalized = assertSingleConversationState(state);
  assert.equal(normalized.conversation.generation, 8);
  assert.equal(normalized.external_work.task_id, "XSTORE-019B");
  assert.equal(normalized.external_work.authoritative_sha, "a".repeat(40));
});

test("14. targeted QA GREEN plus failed release regression cannot COMPLETE", () => {
  const decision = releaseGateDecision({
    targetedQaStatus: "GREEN",
    requiredRegressionStatus: "FAIL",
    exactMainStatus: "PENDING"
  });
  assert.equal(decision.phase, "REQUIRED_REGRESSION");
  assert.equal(decision.may_complete, false);
});

test("failure fingerprint includes workflow/gate/signature/module and commit SHA while root key survives SHA changes", () => {
  const a = evidence({
    checkpoint_id: "C3_DRAG_RESIZE",
    failure_signature: "pointer_overlap",
    commit_sha: "a".repeat(40)
  });
  const b = { ...a, commit_sha: "b".repeat(40) };
  assert.equal(deriveFailureRootKey(a), deriveFailureRootKey(b));
  assert.notEqual(deriveFailureFingerprint(a), deriveFailureFingerprint(b));
  assert.match(deriveFailureFingerprint(a), /XSTORE_019B_Direct_Calendar_Editing_QA/);
  assert.match(deriveFailureFingerprint(a), /C3_DRAG_RESIZE/);
  assert.match(deriveFailureFingerprint(a), /pointer_overlap/);
  assert.match(deriveFailureFingerprint(a), /aaaaaaaaaaaa/);
});

test("EXECUTE prompt keeps protocol while enforcing targeted QA, batch repair, stale-test authority and final gates", () => {
  const prompt = buildSingleConversationTaskInstruction({
    sourceOfTruthUrl: "https://github.com/magasincoffee/magasincoffee.github.io/blob/main/SOURCE_OF_TRUTH.md",
    taskId: "XSTORE-019B",
    messageId: "throughput-contract",
    checkOnly: false
  });
  assert.match(prompt, /^MAGASIN_EXECUTE_TASK_V1/m);
  assert.match(prompt, /TASK_ID=XSTORE-019B/);
  assert.match(prompt, /targeted\/impacted QA/i);
  assert.match(prompt, /group failures by root cause/i);
  assert.match(prompt, /one coherent batch commit/i);
  assert.match(prompt, /STALE TEST/i);
  assert.match(prompt, /exact-main verification/i);
  assert.match(prompt, /targeted QA never lowers those acceptance standards/i);
  assert.match(prompt, /MAGASIN_TASK_CONTROL_V1/);
  assert.match(prompt, /MAGASIN_EXTERNAL_RUN_V1/);
});

test("unknown change impact fails safe to broader regression", () => {
  const impact = classifyChangeImpact(["mystery/new-domain/unknown.xyz"]);
  assert.equal(impact.confidence, "LOW");
  assert.equal(impact.risk, "WIDE");
  assert.equal(impact.fallback_broad, true);
  assert.deepEqual(impact.targeted_qa, ["broad regression fallback"]);
});

test("optimization policy never creates new SOT task boundaries", () => {
  const policy = executionOptimizationPolicyLines().join("\n");
  assert.match(policy, /do not change MAGASIN protocol, TASK_ID, NEXT_TASK_ID, or SOT task boundaries/i);
  assert.match(policy, /Never create checkpoint IDs as new SOT tasks/i);
});
