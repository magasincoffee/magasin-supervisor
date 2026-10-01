import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import {
  captureMatchingUserTurnEvidence,
  inspectComposerDraftDigest
} from "../../src/ui/actions.mjs";
import {
  buildSingleConversationBootstrap
} from "../../src/runtime/single-conversation-bootstrap.mjs";
import {
  readSingleConversationState
} from "../../src/runtime/single-conversation-state.mjs";

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const statePath = argValue("--state");
const cdpUrl = argValue("--cdp-url");
if (!statePath || !cdpUrl) throw new Error("state/cdp required");

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
