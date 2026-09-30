import path from "node:path";
import {pathToFileURL} from "node:url";
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

const state=await readSingleConversationState(statePath);
const id=String(state.outbound?.message_id||"");
const message=buildSingleConversationTaskDiscoveryInstruction({
  sourceOfTruthUrl:state.source_of_truth.url,
  messageId:id
});
const strict=composerInstructionDigest(message);
const rendered=composerRenderedInstructionDigest(message);
console.log("SC013_PREFLIGHT_STATE="+String(state.outbound?.state||""));
console.log("SC013_PREFLIGHT_KIND="+String(state.outbound?.kind||""));
console.log("SC013_PREFLIGHT_MESSAGE_ID="+id);
console.log("SC013_PREFLIGHT_DURABLE_STRICT_MATCH="+String(strict===state.outbound?.message_digest));

const adapter=new ChatGptUiAdapter({cdpUrl,settleMs:0,actionTimeoutMs:5000,timeoutMs:15000});
await adapter.open();
const expected=String(state.conversation?.runtime_id||"");
const pages=adapter.getChatGptPages();
let page=pages.find(p=>{try{return opaqueRuntimeIdentity(p.url())===expected;}catch{return false;}})||null;
if(!page) throw new Error("active runtime page not found");
const draft=await inspectComposerDraftDigest(page,{timeoutMs:2000});
const matching=await captureMatchingUserTurnEvidence(page,message).catch(()=>({confirmed:false,evidence:"unreadable"}));
const draftText=String(draft?.normalized_text||"");
const ownedDraft=Boolean(
  draft?.has_text &&
  draftText.startsWith("MAGASIN_DISCOVER_TASK_V1") &&
  draftText.includes("id="+id) &&
  draftText.includes("SOT="+String(state.source_of_truth.url||""))
);
const compact=(value)=>String(value||"").replace(/[\\s\\u200B-\\u200F\\u2060\\uFEFF]+/gu,"");
const startsMarker=draftText.startsWith("MAGASIN_DISCOVER_TASK_V1");
const containsId=draftText.includes("id="+id);
const containsSot=draftText.includes("SOT="+String(state.source_of_truth.url||""));
let prefix=0;
while(prefix<draftText.length && prefix<message.length && draftText[prefix]===message[prefix]) prefix+=1;
let suffix=0;
while(
  suffix<draftText.length-prefix &&
  suffix<message.length-prefix &&
  draftText[draftText.length-1-suffix]===message[message.length-1-suffix]
) suffix+=1;
const draftCp=prefix<draftText.length?draftText.codePointAt(prefix):null;
const expectedCp=prefix<message.length?message.codePointAt(prefix):null;
let singleExtraIndex=-1;
let singleExtraCodePoint=null;
if(draftText.length===message.length+1){
  for(let i=0;i<draftText.length;i+=1){
    if(draftText.slice(0,i)+draftText.slice(i+1)===message){
      singleExtraIndex=i;
      singleExtraCodePoint=draftText.codePointAt(i);
      break;
    }
  }
}

console.log("SC013_PREFLIGHT_CHAT_PAGES="+pages.length);
console.log("SC013_PREFLIGHT_DRAFT_READY="+String(draft?.ready));
console.log("SC013_PREFLIGHT_DRAFT_HAS_TEXT="+String(draft?.has_text));
console.log("SC013_PREFLIGHT_DRAFT_STRICT_MATCH="+String(draft?.digest===strict));
console.log("SC013_PREFLIGHT_DRAFT_RENDERED_MATCH="+String(draft?.rendered_digest===rendered));
console.log("SC013_PREFLIGHT_EXPECTED_LEN="+String(message.length));
console.log("SC013_PREFLIGHT_DRAFT_LEN="+String(draftText.length));
console.log("SC013_PREFLIGHT_DRAFT_OWNED="+String(ownedDraft));
console.log("SC013_PREFLIGHT_STARTS_MARKER="+String(startsMarker));
console.log("SC013_PREFLIGHT_CONTAINS_ID="+String(containsId));
console.log("SC013_PREFLIGHT_CONTAINS_SOT="+String(containsSot));
console.log("SC013_PREFLIGHT_COMMON_PREFIX="+String(prefix));
console.log("SC013_PREFLIGHT_COMMON_SUFFIX="+String(suffix));
console.log("SC013_PREFLIGHT_DRAFT_CODEPOINT_AT_MISMATCH="+String(draftCp));
console.log("SC013_PREFLIGHT_EXPECTED_CODEPOINT_AT_MISMATCH="+String(expectedCp));
console.log("SC013_PREFLIGHT_SINGLE_EXTRA_INDEX="+String(singleExtraIndex));
console.log("SC013_PREFLIGHT_SINGLE_EXTRA_CODEPOINT="+String(singleExtraCodePoint));
console.log("SC013_PREFLIGHT_DRAFT_HAS_CORRELATION="+String(draftText.includes("MAGASIN_CYCLE_CORRELATION_V1 "+id)));
console.log("SC013_PREFLIGHT_NONWHITESPACE_MATCH="+String(compact(draftText)===compact(message)));
console.log("SC013_PREFLIGHT_MATCHING_USER_TURN="+String(Boolean(matching?.confirmed)));
console.log("SC013_PREFLIGHT_MATCHING_EVIDENCE="+String(matching?.evidence||""));
const safe=Boolean(
  ["PREPARED","ENQUEUED"].includes(String(state.outbound?.state||"").toUpperCase()) &&
  state.outbound?.kind==="SOURCE_OF_TRUTH_TASK_DISCOVERY" &&
  strict===state.outbound?.message_digest &&
  !matching?.confirmed &&
  (!draft?.has_text || draft?.digest===strict || draft?.rendered_digest===rendered || ownedDraft)
);
console.log("SC013_PREFLIGHT_SAFE_TO_RECOVER="+String(safe));
process.exit(safe?0:7);
