import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  boundedRuntimeStep,
  runSingleConversationRuntime,
  waitForNextCycleDelay
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


test("SC-010 inter-cycle delay does not depend on Playwright page RPC", async () => {
  let slept = 0;
  await waitForNextCycleDelay(25, {
    sleep: async (ms) => {
      slept = ms;
    }
  });
  assert.equal(slept, 25);

  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /page\.waitForTimeout\(pollMs\)/);
  assert.match(source, /await waitForNextCycleDelay\(pollMs\)/);
});

test("SC-010 bounded runtime step converts a hung NEXT_WORK UI probe into recovery", async () => {
  await assert.rejects(
    boundedRuntimeStep(
      "NEXT_WORK_RECOVERY_PROBE",
      () => new Promise(() => {}),
      { timeoutMs: 20 }
    ),
    (error) => {
      assert.equal(error?.code, "CDP_RECOVERY_REQUIRED");
      assert.equal(error?.runtime_stage, "NEXT_WORK_RECOVERY_PROBE");
      return true;
    }
  );
});

test("SC-010 production CLI maps watchdog recovery to wrapper exit 75 and bounds cleanup", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /NEXT_WORK_RECOVERY_PROBE/);
  assert.match(source, /NEXT_WORK_CAPTURE_USER/);
  assert.match(source, /NEXT_WORK_CAPTURE_ASSISTANT/);
  assert.match(source, /code === "CDP_RECOVERY_REQUIRED" \? 75 : 1/);
  assert.match(source, /boundedRuntimeCleanup\(\(\) => adapter\.close\(\), 1_500\)/);
  assert.match(source, /process\.exit\(finalExitCode\)/);
});


test("SC-010 qualification-only ignores terminal-looking assistant text until maxCycles", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /const terminal = qualificationOnly\s*\? null\s*:\s*terminalAnswer\(response\.assistant_turn\?\.text\)/
  );
  assert.match(source, /while \(maxCycles <= 0 \|\| cycles < maxCycles\)/);
});
