import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  boundedRuntimeOperation,
  captureBaselineTurnBounded,
  runSingleConversationRuntime,
  runtimePollDelay
} from "../src/runtime/single-conversation-cli.mjs";
import {
  ensureSingleConversationState,
  readSingleConversationState
} from "../src/runtime/single-conversation-state.mjs";

async function tempState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc007-runtime-"));
  return { root, statePath: path.join(root, "state.json") };
}

test("SC-007 runtime dry-run starts from Source of Truth only", async () => {
  const { root, statePath } = await tempState();
  try {
    const result = await runSingleConversationRuntime({
      adapter: {},
      statePath,
      sourceOfTruthUrl: "https://example.com/SOURCE_OF_TRUTH.md",
      execute: false
    });
    assert.equal(result.status, "READY");
    assert.equal(result.chat_url_required, false);
    const state = await readSingleConversationState(statePath);
    assert.equal(state.mode, "SINGLE_CONVERSATION_V1");
    assert.equal(state.source_of_truth.url, "https://example.com/SOURCE_OF_TRUTH.md");
    assert.equal(Object.hasOwn(state, "planner"), false);
    assert.equal(Object.hasOwn(state, "executor"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-007 CLI exposes a qualification-only mode without chat URL arguments", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /--qualification-only/);
  assert.match(source, /qualificationOnly/);
  assert.doesNotMatch(source, /--planner-url|--executor-url|--chat-url/);
});

test("SC-007 runtime source mismatch fails closed", async () => {
  const { root, statePath } = await tempState();
  try {
    await ensureSingleConversationState(statePath, {
      sourceOfTruthUrl: "https://example.com/a"
    });
    await assert.rejects(
      runSingleConversationRuntime({
        adapter: {},
        statePath,
        sourceOfTruthUrl: "https://example.com/b",
        execute: false
      }),
      /different Source of Truth/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("SC-010 NEXT_WORK pacing is independent of a wedged Playwright page timer", async () => {
  let browserTimerTouched = false;
  const fakePage = {
    waitForTimeout() {
      browserTimerTouched = true;
      return new Promise(() => {});
    }
  };

  const started = Date.now();
  await runtimePollDelay(5);
  assert.equal(browserTimerTouched, false);
  assert.ok(Date.now() - started < 500);
  assert.equal(typeof fakePage.waitForTimeout, "function");
});

test("SC-010 bounded runtime operation rejects a never-resolving UI operation", async () => {
  await assert.rejects(
    boundedRuntimeOperation(
      "TEST_NEVER_RESOLVES",
      () => new Promise(() => {}),
      { timeoutMs: 15 }
    ),
    (error) =>
      error?.code === "SINGLE_CONVERSATION_RUNTIME_STALL" &&
      error?.stall_stage === "TEST_NEVER_RESOLVES"
  );
});

test("SC-010 baseline turn capture cannot hang NEXT_WORK indefinitely", async () => {
  const page = {
    evaluate() {
      return new Promise(() => {});
    }
  };
  await assert.rejects(
    captureBaselineTurnBounded(page, "assistant", { timeoutMs: 15 }),
    (error) =>
      error?.code === "SINGLE_CONVERSATION_RUNTIME_STALL" &&
      error?.stall_stage === "CAPTURE_BASELINE_ASSISTANT"
  );
});

test("SC-010 CLI maps bounded UI stalls to dedicated Chrome recovery", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /DISPOSABLE_CONVERSATION_PROBE_TIMEOUT/);
  assert.match(source, /SINGLE_CONVERSATION_RUNTIME_STALL/);
  assert.match(source, /exitCode = \[/);
  assert.match(source, /\? 75 : 1/);
  assert.match(source, /process\.exit\(exitCode\)/);
  assert.doesNotMatch(source, /await page\.waitForTimeout\(pollMs\)/);
});
