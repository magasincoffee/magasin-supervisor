import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const phase=String(process.env.P2_PROBE_PHASE||"").trim().toLowerCase();
const runtime=process.env.P2_RUNTIME_DIR;
const configFile=process.env.P2_CONFIG_FILE;
const registryFile=process.env.P2_REGISTRY_FILE;
const cdpUrl=process.env.P2_CDP_URL;
const identityFile=process.env.P2_IDENTITY_FILE;
const sourceRoot=process.env.GITHUB_WORKSPACE;
if(!["pre","post"].includes(phase)||!runtime||!configFile||!registryFile||!cdpUrl||!identityFile||!sourceRoot){
  throw new Error("P2 live evidence environment incomplete");
}

const three=await import(pathToFileURL(path.join(sourceRoot,"src","runtime","three-lane.mjs")).href);
const capture=await import(pathToFileURL(path.join(sourceRoot,"src","ui","message-capture.mjs")).href);
const adapterMod=await import(pathToFileURL(path.join(runtime,"src","ui","playwright-adapter.mjs")).href);

function readState(){
  return {
    config:JSON.parse(fs.readFileSync(configFile,"utf8")),
    registry:JSON.parse(fs.readFileSync(registryFile,"utf8"))
  };
}
function laneState(state){
  const lane=state.config.lanes.find(x=>x.lane_id==="lane-1")||{};
  const reg=state.registry?.lanes?.["lane-1"]||{};
  return {lane,reg};
}
async function exactPage(adapter,url){
  const exact=three.normalizeChatGptConversationUrl(url);
  for(const page of adapter.getChatGptPages()){
    try{if(three.normalizeChatGptConversationUrl(page.url())===exact)return {page,created:false};}catch{}
  }
  const page=await adapter.newChatPage(exact);
  return {page,created:true};
}
async function latestDirective(page){
  let turns=[];
  let directive=null;
  for(let attempt=0;attempt<40&&!directive;attempt+=1){
    if(attempt)await page.waitForTimeout(500);
    turns=await capture.captureRecentConversationTurns(page,{limit:30}).catch(()=>[]);
    for(let i=turns.length-1;i>=0;i-=1){
      if(turns[i].role!=="assistant")continue;
      try{directive=three.parseLaneDirective(turns[i].text);break;}catch{}
    }
  }
  if(!directive&&turns.length===0){
    await page.reload({waitUntil:"domcontentloaded",timeout:30000});
    for(let attempt=0;attempt<40&&!directive;attempt+=1){
      if(attempt)await page.waitForTimeout(500);
      turns=await capture.captureRecentConversationTurns(page,{limit:30}).catch(()=>[]);
      for(let i=turns.length-1;i>=0;i-=1){
        if(turns[i].role!=="assistant")continue;
        try{directive=three.parseLaneDirective(turns[i].text);break;}catch{}
      }
    }
  }
  if(!directive)throw new Error("no valid completed Brain directive");
  return {turns,directive};
}

const state=readState();
const {lane,reg}=laneState(state);
const configuredBrain=three.normalizeChatGptConversationUrl(lane.brain_url);
const activeBrain=three.normalizeChatGptConversationUrl(reg.brain_url||lane.brain_url);
if(!configuredBrain||configuredBrain!==activeBrain)throw new Error("Brain target mismatch");
if(Number(lane.brain_url_revision||0)!==Number(reg.applied_brain_url_revision||0))throw new Error("Brain revision mismatch");

const adapter=new adapterMod.ChatGptUiAdapter({cdpUrl,settleMs:250});
await adapter.open();
let brainRef=null;
let workRef=null;
try{
  brainRef=await exactPage(adapter,activeBrain);
  if(three.normalizeChatGptConversationUrl(brainRef.page.url())!==activeBrain)throw new Error("exact Brain page changed");
  const probe=await adapter.probePage(brainRef.page).catch(()=>null);
  if(!probe||probe.snapshot?.responseRunning)throw new Error("Brain response surface not stable");
  const {directive}=await latestDirective(brainRef.page);
  if(directive.action!=="WORK")throw new Error("current Brain directive is not WORK");

  const brainDigest=three.sha256(activeBrain);
  if(phase==="pre"){
    if(String(reg.task_id||"")!==directive.task_id)throw new Error("pre durable task mismatch");
    if(String(reg.last_brain_directive_digest||"")!==directive.digest)throw new Error("pre durable directive mismatch");
    if(String(reg.instruction_digest||"")!==directive.instruction_digest)throw new Error("pre durable instruction mismatch");
    const identity={
      lane_id:"lane-1",
      task_id:directive.task_id,
      directive_digest:directive.digest,
      instruction_digest:directive.instruction_digest,
      brain_target_digest:brainDigest,
      brain_revision:Number(reg.applied_brain_url_revision||0)
    };
    fs.writeFileSync(identityFile,JSON.stringify(identity,null,2)+"\n","utf8");
    console.log("LIVE_P2_PRE_BRAIN_EXACT=True");
    console.log("LIVE_P2_PRE_TASK_ID="+directive.task_id);
    console.log("LIVE_P2_PRE_DIRECTIVE_DIGEST="+directive.digest);
    console.log("LIVE_P2_PRE_INSTRUCTION_DIGEST="+directive.instruction_digest);
    console.log("LIVE_P2_PRE_BRAIN_TARGET_DIGEST="+brainDigest);
    console.log("LIVE_P2_PRE_BRAIN_REVISION="+identity.brain_revision);
  }else{
    const before=JSON.parse(fs.readFileSync(identityFile,"utf8"));
    if(before.brain_target_digest!==brainDigest)throw new Error("post Brain target digest changed");
    if(Number(before.brain_revision)!==Number(reg.applied_brain_url_revision||0))throw new Error("post Brain revision changed");
    if(directive.task_id!==before.task_id||directive.digest!==before.directive_digest||directive.instruction_digest!==before.instruction_digest){
      throw new Error("post Brain directive identity changed");
    }
    if(String(reg.task_id||"")!==before.task_id)throw new Error("post durable task mismatch");
    if(String(reg.last_brain_directive_digest||"")!==before.directive_digest)throw new Error("post durable directive mismatch");
    if(String(reg.instruction_digest||"")!==before.instruction_digest)throw new Error("post durable instruction mismatch");
    const workUrl=three.normalizeChatGptConversationUrl(reg.work_url);
    const workTarget=new URL(workUrl);
    if(!/^\/c\/[A-Za-z0-9:_-]+$/.test(workTarget.pathname)||/^\/c\/WEB:/i.test(workTarget.pathname)){
      throw new Error("post Work target is not canonical /c/");
    }
    const workDigest=three.sha256(workUrl);
    const dispatchId=String(reg.last_dispatch_id||"").trim();
    if(!/^[a-f0-9]{16,128}$/i.test(dispatchId))throw new Error("post dispatch id missing");
    workRef=await exactPage(adapter,workUrl);
    if(three.normalizeChatGptConversationUrl(workRef.page.url())!==workUrl)throw new Error("exact Work page changed");
    const texts=await capture.captureUserTurnTexts(workRef.page).catch(()=>[]);
    const exactDispatches=texts.filter(text=>
      String(text).includes("MAGASIN_WORK_DISPATCH_V1")&&
      String(text).includes("task_id="+before.task_id)&&
      String(text).includes("dispatch_id="+dispatchId)
    );
    if(exactDispatches.length!==1)throw new Error("exact Work dispatch envelope count is not one");
    console.log("LIVE_P2_EXACT_BRAIN_TARGET_RETAINED=True");
    console.log("LIVE_P2_TASK_ID="+before.task_id);
    console.log("LIVE_P2_DIRECTIVE_DIGEST="+before.directive_digest);
    console.log("LIVE_P2_INSTRUCTION_DIGEST="+before.instruction_digest);
    console.log("LIVE_P2_CANONICAL_WORK_C=True");
    console.log("LIVE_P2_WORK_TARGET_DIGEST="+workDigest);
    console.log("LIVE_P2_DISPATCH_ID="+dispatchId);
    console.log("LIVE_P2_DISPATCH_ENVELOPE_COUNT=1");
    if(process.env.P2_CLOSE_WORK_PAGE==="1"){
      await adapter.closePage(workRef.page).catch(()=>{});
      workRef=null;
      console.log("LIVE_P2_CREATED_WORK_PAGE_CLOSED=True");
    }
  }
}finally{
  if(brainRef?.created&&brainRef.page)await adapter.closePage(brainRef.page).catch(()=>{});
  if(workRef?.created&&workRef.page)await adapter.closePage(workRef.page).catch(()=>{});
  await adapter.close().catch(()=>{});
}
