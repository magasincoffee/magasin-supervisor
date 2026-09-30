import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeRoot,statePath,cdpUrl]=process.argv.slice(2);
if(!runtimeRoot||!statePath||!cdpUrl){
  console.log("SC013_UI_LIVENESS_ERROR=ARGUMENTS");
  process.exit(0);
}
const mod=(rel)=>import(pathToFileURL(path.join(runtimeRoot,...rel.split("/"))).href);
const {ChatGptUiAdapter}=await mod("src/ui/playwright-adapter.mjs");
const {opaqueRuntimeIdentity}=await mod("src/runtime/single-conversation-bootstrap.mjs");
const {readSingleConversationState}=await mod("src/runtime/single-conversation-state.mjs");

const bounded=async(label,promise,ms)=>{
  let timer;
  try{
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Object.assign(new Error(label+" timeout"),{code:label+"_TIMEOUT"})),ms);
      })
    ]);
  }finally{
    clearTimeout(timer);
  }
};

const state=await readSingleConversationState(statePath).catch(()=>null);
const expected=String(state?.conversation?.runtime_id||"");
console.log("SC013_UI_EXPECTED_RUNTIME_ID="+expected);
if(!expected){
  console.log("SC013_UI_MATCH_COUNT=0");
  process.exit(0);
}

const adapter=new ChatGptUiAdapter({
  cdpUrl,
  settleMs:50,
  actionTimeoutMs:3000,
  timeoutMs:5000
});

try{
  await bounded("OPEN",adapter.open(),7000);
  const pages=adapter.getChatGptPages();
  const matches=pages.filter((page)=>{
    try{return opaqueRuntimeIdentity(String(page.url?.()||""))===expected;}
    catch{return false;}
  });
  console.log("SC013_UI_MATCH_COUNT="+matches.length);
  if(matches.length!==1) process.exit(0);

  const page=matches[0];
  if(typeof adapter.setActivePage==="function") adapter.setActivePage(page);
  const probe=await bounded("PROBE",adapter.probePage(page),5000).catch(()=>null);
  const snap=probe?.snapshot||{};
  console.log("SC013_UI_RESPONSE_RUNNING="+String(Boolean(snap.responseRunning)));
  console.log("SC013_UI_ASSISTANT_BUSY="+String(Boolean(snap.assistantBusy)));
  console.log("SC013_UI_MAIN_BUSY="+String(Boolean(snap.mainBusy)));
  console.log("SC013_UI_ASSISTANT_COUNT="+String(Number(snap.assistantMessageCount||0)));
  console.log("SC013_UI_ASSISTANT_CHARS="+String(Number(snap.lastAssistantCharCount||0)));
  console.log("SC013_UI_CONTINUE="+String(Boolean(snap.hasContinueControl)));
  console.log("SC013_UI_LIVENESS_STATUS=PASS");
}catch(error){
  console.log("SC013_UI_LIVENESS_ERROR="+String(error?.code||error?.name||"Error"));
}finally{
  await Promise.race([
    adapter.close().catch(()=>{}),
    new Promise((resolve)=>setTimeout(resolve,1000))
  ]).catch(()=>{});
}
process.exit(0);
