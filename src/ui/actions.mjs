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
  'button#composer-submit-button:visible',
  'button[data-testid="composer-submit-button"]:visible',
  'button[data-testid="composer-send-button"]:visible',
  'button[data-testid*="send" i]:visible',
  'button[aria-label*="Send" i]:visible',
  'button[aria-label*="Gửi" i]:visible',
  'button[title*="Send" i]:visible',
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
  { timeoutMs = 5_000, composer = null } = {}
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

  // Prefer a Send control from the same composer form before falling back to
  // page-wide semantics. This prevents unrelated visible controls elsewhere in
  // a long ChatGPT conversation from being treated as the active submit button.
  const directSend = await clickReadyDirectSendControl(page, {
    composer: textSet.composer
  });
  let sendMethod = directSend?.method || null;
  let sendSelector = directSend?.selector || null;
  let sendScope = directSend?.scope || null;

  if (!directSend) {
    const afterFill = await inspectActionSurface(page);
    if (afterFill.sendControl) {
      await clickControlBySemantic(page, afterFill.sendControl);
      sendMethod = "semantic-control";
      sendScope = "page-semantic";
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
      sendScope = "composer";
    }
  }

  // A successful Playwright click is not sufficient evidence that ChatGPT
  // accepted the message. Require a local composer state transition before the
  // caller may advance the durable send latch to SEND_CLICKED. If the exact
  // instruction is still present, fail closed; the outer reconciliation pass
  // will reload the exact Work target and prove whether a user turn persisted
  // before any retry is allowed.
  let submission = await waitForComposerSubmission(page, instruction);
  const primarySubmitEvidence = submission.evidence;

  // If an explicit Send control was clicked but the exact instruction is still
  // present after a bounded observation window, the first actuation is proven
  // inert. Only in that state is one alternate Enter actuation safe: there is
  // still no local evidence that ChatGPT accepted the turn, so this does not
  // blindly replay an uncertain send.
  if (
    !submission.confirmed &&
    submission.evidence === "instruction-still-present" &&
    sendMethod !== "enter-fallback"
  ) {
    const enterRecovery = await pressComposerEnter(page, instruction);
    if (enterRecovery.executed) {
      sendMethod = sendMethod
        ? `${sendMethod}+${enterRecovery.method}`
        : enterRecovery.method;
      sendScope = sendScope || "composer";
      submission = await waitForComposerSubmission(page, instruction, {
        timeoutMs: 2_500
      });
    }
  }

  if (!submission.confirmed) {
    return {
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
      reason: "send control and bounded Enter recovery did not actuate composer submission",
      rejection_class: SEND_REJECTION_CLASSES.SEND_NOT_ACTUATED
    };
  }

  return {
    executed: true,
    dryRun: false,
    action: ACTIONS.CONTINUE,
    target: "COMPOSER_SEND",
    input_method: textSet.method,
    send_method: sendMethod,
    send_selector: sendSelector,
    send_scope: sendScope,
    primary_submit_evidence: primarySubmitEvidence,
    submit_evidence: submission.evidence
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

