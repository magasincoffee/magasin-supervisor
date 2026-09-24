import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  WORK_TARGET_MODES,
  resolveWorkTargetPolicy
} from "../src/runtime/work-target-state.mjs";
import {
  beginWorkRollover,
  markBlankTargetCreating,
  markRolloverTargetPersisted
} from "../src/runtime/work-rollover.mjs";

const TASK="SUP-SELFHEAL-P2";
const DIRECTIVE="a".repeat(64);
const INSTRUCTION="b".repeat(64);
const TARGET="c".repeat(64);
const T0="2026-09-24T03:30:00.000Z";

async function source(rel){
  return fs.readFile(new URL(rel,import.meta.url),"utf8");
}
function slice(src,start,end){
  const a=src.indexOf(start),b=src.indexOf(end,a+start.length);
  assert.ok(a>=0,`missing start: ${start}`);
  assert.ok(b>a,`missing end: ${end}`);
  return src.slice(a,b);
}

test("P2 OWNER mode pins explicit Work and never authorizes AUTO creation",()=>{
  const p=resolveWorkTargetPolicy({
    applied_work_mode:"OWNER",
    work_url:"https://chatgpt.com/c/owner-pinned"
  });
  assert.equal(p.mode,WORK_TARGET_MODES.OWNER);
  assert.equal(p.has_usable_configured_target,true);
  assert.equal(p.auto_create_allowed,false);
  assert.equal(p.reason_code,"OWNER_PINNED_TARGET");
});

test("P2 OWNER mode without explicit Work fails closed instead of AUTO creating",()=>{
  const p=resolveWorkTargetPolicy({applied_work_mode:"OWNER",work_url:""});
  assert.deepEqual(p,{
    mode:"OWNER",
    work_url:"",
    has_usable_configured_target:false,
    auto_create_allowed:false,
    reason_code:"OWNER_WORK_TARGET_REQUIRED"
  });
});

test("P2 AUTO mode requests creation only when no persisted Work target exists",()=>{
  const empty=resolveWorkTargetPolicy({applied_work_mode:"AUTO",work_url:""});
  assert.equal(empty.auto_create_allowed,true);
  assert.equal(empty.reason_code,"AUTO_WORK_CREATE_REQUIRED");
  const persisted=resolveWorkTargetPolicy({
    applied_work_mode:"AUTO",
    work_url:"https://chatgpt.com/c/auto-persisted"
  });
  assert.equal(persisted.auto_create_allowed,false);
  assert.equal(persisted.reason_code,"AUTO_PERSISTED_TARGET_REUSE");
});

test("P2 durable AUTO state requires target persistence before dispatch latch stage",()=>{
  let r=beginWorkRollover({
    reason:"NO_WORK_TARGET",
    taskId:TASK,
    directiveDigest:DIRECTIVE,
    directiveInstructionDigest:INSTRUCTION,
    oldWorkGeneration:4,
    oldWorkUrlRevision:2,
    at:T0
  });
  assert.equal(r.stage,"INTENT_PERSISTED");
  r=markBlankTargetCreating(r,{at:T0});
  assert.equal(r.stage,"BLANK_TARGET_CREATING");
  r=markRolloverTargetPersisted(r,{
    newWorkGeneration:5,
    newWorkTargetDigest:TARGET,
    at:T0
  });
  assert.equal(r.stage,"TARGET_PERSISTED");
  assert.equal(r.new_work_generation,5);
  assert.equal(r.new_work_target_digest,TARGET);
});

test("P2 runtime persists canonical AUTO Work target before constructing dispatch latch",async()=>{
  const runtime=await source("../src/runtime/three-lane-cli.mjs");
  const work=slice(runtime,"async function dispatchWork","async function reconcileRelayInflight");
  const persist=work.indexOf("LANE_AUTO_WORK_TARGET_PERSISTED");
  const latch=work.indexOf("registryLane.dispatch_inflight = latch");
  assert.ok(persist>=0);
  assert.ok(latch>persist);
  assert.match(work,/await atomicJsonWrite\(registryPath, registry\);[\s\S]*AUTO_WORK_TARGET_PERSISTED/);
  assert.match(work,/AUTO Work target did not resolve to canonical \/c\/ identity/);
});

test("P2 AUTO creation uses the canonical global browser mutation lease",async()=>{
  const runtime=await source("../src/runtime/three-lane-cli.mjs");
  const scheduler=await source("../src/runtime/browser-scheduler.mjs");
  const create=slice(runtime,"async function createBlankWorkTarget","async function dispatchWork");
  assert.match(create,/scheduler\.createPageUnderMutation/);
  assert.match(scheduler,/createPageUnderMutation\([\s\S]*acquireMutationLease/);
  assert.match(scheduler,/error\.code = "MUTATION_LEASE_BUSY"/);
});

test("P2 restart in ambiguous create-before-persist state fails closed and cannot create a second Work",async()=>{
  const runtime=await source("../src/runtime/three-lane-cli.mjs");
  const work=slice(runtime,"async function dispatchWork","async function reconcileRelayInflight");
  const ambiguous=work.indexOf("AUTO_WORK_CREATE_RESTART_AMBIGUOUS");
  const create=work.indexOf("created = await createBlankWorkTarget");
  assert.ok(ambiguous>=0);
  assert.ok(create>ambiguous);
  assert.match(work,/else if \(rollover\.reason === "NO_WORK_TARGET"\)[\s\S]*AUTO_WORK_CREATE_AMBIGUOUS[\s\S]*return;/);
});

test("P2 persisted AUTO Work is reused after restart rather than creating another target",async()=>{
  const p=resolveWorkTargetPolicy({
    applied_work_mode:"AUTO",
    work_url:"https://chatgpt.com/c/restart-safe"
  });
  assert.equal(p.auto_create_allowed,false);
  const runtime=await source("../src/runtime/three-lane-cli.mjs");
  const work=slice(runtime,"async function dispatchWork","async function reconcileRelayInflight");
  assert.match(work,/rollover\.stage !== WORK_ROLLOVER_STAGES\.TARGET_PERSISTED/);
  assert.match(work,/persisted rollover target identity mismatch/);
  assert.match(work,/openExactConversation\(adapter, registryLane\.work_url/);
});

test("P2 exact-once dispatch remains deterministic and duplicate-safe",async()=>{
  const runtime=await source("../src/runtime/three-lane-cli.mjs");
  const work=slice(runtime,"async function dispatchWork","async function reconcileRelayInflight");
  assert.match(work,/const dispatchId = existingDispatchLatch\?\.dispatch_id \|\| sha256/);
  assert.match(work,/workDispatchMarker\(dispatchId\)/);
  assert.match(work,/hasUserTurnMarker\(page, workDispatchMarker\(dispatchId\)\)/);
  assert.match(work,/persisted Work dispatch latch identity mismatch/);
});

test("P2 invalid or non-/c/ newly created identity is rejected before persistence",async()=>{
  const runtime=await source("../src/runtime/three-lane-cli.mjs");
  const wait=slice(runtime,"async function waitForConversationUrl","function laneStatus");
  assert.match(wait,/isPersistableConversationUrl/);
  assert.match(wait,/\^\\\/c\\\//);
  assert.match(wait,/AUTO_WORK_TARGET_NOT_CANONICAL_C/);
});

test("P2 Owner STOP/lane disable is rechecked before both create and send",async()=>{
  const runtime=await source("../src/runtime/three-lane-cli.mjs");
  const work=slice(runtime,"async function dispatchWork","async function reconcileRelayInflight");
  const checks=[...work.matchAll(/isLaneMutationAllowed\(\{/g)].map(m=>m.index);
  const create=work.indexOf("created = await createBlankWorkTarget");
  const send=work.indexOf("sendComposerInstruction");
  assert.ok(checks.length>=2);
  assert.ok(checks.some(x=>x<create));
  assert.ok(checks.some(x=>x>create && x<send));
  assert.match(runtime,/if \(await isOwnerStopRequested\(stopPath\)\) return false/);
});

test("P2 AUTO lifecycle events are sanitized and machine-readable",async()=>{
  const events=await source("../src/runtime/lane-events.mjs");
  for(const name of [
    "AUTO_WORK_CREATE_REQUESTED",
    "AUTO_WORK_TARGET_PERSISTED",
    "AUTO_WORK_DISPATCH_CONFIRMED",
    "AUTO_WORK_CREATE_AMBIGUOUS"
  ]) assert.match(events,new RegExp(name));
  assert.doesNotMatch(events,/"work_url",/);
});
