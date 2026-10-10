import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const helper=fileURLToPath(new URL("../windows/project-fault-containment.ps1",import.meta.url));
const wrapper=fileURLToPath(new URL("../windows/run-supervisor.ps1",import.meta.url));
const ps=(s)=>"'" + s.replace(/'/g,"''") + "'";
const onWindows=process.platform==="win32";

test("SC-013 project hold keeps the wrapper, preserves STOP and forbids task replay",async()=>{
 const src=await fs.readFile(wrapper,"utf8");
 const helperCode=await fs.readFile(helper,"utf8");
 assert.match(src,/project-fault-containment\.ps1/);
 assert.match(src,/SINGLE_CONVERSATION_BLOCKED_PAUSE=True/);
 assert.match(src,/Invoke-SupervisorProjectHold/);
 assert.match(src,/-StopFile \$stop/);
 assert.match(src,/-AutostartDisabledFile \$autostartDisabled/);
 assert.match(src,/automation\.status -in @\('DONE','BLOCKED'\)/);
 assert.match(helperCode,/Get-SupervisorProjectHoldClassification/);
 assert.match(helperCode,/while \(-not \(Test-Path \$StopFile\) -and -not \(Test-Path \$AutostartDisabledFile\)\)/);
 assert.match(helperCode,/mode = 'MONITORING_ONLY'/);
 assert.match(helperCode,/pending_transaction_replay_allowed = \$false/);
 assert.match(helperCode,/active_project_execution_allowed = \$false/);
 assert.match(helperCode,/project_switch_allowed = \$false/);
 assert.match(helperCode,/STATE_CHANGED_REARM_REQUIRED/);
 for(const forbidden of [/Stop-Process/,/Start-Process/,/sendComposerInstruction/,/prepareExactOnceOutbound/,/Remove-Item.*\$StopFile/]){
  assert.doesNotMatch(helperCode,forbidden);
 }
});

test("SC-013 separates project STOP from ambiguous transport and fail-closes project switches",{
 skip:!onWindows
},()=>{
 const cases=[
  {automation:{status:"BLOCKED",reason:"OWNER_INPUT_REQUIRED:XSTORE-019J"},outbound:{state:"VERIFIED",kind:"TASK_STATUS_CHECK",task_id:"XSTORE-019J"}},
  {automation:{status:"BLOCKED",reason:"AMBIGUOUS_ENQUEUED_OUTCOME"},outbound:{state:"ENQUEUED",kind:"TASK_STATUS_CHECK",task_id:"XSTORE-019J"}},
  {automation:{status:"BLOCKED",reason:"OWNER_INPUT_REQUIRED:XSTORE-019J"},outbound:{state:"PREPARED",kind:"TASK_EXECUTION",task_id:"XSTORE-019J"}},
  {automation:{status:"BLOCKED",reason:"TECHNICAL_ISSUE"},outbound:{state:"VERIFIED",kind:"TASK_EXECUTION",task_id:"XSTORE-019J"}},
  {automation:{status:"DONE",reason:"PROJECT_DONE"},outbound:{state:"VERIFIED",kind:"TASK_EXECUTION",task_id:"XSTORE-019J"}},
  {automation:{status:"RUNNING",reason:null},outbound:{state:"VERIFIED",kind:"TASK_EXECUTION",task_id:"XSTORE-019J"}}
 ];
 const command=". "+ps(helper)+"; $items="+ps(JSON.stringify(cases))+
   " | ConvertFrom-Json; @($items|ForEach-Object{Get-SupervisorProjectHoldClassification -State $_})|ConvertTo-Json -Depth 8 -Compress";
 const child=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],{encoding:"utf8",timeout:15000});
 assert.equal(child.status,0,child.stderr);
 const got=JSON.parse(child.stdout);
 assert.deepEqual(got.map(x=>x?.scope||null),[
  "PROJECT_WAIT_OWNER","TRANSACTION_OUTCOME_UNRESOLVED",
  "TRANSACTION_OUTCOME_UNRESOLVED","SUPERVISOR_TECHNICAL_HOLD",
  "PROJECT_COMPLETE",null
 ]);
 for(const entry of got.filter(Boolean)){
  assert.equal(entry.pending_transaction_replay_allowed,false);
  assert.equal(entry.active_project_execution_allowed,false);
  assert.equal(entry.project_switch_allowed,false);
  assert.equal(entry.requires_explicit_owner_rearm,true);
 }
});
