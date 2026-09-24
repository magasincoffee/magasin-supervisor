import { ACTIONS } from "../decision.mjs";
import { collectSafeUiSnapshot } from "./snapshot.mjs";

const SAFE_RETRY_RE = /^(try again|retry|thử lại)$/i;
const SAFE_CONTINUE_RE = /^(continue generating|continue response|tiếp tục tạo|tiếp tục)$/i;
const SAFE_SEND_RE = /^(send|send prompt|gửi|gửi tin nhắn)$/i;
export const SEND_REJECTION_CLASSES = Object.freeze({
  NONE: "NONE",
  CAPACITY_REJECTED: "CAPACITY_REJECTED",
  NETWORK_TRANSIENT: "NETWORK_TRANSIENT",
  RATE_LIMITED: "RATE_LIMITED",
  AUTH_SECURITY: "AUTH_SECURITY",
  TRANSIENT: "TRANSIENT",
  COMPOSER_NOT_READY: "COMPOSER_NOT_READY",
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
  if (snapshot.rateLimited) {
    return SEND_REJECTION_CLASSES.RATE_LIMITED;
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
  "[contenteditable='true'][role='textbox']:visible",
  "textarea:visible",
  "[contenteditable='true']:visible"
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
  const editable = typeof composer?.isEditable === "function"
    ? await composer.isEditable().catch(() => false)
    : enabled;
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

  try {
    await composer.fill(instruction, { timeout: 2_500 });
    return { ready: true, method: "fill", composer };
  } catch (fillError) {
    // ChatGPT can replace the ProseMirror composer between readiness probing
    // and locator.fill(). Reacquire the live editor and use one keyboard
    // transaction so a detached locator cannot turn into a retry loop.
    const fresh = await waitForReadyComposer(page, { timeoutMs: 3_000 });
    if (!fresh) throw fillError;
    await keyboardClearComposer(page, fresh);
    if (!page.keyboard || typeof page.keyboard.insertText !== "function") {
      throw fillError;
    }
    await page.keyboard.insertText(instruction);
    await page.waitForTimeout(120);

    const afterInsert = await waitForReadyComposer(page, { timeoutMs: 1_500 });
    if (!afterInsert) {
      throw new Error("composer disappeared after keyboard text insertion");
    }
    return { ready: true, method: "keyboard", composer: afterInsert };
  }
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

export async function inspectActionSurface(page) {
  if (!page) throw new TypeError("page is required");

  const composer = await firstReadyComposer(page);
  const composerReady = Boolean(composer);
  const controls = await visibleControlSnapshot(page);

  return {
    composerReady,
    retryControl: findSafeControl(controls, SAFE_RETRY_RE),
    continueControl: findSafeControl(controls, SAFE_CONTINUE_RE),
    sendControl: findSafeControl(controls, SAFE_SEND_RE, ["send-button"])
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

  const beforeMutation = await collectSafeUiSnapshot(page).catch(() => null);
  if (beforeMutation?.rateLimited) {
    return {
      executed: false,
      dryRun: false,
      action: ACTIONS.CONTINUE,
      reason: "CHATGPT_RATE_LIMITED",
      rejection_class: SEND_REJECTION_CLASSES.RATE_LIMITED
    };
  }

  const textSet = await setComposerText(page, instruction);
  if (!textSet.ready) {
    return {
      executed: false,
      dryRun: false,
      action: ACTIONS.CONTINUE,
      reason: textSet.reason,
      rejection_class: SEND_REJECTION_CLASSES.COMPOSER_NOT_READY
    };
  }

  const afterFillSnapshot = await collectSafeUiSnapshot(page).catch(() => null);
  if (afterFillSnapshot?.rateLimited) {
    return {
      executed: false,
      dryRun: false,
      action: ACTIONS.CONTINUE,
      reason: "CHATGPT_RATE_LIMITED",
      rejection_class: SEND_REJECTION_CLASSES.RATE_LIMITED
    };
  }

  const afterFill = await inspectActionSurface(page);
  if (afterFill.sendControl) {
    await clickControlBySemantic(page, afterFill.sendControl);
  } else {
    const composer = await waitForReadyComposer(page, { timeoutMs: 2_000 });
    if (!composer) {
      throw new Error("composer disappeared before send");
    }
    await composer.press("Enter", { timeout: 2_000 });
  }

  return {
    executed: true,
    dryRun: false,
    action: ACTIONS.CONTINUE,
    target: "COMPOSER_SEND"
  };
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


const ATTACHMENT_BUTTON_RE =
  /attach|upload|add files|add photos|đính kèm|tải lên|thêm tệp|thêm ảnh/i;
const REMOVE_ATTACHMENT_SELECTOR = [
  "button[aria-label*='Remove file' i]",
  "button[aria-label*='Remove attachment' i]",
  "button[aria-label*='Remove image' i]",
  "button[title*='Remove file' i]",
  "button[title*='Remove attachment' i]",
  "button[aria-label*='Xóa tệp' i]",
  "button[aria-label*='Xóa ảnh' i]"
].join(",");

async function clearExistingAttachments(
  page,
  { maxRemovals = 8 } = {}
) {
  let removed = 0;
  while (removed < maxRemovals) {
    const button = page.locator(REMOVE_ATTACHMENT_SELECTOR).first();
    const visible = await button.isVisible().catch(() => false);
    if (!visible) break;
    await button.click({ timeout: 2_000 }).catch(() => {});
    removed += 1;
    await page.waitForTimeout(120);
  }
  return removed;
}

async function resetAttachmentDraft(
  page,
  { timeoutMs = 3_000 } = {}
) {
  const cleared = await clearComposerText(page, { timeoutMs });
  if (!cleared.ready) return cleared;
  await clearExistingAttachments(page);
  return { ready: true, method: cleared.method };
}

async function resolveFileInput(page) {
  let input = page.locator("input[type='file']").first();
  if (await input.count().catch(() => 0)) return input;

  const attachButton = page.getByRole("button", { name: ATTACHMENT_BUTTON_RE }).first();
  if (await attachButton.isVisible().catch(() => false)) {
    await attachButton.click({ timeout: 3_000 });
    await page.waitForTimeout(250);
    input = page.locator("input[type='file']").first();
    if (await input.count().catch(() => 0)) return input;
  }
  return null;
}

async function waitForAttachmentReady(
  page,
  { timeoutMs = 20_000, intervalMs = 250 } = {}
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const composer = await firstReadyComposer(page);
    const surface = await inspectActionSurface(page).catch(() => null);

    if (composer && surface?.sendControl) {
      return { ready: true, sendControl: surface.sendControl };
    }
    await page.waitForTimeout(intervalMs);
  }

  return {
    ready: false,
    reason: "attachment upload did not become ready before timeout"
  };
}

export async function sendComposerWithAttachment(
  page,
  instruction,
  filePath,
  { dryRun = true } = {}
) {
  if (!page) throw new TypeError("page is required");
  // Relay normally follows a Work-page capture. Bring the Brain page to the
  // foreground before probing/filling because ChatGPT may temporarily stop
  // rendering the editable composer in a background tab.
  if (!dryRun && typeof page.bringToFront === "function") {
    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(250);
  }
  if (typeof instruction !== "string" || !instruction.trim()) {
    throw new Error("composer instruction is required");
  }
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("attachment path is required");
  }

  const surface = await inspectActionSurface(page);
  if (!surface.composerReady && dryRun) {
    return {
      executed: false,
      dryRun,
      action: ACTIONS.CONTINUE,
      reason: "composer is not ready"
    };
  }

  if (dryRun) {
    return {
      executed: false,
      dryRun: true,
      action: ACTIONS.CONTINUE,
      target: "COMPOSER_ATTACHMENT_SEND"
    };
  }

  // Every retry starts from a clean local draft. This prevents a prior
  // uncertain attempt from stacking text or attachments before exact-once
  // relay reconciliation decides whether another send is safe.
  const reset = await resetAttachmentDraft(page);
  if (!reset.ready) {
    return {
      executed: false,
      dryRun: false,
      action: ACTIONS.CONTINUE,
      reason: reset.reason
    };
  }

  const textSet = await setComposerText(page, instruction);
  if (!textSet.ready) {
    return {
      executed: false,
      dryRun: false,
      action: ACTIONS.CONTINUE,
      reason: textSet.reason
    };
  }

  const input = await resolveFileInput(page);
  if (!input) {
    await resetAttachmentDraft(page, { timeoutMs: 1_500 });
    return {
      executed: false,
      dryRun: false,
      action: ACTIONS.CONTINUE,
      reason: "attachment input is not available"
    };
  }

  try {
    await input.setInputFiles(filePath, { timeout: 10_000 });
  } catch (error) {
    await resetAttachmentDraft(page, { timeoutMs: 1_500 });
    throw error;
  }

  const ready = await waitForAttachmentReady(page);
  if (!ready.ready) {
    await resetAttachmentDraft(page, { timeoutMs: 2_000 });
    return {
      executed: false,
      dryRun: false,
      action: ACTIONS.CONTINUE,
      reason: ready.reason
    };
  }

  try {
    await clickControlBySemantic(page, ready.sendControl);
  } catch (error) {
    await resetAttachmentDraft(page, { timeoutMs: 2_000 });
    throw error;
  }

  return {
    executed: true,
    dryRun: false,
    action: ACTIONS.CONTINUE,
    target: "COMPOSER_ATTACHMENT_SEND"
  };
}

