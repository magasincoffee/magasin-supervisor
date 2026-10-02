import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeRoot,statePath,cdpUrl]=process.argv.slice(2);
const mod=(rel)=>import(pathToFileURL(path.join(runtimeRoot,...rel.split("/"))).href);
const {ChatGptUiAdapter}=await mod("src/ui/playwright-adapter.mjs");
const {
  opaqueRuntimeIdentity,
  captureCorrelatedBootstrapUserTurnEvidence
}=await mod("src/runtime/single-conversation-bootstrap.mjs");
const {
  canResumePreActuationDiscovery,
  resumeExistingConversationPage
}=await mod("src/runtime/single-conversation-cli.mjs");
const {readSingleConversationState}=await mod("src/runtime/single-conversation-state.mjs");
const {inspectComposerDraftDigest}=await mod("src/ui/actions.mjs");
const {captureLatestRoleTurn}=await mod("src/ui/latest-turn.mjs");

const bounded=async(label,promise,ms)=>{
  let timer;
  try{
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Object.assign(new Error(label+" timed out"),{code:label+"_TIMEOUT"})),ms);
      })
    ]);
  }finally{
    clearTimeout(timer);
  }
};

const state=await readSingleConversationState(statePath);
console.log("SC013_DIAG_CAN_RESUME_PRE_ACTUATION="+String(canResumePreActuationDiscovery(state)));
console.log("SC013_DIAG_EXPECTED_RUNTIME_ID="+String(state.conversation?.runtime_id||""));
console.log("SC013_DIAG_OUTBOUND="+String(state.outbound?.state||""));
console.log("SC013_DIAG_KIND="+String(state.outbound?.kind||""));
console.log("SC013_DIAG_PRE_CODE="+String(state.outbound?.last_pre_actuation_error_code||""));
console.log("SC013_DIAG_RETRY_COUNT="+String(state.outbound?.retry_count||0));

const adapter=new ChatGptUiAdapter({cdpUrl,settleMs:100,actionTimeoutMs:8000,timeoutMs:20000});
try{
  await adapter.open();
  const expected=String(state.conversation?.runtime_id||"");
  const pages=adapter.getChatGptPages();
  console.log("SC013_DIAG_PAGE_COUNT="+String(pages.length));
  const messageId=String(state.outbound?.message_id||"");
  const sourceOfTruthUrl=String(state.source_of_truth?.url||"");
  for(let i=0;i<pages.length;i+=1){
    const page=pages[i];
    const url=String(page.url?.()||"");
    let id="";
    try{id=opaqueRuntimeIdentity(url)||"";}catch{}
    console.log("SC013_DIAG_PAGE_"+i+"_URL="+url);
    console.log("SC013_DIAG_PAGE_"+i+"_RUNTIME_ID="+id);

    const corr=await captureCorrelatedBootstrapUserTurnEvidence(page,{
      messageId,
      sourceOfTruthUrl
    }).catch(()=>null);
    console.log("SC013_DIAG_PAGE_"+i+"_BOOTSTRAP_CORRELATED="+String(Boolean(corr?.confirmed)));
    console.log("SC013_DIAG_PAGE_"+i+"_BOOTSTRAP_EVIDENCE="+String(corr?.evidence||""));
    console.log("SC013_DIAG_PAGE_"+i+"_BOOTSTRAP_MATCH_COUNT="+String(Number(corr?.match_count||0)));
    console.log("SC013_DIAG_PAGE_"+i+"_USER_TURN_COUNT="+String(Number(corr?.total_count||0)));

    const assistant=await captureLatestRoleTurn(page,"assistant").catch(()=>null);
    const assistantText=String(assistant?.text||"");
    const expectedMarker="MAGASIN_BOOTSTRAP_CORRELATION_V1 "+messageId;
    console.log("SC013_DIAG_PAGE_"+i+"_ASSISTANT_PRESENT="+String(Boolean(assistant?.turn_id||assistantText)));
    console.log("SC013_DIAG_PAGE_"+i+"_ASSISTANT_MARKER="+String(assistantText.includes(expectedMarker)));
    console.log("SC013_DIAG_PAGE_"+i+"_ASSISTANT_CHARS="+String(assistantText.length));
  }

  const discovery=adapter.getActivePage()||pages.at(-1)||null;
  if(discovery && typeof adapter.listRecentConversationUrls==="function"){
    let urls=[];
    try{
      urls=await bounded("RECENT_URLS",adapter.listRecentConversationUrls(discovery,{limit:50}),8000);
      console.log("SC013_DIAG_RECENT_URLS_TIMEOUT=False");
    }catch(error){
      console.log("SC013_DIAG_RECENT_URLS_TIMEOUT=True");
      console.log("SC013_DIAG_RECENT_URLS_ERROR="+String(error?.code||error?.message||"Error"));
      urls=[];
    }
    const matches=[...new Set(urls.filter(u=>{
      try{return opaqueRuntimeIdentity(u)===expected;}catch{return false;}
    }))];
    console.log("SC013_DIAG_RECENT_URL_COUNT="+String(urls.length));
    console.log("SC013_DIAG_RECENT_MATCH_COUNT="+String(matches.length));
    for(const u of matches) console.log("SC013_DIAG_RECENT_MATCH_URL="+u);
  }

  let resumed=null;
  try{
    resumed=await bounded(
      "REBIND",
      resumeExistingConversationPage({
        adapter,
        state,
        recoveryRetries:6,
        recoveryPollMs:500
      }),
      15000
    );
    console.log("SC013_DIAG_REBIND_TIMEOUT=False");
  }catch(error){
    console.log("SC013_DIAG_REBIND_TIMEOUT=True");
    console.log("SC013_DIAG_REBIND_ERROR="+String(error?.code||error?.message||"Error"));
  }
  console.log("SC013_DIAG_REBIND_SUCCESS="+String(Boolean(resumed?.page)));
  console.log("SC013_DIAG_REBIND_SOURCE="+String(resumed?.recovered_from||""));
  if(resumed?.page) {
    console.log("SC013_DIAG_REBOUND_URL="+String(resumed.page.url?.()||""));
    const draft=await inspectComposerDraftDigest(resumed.page,{timeoutMs:1500}).catch(()=>null);
    console.log("SC013_DIAG_DRAFT_READY="+String(Boolean(draft?.ready)));
    console.log("SC013_DIAG_DRAFT_HAS_TEXT="+String(Boolean(draft?.has_text)));
    console.log("SC013_DIAG_DRAFT_DIGEST="+String(draft?.digest||""));
    const draftText=String(draft?.normalized_text||"");
    console.log("SC013_DIAG_DRAFT_TEXT_PREFIX="+draftText.slice(0,600).replace(/\r?\n/g,"\\n"));
  }
}finally{
  await Promise.race([
    adapter.close().catch(()=>{}),
    new Promise(resolve=>setTimeout(resolve,1500))
  ]).catch(()=>{});
}
process.exit(0);
