import path from "node:path";
import { pathToFileURL } from "node:url";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const statePath = arg("--state");
const cdpUrl = arg("--cdp-url");
const runtimeRoot = arg("--runtime");
const targetRuntimeId = arg("--runtime-id");
if (!statePath || !cdpUrl || !runtimeRoot || !targetRuntimeId) {
  throw new Error("state/cdp/runtime/runtime-id required");
}

const mod = (rel) => pathToFileURL(path.join(runtimeRoot, rel)).href;
const [{ ChatGptUiAdapter }, bootstrap, stateModule] = await Promise.all([
  import(mod("src/ui/playwright-adapter.mjs")),
  import(mod("src/runtime/single-conversation-bootstrap.mjs")),
  import(mod("src/runtime/single-conversation-state.mjs"))
]);

const {
  captureCorrelatedBootstrapUserTurnEvidence,
  opaqueRuntimeIdentity
} = bootstrap;
const { readSingleConversationState } = stateModule;

const out = [];
const emit = (k,v) => out.push(String(k)+"="+String(v));
let adapter=null;
try {
  const state=await readSingleConversationState(statePath);
  const messageId=String(state?.outbound?.message_id||"").trim();
  const source=String(state?.source_of_truth?.url||"").trim();

  adapter=new ChatGptUiAdapter({
    cdpUrl,
    settleMs:150,
    actionTimeoutMs:2500,
    timeoutMs:8000
  });
  await adapter.open();
  const original=adapter.getActivePage();
  const recent=await adapter.listRecentConversationUrls(original,{limit:50}).catch(()=>[]);
  const matches=recent.filter(url=>opaqueRuntimeIdentity(url)===targetRuntimeId);
  emit("DIAG_TARGET_URL_MATCH_COUNT",matches.length);
  if(matches.length!==1) throw new Error("target runtime identity not uniquely present in Recent");

  const page=await adapter.reopenTargetPage(matches[0]);
  const started=Date.now();
  let evidence=null;
  let firstPositiveMs=-1;
  let attempts=0;
  for(let i=0;i<120;i+=1){
    attempts+=1;
    evidence=await captureCorrelatedBootstrapUserTurnEvidence(page,{
      messageId,
      sourceOfTruthUrl:source
    }).catch(()=>null);
    if(evidence?.confirmed){
      firstPositiveMs=Date.now()-started;
      break;
    }
    await new Promise(resolve=>setTimeout(resolve,500));
  }

  emit("DIAG_HYDRATION_ATTEMPTS",attempts);
  emit("DIAG_CORRELATION_CONFIRMED",Boolean(evidence?.confirmed));
  emit("DIAG_FIRST_POSITIVE_MS",firstPositiveMs);
  emit("DIAG_EVIDENCE",String(evidence?.evidence||""));
  emit("DIAG_TOTAL_TURNS",Number(evidence?.total_count||0));

  const probe=await adapter.probePage(page).catch(()=>null);
  emit("DIAG_CONVERSATION_PATH",Boolean(probe?.snapshot?.conversationPath));
  emit("DIAG_RESPONSE_RUNNING",Boolean(probe?.snapshot?.responseRunning));
  emit("DIAG_ASSISTANT_COUNT",Number(probe?.snapshot?.assistantMessageCount||0));

  if(original && page!==original){
    try{adapter.setActivePage(original);}catch{}
    await adapter.closePage(page).catch(()=>{});
  }
} finally {
  if(adapter){
    await Promise.race([
      adapter.close().catch(()=>{}),
      new Promise(resolve=>setTimeout(resolve,1000))
    ]).catch(()=>{});
  }
  process.stdout.write(out.join("\n")+"\n",()=>process.exit(0));
}
