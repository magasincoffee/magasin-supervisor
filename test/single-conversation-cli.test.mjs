import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assistantTurnConfirmsCycleDelivery,
  bootstrapRecoveryReasonForState,
  boundedRuntimeStep,
  canRecoverPreparedBootstrapNonDelivery,
  canRebindEnqueuedStatusCheck,
  canRebindEnqueuedTaskMessage,
  canRebindInFlightProtocolMessage,
  canRebindPreparedProtocolMessage,
  canReplaceLostReadOnlyDiscovery,
  canReplaceLostSettledConversation,
  canResumePreActuationDiscovery,
  reconstructPendingProtocolMessage,
  reconstructPendingStatusCheckMessage,
  reconstructPendingTaskMessage,
  replacementReasonForResponseWaitError,
  recoverableConversationFullTask,
  preparedBootstrapIsStaleEnough,
  probeReusableConversationPage,
  safeBootstrapNonDeliverySnapshot,
  safeFalseHistoricalDeliverySnapshot,
  stableUnmarkedTaskResponseCandidate,
  orphanedInFlightTaskRecoveryCandidate,
  runSingleConversationRuntime,
  persistTerminalTaskControl,
  waitForNextCycleDelay,
  waitForPositiveBlankBootstrapNonDelivery
} from "../src/runtime/single-conversation-cli.mjs";
import { composerInstructionDigest } from "../src/ui/actions.mjs";
import { captureAssistantCycleCorrelationEvidence } from "../src/ui/latest-turn.mjs";
import { buildSingleConversationTaskInstruction } from "../src/runtime/single-conversation-loop.mjs";
import {
  ensureSingleConversationState,
  readSingleConversationState
} from "../src/runtime/single-conversation-state.mjs";

async function tempState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc007-runtime-"));
  return { root, statePath: path.join(root, "state.json") };
}

test("SC-013 lost read-only discovery identity is safe to replace without Owner input", () => {
  const base = {
    conversation: { status: "ACTIVE" },
    outbound: {
      state: "ENQUEUED",
      kind: "SOURCE_OF_TRUTH_TASK_DISCOVERY",
      message_id: "lost-discovery",
      message_digest: "digest"
    }
  };

  assert.equal(canReplaceLostReadOnlyDiscovery(base), true);

  const delivered = structuredClone(base);
  delivered.outbound.state = "DELIVERED";
  assert.equal(canReplaceLostReadOnlyDiscovery(delivered), true);

  const responseRunning = structuredClone(base);
  responseRunning.outbound.state = "RESPONSE_RUNNING";
  responseRunning.outbound.kind = "SOURCE_OF_TRUTH_NEXT_WORK";
  assert.equal(canReplaceLostReadOnlyDiscovery(responseRunning), true);

  for (const mutate of [
    (state) => { state.conversation.status = "RETIRED"; },
    (state) => { state.outbound.state = "PREPARED"; },
    (state) => { state.outbound.kind = "TASK_EXECUTION"; },
    (state) => { state.outbound.message_id = ""; },
    (state) => { state.outbound.message_digest = ""; }
  ]) {
    const unsafe = structuredClone(base);
    mutate(unsafe);
    assert.equal(canReplaceLostReadOnlyDiscovery(unsafe), false);
  }
});

test("SC-013 settled conversation identity loss is safe to replace without replay", () => {
  const base = {
    conversation: { status: "ACTIVE" },
    outbound: {
      state: "VERIFIED",
      kind: "TASK_EXECUTION",
      task_id: "XSTORE-019A",
      message_id: "settled-1",
      message_digest: "digest"
    }
  };

  assert.equal(canReplaceLostSettledConversation(base), true);

  const responseComplete = structuredClone(base);
  responseComplete.outbound.state = "RESPONSE_COMPLETE";
  assert.equal(canReplaceLostSettledConversation(responseComplete), true);

  for (const mutate of [
    (state) => { state.conversation.status = "RETIRED"; },
    (state) => { state.outbound.state = "RESPONSE_RUNNING"; },
    (state) => { state.outbound.message_id = ""; },
    (state) => { state.outbound.message_digest = ""; }
  ]) {
    const unsafe = structuredClone(base);
    mutate(unsafe);
    assert.equal(canReplaceLostSettledConversation(unsafe), false);
  }
});

test("SC-013 restart recovery probes are bounded before settled-chat replacement", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );

  const reusable = source.indexOf("async function probeReusableConversationPage");
  const reusableBound = source.indexOf("RUNTIME_REBIND_REUSABLE_PAGE_PROBE", reusable);
  const recent = source.indexOf("async function recoverConversationFromRecentSidebar");
  const recentBound = source.indexOf("RUNTIME_REBIND_RECENT_LIST", recent);
  const history = source.indexOf("async function recoverConversationFromBrowserHistory");
  const historyBound = source.indexOf("RUNTIME_REBIND_HISTORY_LIST", history);
  const restart = source.indexOf("const restartProbe = rebound?.page");
  const restartBound = source.indexOf("RUNTIME_RESTART_OLD_PAGE_PROBE", restart);
  const settled = source.indexOf("else if (canReplaceLostSettledConversation(current))", restart);
  const replacement = source.indexOf('reason: "SETTLED_CONVERSATION_IDENTITY_LOST"', settled);
  const failClosed = source.indexOf('code: "RUNTIME_RESTART_IDENTITY_NOT_VERIFIED"', replacement);

  assert.ok(reusable >= 0 && reusableBound > reusable);
  assert.ok(recent >= 0 && recentBound > recent);
  assert.ok(history >= 0 && historyBound > history);
  assert.ok(restart >= 0 && restartBound > restart);
  assert.ok(settled > restartBound);
  assert.ok(replacement > settled);
  assert.ok(failClosed > replacement);
});

test("SC-013 lost discovery restart rolls over before generic identity fail-closed", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const active = source.indexOf("if (current.conversation.status !== \"ACTIVE\")");
  const lost = source.indexOf("else if (canReplaceLostReadOnlyDiscovery(current))", active);
  const replacement = source.indexOf('reason: "READ_ONLY_DISCOVERY_IDENTITY_LOST"', lost);
  const fullTask = source.indexOf("else if (recoverableConversationFullTask(current))", replacement);
  const failClosed = source.indexOf('code: "RUNTIME_RESTART_IDENTITY_NOT_VERIFIED"', fullTask);

  assert.ok(active >= 0);
  assert.ok(lost > active);
  assert.ok(replacement > lost);
  assert.ok(fullTask > replacement);
  assert.ok(failClosed > fullTask);

  const body = source.slice(lost, fullTask);
  assert.match(body, /replaceDisposableConversation/);
  assert.match(body, /bootstrapResponse = replacement\.response/);
  assert.doesNotMatch(body, /TASK_EXECUTION/);
});

test("SC-013 conversation-full during read-only discovery rolls over instead of stopping", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("async function discoverTaskControl");
  const end = source.indexOf("export async function runSingleConversationRuntime", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  assert.match(body, /CONVERSATION_FULL/);
  assert.match(body, /CONVERSATION_FULL_READ_ONLY_DISCOVERY/);
  assert.match(body, /replaceDisposableConversation/);
  assert.match(body, /return parseTaskControl\(replacement\.response\?\.assistant_turn\?\.text\)/);
});

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

test("SC-013 startup reconciles correlated bootstrap delivery before any resend recovery", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const correlated = source.indexOf(
    "canRecoverCorrelatedPreparedBootstrapDelivery(current)"
  );
  const recover = source.indexOf(
    "recoverCorrelatedPreparedBootstrapDelivery",
    correlated
  );
  const branch = source.indexOf(
    "correlatedBootstrapRecovery?.recovered",
    recover
  );
  const retry = source.indexOf(
    "canRecoverPreparedBootstrapNonDelivery(current)",
    branch
  );

  assert.ok(correlated >= 0);
  assert.ok(recover > correlated);
  assert.ok(branch > recover);
  assert.ok(retry > branch);
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
    true
  );
  assert.equal(
    canRecoverPreparedBootstrapNonDelivery({
      ...candidate,
      outbound: { ...candidate.outbound, last_error_code: "COMPOSER_NOT_READY" }
    }),
    false
  );
});

test("SC-013 bootstrap non-delivery ignores heuristic message counts but rejects structured turns", () => {
  const base = {
    loginRequired: false,
    hasCaptcha: false,
    hasNetworkError: false,
    hasTransientError: false,
    conversationMissing: false,
    conversationAccessDenied: false,
    conversationPath: false,
    responseRunning: false,
    composerReady: true,
    composerTextReadable: true,
    composerHasText: false,
    composerTextCharCount: 0,
    conversationTurnElementCount: 0,
    // Current ChatGPT home can expose text surfaces that resemble modern
    // user/assistant messages even when there is no persisted conversation.
    userMessageCount: 4,
    assistantMessageCount: 3
  };

  assert.equal(safeBootstrapNonDeliverySnapshot(base), true);
  assert.equal(
    safeBootstrapNonDeliverySnapshot({
      ...base,
      conversationTurnElementCount: 1
    }),
    false
  );
  assert.equal(
    safeBootstrapNonDeliverySnapshot({
      ...base,
      conversationPath: true
    }),
    false
  );
  assert.equal(
    safeBootstrapNonDeliverySnapshot({
      ...base,
      responseRunning: true
    }),
    false
  );
  assert.equal(
    safeBootstrapNonDeliverySnapshot({
      ...base,
      composerHasText: true,
      composerTextCharCount: 12
    }),
    false
  );
  assert.equal(
    safeBootstrapNonDeliverySnapshot({
      ...base,
      composerTextReadable: false,
      composerHasText: null
    }),
    false
  );
});

test("SC-013 bootstrap retry requires stale PREPARED evidence before exact-turn absence can authorize recovery", () => {
  const state = {
    updated_at: "2026-10-01T10:00:00.000Z",
    outbound: {
      prepared_at: "2026-10-01T10:00:00.000Z"
    }
  };
  assert.equal(
    preparedBootstrapIsStaleEnough(state, {
      nowMs: Date.parse("2026-10-01T10:01:00.000Z"),
      minimumAgeMs: 60_000
    }),
    true
  );
  assert.equal(
    preparedBootstrapIsStaleEnough(state, {
      nowMs: Date.parse("2026-10-01T10:00:59.999Z"),
      minimumAgeMs: 60_000
    }),
    false
  );
});

test("SC-013 bootstrap non-delivery waits for two stable positive observations", async () => {
  const page = {
    url: () => "https://chatgpt.com/",
    isClosed: () => false
  };
  const adapter = {
    getActivePage: () => page,
    getChatGptPages: () => [page]
  };

  let tick = 0;
  let checks = 0;
  const verified = await waitForPositiveBlankBootstrapNonDelivery(
    adapter,
    page,
    {
      timeoutMs: 10_000,
      pollMs: 100,
      stablePasses: 2,
      now: () => tick,
      sleep: async (ms) => { tick += ms; },
      verify: async () => {
        checks += 1;
        return checks >= 2;
      }
    }
  );

  assert.equal(verified, page);
  assert.equal(checks, 3);
});

test("SC-013 bootstrap non-delivery does not authorize retry from unstable evidence", async () => {
  const page = {
    url: () => "https://chatgpt.com/",
    isClosed: () => false
  };
  const adapter = {
    getActivePage: () => page,
    getChatGptPages: () => [page]
  };

  let tick = 0;
  let checks = 0;
  const verified = await waitForPositiveBlankBootstrapNonDelivery(
    adapter,
    page,
    {
      timeoutMs: 500,
      pollMs: 100,
      stablePasses: 2,
      now: () => tick,
      sleep: async (ms) => { tick += ms; },
      verify: async () => {
        checks += 1;
        return checks % 2 === 0;
      }
    }
  );

  assert.equal(verified, null);
  assert.ok(checks >= 4);
});

test("SC-013 prepared bootstrap restart requires positive blank-home evidence before bounded replacement", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const gate = source.indexOf("canRecoverPreparedBootstrapNonDelivery(current)");
  const digest = source.indexOf("prepared bootstrap reconstruction digest mismatch", gate);
  const verify = source.indexOf("waitForPositiveBlankBootstrapNonDelivery", digest);
  const reason = source.indexOf("BOOTSTRAP_POSITIVE_NON_DELIVERY_RETRY", verify);
  const replace = source.indexOf("replaceDisposableConversation", reason);
  const lostBootstrap = source.indexOf("lostBootstrapRecoveryReason", replace);

  assert.ok(gate >= 0);
  assert.ok(digest > gate);
  assert.ok(verify > digest);
  assert.ok(reason > verify);
  assert.ok(replace > reason);
  assert.ok(lostBootstrap > replace);

  const body = source.slice(gate, lostBootstrap);
  assert.match(body, /messageId: retryMessageId/);
  assert.match(body, /composerInstructionDigest\(retryMessage\)/);
  assert.match(
    body,
    /initialRetryCount: Number\(current\.outbound\.retry_count \|\| 0\) \+ 1/
  );
  assert.match(body, /preparedBootstrapIsStaleEnough\(current\)/);
  assert.match(body, /expectedInstruction: retryMessage/);

  const helper = source.indexOf("async function hasPositiveBlankBootstrapNonDelivery");
  const settle = source.indexOf("export async function waitForPositiveBlankBootstrapNonDelivery", helper);
  const helperEnd = source.indexOf("function recoverableBootstrapPage", settle);
  assert.ok(helper >= 0 && settle > helper && helperEnd > settle);
  const helperBody = source.slice(helper, helperEnd);
  assert.match(helperBody, /safeBootstrapNonDeliverySnapshot/);
  assert.match(helperBody, /captureMatchingUserTurnEvidence/);
  assert.match(helperBody, /BOOTSTRAP_NON_DELIVERY_EXACT_TURN/);
  assert.doesNotMatch(helperBody, /BOOTSTRAP_NON_DELIVERY_DRAFT/);

  const safeHelper = source.indexOf("export function safeBootstrapNonDeliverySnapshot");
  const safeHelperEnd = source.indexOf("function logBootstrapNonDeliverySample", safeHelper);
  assert.ok(safeHelper >= 0 && safeHelperEnd > safeHelper);
  const safeBody = source.slice(safeHelper, safeHelperEnd);
  assert.match(safeBody, /composerTextReadable === true/);
  assert.match(safeBody, /composerHasText === false/);
  assert.doesNotMatch(helperBody, /Number\(snapshot\.userMessageCount/);
  assert.doesNotMatch(helperBody, /Number\(snapshot\.assistantMessageCount/);
  assert.match(helperBody, /stablePasses = 2/);
  assert.match(helperBody, /timeoutMs = 90_000/);
  assert.match(helperBody, /passCount >= requiredPasses/);
  assert.match(helperBody, /logBootstrapNonDeliverySample/);
  assert.match(helperBody, /BOOTSTRAP_NON_DELIVERY_SETTLE_TIMEOUT/);
  assert.match(body, /timeoutMs: 90_000/);
  assert.match(body, /page: verifiedNonDeliveryPage/);
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

test("SC-013 task recheck waits preserve the external deadline while observing chat health", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const helper = source.indexOf("export async function waitForTaskRecheckDelay");
  const helperEnd = source.indexOf("export async function boundedRuntimeStep", helper);
  assert.ok(helper >= 0 && helperEnd > helper);
  const body = source.slice(helper, helperEnd);
  assert.match(body, /TASK_RECHECK_WAIT_RECOVERY_PROBE/);
  assert.match(body, /recoveryProbe/);
  assert.match(body, /const requestedDeadline = Number\(now\(\)\) \+ totalMs/);
  assert.match(body, /inspectTrackedGitHubRun/);
  assert.match(body, /persistTaskRecheckWait/);
  assert.match(body, /secondsToDecision/);
  assert.match(body, /LOCAL_EXTERNAL_TERMINAL/);

  const loop = source.indexOf("if (checkOnly)");
  const send = source.indexOf("const messageId = randomUUID()", loop);
  const loopBody = source.slice(loop, send);
  assert.match(loopBody, /waitForTaskRecheckDelay/);
  assert.match(loopBody, /page = observedWait\.page/);
  assert.doesNotMatch(
    loopBody,
    /waitForNextCycleDelay\(control\.check_after_seconds \* 1000\)/
  );
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
  const taskSend = source.indexOf("response = await sendProtocolMessage", source.indexOf("while (maxCycles <= 0 || cycles < maxCycles)"));
  const parse = source.indexOf("control = await parseTaskResponseControl({", taskSend);
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

test("SC-013 in-flight task restart checks assistant correlation before prompt reconstruction", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );

  const start = source.indexOf("async function resumeInFlightProtocolMessageAfterRebind");
  const end = source.indexOf("async function probeReusableConversationPage", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  const capture = body.indexOf("RESTART_WAIT_RESPONSE_CAPTURE_ASSISTANT_CORRELATION");
  const confirm = body.indexOf("assistantTurnConfirmsCycleDelivery", capture);
  const verify = body.indexOf("markCorrelatedInFlightTaskResponseVerified", confirm);
  const reconstruct = body.indexOf("reconstructPendingProtocolMessage", verify);

  assert.ok(capture >= 0);
  assert.ok(confirm > capture);
  assert.ok(verify > confirm);
  assert.ok(reconstruct > verify);
  assert.match(body, /recovered_from_correlation_without_prompt_reconstruction/);
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
  const helperEnd = source.indexOf("async function resumeEnqueuedTaskDiscoveryAfterRebind", helper);
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


test("SC-013 identifies only in-flight task work as safe full-chat CHECK recovery", () => {
  const base = {
    conversation: { status: "ACTIVE" },
    automation: { status: "BLOCKED", phase: "CYCLE_FAILED" },
    outbound: {
      state: "RESPONSE_RUNNING",
      kind: "TASK_EXECUTION",
      task_id: "OPS-074",
      message_id: "full-live-task",
      last_error_code: "CONVERSATION_FULL"
    }
  };

  assert.deepEqual(recoverableConversationFullTask(base), {
    task_id: "OPS-074",
    kind: "TASK_EXECUTION",
    outbound_state: "RESPONSE_RUNNING",
    message_id: "full-live-task"
  });

  const statusCheck = structuredClone(base);
  statusCheck.outbound.kind = "TASK_STATUS_CHECK";
  statusCheck.outbound.state = "DELIVERED";
  assert.equal(recoverableConversationFullTask(statusCheck)?.task_id, "OPS-074");

  for (const mutation of [
    (state) => { state.outbound.last_error_code = "NETWORK_ERROR"; },
    (state) => { state.outbound.kind = "SOURCE_OF_TRUTH_TASK_DISCOVERY"; },
    (state) => { state.outbound.state = "PREPARED"; },
    (state) => { state.outbound.task_id = null; },
    (state) => { state.conversation.status = "RETIRED"; }
  ]) {
    const unsafe = structuredClone(base);
    mutation(unsafe);
    assert.equal(recoverableConversationFullTask(unsafe), null);
  }
});

test("SC-013 full chat during in-flight task rolls over then CHECKs same task without replaying EXECUTE", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );

  const helperStart = source.indexOf("async function recoverConversationFullTaskByCheck");
  const helperEnd = source.indexOf("async function discoverTaskControl", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);

  assert.match(helper, /reason: "CONVERSATION_FULL_IN_FLIGHT"/);
  assert.match(helper, /checkOnly: true/);
  assert.match(helper, /kind: "TASK_STATUS_CHECK"/);
  assert.match(helper, /taskId: task/);
  assert.doesNotMatch(helper, /kind: "TASK_EXECUTION"/);

  const loop = source.indexOf("while (maxCycles <= 0 || cycles < maxCycles)");
  const send = source.indexOf("response = await sendProtocolMessage", loop);
  const full = source.indexOf('String(error?.code || "").toUpperCase() !== "CONVERSATION_FULL"', send);
  const recover = source.indexOf("recoverConversationFullTaskByCheck({", full);
  const parse = source.indexOf("sourceKind: responseSourceKind", recover);
  assert.ok(loop >= 0 && send > loop && full > send && recover > full && parse > recover);
});

test("SC-013 restart full-chat handling checks in-flight task before settled rollover", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const probe = source.indexOf("async function probeReusableConversationPage");
  const rebind = source.indexOf("export async function resumeExistingConversationPage", probe);
  assert.match(source.slice(probe, rebind), /classifyDisposableConversation\(snapshot\)\.action !== "KEEP_CHAT"/);
  const restart = source.indexOf("const restartProbe = rebound?.page");
  const inFlight = source.indexOf("else if (recoverableConversationFullTask(current))", restart);
  const inFlightRecover = source.indexOf("recoverConversationFullTaskByCheck({", inFlight);
  const full = source.indexOf('restartProbe?.classification?.reason === "CONVERSATION_FULL"', inFlightRecover);
  const settled = source.indexOf('["RESPONSE_COMPLETE", "VERIFIED"]', full);
  const replace = source.indexOf("const replacement = await replaceDisposableConversation", settled);
  const failClosed = source.indexOf('code: "RUNTIME_RESTART_IDENTITY_NOT_VERIFIED"', replace);
  assert.ok(
    restart >= 0 &&
    inFlight > restart &&
    inFlightRecover > inFlight &&
    full > inFlightRecover &&
    settled > full &&
    replace > settled &&
    failClosed > replace
  );
  assert.match(source.slice(inFlight, full), /taskId: interrupted.task_id/);
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
  const parse = source.indexOf("control = await parseTaskResponseControl({", branch);
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


test("SC-013 restart falls back from Recent to exact Chrome history identity without resend", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const recent = source.indexOf("recoverConversationFromRecentSidebar");
  const historyHelper = source.indexOf("recoverConversationFromBrowserHistory");
  const resume = source.indexOf("export async function resumeExistingConversationPage");
  const recentCall = source.indexOf("page = await recoverConversationFromRecentSidebar", resume);
  const historyCall = source.indexOf("page = await recoverConversationFromBrowserHistory", recentCall);
  const recoveredFrom = source.indexOf('recoveredFrom = "BROWSER_HISTORY"', historyCall);

  assert.ok(recent >= 0);
  assert.ok(historyHelper > recent);
  assert.ok(resume > historyHelper);
  assert.ok(recentCall > resume);
  assert.ok(historyCall > recentCall);
  assert.ok(recoveredFrom > historyCall);

  const body = source.slice(historyCall, recoveredFrom + 80);
  assert.match(body, /expected/);
  assert.doesNotMatch(body, /sendProtocolMessage|reconcileExactOnceOutbound/);
});


test("SC-013 in-flight discovery restart attempts proof-gated false-delivery rewind before waiting for response", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const helper = source.indexOf("async function resumeInFlightProtocolMessageAfterRebind");
  const helperEnd = source.indexOf("async function probeReusableConversationPage", helper);
  assert.ok(helper >= 0 && helperEnd > helper);
  const body = source.slice(helper, helperEnd);

  const rewind = body.indexOf("rewindFalseHistoricalDiscoveryDelivery");
  const resumeEnqueued = body.indexOf("resumeEnqueuedTaskDiscoveryAfterRebind", rewind);
  const settle = body.indexOf("settleTransactionResponse", resumeEnqueued);

  assert.ok(rewind >= 0);
  assert.ok(resumeEnqueued > rewind);
  assert.ok(settle > resumeEnqueued);
  assert.match(body, /SOURCE_OF_TRUTH_TASK_DISCOVERY/);
  assert.match(body, /retry_count/);
  assert.match(body, /RESTART_FALSE_DELIVERY_SAFE_PROBE/);
  assert.match(body, /safeFalseHistoricalDeliverySnapshot/);
  assert.match(body, /composerReadable:\s*safeSnapshot\.composerTextReadable/);
  assert.match(body, /responseRunning:\s*Boolean\(safeSnapshot\.responseRunning\)/);
  assert.doesNotMatch(body, /RESTART_FALSE_DELIVERY_CAPTURE_DRAFT/);
  assert.match(body, /FALSE_DELIVERY_REWIND_UNVERIFIED/);
});


test("SC-013 false-delivery safe snapshot requires one idle readable empty-composer DOM sample", () => {
  const safe = {
    loginRequired: false,
    hasCaptcha: false,
    hasNetworkError: false,
    hasTransientError: false,
    conversationMissing: false,
    conversationAccessDenied: false,
    responseRunning: false,
    composerReady: true,
    composerTextReadable: true,
    composerHasText: false
  };
  assert.equal(safeFalseHistoricalDeliverySnapshot(safe), true);
  assert.equal(
    safeFalseHistoricalDeliverySnapshot({ ...safe, composerTextReadable: false }),
    false
  );
  assert.equal(
    safeFalseHistoricalDeliverySnapshot({ ...safe, responseRunning: true }),
    false
  );
  assert.equal(
    safeFalseHistoricalDeliverySnapshot({ ...safe, hasNetworkError: true }),
    false
  );
});


test("SC-013 restart can recover a stable terminal task reply that omitted only the cycle marker", () => {
  const state = {
    conversation: { status: "ACTIVE" },
    outbound: {
      state: "DELIVERED",
      kind: "TASK_STATUS_CHECK",
      task_id: "OPS-074",
      message_id: "restart-unmarked-1"
    }
  };
  const snapshot = {
    responseRunning: false,
    assistantBusy: false,
    hasContinueControl: false,
    loginRequired: false,
    hasCaptcha: false,
    hasNetworkError: false,
    hasTransientError: false,
    conversationMissing: false,
    conversationAccessDenied: false,
    composerReady: true,
    composerTextReadable: true,
    composerHasText: false
  };
  const text =
    "MAGASIN_TASK_CONTROL_V1\n" +
    "STATUS=READY\n" +
    "TASK_ID=NONE\n" +
    "NEXT_TASK_ID=OPS-074\n" +
    "CHECK_AFTER_SECONDS=0\n" +
    "END_MAGASIN_TASK_CONTROL_V1";
  const assistant = { turn_id: "assistant-9", text };
  const matchingUser = { confirmed: true, turn_id: "user-8" };

  const recovered = stableUnmarkedTaskResponseCandidate({
    state,
    snapshot,
    matchingUser,
    assistantFirst: assistant,
    assistantSecond: { ...assistant }
  });
  assert.equal(recovered?.task_control?.status, "READY");
  assert.equal(recovered?.task_control?.next_task_id, "OPS-074");

  assert.equal(
    stableUnmarkedTaskResponseCandidate({
      state,
      snapshot: { ...snapshot, responseRunning: true },
      matchingUser,
      assistantFirst: assistant,
      assistantSecond: assistant
    }),
    null
  );
  assert.equal(
    stableUnmarkedTaskResponseCandidate({
      state,
      snapshot,
      matchingUser: { confirmed: false },
      assistantFirst: assistant,
      assistantSecond: assistant
    }),
    null
  );
  assert.equal(
    stableUnmarkedTaskResponseCandidate({
      state,
      snapshot,
      matchingUser,
      assistantFirst: assistant,
      assistantSecond: {
        turn_id: "assistant-10",
        text
      }
    }),
    null
  );
  assert.equal(
    stableUnmarkedTaskResponseCandidate({
      state,
      snapshot,
      matchingUser,
      assistantFirst: assistant,
      assistantSecond: {
        ...assistant,
        text:
          "MAGASIN_TASK_CONTROL_V1\n" +
          "STATUS=READY\n" +
          "TASK_ID=NONE\n" +
          "NEXT_TASK_ID=OTHER-001\n" +
          "CHECK_AFTER_SECONDS=0\n" +
          "END_MAGASIN_TASK_CONTROL_V1"
      }
    }),
    null
  );
  assert.equal(
    stableUnmarkedTaskResponseCandidate({
      state,
      snapshot,
      matchingUser,
      assistantFirst: {
        ...assistant,
        text: text + "\nMAGASIN_CYCLE_CORRELATION_V1 restart-unmarked-1"
      },
      assistantSecond: {
        ...assistant,
        text: text + "\nMAGASIN_CYCLE_CORRELATION_V1 restart-unmarked-1"
      }
    }),
    null
  );
});

// Production regression: stale RESPONSE_RUNNING must reconcile by CHECK, never EXECUTE replay.
test("SC-013 stale orphaned in-flight task is eligible for CHECK-only restart recovery", () => {
  const state = {
    updated_at: "2026-10-05T15:00:00.000Z",
    conversation: { status: "ACTIVE" },
    outbound: {
      state: "RESPONSE_RUNNING",
      kind: "TASK_EXECUTION",
      task_id: "XSTORE-019B",
      message_id: "orphaned-exec-1",
      response_running_at: "2026-10-05T15:00:00.000Z"
    }
  };
  const idle = {
    responseRunning: false,
    assistantBusy: false,
    hasContinueControl: false,
    loginRequired: false,
    hasCaptcha: false,
    hasNetworkError: false,
    hasTransientError: false,
    conversationMissing: false,
    conversationAccessDenied: false,
    composerReady: true,
    composerTextReadable: true,
    composerHasText: false
  };
  const assistant = {
    turn_id: "assistant-old",
    text: "prior unrelated terminal answer"
  };

  const recovered = orphanedInFlightTaskRecoveryCandidate({
    state,
    firstSnapshot: idle,
    secondSnapshot: { ...idle },
    matchingUser: { confirmed: false },
    assistantFirst: assistant,
    assistantSecond: { ...assistant },
    nowMs: Date.parse("2026-10-05T15:02:00.000Z")
  });

  assert.equal(recovered?.task_id, "XSTORE-019B");
  assert.equal(recovered?.kind, "TASK_EXECUTION");
  assert.equal(recovered?.outbound_state, "RESPONSE_RUNNING");
  assert.equal(recovered?.message_id, "orphaned-exec-1");
});

test("SC-013 orphaned in-flight recovery remains proof-gated", () => {
  const baseState = {
    updated_at: "2026-10-05T15:00:00.000Z",
    conversation: { status: "ACTIVE" },
    outbound: {
      state: "RESPONSE_RUNNING",
      kind: "TASK_EXECUTION",
      task_id: "XSTORE-019B",
      message_id: "orphaned-exec-2",
      response_running_at: "2026-10-05T15:00:00.000Z"
    }
  };
  const idle = {
    responseRunning: false,
    assistantBusy: false,
    hasContinueControl: false,
    loginRequired: false,
    hasCaptcha: false,
    hasNetworkError: false,
    hasTransientError: false,
    conversationMissing: false,
    conversationAccessDenied: false,
    composerReady: true,
    composerTextReadable: true,
    composerHasText: false
  };
  const assistant = { turn_id: "assistant-old", text: "stable old answer" };
  const args = {
    state: baseState,
    firstSnapshot: idle,
    secondSnapshot: { ...idle },
    matchingUser: { confirmed: false },
    assistantFirst: assistant,
    assistantSecond: { ...assistant },
    nowMs: Date.parse("2026-10-05T15:02:00.000Z")
  };

  assert.equal(
    orphanedInFlightTaskRecoveryCandidate({
      ...args,
      matchingUser: { confirmed: true }
    }),
    null
  );
  assert.equal(
    orphanedInFlightTaskRecoveryCandidate({
      ...args,
      firstSnapshot: { ...idle, responseRunning: true }
    }),
    null
  );
  assert.equal(
    orphanedInFlightTaskRecoveryCandidate({
      ...args,
      nowMs: Date.parse("2026-10-05T15:00:30.000Z")
    }),
    null
  );
  assert.equal(
    orphanedInFlightTaskRecoveryCandidate({
      ...args,
      assistantSecond: { turn_id: "assistant-new", text: "new response" }
    }),
    null
  );
  assert.equal(
    orphanedInFlightTaskRecoveryCandidate({
      ...args,
      assistantFirst: {
        turn_id: "assistant-old",
        text: "MAGASIN_CYCLE_CORRELATION_V1 orphaned-exec-2"
      },
      assistantSecond: {
        turn_id: "assistant-old",
        text: "MAGASIN_CYCLE_CORRELATION_V1 orphaned-exec-2"
      }
    }),
    null
  );
});

test("SC-013 orphaned in-flight restart retires old chat and CHECKs same task without replaying EXECUTE", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );

  const resume = source.indexOf("async function resumeInFlightProtocolMessageAfterRebind");
  const orphanProbe = source.indexOf("RESTART_WAIT_RESPONSE_ORPHAN_PROBE_2", resume);
  const orphanCode = source.indexOf("RUNTIME_RESTART_ORPHANED_IN_FLIGHT_TASK", orphanProbe);
  const startup = source.indexOf("if (rebound?.page)");
  const catchBranch = source.indexOf("RUNTIME_RESTART_ORPHANED_IN_FLIGHT_TASK", startup);
  const recovery = source.indexOf("recoverOrphanedInFlightTaskByCheck", catchBranch);
  assert.ok(resume >= 0 && orphanProbe > resume && orphanCode > orphanProbe);
  assert.ok(startup >= 0 && catchBranch > startup && recovery > catchBranch);

  const helperStart = source.indexOf("async function recoverOrphanedInFlightTaskByCheck");
  const helperEnd = source.indexOf("async function discoverTaskControl", helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /reason: "RUNTIME_RESTART_ORPHANED_IN_FLIGHT_TASK"/);
  assert.match(helper, /checkOnly: true/);
  assert.match(helper, /kind: "TASK_STATUS_CHECK"/);
  assert.doesNotMatch(helper, /kind: "TASK_EXECUTION"/);
});

test("SC-013 unmarked terminal recovery is proof-gated before long restart wait", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("async function resumeInFlightProtocolMessageAfterRebind");
  const end = source.indexOf("async function probeReusableConversationPage", start);
  const body = source.slice(start, end);
  const exactUser = body.indexOf("RESTART_WAIT_RESPONSE_EXACT_USER_CORRELATION");
  const helper = body.indexOf("stableUnmarkedTaskResponseCandidate", exactUser);
  const verify = body.indexOf("markCorrelatedInFlightTaskResponseVerified", helper);
  const settle = body.lastIndexOf("settleTransactionResponse");

  assert.ok(start >= 0 && end > start);
  assert.ok(exactUser >= 0);
  assert.ok(helper > exactUser);
  assert.ok(verify > helper);
  assert.ok(settle > verify);
  assert.match(body, /TERMINAL_PROBE_1/);
  assert.match(body, /TERMINAL_PROBE_2/);
  assert.doesNotMatch(body.slice(exactUser, settle), /sendProtocolMessage|reconcileExactOnceOutbound/);
});

test("SC-013 assistant cycle correlation is positive delivery evidence for restart", () => {
  const messageId = "4129456d-b3d8-4420-96b9-43988924c002";
  const correlated = {
    turn_id: "conversation-turn-assistant-9",
    text:
      "MAGASIN_TASK_CONTROL_V1\n" +
      "STATUS=RUNNING\n" +
      "TASK_ID=SCHED-UI-012\n" +
      "NEXT_TASK_ID=NONE\n" +
      "CHECK_AFTER_SECONDS=180\n" +
      "END_MAGASIN_TASK_CONTROL_V1\n\n" +
      "MAGASIN_CYCLE_CORRELATION_V1 " + messageId
  };
  assert.equal(
    assistantTurnConfirmsCycleDelivery(correlated, messageId),
    true
  );
  assert.equal(
    assistantTurnConfirmsCycleDelivery(
      correlated,
      "different-message-id"
    ),
    false
  );
  assert.equal(
    assistantTurnConfirmsCycleDelivery(
      { turn_id: "a", text: "STATUS=RUNNING" },
      messageId
    ),
    false
  );
});

test("SC-013 ENQUEUED task restart checks assistant correlation before exact-once resend decision", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("async function resumeEnqueuedTaskMessageAfterRebind");
  const end = source.indexOf("async function resumeInFlightProtocolMessageAfterRebind", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  const capture = body.indexOf("CAPTURE_ASSISTANT_CORRELATION");
  const positive = body.indexOf("correlatedAssistant?.confirmed === true", capture);
  const confirm = body.indexOf("assistantTurnConfirmsCycleDelivery", positive);
  const delivered = body.indexOf("markExactOnceDelivered", confirm);
  const verified = body.indexOf("markCorrelatedInFlightTaskResponseVerified", delivered);
  const confirmedReturn = body.indexOf("recovered_from_unique_assistant_cycle_correlation: true", verified);
  const reconcile = body.indexOf("reconcileExactOnceOutbound", confirmedReturn);
  const settle = body.indexOf("settleTransactionResponse", reconcile);

  assert.ok(capture >= 0);
  assert.match(body, /captureAssistantCycleCorrelationEvidence\(page, messageId\)/);
  assert.ok(positive > capture);
  assert.ok(confirm > positive);
  assert.ok(delivered > confirm);
  assert.ok(verified > delivered);
  // Proven delivery is VERIFIED and returned before generic fallback. Never resend.
  assert.ok(confirmedReturn > verified);
  assert.ok(reconcile > confirmedReturn);
  assert.ok(settle > reconcile);
  assert.doesNotMatch(body.slice(capture, confirmedReturn), /sendProtocolMessage|reconcileExactOnceOutbound/);
  assert.match(body, /userTurnId:\s*null/);
});


test("SC-013 runtime logs structured task-protocol subreason without chat content", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/single-conversation-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /SINGLE_CONVERSATION_TASK_PROTOCOL_REASON=/);
  assert.match(source, /MISSING_BLOCK/);
  assert.match(source, /MALFORMED_FIELD/);
  assert.match(source, /READY_MISSING_NEXT_TASK/);
  assert.match(source, /RUNNING_INVALID_TASK_OR_DELAY/);
  assert.match(source, /NO_EXECUTABLE_TASK_ID/);
  assert.doesNotMatch(
    source,
    /SINGLE_CONVERSATION_TASK_PROTOCOL_REASON=.*assistant_turn.*text/
  );
});


test("SC-013 persists a legitimate blocked Owner gate instead of leaving RUNNING/NEXT_WORK", async () => {
  const { root, statePath } = await tempState();
  try {
    await ensureSingleConversationState(statePath, {
      sourceOfTruthUrl: "https://github.com/magasincoffee/project/blob/main/SOURCE_OF_TRUTH.md"
    });

    const blocked = await persistTerminalTaskControl(statePath, {
      status: "BLOCKED",
      task_id: "SCHED-UI-016",
      next_task_id: null,
      check_after_seconds: 0
    }, {
      now: () => "2026-10-03T09:30:00.000Z"
    });

    assert.equal(blocked.automation.status, "BLOCKED");
    assert.equal(blocked.automation.phase, "WAIT_OWNER");
    assert.equal(blocked.automation.reason, "OWNER_INPUT_REQUIRED:SCHED-UI-016");

    const reread = await readSingleConversationState(statePath);
    assert.equal(reread.automation.status, "BLOCKED");
    assert.equal(reread.automation.phase, "WAIT_OWNER");
    assert.equal(reread.automation.reason, "OWNER_INPUT_REQUIRED:SCHED-UI-016");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SC-013 persists DONE separately from Owner BLOCKED", async () => {
  const { root, statePath } = await tempState();
  try {
    await ensureSingleConversationState(statePath, {
      sourceOfTruthUrl: "https://github.com/magasincoffee/project/blob/main/SOURCE_OF_TRUTH.md"
    });
    const done = await persistTerminalTaskControl(statePath, {
      status: "DONE",
      task_id: null,
      next_task_id: null,
      check_after_seconds: 0
    });
    assert.equal(done.automation.status, "DONE");
    assert.equal(done.automation.phase, "DONE");
    assert.equal(done.automation.reason, "PROJECT_DONE");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("SC-013 rebind retries only a transient read-only CDP probe, never sends", async () => {
  const page = { url: () => "https://chatgpt.com/c/one-correlated-chat" };
  let probes = 0;
  let sends = 0;
  const adapter = {
    async probePage(candidate) {
      assert.equal(candidate, page);
      probes += 1;
      if (probes === 1) throw Object.assign(new Error("slow hydration"), {
        code: "CDP_RECOVERY_REQUIRED"
      });
      return { snapshot: { conversationPath: true, composerReady: true } };
    },
    async send() { sends += 1; },
    async reopenTargetPage() { sends += 1; }
  };

  const result = await probeReusableConversationPage(adapter, page, {
    maxAttempts: 2, timeoutMs: 100, retryDelayMs: 0
  });
  assert.equal(result?.snapshot?.composerReady, true);
  assert.equal(probes, 2);
  assert.equal(sends, 0);
});

test("SC-013 rebind refuses auth/full-chat evidence without retries", async () => {
  for (const snapshot of [
    { loginRequired: true },
    { hasCaptcha: true },
    { conversationFull: true },
    { conversationIdentityAmbiguous: true },
    { conversationMissing: true }
  ]) {
    let count = 0;
    const adapter = {
      async probePage() {
        count += 1;
        return { snapshot };
      }
    };
    assert.equal(await probeReusableConversationPage(adapter, {}, {
      maxAttempts: 2, retryDelayMs: 0
    }), null);
    assert.equal(count, 1);
  }
});

test("SC-013 repeated unresponsive CDP probes fail closed in bounded time", async () => {
  let probes = 0;
  const adapter = {
    async probePage() {
      probes += 1;
      return new Promise(() => {});
    }
  };
  const begin = Date.now();
  assert.equal(await probeReusableConversationPage(adapter, {}, {
    maxAttempts: 99, timeoutMs: 10, retryDelayMs: 0
  }), null);
  assert.equal(probes, 2, "strict retry cap is two");
  assert.ok(Date.now() - begin < 800, "bounded failure, no infinite wait");
});


test("SC-013 assistant cycle recovery requires exactly one matching assistant response", async () => {
  const messageId = "sc013-cycle-unique";
  const marker = "MAGASIN_CYCLE_CORRELATION_V1 " + messageId;
  let calls = 0;
  const page = {
    async evaluate(_fn, args) {
      calls += 1;
      assert.equal(args.wantedMarker, marker);
      return { matches: [{turn_id:"unique-assistant-turn", text:"STATUS=RUNNING\n"+marker}] };
    }
  };
  const evidence = await captureAssistantCycleCorrelationEvidence(page,messageId);
  assert.equal(evidence.confirmed,true);
  assert.equal(evidence.turn_id,"unique-assistant-turn");
  assert.equal(evidence.match_count,1);
  assert.equal(assistantTurnConfirmsCycleDelivery(evidence,messageId),true);
  assert.equal(calls,1);
});

test("SC-013 missing or ambiguous assistant correlations fail closed", async () => {
  let calls=0;
  const page={
    async evaluate(_fn,args) {
      calls+=1;
      return { matches:[
        {turn_id:"assistant-1",text:args.wantedMarker},
        {turn_id:"assistant-2",text:args.wantedMarker}
      ]};
    }
  };
  const ambiguous=await captureAssistantCycleCorrelationEvidence(page,"message-1");
  assert.equal(ambiguous.confirmed,false);
  assert.equal(ambiguous.evidence,"multiple-assistant-cycle-correlations");
  assert.equal(assistantTurnConfirmsCycleDelivery(ambiguous,"message-1"),false);
  const missing=await captureAssistantCycleCorrelationEvidence(page,"");
  assert.equal(missing.confirmed,false);
  assert.equal(missing.evidence,"missing-message-id");
  assert.equal(calls,1,"missing message id must not query CDP");
});
