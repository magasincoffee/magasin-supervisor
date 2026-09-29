import process from "node:process";
import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import {
  captureMatchingUserTurnEvidence,
  inspectComposerDraftDigest,
  inspectActionSurface
} from "../../src/ui/actions.mjs";
import { captureLatestRoleTurn } from "../../src/ui/latest-turn.mjs";

const cdpUrl=String(process.argv[2]||"").trim();
if(!cdpUrl) throw new Error("cdp url required");

const adapter=new ChatGptUiAdapter({
  cdpUrl,
  settleMs:100,
  actionTimeoutMs:2000,
  timeoutMs:10000
});

async function timed(label, fn, timeoutMs=15000){
  const start=Date.now();
  let timer;
  try{
    const value=await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Object.assign(new Error("timeout"),{code:"PROFILE_TIMEOUT"})),timeoutMs);
      })
    ]);
    console.log(`SC011_PROFILE_${label}_MS=${Date.now()-start}`);
    console.log(`SC011_PROFILE_${label}_RESULT=${JSON.stringify(value)}`);
    return {ok:true,value};
  }catch(error){
    console.log(`SC011_PROFILE_${label}_MS=${Date.now()-start}`);
    console.log(`SC011_PROFILE_${label}_ERROR=${String(error?.code||error?.message||error)}`);
    return {ok:false,error};
  }finally{
    if(timer) clearTimeout(timer);
  }
}

try{
  await timed("OPEN",()=>adapter.open(),15000);
  const pages=adapter.getChatGptPages();
  console.log("SC011_PROFILE_CHAT_PAGE_COUNT="+pages.length);
  for(let i=0;i<pages.length;i+=1){
    console.log(`SC011_PROFILE_PAGE_${i}_URL=${pages[i].url()}`);
  }
  const page=adapter.getActivePage();
  if(!page) throw new Error("no active page");

  await timed("PROBE",()=>adapter.probePage(page),15000);
  await timed("MATCHING_USER",()=>captureMatchingUserTurnEvidence(page,"__SC011_PROFILE_NO_MATCH__"),15000);
  await timed("LATEST_USER",()=>captureLatestRoleTurn(page,"user"),15000);
  await timed("LATEST_ASSISTANT",()=>captureLatestRoleTurn(page,"assistant"),15000);
  await timed("DRAFT",()=>inspectComposerDraftDigest(page,{timeoutMs:1500}),15000);
  await timed("ACTION_SURFACE",()=>inspectActionSurface(page),15000);
} finally {
  await adapter.close().catch(()=>{});
}
