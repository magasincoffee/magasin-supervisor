import { pathToFileURL } from "node:url";
import path from "node:path";
const [runtimeRoot, cdpUrl] = process.argv.slice(2);
const adapterUrl=pathToFileURL(path.join(runtimeRoot,"src","ui","playwright-adapter.mjs")).href;
const actionsUrl=pathToFileURL(path.join(runtimeRoot,"src","ui","actions.mjs")).href;
const {ChatGptUiAdapter}=await import(adapterUrl);
const {inspectComposerDraftDigest}=await import(actionsUrl);
const adapter=new ChatGptUiAdapter({cdpUrl,settleMs:0,actionTimeoutMs:3000,timeoutMs:10000});
try{
  await adapter.open();
  const pages=adapter.getChatGptPages();
  console.log("DIGEST_CHAT_PAGE_COUNT="+pages.length);
  const page=pages[0]||adapter.getActivePage();
  if(!page) throw new Error("no ChatGPT page");
  const d=await inspectComposerDraftDigest(page,{timeoutMs:1500});
  console.log("DIGEST_DRAFT_READY="+Boolean(d?.ready));
  console.log("DIGEST_DRAFT_HAS_TEXT="+String(d?.has_text));
  console.log("DIGEST_DRAFT_SHA256="+String(d?.digest||""));
  console.log("DIGEST_DRAFT_NORMALIZED_LEN="+String(d?.normalized_text?.length||0));
}finally{
  await adapter.close().catch(()=>{});
  process.exit(0);
}
