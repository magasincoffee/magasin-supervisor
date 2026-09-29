import crypto from "node:crypto";

import { ACTIONS } from "../decision.mjs";
import { beginSubmitFlightRecording } from "./submit-flight-recorder.mjs";

const SAFE_RETRY_RE = /^(try again|retry|thử lại)$/i;
const SAFE_CONTINUE_RE = /^(continue generating|continue response|tiếp tục tạo|tiếp tục)$/i;
const SAFE_SEND_RE = /^(send|send prompt|send message|submit|submit prompt|gửi|gửi tin nhắn|gửi lời nhắc)$/i;
const MACHINE_FRAME_MENTION_RE = /(^|\n)\s*@M\s/u;
export const SEND_REJECTION_CLASSES = Object.freeze({
  NONE: "NONE",
  CAPACITY_REJECTED: "CAPACITY_REJECTED",
  NETWORK_TRANSIENT: "NETWORK_TRANSIENT",
  AUTH_SECURITY: "AUTH_SECURITY",
  TRANSIENT: "TRANSIENT",
  COMPOSER_NOT_READY: "COMPOSER_NOT_READY",
  SEND_NOT_ACTUATED: "SEND_NOT_ACTUATED",
  UNKNOWN: "UNKNOWN"
});

export function classifyComposerSendRejection(snapshot = {}) {
  if (
    snapshot.loginRequired ||
    snapshot.hasCaptcha ||
    snapshot.conversationAccessDenied
  ) {
    return SEND_REJECTION_CLASSES.AUTH_SECURITY;
  }
  if (snapshot.hasNetworkError) {
    return SEND_REJECTION_CLASSES.NETWORK_TRANSIENT;
  }
  if (
    snapshot.hasTransientError ||
    snapshot.hasRetryControl ||
    snapshot.modelSwitching
  ) {
    return SEND_REJECTION_CLASSES.TRANSIENT;
  }
  if (
    snapshot.capacityExplicitFullUi ||
    snapshot.composerCapacityBlocked
  ) {
    return SEND_REJECTION_CLASSES.CAPACITY_REJECTED;
  }
  if (!snapshot.composerReady || snapshot.composerGenericBlocked) {
    return SEND_REJECTION_CLASSES.COMPOSER_NOT_READY;
  }
  return SEND_REJECTION_CLASSES.UNKNOWN;
}

const COMPOSER_SELECTORS = Object.freeze([
  "#prompt-textarea:visible",
  "[contenteditable][role='textbox']:visible",
  "textarea:visible",
  "[contenteditable]:visible"
]);

function composerLocator(page, selector = COMPOSER_SELECTORS[0]) {
  return page.locator(selector).first();
}

async function composerReadyState(composer) {
  const visible = typeof composer?.isVisible === "function"
    ? await composer.isVisible().catch(() => false)
    : false;
  const enabled = typeof composer?.isEnabled === "function"
    ? await composer.isEnabled().catch(() => false)
    : visible;
  let editable = typeof composer?.isEditable === "function"
    ? await composer.isEditable().catch(() => false)
    : enabled;

  // ChatGPT occasionally exposes the ProseMirror editor as
  // contenteditable="plaintext-only". Playwright versions differ on whether
  // isEditable() reports that value as editable, so use the DOM attribute as
  // a bounded compatibility hint instead of rejecting a real composer.
  if (!editable && visible && enabled && typeof composer?.getAttribute === "function") {
    const contentEditable = await composer.getAttribute("contenteditable")
      .catch(() => null);
    const role = await composer.getAttribute("role").catch(() => null);
    editable = Boolean(
      contentEditable !== null &&
      String(contentEditable).toLowerCase() !== "false"
    ) || String(role || "").toLowerCase() === "textbox";
  }

  return { visible, enabled, editable, ready: visible && enabled && editable };
}

async function firstReadyComposer(page) {
  for (const selector of COMPOSER_SELECTORS) {
    const composer = composerLocator(page, selector);
    const state = await composerReadyState(composer);
    if (state.ready) return composer;
  }
  return null;
}

async function waitForReadyComposer(
  page,
  { timeoutMs = 8_000, intervalMs = 200 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const composer = await firstReadyComposer(page);
    if (composer) return composer;
    await page.waitForTimeout(intervalMs);
  }
  return null;
}

function selectAllChord() {
  return process.platform === "darwin" ? "Meta+A" : "Control+A";
}

async function keyboardClearComposer(page, composer) {
  await composer.click({ timeout: 2_000 });
  // Use the page keyboard after explicitly focusing the live composer. Current
  // ChatGPT can rerender ProseMirror between locator key events; page-level
  // native keys match the SC-003 path that is qualified on the real target.
  if (page.keyboard && typeof page.keyboard.press === "function") {
    await page.keyboard.press(selectAllChord());
    await page.keyboard.press("Backspace");
    return;
  }
  await composer.press(selectAllChord(), { timeout: 2_000 });
  await composer.press("Backspace", { timeout: 2_000 });
}

async function clearComposerText(
  page,
  { timeoutMs = 3_000 } = {}
) {
  const composer = await waitForReadyComposer(page, { timeoutMs });
  if (!composer) {
    return {
      ready: false,
      reason: "composer did not become editable for bounded clear"
    };
  }

  try {
    await composer.fill("", { timeout: 1_500 });
    return { ready: true, method: "fill" };
  } catch (fillError) {
    const fresh = await waitForReadyComposer(page, { timeoutMs: 2_000 });
    if (!fresh) throw fillError;
    await keyboardClearComposer(page, fresh);
    return { ready: true, method: "keyboard" };
  }
}

function normalizeComposerText(value) {
  return String(value || "")
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

// ChatGPT's contenteditable composer may preserve the same visible instruction
// while rewriting line breaks, tabs, or NBSP into equivalent rendered
// whitespace. Use a render-equivalent identity only for send verification;
// keep normalizeComposerText() strict for guarded stale-draft digests.
function normalizeRenderedInstructionText(value) {
  return normalizeComposerText(value)
    .replace(/\u00A0/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

async function readComposerText(composer) {
  if (!composer) return null;

  if (typeof composer.inputValue === "function") {
    try {
      return await composer.inputValue({ timeout: 800 });
    } catch {}
  }

  if (typeof composer.evaluate === "function") {
    try {
      return await composer.evaluate((el) => {
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement
        ) {
          return el.value;
        }
        // textContent is the stable logical ProseMirror value on the current
        // ChatGPT composer; innerText can inject layout-derived whitespace.
        return el.textContent || el.innerText || "";
      });
    } catch {}
  }

  return null;
}

async function composerContainsExactInstruction(composer, instruction) {
  const text = await readComposerText(composer);
  if (text === null) return null;
  return normalizeRenderedInstructionText(text) ===
    normalizeRenderedInstructionText(instruction);
}

function normalizedComposerDigest(value) {
  return crypto
    .createHash("sha256")
    .update(normalizeComposerText(value), "utf8")
    .digest("hex");
}

export function composerInstructionDigest(value) {
  return normalizedComposerDigest(value);
}

export async function inspectComposerDraftDigest(
  page,
  { timeoutMs = 1_500 } = {}
) {
  const composer = await waitForReadyComposer(page, { timeoutMs });
  if (!composer) {
    return {
      ready: false,
      has_text: false,
      digest: null,
      reason: "composer not ready"
    };
  }

  const current = await readComposerText(composer);
  if (current === null) {
    return {
      ready: true,
      has_text: null,
      digest: null,
      reason: "composer text unreadable"
    };
  }

  const normalized = normalizeComposerText(current);
  if (!normalized) {
    return {
      ready: true,
      has_text: false,
      digest: null
    };
  }

  return {
    ready: true,
    has_text: true,
    digest: normalizedComposerDigest(normalized),
    normalized_text: normalized
  };
}

export async function discardComposerDraftIfDigest(
  page,
  expectedDigest,
  { timeoutMs = 3_000 } = {}
) {
  const digest = String(expectedDigest || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    return {
      discarded: false,
      reason: "invalid expected composer digest"
    };
  }

  const composer = await waitForReadyComposer(page, { timeoutMs });
  if (!composer) {
    return {
      discarded: false,
      reason: "composer not ready for guarded draft discard"
    };
  }

  const current = await readComposerText(composer);
  if (current === null) {
    return {
      discarded: false,
      reason: "composer text unreadable for guarded draft discard"
    };
  }

  const normalized = normalizeComposerText(current);
  if (!normalized) {
    return {
      discarded: false,
      reason: "composer already empty"
    };
  }

  if (normalizedComposerDigest(normalized) !== digest) {
    return {
      discarded: false,
      reason: "composer draft digest mismatch"
    };
  }

  // Ownership is proven by the exact digest above. Close transient ChatGPT
  // mention/file UI before clearing the Robot-owned draft so a stale @M
  // autocomplete cannot retain focus or intercept the next send attempt.
  try {
    await composer.click({ timeout: 1_000 }).catch(() => {});
    if (page.keyboard && typeof page.keyboard.press === "function") {
      await page.keyboard.press("Escape").catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
    } else if (typeof composer.press === "function") {
      await composer.press("Escape", { timeout: 1_000 }).catch(() => {});
      await composer.press("Escape", { timeout: 1_000 }).catch(() => {});
    }
  } catch {
    // Continue to the guarded clear; the digest check remains the authority.
  }

  const cleared = await clearComposerText(page, { timeoutMs });
  if (!cleared.ready) {
    return {
      discarded: false,
      reason: cleared.reason || "guarded composer clear failed"
    };
  }

  const after = await waitForReadyComposer(page, { timeoutMs: 1_500 });
  if (!after) {
    return {
      discarded: true,
      method: cleared.method,
      evidence: "composer-disappeared-after-clear"
    };
  }

  const afterText = await readComposerText(after);
  if (afterText !== null && normalizeComposerText(afterText)) {
    return {
      discarded: false,
      reason: "composer remained non-empty after guarded clear"
    };
  }

  return {
    discarded: true,
    method: cleared.method,
    evidence: "exact-digest-draft-cleared"
  };
}

const USER_TURN_SELECTORS = Object.freeze({
  legacy: '[data-message-author-role="user"]',
  modern: "main .text-size-chat.whitespace-pre-wrap"
});

async function captureUserTurnState(page, instruction) {
  if (!page || typeof page.evaluate !== "function") {
    return { readable: false, totalCount: 0, exactMatchCount: 0 };
  }
  try {
    return await page.evaluate(({ expected, selectors }) => {
      const normalize = (value) => String(value || "")
        .replace(/\u200B/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\u00A0/g, " ")
        .replace(/\s+/gu, " ")
        .trim();
      const wanted = normalize(expected);

      // A live conversation can contain a mixed DOM during hydration: older
      // turns may expose semantic role nodes while the newest user turn exists
      // only on the modern text surface. Never choose one representation and
      // discard the other. Merge both sets, exclude the active composer, and
      // deduplicate nested/identical DOM nodes by element identity.
      const candidates = [
        // Keep the legacy selector literal here as well as in the selector
        // contract. Besides being equivalent in production, this preserves
        // compatibility with existing deterministic UI fixtures that identify
        // the semantic user-turn probe by function source.
        ...document.querySelectorAll('[data-message-author-role="user"]'),
        ...document.querySelectorAll(selectors.modern)
      ];
      const seen = new Set();
      const turns = [];
      for (const node of candidates) {
        if (!node || seen.has(node)) continue;
        seen.add(node);
        if (
          node.matches?.("#prompt-textarea,textarea,[contenteditable='true'],[contenteditable='plaintext-only']") ||
          node.closest?.("#prompt-textarea")
        ) {
          continue;
        }
        turns.push(node);
      }

      let exactMatchCount = 0;
      let matchingTurnId = null;
      let matchingEvidence = null;
      for (let index = 0; index < turns.length; index += 1) {
        const node = turns[index];
        const text = normalize(node.textContent || node.innerText || "");
        if (text !== wanted) continue;
        exactMatchCount += 1;
        const container = node.closest?.("[data-testid^='conversation-turn-']");
        matchingTurnId =
          String(container?.getAttribute?.("data-testid") || "").trim() ||
          `user-turn-${index}`;
        matchingEvidence = node.matches?.('[data-message-author-role="user"]')
          ? "exact-semantic-user-turn"
          : "exact-modern-user-turn";
      }
      return {
        readable: true,
        totalCount: turns.length,
        exactMatchCount,
        matchingTurnId,
        matchingEvidence
      };
    }, {
      expected: instruction,
      selectors: USER_TURN_SELECTORS
    });
  } catch {
    return { readable: false, totalCount: 0, exactMatchCount: 0 };
  }
}

export async function captureMatchingUserTurnEvidence(page, instruction) {
  const state = await captureUserTurnState(page, instruction);
  if (
    state?.readable &&
    Number(state.exactMatchCount || 0) > 0
  ) {
    return {
      confirmed: true,
      turn_id: state.matchingTurnId || null,
      evidence: state.matchingEvidence || "matching-user-turn-observed",
      totalCount: Number(state.totalCount || 0)
    };
  }
  return {
    confirmed: false,
    turn_id: null,
    evidence: state?.readable
      ? "matching-user-turn-not-observed"
      : "user-turn-state-unreadable",
    totalCount: Number(state?.totalCount || 0)
  };
}

async function waitForMatchingUserTurn(
  page,
  instruction,
  baseline,
  { timeoutMs = 8_000, intervalMs = 200 } = {}
) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  let readable = false;
  let sawAdditionalUserTurn = false;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await captureUserTurnState(page, instruction);
    if (current.readable) {
      readable = true;
      if (current.totalCount > Number(baseline?.totalCount || 0)) {
        sawAdditionalUserTurn = true;
      }
      if (
        current.exactMatchCount >
        Number(baseline?.exactMatchCount || 0)
      ) {
        return {
          confirmed: true,
          evidence: "matching-user-turn-observed",
          totalCount: current.totalCount
        };
      }
    }

    if (attempt < attempts - 1 && typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(intervalMs);
    }
  }

  return {
    confirmed: false,
    evidence: !readable
      ? "user-turn-state-unreadable"
      : sawAdditionalUserTurn
        ? "new-user-turn-text-mismatch"
        : "matching-user-turn-not-observed"
  };
}

async function dismissMachineFrameMentionPopover(page, composer, instruction) {
  // ChatGPT treats "@..." as a file/mention trigger. Supervisor protocol
  // deliberately uses "@M {...}", so typing a machine frame can open the
  // Files/Tệp mention popover above the composer. If it remains open, Enter
  // is consumed by the mention UI instead of submitting the prompt.
  if (!MACHINE_FRAME_MENTION_RE.test(String(instruction || ""))) {
    return { attempted: false, preserved: true };
  }

  const exactBefore = await composerContainsExactInstruction(
    composer,
    instruction
  );
  if (exactBefore === false) {
    return { attempted: false, preserved: false };
  }

  try {
    // Keep focus anchored to the live composer. ChatGPT can move focus into the
    // Files/Tệp mention list after @M is recognized, in which case a page-level
    // Escape may be swallowed by the list rather than closing it.
    if (composer && typeof composer.click === "function") {
      await composer.click({ timeout: 1_000 }).catch(() => {});
    }
    if (page.keyboard && typeof page.keyboard.press === "function") {
      await page.keyboard.press("Escape");
      if (typeof page.waitForTimeout === "function") {
        await page.waitForTimeout(60);
      }
      // A second bounded Escape handles the nested mention/listbox layer used
      // by current ChatGPT without touching the composer text.
      await page.keyboard.press("Escape");
    } else if (composer && typeof composer.press === "function") {
      await composer.press("Escape", { timeout: 1_500 });
      await composer.press("Escape", { timeout: 1_500 }).catch(() => {});
    }
  } catch {
    return { attempted: true, preserved: exactBefore !== false };
  }

  if (typeof page.waitForTimeout === "function") {
    await page.waitForTimeout(120);
  }
  const fresh = await waitForReadyComposer(page, { timeoutMs: 1_500 });
  if (!fresh) {
    return { attempted: true, preserved: false };
  }
  const exactAfter = await composerContainsExactInstruction(
    fresh,
    instruction
  );
  return {
    attempted: true,
    preserved: exactAfter !== false,
    composer: fresh
  };
}

async function setComposerText(
  page,
  instruction,
  { timeoutMs = 8_000 } = {}
) {
  const composer = await waitForReadyComposer(page, { timeoutMs });
  if (!composer) {
    return {
      ready: false,
      reason: "composer is not ready; did not become editable before bounded timeout"
    };
  }

  let fillError = null;
  try {
    await composer.fill(instruction, { timeout: 2_500 });
    if (typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(120);
    }
    const persisted = await composerContainsExactInstruction(
      composer,
      instruction
    );
    if (persisted !== false) {
      return { ready: true, method: "fill", composer };
    }
    fillError = new Error("composer fill did not persist exact instruction text");
  } catch (error) {
    fillError = error;
  }

  // ChatGPT can replace the ProseMirror composer between readiness probing
  // and locator.fill(), or accept fill() without updating the live React
  // editor state. Reacquire the editor and perform a real keyboard insertion.
  const fresh = await waitForReadyComposer(page, { timeoutMs: 3_000 });
  if (!fresh) throw fillError;
  await keyboardClearComposer(page, fresh);
  if (!page.keyboard || typeof page.keyboard.insertText !== "function") {
    throw fillError;
  }
  await page.keyboard.insertText(instruction);
  if (typeof page.waitForTimeout === "function") {
    await page.waitForTimeout(180);
  }

  const afterInsert = await waitForReadyComposer(page, { timeoutMs: 1_500 });
  if (!afterInsert) {
    throw new Error("composer disappeared after keyboard text insertion");
  }

  const persisted = await composerContainsExactInstruction(
    afterInsert,
    instruction
  );
  if (persisted !== false) {
    return { ready: true, method: "keyboard-insertText", composer: afterInsert };
  }

  // Current ChatGPT can accept insertText() at the Playwright layer without
  // updating the live ProseMirror/React editor. For printable ASCII machine
  // contracts, fall back once to native key events, which matches the proven
  // SC-003 bootstrap path. This mutates only the draft; no send occurs here.
  if (
    /^[\x20-\x7E]+$/.test(instruction) &&
    page.keyboard &&
    typeof page.keyboard.type === "function"
  ) {
    const typedComposer = await waitForReadyComposer(page, { timeoutMs: 1_500 });
    if (typedComposer) {
      await keyboardClearComposer(page, typedComposer);
      await page.keyboard.type(instruction, { delay: 0 });
      if (typeof page.waitForTimeout === "function") {
        await page.waitForTimeout(180);
      }
      const afterType = await waitForReadyComposer(page, { timeoutMs: 1_500 });
      if (afterType) {
        const typedPersisted = await composerContainsExactInstruction(
          afterType,
          instruction
        );
        if (typedPersisted !== false) {
          return {
            ready: true,
            method: "native-keyboard-type",
            composer: afterType
          };
        }
      }
    }
  }

  return {
    ready: false,
    reason: "composer text did not persist after bounded keyboard insertion"
  };
}

function visibleControlSnapshot(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        box.width > 0 &&
        box.height > 0;
    };

    return Array.from(document.querySelectorAll("button,[role='button']"))
      .filter(visible)
      .slice(0, 200)
      .map((el) => ({
        text: String(el.innerText || el.textContent || "").trim(),
        ariaLabel: String(el.getAttribute("aria-label") || "").trim(),
        testId: el.getAttribute("data-testid") || null,
        disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true"
      }));
  });
}

function findSafeControl(controls, pattern, allowedTestIds = []) {
  return controls.find((control) => {
    if (control.disabled) return false;
    const candidates = [control.text, control.ariaLabel].filter(Boolean);
    return candidates.some((value) => pattern.test(value)) ||
      (control.testId && allowedTestIds.includes(control.testId));
  }) || null;
}

const DIRECT_SEND_SELECTORS = Object.freeze([
  'button[data-testid="send-button"]:visible',
  'button#composer-submit-button:visible',
  'button[data-testid="composer-submit-button"]:visible',
  'button[data-testid="composer-send-button"]:visible',
  'button[data-testid*="send" i]:visible',
  'button[data-testid*="submit" i]:visible',
  'button[id*="send" i]:visible',
  'button[id*="submit" i]:visible',
  'button[aria-label*="Send" i]:visible',
  'button[aria-label*="Submit" i]:visible',
  'button[aria-label*="Gửi" i]:visible',
  'button[title*="Send" i]:visible',
  'button[title*="Submit" i]:visible',
  'button[title*="Gửi" i]:visible'
]);

const FORM_SEND_SELECTORS = Object.freeze([
  ...DIRECT_SEND_SELECTORS,
  'button[type="submit"]:visible'
]);

async function composerFormScope(composer) {
  if (!composer || typeof composer.locator !== "function") return null;
  try {
    const form = composer.locator("xpath=ancestor::form[1]").first();
    const count = typeof form.count === "function"
      ? await form.count().catch(() => 0)
      : 1;
    if (!count) return null;
    if (
      typeof form.isVisible === "function" &&
      !(await form.isVisible().catch(() => false))
    ) {
      return null;
    }
    return form;
  } catch {
    return null;
  }
}

async function findGeometricComposerSendControl(form) {
  if (!form || typeof form.locator !== "function") return null;
  const formBox = typeof form.boundingBox === "function"
    ? await form.boundingBox().catch(() => null)
    : null;
  if (!formBox || formBox.width <= 0 || formBox.height <= 0) return null;

  const buttons = form.locator("button");
  const count = Math.min(
    40,
    typeof buttons.count === "function"
      ? await buttons.count().catch(() => 0)
      : 0
  );
  const candidates = [];
  const rejectRe = /(attach|attachment|file|upload|plus|add|voice|mic|microphone|dictat|audio|model|tool|stop|retry|continue|tệp|đính kèm|thêm|giọng|âm thanh)/i;

  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    const visible = await button.isVisible().catch(() => false);
    if (!visible) continue;
    const enabled = typeof button.isEnabled === "function"
      ? await button.isEnabled().catch(() => false)
      : true;
    if (!enabled) continue;

    const box = typeof button.boundingBox === "function"
      ? await button.boundingBox().catch(() => null)
      : null;
    if (!box || box.width < 22 || box.height < 22 || box.width > 96 || box.height > 96) {
      continue;
    }

    const attrs = await Promise.all([
      button.getAttribute?.("aria-label").catch?.(() => null),
      button.getAttribute?.("title").catch?.(() => null),
      button.getAttribute?.("data-testid").catch?.(() => null),
      button.getAttribute?.("id").catch?.(() => null),
      button.getAttribute?.("type").catch?.(() => null)
    ]);
    const text = typeof button.innerText === "function"
      ? await button.innerText().catch(() => "")
      : "";
    const haystack = [...attrs, text].filter(Boolean).join(" ");
    if (rejectRe.test(haystack)) continue;

    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    const rightBand = formBox.x + formBox.width * 0.62;
    const lowerBand = formBox.y + formBox.height * 0.35;
    if (centerX < rightBand || centerY < lowerBand) continue;

    let score = centerX - formBox.x;
    if (String(attrs[4] || "").toLowerCase() === "submit") score += 1000;
    if (/(send|submit|gửi)/i.test(haystack)) score += 2000;
    candidates.push({ button, score, index });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] || null;
  if (!best) return null;
  return {
    button: best.button,
    selector: "geometric-rightmost-composer-action",
    scope: "composer-form-geometric"
  };
}

async function findReadyDirectSendControl(page, composer = null) {
  const scopes = [];
  const form = await composerFormScope(composer);
  if (form) scopes.push({ root: form, scope: "composer-form" });
  scopes.push({ root: page, scope: "page" });

  for (const candidate of scopes) {
    const selectors = candidate.scope === "composer-form"
      ? FORM_SEND_SELECTORS
      : DIRECT_SEND_SELECTORS;
    for (const selector of selectors) {
      const button = candidate.root.locator(selector).first();
      const visible = await button.isVisible().catch(() => false);
      if (!visible) continue;
      const enabled = typeof button.isEnabled === "function"
        ? await button.isEnabled().catch(() => false)
        : true;
      if (enabled) {
        return {
          button,
          selector,
          scope: candidate.scope
        };
      }
    }
  }
  if (form) {
    const geometric = await findGeometricComposerSendControl(form);
    if (geometric) return geometric;
  }
  return null;
}

async function waitForReadyDirectSendControl(
  page,
  { timeoutMs = 3_000, intervalMs = 100, composer = null } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const control = await findReadyDirectSendControl(page, composer);
    if (control) return control;
    await page.waitForTimeout(intervalMs);
  }
  return null;
}

async function clickReadyDirectSendControl(
  page,
  { timeoutMs = 5_000, composer = null, recorder = null } = {}
) {
  const control = await waitForReadyDirectSendControl(page, {
    timeoutMs,
    composer
  });
  if (!control) return null;

  if (typeof control.button.scrollIntoViewIfNeeded === "function") {
    await control.button.scrollIntoViewIfNeeded({ timeout: 1_500 }).catch(() => {});
  }

  let method = "direct-control";
  await recorder?.capture?.("before-submit-click", {
    selector: control.selector,
    scope: control.scope,
    method
  }).catch?.(() => {});
  try {
    // Prefer a normal actionability-checked click. A forced click can report
    // success while ChatGPT is replacing/covering the live submit control.
    await control.button.click({ timeout: 2_500 });
  } catch (clickError) {
    if (typeof control.button.evaluate === "function") {
      try {
        await control.button.evaluate((el) => el.click());
        method = "direct-dom-control";
      } catch {
        await control.button.click({ timeout: 2_000, force: true });
        method = "direct-force-control";
      }
    } else {
      await control.button.click({ timeout: 2_000, force: true });
      method = "direct-force-control";
    }
  }

  return {
    selector: control.selector,
    scope: control.scope,
    method
  };
}

async function pressComposerEnter(page, instruction) {
  const composer = await waitForReadyComposer(page, { timeoutMs: 2_000 });
  if (!composer) {
    return {
      executed: false,
      reason: "composer disappeared before Enter recovery"
    };
  }

  const persisted = await composerContainsExactInstruction(
    composer,
    instruction
  );
  if (persisted === false) {
    return {
      executed: false,
      reason: "composer changed before Enter recovery"
    };
  }

  await composer.click({ timeout: 1_500 });
  if (page.keyboard && typeof page.keyboard.press === "function") {
    await page.keyboard.press("Enter");
  } else {
    await composer.press("Enter", { timeout: 2_000 });
  }
  return {
    executed: true,
    method: "enter-recovery"
  };
}

async function waitForComposerSubmission(
  page,
  instruction,
  { timeoutMs = 2_000, intervalMs = 125 } = {}
) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  let readable = false;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const composer = await firstReadyComposer(page);
    if (!composer) {
      return {
        confirmed: true,
        evidence: "composer-disappeared"
      };
    }

    const stillExact = await composerContainsExactInstruction(
      composer,
      instruction
    );
    if (stillExact === false) {
      return {
        confirmed: true,
        evidence: "composer-changed"
      };
    }
    if (stillExact !== null) readable = true;

    if (attempt < attempts - 1 && typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(intervalMs);
    }
  }

  return {
    confirmed: false,
    evidence: readable
      ? "instruction-still-present"
      : "composer-state-unreadable"
  };
}

export async function inspectActionSurface(page) {
  if (!page) throw new TypeError("page is required");

  const composer = await firstReadyComposer(page);
  const composerReady = Boolean(composer);
  const controls = await visibleControlSnapshot(page);

  return {
    composerReady,
    retryControl: findSafeControl(controls, SAFE_RETRY_RE),
    continueControl: findSafeControl(controls, SAFE_CONTINUE_RE),
    sendControl: findSafeControl(
      controls,
      SAFE_SEND_RE,
      ["send-button", "composer-submit-button", "composer-send-button"]
    )
  };
}

async function clickControlBySemantic(page, control) {
  if (!control) throw new Error("safe control not found");

  if (control.testId) {
    const locator = page.locator(`[data-testid="${control.testId}"]`).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click();
      return;
    }
  }

  const exactText = control.ariaLabel || control.text;
  const locator = page.getByRole("button", { name: exactText, exact: true }).first();
  if (!(await locator.isVisible().catch(() => false))) {
    throw new Error("safe control disappeared before click");
  }
  await locator.click();
}

export async function sendComposerInstruction(
  page,
  instruction,
  { dryRun = true } = {}
) {
  if (!page) throw new TypeError("page is required");
  if (typeof instruction !== "string" || !instruction.trim()) {
    throw new Error("composer instruction is required");
  }

  if (!dryRun && typeof page.bringToFront === "function") {
    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(150);
  }

  const surface = await inspectActionSurface(page);
  if (!surface.composerReady && dryRun) {
    return {
      executed: false,
      dryRun,
      action: ACTIONS.CONTINUE,
      reason: "composer is not ready",
      rejection_class: SEND_REJECTION_CLASSES.COMPOSER_NOT_READY
    };
  }

  if (dryRun) {
    return {
      executed: false,
      dryRun: true,
      action: ACTIONS.CONTINUE,
      target: "COMPOSER_SEND"
    };
  }

  const recorder = await beginSubmitFlightRecording(page, instruction);
  const finish = async (result, { error = null } = {}) => {
    const stage = result?.executed ? "send-confirmed" : "send-failed";
    await recorder.capture(stage, {
      selector: result?.send_selector || null,
      scope: result?.send_scope || null,
      method: result?.send_method || null
    }).catch(() => {});
    const diagnosticDir = await recorder.finish({
      success: Boolean(result?.executed),
      result,
      error
    }).catch(() => null);
    return diagnosticDir
      ? { ...result, diagnostic_dir: diagnosticDir }
      : result;
  };

  try {
    const baselineUserTurns = await captureUserTurnState(page, instruction);
    await recorder.capture("before-type").catch(() => {});

    const textSet = await setComposerText(page, instruction);
    if (!textSet.ready) {
      return await finish({
        executed: false,
        dryRun: false,
        action: ACTIONS.CONTINUE,
        reason: textSet.reason,
        rejection_class: SEND_REJECTION_CLASSES.COMPOSER_NOT_READY
      });
    }
    // Do not let diagnostics run before the mention popover is dismissed.
    // The recorder is observational only and must never delay the control
    // action that makes the composer sendable.
    // "@M" is our protocol marker but also ChatGPT's mention/file trigger.
    // Dismiss that transient popover before looking for the submit control so
    // it cannot capture Enter or interfere with the send click.
    const mentionDismiss = await dismissMachineFrameMentionPopover(
      page,
      textSet.composer,
      instruction
    );
    if (mentionDismiss.attempted) {
      await recorder.capture("after-mention-dismiss", {
        preserved: mentionDismiss.preserved
      }).catch(() => {});
      if (!mentionDismiss.preserved) {
        return await finish({
          executed: false,
          dryRun: false,
          action: ACTIONS.CONTINUE,
          reason: "machine-frame mention dismissal changed composer text",
          rejection_class: SEND_REJECTION_CLASSES.COMPOSER_NOT_READY
        });
      }
      if (mentionDismiss.composer) {
        textSet.composer = mentionDismiss.composer;
      }
    }
    await recorder.capture("after-type-and-mention-dismiss", {
      preserved: mentionDismiss.preserved
    }).catch(() => {});

    // Prefer a Send control from the same composer form before falling back to
    // page-wide semantics. This prevents unrelated visible controls elsewhere in
    // a long ChatGPT conversation from being treated as the active submit button.
    const directSend = await clickReadyDirectSendControl(page, {
      composer: textSet.composer,
      recorder
    });
    let sendMethod = directSend?.method || null;
    let sendSelector = directSend?.selector || null;
    let sendScope = directSend?.scope || null;

    if (directSend) {
      await recorder.capture("after-primary-submit", {
        selector: sendSelector,
        scope: sendScope,
        method: sendMethod
      }).catch(() => {});
    }

    if (!directSend) {
      const afterFill = await inspectActionSurface(page);
      if (afterFill.sendControl) {
        sendSelector = afterFill.sendControl.testId
          ? `[data-testid="${afterFill.sendControl.testId}"]`
          : null;
        sendScope = "page-semantic";
        sendMethod = "semantic-control";
        await recorder.capture("before-semantic-submit", {
          selector: sendSelector,
          scope: sendScope,
          method: sendMethod
        }).catch(() => {});
        await clickControlBySemantic(page, afterFill.sendControl);
        await recorder.capture("after-primary-submit", {
          selector: sendSelector,
          scope: sendScope,
          method: sendMethod
        }).catch(() => {});
      } else {
        const composer = await waitForReadyComposer(page, { timeoutMs: 2_000 });
        if (!composer) {
          throw new Error("composer disappeared before send");
        }
        const persisted = await composerContainsExactInstruction(
          composer,
          instruction
        );
        if (persisted === false) {
          return await finish({
            executed: false,
            dryRun: false,
            action: ACTIONS.CONTINUE,
            reason: "composer lost instruction before send",
            rejection_class: SEND_REJECTION_CLASSES.COMPOSER_NOT_READY
          });
        }
        sendMethod = "enter-fallback";
        sendScope = "composer";
        await recorder.capture("before-enter-submit", {
          scope: sendScope,
          method: sendMethod
        }).catch(() => {});
        await composer.click({ timeout: 1_500 });
        if (page.keyboard && typeof page.keyboard.press === "function") {
          await page.keyboard.press("Enter");
        } else {
          await composer.press("Enter", { timeout: 2_000 });
        }
        await recorder.capture("after-primary-submit", {
          scope: sendScope,
          method: sendMethod
        }).catch(() => {});
      }
    }

    // A successful Playwright click is not sufficient evidence that ChatGPT
    // accepted the message. Require a local composer transition first.
    let submission = await waitForComposerSubmission(page, instruction);
    const primarySubmitEvidence = submission.evidence;

    // If the explicit Send click was inert and the exact instruction remains,
    // "@M" mention UI may have reopened. Dismiss it once more and retry a
    // direct Send control before falling back to Enter.
    if (
      !submission.confirmed &&
      submission.evidence === "instruction-still-present" &&
      MACHINE_FRAME_MENTION_RE.test(instruction)
    ) {
      const retryComposer = await waitForReadyComposer(page, { timeoutMs: 1_500 });
      if (retryComposer) {
        const dismissed = await dismissMachineFrameMentionPopover(
          page,
          retryComposer,
          instruction
        );
        if (dismissed.preserved) {
          const retrySend = await clickReadyDirectSendControl(page, {
            timeoutMs: 2_500,
            composer: dismissed.composer || retryComposer,
            recorder
          });
          if (retrySend) {
            sendMethod = sendMethod
              ? `${sendMethod}+${retrySend.method}-post-dismiss`
              : `${retrySend.method}-post-dismiss`;
            sendSelector = retrySend.selector || sendSelector;
            sendScope = retrySend.scope || sendScope;
            submission = await waitForComposerSubmission(page, instruction, {
              timeoutMs: 2_500
            });
          }
        }
      }
    }

    // If the explicit Send click is still inert and the exact instruction
    // remains, one bounded Enter recovery is safe because local evidence still
    // proves that no submission transition occurred and mention UI was closed.
    if (
      !submission.confirmed &&
      submission.evidence === "instruction-still-present" &&
      sendMethod !== "enter-fallback"
    ) {
      await recorder.capture("before-enter-recovery", {
        selector: sendSelector,
        scope: "composer",
        method: "enter-recovery"
      }).catch(() => {});
      const enterRecovery = await pressComposerEnter(page, instruction);
      if (enterRecovery.executed) {
        sendMethod = sendMethod
          ? `${sendMethod}+${enterRecovery.method}`
          : enterRecovery.method;
        sendScope = sendScope || "composer";
        await recorder.capture("after-enter-recovery", {
          selector: sendSelector,
          scope: sendScope,
          method: sendMethod
        }).catch(() => {});
        submission = await waitForComposerSubmission(page, instruction, {
          timeoutMs: 2_500
        });
      }
    }

    if (!submission.confirmed) {
      return await finish({
        executed: false,
        dryRun: false,
        action: ACTIONS.CONTINUE,
        target: "COMPOSER_SEND",
        input_method: textSet.method,
        send_method: sendMethod,
        send_selector: sendSelector,
        send_scope: sendScope,
        primary_submit_evidence: primarySubmitEvidence,
        submit_evidence: submission.evidence,
        user_turn_evidence: "not-checked",
        reason: "send control and bounded Enter recovery did not actuate composer submission",
        rejection_class: SEND_REJECTION_CLASSES.SEND_NOT_ACTUATED
      });
    }

    // Do not advance durable send latches only because the editor cleared.
    // Confirm that a new matching user turn actually appeared in the
    // conversation. This closes the gap where a click/Enter mutates the
    // composer but never creates a ChatGPT turn.
    const userTurn = await waitForMatchingUserTurn(
      page,
      instruction,
      baselineUserTurns
    );
    await recorder.capture("after-user-turn-verification", {
      selector: sendSelector,
      scope: sendScope,
      method: sendMethod
    }).catch(() => {});

    if (!userTurn.confirmed) {
      return await finish({
        executed: false,
        dryRun: false,
        action: ACTIONS.CONTINUE,
        target: "COMPOSER_SEND",
        input_method: textSet.method,
        send_method: sendMethod,
        send_selector: sendSelector,
        send_scope: sendScope,
        primary_submit_evidence: primarySubmitEvidence,
        submit_evidence: submission.evidence,
        user_turn_evidence: userTurn.evidence,
        reason: "composer transitioned but a matching new user turn was not observed",
        rejection_class: SEND_REJECTION_CLASSES.SEND_NOT_ACTUATED
      });
    }

    return await finish({
      executed: true,
      dryRun: false,
      action: ACTIONS.CONTINUE,
      target: "COMPOSER_SEND",
      input_method: textSet.method,
      send_method: sendMethod,
      send_selector: sendSelector,
      send_scope: sendScope,
      primary_submit_evidence: primarySubmitEvidence,
      submit_evidence: submission.evidence,
      user_turn_evidence: userTurn.evidence
    });
  } catch (error) {
    await recorder.capture("send-exception").catch(() => {});
    await recorder.finish({
      success: false,
      error
    }).catch(() => {});
    throw error;
  }
}

export async function executeDecision({
  page,
  decision,
  dryRun = true
}) {
  if (!page) throw new TypeError("page is required");
  if (!decision || typeof decision.action !== "string") {
    throw new TypeError("decision with action is required");
  }

  const surface = await inspectActionSurface(page);

  if (decision.action === ACTIONS.WAIT ||
      decision.action === ACTIONS.STOP_WAIT_USER ||
      decision.action === ACTIONS.STOP_DONE) {
    return {
      executed: false,
      dryRun,
      action: decision.action,
      reason: "decision requires no UI action"
    };
  }

  if (decision.action === ACTIONS.RETRY) {
    if (!surface.retryControl) {
      return {
        executed: false,
        dryRun,
        action: decision.action,
        reason: "safe retry control not present"
      };
    }

    if (!dryRun) await clickControlBySemantic(page, surface.retryControl);
    return {
      executed: !dryRun,
      dryRun,
      action: decision.action,
      target: "SAFE_RETRY_CONTROL"
    };
  }

  if (decision.action === ACTIONS.CONTINUE) {
    if (surface.continueControl) {
      if (!dryRun) await clickControlBySemantic(page, surface.continueControl);
      return {
        executed: !dryRun,
        dryRun,
        action: decision.action,
        target: "SAFE_CONTINUE_CONTROL"
      };
    }

    if (typeof decision.instruction !== "string" || !decision.instruction.trim()) {
      throw new Error("continue decision is missing canonical instruction");
    }

    return sendComposerInstruction(page, decision.instruction, { dryRun });
  }

  throw new Error(`unsupported decision action: ${decision.action}`);
}

