import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
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
   " | ConvertFrom-Json; $results=@(); foreach($item in $items){$x=Get-SupervisorProjectHoldClassification -State $item; if($null -eq $x){$results+=@{scope='NONE'}} else {$results+=$x}}; $results|ConvertTo-Json -Depth 8 -Compress";
 const child=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],{encoding:"utf8",timeout:15000});
 assert.equal(child.status,0,child.stderr);
 const got=JSON.parse(child.stdout);
 assert.deepEqual(got.map(x=>x?.scope||null),[
  "PROJECT_WAIT_OWNER","TRANSACTION_OUTCOME_UNRESOLVED",
  "TRANSACTION_OUTCOME_UNRESOLVED","SUPERVISOR_TECHNICAL_HOLD",
  "PROJECT_COMPLETE","NONE"
 ]);
 for(const entry of got.filter(x=>x.scope!=="NONE")){
  assert.equal(entry.pending_transaction_replay_allowed,false);
  assert.equal(entry.active_project_execution_allowed,false);
  assert.equal(entry.project_switch_allowed,false);
  assert.equal(entry.requires_explicit_owner_rearm,true);
 }
});

test("SC-013 active read-only hold respects a later Owner STOP and never changes the outbound ledger",{
 skip:!onWindows,timeout:20000
},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"sc013-project-hold-"));
 const statePath=path.join(dir,"state.json");
 const holdPath=path.join(dir,"hold.json");
 const stopPath=path.join(dir,"STOP");
 const disabledPath=path.join(dir,"AUTOSTART_DISABLED");
 const heartbeatPath=path.join(dir,"sc013-independent-heartbeat.json");
 const original=JSON.stringify({
  automation:{status:"BLOCKED",reason:"AMBIGUOUS_ENQUEUED_OUTCOME"},
  outbound:{state:"ENQUEUED",kind:"TASK_STATUS_CHECK",task_id:"XSTORE-019J",
    message_id:"f3b69f53-d2b0-4a91-8ab7-5403807254df"}
 });
 await fs.writeFile(statePath,original);
 const command=". "+ps(helper)+"; Invoke-SupervisorProjectHold"+
  " -StateFile "+ps(statePath)+" -HoldFile "+ps(holdPath)+
  " -StopFile "+ps(stopPath)+" -AutostartDisabledFile "+ps(disabledPath)+
  " -CoordinatorHeartbeatFile "+ps(heartbeatPath)+" -PollSeconds 5";
 let child;
 try{
  child=spawn("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],{
   stdio:["ignore","pipe","pipe"]
  });
  let observed=null;
  const limit=Date.now()+6000;
  while(Date.now()<limit){
   observed=await fs.readFile(holdPath,"utf8").then(JSON.parse).catch(()=>null);
   if(observed)break;
   await new Promise(resolve=>setTimeout(resolve,150));
  }
  assert.ok(observed,"monitor-only heartbeat should be visible");
  assert.equal(observed.scope,"TRANSACTION_OUTCOME_UNRESOLVED");
  assert.equal(observed.mode,"MONITORING_ONLY");
  assert.equal(observed.pending_transaction_replay_allowed,false);
  assert.equal(observed.project_switch_allowed,false);
  assert.equal(await fs.readFile(statePath,"utf8"),original);
  await fs.writeFile(stopPath,"OWNER_STOP");
  await Promise.race([
   new Promise((resolve,reject)=>{
    child.once("exit",(code,signal)=>
      code===0?resolve():reject(new Error("unexpected observer exit: "+code+" "+signal)));
    child.once("error",reject);
   }),
   new Promise((_,reject)=>setTimeout(()=>reject(new Error("Owner STOP ignored")),10000))
  ]);
  assert.equal(await fs.readFile(statePath,"utf8"),original);
  assert.equal(await fs.readFile(stopPath,"utf8"),"OWNER_STOP");
 }finally{
  if(child && child.exitCode===null)child.kill();
  await fs.rm(dir,{recursive:true,force:true});
 }
});
