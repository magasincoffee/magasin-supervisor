import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const ui=new URL("../src/control-center/web/app.js",import.meta.url);
const server=new URL("../src/control-center/server.py",import.meta.url);
const risk=new URL("../src/control-center/cutover_preflight.py",import.meta.url);
const matrix=new URL("../docs/control-center/UNIFIED_CUTOVER_MATRIX_V1.json",import.meta.url);

test("all three robots' pre-cutover status is integrated into the ONE existing overview, not external windows",async()=>{
  const s=await fs.readFile(ui,"utf8");
  assert.match(s,/const migrationPanel=/);
  assert.match(s,/MIG-CC-01/);
  assert.match(s,/\{migrationPanel\(\)\}/);
  assert.match(s,/\{r\.id==="coordinator"\?migrationPanel\(\):""\}/);
  for(const t of ["supervisor","saydi","sapo"])assert.match(s,new RegExp('"'+t+'"'));
  assert.match(s,/esc\(migrationWarnings\[k\]\|\|k\)/);
  assert.match(s,/esc\(p\.status/);
  assert.match(s,/Không công bố đường dẫn xuất dữ liệu SAPO/);
  assert.doesNotMatch(s,/START_SAPO|START_SAYDI|\/api\/sapo\/control|\/api\/saydi\/control/);
});
test("backend risk API does not create an actuator or expose raw SAPO state",async()=>{
  const s=await fs.readFile(server,"utf8");
  assert.match(s,/def migration_preflight\(\):/);
  assert.match(s,/import cutover_preflight/);
  assert.match(s,/sapo_state_path=SAPO \/ "data" \/ "state\.json"/);
  assert.match(s,/supervisor_stop=\(SUP \/ "STOP"\)\.exists\(\)/);
  assert.match(s,/migration_preflight": migration_preflight\(\)/);
  assert.match(s,/business_dispatch_enabled": False/);
  assert.doesNotMatch(s,/\/api\/(?:sapo|saydi)\/control/);
});
test("financial state and diagnostic content are never returned verbatim",async()=>{
  const s=await fs.readFile(risk,"utf8");
  assert.match(s,/_log_classes/);
  assert.match(s,/MAX_LOG_BYTES = 32768/);
  assert.match(s,/pending_export_evidence/);
  assert.match(s,/business_dispatch_enabled": False/);
  assert.match(s,/cutover_allowed": False/);
  assert.doesNotMatch(s,/subprocess|Popen|os\.system|urlopen|Invoke-WebRequest/);
  assert.doesNotMatch(s,/["\u0027](?:export_url|raw_path)["\u0027]\s*:/);
});
test("source preview cannot promote a production cutover",async()=>{
  const m=JSON.parse(await fs.readFile(matrix,"utf8"));
  assert.equal(m.production_cutover_approved,false);
  assert.equal(m.ui_only_deployment.applied,true);
  assert.equal(m.ui_only_deployment.disabled_saydi_control_http,405);
  assert.equal(m.status,"UI_ONLY_DIAGNOSTICS_APPLIED_CHILD_CONTROLS_NOT_QUALIFIED");
  assert.equal(m.phases[0].state,"IN_PROGRESS");
  assert.equal(m.phases[1].state,"NOT_DONE");
  assert.equal(m.specialists.every(x=>x.cutover_state==="NOT_QUALIFIED"),true);
});
