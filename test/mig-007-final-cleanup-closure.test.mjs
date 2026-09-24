import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const closure = JSON.parse(
  fs.readFileSync(new URL("../docs/MIG_007_FINAL_CLEANUP_CLOSURE.json", import.meta.url), "utf8")
);
const evidence = fs.readFileSync(
  new URL("../docs/MIG_007_FINAL_CLEANUP_EVIDENCE.md", import.meta.url),
  "utf8"
);

test("MIG-007 closure candidate is backed by exact merged Business OS cleanup", () => {
  assert.equal(closure.schema_version, "supervisor-mig007-final-cleanup-closure.v1");
  assert.equal(closure.task_id, "MIG-007");
  assert.equal(closure.execution_task_id, "MIG-007-EXECUTION-FINAL-CLEANUP");
  assert.equal(closure.business_os_cleanup.pull_request, 291);
  assert.equal(closure.business_os_cleanup.merge_sha, "1919cbab4e05cb5fc4af07b5df6b62a9f029c05c");
  assert.equal(closure.business_os_cleanup.deleted_authorized_file_count, 137);
  assert.equal(closure.business_os_cleanup.residual_embedded_supervisor_files, 0);
  assert.equal(closure.business_os_cleanup.residual_supervisor_workflows, 0);
  assert.equal(closure.business_os_cleanup.residual_supervisor_scripts, 0);
  assert.equal(closure.business_os_cleanup.retained_business_os_file_count, 5);
  assert.equal(closure.business_os_cleanup.rollback_window, "CLOSED");
});

test("Business OS post-merge validation is fully green", () => {
  assert.equal(closure.business_os_validation.preclosure.conclusion, "SUCCESS");
  assert.equal(closure.business_os_validation.final_state.conclusion, "SUCCESS");
  assert.equal(closure.business_os_validation.post_merge_contract.conclusion, "SUCCESS");
  assert.equal(closure.business_os_validation.post_merge_pages_source.conclusion, "SUCCESS");
  assert.equal(closure.business_os_validation.post_merge_pages_deployment.conclusion, "SUCCESS");
});

test("MIG-006 and RBT-009 remain complete and released", () => {
  assert.equal(closure.predecessors.mig005, "COMPLETE");
  assert.equal(closure.predecessors.mig006, "COMPLETE_QUALIFIED");
  assert.equal(closure.predecessors.rbt009, "COMPLETE_RELEASED");
  assert.equal(closure.predecessors.rbt009_tier_b_480m, "PASS");
});

test("project adapter boundary remains explicit and fail-closed", () => {
  const adapter = closure.project_adapter_boundary;
  assert.equal(adapter.schema, "supervisor-project-adapter.v1");
  assert.equal(adapter.explicit_source_required, true);
  assert.equal(adapter.missing_source_fails_closed, true);
  assert.equal(adapter.default_business_os_repository, false);
  assert.equal(adapter.default_project_state_path, false);
});

test("closure candidate records no prohibited production mutation", () => {
  for (const [key, value] of Object.entries(closure.safety)) {
    assert.equal(value, false, key);
  }
  assert.equal(closure.rollback_window, "CLOSED");
  assert.equal(closure.next_migration_task, null);
  assert.equal(closure.next_migration_task_state, "NO_ADDITIONAL_MIGRATION_TASK_DEFINED");
});

test("MIG-007 and the independent-repository migration are complete after target validation", () => {
  assert.equal(closure.status, "COMPLETE");
  assert.equal(closure.complete, true);
  assert.equal(closure.source_of_truth_role, "CURRENT_CANONICAL_CLOSURE");
  assert.equal(closure.target_closure_validation.status, "PASS");
  assert.equal(closure.target_closure_validation.pull_request, 14);
  assert.equal(closure.target_closure_validation.checks.filter((check) => check.conclusion === "SUCCESS").length, 4);
  assert.equal(closure.migration_complete, true);
  assert.equal(closure.migration_final_state, "MAGASIN_SUPERVISOR_INDEPENDENT_REPOSITORY_V1_COMPLETE");
  assert.match(evidence, /COMPLETE \/ READY FOR CANONICAL MERGE/);
});
