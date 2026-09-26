import { ACTIONS } from "../decision.mjs";

const SAFE_RETRY_RE = /^(try again|retry|thử lại)$/i;
const SAFE_CONTINUE_RE = /^(continue generating|continue response|tiếp tục tạo|tiếp tục)$/i;
const SAFE_SEND_RE = /^(send|send prompt|gửi|gửi tin nhắn)$/i;
export const SEND_REJECTION_CLASSES = Object.freeze({
  NONE: "NONE",
  CAPACITY_REJECTED: "CAPACITY_REJECTED",
  NETWORK_TRANSIENT: "NETWORK_TRANSIENT",
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
    .replace(/\u200B/g, "")
    .replace(/\r\n/g, "\n")
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
        return el.innerText || el.textContent || "";
      });
    } catch {}
  }

  return null;
}

async function composerContainsExactInstruction(composer, instruction) {
  const text = await readComposerText(composer);
  if (text === null) return null;
  return normalizeComposerText(text) === normalizeComposerText(instruction);
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
  if (persisted === false) {
    return {
      ready: false,
      reason: "composer text did not persist after bounded keyboard insertion"
    };
  }

  return { ready: true, method: "keyboard", composer: afterInsert };
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
  'button[data-testid="composer-submit-button"]:visible',
  'button[data-testid="composer-send-button"]:visible',
  'button[data-testid*="send" i]:visible',
  'button[aria-label*="Send" i]:visible',
  'button[aria-label*="Gửi" i]:visible',
  'button[title*="Send" i]:visible',
  'button[title*="Gửi" i]:visible'
]);

async function findReadyDirectSendControl(page) {
  for (const selector of DIRECT_SEND_SELECTORS) {
    const button = page.locator(selector).first();
    const visible = await button.isVisible().catch(() => false);
    if (!visible) continue;
    const enabled = typeof button.isEnabled === "function"
      ? await button.isEnabled().catch(() => false)
      : true;
    if (enabled) return { button, selector };
  }
  return null;
}

async function waitForReadyDirectSendControl(
  page,
  { timeoutMs = 3_000, intervalMs = 100 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const control = await findReadyDirectSendControl(page);
    if (control) return control;
    await page.waitForTimeout(intervalMs);
  }
  return null;
}

async function clickReadyDirectSendControl(
  page,
  { timeoutMs = 5_000 } = {}
) {
  const control = await waitForReadyDirectSendControl(page, { timeoutMs });
  if (!control) return null;

  // The selector is already constrained to the visible, enabled composer send
  // control. Force-click avoids long actionability waits caused by transient
  // ChatGPT animations/overlays while preserving the exact semantic target.
  await control.button.click({ timeout: 2_000, force: true });
  return control.selector;
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

  // Prefer the exact composer send control directly. Long ChatGPT
  // conversations can contain more than 200 visible buttons, so the bounded
  // semantic snapshot may omit the blue send control beside the composer.
  const directSendSelector = await clickReadyDirectSendControl(page);
  let sendMethod = directSendSelector ? "direct-control" : null;

  if (!directSendSelector) {
    const afterFill = await inspectActionSurface(page);
    if (afterFill.sendControl) {
      await clickControlBySemantic(page, afterFill.sendControl);
      sendMethod = "semantic-control";
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
        return {
          executed: false,
          dryRun: false,
          action: ACTIONS.CONTINUE,
          reason: "composer lost instruction before send",
          rejection_class: SEND_REJECTION_CLASSES.COMPOSER_NOT_READY
        };
      }
      await composer.click({ timeout: 1_500 });
      if (page.keyboard && typeof page.keyboard.press === "function") {
        await page.keyboard.press("Enter");
      } else {
        await composer.press("Enter", { timeout: 2_000 });
      }
      sendMethod = "enter-fallback";
    }
  }

  return {
    executed: true,
    dryRun: false,
    action: ACTIONS.CONTINUE,
    target: "COMPOSER_SEND",
    input_method: textSet.method,
    send_method: sendMethod,
    send_selector: directSendSelector || null
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

