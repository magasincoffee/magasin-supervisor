import path from "node:path";
import { pathToFileURL } from "node:url";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const statePath = arg("--state");
const cdpUrl = arg("--cdp-url");
const runtimeRoot = arg("--runtime");
if (!statePath || !cdpUrl || !runtimeRoot) throw new Error("state/cdp/runtime required");

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
const emit = (k, v) => out.push(String(k) + "=" + String(v));
let adapter = null;

try {
  const state = await readSingleConversationState(statePath);
  const messageId = String(state?.outbound?.message_id || "").trim();
  const source = String(state?.source_of_truth?.url || "").trim();

  adapter = new ChatGptUiAdapter({
    cdpUrl,
    settleMs: 150,
    actionTimeoutMs: 2500,
    timeoutMs: 8000
  });
  await adapter.open();

  const original = adapter.getActivePage();
  emit("DIAG_ORIGINAL_URL_KIND", (() => {
    try { return new URL(original?.url?.() || "").pathname || "/"; } catch { return "invalid"; }
  })());

  const urls = await adapter.listRecentConversationUrls(original, { limit: 50 }).catch(() => []);
  emit("DIAG_RECENT_COUNT", urls.length);

  let matchCount = 0;
  let matchedRuntimeId = "";
  let checked = 0;

  for (const url of urls.slice(0, 50)) {
    let page = null;
    try {
      page = await adapter.reopenTargetPage(url);
      await new Promise((resolve) => setTimeout(resolve, 900));
      const probe = await adapter.probePage(page).catch(() => null);
      const snapshot = probe?.snapshot || {};
      if (!snapshot.conversationPath || snapshot.loginRequired || snapshot.hasCaptcha) {
        continue;
      }
      const evidence = await captureCorrelatedBootstrapUserTurnEvidence(page, {
        messageId,
        sourceOfTruthUrl: source
      }).catch(() => null);
      checked += 1;
      if (evidence?.confirmed) {
        matchCount += 1;
        matchedRuntimeId = opaqueRuntimeIdentity(page.url()) || "";
        emit("DIAG_MATCH_EVIDENCE", evidence.evidence || "");
        emit("DIAG_MATCH_TURN_COUNT", Number(evidence.total_count || 0));
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

  emit("DIAG_CHECKED_CONVERSATIONS", checked);
  emit("DIAG_MATCH_COUNT", matchCount);
  emit("DIAG_MATCH_RUNTIME_ID_PRESENT", Boolean(matchedRuntimeId));
} finally {
  if (adapter) {
    await Promise.race([
      adapter.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
  }
  process.stdout.write(out.join("\n") + "\n", () => process.exit(0));
}
