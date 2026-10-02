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
  recoverCorrelatedPreparedBootstrapDelivery
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

  emit("REPAIR_STATE_BEFORE", String(state?.outbound?.state || ""));
  emit("REPAIR_RETRY_COUNT_BEFORE", Number(state?.outbound?.retry_count || 0));

  adapter = new ChatGptUiAdapter({
    cdpUrl,
    settleMs: 200,
    actionTimeoutMs: 2500,
    timeoutMs: 8000
  });
  await adapter.open();
  const original = adapter.getActivePage();

  const matches = [];
  for (const url of (Array.isArray(urls) ? urls : []).slice(0, 50)) {
    let page = null;
    let keep = false;
    try {
      page = await adapter.reopenTargetPage(url);
      let evidence = null;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const probe = await adapter.probePage(page).catch(() => null);
        const snapshot = probe?.snapshot || {};
        if (
          snapshot.conversationPath &&
          !snapshot.loginRequired &&
          !snapshot.hasCaptcha &&
          !snapshot.hasNetworkError &&
          !snapshot.hasTransientError
        ) {
          evidence = await captureCorrelatedBootstrapUserTurnEvidence(page, {
            messageId,
            sourceOfTruthUrl: source
          }).catch(() => null);
          if (evidence?.confirmed) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (evidence?.confirmed) {
        matches.push({ page, evidence });
        keep = true;
      }
    } finally {
      if (!keep && page && original && page !== original) {
        await adapter.closePage(page).catch(() => {});
        if (!original.isClosed?.()) {
          try { adapter.setActivePage(original); } catch {}
        }
      }
    }
  }

  emit("REPAIR_MATCH_COUNT", matches.length);
  if (matches.length !== 1) {
    throw new Error("Expected exactly one correlated bootstrap conversation");
  }

  const match = matches[0];
  adapter.setActivePage(match.page);

  const recovered = await recoverCorrelatedPreparedBootstrapDelivery({
    adapter,
    statePath,
    sourceOfTruthUrl: source,
    qualificationOnly: false,
    timeoutMs: 120_000,
    pollMs: 750
  });

  emit("REPAIR_RECOVERED", Boolean(recovered?.recovered));
  emit("REPAIR_RESPONSE_STATUS", String(recovered?.response?.status || ""));
  emit("REPAIR_USER_TURN_EVIDENCE", String(recovered?.user_turn_evidence || ""));
  emit("REPAIR_RUNTIME_ID_PRESENT", Boolean(recovered?.runtime_id));

  const after = await readSingleConversationState(statePath);
  emit("REPAIR_STATE_AFTER", String(after?.outbound?.state || ""));
  emit("REPAIR_AUTOMATION_AFTER", String(after?.automation?.status || ""));
  emit("REPAIR_PHASE_AFTER", String(after?.automation?.phase || ""));
  emit("REPAIR_RUNTIME_ID_AFTER_PRESENT", Boolean(String(after?.conversation?.runtime_id || "").trim()));
} finally {
  if (adapter) {
    await Promise.race([
      adapter.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
  }
  process.stdout.write(out.join("\n") + "\n", () => process.exit(0));
}
