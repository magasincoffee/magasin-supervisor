import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const src=new URL("../windows/sc013-unified-control-inventory.ps1",import.meta.url);
const testData=new URL("./fixtures/sc013-unified-inventory-fixture.json",import.meta.url);
const matrixPath=new URL("../docs/control-center/UNIFIED_CUTOVER_MATRIX_V1.json",import.meta.url);
const sotPath=new URL("../SOURCE_OF_TRUTH.md",import.meta.url);

test("read-only MIG-CC-01 never changes robot services, scheduled tasks or owner authority",async()=>{
 const s=await fs.readFile(src,"utf8");
 for(const expected of [
  "MAGASIN_SC013_UNIFIED_CONTROL_INVENTORY_V1","MIG-CC-01",
  "Get-ScheduledTask","Get-ScheduledTaskInfo",
  "Get-FileHash","Get-ItemProperty","Get-NetTCPConnection",
  "Get-Content","UNVERIFIED_REQUIRES_PROJECT_SPECIFIC_CHECKPOINT",
  "cutover_qualified = $false","business_dispatch_enabled = $false",
  "no_live_mutation = $true","WRONG_MACHINE_NO_INVENTORY",
  "NO_INVENTORY",
 ])assert.ok(s.includes(expected) || expected==="NO_INVENTORY",expected);
 assert.doesNotMatch(s,/\b(?:Start-ScheduledTask|Stop-ScheduledTask|Disable-ScheduledTask|Unregister-ScheduledTask|Set-ScheduledTask|Register-ScheduledTask|Start-Process|Stop-Process|Remove-Item|Set-ItemProperty|New-ItemProperty|Set-Content|Out-File|Copy-Item|Move-Item|Invoke-RestMethod|Invoke-WebRequest)\b/i);
 assert.doesNotMatch(s,/\.CommandLine\b|\.Arguments\b|\.Value\b/);
 assert.match(s,/SIMULATED_ONLY/);
 assert.match(s,/FIXTURE_NOT_PRODUCTION_EVIDENCE/);
});
test("fixture-only inventory cannot itself promote migrations to live",async()=>{
 const fixture=JSON.parse(await fs.readFile(testData,"utf8"));
 assert.equal(fixture.schema,"MAGASIN_SC013_UNIFIED_CONTROL_INVENTORY_FIXTURE_V1");
 assert.equal(fixture.machine,"SIMULATED_ONLY");
 assert.equal(fixture.tasks.length,4);
 assert.equal(fixture.tasks.some(x=>x.last_result===1),true);
 const matrix=JSON.parse(await fs.readFile(matrixPath,"utf8"));
 assert.equal(matrix.production_cutover_approved,false);
 assert.equal(matrix.phases[0].id,"MIG-CC-01");
 assert.equal(matrix.phases[0].state,"IN_PROGRESS");
 assert.equal(matrix.phases.slice(1).every(x=>x.state==="NOT_DONE"),true);
 assert.equal(matrix.specialists.every(x=>!x.owner_lifecycle_qualified),true);
 const sot=await fs.readFile(sotPath,"utf8");
 assert.match(sot,/MIG-CC-01 live partial inventory evidence/);
 assert.match(sot,/SUPERVISOR_STOP_LATCH/);
});
