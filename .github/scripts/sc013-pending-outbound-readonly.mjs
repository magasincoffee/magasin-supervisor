import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeRoot,statePath,cdpUrl]=process.argv.slice(2);
const mod=(rel)=>import(pathToFileURL(path.join(runtimeRoot,...rel.split("/"))).href);
const {ChatGptUiAdapter}=await mod("src/ui/playwright-adapter.mjs");
const {opaqueRuntimeIdentity}=await mod("src/runtime/single-conversation-bootstrap.mjs");
const {readSingleConversationState}=await mod("src/runtime/single-conversation-state.mjs");
const {captureLatestRoleTurn}=await mod("src/ui/latest-turn.mjs");
const {composerInstructionDigest,inspectComposerDraftDigest}=await mod("src/ui/actions.mjs");

const state=await readSingleConversationState(statePath);
const expected=String(state.conversation?.runtime_id||"");
const messageId=String(state.outbound?.message_id||"");
const expectedDigest=String(state.outbound?.message_digest||"");
console.log("SC013_PENDING_EXPECTED_RUNTIME_ID="+expected);
console.log("SC013_PENDING_MESSAGE_ID="+messageId);
console.log("SC013_PENDING_EXPECTED_DIGEST="+expectedDigest);
console.log("SC013_PENDING_OUTBOUND="+String(state.outbound?.state||""));
console.log("SC013_PENDING_KIND="+String(state.outbound?.kind||""));

const adapter=new ChatGptUiAdapter({cdpUrl,settleMs:100,actionTimeoutMs:8000,timeoutMs:20000});
try{
  await adapter.open();
  const discovery=adapter.getActivePage()||adapter.getChatGptPages().at(-1)||null;
  const urls=discovery && typeof adapter.listRecentConversationUrls==="function"
    ? await adapter.listRecentConversationUrls(discovery,{limit:50}).catch(()=>[])
    : [];
  const matches=[...new Set(urls.filter(u=>{try{return opaqueRuntimeIdentity(u)===expected}catch{return false}}))];
  console.log("SC013_PENDING_MATCH_COUNT="+matches.length);
  if(matches.length!==1) process.exit(0);
  const page=await adapter.reopenTargetPage(matches[0]).catch(()=>null);
  console.log("SC013_PENDING_REOPEN_SUCCESS="+String(Boolean(page)));
  if(!page) process.exit(0);
  console.log("SC013_PENDING_REOPEN_URL="+String(page.url?.()||""));

  const probe=await adapter.probePage(page).catch(()=>null);
  const snap=probe?.snapshot||{};
  console.log("SC013_PENDING_RESPONSE_RUNNING="+String(Boolean(snap.responseRunning)));
  console.log("SC013_PENDING_CONTINUE="+String(Boolean(snap.hasContinueControl)));
  console.log("SC013_PENDING_TRANSIENT="+String(Boolean(snap.hasTransientError||snap.hasNetworkError)));

  const user=await captureLatestRoleTurn(page,"user").catch(()=>null);
  const assistant=await captureLatestRoleTurn(page,"assistant").catch(()=>null);
  const userDigest=user?.text ? composerInstructionDigest(user.text) : "";
  console.log("SC013_PENDING_LATEST_USER_PRESENT="+String(Boolean(user?.text)));
  console.log("SC013_PENDING_LATEST_USER_TURN_ID="+String(user?.turn_id||""));
  console.log("SC013_PENDING_LATEST_USER_DIGEST="+userDigest);
  console.log("SC013_PENDING_LATEST_USER_DIGEST_MATCH="+String(Boolean(userDigest&&userDigest===expectedDigest)));
  console.log("SC013_PENDING_LATEST_USER_ID_MATCH="+String(Boolean(user?.text&&messageId&&user.text.includes("id="+messageId))));

  const marker="MAGASIN_CYCLE_CORRELATION_V1 "+messageId;
  console.log("SC013_PENDING_LATEST_ASSISTANT_PRESENT="+String(Boolean(assistant?.text)));
  console.log("SC013_PENDING_ASSISTANT_MARKER_MATCH="+String(Boolean(assistant?.text&&messageId&&assistant.text.includes(marker))));

  const draft=await inspectComposerDraftDigest(page,{timeoutMs:1500}).catch(()=>null);
  console.log("SC013_PENDING_COMPOSER_READY="+String(Boolean(draft?.ready)));
  console.log("SC013_PENDING_COMPOSER_HAS_TEXT="+String(Boolean(draft?.has_text)));
  console.log("SC013_PENDING_COMPOSER_DIGEST="+String(draft?.digest||""));
  console.log("SC013_PENDING_COMPOSER_DIGEST_MATCH="+String(Boolean(draft?.digest&&draft.digest===expectedDigest)));
  console.log("SC013_PENDING_COMPOSER_ID_MATCH="+String(Boolean(draft?.normalized_text&&messageId&&draft.normalized_text.includes("id="+messageId))));
} finally {
  await Promise.race([adapter.close().catch(()=>{}),new Promise(r=>setTimeout(r,1500))]).catch(()=>{});
}
