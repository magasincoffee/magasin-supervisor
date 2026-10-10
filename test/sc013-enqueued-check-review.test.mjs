import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { classifyEnqueuedCheckForRecoveryReview } from "../src/runtime/single-conversation-cli.mjs";

const uuid="f3b69f53-d2b0-4a91-8ab7-5403807254df";
const sot="https://github.com/magasincoffee/magasincoffee.github.io/blob/main/01_DOCS/MAGASIN/05_SYSTEM/WORKFORCE_CROSS_STORE_SCHEDULING_TEMP_SOURCE_OF_TRUTH.md";
const runtime="chat:fixture-only";
const idle={
  conversationPath:true,responseRunning:false,assistantBusy:false,
  composerReady:true,composerTextReadable:true,composerHasText:false,
  hasContinueControl:false,hasRetryControl:false,loginRequired:false,
  hasCaptcha:false,hasNetworkError:false,hasTransientError:false,
  conversationFull:false,conversationMissing:false,conversationAccessDenied:false
};
const user={turn_id:"prior-user",text:"MAGASIN_SINGLE_CONVERSATION_BOOTSTRAP_V1\nSOT="+sot};
const assistant={turn_id:"prior-assistant",text:"MAGASIN_TASK_CONTROL_V1\nSTATUS=READY\nNEXT_TASK_ID=XSTORE-019J"};
const fixture=()=>({
  state:{
    conversation:{status:"ACTIVE",runtime_id:runtime},
    source_of_truth:{url:sot},
    automation:{status:"BLOCKED",reason:"AMBIGUOUS_ENQUEUED_OUTCOME"},
    outbound:{
      state:"ENQUEUED",kind:"TASK_STATUS_CHECK",
      task_id:"XSTORE-019J",message_id:uuid,message_digest:"existing-digest",
      baseline_user_turn_id:null,retry_count:0,
      enqueued_at:"2026-10-10T04:30:00.000Z"
    }
  },
  firstRuntimeId:runtime,secondRuntimeId:runtime,
  firstSnapshot:{...idle},secondSnapshot:{...idle},
  firstUser:{...user},secondUser:{...user},
  firstAssistant:{...assistant},secondAssistant:{...assistant},
  matchingUser:{confirmed:false},assistantCorrelation:{confirmed:false},
  nowMs:Date.parse("2026-10-10T04:35:00.000Z")
});
test("legacy pending CHECK yields review evidence, not recovery authority",()=>{
 const x=classifyEnqueuedCheckForRecoveryReview(fixture());
 assert.equal(x.classification,"REVIEW_ONLY_LEGACY_ENQUEUED_CHECK");
 assert.equal(x.message_id,uuid);
 assert.equal(x.may_replay_pending_message,false);
 assert.equal(x.may_mutate_outbound_state,false);
 assert.equal(x.may_clear_owner_stop,false);
 assert.equal(x.requires_owner_review,true);
});
test("legacy pending CHECK rejects missing, changing, spoofed or active evidence",()=>{
 const mutations=[
  a=>a.state.outbound.kind="TASK_EXECUTION",
  a=>a.state.outbound.state="DELIVERED",
  a=>a.state.outbound.baseline_user_turn_id="u",
  a=>a.state.outbound.retry_count=1,
  a=>a.state.outbound.task_id="",
  a=>a.state.outbound.message_digest="",
  a=>a.state.outbound.enqueued_at="",
  a=>a.nowMs=Date.parse("2026-10-10T04:31:00.000Z"),
  a=>a.state.automation.reason="OTHER",
  a=>a.state.automation.status="RUNNING",
  a=>a.state.conversation.status="RETIRED",
  a=>a.firstRuntimeId="different",
  a=>a.secondRuntimeId="different",
  a=>a.matchingUser={confirmed:true},
  a=>a.assistantCorrelation={confirmed:true},
  a=>a.matchingUser=null,
  a=>a.assistantCorrelation=null,
  a=>a.firstSnapshot.responseRunning=true,
  a=>a.secondSnapshot.assistantBusy=true,
  a=>a.firstSnapshot.composerHasText=true,
  a=>a.secondSnapshot.composerTextReadable=false,
  a=>a.firstSnapshot.conversationPath=false,
  a=>a.secondSnapshot.hasNetworkError=true,
  a=>a.firstSnapshot.loginRequired=true,
  a=>a.secondSnapshot.hasContinueControl=true,
  a=>a.firstSnapshot.conversationFull=true,
  a=>a.firstUser.turn_id="",
  a=>a.secondUser.turn_id="different",
  a=>a.secondUser.text+="\nnew",
  a=>a.firstAssistant.turn_id="",
  a=>a.secondAssistant.turn_id="different",
  a=>a.secondAssistant.text+="\nother answer",
  a=>a.firstAssistant.text="different response",
  a=>a.firstAssistant.text+="\nMAGASIN_CYCLE_CORRELATION_V1 "+uuid,
  a=>a.firstUser.text="different question",
  a=>a.state.source_of_truth.url="https://example.com/other"
 ];
 mutations.forEach((fn,i)=>{
  const p=fixture();
  fn(p);
  assert.equal(classifyEnqueuedCheckForRecoveryReview(p),null,"negative case "+i);
 });
});
test("new task preflight repeats bounded paired capture before writing PREPARED",async()=>{
 const source=await fs.readFile(new URL("../src/runtime/single-conversation-cli.mjs",import.meta.url),"utf8");
 const a=source.indexOf("async function captureProtocolBaselines(");
 const b=source.indexOf("async function sendProtocolMessage(",a);
 const c=source.indexOf("await prepareExactOnceOutbound(statePath, {",b);
 assert.ok(a>=0 && b>a && c>b);
 assert.match(source.slice(a,b),/attempts = requiresTaskBaseline \? 4 : 1/);
 assert.match(source.slice(a,b),/waitForNextCycleDelay\(400\)/);
 assert.match(source.slice(a,b),/baselineUser\?\.turn_id && baselineAssistant\?\.turn_id/);
 assert.match(source.slice(b,c),/captureProtocolBaselines\(page, \{ kind \}\)/);
 assert.match(source.slice(b,c),/TASK_BASELINE_UNVERIFIED/);
});
