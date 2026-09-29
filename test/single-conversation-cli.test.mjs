import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runSingleConversationRuntime, runtimeOwnedDelay, withRuntimeDeadline } from "../src/runtime/single-conversation-cli.mjs";
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


test("SC-010 inter-cycle delay is runtime-owned and does not depend on Playwright page timers", async () => {
  let requested = null;
  let callback = null;
  const promise = runtimeOwnedDelay(25, {
    setTimeoutImpl(fn, ms) {
      requested = ms;
      callback = fn;
      return { unref() {} };
    }
  });
  assert.equal(requested, 25);
  assert.equal(typeof callback, "function");
  callback();
  await promise;
});

test("SC-010 runtime deadline converts a never-resolving UI operation into deterministic recovery", async () => {
  await assert.rejects(
    withRuntimeDeadline(
      "NEXT_WORK_CAPTURE_USER",
      () => new Promise(() => {}),
      20
    ),
    (error) =>
      error?.code === "CDP_STALL_RECOVERY_REQUIRED" &&
      error?.runtime_operation === "NEXT_WORK_CAPTURE_USER"
  );
});

test("SC-010 production CLI maps a UI stall to wrapper Chrome recovery and exits explicitly", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /page\.waitForTimeout\(pollMs\)/);
  assert.match(source, /await runtimeOwnedDelay\(pollMs\)/);
  assert.match(source, /CDP_STALL_RECOVERY_REQUIRED/);
  assert.match(source, /finalExitCode[\s\S]*?\? 75[\s\S]*?: 1/);
  assert.match(source, /process\.exit\(finalExitCode\)/);
});
