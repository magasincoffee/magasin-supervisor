import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../docs/MIG_007_AUTHORITY_MANIFEST.json", import.meta.url), "utf8")
);
const plan = fs.readFileSync(
  new URL("../docs/MIG_007_FINAL_CLEANUP_PLAN.md", import.meta.url),
  "utf8"
);
const evidence = fs.readFileSync(
  new URL("../docs/MIG_007_AUTHORITY_EVIDENCE.md", import.meta.url),
  "utf8"
);

test("MIG-007 authority is ready but explicitly not executed or complete", () => {
  assert.equal(manifest.schema_version, "supervisor-mig007-authority.v1");
  assert.equal(manifest.authority_task_id, "MIG-007-AUTHORITY-CLOSURE");
  assert.equal(manifest.execution_task_id, "MIG-007-EXECUTION-FINAL-CLEANUP");
  assert.equal(manifest.status, "AUTHORIZED_READY_FOR_EXECUTION");
  assert.equal(manifest.execution_status, "NOT_STARTED");
  assert.equal(manifest.complete, false);
  assert.equal(manifest.next_task, "MIG-007-EXECUTION-FINAL-CLEANUP");
  assert.equal(manifest.next_task_state, "READY_NOT_STARTED");
  assert.match(plan, /AUTHORIZED \/ READY FOR EXECUTION \/ NOT EXECUTED/);
  assert.match(evidence, /AUTHORIZED_READY_FOR_EXECUTION \/ NOT_STARTED \/ NOT_COMPLETE/);
});

test("MIG-006 and RBT-009 dependencies are satisfied by exact existing evidence", () => {
  const d = manifest.dependency_evidence;
  assert.equal(d.mig005_production_cutover, true);
  assert.equal(d.mig006_status, "COMPLETE");
  assert.equal(d.mig006_qualification, "QUALIFIED");
  assert.equal(d.rbt009_status, "COMPLETE_RELEASED");
  assert.equal(d.rbt009_tier_b_480m, "PASS");
  assert.equal(d.workflow_run_id, 35860156388);
  assert.equal(d.tier_b_job_id, 107180300345);
  assert.equal(d.duration_seconds, 28843);
  assert.equal(d.sample_count, 240);
});

test("cleanup inventory is exactly the revalidated 137-path frozen surface", () => {
  const i = manifest.cleanup_inventory;
  assert.equal(i.frozen_managed_file_count, 137);
  assert.equal(i.current_file_count, 137);
  assert.equal(i.path_set_equal_to_frozen_map, true);
  assert.deepEqual(i.missing_paths, []);
  assert.deepEqual(i.extra_paths, []);
  assert.equal(i.group_counts.embedded_supervisor, 123);
  assert.equal(i.group_counts.supervisor_workflows, 8);
  assert.equal(i.group_counts.supervisor_scripts, 6);
  assert.equal(i.delete_paths.length, 137);
  assert.equal(new Set(i.delete_paths).size, 137);
  assert.equal(i.delete_paths.filter((p) => p.startsWith("08_INTEGRATIONS/supervisor/")).length, 123);
  assert.equal(i.delete_paths.filter((p) => /^\.github\/workflows\/supervisor-.*\.ya?ml$/i.test(p)).length, 8);
  assert.equal(i.delete_paths.filter((p) => /^\.github\/scripts\/supervisor-/i.test(p)).length, 6);
});

test("Business OS retained boundary is explicit and not part of delete inventory", () => {
  const retained = new Set(manifest.retained_business_os_files);
  for (const path of [
    "01_DOCS/MAGASIN/00_PROJECT_STATE.json",
    "01_DOCS/MAGASIN/00_TASK_QUEUE.md",
    "01_DOCS/MAGASIN/00_SUPERVISOR_THREE_LANE_ARCHITECTURE.md",
    "01_DOCS/MAGASIN/00_MAGASIN_LANE_DIRECTIVE_V1_PROTOCOL.md",
    "01_DOCS/MAGASIN/08_AUTONOMY/SUPERVISOR_REPOSITORY_MIGRATION_V1.md",
  ]) {
    assert.equal(retained.has(path), true, path);
    assert.equal(manifest.cleanup_inventory.delete_paths.includes(path), false, path);
  }
  assert.equal(manifest.retained_reference_reconciliation.length, 3);
});

test("project adapter remains explicit and project-neutral", () => {
  const a = manifest.project_adapter_boundary;
  assert.equal(a.schema, "supervisor-project-adapter.v1");
  assert.equal(a.explicit_source_required, true);
  assert.equal(a.missing_source_fails_closed, true);
  assert.equal(a.default_business_os_repository, false);
  assert.equal(a.default_project_state_path, false);
});

test("authority task records zero cleanup or production mutation", () => {
  const s = manifest.authority_safety;
  for (const [key, value] of Object.entries(s)) {
    assert.equal(value, false, key);
  }
  assert.equal(manifest.execution_preflight.rescan_required, true);
  assert.equal(manifest.execution_preflight.fail_closed_on_inventory_drift, true);
  assert.equal(manifest.execution_preflight.scope_expansion_requires_new_authority, true);
});

test("rollback closure is code-surface only and preserves historical/local recovery boundaries", () => {
  const r = manifest.rollback_boundary;
  assert.equal(r.close_active_source_code_rollback_window_on_execution, true);
  assert.equal(r.preserve_git_history, true);
  assert.equal(r.delete_machine_local_rollback_metadata, false);
  assert.equal(r.local_recovery_material_requires_separate_authority, true);
});
