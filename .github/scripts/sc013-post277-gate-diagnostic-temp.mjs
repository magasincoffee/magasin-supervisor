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
  console.log("DIAG_PAGE_COUNT=" + pages.length);
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    console.log("DIAG_PAGE_INDEX=" + i);
    console.log("DIAG_PAGE_URL=" + page.url());
    const probe = await adapter.probePage(page).catch((e) => ({ error: e }));
    if (probe?.error) {
      console.log("DIAG_PROBE_ERROR=" + String(probe.error?.code || probe.error?.message || probe.error));
      continue;
    }
    const s = probe.snapshot || {};
    console.log("DIAG_CONVERSATION_PATH=" + Boolean(s.conversationPath));
    console.log("DIAG_COMPOSER_READY=" + Boolean(s.composerReady));
    console.log("DIAG_RESPONSE_RUNNING=" + Boolean(s.responseRunning));
    console.log("DIAG_LOGIN_REQUIRED=" + Boolean(s.loginRequired));
    console.log("DIAG_CAPTCHA=" + Boolean(s.hasCaptcha));
    console.log("DIAG_NETWORK_ERROR=" + Boolean(s.hasNetworkError));
    console.log("DIAG_TRANSIENT_ERROR=" + Boolean(s.hasTransientError));
    console.log("DIAG_CONVERSATION_MISSING=" + Boolean(s.conversationMissing));
    console.log("DIAG_ACCESS_DENIED=" + Boolean(s.conversationAccessDenied));
    console.log("DIAG_STRUCTURED_TURN_COUNT=" + Number(s.conversationTurnElementCount || 0));
    console.log("DIAG_USER_MESSAGE_COUNT=" + Number(s.userMessageCount || 0));
    console.log("DIAG_ASSISTANT_MESSAGE_COUNT=" + Number(s.assistantMessageCount || 0));

    const exact = await captureMatchingUserTurnEvidence(page, message).catch((e) => ({
      error: String(e?.code || e?.message || e)
    }));
    console.log("DIAG_EXACT_CONFIRMED=" + Boolean(exact?.confirmed));
    console.log("DIAG_EXACT_EVIDENCE=" + String(exact?.evidence || ""));
    console.log("DIAG_EXACT_TOTAL_COUNT=" + Number(exact?.totalCount || 0));
    console.log("DIAG_EXACT_ERROR=" + String(exact?.error || ""));

    const draft = await inspectComposerDraftDigest(page, { timeoutMs: 1_500 }).catch((e) => ({
      error: String(e?.code || e?.message || e)
    }));
    console.log("DIAG_DRAFT_READY=" + String(draft?.ready));
    console.log("DIAG_DRAFT_HAS_TEXT=" + String(draft?.has_text));
    console.log("DIAG_DRAFT_LENGTH=" + String(draft?.normalized_text || "").length);
    console.log("DIAG_DRAFT_ERROR=" + String(draft?.error || ""));
  }
} finally {
  if (adapter) {
    await Promise.race([
      adapter.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]).catch(() => {});
  }
  process.exit(0);
}
