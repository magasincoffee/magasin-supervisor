import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  bootstrapRecoveryReasonForState,
  boundedRuntimeStep,
  canRecoverPreparedBootstrapNonDelivery,
  canRebindEnqueuedStatusCheck,
  canRebindEnqueuedTaskMessage,
  canRebindInFlightProtocolMessage,
  canRebindPreparedProtocolMessage,
  canResumePreActuationDiscovery,
  reconstructPendingProtocolMessage,
  reconstructPendingStatusCheckMessage,
  reconstructPendingTaskMessage,
  replacementReasonForResponseWaitError,
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

test("SC-013 restart allows one bootstrap retry only from proven SEND_NOT_ACTUATED PREPARED state", () => {
  const candidate = {
    conversation: { status: "ACTIVE", runtime_id: null },
    automation: {
      status: "BLOCKED",
      phase: "BOOTSTRAP_FAILED",
      reason: "SEND_NOT_ACTUATED"
    },
    outbound: {
      state: "PREPARED",
      kind: "SOURCE_OF_TRUTH_BOOTSTRAP",
      message_id: "bootstrap-retry-1",
      message_digest: "digest",
      retry_count: 0,
      last_error_code: "SEND_NOT_ACTUATED"
    }
  };

  assert.equal(canRecoverPreparedBootstrapNonDelivery(candidate), true);
  assert.equal(
    canRecoverPreparedBootstrapNonDelivery({
      ...candidate,
      conversation: { ...candidate.conversation, runtime_id: "chat:known" }
    }),
    false
  );
  assert.equal(
    canRecoverPreparedBootstrapNonDelivery({
      ...candidate,
      outbound: { ...candidate.outbound, retry_count: 1 }
    }),
    false
  );
  assert.equal(
    canRecoverPreparedBootstrapNonDelivery({
      ...candidate,
      recovery: { reason: "BOOTSTRAP_POSITIVE_NON_DELIVERY_RETRY" }
    }),
    false
  );
  assert.equal(
    canRecoverPreparedBootstrapNonDelivery({
      ...candidate,
      outbound: { ...candidate.outbound, last_error_code: "COMPOSER_NOT_READY" }
    }),
    false
  );
});

test("SC-013 prepared bootstrap restart requires positive blank-home evidence before bounded replacement", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const gate = source.indexOf("canRecoverPreparedBootstrapNonDelivery(current)");
  const verify = source.indexOf("hasPositiveBlankBootstrapNonDelivery", gate);
  const digest = source.indexOf("prepared bootstrap reconstruction digest mismatch", verify);
  const reason = source.indexOf("BOOTSTRAP_POSITIVE_NON_DELIVERY_RETRY", digest);
  const replace = source.indexOf("replaceDisposableConversation", reason);
  const lostBootstrap = source.indexOf("lostBootstrapRecoveryReason", replace);

  assert.ok(gate >= 0);
  assert.ok(verify > gate);
  assert.ok(digest > verify);
  assert.ok(reason > digest);
  assert.ok(replace > reason);
  assert.ok(lostBootstrap > replace);

  const body = source.slice(gate, lostBootstrap);
  assert.match(body, /messageId: retryMessageId/);
  assert.match(body, /composerInstructionDigest\(retryMessage\)/);

  const helper = source.indexOf("async function hasPositiveBlankBootstrapNonDelivery");
  const helperEnd = source.indexOf("function recoverableBootstrapPage", helper);
  assert.ok(helper >= 0 && helperEnd > helper);
  const helperBody = source.slice(helper, helperEnd);
  assert.match(helperBody, /userMessageCount/);
  assert.match(helperBody, /assistantMessageCount/);
  assert.match(helperBody, /draft\.has_text === false/);
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
  const durable = {
    ...state,
    outbound: { ...state.outbound, task_id: taskId }
  };
  assert.equal(
    reconstructPendingStatusCheckMessage(durable),
    message
  );
  assert.equal(
    reconstructPendingStatusCheckMessage({
      ...durable,
      outbound: { ...durable.outbound, task_id: "OPS-999" }
    }),
    null
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

test("SC-013 restart rebind safely reconstructs ENQUEUED TASK_EXECUTION from exact evidence", () => {
  const sourceOfTruthUrl = "https://example.com/SOURCE_OF_TRUTH.md";
  const messageId = "exec-restart-1";
  const taskId = "OPS-022";
  const message = buildSingleConversationTaskInstruction({
    sourceOfTruthUrl,
    taskId,
    messageId,
    checkOnly: false
  });
  const state = {
    conversation: { status: "ACTIVE" },
    source_of_truth: { url: sourceOfTruthUrl },
    outbound: {
      state: "ENQUEUED",
      kind: "TASK_EXECUTION",
      message_id: messageId,
      message_digest: composerInstructionDigest(message),
      retry_count: 0
    }
  };

  assert.equal(canRebindEnqueuedTaskMessage(state), true);
  assert.equal(reconstructPendingTaskMessage(state, message), message);
  assert.equal(
    reconstructPendingTaskMessage(
      state,
      message.replace("TASK_ID=OPS-022", "TASK_ID=OPS-999")
    ),
    null
  );

  const durable = {
    ...state,
    outbound: { ...state.outbound, task_id: taskId }
  };
  assert.equal(reconstructPendingTaskMessage(durable), message);
  assert.equal(
    reconstructPendingTaskMessage({
      ...durable,
      outbound: { ...durable.outbound, task_id: "OPS-999" }
    }),
    null
  );
  assert.equal(canRebindEnqueuedStatusCheck(state), false);
});

test("SC-013 restart reconciles pending task message before selecting any new work", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const helper = source.indexOf("async function resumeEnqueuedTaskMessageAfterRebind");
  const reconcile = source.indexOf("reconcileExactOnceOutbound", helper);
  const settle = source.indexOf("settleTransactionResponse", reconcile);
  const activeBranch = source.indexOf("if (rebound?.page)");
  const recovery = source.indexOf("resumeEnqueuedTaskMessageAfterRebind", activeBranch);
  const cycles = source.indexOf("let cycles = 0;", recovery);

  assert.ok(helper >= 0);
  assert.ok(reconcile > helper);
  assert.ok(settle > reconcile);
  assert.ok(activeBranch >= 0);
  assert.ok(recovery > activeBranch);
  assert.ok(cycles > recovery);
});


test("SC-013 restart rebind accepts DELIVERED and RESPONSE_RUNNING task messages without authorizing a resend", () => {
  const sourceOfTruthUrl = "https://example.com/SOURCE_OF_TRUTH.md";
  const messageId = "wait-response-restart-1";
  const taskId = "OPS-033";
  const message = buildSingleConversationTaskInstruction({
    sourceOfTruthUrl,
    taskId,
    messageId,
    checkOnly: false
  });
  const base = {
    conversation: { status: "ACTIVE" },
    source_of_truth: { url: sourceOfTruthUrl },
    outbound: {
      kind: "TASK_EXECUTION",
      task_id: taskId,
      message_id: messageId,
      message_digest: composerInstructionDigest(message),
      delivered_user_turn_id: "conversation-turn-user-1"
    }
  };

  for (const outboundState of ["DELIVERED", "RESPONSE_RUNNING"]) {
    const state = {
      ...base,
      outbound: { ...base.outbound, state: outboundState }
    };
    assert.equal(canRebindInFlightProtocolMessage(state), true);
    assert.equal(reconstructPendingProtocolMessage(state), message);
    assert.equal(canRebindEnqueuedTaskMessage(state), false);
  }

  assert.equal(
    canRebindInFlightProtocolMessage({
      ...base,
      outbound: { ...base.outbound, state: "PREPARED" }
    }),
    false
  );
});

test("SC-013 restart WAIT_RESPONSE recovery never reconciles or actuates outbound again", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );

  const helper = source.indexOf("async function resumeInFlightProtocolMessageAfterRebind");
  const helperEnd = source.indexOf("async function probeReusableConversationPage", helper);
  assert.ok(helper >= 0 && helperEnd > helper);

  const body = source.slice(helper, helperEnd);
  assert.match(body, /settleTransactionResponse/);
  assert.match(body, /DELIVERED \/ RESPONSE_RUNNING already has durable positive send evidence/);
  assert.doesNotMatch(body, /reconcileExactOnceOutbound/);
  assert.doesNotMatch(body, /sendProtocolMessage/);
  assert.doesNotMatch(body, /sendComposerInstruction/);
});

test("SC-013 startup resumes WAIT_RESPONSE before any new task selection", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );

  const activeBranch = source.indexOf("if (rebound?.page)");
  const inFlightCheck = source.indexOf("if (canRebindInFlightProtocolMessage(current))", activeBranch);
  const resume = source.indexOf("resumeInFlightProtocolMessageAfterRebind", inFlightCheck);
  const enqueuedFallback = source.indexOf("else if (canRebindEnqueuedTaskMessage(current))", resume);
  const cycles = source.indexOf("let cycles = 0;", enqueuedFallback);

  assert.ok(activeBranch >= 0);
  assert.ok(inFlightCheck > activeBranch);
  assert.ok(resume > inFlightCheck);
  assert.ok(enqueuedFallback > resume);
  assert.ok(cycles > enqueuedFallback);
});

test("SC-013 delivered bootstrap can be reconstructed for response-only restart recovery", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /SOURCE_OF_TRUTH_BOOTSTRAP/);
  assert.match(source, /MAGASIN_BOOTSTRAP_CORRELATION_V1/);
  assert.match(source, /buildSingleConversationBootstrap/);
});


test("SC-013 restart can safely rebind PREPARED task status check before first actuation", () => {
  const sourceOfTruthUrl = "https://example.com/SOURCE_OF_TRUTH.md";
  const messageId = "prepared-status-1";
  const taskId = "OPS-033";
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
      state: "PREPARED",
      kind: "TASK_STATUS_CHECK",
      task_id: taskId,
      message_id: messageId,
      message_digest: composerInstructionDigest(message),
      retry_count: 0
    }
  };

  assert.equal(canRebindPreparedProtocolMessage(state), true);
  assert.equal(reconstructPendingProtocolMessage(state), message);
  assert.equal(canRebindEnqueuedTaskMessage(state), false);
  assert.equal(canRebindInFlightProtocolMessage(state), false);
});

test("SC-013 PREPARED restart recovery reconciles exactly once and is not treated as retry", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const helper = source.indexOf("async function resumePreparedProtocolMessageAfterRebind");
  const helperEnd = source.indexOf("async function resumeEnqueuedTaskMessageAfterRebind", helper);
  assert.ok(helper >= 0 && helperEnd > helper);
  const body = source.slice(helper, helperEnd);
  assert.match(body, /PREPARED is durable proof that browser actuation has not yet started/);
  assert.match(body, /reconcileExactOnceOutbound/);
  assert.match(body, /\["SEND", "NO_SEND"\]/);
  assert.doesNotMatch(body, /SAFE_RETRY_SENT/);
  assert.doesNotMatch(body, /initialRetryCount/);
});

test("SC-013 startup prioritizes PREPARED recovery before in-flight and ENQUEUED branches", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const active = source.indexOf("if (rebound?.page)");
  const prepared = source.indexOf("if (canRebindPreparedProtocolMessage(current))", active);
  const preparedResume = source.indexOf("resumePreparedProtocolMessageAfterRebind", prepared);
  const inFlight = source.indexOf("else if (canRebindInFlightProtocolMessage(current))", preparedResume);
  const enqueued = source.indexOf("else if (canRebindEnqueuedTaskMessage(current))", inFlight);
  assert.ok(active >= 0);
  assert.ok(prepared > active);
  assert.ok(preparedResume > prepared);
  assert.ok(inFlight > preparedResume);
  assert.ok(enqueued > inFlight);
});


test("SC-013 restart rejects a full chat and rolls over only settled outbound work", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const probe = source.indexOf("async function probeReusableConversationPage");
  const rebind = source.indexOf("export async function resumeExistingConversationPage", probe);
  assert.match(source.slice(probe, rebind), /classifyDisposableConversation\(snapshot\)\.action !== "KEEP_CHAT"/);
  const restart = source.indexOf("const restartProbe = rebound?.page");
  const full = source.indexOf('restartProbe?.classification?.reason === "CONVERSATION_FULL"', restart);
  const settled = source.indexOf('["RESPONSE_COMPLETE", "VERIFIED"]', full);
  const replace = source.indexOf("const replacement = await replaceDisposableConversation", settled);
  const failClosed = source.indexOf('code: "RUNTIME_RESTART_IDENTITY_NOT_VERIFIED"', replace);
  assert.ok(restart >= 0 && full > restart && settled > full && replace > settled && failClosed > replace);
  assert.match(source.slice(full, failClosed), /reason: "CONVERSATION_FULL"/);
});


test("SC-013 response-wait failure maps only repeated transient/network errors to rollover", () => {
  assert.equal(
    replacementReasonForResponseWaitError({ code: "TRANSIENT_ERROR" }),
    "REPEATED_TRANSIENT_FAILURE"
  );
  assert.equal(
    replacementReasonForResponseWaitError({ code: "NETWORK_ERROR" }),
    "REPEATED_NETWORK_FAILURE"
  );
  assert.equal(
    replacementReasonForResponseWaitError({ code: "AUTH_REQUIRED" }),
    null
  );
  assert.equal(
    replacementReasonForResponseWaitError({ code: "CONVERSATION_FULL" }),
    null
  );
  assert.equal(replacementReasonForResponseWaitError(null), null);
});

test("SC-013 restart WAIT_RESPONSE repeated failure retires chat without resending prior task", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const active = source.indexOf("if (rebound?.page)");
  const inFlight = source.indexOf("else if (canRebindInFlightProtocolMessage(current))", active);
  const resume = source.indexOf("resumeInFlightProtocolMessageAfterRebind", inFlight);
  const catchIndex = source.indexOf("replacementReasonForResponseWaitError(error)", resume);
  const replace = source.indexOf("replaceDisposableConversation", catchIndex);
  const enqueued = source.indexOf("else if (canRebindEnqueuedTaskMessage(current))", replace);
  assert.ok(active >= 0);
  assert.ok(inFlight > active);
  assert.ok(resume > inFlight);
  assert.ok(catchIndex > resume);
  assert.ok(replace > catchIndex);
  assert.ok(enqueued > replace);

  const body = source.slice(catchIndex, enqueued);
  assert.match(body, /reason: replacementReason/);
  assert.match(body, /bootstrapResponse = replacement\.response/);
  assert.match(body, /page = replacement\.page/);
  assert.doesNotMatch(body, /sendProtocolMessage/);
  assert.doesNotMatch(body, /reconcileExactOnceOutbound/);
});


test("SC-013 completed bootstrap recovers malformed task-control without pausing wrapper", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const branch = source.indexOf("if (bootstrapResponse?.assistant_turn?.text)");
  const parse = source.indexOf("parseTaskControl(bootstrapResponse.assistant_turn.text)", branch);
  const invalid = source.indexOf('error?.code !== "TASK_PROTOCOL_INVALID"', parse);
  const discovery = source.indexOf("control = await discoverTaskControl", invalid);
  const fallbackElse = source.indexOf("} else {", discovery);

  assert.ok(branch >= 0);
  assert.ok(parse > branch);
  assert.ok(invalid > parse);
  assert.ok(discovery > invalid);
  assert.ok(fallbackElse > discovery);
  assert.match(source.slice(parse, fallbackElse), /cycles \+= 1/);
});


test("SC-013 restart classifies lost delivered bootstrap as disposable recovery, not Owner block", () => {
  const legacyIncident = {
    conversation: {
      status: "ACTIVE",
      runtime_id: "chat:expected"
    },
    automation: {
      status: "BLOCKED",
      phase: "BOOTSTRAP_FAILED",
      reason: "BOOTSTRAP_FAILED"
    },
    outbound: {
      state: "RESPONSE_RUNNING",
      kind: "SOURCE_OF_TRUTH_BOOTSTRAP",
      message_id: "bootstrap-1",
      message_digest: "digest",
      last_error_code: "BOOTSTRAP_FAILED"
    }
  };

  assert.equal(
    bootstrapRecoveryReasonForState(legacyIncident),
    "BOOTSTRAP_RESPONSE_SURFACE_FAILURE"
  );
  assert.equal(
    bootstrapRecoveryReasonForState({
      ...legacyIncident,
      outbound: {
        ...legacyIncident.outbound,
        last_error_code: "AUTH_REQUIRED"
      }
    }),
    null
  );
  assert.equal(
    bootstrapRecoveryReasonForState({
      ...legacyIncident,
      outbound: {
        ...legacyIncident.outbound,
        kind: "TASK_EXECUTION"
      }
    }),
    null
  );
});

test("SC-013 runtime replaces a lost bootstrap chat before fail-closed restart handling", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );

  const classify = source.indexOf(
    "const lostBootstrapRecoveryReason = bootstrapRecoveryReasonForState(current)"
  );
  const branch = source.indexOf("} else if (lostBootstrapRecoveryReason)", classify);
  const replace = source.indexOf("replaceDisposableConversation", branch);
  const fullChat = source.indexOf(
    'restartProbe?.classification?.reason === "CONVERSATION_FULL"',
    replace
  );
  const failClosed = source.indexOf(
    'code: "RUNTIME_RESTART_IDENTITY_NOT_VERIFIED"',
    fullChat
  );

  assert.ok(classify >= 0);
  assert.ok(branch > classify);
  assert.ok(replace > branch);
  assert.ok(fullChat > replace);
  assert.ok(failClosed > fullChat);
  assert.match(
    source.slice(branch, fullChat),
    /BOOTSTRAP.*no project side effects|bootstrap.*no project side effects/i
  );
});

test("SC-013 cold bootstrap gets one bounded disposable retry on recoverable response failure", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const helper = source.indexOf("async function createInitialBootstrapWithRecovery");
  const create = source.indexOf("createNewChatAndBootstrap", helper);
  const classify = source.indexOf("bootstrapFailureRecoveryReason", create);
  const replace = source.indexOf("replaceDisposableConversation", classify);
  const runtimeStart = source.indexOf("if (current.conversation.status !== \"ACTIVE\")");
  const helperCall = source.indexOf("createInitialBootstrapWithRecovery", runtimeStart);

  assert.ok(helper >= 0);
  assert.ok(create > helper);
  assert.ok(classify > create);
  assert.ok(replace > classify);
  assert.ok(runtimeStart > replace);
  assert.ok(helperCall > runtimeStart);
});
