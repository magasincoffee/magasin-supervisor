import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeRoot,statePath,cdpUrl]=process.argv.slice(2);
const mod=async(rel)=>import(pathToFileURL(path.join(runtimeRoot,...rel.split("/"))).href);
const {ChatGptUiAdapter}=await mod("src/ui/playwright-adapter.mjs");
const {buildSingleConversationTaskDiscoveryInstruction}=await mod("src/runtime/single-conversation-loop.mjs");
const {readSingleConversationState}=await mod("src/runtime/single-conversation-state.mjs");
const {opaqueRuntimeIdentity}=await mod("src/runtime/single-conversation-bootstrap.mjs");

const state=await readSingleConversationState(statePath);
const expected=buildSingleConversationTaskDiscoveryInstruction({
  sourceOfTruthUrl:state.source_of_truth.url,
  messageId:state.outbound.message_id
});
const norm=(v)=>String(v||"")
 .replace(/[\u200B-\u200F\u2060\uFEFF]/g,"")
 .replace(/\r\n/g,"\n")
 .replace(/\u00A0/g," ")
 .replace(/\s+/gu," ")
 .replace(/\bSOT=\s+(https?:\/\/)/giu,"SOT=$1")
 .trim();
const esc=(v)=>String(v||"").replace(/\n/g,"\\n").replace(/\r/g,"\\r").replace(/\t/g,"\\t");

const adapter=new ChatGptUiAdapter({cdpUrl,settleMs:0,actionTimeoutMs:4000,timeoutMs:12000});
try{
  await adapter.open();
  const rid=String(state.conversation.runtime_id||"");
  let page=adapter.getChatGptPages().find(p=>opaqueRuntimeIdentity(p.url())===rid)||null;
  if(!page) page=adapter.getChatGptPages().find(p=>/\/c\//.test(new URL(p.url()).pathname))||null;
  if(!page) throw new Error("conversation page not found");

  const turns=await page.evaluate(()=>{
    const nodes=[
      ...document.querySelectorAll('[data-message-author-role="user"]'),
      ...document.querySelectorAll("main .text-size-chat.whitespace-pre-wrap")
    ];
    const seen=new Set(), out=[];
    for(const node of nodes){
      if(!node||seen.has(node)) continue;
      seen.add(node);
      if(node.matches?.("#prompt-textarea,textarea,[contenteditable='true'],[contenteditable='plaintext-only']")||node.closest?.("#prompt-textarea")) continue;
      out.push({
        innerText:String(node.innerText||""),
        textContent:String(node.textContent||""),
        testid:String(node.closest?.("[data-testid^='conversation-turn-']")?.getAttribute?.("data-testid")||"")
      });
    }
    return out;
  });

  console.log("TURN_DIFF_COUNT="+turns.length);
  console.log("TURN_DIFF_EXPECTED_LEN="+expected.length);
  console.log("TURN_DIFF_EXPECTED_NORM_LEN="+norm(expected).length);
  for(let i=0;i<turns.length;i++){
    const actual=turns[i].innerText||turns[i].textContent||"";
    const a=norm(actual), e=norm(expected);
    let d=0; while(d<Math.min(a.length,e.length)&&a[d]===e[d]) d++;
    console.log("TURN_DIFF_"+(i+1)+"_TESTID="+turns[i].testid);
    console.log("TURN_DIFF_"+(i+1)+"_INNER_LEN="+turns[i].innerText.length);
    console.log("TURN_DIFF_"+(i+1)+"_TEXTCONTENT_LEN="+turns[i].textContent.length);
    console.log("TURN_DIFF_"+(i+1)+"_NORM_LEN="+a.length);
    console.log("TURN_DIFF_"+(i+1)+"_MATCH="+String(a===e));
    console.log("TURN_DIFF_"+(i+1)+"_FIRST_DIFF="+d);
    const start=Math.max(0,d-100), end=Math.min(Math.max(a.length,e.length),d+220);
    console.log("TURN_DIFF_"+(i+1)+"_EXPECTED_SNIP="+esc(e.slice(start,end)));
    console.log("TURN_DIFF_"+(i+1)+"_ACTUAL_SNIP="+esc(a.slice(start,end)));
  }
}finally{
  await adapter.close().catch(()=>{});
}
