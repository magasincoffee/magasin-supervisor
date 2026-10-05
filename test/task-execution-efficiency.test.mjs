import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { adaptiveExternalPollSeconds, deriveFailureFingerprint } from "../src/runtime/task-execution-optimization.mjs";
import { reconcileExternalRunState, reconcileTaskControlWithExternalRun } from "../src/runtime/external-run-control.mjs";
import { buildSingleConversationTaskInstruction } from "../src/runtime/single-conversation-loop.mjs";
import { ensureSingleConversationState, readSingleConversationState, writeSingleConversationState } from "../src/runtime/single-conversation-state.mjs";

function ev(overrides = {}) {
  return {
    task_id: "XSTORE-019B",
    checkpoint_id: "C3",
    repo: "magasincoffee/magasincoffee.github.io",
    commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    workflow_run_id: "37300000001",
    workflow_name: "XSTORE_019B_Direct_Calendar_Editing_QA",
    workflow_status: "in_progress",
    workflow_conclusion: null,
    failure_signature: null,
    failure_count: 0,
    last_action: "WAIT_EXTERNAL",
    next_action: "VERIFY",
    last_progress_at: "2026-10-05T10:00:00.000Z",
    owner_required: false,
    ...overrides
  };
}

function reconcile(previous, evidence, sourceKind = "TASK_STATUS_CHECK", control = null) {
  const r = reconcileExternalRunState({ previous, evidence, sourceKind, now: () => "2026-10-05T10:10:00.000Z" });
  const c = reconcileTaskControlWithExternalRun({
    taskControl: control || { status: "RUNNING", task_id: "XSTORE-019B", next_task_id: null, check_after_seconds: 120 },
    evidence,
    externalWork: r.external_work,
    expectedTaskId: "XSTORE-019B"
  });
  return { ...r, taskControl: c };
}

test("targeted QA policy precedes required full regression in EXECUTE", () => {
  const message = buildSingleConversationTaskInstruction({ sourceOfTruthUrl: "https://example.com/SOT.md", taskId: "XSTORE-019B", messageId: "m-targeted" });
  assert.ok(message.indexOf("narrowest task-specific/impacted QA") >= 0);
  assert.ok(message.indexOf("required release/full regression") > message.indexOf("narrowest task-specific/impacted QA"));
});

test("batch repair policy prevents CI cycle per file", () => {
  const message = buildSingleConversationTaskInstruction({ sourceOfTruthUrl: "https://example.com/SOT.md", taskId: "XSTORE-019B", messageId: "m-batch" });
  assert.match(message, /collect all currently available failing jobs\/steps\/log evidence/i);
  assert.match(message, /group failures by root cause/i);
  assert.match(message, /one coherent batch commit/i);
  assert.match(message, /Do not create a commit merely because one file\/update operation completed/i);
});

test("commit B supersedes A and old active run becomes obsolete", () => {
  const first = reconcile(null, ev(), "TASK_EXECUTION");
  const newer = reconcile(first.external_work, ev({ commit_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", workflow_run_id: "37300000002" }), "TASK_EXECUTION");
  const obsolete = reconcile(newer.external_work, ev({ commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", workflow_run_id: "37300000001" }), "TASK_STATUS_CHECK");
  assert.equal(newer.external_work.authoritative_sha, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(obsolete.decision, "OBSOLETE_EXTERNAL");
  assert.equal(obsolete.external_work.run_authority, "OBSOLETE");
  assert.equal(obsolete.taskControl.status, "READY");
  assert.equal(obsolete.taskControl.next_task_id, "XSTORE-019B");
});

test("external active polling follows 20 30 60 120 and preserves shorter request", () => {
  assert.equal(adaptiveExternalPollSeconds({workflowStatus:"queued",pollAttempt:1,requestedSeconds:120}), 20);
  assert.equal(adaptiveExternalPollSeconds({workflowStatus:"in_progress",pollAttempt:2,requestedSeconds:120}), 30);
  assert.equal(adaptiveExternalPollSeconds({workflowStatus:"in_progress",pollAttempt:3,requestedSeconds:120}), 60);
  assert.equal(adaptiveExternalPollSeconds({workflowStatus:"in_progress",pollAttempt:4,requestedSeconds:120}), 120);
  assert.equal(adaptiveExternalPollSeconds({workflowStatus:"in_progress",pollAttempt:4,requestedSeconds:45}), 45);
});

test("completed success does not wait", () => {
  const result = reconcile(null, ev({workflow_status:"completed",workflow_conclusion:"success"}));
  assert.equal(result.decision, "VERIFY_EXTERNAL_SUCCESS");
  assert.equal(result.taskControl.status, "READY");
  assert.equal(result.taskControl.check_after_seconds, 0);
});

test("completed failure is never polled again", () => {
  const failed = ev({workflow_status:"completed",workflow_conclusion:"failure",failure_signature:"calendar_slot_layering",failure_count:3});
  const first = reconcile(null, failed);
  const second = reconcile(first.external_work, failed);
  assert.equal(first.decision, "AUTO_REPAIR");
  assert.equal(second.decision, "AUTO_REPAIR");
  assert.equal(second.external_work.repair_attempt, 1);
  assert.equal(second.taskControl.check_after_seconds, 0);
});

test("multiple failures are retained as batch repair evidence", () => {
  const result = reconcile(null, ev({workflow_status:"completed",workflow_conclusion:"failure",failure_signature:"calendar_accessibility_batch",failure_count:5}));
  assert.equal(result.external_work.last_failure_batch_count, 5);
  assert.equal(result.external_work.last_failure_batch_signature, "calendar_accessibility_batch");
  assert.equal(result.external_work.last_failure_batch_run_id, "37300000001");
});

test("same root failure across candidates activates loop detector", () => {
  let previous = null;
  for (let i=1;i<=3;i+=1) {
    previous = reconcile(previous, ev({
      commit_sha:String(i).repeat(40),
      workflow_run_id:String(37300000000+i),
      workflow_status:"completed",
      workflow_conclusion:"failure",
      failure_signature:"same_root_failure",
      failure_count:2
    }), i === 1 ? "TASK_STATUS_CHECK" : "TASK_EXECUTION").external_work;
  }
  assert.equal(previous.failure_occurrence_count, 3);
  assert.equal(previous.loop_detected, true);
  assert.equal(previous.execution_phase, "REPAIR_STRATEGY_CHANGE");
  assert.equal(previous.next_action, "CHANGE_REPAIR_STRATEGY");
});

test("internal checkpoint never changes TASK_ID", () => {
  const result = reconcile(null, ev({checkpoint_id:"C4_HARD_CONFLICT"}));
  assert.equal(result.external_work.task_id, "XSTORE-019B");
  assert.equal(result.external_work.checkpoint_id, "C4_HARD_CONFLICT");
  assert.equal(result.taskControl.task_id, "XSTORE-019B");
});

test("targeted QA cannot bypass failed final regression", () => {
  const result = reconcile(null, ev({workflow_name:"Release_Regression",workflow_status:"completed",workflow_conclusion:"failure",failure_signature:"release_regression_failed",failure_count:1}));
  assert.equal(result.taskControl.status, "READY");
  assert.notEqual(result.taskControl.status, "COMPLETE");
  assert.equal(result.external_work.release_regression_required, true);
});

test("restart restores checkpoint SHA gate and fingerprint", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "efficiency-restart-"));
  const statePath = path.join(root, "state.json");
  try {
    const state = await ensureSingleConversationState(statePath, {sourceOfTruthUrl:"https://example.com/SOT.md",sessionId:"eff-restart"});
    state.external_work = reconcile(null, ev({workflow_status:"completed",workflow_conclusion:"failure",failure_signature:"persist_me",failure_count:2})).external_work;
    await writeSingleConversationState(statePath,state);
    const restored = await readSingleConversationState(statePath);
    assert.equal(restored.external_work.checkpoint_id,"C3");
    assert.equal(restored.external_work.authoritative_sha,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(restored.external_work.current_gate,"XSTORE_019B_Direct_Calendar_Editing_QA");
    assert.match(restored.external_work.failure_fingerprint,/persist_me/);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test("old state without new fields uses safe defaults", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "efficiency-old-"));
  const statePath = path.join(root, "state.json");
  try {
    const state = await ensureSingleConversationState(statePath, {sourceOfTruthUrl:"https://example.com/SOT.md",sessionId:"eff-old"});
    for (const key of ["authoritative_sha","run_authority","execution_phase","current_gate","gate_started_at","last_result","poll_attempt","next_check_seconds","failure_fingerprint","failure_occurrence_count","loop_detected","last_failure_batch_count","last_failure_batch_signature","last_failure_batch_run_id","last_failure_batch_commit_sha","targeted_qa_required","release_regression_required","obsolete_runs"]) delete state.external_work[key];
    await fs.writeFile(statePath, JSON.stringify(state,null,2));
    const restored = await readSingleConversationState(statePath);
    assert.equal(restored.external_work.run_authority,"UNKNOWN");
    assert.equal(restored.external_work.poll_attempt,0);
    assert.equal(restored.external_work.release_regression_required,true);
    assert.deepEqual(restored.external_work.obsolete_runs,[]);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test("new chat generation does not erase task state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "efficiency-chat-"));
  const statePath = path.join(root, "state.json");
  try {
    const state = await ensureSingleConversationState(statePath, {sourceOfTruthUrl:"https://example.com/SOT.md",sessionId:"eff-chat"});
    state.external_work = reconcile(null, ev()).external_work;
    state.conversation.generation = 7;
    await writeSingleConversationState(statePath,state);
    const restored = await readSingleConversationState(statePath);
    assert.equal(restored.conversation.generation,7);
    assert.equal(restored.external_work.task_id,"XSTORE-019B");
    assert.equal(restored.external_work.authoritative_sha,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test("failure fingerprint carries workflow gate signature and module evidence", () => {
  const fp = deriveFailureFingerprint(ev({checkpoint_id:"C3_DRAG_RESIZE",failure_signature:"pointer_layering"}));
  assert.match(fp,/XSTORE_019B_Direct_Calendar_Editing_QA/);
  assert.match(fp,/C3_DRAG_RESIZE/);
  assert.match(fp,/pointer_layering/);
});

test("legacy and optimized prompts keep the same machine protocol header", () => {
  const legacy = buildSingleConversationTaskInstruction({sourceOfTruthUrl:"https://example.com/SOT.md",taskId:"XSTORE-019B",messageId:"legacy",optimizationPolicy:false});
  const current = buildSingleConversationTaskInstruction({sourceOfTruthUrl:"https://example.com/SOT.md",taskId:"XSTORE-019B",messageId:"legacy",optimizationPolicy:true});
  assert.doesNotMatch(legacy,/Execution optimization policy/);
  assert.match(current,/Execution optimization policy/);
  assert.match(legacy,/MAGASIN_EXECUTE_TASK_V1/);
  assert.match(current,/MAGASIN_EXECUTE_TASK_V1/);
});
