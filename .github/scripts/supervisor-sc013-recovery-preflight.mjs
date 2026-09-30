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
console.log("SC013_PREFLIGHT_CHAT_PAGES="+pages.length);
console.log("SC013_PREFLIGHT_DRAFT_READY="+String(draft?.ready));
console.log("SC013_PREFLIGHT_DRAFT_HAS_TEXT="+String(draft?.has_text));
console.log("SC013_PREFLIGHT_DRAFT_STRICT_MATCH="+String(draft?.digest===strict));
console.log("SC013_PREFLIGHT_DRAFT_RENDERED_MATCH="+String(draft?.rendered_digest===rendered));
console.log("SC013_PREFLIGHT_MATCHING_USER_TURN="+String(Boolean(matching?.confirmed)));
console.log("SC013_PREFLIGHT_MATCHING_EVIDENCE="+String(matching?.evidence||""));
const safe=Boolean(
  ["PREPARED","ENQUEUED"].includes(String(state.outbound?.state||"").toUpperCase()) &&
  state.outbound?.kind==="SOURCE_OF_TRUTH_TASK_DISCOVERY" &&
  strict===state.outbound?.message_digest &&
  !matching?.confirmed &&
  (!draft?.has_text || draft?.digest===strict || draft?.rendered_digest===rendered)
);
console.log("SC013_PREFLIGHT_SAFE_TO_RECOVER="+String(safe));
process.exit(safe?0:7);
