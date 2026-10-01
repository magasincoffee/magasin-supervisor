import path from "node:path";
import { pathToFileURL } from "node:url";

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const statePath = argValue("--state");
const cdpUrl = argValue("--cdp-url");
const runtimeRoot = argValue("--runtime");
if (!statePath || !cdpUrl || !runtimeRoot) {
  throw new Error("state/cdp/runtime required");
}

const mod = (rel) => pathToFileURL(path.join(runtimeRoot, rel)).href;
const [{ ChatGptUiAdapter }, actions, bootstrap, stateModule, cli] = await Promise.all([
  import(mod("src/ui/playwright-adapter.mjs")),
  import(mod("src/ui/actions.mjs")),
  import(mod("src/runtime/single-conversation-bootstrap.mjs")),
  import(mod("src/runtime/single-conversation-state.mjs")),
  import(mod("src/runtime/single-conversation-cli.mjs"))
]);

const {
  captureMatchingUserTurnEvidence,
  inspectComposerDraftDigest
} = actions;
const { buildSingleConversationBootstrap } = bootstrap;
const { readSingleConversationState } = stateModule;
const {
  preparedBootstrapIsStaleEnough,
  waitForPositiveBlankBootstrapNonDelivery
} = cli;

let adapter = null;
const output = [];
const emit = (value) => output.push(String(value));

try {
  const state = await readSingleConversationState(statePath);
  const messageId = String(state?.outbound?.message_id || "").trim();
  const message = buildSingleConversationBootstrap({
    sourceOfTruthUrl: state.source_of_truth.url,
    messageId,
    qualificationOnly: false
  });

  adapter = new ChatGptUiAdapter({
    cdpUrl,
    settleMs: 50,
    actionTimeoutMs: 2_000,
    timeoutMs: 5_000
  });
  await adapter.open();

  emit("DIAG_PREPARED_STALE_ENOUGH=" + preparedBootstrapIsStaleEnough(state));
  const helperStarted = Date.now();
  const helperPage = await waitForPositiveBlankBootstrapNonDelivery(
    adapter,
    adapter.getActivePage(),
    {
      timeoutMs: 30_000,
      pollMs: 750,
      stablePasses: 2,
      expectedInstruction: message
    }
  ).catch((e) => {
    emit("DIAG_HELPER_ERROR=" + String(e?.code || e?.message || e));
    emit("DIAG_HELPER_ERROR_STAGE=" + String(e?.runtime_stage || ""));
    return null;
  });
  emit("DIAG_HELPER_RESULT=" + Boolean(helperPage));
  emit("DIAG_HELPER_ELAPSED_MS=" + (Date.now() - helperStarted));

  const pages = adapter.getChatGptPages();
  emit("DIAG_PAGE_COUNT=" + pages.length);
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    emit("DIAG_PAGE_INDEX=" + i);
    emit("DIAG_PAGE_URL=" + page.url());
    const probe = await adapter.probePage(page).catch((e) => ({ error: e }));
    if (probe?.error) {
      emit("DIAG_PROBE_ERROR=" + String(probe.error?.code || probe.error?.message || probe.error));
      continue;
    }
    const s = probe.snapshot || {};
    emit("DIAG_CONVERSATION_PATH=" + Boolean(s.conversationPath));
    emit("DIAG_COMPOSER_READY=" + Boolean(s.composerReady));
    emit("DIAG_RESPONSE_RUNNING=" + Boolean(s.responseRunning));
    emit("DIAG_LOGIN_REQUIRED=" + Boolean(s.loginRequired));
    emit("DIAG_CAPTCHA=" + Boolean(s.hasCaptcha));
    emit("DIAG_NETWORK_ERROR=" + Boolean(s.hasNetworkError));
    emit("DIAG_TRANSIENT_ERROR=" + Boolean(s.hasTransientError));
    emit("DIAG_CONVERSATION_MISSING=" + Boolean(s.conversationMissing));
    emit("DIAG_ACCESS_DENIED=" + Boolean(s.conversationAccessDenied));
    emit("DIAG_STRUCTURED_TURN_COUNT=" + Number(s.conversationTurnElementCount || 0));
    emit("DIAG_USER_MESSAGE_COUNT=" + Number(s.userMessageCount || 0));
    emit("DIAG_ASSISTANT_MESSAGE_COUNT=" + Number(s.assistantMessageCount || 0));

    const exact = await captureMatchingUserTurnEvidence(page, message).catch((e) => ({
      error: String(e?.code || e?.message || e)
    }));
    emit("DIAG_EXACT_CONFIRMED=" + Boolean(exact?.confirmed));
    emit("DIAG_EXACT_EVIDENCE=" + String(exact?.evidence || ""));
    emit("DIAG_EXACT_TOTAL_COUNT=" + Number(exact?.totalCount || 0));
    emit("DIAG_EXACT_ERROR=" + String(exact?.error || ""));

    const draft = await inspectComposerDraftDigest(page, { timeoutMs: 1_500 }).catch((e) => ({
      error: String(e?.code || e?.message || e)
    }));
    emit("DIAG_DRAFT_READY=" + String(draft?.ready));
    emit("DIAG_DRAFT_HAS_TEXT=" + String(draft?.has_text));
    emit("DIAG_DRAFT_LENGTH=" + String(draft?.normalized_text || "").length);
    emit("DIAG_DRAFT_ERROR=" + String(draft?.error || ""));
  }
} finally {
  if (adapter) {
    await Promise.race([
      adapter.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
  }
  process.stdout.write(output.join("\n") + "\n", () => process.exit(0));
}
