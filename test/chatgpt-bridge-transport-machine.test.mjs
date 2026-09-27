import test from "node:test";
import assert from "node:assert/strict";

import {
  CHATGPT_BRIDGE_TRANSPORT_PHASES as P,
  ChatGptBridgeTransportError,
  ChatGptBridgeTransportMachine,
  bridgeTransportAssistantText,
  defaultChatGptBridgeTransportState
} from "../src/runtime/chatgpt-bridge-transport-machine.mjs";

const plannerUrl="https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const executorUrl="https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
const binding={
  schema_version:"chatgpt-bridge-binding.v1",
  page_count:2,
  exact_page_set:true,
  planner:{role:"planner",chat_url:plannerUrl,canonical_target:plannerUrl,page_id:"planner_page",page_url:plannerUrl,title:"Planner"},
  executor:{role:"executor",chat_url:executorUrl,canonical_target:executorUrl,page_id:"executor_page",page_url:executorUrl,title:"Executor"},
  unrelated_page_ids:[]
};

function observed(text, cmd="cmd"){
  return {
    ok:true,cmd_id:cmd,page_id:"ignored",
    snapshot:{
      last_assistant:text,
      recent_turns:[{role:"assistant",text}],
      is_generating:false,
      assistant_count:1
    },
    evidence:{response_changed:true,count_advanced:true,digest_changed:true,assistant_digest:"a".repeat(64)}
  };
}

function scriptedAdapter(script){
  const calls=[];
  return {
    calls,
    async send(page_id,message){
      calls.push({page_id,message});
      const next=script.shift();
      if(next instanceof Error) throw next;
      return typeof next==="function" ? next(page_id,message) : next;
    }
  };
}

test("default transport state is IDLE and bound to exact role page ids",()=>{
  const state=defaultChatGptBridgeTransportState(binding);
  assert.equal(state.phase,P.IDLE);
  assert.deepEqual(state.role_page_ids,{planner:"planner_page",executor:"executor_page"});
});

test("start bootstraps exact Planner and yields opaque Planner response",async()=>{
  const adapter=scriptedAdapter([observed("planner-output","p1")]);
  const m=new ChatGptBridgeTransportMachine({adapter,binding,now:()=> "2026-09-27T00:00:00.000Z"});
  const r=await m.start("bootstrap");
  assert.deepEqual(adapter.calls,[{page_id:"planner_page",message:"bootstrap"}]);
  assert.equal(r.response_text,"planner-output");
  assert.equal(r.state.phase,P.WAIT_PLANNER);
  assert.equal(r.state.send_count,1);
  assert.equal(r.state.last_response_role,"planner");
});

test("Planner -> Executor -> Planner -> Executor uses three task-cycle sends",async()=>{
  const adapter=scriptedAdapter([
    observed("planner-assign","p"),
    observed("executor-report","e"),
    observed("planner-decision","pd"),
    observed("executor-next","en")
  ]);
  const m=new ChatGptBridgeTransportMachine({adapter,binding});
  await m.start("bootstrap");
  const before=m.snapshot().send_count;
  const e1=await m.sendToExecutor("assignment");
  assert.equal(e1.state.phase,P.WAIT_EXECUTOR);
  const p1=await m.sendToPlanner("report relay");
  assert.equal(p1.state.phase,P.WAIT_PLANNER_DECISION);
  const e2=await m.sendToExecutor("next assignment");
  assert.equal(e2.state.phase,P.WAIT_EXECUTOR);
  assert.equal(m.snapshot().send_count-before,3);
  assert.deepEqual(adapter.calls.slice(1).map(x=>x.page_id),["executor_page","planner_page","executor_page"]);
});

test("wrong role/phase transition fails before any Bridge send",async()=>{
  const adapter=scriptedAdapter([]);
  const m=new ChatGptBridgeTransportMachine({adapter,binding});
  await assert.rejects(
    ()=>m.sendToPlanner("bad"),
    e=>e instanceof ChatGptBridgeTransportError && e.code==="INVALID_TRANSITION"
  );
  assert.equal(adapter.calls.length,0);
  assert.equal(m.snapshot().phase,P.IDLE);
});

test("transport send failure enters BLOCKED with ambiguous in-flight marker",async()=>{
  const adapter=scriptedAdapter([new Error("network")]);
  const m=new ChatGptBridgeTransportMachine({adapter,binding});
  await assert.rejects(
    ()=>m.start("bootstrap"),
    e=>e instanceof ChatGptBridgeTransportError && e.code==="AMBIGUOUS_SEND"
  );
  const s=m.snapshot();
  assert.equal(s.phase,P.BLOCKED);
  assert.equal(s.in_flight.outcome,"AMBIGUOUS");
  assert.equal(s.in_flight.role,"planner");
  assert.equal(s.blocked_reason,"transport-send-ambiguous");
  assert.throws(()=>m.resume(),e=>e.code==="AMBIGUOUS_IN_FLIGHT");
  assert.equal(adapter.calls.length,1);
});

test("explicit protocol-level block can resume to prior waiting phase",async()=>{
  const adapter=scriptedAdapter([observed("planner")]);
  const m=new ChatGptBridgeTransportMachine({adapter,binding});
  await m.start("bootstrap");
  m.markBlocked("owner-dependency");
  assert.equal(m.snapshot().phase,P.BLOCKED);
  const resumed=m.resume();
  assert.equal(resumed.phase,P.WAIT_PLANNER);
  assert.equal(resumed.blocked_reason,null);
});

test("DONE is terminal and only allowed after Planner response phases",async()=>{
  const adapter=scriptedAdapter([observed("planner")]);
  const m=new ChatGptBridgeTransportMachine({adapter,binding});
  assert.throws(()=>m.markDone(),e=>e.code==="INVALID_TRANSITION");
  await m.start("bootstrap");
  assert.equal(m.markDone("complete").phase,P.DONE);
  assert.equal(m.isTerminal(),true);
  await assert.rejects(()=>m.sendToExecutor("x"),e=>e.code==="INVALID_TRANSITION");
});

test("STOPPED refuses ambiguous in-flight and is otherwise terminal",async()=>{
  const adapter=scriptedAdapter([observed("planner")]);
  const m=new ChatGptBridgeTransportMachine({adapter,binding});
  await m.start("bootstrap");
  assert.equal(m.markStopped("owner-stop").phase,P.STOPPED);
  assert.equal(m.isTerminal(),true);
});

test("empty assistant response is ambiguous and blocks duplicate continuation",async()=>{
  const adapter=scriptedAdapter([observed("")]);
  const m=new ChatGptBridgeTransportMachine({adapter,binding});
  await assert.rejects(()=>m.start("bootstrap"),e=>e.code==="AMBIGUOUS_SEND");
  assert.equal(m.snapshot().phase,P.BLOCKED);
  assert.equal(m.snapshot().in_flight.error_code,"EMPTY_ASSISTANT_RESPONSE");
});

test("transport state stores observation metadata but not message or response body",async()=>{
  const adapter=scriptedAdapter([observed("secret response")]);
  const m=new ChatGptBridgeTransportMachine({adapter,binding});
  await m.start("secret prompt");
  const serialized=JSON.stringify(m.snapshot());
  assert.equal(serialized.includes("secret prompt"),false);
  assert.equal(serialized.includes("secret response"),false);
  assert.equal(m.snapshot().last_observation.cmd_id,"cmd");
});

test("safe rebinding may change page_id only for the same canonical role conversations",async()=>{
  const adapter=scriptedAdapter([observed("planner")]);
  const m=new ChatGptBridgeTransportMachine({adapter,binding});
  await m.start("bootstrap");

  const rebound=structuredClone(binding);
  rebound.planner.page_id="planner_reloaded";
  rebound.executor.page_id="executor_reloaded";
  const state=m.replaceBinding(rebound);
  assert.deepEqual(state.role_page_ids,{
    planner:"planner_reloaded",
    executor:"executor_reloaded"
  });

  const changed=structuredClone(rebound);
  changed.planner.canonical_target="https://chatgpt.com/c/33333333-3333-4333-8333-333333333333";
  assert.throws(
    ()=>m.replaceBinding(changed),
    e=>e instanceof ChatGptBridgeTransportError && e.code==="ROLE_IDENTITY_CHANGED"
  );
});

test("ambiguous in-flight transport blocks binding replacement",async()=>{
  const adapter=scriptedAdapter([new Error("network")]);
  const m=new ChatGptBridgeTransportMachine({adapter,binding});
  await assert.rejects(()=>m.start("bootstrap"),e=>e.code==="AMBIGUOUS_SEND");
  const rebound=structuredClone(binding);
  rebound.planner.page_id="planner_reloaded";
  assert.throws(
    ()=>m.replaceBinding(rebound),
    e=>e instanceof ChatGptBridgeTransportError && e.code==="AMBIGUOUS_IN_FLIGHT"
  );
});

test("assistant text helper falls back to latest assistant recent turn",()=>{
  assert.equal(
    bridgeTransportAssistantText({
      snapshot:{
        last_assistant:"",
        recent_turns:[
          {role:"assistant",text:"older"},
          {role:"user",text:"user"},
          {role:"assistant",text:"latest"}
        ]
      }
    }),
    "latest"
  );
});
