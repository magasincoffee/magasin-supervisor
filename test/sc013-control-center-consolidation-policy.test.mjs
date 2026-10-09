import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const matrixUrl=new URL("../docs/control-center/UNIFIED_CUTOVER_MATRIX_V1.json",import.meta.url);
const sotUrl=new URL("../SOURCE_OF_TRUTH.md",import.meta.url);

test("Owner policy is one Control Center but backend/SOT separation is preserved",async()=>{
  const m=JSON.parse(await fs.readFile(matrixUrl,"utf8"));
  assert.equal(m.schema,"MAGASIN_SINGLE_CONTROL_CENTER_MIGRATION_MATRIX_V1");
  assert.equal(m.document_only,true);
  assert.equal(m.owner_policy_approved,true);
  assert.equal(m.production_cutover_approved,false);
  assert.equal(m.ui_only_deployment.applied,true);
  assert.equal(m.ui_only_deployment.specialist_start_stop_qualified,false);
  assert.equal(m.ui_only_deployment.business_dispatch_enabled,false);
  assert.equal(m.status,"UI_ONLY_DIAGNOSTICS_APPLIED_CHILD_CONTROLS_NOT_QUALIFIED");
  assert.equal(m.host,"DESKTOP-H4A16IL");
  assert.equal(m.control_center.address,"http://127.0.0.1:8781");
  assert.equal(m.control_center.ui_count_target,1);
  assert.equal(m.control_center.lifecycle_executes_work,false);
  assert.equal(m.control_center.dispatcher_qualified,false);
  for(const flag of [
    "each_robot_manual_owner_start","default_off_after_reboot",
    "owner_stop_persists","read_only_health_can_autostart",
    "no_automatic_cross_robot_start","preserve_worker_engines",
    "preserve_data_and_credentials","legacy_interfaces_retire_only_after_acceptance",
  ])assert.equal(m.target_policy[flag],true,flag);
  assert.deepEqual(m.specialists.map(r=>r.id),["supervisor","saydi","sapo"]);
  assert.equal(new Set(m.specialists.map(r=>r.repo)).size,3);
  assert.equal(m.specialists.every(r=>r.owner_lifecycle_qualified===false),true);
  assert.equal(m.specialists.every(r=>r.dispatched_by_coordinator===false),true);
  assert.equal(m.specialists.every(r=>r.cutover_state==="NOT_QUALIFIED"),true);
  assert.equal(m.specialists.find(r=>r.id==="saydi").chapter2_min_ram_gib,2.3);
  assert.deepEqual(m.specialists.find(r=>r.id==="sapo").legacy_schedulers,[
    "MAGASIN Sapo Nightly","MAGASIN Sapo Reconcile",
  ]);
});
test("migration milestones are not accidentally promoted to deployed or DONE",async()=>{
  const m=JSON.parse(await fs.readFile(matrixUrl,"utf8"));
  assert.deepEqual(m.phases.map(p=>p.id),[
    "MIG-CC-01","MIG-CC-02","MIG-CC-03","MIG-CC-04","MIG-CC-05",
  ]);
  assert.equal(m.phases[0].state,"IN_PROGRESS");
  assert.equal(m.phases.slice(1).every(p=>p.state==="NOT_DONE"),true);
  assert.equal(m.phases.some(p=>p.state==="DONE"),false);
  assert.deepEqual(m.guardrails,[
    "NO_PRODUCTION_DEPLOYMENT","NO_SCHEDULE_MUTATION","NO_START_STOP",
    "NO_DELETE_OR_MOVE_WORKER_DATA","NO_REAL_BUSINESS_DISPATCH",
    "NO_FINANCE_WRITES","NO_CREDENTIAL_CHANGES",
  ]);
});
test("SOT explicitly supersedes separate robot control UI without touching worker/data plane",async()=>{
  const s=await fs.readFile(sotUrl,"utf8");
  assert.match(s,/Control Center is the sole operational interface/);
  assert.match(s,/supersedes any earlier plan that required the Owner to open Supervisor Control/);
  assert.match(s,/does not authorize deleting robot execution engines/);
  assert.match(s,/default-on Windows boot recovery/);
  assert.match(s,/SAYDI's authoritative/);
  assert.match(s,/MIG-CC-04: One-by-one, Owner-approved safe cutover/);
  assert.match(s,/MIG-CC-05: Acceptance and retirement/);
  assert.match(s,/production Business Executor/);
  assert.match(s,/source code, read-only inspection and isolated fixture testing/);
  assert.match(s,/SC-013 = IN PROGRESS|SC-013=IN PROGRESS|SC-013 remains.*IN PROGRESS/i);
});
