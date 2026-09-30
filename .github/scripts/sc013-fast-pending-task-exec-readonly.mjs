import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeRoot,statePath,cdpUrl]=process.argv.slice(2);
const mod=(rel)=>import(pathToFileURL(path.join(runtimeRoot,...rel.split("/"))).href);
const {ChatGptUiAdapter}=await mod("src/ui/playwright-adapter.mjs");
const {opaqueRuntimeIdentity}=await mod("src/runtime/single-conversation-bootstrap.mjs");
const {readSingleConversationState}=await mod("src/runtime/single-conversation-state.mjs");
const {captureLatestRoleTurn}=await mod("src/ui/latest-turn.mjs");
const {composerInstructionDigest,composerRenderedInstructionDigest,inspectComposerDraftDigest}=await mod("src/ui/actions.mjs");

const state=await readSingleConversationState(statePath);
const expected=String(state.conversation?.runtime_id||"");
const id=String(state.outbound?.message_id||"");
const digest=String(state.outbound?.message_digest||"");
console.log("SC013_FAST_STATE="+String(state.outbound?.state||""));
console.log("SC013_FAST_KIND="+String(state.outbound?.kind||""));
console.log("SC013_FAST_MESSAGE_ID="+id);
console.log("SC013_FAST_DIGEST="+digest);
console.log("SC013_FAST_TASK_ID_STATE="+String(state.outbound?.task_id||""));
console.log("SC013_FAST_RUNTIME_ID="+expected);

const bounded=async(label,promise,ms)=>{
  let timer;
  try{
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error(label+" timeout"),{code:label+"_TIMEOUT"})),ms);})
    ]);
  }finally{clearTimeout(timer);}
};

const extractTaskId=(text)=>{
  const m=String(text||"").match(/(?:^|\n)TASK_ID=([^\n\r]+)/);
  return m ? m[1].trim() : "";
};

const adapter=new ChatGptUiAdapter({cdpUrl,settleMs:100,actionTimeoutMs:5000,timeoutMs:10000});
try{
  await bounded("OPEN",adapter.open(),10000);
  const pages=adapter.getChatGptPages();
  console.log("SC013_FAST_PAGE_COUNT="+pages.length);
  const matches=pages.filter(p=>{
    try{return opaqueRuntimeIdentity(String(p.url?.()||""))===expected}catch{return false}
  });
  console.log("SC013_FAST_MATCH_COUNT="+matches.length);
  if(matches.length!==1) process.exit(0);
  const page=matches[0];
  if(typeof adapter.setActivePage==="function") adapter.setActivePage(page);
  console.log("SC013_FAST_MATCH_URL="+String(page.url?.()||""));

  const user=await bounded("USER",captureLatestRoleTurn(page,"user"),5000).catch(()=>null);
  const assistant=await bounded("ASSISTANT",captureLatestRoleTurn(page,"assistant"),5000).catch(()=>null);
  const draft=await bounded("DRAFT",inspectComposerDraftDigest(page,{timeoutMs:1500}),5000).catch(()=>null);

  const userText=String(user?.text||"");
  const draftText=String(draft?.normalized_text||"");
  const userDigest=userText ? composerInstructionDigest(userText) : "";
  const userRendered=userText ? composerRenderedInstructionDigest(userText) : "";
  const marker="MAGASIN_CYCLE_CORRELATION_V1 "+id;

  console.log("SC013_FAST_USER_PRESENT="+String(Boolean(userText)));
  console.log("SC013_FAST_USER_TURN_ID="+String(user?.turn_id||""));
  console.log("SC013_FAST_USER_DIGEST="+userDigest);
  console.log("SC013_FAST_USER_DIGEST_MATCH="+String(Boolean(userDigest&&userDigest===digest)));
  console.log("SC013_FAST_USER_ID_MATCH="+String(Boolean(userText&&id&&userText.includes("id="+id))));
  console.log("SC013_FAST_USER_TASK_ID="+extractTaskId(userText));

  console.log("SC013_FAST_DRAFT_READY="+String(Boolean(draft?.ready)));
  console.log("SC013_FAST_DRAFT_HAS_TEXT="+String(Boolean(draft?.has_text)));
  console.log("SC013_FAST_DRAFT_DIGEST="+String(draft?.digest||""));
  console.log("SC013_FAST_DRAFT_RENDERED_DIGEST="+String(draft?.rendered_digest||""));
  console.log("SC013_FAST_DRAFT_DIGEST_MATCH="+String(Boolean(draft?.digest&&draft.digest===digest)));
  console.log("SC013_FAST_DRAFT_ID_MATCH="+String(Boolean(draftText&&id&&draftText.includes("id="+id))));
  console.log("SC013_FAST_DRAFT_TASK_ID="+extractTaskId(draftText));

  console.log("SC013_FAST_ASSISTANT_MARKER_MATCH="+String(Boolean(assistant?.text&&id&&String(assistant.text).includes(marker))));
  console.log("SC013_FAST_DONE=PASS");
} finally {
  await Promise.race([adapter.close().catch(()=>{}),new Promise(r=>setTimeout(r,1000))]).catch(()=>{});
}
process.exit(0);
