import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  boundedRuntimeStep,
  canRebindEnqueuedStatusCheck,
  canResumePreActuationDiscovery,
  reconstructPendingStatusCheckMessage,
  runSingleConversationRuntime,
  waitForNextCycleDelay
} from "../src/runtime/single-conversation-cli.mjs";
import { composerInstructionDigest } from "../src/ui/actions.mjs";
import { buildSingleConversationTaskInstruction } from "../src/runtime/single-conversation-loop.mjs";
import {
  ensureSingleConversationState,
  readSingleConversationState
} from "../src/runtime/single-conversation-state.mjs";

async function tempState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc007-runtime-"));
  return { root, statePath: path.join(root, "state.json") };
}

test("SC-013 restart rebind permits only proven pre-actuation task discovery recovery", () => {
  const candidate = {
    conversation: { status: "ACTIVE" },
    outbound: {
      state: "ENQUEUED",
      kind: "SOURCE_OF_TRUTH_TASK_DISCOVERY",
      message_id: "sc013-pending",
      message_digest: "digest",
      retry_count: 0,
      last_pre_actuation_error_code: "COMPOSER_NOT_READY"
    }
  };

  assert.equal(canResumePreActuationDiscovery(candidate), true);
  assert.equal(
    canResumePreActuationDiscovery({
      ...candidate,
      outbound: { ...candidate.outbound, retry_count: 1 }
    }),
    false
  );
  assert.equal(
    canResumePreActuationDiscovery({
      ...candidate,
      outbound: {
        ...candidate.outbound,
        last_pre_actuation_error_code: null
      }
    }),
    false
  );
  assert.equal(
    canResumePreActuationDiscovery({
      ...candidate,
      outbound: { ...candidate.outbound, kind: "TASK_EXECUTION" }
    }),
    false
  );
  assert.equal(
    canResumePreActuationDiscovery({
      ...candidate,
      outbound: { ...candidate.outbound, state: "DELIVERED" }
    }),
    false
  );
});

test("SC-013 startup resumes the pending discovery before selecting new work", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const recovery = source.indexOf("if (canResumePreActuationDiscovery(current))");
  const cycles = source.indexOf("let cycles = 0;", recovery);
  assert.ok(recovery >= 0 && cycles > recovery);
  const body = source.slice(recovery, cycles);
  assert.match(body, /buildSingleConversationTaskDiscoveryInstruction/);
  assert.match(body, /sendProtocolMessage/);
  assert.match(body, /pendingMessageId/);
});

test("SC-013 missing restart identity uses disposable replacement only for proven pre-actuation discovery", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const activeBranch = source.indexOf(
    "const pendingPreActuation = canResumePreActuationDiscovery(current)"
  );
  const replacement = source.indexOf(
    "RUNTIME_RESTART_IDENTITY_NOT_VERIFIED_PRE_ACTUATION",
    activeBranch
  );
  const replay = source.indexOf(
    "initialRetryCount: pendingPreActuation.retry_count + 1",
    replacement
  );
  const failClosed = source.indexOf(
    'code: "RUNTIME_RESTART_IDENTITY_NOT_VERIFIED"',
    replay
  );

  assert.ok(activeBranch >= 0);
  assert.ok(replacement > activeBranch);
  assert.ok(replay > replacement);
  assert.ok(failClosed > replay);

  const body = source.slice(activeBranch, failClosed);
  assert.match(body, /replaceDisposableConversation/);
  assert.match(body, /composerInstructionDigest\(pendingMessage\)/);
  assert.match(body, /messageId: pendingPreActuation\.message_id/);
  assert.match(body, /kind: "SOURCE_OF_TRUTH_TASK_DISCOVERY"/);
});

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
  assert.match(source, /TASK_CAPTURE_USER/);
  assert.match(source, /TASK_CAPTURE_ASSISTANT/);
  assert.match(source, /code === "CDP_RECOVERY_REQUIRED"[\s\S]*\? 75/);
  assert.match(source, /boundedRuntimeCleanup\(\(\) => adapter\.close\(\), 1_500\)/);
  assert.match(source, /process\.exit\(finalExitCode\)/);
});


test("SC-010 qualification-only remains fixed-cycle and read-only after SC-011", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /if \(qualificationOnly\)/);
  assert.match(source, /qualificationOnly: true/);
  assert.match(source, /while \(maxCycles <= 0 \|\| cycles < maxCycles\)/);
  assert.match(source, /status: "MAX_CYCLES"/);
});


test("SC-011 fresh task send remains PREPARED until exact-once reconciler enqueues", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("async function sendProtocolMessage");
  const end = source.indexOf("async function discoverTaskControl", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /prepareExactOnceOutbound/);
  assert.match(body, /reconcileExactOnceOutbound/);
  assert.doesNotMatch(body, /markExactOnceEnqueued/);
});


test("SC-013 NEXT_WORK recovers malformed task-control with authoritative discovery instead of terminal exit", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const taskSend = source.indexOf("const response = await sendProtocolMessage", source.indexOf("while (maxCycles <= 0 || cycles < maxCycles)"));
  const parse = source.indexOf("control = parseTaskControl(response.assistant_turn?.text)", taskSend);
  const invalid = source.indexOf('error?.code !== "TASK_PROTOCOL_INVALID"', parse);
  const discovery = source.indexOf("control = await discoverTaskControl", invalid);
  const nextDelay = source.indexOf("await waitForNextCycleDelay(pollMs)", discovery);

  assert.ok(taskSend >= 0);
  assert.ok(parse > taskSend);
  assert.ok(invalid > parse);
  assert.ok(discovery > invalid);
  assert.ok(nextDelay > discovery);
});


test("SC-013 restart rebind permits only a durable ENQUEUED TASK_STATUS_CHECK candidate", () => {
  const sourceOfTruthUrl = "https://example.com/SOURCE_OF_TRUTH.md";
  const messageId = "status-restart-1";
  const taskId = "OPS-022";
  const message = buildSingleConversationTaskInstruction({
    sourceOfTruthUrl,
    taskId,
    messageId,
    checkOnly: true
  });
  const state = {
    conversation: { status: "ACTIVE" },
    source_of_truth: { url: sourceOfTruthUrl },
    outbound: {
      state: "ENQUEUED",
      kind: "TASK_STATUS_CHECK",
      message_id: messageId,
      message_digest: composerInstructionDigest(message),
      retry_count: 0
    }
  };

  assert.equal(canRebindEnqueuedStatusCheck(state), true);
  assert.equal(
    reconstructPendingStatusCheckMessage(state, message),
    message
  );
  assert.equal(
    reconstructPendingStatusCheckMessage(
      state,
      message.replace("TASK_ID=OPS-022", "TASK_ID=OPS-999")
    ),
    null
  );
  assert.equal(
    canRebindEnqueuedStatusCheck({
      ...state,
      outbound: { ...state.outbound, kind: "TASK_EXECUTION" }
    }),
    false
  );
  assert.equal(
    canRebindEnqueuedStatusCheck({
      ...state,
      outbound: { ...state.outbound, state: "PREPARED" }
    }),
    false
  );
});

test("SC-013 restart reconciles pending status check before selecting any new work", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const helper = source.indexOf("async function resumeEnqueuedStatusCheckAfterRebind");
  const reconcile = source.indexOf("reconcileExactOnceOutbound", helper);
  const settle = source.indexOf("settleTransactionResponse", reconcile);
  const activeBranch = source.indexOf("if (rebound?.page)");
  const recovery = source.indexOf("resumeEnqueuedStatusCheckAfterRebind", activeBranch);
  const cycles = source.indexOf("let cycles = 0;", recovery);

  assert.ok(helper >= 0);
  assert.ok(reconcile > helper);
  assert.ok(settle > reconcile);
  assert.ok(activeBranch >= 0);
  assert.ok(recovery > activeBranch);
  assert.ok(cycles > recovery);
});
