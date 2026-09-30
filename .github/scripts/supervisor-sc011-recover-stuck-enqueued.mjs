import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeRoot,statePath,cdpUrl,responseTimeoutRaw]=process.argv.slice(2);
const responseTimeoutMs=Math.max(30000,Number(responseTimeoutRaw||600)*1000);
const mod=async(rel)=>import(pathToFileURL(path.join(runtimeRoot,...rel.split("/"))).href);
const {ChatGptUiAdapter}=await mod("src/ui/playwright-adapter.mjs");
const {
  composerInstructionDigest,
  composerRenderedInstructionDigest,
  inspectComposerDraftDigest
}=await mod("src/ui/actions.mjs");
const {
  buildSingleConversationTaskDiscoveryInstruction,
  waitForSingleConversationResponse
}=await mod("src/runtime/single-conversation-loop.mjs");
const {
  reconcileExactOnceOutbound,
  markExactOnceResponseComplete,
  markExactOnceVerified
}=await mod("src/runtime/single-conversation-transaction.mjs");
const {readSingleConversationState}=await mod("src/runtime/single-conversation-state.mjs");
const {opaqueRuntimeIdentity}=await mod("src/runtime/single-conversation-bootstrap.mjs");
const {captureLatestRoleTurn}=await mod("src/ui/latest-turn.mjs");

const state=await readSingleConversationState(statePath);
const id=String(state.outbound?.message_id||"");
const message=buildSingleConversationTaskDiscoveryInstruction({
  sourceOfTruthUrl:state.source_of_truth.url,
  messageId:id
});
if(composerInstructionDigest(message)!==state.outbound.message_digest){
  throw new Error("reconstructed discovery message digest mismatch");
}

const adapter=new ChatGptUiAdapter({cdpUrl,settleMs:100,actionTimeoutMs:8000,timeoutMs:20000});
try{
  await adapter.open();
  const expected=String(state.conversation?.runtime_id||"");
  const pages=adapter.getChatGptPages();
  let page=pages.find(p=>{
    try{return opaqueRuntimeIdentity(p.url())===expected;}catch{return false;}
  })||null;

  if(!page){
    const discovery=adapter.getActivePage()||pages.at(-1)||null;
    if(discovery){
      const urls=await adapter.listRecentConversationUrls(discovery,{limit:50}).catch(()=>[]);
      const matches=[...new Set(urls.filter(u=>opaqueRuntimeIdentity(u)===expected))];
      if(matches.length===1){
        page=await adapter.reopenTargetPage(matches[0]);
      }
    }
  }
  if(!page) throw new Error("exact active conversation could not be rebound");

  adapter.setActivePage(page);
  const draft=await inspectComposerDraftDigest(page,{timeoutMs:2000});
  const strict=composerInstructionDigest(message);
  const rendered=composerRenderedInstructionDigest(message);
  const draftMatches=Boolean(
    draft?.has_text &&
    (draft.digest===strict || draft.rendered_digest===rendered)
  );
  console.log("RECOVER_STUCK_DRAFT_HAS_TEXT="+String(draft?.has_text));
  console.log("RECOVER_STUCK_DRAFT_STRICT_MATCH="+String(draft?.digest===strict));
  console.log("RECOVER_STUCK_DRAFT_RENDERED_MATCH="+String(draft?.rendered_digest===rendered));
  if(draft?.has_text && !draftMatches){
    throw new Error("live draft differs from reconstructed outbound message");
  }

  const baselineAssistant=await captureLatestRoleTurn(page,"assistant").catch(()=>null);
  const delivery=await reconcileExactOnceOutbound({
    statePath,
    page,
    messageId:id,
    message,
    maxSafeRetries:1,
    reconciliationProbes:4,
    reconciliationPollMs:250
  });
  console.log("RECOVER_STUCK_DELIVERY_ACTION="+String(delivery.action||""));
  console.log("RECOVER_STUCK_DELIVERY_STATE="+String(delivery.state||""));

  const response=await waitForSingleConversationResponse({
    page,
    statePath,
    baselineAssistantTurnId:baselineAssistant?.turn_id||null,
    expectedAssistantMarker:"MAGASIN_CYCLE_CORRELATION_V1 "+id,
    timeoutMs:responseTimeoutMs,
    pollMs:750,
    maxContinueClicks:8
  });
  console.log("RECOVER_STUCK_RESPONSE_STATUS="+String(response?.status||""));
  if(response?.status!=="RESPONSE_COMPLETE"){
    throw new Error("recovered task discovery response did not complete");
  }
  await markExactOnceResponseComplete(statePath,{messageId:id,message});
  await markExactOnceVerified(statePath,{messageId:id,message});
  console.log("RECOVER_STUCK_TRANSACTION_VERIFIED=True");
}finally{
  await adapter.close().catch(()=>{});
  process.exitCode=0;
}
