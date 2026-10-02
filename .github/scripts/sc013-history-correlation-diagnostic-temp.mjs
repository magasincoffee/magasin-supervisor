import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const statePath = arg("--state");
const cdpUrl = arg("--cdp-url");
const runtimeRoot = arg("--runtime");
const candidatesPath = arg("--candidates");
if (!statePath || !cdpUrl || !runtimeRoot || !candidatesPath) {
  throw new Error("state/cdp/runtime/candidates required");
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
const urls = JSON.parse(await fs.readFile(candidatesPath, "utf8"));

const out = [];
const emit = (k, v) => out.push(String(k) + "=" + String(v));
let adapter = null;
try {
  const state = await readSingleConversationState(statePath);
  const messageId = String(state?.outbound?.message_id || "").trim();
  const source = String(state?.source_of_truth?.url || "").trim();

  adapter = new ChatGptUiAdapter({
    cdpUrl,
    settleMs: 200,
    actionTimeoutMs: 2500,
    timeoutMs: 8000
  });
  await adapter.open();
  const original = adapter.getActivePage();

  emit("DIAG_HISTORY_CANDIDATE_COUNT", Array.isArray(urls) ? urls.length : 0);
  let checked = 0;
  let matchCount = 0;
  let matchedRuntime = "";

  for (const url of (Array.isArray(urls) ? urls : []).slice(0, 100)) {
    let page = null;
    try {
      page = await adapter.reopenTargetPage(url);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const probe = await adapter.probePage(page).catch(() => null);
      const snapshot = probe?.snapshot || {};
      if (!snapshot.conversationPath || snapshot.loginRequired || snapshot.hasCaptcha) continue;
      checked += 1;
      const evidence = await captureCorrelatedBootstrapUserTurnEvidence(page, {
        messageId,
        sourceOfTruthUrl: source
      }).catch(() => null);
      if (evidence?.confirmed) {
        matchCount += 1;
        matchedRuntime = opaqueRuntimeIdentity(page.url()) || "";
        emit("DIAG_MATCH_EVIDENCE", evidence.evidence || "");
        emit("DIAG_MATCH_TOTAL_TURNS", Number(evidence.total_count || 0));
      }
    } finally {
      if (page && original && page !== original) {
        await adapter.closePage(page).catch(() => {});
        if (!original.isClosed?.()) {
          try { adapter.setActivePage(original); } catch {}
        }
      }
    }
  }

  emit("DIAG_HISTORY_CHECKED", checked);
  emit("DIAG_HISTORY_MATCH_COUNT", matchCount);
  emit("DIAG_MATCH_RUNTIME_ID", matchedRuntime);
} finally {
  if (adapter) {
    await Promise.race([
      adapter.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
  }
  process.stdout.write(out.join("\n") + "\n", () => process.exit(0));
}
