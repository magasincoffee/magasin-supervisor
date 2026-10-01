import path from "node:path";
import { pathToFileURL } from "node:url";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const runtimeRoot = arg("--runtime");
const statePath = arg("--state");
const cdpUrl = arg("--cdp-url");
if (!runtimeRoot || !statePath || !cdpUrl) throw new Error("runtime/state/cdp required");

const mod = (rel) => pathToFileURL(path.join(runtimeRoot, rel)).href;
const [{ ChatGptUiAdapter }, actions, bootstrap, stateModule, latestTurn] = await Promise.all([
  import(mod("src/ui/playwright-adapter.mjs")),
  import(mod("src/ui/actions.mjs")),
  import(mod("src/runtime/single-conversation-bootstrap.mjs")),
  import(mod("src/runtime/single-conversation-state.mjs")),
  import(mod("src/ui/latest-turn.mjs"))
]);

const state = await stateModule.readSingleConversationState(statePath);
const instruction = bootstrap.buildSingleConversationBootstrap({
  sourceOfTruthUrl: state.source_of_truth.url,
  messageId: String(state.outbound.message_id || ""),
  qualificationOnly: false
});

let adapter = null;
const out = [];
const emit = (k,v) => out.push(k + "=" + String(v ?? ""));

try {
  adapter = new ChatGptUiAdapter({
    cdpUrl,
    settleMs: 50,
    actionTimeoutMs: 2000,
    timeoutMs: 5000
  });
  await adapter.open();
  const pages = adapter.getChatGptPages();
  emit("DIAG_PAGE_COUNT", pages.length);
  const page = adapter.getActivePage() || pages[0] || null;
  if (!page) {
    emit("DIAG_NO_PAGE", true);
  } else {
    const probe = await adapter.probePage(page).catch((e) => ({ error:e }));
    if (probe?.error) {
      emit("DIAG_PROBE_ERROR", probe.error?.code || probe.error?.message || probe.error);
    } else {
      const s = probe.snapshot || {};
      emit("DIAG_CONVERSATION_PATH", Boolean(s.conversationPath));
      emit("DIAG_STRUCTURED_TURN_COUNT", Number(s.conversationTurnElementCount || 0));
      emit("DIAG_USER_MESSAGE_COUNT", Number(s.userMessageCount || 0));
      emit("DIAG_ASSISTANT_MESSAGE_COUNT", Number(s.assistantMessageCount || 0));
      emit("DIAG_COMPOSER_READY", Boolean(s.composerReady));
      emit("DIAG_COMPOSER_TEXT_READABLE", s.composerTextReadable === true);
      emit("DIAG_COMPOSER_HAS_TEXT", s.composerHasText === true);
      emit("DIAG_RESPONSE_RUNNING", Boolean(s.responseRunning));
    }

    const exact = await actions.captureMatchingUserTurnEvidence(page, instruction)
      .catch((e) => ({ error:String(e?.code || e?.message || e) }));
    emit("DIAG_EXACT_CONFIRMED", Boolean(exact?.confirmed));
    emit("DIAG_EXACT_EVIDENCE", exact?.evidence || "");
    emit("DIAG_EXACT_TURN_ID", exact?.turn_id || "");
    emit("DIAG_EXACT_TOTAL_COUNT", Number(exact?.totalCount || 0));
    emit("DIAG_EXACT_ERROR", exact?.error || "");

    const latestUser = await latestTurn.captureLatestRoleTurn(page, "user").catch(() => null);
    const latestAssistant = await latestTurn.captureLatestRoleTurn(page, "assistant").catch(() => null);
    emit("DIAG_LATEST_USER_PRESENT", Boolean(latestUser));
    emit("DIAG_LATEST_USER_TURN_ID", latestUser?.turn_id || "");
    const latestUserText = String(latestUser?.text || "");
    emit("DIAG_LATEST_USER_CHAR_COUNT", latestUserText.length);
    emit("DIAG_EXPECTED_CHAR_COUNT", instruction.length);
    emit("DIAG_STRICT_DIGEST_MATCH",
      Boolean(latestUserText) &&
      actions.composerInstructionDigest(latestUserText) === actions.composerInstructionDigest(instruction)
    );
    emit("DIAG_RENDERED_DIGEST_MATCH",
      Boolean(latestUserText) &&
      actions.composerRenderedInstructionDigest(latestUserText) === actions.composerRenderedInstructionDigest(instruction)
    );
    emit("DIAG_HAS_BOOTSTRAP_MARKER",
      latestUserText.includes("MAGASIN_SINGLE_CONVERSATION_BOOTSTRAP_V1")
    );
    emit("DIAG_HAS_CURRENT_MESSAGE_ID",
      latestUserText.includes(String(state.outbound.message_id || ""))
    );
    emit("DIAG_HAS_CURRENT_SOT_URL",
      latestUserText.includes(String(state.source_of_truth.url || ""))
    );
    emit("DIAG_LATEST_ASSISTANT_PRESENT", Boolean(latestAssistant));
    emit("DIAG_LATEST_ASSISTANT_TURN_ID", latestAssistant?.turn_id || "");
    emit("DIAG_LATEST_ASSISTANT_CHAR_COUNT", String(latestAssistant?.text || "").length);
  }
} finally {
  if (adapter) {
    await Promise.race([
      adapter.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
  }
  process.stdout.write(out.join("\n") + "\n", () => process.exit(0));
}
