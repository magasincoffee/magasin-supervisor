import test from "node:test";
import assert from "node:assert/strict";

import { ACTIONS } from "../src/decision.mjs";
import { executeDecision, sendComposerInstruction, sendComposerWithAttachment } from "../src/ui/actions.mjs";

function fakeLocator({
  visible = true,
  onClick = () => {},
  onFill = () => {},
  onPress = () => {},
  onSetFiles = () => {},
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
    async setInputFiles(value) { onSetFiles(value); }
  };
}

function fakePage({
  composerVisible = true,
  controls = [],
  onClick = () => {},
  onFill = () => {},
  onPress = () => {},
  onSetFiles = () => {},
  onInsertText = () => {},
  fillError = null,
  fileInputPresent = true
} = {}) {
  return {
    async evaluate() { return controls; },
    locator(selector) {
      if (selector.includes("prompt-textarea") || selector.includes("contenteditable")) {
        return fakeLocator({
          visible: composerVisible,
          enabled: true,
          onFill,
          onPress,
          fillError
        });
      }
      if (selector.includes("input[type='file']")) {
        return fakeLocator({
          visible: fileInputPresent,
          enabled: true,
          count: fileInputPresent ? 1 : 0,
          onSetFiles
        });
      }
      if (selector.includes("data-testid")) {
        return fakeLocator({ visible: true, enabled: true, onClick });
      }
      return fakeLocator({ visible: false, enabled: false, count: 0 });
    },
    async waitForTimeout() {},
    async bringToFront() {},
    keyboard: {
      async insertText(value) { onInsertText(value); },
      async press(key) { onPress(key); }
    },
    getByRole() {
      return fakeLocator({ visible: true, onClick });
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


test("attachment relay fills text before upload and waits for explicit enabled Send", async () => {
  const events = [];
  const controls = [{
    text: "",
    ariaLabel: "Send prompt",
    testId: "send-button",
    disabled: false
  }];

  const result = await sendComposerWithAttachment(
    fakePage({
      controls,
      onFill: () => { events.push("fill"); },
      onSetFiles: () => { events.push("attach"); },
      onClick: () => { events.push("send"); }
    }),
    "relay full text",
    "C:\\temp\\work.png",
    { dryRun: false }
  );

  assert.equal(result.executed, true);
  assert.deepEqual(events, ["fill", "fill", "attach", "send"]);
});

test("disabled Send control is never selected as an attachment send target", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/ui/actions.mjs", import.meta.url), "utf8")
  );
  assert.match(source, /if \(control\.disabled\) return false/);
  assert.match(source, /attachment upload did not become ready before timeout/);
  assert.doesNotMatch(
    source,
    /await input\.setInputFiles\(filePath\);[\s\S]{0,200}await composer\.fill\(instruction\)/
  );
});


test("composer send prefers an exact visible send-button selector before bounded snapshot fallback", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/ui/actions.mjs", import.meta.url), "utf8")
  );

  assert.match(source, /DIRECT_SEND_SELECTORS/);
  assert.match(source, /button\\[data-testid="send-button"\\]:visible/);
  assert.match(source, /clickReadyDirectSendControl/);
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
  assert.match(source, /did not become editable before bounded timeout/);
});


test("attachment relay retry resets stale draft and attachments with bounded waits", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/ui/actions.mjs", import.meta.url), "utf8")
  );

  assert.match(source, /async function resetAttachmentDraft/);
  assert.match(source, /clearExistingAttachments/);
  assert.match(source, /maxRemovals = 8/);
  assert.match(source, /async function clearComposerText/);
  assert.match(source, /composer\.fill\("", \{ timeout: 1_500 \}\)/);
  assert.match(source, /keyboardClearComposer/);
  assert.match(source, /setInputFiles\(filePath, \{ timeout: 10_000 \}\)/);
  assert.match(source, /timeoutMs = 20_000/);
  assert.match(source, /await resetAttachmentDraft\(page, \{ timeoutMs: 2_000 \}\)/);
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

test("v49 attachment relay uses keyboard fallback without duplicating attachment send", async () => {
  const events = [];
  let fillCalls = 0;
  const timeout = new Error("locator.fill: Timeout 2500ms exceeded");
  timeout.name = "TimeoutError";
  const controls = [{
    text: "",
    ariaLabel: "Send prompt",
    testId: "send-button",
    disabled: false
  }];

  const result = await sendComposerWithAttachment(
    fakePage({
      controls,
      fillError: timeout,
      onFill: () => { fillCalls += 1; },
      onInsertText: () => { events.push("insert"); },
      onSetFiles: () => { events.push("attach"); },
      onClick: () => { events.push("send"); }
    }),
    "relay with fallback",
    "C:\\temp\\relay.png",
    { dryRun: false }
  );

  assert.equal(result.executed, true);
  assert.equal(fillCalls, 0);
  assert.deepEqual(events, ["insert", "attach", "send"]);
});
