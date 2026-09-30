import path from "node:path";
import {pathToFileURL} from "node:url";
import crypto from "node:crypto";
const [runtimeRoot,statePath,cdpUrl]=process.argv.slice(2);
const mod=(rel)=>import(pathToFileURL(path.join(runtimeRoot,...rel.split("/"))).href);
const {ChatGptUiAdapter}=await mod("src/ui/playwright-adapter.mjs");
const {
  composerInstructionDigest,
  composerRenderedInstructionDigest,
  inspectComposerDraftDigest,
  captureMatchingUserTurnEvidence
}=await mod("src/ui/actions.mjs");
const {buildSingleConversationTaskDiscoveryInstruction}=await mod("src/runtime/single-conversation-loop.mjs");
const {readSingleConversationState}=await mod("src/runtime/single-conversation-state.mjs");
const {opaqueRuntimeIdentity}=await mod("src/runtime/single-conversation-bootstrap.mjs");
const {captureLatestRoleTurn}=await mod("src/ui/latest-turn.mjs");

const state=await readSingleConversationState(statePath);
const id=String(state.outbound?.message_id||"");
const message=buildSingleConversationTaskDiscoveryInstruction({
  sourceOfTruthUrl:state.source_of_truth.url,
  messageId:id
});
const expectedStrict=composerInstructionDigest(message);
const expectedRendered=composerRenderedInstructionDigest(message);
const adapter=new ChatGptUiAdapter({cdpUrl,settleMs:0,actionTimeoutMs:5000,timeoutMs:15000});
await adapter.open();
const expectedRuntime=String(state.conversation?.runtime_id||"");
let pages=adapter.getChatGptPages();
let page=pages.find(p=>{try{return opaqueRuntimeIdentity(p.url())===expectedRuntime;}catch{return false;}})||null;
if(!page){
  const discovery=adapter.getActivePage()||pages.at(-1)||null;
  if(discovery){
    for(let i=0;i<30&&!page;i+=1){
      const urls=await adapter.listRecentConversationUrls(discovery,{limit:50}).catch(()=>[]);
      const matches=[...new Set(urls.filter(u=>opaqueRuntimeIdentity(u)===expectedRuntime))];
      if(matches.length===1){
        const candidate=await adapter.reopenTargetPage(matches[0]).catch(()=>null);
        if(candidate&&opaqueRuntimeIdentity(candidate.url())===expectedRuntime) page=candidate;
      }
      if(!page&&i<29) await new Promise(r=>setTimeout(r,500));
    }
  }
}
if(!page) throw new Error("active conversation page unavailable");
adapter.setActivePage(page);

const matching=await captureMatchingUserTurnEvidence(page,message).catch(e=>({confirmed:false,evidence:"error:"+String(e?.name||"Error")}));
const latestUser=await captureLatestRoleTurn(page,"user").catch(()=>null);
const latestAssistant=await captureLatestRoleTurn(page,"assistant").catch(()=>null);
const draft=await inspectComposerDraftDigest(page,{timeoutMs:1500}).catch(()=>null);
const probe=await adapter.probePage(page).catch(()=>null);
const raw=await page.evaluate((id)=>{
  const norm=(v)=>String(v||"").replace(/\u00A0/g," ").replace(/\s+/gu," ").trim();
  const turnEls=[...document.querySelectorAll("[data-testid^='conversation-turn-']")];
  const rows=turnEls.slice(-12).map(el=>({
    testid:el.getAttribute("data-testid")||"",
    role:el.getAttribute("data-message-author-role")||el.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role")||"",
    text:String(el.innerText||el.textContent||""),
    hasId:String(el.innerText||el.textContent||"").includes(id)
  }));
  const legacyUsers=[...document.querySelectorAll('[data-message-author-role="user"]')].map(el=>String(el.innerText||el.textContent||""));
  const modernUsers=[...document.querySelectorAll("main .text-size-chat.whitespace-pre-wrap")].map(el=>String(el.innerText||el.textContent||""));
  return {
    turnCount:turnEls.length,
    rows,
    legacyUserCount:legacyUsers.length,
    modernUserCount:modernUsers.length,
    legacyHasId:legacyUsers.some(t=>t.includes(id)),
    modernHasId:modernUsers.some(t=>t.includes(id)),
    bodyHasId:String(document.body?.innerText||"").includes(id)
  };
},id);

console.log("SC013_AMBIG_CHAT_PAGES="+pages.length);
console.log("SC013_AMBIG_MATCH_CONFIRMED="+String(Boolean(matching?.confirmed)));
console.log("SC013_AMBIG_MATCH_EVIDENCE="+String(matching?.evidence||""));
console.log("SC013_AMBIG_LATEST_USER_PRESENT="+String(Boolean(latestUser)));
console.log("SC013_AMBIG_LATEST_USER_HAS_ID="+String(Boolean(latestUser?.text?.includes(id))));
console.log("SC013_AMBIG_LATEST_USER_STRICT_MATCH="+String(Boolean(latestUser?.text&&composerInstructionDigest(latestUser.text)===expectedStrict)));
console.log("SC013_AMBIG_LATEST_USER_RENDERED_MATCH="+String(Boolean(latestUser?.text&&composerRenderedInstructionDigest(latestUser.text)===expectedRendered)));
console.log("SC013_AMBIG_LATEST_ASSISTANT_PRESENT="+String(Boolean(latestAssistant)));
console.log("SC013_AMBIG_LATEST_ASSISTANT_HAS_CORRELATION="+String(Boolean(latestAssistant?.text?.includes("MAGASIN_CYCLE_CORRELATION_V1 "+id))));
console.log("SC013_AMBIG_DRAFT_HAS_TEXT="+String(draft?.has_text));
console.log("SC013_AMBIG_DRAFT_STRICT_MATCH="+String(Boolean(draft?.digest===expectedStrict)));
console.log("SC013_AMBIG_DRAFT_RENDERED_MATCH="+String(Boolean(draft?.rendered_digest===expectedRendered)));
console.log("SC013_AMBIG_RESPONSE_RUNNING="+String(Boolean(probe?.snapshot?.responseRunning)));
console.log("SC013_AMBIG_LAST_MESSAGE_ROLE="+String(probe?.snapshot?.lastMessageRole||""));
console.log("SC013_AMBIG_USER_MESSAGE_COUNT="+String(probe?.snapshot?.userMessageCount??-1));
console.log("SC013_AMBIG_ASSISTANT_MESSAGE_COUNT="+String(probe?.snapshot?.assistantMessageCount??-1));
console.log("SC013_AMBIG_TURN_COUNT="+String(raw.turnCount));
console.log("SC013_AMBIG_LEGACY_USER_COUNT="+String(raw.legacyUserCount));
console.log("SC013_AMBIG_MODERN_USER_COUNT="+String(raw.modernUserCount));
console.log("SC013_AMBIG_LEGACY_HAS_ID="+String(raw.legacyHasId));
console.log("SC013_AMBIG_MODERN_HAS_ID="+String(raw.modernHasId));
console.log("SC013_AMBIG_BODY_HAS_ID="+String(raw.bodyHasId));
for(const row of raw.rows){
  const strict=composerInstructionDigest(row.text);
  const rendered=composerRenderedInstructionDigest(row.text);
  console.log("SC013_AMBIG_TURN_META testid="+row.testid+" role="+row.role+" len="+row.text.length+" has_id="+row.hasId+" strict_match="+(strict===expectedStrict)+" rendered_match="+(rendered===expectedRendered));
}
process.exit(0);
