import path from "node:path";
import { pathToFileURL } from "node:url";
const [runtimeRoot,statePath,cdpUrl]=process.argv.slice(2);
const mod=async(rel)=>import(pathToFileURL(path.join(runtimeRoot,...rel.split("/"))).href);
const {ChatGptUiAdapter}=await mod("src/ui/playwright-adapter.mjs");
const {composerInstructionDigest,composerRenderedInstructionDigest}=await mod("src/ui/actions.mjs");
const {buildSingleConversationTaskDiscoveryInstruction}=await mod("src/runtime/single-conversation-loop.mjs");
const {readSingleConversationState}=await mod("src/runtime/single-conversation-state.mjs");
const {opaqueRuntimeIdentity}=await mod("src/runtime/single-conversation-bootstrap.mjs");

const state=await readSingleConversationState(statePath);
const expected=buildSingleConversationTaskDiscoveryInstruction({
  sourceOfTruthUrl:state.source_of_truth.url,
  messageId:state.outbound.message_id
});
const strictExpected=composerInstructionDigest(expected);
const renderedExpected=composerRenderedInstructionDigest(expected);

const adapter=new ChatGptUiAdapter({cdpUrl,settleMs:0,actionTimeoutMs:3000,timeoutMs:10000});
try{
  await adapter.open();
  const wanted=String(state.conversation.runtime_id||"");
  const pages=adapter.getChatGptPages();
  const page=pages.find(p=>opaqueRuntimeIdentity(p.url())===wanted)||
    pages.find(p=>/^https:\/\/chatgpt\.com\/c\//.test(p.url()))||pages[0];
  if(!page) throw new Error("conversation page missing");
  const actual=await page.evaluate(()=>{
    const legacy=[...document.querySelectorAll('[data-message-author-role="user"]')];
    const modern=[...document.querySelectorAll('main .text-size-chat.whitespace-pre-wrap')];
    const nodes=[...legacy,...modern].filter((n,i,a)=>a.indexOf(n)===i).filter(n=>
      !n.matches?.("#prompt-textarea,textarea,[contenteditable='true'],[contenteditable='plaintext-only']") &&
      !n.closest?.("#prompt-textarea")
    );
    const node=nodes.at(-1)||null;
    return node ? String(node.innerText||node.textContent||"") : "";
  });
  const strictActual=composerInstructionDigest(actual);
  const renderedActual=composerRenderedInstructionDigest(actual);
  const normalizeBasic=(v)=>String(v||"").replace(/[\u200B-\u200F\u2060\uFEFF]/g,"").replace(/\r\n/g,"\n").replace(/\u00A0/g," ").replace(/\s+/gu," ").trim();
  const normExpected=normalizeBasic(expected);
  const normActual=normalizeBasic(actual);
  const artifactExpected=normExpected.replace(/\bSOT=\s+(https?:\/\/)/giu,"SOT=$1");
  const artifactActual=normActual.replace(/\bSOT=\s+(https?:\/\/)/giu,"SOT=$1");
  let firstDiff=-1;
  const n=Math.min(artifactExpected.length,artifactActual.length);
  for(let i=0;i<n;i++){if(artifactExpected[i]!==artifactActual[i]){firstDiff=i;break;}}
  if(firstDiff<0 && artifactExpected.length!==artifactActual.length) firstDiff=n;
  console.log("TURNDIFF_EXPECTED_LEN="+expected.length);
  console.log("TURNDIFF_ACTUAL_LEN="+actual.length);
  console.log("TURNDIFF_EXPECTED_STRICT="+strictExpected);
  console.log("TURNDIFF_ACTUAL_STRICT="+strictActual);
  console.log("TURNDIFF_EXPECTED_RENDERED="+renderedExpected);
  console.log("TURNDIFF_ACTUAL_RENDERED="+renderedActual);
  console.log("TURNDIFF_RENDERED_MATCH="+String(renderedExpected===renderedActual));
  console.log("TURNDIFF_SOT_ARTIFACT_NORMALIZED_MATCH="+String(artifactExpected===artifactActual));
  console.log("TURNDIFF_FIRST_DIFF="+firstDiff);
  console.log("TURNDIFF_ACTUAL_HAS_ID="+String(actual.includes(String(state.outbound.message_id))));
  console.log("TURNDIFF_ACTUAL_HAS_HEADER="+String(actual.includes("MAGASIN_DISCOVER_TASK_V1")));
  console.log("TURNDIFF_ACTUAL_HAS_CONTROL_HEADER="+String(actual.includes("MAGASIN_TASK_CONTROL_V1")));
  console.log("TURNDIFF_ACTUAL_HAS_CORRELATION="+String(actual.includes("MAGASIN_CYCLE_CORRELATION_V1")));
}finally{
  await adapter.close().catch(()=>{});
  process.exit(0);
}
