import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  nativeRuntimeSleep,
  runSingleConversationRuntime,
  withRuntimeDeadline
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


test("SC-010 unresolved NEXT_WORK UI step is bounded and requests recovery", async () => {
  const started = Date.now();
  await assert.rejects(
    withRuntimeDeadline(
      "NEXT_WORK_PROBE_PAGE",
      () => new Promise(() => {}),
      120
    ),
    (error) => {
      assert.equal(error?.code, "RUNTIME_UI_STEP_TIMEOUT");
      assert.equal(error?.step, "NEXT_WORK_PROBE_PAGE");
      return true;
    }
  );
  assert.ok(Date.now() - started < 2_000);
});

test("SC-010 inter-cycle delay uses native timer and production CLI has hard recovery exit", async () => {
  const started = Date.now();
  await nativeRuntimeSleep(20);
  assert.ok(Date.now() - started >= 10);

  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /page\.waitForTimeout\(pollMs\)/);
  assert.match(source, /NEXT_WORK_PROBE_PAGE/);
  assert.match(source, /RUNTIME_UI_STEP_TIMEOUT/);
  assert.match(source, /RECOVERY_REQUESTED/);
  assert.match(source, /finalExitCode = 75/);
  assert.match(source, /process\.exit\(finalExitCode\)/);
});
