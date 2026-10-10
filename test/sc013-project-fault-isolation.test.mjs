import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  classifySupervisorFault,
  assertNoUnsafeProjectFaultPromotion
} from "../src/runtime/project-fault-isolation.mjs";

test("SC-013 project CI failure does not become a global Supervisor fault",()=>{
 const d=assertNoUnsafeProjectFaultPromotion(classifySupervisorFault({
   projectId:"MAGASIN-WEBAPP",taskId:"XSTORE-019J",
   errorCode:"PROJECT_CI_FAILED",outboundState:"VERIFIED",
   workerRunning:true,independentMonitorAvailable:true
 }));
 assert.equal(d.category,"PROJECT_BLOCKED");
 assert.equal(d.project_blocked,true);
 assert.equal(d.supervisor_worker_running,true);
 assert.equal(d.independent_monitor_may_observe,true);
 assert.equal(d.can_dispatch_other_projects,false);
 assert.equal(d.worker_dispatch_authorized,false);
});
test("SC-013 unknown ENQUEUED request is transaction fault, not evidence of project failure",()=>{
 const d=assertNoUnsafeProjectFaultPromotion(classifySupervisorFault({
   projectId:"MAGASIN-WEBAPP",taskId:"XSTORE-019J",
   errorCode:"AMBIGUOUS_ENQUEUED_OUTCOME",outboundState:"ENQUEUED",
   workerRunning:false,independentMonitorAvailable:true
 }));
 assert.equal(d.category,"OUTBOUND_TRANSACTION_QUARANTINED");
 assert.equal(d.transaction_quarantined,true);
 assert.equal(d.may_resend_uncertain_transaction,false);
 assert.equal(d.may_clear_outbound_ledger,false);
 assert.equal(d.independent_monitor_may_observe,true);
 assert.equal(d.can_dispatch_other_projects,false);
});
test("SC-013 explicit Owner STOP always has authority and cannot be overridden",()=>{
 const d=assertNoUnsafeProjectFaultPromotion(classifySupervisorFault({
   errorCode:"PROJECT_QA_FAILED",outboundState:"NONE",
   ownerStop:true,autostartDisabled:true,workerRunning:false
 }));
 assert.equal(d.category,"OWNER_STOPPED");
 assert.equal(d.worker_dispatch_authorized,false);
 assert.equal(d.may_clear_owner_stop,false);
});
test("SC-013 malformed and false proofs never authorize cross-project dispatch",()=>{
 for(const kind of ["PREPARED","ENQUEUED","DELIVERED","RESPONSE_RUNNING","SENDING","UNKNOWN"]){
  const d=assertNoUnsafeProjectFaultPromotion(classifySupervisorFault({
    errorCode:"PROJECT_CI_FAILED",outboundState:kind,workerRunning:true
  }));
  assert.equal(d.transaction_quarantined,true);
  assert.equal(d.worker_dispatch_authorized,false);
  assert.equal(d.can_dispatch_other_projects,false);
 }
 assert.throws(()=>assertNoUnsafeProjectFaultPromotion({
   transaction_quarantined:true,may_resend_uncertain_transaction:true,
   worker_dispatch_authorized:true,can_dispatch_other_projects:false,
   may_clear_owner_stop:false,may_clear_outbound_ledger:false
 }),/unsafe transaction/);
});
test("SC-013 runtime catch emits classification rather than resetting transaction",async()=>{
 const src=await fs.readFile(new URL("../src/runtime/single-conversation-cli.mjs",import.meta.url),"utf8");
 const catchPos=src.lastIndexOf("} catch (error) {");
 const end=src.lastIndexOf("} finally {");
 assert.ok(catchPos>0 && end>catchPos);
 const body=src.slice(catchPos,end);
 assert.match(body,/SUPERVISOR_FAULT_CLASSIFICATION=/);
 assert.match(body,/classifySupervisorFault/);
 assert.doesNotMatch(body,/beginConversationGeneration|markExactOnceVerified|writeSingleConversationState|sendProtocolMessage/);
});
