import test from "node:test";
import assert from "node:assert/strict";

import { ACTIONS } from "../src/decision.mjs";
import { executeDecision, sendComposerInstruction } from "../src/ui/actions.mjs";

function fakeLocator({
  visible = true,
  onClick = () => {},
  onFill = () => {},
  onPress = () => {},
  inputValue = null,
  fillError = null,
  enabled = true,
  editable = true,
  count = 1
} = {}) {
  return {
    first() { return this; },
    async isVisible() { return visible; },
    async isEnabled() { return enabled; },
    async isEditable() { return editable; },
    async count() { return count; },
    async click() { onClick(); },
    async fill(value) {
      if (fillError) throw fillError;
      onFill(value);
    },
    async press(key) { onPress(key); },
    async inputValue() {
      if (typeof inputValue === "function") return inputValue();
      throw new Error("inputValue unavailable");
    }
  };
}

function fakePage({
  composerVisible = true,
  controls = [],
  onClick = () => {},
  onFill = () => {},
  onPress = () => {},
  onInsertText = () => {},
  fillError = null
} = {}) {
  let composerText = "";

  const composer = () => fakeLocator({
    visible: composerVisible,
    enabled: true,
    fillError,
    inputValue: () => composerText,
    onFill: (value) => {
      composerText = value;
      onFill(value);
    },
    onPress: (key) => {
      if (key === "Backspace" || key === "Enter") composerText = "";
      onPress(key);
    }
  });

  const sendControl = () => fakeLocator({
    visible: true,
    enabled: true,
    onClick: () => {
      composerText = "";
      onClick();
    }
  });

  return {
    async evaluate() { return controls; },
    locator(selector) {
      if (
        selector.includes("prompt-textarea") ||
        selector.includes("contenteditable") ||
        selector.includes("textarea")
      ) {
        return composer();
      }
      if (selector.includes("data-testid")) {
        return sendControl();
      }
      return fakeLocator({ visible: false, enabled: false, count: 0 });
    },
    async waitForTimeout() {},
    async bringToFront() {},
    keyboard: {
      async insertText(value) {
        composerText = value;
        onInsertText(value);
      },
      async press(key) {
        if (key === "Enter") composerText = "";
        onPress(key);
      }
    },
    getByRole() {
      return sendControl();
    }
  };
}

test("dry-run continue plans composer send without mutation", async () => {
  let filled = false;
  const result = await executeDecision({
    page: fakePage({ onFill: () => { filled = true; } }),
    decision: {
      action: ACTIONS.CONTINUE,
      instruction: "continue"
    },
    dryRun: true
  });

  assert.equal(result.target, "COMPOSER_SEND");
  assert.equal(result.executed, false);
  assert.equal(filled, false);
});

test("live continue fills canonical instruction and uses send control", async () => {
  let filled = null;
  let clicks = 0;
  const controls = [{ text: "", ariaLabel: "Send prompt", testId: "send-button" }];

  const result = await executeDecision({
    page: fakePage({
      controls,
      onFill: (value) => { filled = value; },
      onClick: () => { clicks += 1; }
    }),
    decision: {
      action: ACTIONS.CONTINUE,
      instruction: "canonical continue instruction"
    },
    dryRun: false
  });

  assert.equal(result.executed, true);
  assert.equal(filled, "canonical continue instruction");
  assert.equal(clicks, 1);
});

test("retry clicks only a recognized retry control", async () => {
  let clicks = 0;
  const result = await executeDecision({
    page: fakePage({
      controls: [{ text: "Try again", ariaLabel: "", testId: null }],
      onClick: () => { clicks += 1; }
    }),
    decision: { action: ACTIONS.RETRY },
    dryRun: false
  });

  assert.equal(result.executed, true);
  assert.equal(result.target, "SAFE_RETRY_CONTROL");
  assert.equal(clicks, 1);
});

test("retry fails closed when no safe retry control exists", async () => {
  const result = await executeDecision({
    page: fakePage({
      controls: [{ text: "Delete account", ariaLabel: "", testId: null }]
    }),
    decision: { action: ACTIONS.RETRY },
    dryRun: false
  });

  assert.equal(result.executed, false);
  assert.match(result.reason, /safe retry control not present/);
});

test("continue does not send if composer is unavailable", async () => {
  const result = await executeDecision({
    page: fakePage({ composerVisible: false }),
    decision: {
      action: ACTIONS.CONTINUE,
      instruction: "continue"
    },
    dryRun: false
  });

  assert.equal(result.executed, false);
  assert.match(result.reason, /composer is not ready/);
});

test("wait/stop decisions never mutate UI", async () => {
  for (const action of [ACTIONS.WAIT, ACTIONS.STOP_WAIT_USER, ACTIONS.STOP_DONE]) {
    const result = await executeDecision({
      page: fakePage(),
      decision: { action },
      dryRun: false
    });
    assert.equal(result.executed, false);
  }
});


test("action surface targets only a visible composer", async () => {
  let selectorSeen = "";
  const page = fakePage();
  const original = page.locator;
  page.locator = (selector) => {
    selectorSeen = selector;
    return original(selector);
  };

  await executeDecision({
    page,
    decision: { action: ACTIONS.CONTINUE, instruction: "continue" },
    dryRun: true
  });

  assert.match(selectorSeen, /:visible/);
});


test("dynamic composer send never clicks Continue-generating as a substitute", async () => {
  let filled = null;
  let clicks = 0;
  const controls = [
    { text: "Continue generating", ariaLabel: "", testId: null },
    { text: "", ariaLabel: "Send prompt", testId: "send-button" }
  ];

  const result = await sendComposerInstruction(
    fakePage({
      controls,
      onFill: (value) => { filled = value; },
      onClick: () => { clicks += 1; }
    }),
    "Dynamic Brain directive for worker-2",
    { dryRun: false }
  );

  assert.equal(result.target, "COMPOSER_SEND");
  assert.equal(result.executed, true);
  assert.equal(filled, "Dynamic Brain directive for worker-2");
  assert.equal(clicks, 1);
});

test("long conversations bypass the 200-control snapshot and click the exact send button", async () => {
  let clicks = 0;
  const controls = Array.from({ length: 260 }, (_, index) => ({
    text: "Other control " + index,
    ariaLabel: "",
    testId: null,
    disabled: false
  }));

  const result = await sendComposerInstruction(
    fakePage({
      controls,
      onClick: () => { clicks += 1; }
    }),
    "dispatch must be sent even in a long conversation",
    { dryRun: false }
  );

  assert.equal(result.executed, true);
  assert.equal(clicks, 1);
});


test("plaintext-only ChatGPT composer is accepted as an editable surface", async () => {
  let filled = null;
  let clicks = 0;
  let composerText = "";

  const composer = {
    first() { return this; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async isEditable() { return false; },
    async getAttribute(name) {
      if (name === "contenteditable") return "plaintext-only";
      if (name === "role") return "textbox";
      return null;
    },
    async fill(value) {
      filled = value;
      composerText = value;
    },
    async inputValue() { return composerText; },
    async click() {},
    async press() {}
  };
  const send = {
    first() { return this; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async click() {
      clicks += 1;
      composerText = "";
    }
  };
  const page = {
    locator(selector) {
      if (selector.includes("send-button")) return send;
      return composer;
    },
    async evaluate() { return []; },
    async waitForTimeout() {},
    async bringToFront() {},
    keyboard: { async press() {}, async insertText() {} },
    getByRole() { return send; }
  };

  const result = await sendComposerInstruction(
    page,
    "plaintext-only composer dispatch",
    { dryRun: false }
  );

  assert.equal(result.executed, true);
  assert.equal(filled, "plaintext-only composer dispatch");
  assert.equal(clicks, 1);
  assert.equal(result.send_method, "direct-control");
});

test("fill success without persisted text falls back to a real keyboard insertion", async () => {
  const events = [];
  let composerText = "";

  const composer = {
    first() { return this; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async isEditable() { return true; },
    async fill() {
      events.push("fill");
      // Simulate the live React editor dropping the programmatic fill.
    },
    async inputValue() { return composerText; },
    async click() { events.push("composer-click"); },
    async press(key) {
      events.push(`press:${key}`);
      if (key === "Backspace") composerText = "";
    }
  };
  const send = {
    first() { return this; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async click() {
      composerText = "";
      events.push("send");
    }
  };
  const page = {
    locator(selector) {
      if (selector.includes("send-button")) return send;
      return composer;
    },
    async evaluate() { return []; },
    async waitForTimeout() {},
    async bringToFront() {},
    keyboard: {
      async insertText(value) {
        composerText = value;
        events.push(`insert:${value}`);
      },
      async press(key) { events.push(`keyboard:${key}`); }
    },
    getByRole() { return send; }
  };

  const result = await sendComposerInstruction(
    page,
    "must persist before send",
    { dryRun: false }
  );

  assert.equal(result.executed, true);
  assert.equal(result.input_method, "keyboard");
  assert.equal(composerText, "");
  assert.equal(result.submit_evidence, "composer-changed");
  assert.ok(events.includes("fill"));
  assert.ok(events.includes("insert:must persist before send"));
  assert.equal(events.at(-1), "send");
});

test("composer send recovers an inert Send click with one bounded Enter", async () => {
  let composerText = "";
  let clicks = 0;
  let enters = 0;

  const composer = {
    first() { return this; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async isEditable() { return true; },
    async fill(value) { composerText = value; },
    async inputValue() { return composerText; },
    async click() {},
    async press() {}
  };
  const inertSend = {
    first() { return this; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async click() { clicks += 1; }
  };
  const page = {
    locator(selector) {
      if (selector.includes("send-button")) return inertSend;
      return composer;
    },
    async evaluate() { return []; },
    async waitForTimeout() {},
    async bringToFront() {},
    keyboard: {
      async press(key) {
        if (key === "Enter") {
          enters += 1;
          composerText = "";
        }
      },
      async insertText() {}
    },
    getByRole() { return inertSend; }
  };

  const result = await sendComposerInstruction(
    page,
    "recover after inert click",
    { dryRun: false }
  );

  assert.equal(clicks, 1);
  assert.equal(enters, 1);
  assert.equal(result.executed, true);
  assert.equal(result.primary_submit_evidence, "instruction-still-present");
  assert.equal(result.submit_evidence, "composer-changed");
  assert.match(result.send_method, /enter-recovery/);
  assert.equal(composerText, "");
});

test("composer send fails closed when click and Enter are both inert", async () => {
  let composerText = "";
  let clicks = 0;
  let enters = 0;

  const composer = {
    first() { return this; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async isEditable() { return true; },
    async fill(value) { composerText = value; },
    async inputValue() { return composerText; },
    async click() {},
    async press() {}
  };
  const inertSend = {
    first() { return this; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async click() { clicks += 1; }
  };
  const page = {
    locator(selector) {
      if (selector.includes("send-button")) return inertSend;
      return composer;
    },
    async evaluate() { return []; },
    async waitForTimeout() {},
    async bringToFront() {},
    keyboard: {
      async press(key) {
        if (key === "Enter") enters += 1;
      },
      async insertText() {}
    },
    getByRole() { return inertSend; }
  };

  const result = await sendComposerInstruction(
    page,
    "must not be reported as sent",
    { dryRun: false }
  );

  assert.equal(clicks, 1);
  assert.equal(enters, 1);
  assert.equal(result.executed, false);
  assert.equal(result.rejection_class, "SEND_NOT_ACTUATED");
  assert.equal(result.primary_submit_evidence, "instruction-still-present");
  assert.equal(result.submit_evidence, "instruction-still-present");
  assert.equal(composerText, "must not be reported as sent");
});

test("RBT-010 UI action layer contains no attachment upload path", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/ui/actions.mjs", import.meta.url), "utf8")
  );

  assert.doesNotMatch(source, /setInputFiles/);
  assert.doesNotMatch(source, /COMPOSER_ATTACHMENT_SEND/);
  assert.doesNotMatch(source, /sendComposerWithAttachment/);
  assert.match(source, /page\.bringToFront/);
});

test("composer send prefers an exact visible send-button selector before bounded snapshot fallback", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/ui/actions.mjs", import.meta.url), "utf8")
  );

  assert.match(source, /DIRECT_SEND_SELECTORS/);
  assert.match(source, /data-testid="send-button"/);
  assert.match(source, /composer-submit-button/);
  assert.match(source, /button\[type="submit"\]/);
  assert.match(source, /FORM_SEND_SELECTORS/);
  assert.match(source, /data-testid\*="send"/);
  assert.match(source, /clickReadyDirectSendControl/);
  assert.match(source, /ancestor::form\[1\]/);
  assert.match(source, /waitForComposerSubmission/);
  assert.match(source, /pressComposerEnter/);
  assert.match(source, /enter-recovery/);
  assert.match(source, /force: true/);
});

test("live composer send uses bounded editable readiness instead of a 60s implicit fill wait", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/ui/actions.mjs", import.meta.url), "utf8")
  );

  assert.match(source, /async function waitForReadyComposer/);
  assert.match(source, /timeoutMs = 8_000/);
  assert.match(source, /isEditable/);
  assert.match(source, /async function setComposerText/);
  assert.match(source, /composer\.fill\(instruction, \{ timeout: 2_500 \}\)/);
  assert.match(source, /page\.keyboard\.insertText\(instruction\)/);
  assert.match(source, /contenteditable="plaintext-only"/);
  assert.match(source, /composerContainsExactInstruction/);
  assert.match(source, /did not become editable before bounded timeout/);
});


test("v49 composer transaction falls back to keyboard after detached fill timeout", async () => {
  const events = [];
  const timeout = new Error("locator.fill: Timeout 2500ms exceeded");
  timeout.name = "TimeoutError";
  const controls = [{
    text: "",
    ariaLabel: "Send prompt",
    testId: "send-button",
    disabled: false
  }];

  const result = await sendComposerInstruction(
    fakePage({
      controls,
      fillError: timeout,
      onPress: (key) => { events.push(`press:${key}`); },
      onInsertText: (text) => { events.push(`insert:${text}`); },
      onClick: () => { events.push("send"); }
    }),
    "transactional fallback text",
    { dryRun: false }
  );

  assert.equal(result.executed, true);
  assert.ok(events.includes("press:Control+A") || events.includes("press:Meta+A"));
  assert.ok(events.includes("press:Backspace"));
  assert.ok(events.includes("insert:transactional fallback text"));
  assert.equal(events.at(-1), "send");
});

