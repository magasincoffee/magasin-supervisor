import crypto, { randomUUID } from "node:crypto";

import { composerInstructionDigest } from "../ui/actions.mjs";
import { captureLatestRoleTurn } from "../ui/latest-turn.mjs";
import { isChatGptUrl } from "../ui/playwright-adapter.mjs";
import {
  beginConversationGeneration,
  ensureSingleConversationState,
  readSingleConversationState,
  writeSingleConversationState
} from "./single-conversation-state.mjs";

const HOME_URL = "https://chatgpt.com/";

function nowIso(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error("invalid timestamp");
  return date.toISOString();
}

function opaqueRuntimeIdentity(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (!isChatGptUrl(parsed.toString())) return null;
    if (!/^\/(?:c|g|project)\//.test(parsed.pathname)) return null;
    return "chat:" + crypto
      .createHash("sha256")
      .update(parsed.origin + parsed.pathname, "utf8")
      .digest("hex")
      .slice(0, 32);
  } catch {
    return null;
  }
}

function pageUrl(page) {
  try {
    return String(page?.url?.() || "");
  } catch {
    return "";
  }
}

function isHomeChatGptPage(page) {
  try {
    const url = new URL(pageUrl(page));
    return isChatGptUrl(url.toString()) && url.pathname === "/";
  } catch {
    return false;
  }
}

function safeErrorCode(error) {
  const explicit = String(error?.code || "").trim();
  if (explicit) return explicit.slice(0, 120);
  const message = String(error?.message || error || "");
  if (/login|required|auth/i.test(message)) return "AUTH_REQUIRED";
  if (/captcha|human/i.test(message)) return "CAPTCHA_REQUIRED";
  if (/composer/i.test(message)) return "COMPOSER_NOT_READY";
  if (/timeout/i.test(message)) return "RESPONSE_TIMEOUT";
  return "BOOTSTRAP_FAILED";
}

export function buildSingleConversationBootstrap({
  sourceOfTruthUrl,
  messageId = randomUUID(),
  qualificationOnly = false
} = {}) {
  const source = String(sourceOfTruthUrl || "").trim();
  const id = String(messageId || "").trim();
  if (!source) throw new Error("sourceOfTruthUrl is required");
  if (!id) throw new Error("messageId is required");

  // The fresh-chat bootstrap is a compact ASCII machine contract. Durable
  // project context lives in Source of Truth; repeating that context here only
  // makes remote composer actuation slower and less reliable.
  const common = [
    "MAGASIN_SINGLE_CONVERSATION_BOOTSTRAP_V1",
    `id=${id}`,
    `SOT=${source}`,
    "Read SOT from the beginning.",
    "SOT is the sole project authority.",
    "Ignore stale chat, memory, README, and historical state.",
    "Derive current project state only from SOT.",
    "Continue only from that authoritative state."
  ];

  if (qualificationOnly) {
    return [
      ...common,
      "QUALIFICATION ONLY: use read-only web access if needed to read SOT; do not write to external systems.",
      "Report the Architecture generation read from SOT.",
      `End exactly: MAGASIN_BOOTSTRAP_CORRELATION_V1 ${id}`
    ].join(" ");
  }

  return [
    ...common,
    "Do one bounded next unit allowed by SOT, or state the blocker.",
    `End with: MAGASIN_BOOTSTRAP_CORRELATION_V1 ${id}`
  ].join(" ");
}


function normalizeBootstrapRenderedText(value) {
  return String(value || "")
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

async function findFreshChatComposer(page, timeoutMs = 8_000) {
  const selectors = [
    "#prompt-textarea:visible",
    "[contenteditable][role='textbox']:visible",
    "textarea:visible",
    "[contenteditable]:visible"
  ];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      const enabled = typeof locator.isEnabled === "function"
        ? await locator.isEnabled().catch(() => false)
        : true;
      if (enabled) return locator;
    }
    await page.waitForTimeout(150);
  }
  return null;
}


function bootstrapTextMismatchDiagnostic(expected, actual) {
  const left = Array.from(normalizeBootstrapRenderedText(expected));
  const right = Array.from(normalizeBootstrapRenderedText(actual));
  const limit = Math.min(left.length, right.length);
  let firstDiff = limit;
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      firstDiff = index;
      break;
    }
  }
  const cp = (value) => value === undefined
    ? "END"
    : "U+" + value.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
  return {
    expected_len: left.length,
    actual_len: right.length,
    first_diff: firstDiff,
    expected_cp: cp(left[firstDiff]),
    actual_cp: cp(right[firstDiff])
  };
}

async function readFreshComposerText(composer) {
  if (!composer) return null;
  if (typeof composer.inputValue === "function") {
    try {
      return await composer.inputValue({ timeout: 800 });
    } catch {}
  }
  if (typeof composer.evaluate === "function") {
    return composer.evaluate((el) => {
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement
      ) {
        return el.value;
      }
      return el.textContent || el.innerText || "";
    }).catch(() => null);
  }
  return null;
}

async function captureExactFreshUserTurn(page, expected) {
  if (!page || typeof page.evaluate !== "function") return null;
  return page.evaluate((wantedRaw) => {
    const normalize = (value) => String(value || "")
      .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\u00A0/g, " ")
      .replace(/\s+/gu, " ")
      .trim();
    const wanted = normalize(wantedRaw);
    const turns = Array.from(
      document.querySelectorAll("main [data-testid^='conversation-turn-']")
    );

    // SC-003 starts from a proven blank chat and performs exactly one send.
    // Therefore the first new conversation-turn containing the exact bootstrap
    // text is positive delivery evidence even if ChatGPT has not hydrated the
    // legacy role attribute yet.
    for (const turn of turns) {
      const turnId = String(turn.getAttribute("data-testid") || "").trim();
      const semanticUser = turn.querySelector('[data-message-author-role="user"]');
      const candidates = [
        semanticUser,
        ...turn.querySelectorAll(
          ".text-size-chat.whitespace-pre-wrap,p,div,span"
        )
      ].filter(Boolean);

      for (const node of candidates) {
        const text = normalize(node.textContent || node.innerText || "");
        if (text === wanted) {
          return {
            turn_id: turnId || null,
            conversation_turn_count: turns.length,
            evidence: semanticUser
              ? "exact-semantic-user-turn"
              : "exact-fresh-conversation-turn"
          };
        }
      }

      const wholeTurn = normalize(turn.textContent || turn.innerText || "");
      if (wholeTurn === wanted || wholeTurn.includes(wanted)) {
        return {
          turn_id: turnId || null,
          conversation_turn_count: turns.length,
          evidence: wholeTurn === wanted
            ? "exact-fresh-conversation-turn"
            : "exact-bootstrap-contained-in-fresh-turn"
        };
      }
    }

    // Current ChatGPT can omit conversation-turn-* wrappers entirely.
    // SC-003 begins from a proven blank chat, so an exact match on a semantic
    // user node or the current modern user-text surface is still positive
    // evidence that THIS one bootstrap became the first user turn.
    const directCandidates = [
      ...document.querySelectorAll(
        'main [data-message-author-role="user"]'
      ),
      ...document.querySelectorAll(
        "main .text-size-chat.whitespace-pre-wrap"
      )
    ];
    const seenDirect = new Set();
    let directIndex = 0;
    for (const node of directCandidates) {
      if (!node || seenDirect.has(node)) continue;
      seenDirect.add(node);

      // Never treat the live composer itself as a persisted user turn.
      if (
        node.matches?.("#prompt-textarea,[contenteditable='true'],textarea") ||
        node.closest?.("#prompt-textarea")
      ) {
        continue;
      }

      const text = normalize(node.textContent || node.innerText || "");
      if (text !== wanted) {
        directIndex += 1;
        continue;
      }

      const container = node.closest?.(
        "[data-testid^='conversation-turn-']"
      );
      const turnId = String(
        container?.getAttribute?.("data-testid") || ""
      ).trim();

      return {
        turn_id: turnId || `fresh-user-${directIndex}`,
        conversation_turn_count: turns.length,
        direct_user_count: seenDirect.size,
        evidence: node.matches?.('[data-message-author-role="user"]')
          ? "exact-semantic-user-node"
          : "exact-modern-user-node"
      };
    }

    return {
      turn_id: null,
      conversation_turn_count: turns.length,
      direct_user_count: seenDirect.size,
      evidence: "exact-fresh-user-turn-not-observed"
    };
  }, expected).catch(() => null);
}

async function waitForExactFreshUserTurn(
  page,
  expected,
  { timeoutMs = 30_000, pollMs = 250 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() <= deadline) {
    latest = await captureExactFreshUserTurn(page, expected);
    if (latest?.turn_id) return latest;
    await page.waitForTimeout(pollMs);
  }
  return latest || {
    turn_id: null,
    conversation_turn_count: 0,
    evidence: "exact-fresh-user-turn-unreadable"
  };
}

export async function sendFreshChatBootstrapInstruction(
  page,
  instruction,
  { dryRun = true } = {}
) {
  if (!page) throw new TypeError("page is required");
  if (typeof instruction !== "string" || !instruction.trim()) {
    throw new Error("bootstrap instruction is required");
  }
  if (dryRun) {
    return {
      executed: false,
      dryRun: true,
      target: "FRESH_CHAT_BOOTSTRAP"
    };
  }

  if (typeof page.bringToFront === "function") {
    await page.bringToFront().catch(() => {});
  }

  const composer = await findFreshChatComposer(page);
  if (!composer) {
    return {
      executed: false,
      rejection_class: "COMPOSER_NOT_READY",
      reason: "fresh ChatGPT composer is not ready"
    };
  }

  let inputMethod = "fill";
  let rendered = null;
  try {
    await composer.fill(instruction, { timeout: 5_000 });
    await page.waitForTimeout(150);
    rendered = await readFreshComposerText(composer);
  } catch {
    rendered = null;
  }

  let exactInput =
    rendered !== null &&
    normalizeBootstrapRenderedText(rendered) ===
      normalizeBootstrapRenderedText(instruction);

  // Current ChatGPT can expose a contenteditable for which Playwright fill()
  // resolves successfully but the live ProseMirror value remains empty. The
  // SC-003 bootstrap is intentionally printable ASCII, so a bounded native
  // keyboard type is the closest equivalent to the Owner typing the message
  // manually and avoids synthetic InputEvent/clipboard semantics.
  if (
    !exactInput &&
    /^[\x20-\x7E]+$/.test(instruction) &&
    page.keyboard &&
    typeof page.keyboard.type === "function"
  ) {
    const keyboardComposer = await findFreshChatComposer(page, 2_000);
    if (keyboardComposer) {
      await keyboardComposer.click({ timeout: 2_000 }).catch(() => {});
      if (page.keyboard && typeof page.keyboard.press === "function") {
        const selectAll = process.platform === "darwin" ? "Meta+A" : "Control+A";
        await page.keyboard.press(selectAll).catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});
      }
      await page.keyboard.type(instruction, { delay: 0 });
      await page.waitForTimeout(250);
      const typedComposer = await findFreshChatComposer(page, 1_500);
      rendered = typedComposer
        ? await readFreshComposerText(typedComposer)
        : null;
      exactInput =
        rendered !== null &&
        normalizeBootstrapRenderedText(rendered) ===
          normalizeBootstrapRenderedText(instruction);
      if (exactInput) inputMethod = "native-keyboard-type";
    }
  }

  if (!exactInput) {
    const mismatch = bootstrapTextMismatchDiagnostic(
      instruction,
      rendered === null ? "" : rendered
    );
    return {
      executed: false,
      rejection_class: "COMPOSER_NOT_READY",
      reason: "fresh ChatGPT composer did not preserve exact bootstrap text",
      input_method: inputMethod,
      mismatch
    };
  }

  // Native typing can rerender/replace ProseMirror. Never submit through the
  // locator captured before typing; reacquire the live editor after exact text
  // verification and verify the same Robot-owned message is still present.
  const submitComposer = await findFreshChatComposer(page, 2_000);
  const submitText = submitComposer
    ? await readFreshComposerText(submitComposer)
    : null;
  if (
    !submitComposer ||
    submitText === null ||
    normalizeBootstrapRenderedText(submitText) !==
      normalizeBootstrapRenderedText(instruction)
  ) {
    return {
      executed: false,
      rejection_class: "COMPOSER_NOT_READY",
      reason: "fresh ChatGPT composer changed before submit",
      input_method: inputMethod,
      mismatch: bootstrapTextMismatchDiagnostic(
        instruction,
        submitText === null ? "" : submitText
      )
    };
  }

  // A blank New Chat has no mention/file protocol surface and no historical
  // turns. Submit through the freshly reacquired composer exactly as a normal
  // user does.
  await submitComposer.click({ timeout: 2_000 }).catch(() => {});
  try {
    await submitComposer.press("Enter", { timeout: 5_000 });
  } catch {
    return {
      executed: false,
      rejection_class: "SEND_NOT_ACTUATED",
      reason: "fresh ChatGPT composer Enter submit failed",
      input_method: inputMethod,
      send_method: "composer-enter"
    };
  }

  let proof = await waitForExactFreshUserTurn(page, instruction, {
    timeoutMs: 8_000,
    pollMs: 250
  });
  if (proof?.turn_id) {
    return {
      executed: true,
      input_method: inputMethod,
      send_method: "composer-enter",
      send_selector: null,
      user_turn_evidence: proof.evidence,
      user_turn_id: proof.turn_id,
      conversation_turn_count:
        Number(proof.conversation_turn_count || 0)
    };
  }

  // A bounded button retry is allowed only with positive evidence that Enter
  // did not actuate: we are still on the blank home route, no conversation
  // turn exists, and the exact Robot-owned bootstrap remains in the composer.
  // If any of those conditions are absent, delivery is ambiguous and we never
  // perform a second mutation.
  let stillHome = false;
  try {
    const url = new URL(String(page.url?.() || ""));
    stillHome = url.origin === "https://chatgpt.com" && url.pathname === "/";
  } catch {}

  const liveComposer = await findFreshChatComposer(page, 1_500);
  const afterEnterText = liveComposer
    ? await readFreshComposerText(liveComposer)
    : null;
  const exactStillPresent =
    afterEnterText !== null &&
    normalizeBootstrapRenderedText(afterEnterText) ===
      normalizeBootstrapRenderedText(instruction);

  const afterEnterEvidence = {
    still_home: stillHome,
    composer_present: Boolean(liveComposer),
    exact_prompt_present: Boolean(exactStillPresent),
    conversation_turn_count: Number(proof?.conversation_turn_count || 0),
    conversation_path: (() => {
      try {
        return /^\/(?:c|g|project)\//.test(
          new URL(String(page.url?.() || "")).pathname
        );
      } catch {
        return false;
      }
    })()
  };

  if (
    stillHome &&
    Number(proof?.conversation_turn_count || 0) === 0 &&
    exactStillPresent
  ) {
    const scopes = [];
    if (typeof liveComposer?.locator === "function") {
      const form = liveComposer.locator("xpath=ancestor::form[1]").first();
      if (await form.isVisible().catch(() => false)) scopes.push(form);
    }
    scopes.push(page);

    const selectors = [
      'button[data-testid="send-button"]:visible',
      'button#composer-submit-button:visible',
      'button[data-testid="composer-submit-button"]:visible',
      'button[data-testid="composer-send-button"]:visible',
      'button[type="submit"]:visible',
      'button[aria-label*="Send" i]:visible',
      'button[aria-label*="Gửi" i]:visible'
    ];

    let send = null;
    let sendSelector = null;
    for (const scope of scopes) {
      for (const selector of selectors) {
        const candidate = scope.locator(selector).first();
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const enabled = typeof candidate.isEnabled === "function"
          ? await candidate.isEnabled().catch(() => false)
          : true;
        if (!enabled) continue;
        send = candidate;
        sendSelector = selector;
        break;
      }
      if (send) break;
    }

    if (send) {
      await send.click({ timeout: 5_000 });
      proof = await waitForExactFreshUserTurn(page, instruction, {
        timeoutMs: 30_000,
        pollMs: 250
      });
      if (proof?.turn_id) {
        return {
          executed: true,
          input_method: inputMethod,
          send_method: "composer-enter+safe-direct-control",
          send_selector: sendSelector,
          user_turn_evidence: proof.evidence,
          user_turn_id: proof.turn_id,
          conversation_turn_count:
            Number(proof.conversation_turn_count || 0)
        };
      }

      return {
        executed: false,
        rejection_class: "SEND_NOT_ACTUATED",
        reason: "safe Send retry did not produce exact fresh user turn",
        input_method: inputMethod,
        send_method: "composer-enter+safe-direct-control",
        send_selector: sendSelector,
        user_turn_evidence: proof?.evidence || "unreadable",
        conversation_turn_count:
          Number(proof?.conversation_turn_count || 0),
        direct_user_count:
          Number(proof?.direct_user_count || 0),
        after_enter: afterEnterEvidence
      };
    }
  }

  // Enter may have actuated even if the user-turn DOM has not hydrated yet.
  // Continue observing without another send mutation.
  proof = await waitForExactFreshUserTurn(page, instruction, {
    timeoutMs: 22_000,
    pollMs: 250
  });
  if (proof?.turn_id) {
    return {
      executed: true,
      input_method: inputMethod,
      send_method: "composer-enter",
      send_selector: null,
      user_turn_evidence: proof.evidence,
      user_turn_id: proof.turn_id,
      conversation_turn_count:
        Number(proof.conversation_turn_count || 0)
    };
  }

  return {
    executed: false,
    rejection_class: "SEND_NOT_ACTUATED",
    reason: "Enter submit did not yield exact fresh user turn",
    input_method: inputMethod,
    send_method: "composer-enter",
    user_turn_evidence: proof?.evidence || "unreadable",
    conversation_turn_count:
      Number(proof?.conversation_turn_count || 0),
    after_enter: afterEnterEvidence
  };
}

async function assertBlankNewChatSurface(adapter, page) {
  const probe = await adapter.probePage(page);
  const snapshot = probe?.snapshot || {};

  if (snapshot.loginRequired) throw new Error("ChatGPT login is required");
  if (snapshot.hasCaptcha) throw new Error("ChatGPT CAPTCHA requires Owner intervention");
  if (snapshot.conversationAccessDenied) {
    throw new Error("ChatGPT access is denied");
  }
  if (snapshot.conversationMissing) {
    throw new Error("ChatGPT conversation surface is missing");
  }
  if (!snapshot.composerReady) {
    throw new Error("ChatGPT New Chat composer is not ready");
  }
  if (snapshot.responseRunning) {
    throw new Error("ChatGPT New Chat surface is unexpectedly generating");
  }
  if (Number(snapshot.userMessageCount || 0) !== 0 ||
      Number(snapshot.assistantMessageCount || 0) !== 0) {
    throw new Error("ChatGPT surface is not a blank New Chat");
  }

  return probe;
}

export async function acquireBlankNewChatSurface(adapter, {
  forceNewPage = false
} = {}) {
  if (!adapter) throw new Error("adapter is required");
  await adapter.open();

  let page = adapter.getActivePage?.() || null;
  if (!forceNewPage && page && isHomeChatGptPage(page)) {
    try {
      await assertBlankNewChatSurface(adapter, page);
      return { page, created: false, reused_home: true };
    } catch (error) {
      if (/login|required|CAPTCHA|access is denied/i.test(String(error?.message || ""))) {
        throw error;
      }
    }
  }

  page = await adapter.newChatPage(HOME_URL);
  await assertBlankNewChatSurface(adapter, page);
  return { page, created: true, reused_home: false };
}

async function persistPreparedBootstrap(statePath, {
  messageId,
  message,
  baselineUserTurnId,
  now
}) {
  const state = await readSingleConversationState(statePath);
  const at = nowIso(now);
  state.source_of_truth.sync_status = "SYNCING";
  state.outbound = {
    state: "PREPARED",
    message_id: messageId,
    message_digest: composerInstructionDigest(message),
    kind: "SOURCE_OF_TRUTH_BOOTSTRAP",
    cmd_id: null,
    baseline_user_turn_id: baselineUserTurnId || null,
    delivered_user_turn_id: null,
    prepared_at: at,
    enqueued_at: null,
    delivered_at: null,
    response_running_at: null,
    response_complete_at: null,
    verified_at: null,
    retry_count: 0,
    last_error_code: null
  };
  state.automation.status = "RUNNING";
  state.automation.phase = "SEND_BOOTSTRAP";
  state.automation.reason = null;
  state.automation.updated_at = at;
  return writeSingleConversationState(statePath, state, { now });
}

async function persistBootstrapFailure(statePath, error, now) {
  const state = await readSingleConversationState(statePath);
  const at = nowIso(now);
  state.outbound.last_error_code = safeErrorCode(error);
  state.automation.status = "BLOCKED";
  state.automation.phase = "BOOTSTRAP_FAILED";
  state.automation.reason = state.outbound.last_error_code;
  state.automation.updated_at = at;
  return writeSingleConversationState(statePath, state, { now });
}

async function persistDelivered(statePath, {
  userTurnId,
  runtimeId,
  now
}) {
  const state = await readSingleConversationState(statePath);
  const at = nowIso(now);
  state.outbound.state = "DELIVERED";
  state.outbound.delivered_user_turn_id = userTurnId || null;
  state.outbound.delivered_at = at;
  state.outbound.last_error_code = null;
  state.conversation.runtime_id = runtimeId || state.conversation.runtime_id || null;
  state.conversation.last_seen_at = at;
  state.automation.phase = "WAIT_RESPONSE";
  state.automation.updated_at = at;
  return writeSingleConversationState(statePath, state, { now });
}

async function persistResponseRunning(statePath, now) {
  const state = await readSingleConversationState(statePath);
  if (state.outbound.state === "RESPONSE_RUNNING") return state;
  const at = nowIso(now);
  state.outbound.state = "RESPONSE_RUNNING";
  state.outbound.response_running_at =
    state.outbound.response_running_at || at;
  state.automation.phase = "WAIT_RESPONSE";
  state.automation.updated_at = at;
  return writeSingleConversationState(statePath, state, { now });
}

async function persistResponseComplete(statePath, {
  assistantTurnId,
  now
}) {
  const state = await readSingleConversationState(statePath);
  const at = nowIso(now);
  state.outbound.state = "RESPONSE_COMPLETE";
  state.outbound.response_complete_at = at;
  state.automation.phase = "BOOTSTRAP_RESPONSE_COMPLETE";
  state.automation.reason = null;
  state.automation.updated_at = at;
  state.conversation.last_seen_at = at;
  // Assistant turn identity is runtime evidence only. Keep it under
  // automation diagnostics rather than creating a second project authority.
  state.automation.last_assistant_turn_id = assistantTurnId || null;
  return writeSingleConversationState(statePath, state, { now });
}

export async function waitForBootstrapResponse({
  adapter,
  page,
  statePath,
  baselineAssistantTurnId = null,
  captureTurn = captureLatestRoleTurn,
  timeoutMs = 180_000,
  pollMs = 750,
  now = () => new Date().toISOString()
} = {}) {
  const started = Date.now();
  let sawRunning = false;

  while (Date.now() - started <= timeoutMs) {
    const probe = await adapter.probePage(page);
    const snapshot = probe?.snapshot || {};

    if (snapshot.loginRequired) throw new Error("ChatGPT login is required");
    if (snapshot.hasCaptcha) throw new Error("ChatGPT CAPTCHA requires Owner intervention");
    if (snapshot.conversationAccessDenied) throw new Error("ChatGPT access is denied");
    if (snapshot.conversationMissing) throw new Error("ChatGPT conversation is missing");
    if (snapshot.hasNetworkError) throw new Error("ChatGPT network error during bootstrap");
    if (snapshot.hasTransientError && !snapshot.responseRunning) {
      throw new Error("ChatGPT transient error during bootstrap");
    }

    if (snapshot.responseRunning) {
      sawRunning = true;
      await persistResponseRunning(statePath, now);
    } else {
      const assistant = await captureTurn(page, "assistant").catch(() => null);
      if (
        assistant?.turn_id &&
        assistant.turn_id !== baselineAssistantTurnId
      ) {
        if (snapshot.hasContinueControl) {
          return {
            status: "CONTINUE_REQUIRED",
            assistant_turn: assistant,
            saw_running: sawRunning
          };
        }
        await persistResponseComplete(statePath, {
          assistantTurnId: assistant.turn_id,
          now
        });
        return {
          status: "RESPONSE_COMPLETE",
          assistant_turn: assistant,
          saw_running: sawRunning
        };
      }
    }

    if (typeof page?.waitForTimeout === "function") {
      await page.waitForTimeout(pollMs);
    } else {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  throw Object.assign(new Error("bootstrap assistant response timed out"), {
    code: "RESPONSE_TIMEOUT"
  });
}

export async function createNewChatAndBootstrap({
  adapter,
  statePath,
  sourceOfTruthUrl,
  projectId = "LIVE",
  messageId = randomUUID(),
  qualificationOnly = false,
  forceNewPage = false,
  sendInstruction = sendFreshChatBootstrapInstruction,
  captureTurn = captureLatestRoleTurn,
  timeoutMs = 180_000,
  pollMs = 750,
  now = () => new Date().toISOString(),
  onPageAcquired = null,
  onStage = null
} = {}) {
  if (!adapter) throw new Error("adapter is required");
  if (!statePath) throw new Error("statePath is required");

  const stage = async (name, evidence = {}) => {
    if (typeof onStage !== "function") return;
    await onStage(String(name), evidence);
  };

  const state = await ensureSingleConversationState(statePath, {
    sourceOfTruthUrl,
    projectId,
    now
  });
  await stage("STATE_READY");

  try {
    await stage("NEW_CHAT_ACQUIRE_BEGIN");
    const surface = await acquireBlankNewChatSurface(adapter, { forceNewPage });
    const page = surface.page;
    await stage("NEW_CHAT_ACQUIRED", {
      created: Boolean(surface.created),
      reused_home: Boolean(surface.reused_home)
    });
    if (typeof onPageAcquired === "function") {
      await onPageAcquired(page, surface);
    }

    await beginConversationGeneration(statePath, {
      runtimeId: null,
      pageId: null,
      at: now
    });
    await stage("CONVERSATION_GENERATION_STARTED");

    const baselineUser = await captureTurn(page, "user").catch(() => null);
    const baselineAssistant = await captureTurn(page, "assistant").catch(() => null);
    if (baselineUser || baselineAssistant) {
      throw new Error("New Chat acquired with unexpected existing turns");
    }
    await stage("BLANK_BASELINE_CONFIRMED");

    const message = buildSingleConversationBootstrap({
      sourceOfTruthUrl: state.source_of_truth.url,
      messageId,
      qualificationOnly
    });
    await persistPreparedBootstrap(statePath, {
      messageId,
      message,
      baselineUserTurnId: baselineUser?.turn_id || null,
      now
    });
    await stage("BOOTSTRAP_PREPARED", {
      message_length: message.length
    });

    await stage("SEND_BEGIN");
    const sendResult = await sendInstruction(page, message, { dryRun: false });
    await stage("SEND_RETURNED", {
      executed: Boolean(sendResult?.executed),
      input_method: sendResult?.input_method || null,
      send_method: sendResult?.send_method || null,
      rejection_class: sendResult?.rejection_class || null,
      user_turn_evidence: sendResult?.user_turn_evidence || null,
      conversation_turn_count:
        Number(sendResult?.conversation_turn_count || 0),
      direct_user_count:
        Number(sendResult?.direct_user_count || 0),
      mismatch: sendResult?.mismatch || null,
      after_enter: sendResult?.after_enter || null
    });
    if (!sendResult?.executed) {
      throw Object.assign(
        new Error(sendResult?.reason || "bootstrap send was not confirmed"),
        { code: sendResult?.rejection_class || "SEND_NOT_CONFIRMED" }
      );
    }

    const userTurn = sendResult?.user_turn_id
      ? {
          turn_id: String(sendResult.user_turn_id),
          role: "user",
          text: message
        }
      : await captureTurn(page, "user").catch(() => null);
    if (!userTurn?.turn_id) {
      throw Object.assign(
        new Error("bootstrap matching user turn could not be captured after confirmed send"),
        { code: "USER_TURN_NOT_CAPTURED" }
      );
    }
    await stage("USER_TURN_CONFIRMED");

    await persistDelivered(statePath, {
      userTurnId: userTurn.turn_id,
      runtimeId: opaqueRuntimeIdentity(pageUrl(page)),
      now
    });
    await stage("DELIVERED_PERSISTED");

    await stage("WAIT_RESPONSE_BEGIN");
    const response = await waitForBootstrapResponse({
      adapter,
      page,
      statePath,
      baselineAssistantTurnId: baselineAssistant?.turn_id || null,
      captureTurn,
      timeoutMs,
      pollMs,
      now
    });
    await stage("WAIT_RESPONSE_RETURNED", {
      status: response?.status || null
    });

    return {
      page,
      message_id: messageId,
      message,
      surface,
      send: sendResult,
      response
    };
  } catch (error) {
    await stage("FAILED", {
      code: safeErrorCode(error)
    }).catch(() => {});
    await persistBootstrapFailure(statePath, error, now).catch(() => {});
    throw error;
  }
}
