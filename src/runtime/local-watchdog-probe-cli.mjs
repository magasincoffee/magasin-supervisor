import { ChatGptUiAdapter } from "../ui/playwright-adapter.mjs";
import { inspectComposerDraftDigest } from "../ui/actions.mjs";
import { opaqueRuntimeIdentity } from "./single-conversation-bootstrap.mjs";
import { readSingleConversationState } from "./single-conversation-state.mjs";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const statePath = argValue("--state");
const cdpUrl = argValue("--cdp-url");

if (!statePath) throw new Error("--state is required");
if (!cdpUrl) throw new Error("--cdp-url is required");

let adapter = null;
const result = {
  schema_version: 1,
  timestamp: new Date().toISOString(),
  expected_runtime_id_present: false,
  page_count: 0,
  exact_runtime_match: false,
  ui_state: "UNAVAILABLE",
  observation: "UNAVAILABLE",
  conversation_path: false,
  composer_ready: false,
  response_running: false,
  assistant_busy: false,
  login_required: false,
  has_captcha: false,
  has_network_error: false,
  has_transient_error: false,
  has_continue_control: false,
  has_retry_control: false,
  conversation_full: false,
  conversation_missing: false,
  conversation_access_denied: false,
  draft_readable: false,
  draft_has_text: null,
  draft_digest: null,
  draft_rendered_digest: null,
  draft_length: 0,
  probe_error: null
};

try {
  const state = await readSingleConversationState(statePath);
  const expectedRuntimeId = String(state?.conversation?.runtime_id || "").trim();
  result.expected_runtime_id_present = Boolean(expectedRuntimeId);

  adapter = new ChatGptUiAdapter({
    cdpUrl,
    settleMs: 50,
    actionTimeoutMs: 2_000,
    timeoutMs: 5_000
  });

  await Promise.race([
    adapter.open(),
    new Promise((_, reject) => setTimeout(() => {
      const error = new Error("CDP_PROBE_OPEN_TIMEOUT");
      error.code = "CDP_PROBE_OPEN_TIMEOUT";
      reject(error);
    }, 2_500))
  ]);
  const pages = adapter.getChatGptPages();
  result.page_count = pages.length;

  let page = null;
  if (expectedRuntimeId) {
    page = pages.find((candidate) => {
      try {
        return opaqueRuntimeIdentity(String(candidate.url?.() || "")) === expectedRuntimeId;
      } catch {
        return false;
      }
    }) || null;
  }

  result.exact_runtime_match = Boolean(page);
  if (!page) page = adapter.getActivePage();

  if (!page) {
    result.probe_error = "NO_CHATGPT_PAGE";
  } else {
    const probe = await Promise.race([
      adapter.probePage(page),
      new Promise((_, reject) => setTimeout(() => {
        const error = new Error("CDP_PROBE_PAGE_TIMEOUT");
        error.code = "CDP_PROBE_PAGE_TIMEOUT";
        reject(error);
      }, 2_500))
    ]);
    const snapshot = probe?.snapshot || {};
    const classification = probe?.classification || {};

    result.ui_state = String(classification.uiState || "UNKNOWN");
    result.observation = String(classification.observation || "UNKNOWN");
    result.conversation_path = Boolean(snapshot.conversationPath);
    result.composer_ready = Boolean(snapshot.composerReady);
    result.response_running = Boolean(snapshot.responseRunning);
    result.assistant_busy = Boolean(snapshot.assistantBusy);
    result.login_required = Boolean(snapshot.loginRequired);
    result.has_captcha = Boolean(snapshot.hasCaptcha);
    result.has_network_error = Boolean(snapshot.hasNetworkError);
    result.has_transient_error = Boolean(snapshot.hasTransientError);
    result.has_continue_control = Boolean(snapshot.hasContinueControl);
    result.has_retry_control = Boolean(snapshot.hasRetryControl);
    result.conversation_full = Boolean(snapshot.conversationFull);
    result.conversation_missing = Boolean(snapshot.conversationMissing);
    result.conversation_access_denied = Boolean(snapshot.conversationAccessDenied);

    result.draft_readable = snapshot.composerTextReadable === true;
    result.draft_has_text = result.draft_readable
      ? Boolean(snapshot.composerHasText)
      : null;
    result.draft_length = result.draft_readable
      ? Number(snapshot.composerTextCharCount || 0)
      : 0;

    // Only perform the slower digest read when text is actually present.
    // An empty draft is already proven by the same DOM snapshot that proved
    // composer readiness; a timeout here must never be misreported as empty.
    if (result.draft_has_text === true) {
      const draft = await inspectComposerDraftDigest(page, { timeoutMs: 1_000 })
        .catch(() => null);
      result.draft_digest = draft?.digest || null;
      result.draft_rendered_digest = draft?.rendered_digest || null;
    }
  }
} catch (error) {
  result.probe_error = String(error?.code || error?.message || "PROBE_FAILED").slice(0, 240);
} finally {
  if (adapter) {
    await Promise.race([
      adapter.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1_000))
    ]).catch(() => {});
  }
}

// A CDP-attached Playwright browser transport can keep Node's event loop alive
// even after all read-only observations have completed. Flush the single JSON
// result, then terminate this disposable probe process explicitly. Do not
// close the attached production browser or context from this observer.
process.stdout.write(JSON.stringify(result), () => process.exit(0));
