import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";

import {
  captureMatchingUserTurnEvidence,
  composerInstructionDigest,
  inspectComposerDraftDigest
} from "../ui/actions.mjs";
import {
  ChatGptUiAdapter,
  isTransientNavigationError
} from "../ui/playwright-adapter.mjs";
import {
  captureAssistantCycleCorrelationEvidence,
  captureLatestRoleTurn
} from "../ui/latest-turn.mjs";
import {
  bootstrapFailureRecoveryReason,
  buildSingleConversationBootstrap,
  canRecoverCorrelatedPreparedBootstrapDelivery,
  createNewChatAndBootstrap,
  opaqueRuntimeIdentity,
  recoverCorrelatedPreparedBootstrapDelivery
} from "./single-conversation-bootstrap.mjs";
import {
  buildSingleConversationNextInstruction,
  buildSingleConversationTaskDiscoveryInstruction,
  buildSingleConversationTaskInstruction,
  parseTaskControl,
  waitForSingleConversationResponse
} from "./single-conversation-loop.mjs";
import {
  classifyDisposableConversation,
  recoverDisposableConversationIfNeeded,
  replaceDisposableConversation
} from "./single-conversation-rollover.mjs";
import {
  ensureSingleConversationState,
  readSingleConversationState,
  writeSingleConversationState
} from "./single-conversation-state.mjs";
import {
  markExactOnceDelivered,
  markExactOnceResponseComplete,
  markExactOnceVerified,
  markCorrelatedInFlightTaskResponseVerified,
  prepareExactOnceOutbound,
  reconcileExactOnceOutbound,
  rewindFalseHistoricalDiscoveryDelivery
} from "./single-conversation-transaction.mjs";
import {
  parseExternalRunControl,
  reconcileExternalRunState,
  reconcileTaskControlWithExternalRun
} from "./external-run-control.mjs";
import {
  inspectTrackedGitHubRun,
  nextLocalMonitorSeconds
} from "./external-run-local-observer.mjs";

function parseArgs(argv) {
  const out = {
    statePath: null,
    sourceOfTruthUrl: null,
    cdpUrl: null,
    execute: false,
    qualificationOnly: false,
    pollMs: 2_000,
    // SC-011: allow one direct ChatGPT turn to remain observable for long E2E work.
    responseTimeoutMs: 5_400_000,
    maxCycles: 0
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--state") out.statePath = argv[++i];
    else if (arg === "--source-of-truth") out.sourceOfTruthUrl = argv[++i];
    else if (arg === "--cdp-url") out.cdpUrl = argv[++i];
    else if (arg === "--poll-ms") out.pollMs = Number(argv[++i]);
    else if (arg === "--response-timeout-ms") out.responseTimeoutMs = Number(argv[++i]);
    else if (arg === "--max-cycles") out.maxCycles = Number(argv[++i]);
    else if (arg === "--qualification-only") out.qualificationOnly = true;
    else if (arg === "--execute") out.execute = true;
    else throw new Error("unknown argument: " + arg);
  }
  return out;
}

function terminalAnswer(text) {
  const value = String(text || "");
  if (/\b(?:WAIT_OWNER|OWNER_REQUIRED|BLOCKED)\b/i.test(value)) return "WAIT_OWNER";
  if (/\b(?:PROJECT_DONE|PROJECT_COMPLETE)\b/i.test(value)) return "DONE";
  return null;
}

function runtimeStartupErrorCode(error) {
  const explicit = String(error?.code || "").trim().toUpperCase();
  if (explicit) return explicit.slice(0, 120);
  const message = String(error?.message || error || "");
  if (/captcha/i.test(message)) return "CAPTCHA_REQUIRED";
  if (/login|required|sign in/i.test(message)) return "AUTH_REQUIRED";
  if (/access is denied|access denied/i.test(message)) return "ACCESS_DENIED";
  if (/network|ECONN|ETIMEDOUT|socket|fetch failed/i.test(message)) return "NETWORK_ERROR";
  return "RUNTIME_START_FAILED";
}

async function persistRuntimeStartupState(
  statePath,
  {
    status = "RUNNING",
    phase,
    reason = null,
    errorCode = null,
    errorStage = null,
    now = () => new Date().toISOString()
  } = {}
) {
  const state = await readSingleConversationState(statePath);
  const at = new Date(typeof now === "function" ? now() : now).toISOString();
  state.automation.status = String(status || "RUNNING").toUpperCase();
  state.automation.phase = String(phase || "STARTING_BROWSER").toUpperCase();
  state.automation.reason = reason ? String(reason).slice(0, 300) : null;
  state.automation.updated_at = at;
  if (state.outbound && typeof state.outbound === "object") {
    state.outbound.last_error_code = errorCode ? String(errorCode).slice(0, 120) : null;
    if (Object.hasOwn(state.outbound, "last_error_stage")) {
      state.outbound.last_error_stage = errorStage ? String(errorStage).slice(0, 120) : null;
    }
  }
  return writeSingleConversationState(statePath, state, { now: () => at });
}

function taskProtocolSubreason(error) {
  const message = String(error?.message || "");
  const table = new Map([
    ["complete task-control block is missing", "MISSING_BLOCK"],
    ["malformed task-control line", "MALFORMED_FIELD"],
    ["invalid task-control status", "INVALID_STATUS"],
    ["invalid task id in task-control block", "INVALID_TASK_ID"],
    ["invalid CHECK_AFTER_SECONDS", "INVALID_CHECK_AFTER_SECONDS"],
    ["READY requires NEXT_TASK_ID", "READY_MISSING_NEXT_TASK"],
    ["RUNNING requires TASK_ID and positive CHECK_AFTER_SECONDS", "RUNNING_INVALID_TASK_OR_DELAY"],
    ["COMPLETE requires TASK_ID and NEXT_TASK_ID", "COMPLETE_MISSING_TASK_OR_NEXT"],
    ["COMPLETE cannot repeat the same TASK_ID as NEXT_TASK_ID", "COMPLETE_REPEATED_TASK"],
    ["DONE must not include NEXT_TASK_ID", "DONE_HAS_NEXT_TASK"],
    ["BLOCKED must not include NEXT_TASK_ID", "BLOCKED_HAS_NEXT_TASK"],
    ["task protocol did not provide an executable task id", "NO_EXECUTABLE_TASK_ID"],
    ["external-run protocol invalid", "EXTERNAL_RUN_PROTOCOL_INVALID"]
  ]);
  return table.get(message) || "OTHER_PROTOCOL_INVALID";
}

export async function reconcileExternalRunResponse({
  statePath,
  text,
  taskControl,
  expectedTaskId = null,
  sourceKind = null,
  now = () => new Date().toISOString(),
  fetchImpl = globalThis.fetch
} = {}) {
  const state = await readSingleConversationState(statePath);
  const evidence = parseExternalRunControl(text);
  if (!evidence) {
    const trackedTask = String(state.external_work?.task_id || "").trim();
    const expected = String(
      expectedTaskId ||
      state.outbound?.task_id ||
      taskControl?.task_id ||
      taskControl?.next_task_id ||
      ""
    ).trim();
    if (
      taskControl?.status === "RUNNING" &&
      trackedTask &&
      expected === trackedTask
    ) {
      // Once a task has entered durable external-run tracking, a later RUNNING
      // response without fresh run evidence is not concrete progress. Never
      // resume the timer from "no PASS yet"; return the same task to execution
      // so it must inspect/repair/trigger real external evidence.
      state.external_work.decision = "AUTO_REPAIR";
      state.external_work.last_action = "EXTERNAL_EVIDENCE_MISSING";
      state.external_work.next_action = "REFRESH_EXTERNAL_EVIDENCE";
      state.external_work.observed_at = new Date(
        typeof now === "function" ? now() : now
      ).toISOString();
      state.automation.status = "RUNNING";
      state.automation.phase = "AUTO_REPAIR";
      state.automation.reason = "EXTERNAL_EVIDENCE_MISSING";
      state.automation.updated_at = state.external_work.observed_at;
      await writeSingleConversationState(statePath, state, { now });
      return {
        status: "READY",
        task_id: null,
        next_task_id: expected,
        check_after_seconds: 0
      };
    }
    return taskControl;
  }

  const kind = String(sourceKind || state.outbound?.kind || "TASK_STATUS_CHECK").toUpperCase();
  const expected = String(
    expectedTaskId ||
    state.outbound?.task_id ||
    taskControl?.task_id ||
    taskControl?.next_task_id ||
    ""
  ).trim();

  const reconciled = reconcileExternalRunState({
    previous: state.external_work,
    evidence,
    sourceKind: kind,
    maxRepairAttempts: 3,
    now
  });
  state.external_work = reconciled.external_work;

  // A successful tracked workflow is not sufficient when sibling required
  // workflows for the same authoritative SHA are still active or have failed.
  // Read the same-SHA run set locally before allowing VERIFY/BLOCKED Owner gates.
  if (
    evidence.workflow_status === "completed" &&
    evidence.commit_sha &&
    evidence.workflow_run_id &&
    evidence.repo
  ) {
    const aggregate = await inspectTrackedGitHubRun({
      externalWork: state.external_work,
      fetchImpl,
      timeoutMs: 5_000
    }).catch(() => null);

    if (
      aggregate?.supported === true &&
      aggregate.authority === "AUTHORITATIVE" &&
      aggregate.run_set_supported === true
    ) {
      const activeCount = Number(aggregate.run_set_active_count || 0);
      const failureCount = Number(aggregate.run_set_failure_count || 0);
      state.external_work.run_set_count = Number(aggregate.run_set_count || 0);
      state.external_work.run_set_active_count = activeCount;
      state.external_work.run_set_completed_count = Number(
        aggregate.run_set_completed_count || 0
      );
      state.external_work.run_set_failure_count = failureCount;
      state.external_work.run_set_checked_at = new Date(
        typeof now === "function" ? now() : now
      ).toISOString();

      if (activeCount > 0) {
        reconciled.decision = "WAIT_EXTERNAL";
        state.external_work.decision = "WAIT_EXTERNAL";
        state.external_work.owner_required = false;
        state.external_work.execution_phase = "WAIT_RELEASE_GATE";
        state.external_work.current_gate = "SAME_SHA_REQUIRED_GATE_SET";
        state.external_work.last_result = "RUNNING";
        state.external_work.next_action = "WAIT_SAME_SHA_REQUIRED_GATES";
        state.external_work.next_check_seconds = 20;
      } else if (failureCount > 0) {
        reconciled.decision = "AUTO_REPAIR";
        state.external_work.decision = "AUTO_REPAIR";
        state.external_work.owner_required = false;
        state.external_work.execution_phase = "BATCH_REPAIR";
        state.external_work.current_gate = "SAME_SHA_REQUIRED_GATE_SET";
        state.external_work.last_result = "FAIL";
        state.external_work.failure_signature =
          `SAME_SHA_REQUIRED_GATE_FAILURES_${failureCount}`;
        state.external_work.next_action = "INSPECT_SAME_SHA_FAILURE_SET";
        state.external_work.next_check_seconds = 0;
      }
    }
  }

  switch (reconciled.decision) {
    case "WAIT_EXTERNAL":
      state.automation.status = "RUNNING";
      state.automation.phase = "WAIT_EXTERNAL";
      state.automation.reason = null;
      break;
    case "AUTO_REPAIR":
      state.automation.status = "RUNNING";
      state.automation.phase = "AUTO_REPAIR";
      state.automation.reason = Number(state.external_work?.run_set_failure_count || 0) > 0
        ? `SAME_SHA_REQUIRED_GATE_FAILURES:${state.external_work.run_set_failure_count}`
        : (evidence.workflow_conclusion
            ? `EXTERNAL_${String(evidence.workflow_conclusion).toUpperCase()}`
            : "EXTERNAL_FAILURE");
      break;
    case "TRIGGER_EXTERNAL_RUN":
      state.automation.status = "RUNNING";
      state.automation.phase = "TRIGGER_EXTERNAL_RUN";
      state.automation.reason = "EXTERNAL_RUN_NOT_FOUND";
      break;
    case "VERIFY_EXTERNAL_SUCCESS":
      state.automation.status = "RUNNING";
      state.automation.phase = "VERIFY_EXTERNAL_SUCCESS";
      state.automation.reason = null;
      break;
    case "BLOCKED_REPAIR_LIMIT":
      state.automation.status = "BLOCKED";
      state.automation.phase = "WAIT_OWNER";
      state.automation.reason = `OWNER_INPUT_REQUIRED:EXTERNAL_REPAIR_LIMIT:${evidence.task_id}`;
      break;
    case "BLOCKED_OWNER":
      state.automation.status = "BLOCKED";
      state.automation.phase = "WAIT_OWNER";
      state.automation.reason = `OWNER_INPUT_REQUIRED:EXTERNAL_RUN:${evidence.task_id}`;
      break;
    default:
      break;
  }
  state.automation.updated_at = new Date(
    typeof now === "function" ? now() : now
  ).toISOString();
  await writeSingleConversationState(statePath, state, { now });

  return reconcileTaskControlWithExternalRun({
    taskControl,
    evidence,
    externalWork: reconciled.external_work,
    expectedTaskId: expected || evidence.task_id
  });
}

async function parseTaskResponseControl({
  statePath,
  text,
  expectedTaskId = null,
  sourceKind = null
} = {}) {
  const control = parseTaskControl(text);
  try {
    return await reconcileExternalRunResponse({
      statePath,
      text,
      taskControl: control,
      expectedTaskId,
      sourceKind
    });
  } catch (error) {
    if (String(error?.code || "").startsWith("EXTERNAL_RUN_")) {
      throw Object.assign(
        new Error(`external-run protocol invalid: ${error.message}`),
        { code: "TASK_PROTOCOL_INVALID", cause: error }
      );
    }
    throw error;
  }
}

export async function persistTerminalTaskControl(
  statePath,
  control,
  { now = () => new Date().toISOString() } = {}
) {
  const status = String(control?.status || "").toUpperCase();
  if (!["BLOCKED", "DONE"].includes(status)) {
    return readSingleConversationState(statePath);
  }

  const state = await readSingleConversationState(statePath);
  const at = new Date(typeof now === "function" ? now() : now).toISOString();

  if (status === "BLOCKED") {
    const blockedTaskId = String(control?.task_id || "").trim();
    const externalDecision = String(state.external_work?.decision || "");
    state.automation.status = "BLOCKED";
    state.automation.phase = "WAIT_OWNER";
    if (externalDecision === "BLOCKED_REPAIR_LIMIT") {
      state.automation.reason = blockedTaskId
        ? `OWNER_INPUT_REQUIRED:EXTERNAL_REPAIR_LIMIT:${blockedTaskId}`
        : "OWNER_INPUT_REQUIRED:EXTERNAL_REPAIR_LIMIT";
    } else if (externalDecision === "BLOCKED_OWNER") {
      state.automation.reason = blockedTaskId
        ? `OWNER_INPUT_REQUIRED:EXTERNAL_RUN:${blockedTaskId}`
        : "OWNER_INPUT_REQUIRED:EXTERNAL_RUN";
    } else {
      state.automation.reason = blockedTaskId
        ? `OWNER_INPUT_REQUIRED:${blockedTaskId}`
        : "OWNER_INPUT_REQUIRED";
    }
  } else {
    state.automation.status = "DONE";
    state.automation.phase = "DONE";
    state.automation.reason = "PROJECT_DONE";
  }
  state.automation.wait_kind = null;
  state.automation.wait_label = null;
  state.automation.wait_task_id = null;
  state.automation.wait_started_at = null;
  state.automation.wait_until = null;
  state.automation.wait_seconds_total = 0;
  state.automation.updated_at = at;
  return writeSingleConversationState(statePath, state, { now: () => at });
}

export async function persistTaskRecheckWait(
  statePath,
  {
    taskId,
    seconds,
    now = () => new Date().toISOString()
  } = {}
) {
  const waitSeconds = Math.max(0, Math.min(3600, Math.floor(Number(seconds) || 0)));
  const state = await readSingleConversationState(statePath);
  const at = new Date(typeof now === "function" ? now() : now).toISOString();
  const until = new Date(new Date(at).getTime() + waitSeconds * 1000).toISOString();
  const id = String(taskId || "").trim() || null;

  const external = state.external_work || {};
  const waitingExternal = String(external.decision || "") === "WAIT_EXTERNAL";
  state.automation.status = "RUNNING";
  state.automation.phase = waitingExternal ? "WAIT_EXTERNAL" : "WAIT_TASK_RECHECK";
  state.automation.reason = waitingExternal
    ? (external.workflow_run_id
        ? `EXTERNAL_RUN:${external.workflow_run_id}`
        : "EXTERNAL_RUN")
    : (id ? `TASK_RECHECK:${id}` : "TASK_RECHECK");
  state.automation.wait_kind = waitingExternal ? "EXTERNAL_RUN" : "TASK_RECHECK";
  state.automation.wait_label = waitingExternal
    ? `Đang chờ GitHub CI ${external.workflow_name || ""} run ${external.workflow_run_id || "đang tạo"}`.trim()
    : (id
        ? `Đang chờ tác vụ ${id} hoàn tất trước lần kiểm tra kế tiếp`
        : "Đang chờ tác vụ nền hoàn tất trước lần kiểm tra kế tiếp");
  state.automation.wait_task_id = id;
  state.automation.wait_started_at = at;
  state.automation.wait_until = until;
  state.automation.wait_seconds_total = waitSeconds;
  state.automation.updated_at = at;
  return writeSingleConversationState(statePath, state, { now: () => at });
}

export async function clearTaskRecheckWait(
  statePath,
  { now = () => new Date().toISOString() } = {}
) {
  const state = await readSingleConversationState(statePath);
  const at = new Date(typeof now === "function" ? now() : now).toISOString();
  if (["WAIT_TASK_RECHECK", "WAIT_EXTERNAL"].includes(
    String(state.automation.phase || "").toUpperCase()
  )) {
    state.automation.phase = "NEXT_WORK";
    state.automation.reason = null;
  }
  state.automation.wait_kind = null;
  state.automation.wait_label = null;
  state.automation.wait_task_id = null;
  state.automation.wait_started_at = null;
  state.automation.wait_until = null;
  state.automation.wait_seconds_total = 0;
  state.automation.updated_at = at;
  return writeSingleConversationState(statePath, state, { now: () => at });
}

export async function persistTaskExecutionOptimizationIntent(statePath, {
  taskId,
  checkOnly = false,
  now = () => new Date().toISOString()
} = {}) {
  const id = String(taskId || "").trim();
  if (!id) throw new Error("taskId is required");
  const state = await readSingleConversationState(statePath);
  const at = new Date(typeof now === "function" ? now() : now).toISOString();
  const external = state.external_work || {};
  if (external.task_id && external.task_id !== id) {
    external.checkpoint_id = null;
    external.authoritative_sha = null;
    external.failure_root_key = null;
    external.failure_fingerprint = null;
    external.failure_occurrence_count = 0;
    external.loop_detected = false;
    external.repair_attempt = 0;
    external.poll_attempt = 0;
    external.next_check_seconds = 0;
    external.last_failure_batch_count = 0;
    external.last_failure_batch_signature = null;
    external.last_failure_batch_run_id = null;
    external.last_failure_batch_commit_sha = null;
    external.obsolete_runs = [];
  }
  external.task_id = id;
  const priorDecision = String(external.decision || "");
  external.execution_phase = checkOnly
    ? "CHECK_EXTERNAL"
    : (
      priorDecision === "AUTO_REPAIR"
        ? (external.loop_detected ? "REPAIR_STRATEGY_CHANGE" : "BATCH_REPAIR")
        : (
          priorDecision === "VERIFY_EXTERNAL_SUCCESS"
            ? "VERIFY_RELEASE_GATE"
            : "EXECUTE_TARGETED_QA"
        )
    );
  if (!checkOnly && external.execution_phase === "EXECUTE_TARGETED_QA") {
    external.current_gate = "TARGETED_QA";
    external.gate_started_at = at;
    external.last_result = "PENDING";
  }
  external.targeted_qa_required = true;
  external.release_regression_required = true;
  external.last_progress_at = external.last_progress_at || at;
  state.external_work = external;
  return writeSingleConversationState(statePath, state, { now });
}

export async function waitForNextCycleDelay(
  delayMs,
  { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}
) {
  const ms = Math.max(0, Number(delayMs) || 0);
  if (ms <= 0) return;
  await sleep(ms);
}

export async function waitForTaskRecheckDelay({
  adapter,
  page,
  statePath,
  sourceOfTruthUrl,
  taskId,
  seconds,
  qualificationOnly = false,
  responseTimeoutMs = 5_400_000,
  pollMs = 2_000,
  fetchImpl = globalThis.fetch,
  localMonitorMaxSeconds = 300,
  now = () => Date.now(),
  recoveryProbe = (args) => recoverDisposableConversationIfNeeded(args),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  if (!adapter) throw new Error("adapter is required");
  if (!page) throw new Error("page is required");
  if (!statePath) throw new Error("statePath is required");
  if (!sourceOfTruthUrl) throw new Error("sourceOfTruthUrl is required");
  if (!taskId) throw new Error("taskId is required");

  const totalMs = Math.max(
    0,
    Math.min(3_600_000, Math.floor(Number(seconds) || 0) * 1000)
  );
  if (totalMs <= 0) {
    return {
      page,
      recovered: false,
      recovery_count: 0,
      wake_reason: "NO_DELAY",
      local_external_checks: 0
    };
  }

  const requestedDeadline = Number(now()) + totalMs;
  const healthPollMs = Math.max(
    250,
    Math.min(2_000, Math.floor(Number(pollMs) || 2_000))
  );
  const suppressionBudgetMs = Math.max(
    0,
    Math.min(900_000, Math.floor(Number(localMonitorMaxSeconds) || 300) * 1000)
  );

  let activePage = page;
  let recoveryCount = 0;
  let localExternalChecks = 0;
  let localMonitoring = false;
  let localMonitorStartedAt = null;
  let nextExternalPollAt = requestedDeadline;

  async function observeTrackedExternal() {
    const state = await readSingleConversationState(statePath);
    const external = state.external_work || {};
    localExternalChecks += 1;
    return inspectTrackedGitHubRun({
      externalWork: external,
      fetchImpl,
      timeoutMs: 5_000
    });
  }

  async function scheduleNextLocalObservation() {
    const attempt = Math.max(1, localExternalChecks);
    const delaySeconds = nextLocalMonitorSeconds(attempt);
    nextExternalPollAt = Number(now()) + delaySeconds * 1000;
    await persistTaskRecheckWait(statePath, {
      taskId,
      seconds: delaySeconds
    });
  }

  // CHECK_AFTER_SECONDS remains the earliest protocol recheck deadline.
  // At that deadline, an authoritative tracked GitHub Actions run may be
  // observed locally/read-only. While that exact run is still active, suppress
  // redundant ChatGPT CHECK turns and keep observing locally. Terminal,
  // obsolete, unavailable, or bounded-heartbeat conditions wake the protocol
  // immediately; no project mutation or task execution occurs here.
  while (true) {
    const currentNow = Number(now());
    const decisionAt = localMonitoring ? nextExternalPollAt : requestedDeadline;

    if (currentNow >= decisionAt) {
      const observed = await observeTrackedExternal();

      if (
        observed.supported &&
        observed.authority === "AUTHORITATIVE" &&
        observed.active === true
      ) {
        if (!localMonitoring) {
          localMonitoring = true;
          localMonitorStartedAt = Number(now());
        }

        const suppressedFor = Number(now()) - localMonitorStartedAt;
        if (suppressionBudgetMs <= 0 || suppressedFor >= suppressionBudgetMs) {
          return {
            page: activePage,
            recovered: recoveryCount > 0,
            recovery_count: recoveryCount,
            wake_reason: "LOCAL_EXTERNAL_HEARTBEAT",
            local_external_checks: localExternalChecks,
            local_observation: observed
          };
        }

        await scheduleNextLocalObservation();
        continue;
      }

      const wakeReason =
        observed.supported && observed.authority === "OBSOLETE"
          ? "LOCAL_EXTERNAL_OBSOLETE"
          : observed.supported && observed.terminal
            ? "LOCAL_EXTERNAL_TERMINAL"
            : localMonitoring
              ? "LOCAL_EXTERNAL_UNAVAILABLE"
              : "CHECK_AFTER_DEADLINE";

      return {
        page: activePage,
        recovered: recoveryCount > 0,
        recovery_count: recoveryCount,
        wake_reason: wakeReason,
        local_external_checks: localExternalChecks,
        local_observation: observed
      };
    }

    const remainingBeforeDecision = decisionAt - currentNow;
    await sleep(Math.min(healthPollMs, remainingBeforeDecision));
    if (Number(now()) >= decisionAt) continue;

    const recovery = await boundedRuntimeStep(
      "TASK_RECHECK_WAIT_RECOVERY_PROBE",
      () => recoveryProbe({
        adapter,
        page: activePage,
        statePath,
        sourceOfTruthUrl,
        projectId: "LIVE",
        qualificationOnly,
        timeoutMs: responseTimeoutMs,
        pollMs: Math.min(750, Math.max(100, pollMs))
      }),
      { timeoutMs: 15_000 }
    );
    activePage = recovery.page;

    if (recovery.recovered) {
      recoveryCount += 1;
      const secondsToDecision = Math.max(
        1,
        Math.ceil((decisionAt - Number(now())) / 1000)
      );
      await persistTaskRecheckWait(statePath, {
        taskId,
        seconds: secondsToDecision
      });
    }
  }
}

export async function boundedRuntimeStep(
  label,
  operation,
  {
    timeoutMs = 15_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = {}
) {
  if (typeof operation !== "function") {
    throw new TypeError("operation is required");
  }
  const stage = String(label || "RUNTIME_UI_STEP").trim() || "RUNTIME_UI_STEP";
  const budget = Math.max(1, Number(timeoutMs) || 15_000);
  let timer = null;

  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimer(() => {
          const error = Object.assign(
            new Error(`runtime UI/CDP step timed out: ${stage}`),
            {
              code: "CDP_RECOVERY_REQUIRED",
              runtime_stage: stage
            }
          );
          reject(error);
        }, budget);
      })
    ]);
  } finally {
    if (timer) clearTimer(timer);
  }
}

async function boundedRuntimeCleanup(action, timeoutMs = 1_500) {
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise((resolve) => {
        timer = setTimeout(resolve, Math.max(1, Number(timeoutMs) || 1_500));
        timer.unref?.();
      })
    ]);
  } catch {
    // Cleanup must never prevent deterministic wrapper recovery.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function replacementReasonForResponseWaitError(error) {
  const code = String(error?.code || "").toUpperCase();
  if (code === "TRANSIENT_ERROR") return "REPEATED_TRANSIENT_FAILURE";
  if (code === "NETWORK_ERROR") return "REPEATED_NETWORK_FAILURE";
  return null;
}

export function recoverableConversationFullTask(state) {
  const outbound = state?.outbound || {};
  const kind = String(outbound.kind || "").toUpperCase();
  const outboundState = String(outbound.state || "").toUpperCase();
  const taskId = String(outbound.task_id || "").trim();
  const errorCode = String(outbound.last_error_code || "").toUpperCase();
  const conversationStatus = String(state?.conversation?.status || "").toUpperCase();

  if (
    conversationStatus !== "ACTIVE" ||
    errorCode !== "CONVERSATION_FULL" ||
    !["TASK_EXECUTION", "TASK_STATUS_CHECK"].includes(kind) ||
    !["ENQUEUED", "DELIVERED", "RESPONSE_RUNNING"].includes(outboundState) ||
    !taskId
  ) {
    return null;
  }

  return {
    task_id: taskId,
    kind,
    outbound_state: outboundState,
    message_id: String(outbound.message_id || "").trim() || null
  };
}

export function bootstrapRecoveryReasonForState(state) {
  const outbound = state?.outbound || {};
  const outboundState = String(outbound.state || "").toUpperCase();
  if (
    String(state?.conversation?.status || "").toUpperCase() !== "ACTIVE" ||
    String(outbound.kind || "") !== "SOURCE_OF_TRUTH_BOOTSTRAP" ||
    !["DELIVERED", "RESPONSE_RUNNING"].includes(outboundState)
  ) {
    return null;
  }

  const code = String(outbound.last_error_code || "").toUpperCase();
  const explicit = {
    TRANSIENT_ERROR: "BOOTSTRAP_TRANSIENT_FAILURE",
    NETWORK_ERROR: "BOOTSTRAP_NETWORK_FAILURE",
    CONVERSATION_MISSING: "BOOTSTRAP_CONVERSATION_MISSING",
    CONVERSATION_ACCESS_DENIED: "BOOTSTRAP_ACCESS_DENIED",
    RESPONSE_TIMEOUT: "BOOTSTRAP_RESPONSE_TIMEOUT"
  };
  if (explicit[code]) return explicit[code];

  // Compatibility with the production incident captured before bootstrap
  // errors carried specific codes. At RESPONSE_RUNNING, the bootstrap user
  // turn is already durably delivered and bootstrap performs no project work,
  // so retiring that disposable chat is safe and cannot duplicate a project
  // side effect.
  if (
    code === "BOOTSTRAP_FAILED" &&
    String(state?.automation?.phase || "").toUpperCase() === "BOOTSTRAP_FAILED"
  ) {
    return "BOOTSTRAP_RESPONSE_SURFACE_FAILURE";
  }
  return null;
}


export function canRecoverPreparedBootstrapNonDelivery(state) {
  const outbound = state?.outbound || {};
  return Boolean(
    String(state?.conversation?.status || "").toUpperCase() === "ACTIVE" &&
    !String(state?.conversation?.runtime_id || "").trim() &&
    String(state?.automation?.status || "").toUpperCase() === "BLOCKED" &&
    String(state?.automation?.phase || "").toUpperCase() === "BOOTSTRAP_FAILED" &&
    String(outbound.state || "").toUpperCase() === "PREPARED" &&
    String(outbound.kind || "") === "SOURCE_OF_TRUTH_BOOTSTRAP" &&
    String(outbound.last_error_code || "").toUpperCase() === "SEND_NOT_ACTUATED" &&
    Number(outbound.retry_count || 0) < 1 &&
    String(outbound.message_id || "").trim() &&
    String(outbound.message_digest || "").trim()
  );
}

export function preparedBootstrapIsStaleEnough(
  state,
  {
    nowMs = Date.now(),
    minimumAgeMs = 60_000
  } = {}
) {
  const raw =
    state?.outbound?.prepared_at ||
    state?.updated_at ||
    null;
  const preparedAt = Date.parse(String(raw || ""));
  if (!Number.isFinite(preparedAt)) return false;
  return Number(nowMs) - preparedAt >= Math.max(0, Number(minimumAgeMs) || 0);
}

export function safeFalseHistoricalDeliverySnapshot(snapshot = {}) {
  return Boolean(
    snapshot &&
    !snapshot.loginRequired &&
    !snapshot.hasCaptcha &&
    !snapshot.hasNetworkError &&
    !snapshot.hasTransientError &&
    !snapshot.conversationMissing &&
    !snapshot.conversationAccessDenied &&
    snapshot.responseRunning === false &&
    snapshot.composerReady === true &&
    snapshot.composerTextReadable === true &&
    snapshot.composerHasText === false
  );
}

export function safeBootstrapNonDeliverySnapshot(snapshot = {}) {
  return Boolean(
    snapshot &&
    !snapshot.loginRequired &&
    !snapshot.hasCaptcha &&
    !snapshot.hasNetworkError &&
    !snapshot.hasTransientError &&
    !snapshot.conversationMissing &&
    !snapshot.conversationAccessDenied &&
    !snapshot.conversationPath &&
    !snapshot.responseRunning &&
    snapshot.composerReady === true &&
    snapshot.composerTextReadable === true &&
    snapshot.composerHasText === false &&
    Number(snapshot.conversationTurnElementCount || 0) === 0
  );
}

function logBootstrapNonDeliverySample(reason, details = {}) {
  const safe = {
    reason: String(reason || "UNKNOWN"),
    ...details
  };
  console.log(
    "BOOTSTRAP_NON_DELIVERY_SAMPLE=" +
      JSON.stringify(safe)
  );
}

async function hasPositiveBlankBootstrapNonDelivery(
  adapter,
  page,
  { expectedInstruction = null } = {}
) {
  if (!page || !isBlankHomePage(page)) {
    logBootstrapNonDeliverySample("NOT_BLANK_HOME");
    return false;
  }

  let probeError = null;
  const probe = await boundedRuntimeStep(
    "BOOTSTRAP_NON_DELIVERY_PROBE",
    () => adapter.probePage(page),
    { timeoutMs: 10_000 }
  ).catch((error) => {
    if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
    probeError = String(error?.code || error?.message || "PROBE_FAILED").slice(0, 120);
    return null;
  });
  const snapshot = probe?.snapshot || {};
  if (!probe || !safeBootstrapNonDeliverySnapshot(snapshot)) {
    logBootstrapNonDeliverySample("SAFE_SNAPSHOT_NOT_READY", {
      probe_error: probeError,
      conversation_path: Boolean(snapshot.conversationPath),
      composer_ready: snapshot.composerReady === true,
      response_running: Boolean(snapshot.responseRunning),
      login_required: Boolean(snapshot.loginRequired),
      captcha: Boolean(snapshot.hasCaptcha),
      network_error: Boolean(snapshot.hasNetworkError),
      transient_error: Boolean(snapshot.hasTransientError),
      conversation_missing: Boolean(snapshot.conversationMissing),
      access_denied: Boolean(snapshot.conversationAccessDenied),
      structured_turn_count: Number(snapshot.conversationTurnElementCount || 0),
      composer_text_readable: snapshot.composerTextReadable === true,
      composer_has_text:
        snapshot.composerHasText === null
          ? null
          : Boolean(snapshot.composerHasText),
      composer_text_char_count: Number(snapshot.composerTextCharCount || 0)
    });
    return false;
  }

  const wanted = String(expectedInstruction || "");
  if (!wanted) {
    logBootstrapNonDeliverySample("EXPECTED_INSTRUCTION_MISSING");
    return false;
  }

  let exactTurnError = null;
  const exactTurn = await boundedRuntimeStep(
    "BOOTSTRAP_NON_DELIVERY_EXACT_TURN",
    () => captureMatchingUserTurnEvidence(page, wanted),
    { timeoutMs: 5_000 }
  ).catch((error) => {
    if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
    exactTurnError = String(error?.code || error?.message || "EXACT_TURN_FAILED").slice(0, 120);
    return null;
  });
  if (
    !exactTurn ||
    exactTurn.confirmed ||
    exactTurn.evidence === "user-turn-state-unreadable"
  ) {
    logBootstrapNonDeliverySample("EXACT_TURN_NOT_SAFE", {
      exact_error: exactTurnError,
      confirmed: Boolean(exactTurn?.confirmed),
      evidence: String(exactTurn?.evidence || ""),
      total_count: Number(exactTurn?.totalCount || 0)
    });
    return false;
  }

  // The same safe DOM snapshot already proved the active composer is ready,
  // text-readable, and empty. Do not issue a second locator traversal here:
  // on the production ChatGPT surface that redundant traversal can time out
  // while the already-captured DOM evidence remains valid.
  logBootstrapNonDeliverySample("POSITIVE");
  return true;
}

export async function waitForPositiveBlankBootstrapNonDelivery(
  adapter,
  initialPage = null,
  {
    timeoutMs = 90_000,
    pollMs = 750,
    stablePasses = 2,
    verify = hasPositiveBlankBootstrapNonDelivery,
    expectedInstruction = null,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}
) {
  if (!adapter) throw new TypeError("adapter is required");
  if (typeof verify !== "function") throw new TypeError("verify is required");

  const requiredPasses = Math.max(1, Number(stablePasses) || 1);
  const deadline = Number(now()) + Math.max(1, Number(timeoutMs) || 1);
  let stablePage = null;
  let passCount = 0;

  while (Number(now()) <= deadline) {
    const active = adapter.getActivePage?.() || null;
    const pages = adapter.getChatGptPages?.() || [];
    const candidates = [];
    for (const candidate of [initialPage, active, ...pages]) {
      if (!candidate || candidates.includes(candidate)) continue;
      if (candidate.isClosed?.()) continue;
      candidates.push(candidate);
    }

    const candidate =
      candidates.find((page) => isBlankHomePage(page)) ||
      candidates[0] ||
      null;

    const positive = candidate
      ? await verify(adapter, candidate, { expectedInstruction })
      : false;

    if (positive) {
      if (stablePage === candidate) {
        passCount += 1;
      } else {
        stablePage = candidate;
        passCount = 1;
      }
      console.log(
        "BOOTSTRAP_NON_DELIVERY_STABLE_PASS=" +
          passCount + "/" + requiredPasses
      );
      if (passCount >= requiredPasses) return candidate;
    } else {
      stablePage = null;
      passCount = 0;
    }

    if (Number(now()) >= deadline) break;
    await sleep(Math.max(0, Number(pollMs) || 0));
  }

  console.log("BOOTSTRAP_NON_DELIVERY_SETTLE_TIMEOUT=True");
  return null;
}

function recoverableBootstrapPage(adapter, state) {
  const expected = String(state?.conversation?.runtime_id || "").trim();
  const pages = adapter?.getChatGptPages?.() || [];
  const exact = expected
    ? pages.find((candidate) => runtimeIdMatchesPage(candidate, expected))
    : null;
  return exact || adapter?.getActivePage?.() || null;
}

async function createInitialBootstrapWithRecovery({
  adapter,
  statePath,
  sourceOfTruthUrl,
  qualificationOnly,
  responseTimeoutMs,
  pollMs
} = {}) {
  try {
    return await createNewChatAndBootstrap({
      adapter,
      statePath,
      sourceOfTruthUrl,
      projectId: "LIVE",
      qualificationOnly,
      forceNewPage: true,
      timeoutMs: responseTimeoutMs,
      pollMs: Math.min(750, Math.max(100, pollMs))
    });
  } catch (error) {
    const failed = await readSingleConversationState(statePath);
    const reason =
      bootstrapFailureRecoveryReason(error, failed) ||
      bootstrapRecoveryReasonForState(failed);
    if (!reason) throw error;

    // One bounded immediate replacement prevents a single transient ChatGPT
    // response-surface failure from becoming an Owner pause. If the replacement
    // itself fails, its own durable state remains available for diagnosis
    // instead of creating an unbounded replacement storm.
    return replaceDisposableConversation({
      adapter,
      page: recoverableBootstrapPage(adapter, failed),
      statePath,
      reason,
      sourceOfTruthUrl,
      projectId: "LIVE",
      qualificationOnly,
      timeoutMs: responseTimeoutMs,
      pollMs: Math.min(750, Math.max(100, pollMs))
    });
  }
}

async function settleTransactionResponse({
  adapter,
  page,
  statePath,
  messageId,
  message,
  baselineAssistantTurnId,
  expectedAssistantMarker = `MAGASIN_CYCLE_CORRELATION_V1 ${messageId}`,
  timeoutMs,
  pollMs
}) {
  const response = await waitForSingleConversationResponse({
    adapter,
    page,
    statePath,
    baselineAssistantTurnId,
    expectedAssistantMarker,
    timeoutMs,
    pollMs,
    maxContinueClicks: 8
  });
  if (response?.status !== "RESPONSE_COMPLETE") {
    throw new Error("single-conversation response did not complete");
  }
  await markExactOnceResponseComplete(statePath, {
    messageId,
    message,
    assistantTurnId: response.assistant_turn?.turn_id || null
  });
  await markExactOnceVerified(statePath, { messageId, message });
  return response;
}


export function canResumePreActuationDiscovery(state) {
  const outbound = state?.outbound || {};
  return Boolean(
    String(state?.conversation?.status || "").toUpperCase() === "ACTIVE" &&
    String(outbound.state || "").toUpperCase() === "ENQUEUED" &&
    String(outbound.kind || "") === "SOURCE_OF_TRUTH_TASK_DISCOVERY" &&
    String(outbound.last_pre_actuation_error_code || "") === "COMPOSER_NOT_READY" &&
    Number(outbound.retry_count || 0) < 1 &&
    String(outbound.message_id || "").trim() &&
    String(outbound.message_digest || "").trim()
  );
}

export function canRebindEnqueuedTaskMessage(state) {
  const outbound = state?.outbound || {};
  const kind = String(outbound.kind || "");
  return Boolean(
    String(state?.conversation?.status || "").toUpperCase() === "ACTIVE" &&
    String(outbound.state || "").toUpperCase() === "ENQUEUED" &&
    ["TASK_STATUS_CHECK", "TASK_EXECUTION"].includes(kind) &&
    String(outbound.message_id || "").trim() &&
    String(outbound.message_digest || "").trim()
  );
}

export function canRebindEnqueuedTaskDiscovery(state) {
  const outbound = state?.outbound || {};
  const lastError = String(outbound.last_error_code || "");
  return Boolean(
    String(state?.conversation?.status || "").toUpperCase() === "ACTIVE" &&
    String(outbound.state || "").toUpperCase() === "ENQUEUED" &&
    String(outbound.kind || "") === "SOURCE_OF_TRUTH_TASK_DISCOVERY" &&
    ["SEND_NOT_ACTUATED", "POST_SEND_CONFIRMATION_PENDING"].includes(lastError) &&
    Number(outbound.retry_count || 0) < 1 &&
    String(outbound.message_id || "").trim() &&
    String(outbound.message_digest || "").trim()
  );
}

export function canReplaceLostReadOnlyDiscovery(state) {
  const outbound = state?.outbound || {};
  const kind = String(outbound.kind || "").toUpperCase();
  const outboundState = String(outbound.state || "").toUpperCase();
  return Boolean(
    String(state?.conversation?.status || "").toUpperCase() === "ACTIVE" &&
    ["SOURCE_OF_TRUTH_TASK_DISCOVERY", "SOURCE_OF_TRUTH_NEXT_WORK"].includes(kind) &&
    ["ENQUEUED", "DELIVERED", "RESPONSE_RUNNING"].includes(outboundState) &&
    String(outbound.message_id || "").trim() &&
    String(outbound.message_digest || "").trim()
  );
}

export function canReplaceLostSettledConversation(state) {
  const outbound = state?.outbound || {};
  const outboundState = String(outbound.state || "").toUpperCase();
  return Boolean(
    String(state?.conversation?.status || "").toUpperCase() === "ACTIVE" &&
    ["RESPONSE_COMPLETE", "VERIFIED"].includes(outboundState) &&
    String(outbound.message_id || "").trim() &&
    String(outbound.message_digest || "").trim()
  );
}

export function canRebindEnqueuedStatusCheck(state) {
  return Boolean(
    canRebindEnqueuedTaskMessage(state) &&
    String(state?.outbound?.kind || "") === "TASK_STATUS_CHECK"
  );
}

const REBINDABLE_IN_FLIGHT_PROTOCOL_KINDS = new Set([
  "SOURCE_OF_TRUTH_BOOTSTRAP",
  "SOURCE_OF_TRUTH_TASK_DISCOVERY",
  "SOURCE_OF_TRUTH_NEXT_WORK",
  "TASK_STATUS_CHECK",
  "TASK_EXECUTION"
]);

export function canRebindPreparedProtocolMessage(state) {
  const outbound = state?.outbound || {};
  const kind = String(outbound.kind || "");
  return Boolean(
    String(state?.conversation?.status || "").toUpperCase() === "ACTIVE" &&
    String(outbound.state || "").toUpperCase() === "PREPARED" &&
    [
      "SOURCE_OF_TRUTH_TASK_DISCOVERY",
      "SOURCE_OF_TRUTH_NEXT_WORK",
      "TASK_STATUS_CHECK",
      "TASK_EXECUTION"
    ].includes(kind) &&
    String(outbound.message_id || "").trim() &&
    String(outbound.message_digest || "").trim()
  );
}

export function canRebindInFlightProtocolMessage(state) {
  const outbound = state?.outbound || {};
  const outboundState = String(outbound.state || "").toUpperCase();
  const kind = String(outbound.kind || "");
  return Boolean(
    String(state?.conversation?.status || "").toUpperCase() === "ACTIVE" &&
    ["DELIVERED", "RESPONSE_RUNNING"].includes(outboundState) &&
    REBINDABLE_IN_FLIGHT_PROTOCOL_KINDS.has(kind) &&
    String(outbound.message_id || "").trim() &&
    String(outbound.message_digest || "").trim()
  );
}

function canReconstructTaskMessage(state) {
  const outbound = state?.outbound || {};
  const kind = String(outbound.kind || "");
  const outboundState = String(outbound.state || "").toUpperCase();
  return Boolean(
    String(state?.conversation?.status || "").toUpperCase() === "ACTIVE" &&
    ["PREPARED", "ENQUEUED", "DELIVERED", "RESPONSE_RUNNING"].includes(outboundState) &&
    ["TASK_STATUS_CHECK", "TASK_EXECUTION"].includes(kind) &&
    String(outbound.message_id || "").trim() &&
    String(outbound.message_digest || "").trim()
  );
}

export function reconstructPendingTaskMessage(state, evidenceText = null) {
  if (!canReconstructTaskMessage(state)) return null;
  const messageId = String(state.outbound.message_id || "").trim();
  const kind = String(state.outbound.kind || "");
  const checkOnly = kind === "TASK_STATUS_CHECK";
  const protocolHeader = checkOnly
    ? "MAGASIN_CHECK_TASK_V1"
    : "MAGASIN_EXECUTE_TASK_V1";
  let taskId = String(state.outbound.task_id || "").trim();

  if (!taskId) {
    const text = String(evidenceText || "").replace(/\r\n/g, "\n");
    if (!text.includes(protocolHeader)) return null;
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.includes(`id=${messageId}`)) return null;
    const taskLine = lines.find((line) => line.startsWith("TASK_ID="));
    taskId = String(taskLine || "").slice("TASK_ID=".length).trim();
    if (!taskId) return null;
  }

  const expectedDigest = String(state.outbound.message_digest || "");
  const candidates = [];
  try {
    candidates.push(
      buildSingleConversationTaskInstruction({
        sourceOfTruthUrl: state.source_of_truth?.url,
        taskId,
        messageId,
        checkOnly,
        optimizationPolicy: true
      }),
      buildSingleConversationTaskInstruction({
        sourceOfTruthUrl: state.source_of_truth?.url,
        taskId,
        messageId,
        checkOnly,
        optimizationPolicy: false
      })
    );
  } catch {
    return null;
  }

  return candidates.find(
    (candidate) => composerInstructionDigest(candidate) === expectedDigest
  ) || null;
}

export function reconstructPendingStatusCheckMessage(state, evidenceText = null) {
  if (!canRebindEnqueuedStatusCheck(state)) return null;
  return reconstructPendingTaskMessage(state, evidenceText);
}

export function reconstructPendingProtocolMessage(state, evidenceText = null) {
  if (
    !canRebindPreparedProtocolMessage(state) &&
    !canRebindInFlightProtocolMessage(state) &&
    !canRebindEnqueuedTaskDiscovery(state)
  ) return null;

  const outbound = state.outbound || {};
  const kind = String(outbound.kind || "");
  const messageId = String(outbound.message_id || "").trim();
  const sourceOfTruthUrl = String(state?.source_of_truth?.url || "").trim();
  const expectedDigest = String(outbound.message_digest || "").trim();
  const candidates = [];

  try {
    if (kind === "SOURCE_OF_TRUTH_BOOTSTRAP") {
      candidates.push(
        buildSingleConversationBootstrap({
          sourceOfTruthUrl,
          messageId,
          qualificationOnly: false
        }),
        buildSingleConversationBootstrap({
          sourceOfTruthUrl,
          messageId,
          qualificationOnly: true
        })
      );
    } else if (kind === "SOURCE_OF_TRUTH_TASK_DISCOVERY") {
      candidates.push(buildSingleConversationTaskDiscoveryInstruction({
        sourceOfTruthUrl,
        messageId
      }));
    } else if (kind === "SOURCE_OF_TRUTH_NEXT_WORK") {
      candidates.push(
        buildSingleConversationNextInstruction({
          sourceOfTruthUrl,
          messageId,
          qualificationOnly: false
        }),
        buildSingleConversationNextInstruction({
          sourceOfTruthUrl,
          messageId,
          qualificationOnly: true
        })
      );
    } else if (["TASK_STATUS_CHECK", "TASK_EXECUTION"].includes(kind)) {
      const taskMessage = reconstructPendingTaskMessage(state, evidenceText);
      if (taskMessage) candidates.push(taskMessage);
    }
  } catch {
    return null;
  }

  return candidates.find(
    (candidate) => composerInstructionDigest(candidate) === expectedDigest
  ) || null;
}

function safeRebindOutboundState(state) {
  return (
    ["RESPONSE_COMPLETE", "VERIFIED"].includes(
      String(state?.outbound?.state || "").toUpperCase()
    ) ||
    canResumePreActuationDiscovery(state) ||
    canRebindPreparedProtocolMessage(state) ||
    canRebindEnqueuedTaskDiscovery(state) ||
    canRebindEnqueuedTaskMessage(state) ||
    canRebindInFlightProtocolMessage(state)
  );
}

async function resumePreparedProtocolMessageAfterRebind({
  adapter,
  page,
  statePath,
  responseTimeoutMs,
  pollMs
} = {}) {
  const state = await readSingleConversationState(statePath);
  if (!canRebindPreparedProtocolMessage(state)) return null;

  const kind = String(state.outbound.kind || "");
  const messageId = String(state.outbound.message_id || "");

  let message = reconstructPendingProtocolMessage(state);
  let latestUser = null;

  if (!message) {
    latestUser = await boundedRuntimeStep(
      "RESTART_PREPARED_CAPTURE_USER",
      () => captureLatestRoleTurn(page, "user"),
      { timeoutMs: 10_000 }
    ).catch((error) => {
      if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
      return null;
    });
    message = reconstructPendingProtocolMessage(state, latestUser?.text);
  }

  if (!message) {
    throw Object.assign(
      new Error(`prepared ${kind} has no exact restart reconstruction`),
      { code: "RUNTIME_RESTART_PREPARED_UNRESOLVED" }
    );
  }

  // PREPARED is durable proof that browser actuation has not yet started.
  // Rebind the exact conversation and let the exact-once reconciler perform
  // the first send. This is not a retry and must not increment retry_count.
  const delivery = await reconcileExactOnceOutbound({
    statePath,
    page,
    messageId,
    message,
    maxSafeRetries: 1,
    reconciliationProbes: 4,
    reconciliationPollMs: Math.min(500, Math.max(100, pollMs))
  });
  if (!["SEND", "NO_SEND"].includes(delivery.action)) {
    throw Object.assign(
      new Error(`restart PREPARED ${kind} did not reach first-send evidence`),
      { code: "RUNTIME_RESTART_PREPARED_RECONCILE_FAILED" }
    );
  }

  return settleTransactionResponse({
    adapter,
    page,
    statePath,
    messageId,
    message,
    baselineAssistantTurnId: null,
    timeoutMs: responseTimeoutMs,
    pollMs: Math.min(750, Math.max(100, pollMs))
  });
}

async function resumeEnqueuedTaskDiscoveryAfterRebind({
  adapter,
  page,
  statePath,
  responseTimeoutMs,
  pollMs
} = {}) {
  const state = await readSingleConversationState(statePath);
  if (!canRebindEnqueuedTaskDiscovery(state)) return null;

  const messageId = String(state.outbound.message_id || "");
  const message = reconstructPendingProtocolMessage(state);
  if (!message) {
    throw Object.assign(
      new Error("pending SOURCE_OF_TRUTH_TASK_DISCOVERY has no exact restart reconstruction"),
      { code: "RUNTIME_RESTART_ENQUEUED_DISCOVERY_UNRESOLVED" }
    );
  }

  // Correlation or an actively running response on the exact rebound
  // conversation is positive evidence that the prior discovery submit reached
  // ChatGPT. Observe the existing response only; never replay this message.
  const correlatedAssistant = await boundedRuntimeStep(
    "RESTART_DISCOVERY_CAPTURE_ASSISTANT_CORRELATION",
    () => captureLatestRoleTurn(page, "assistant"),
    { timeoutMs: 10_000 }
  ).catch(() => null);

  if (assistantTurnConfirmsCycleDelivery(correlatedAssistant, messageId)) {
    await markExactOnceDelivered(statePath, {
      messageId,
      message,
      userTurnId: null
    });
    return settleTransactionResponse({
      adapter,
      page,
      statePath,
      messageId,
      message,
      baselineAssistantTurnId: null,
      timeoutMs: responseTimeoutMs,
      pollMs: Math.min(750, Math.max(100, pollMs))
    });
  }

  const pendingPostSendConfirmation =
    String(state.outbound.last_error_code || "") ===
    "POST_SEND_CONFIRMATION_PENDING";
  const reboundProbe = await boundedRuntimeStep(
    "RESTART_DISCOVERY_RESPONSE_PROBE",
    () => adapter.probePage(page),
    { timeoutMs: 10_000 }
  ).catch(() => null);
  const responseRunning = Boolean(reboundProbe?.snapshot?.responseRunning);

  if (pendingPostSendConfirmation || responseRunning) {
    return settleTransactionResponse({
      adapter,
      page,
      statePath,
      messageId,
      message,
      baselineAssistantTurnId: null,
      timeoutMs: responseTimeoutMs,
      pollMs: Math.min(750, Math.max(100, pollMs))
    });
  }

  // Without correlation/running-response evidence, the legacy
  // SEND_NOT_ACTUATED state remains fail-closed: only the existing exact-once
  // reconciler may prove delivery or positive non-delivery before any retry.
  const delivery = await reconcileExactOnceOutbound({
    statePath,
    page,
    messageId,
    message,
    maxSafeRetries: 1,
    reconciliationProbes: 4,
    reconciliationPollMs: Math.min(500, Math.max(100, pollMs))
  });
  if (!["SEND", "SAFE_RETRY_SENT", "NO_SEND"].includes(delivery.action)) {
    throw Object.assign(
      new Error("restart SOURCE_OF_TRUTH_TASK_DISCOVERY reconciliation did not reach delivery evidence"),
      { code: "RUNTIME_RESTART_ENQUEUED_DISCOVERY_RECONCILE_FAILED" }
    );
  }

  return settleTransactionResponse({
    adapter,
    page,
    statePath,
    messageId,
    message,
    baselineAssistantTurnId: null,
    timeoutMs: responseTimeoutMs,
    pollMs: Math.min(750, Math.max(100, pollMs))
  });
}

export function assistantTurnConfirmsCycleDelivery(turn, messageId) {
  const id = String(messageId || "").trim();
  if (!id || !turn?.turn_id) return false;
  return String(turn.text || "").includes(
    `MAGASIN_CYCLE_CORRELATION_V1 ${id}`
  );
}

export function stableUnmarkedTaskResponseCandidate({
  state,
  snapshot,
  matchingUser,
  assistantFirst,
  assistantSecond
} = {}) {
  const outbound = state?.outbound || {};
  const kind = String(outbound.kind || "").toUpperCase();
  const outboundState = String(outbound.state || "").toUpperCase();
  const expectedTaskId = String(outbound.task_id || "").trim();

  if (
    !["TASK_EXECUTION", "TASK_STATUS_CHECK"].includes(kind) ||
    !["DELIVERED", "RESPONSE_RUNNING"].includes(outboundState) ||
    !expectedTaskId ||
    matchingUser?.confirmed !== true ||
    !snapshot ||
    snapshot.responseRunning === true ||
    snapshot.assistantBusy === true ||
    snapshot.hasContinueControl === true ||
    snapshot.loginRequired === true ||
    snapshot.hasCaptcha === true ||
    snapshot.hasNetworkError === true ||
    snapshot.hasTransientError === true ||
    snapshot.conversationMissing === true ||
    snapshot.conversationAccessDenied === true ||
    snapshot.composerReady !== true ||
    snapshot.composerTextReadable !== true ||
    snapshot.composerHasText !== false
  ) {
    return null;
  }

  const firstId = String(assistantFirst?.turn_id || "").trim();
  const secondId = String(assistantSecond?.turn_id || "").trim();
  const firstText = String(assistantFirst?.text || "");
  const secondText = String(assistantSecond?.text || "");
  if (!firstId || !secondId || firstId !== secondId || !firstText || !secondText) {
    return null;
  }
  if (composerInstructionDigest(firstText) !== composerInstructionDigest(secondText)) {
    return null;
  }

  const messageId = String(outbound.message_id || "").trim();
  if (assistantTurnConfirmsCycleDelivery(assistantSecond, messageId)) {
    return null;
  }

  let control = null;
  try {
    control = parseTaskControl(secondText);
  } catch {
    return null;
  }

  const sameTask = String(control?.task_id || "").trim() === expectedTaskId;
  const readyForSameTask = (
    String(control?.status || "").toUpperCase() === "READY" &&
    String(control?.next_task_id || "").trim() === expectedTaskId
  );
  const projectDone = String(control?.status || "").toUpperCase() === "DONE";
  if (!sameTask && !readyForSameTask && !projectDone) {
    return null;
  }

  return {
    assistant_turn: assistantSecond,
    task_control: control
  };
}

export function orphanedInFlightTaskRecoveryCandidate({
  state,
  firstSnapshot,
  secondSnapshot,
  matchingUser,
  assistantFirst,
  assistantSecond,
  nowMs = Date.now(),
  minimumAgeMs = 60_000
} = {}) {
  const outbound = state?.outbound || {};
  const kind = String(outbound.kind || "").toUpperCase();
  const outboundState = String(outbound.state || "").toUpperCase();
  const taskId = String(outbound.task_id || "").trim();
  const messageId = String(outbound.message_id || "").trim();

  if (
    !["TASK_EXECUTION", "TASK_STATUS_CHECK"].includes(kind) ||
    !["DELIVERED", "RESPONSE_RUNNING"].includes(outboundState) ||
    !taskId ||
    !messageId ||
    matchingUser?.confirmed === true
  ) {
    return null;
  }

  const staleFrom =
    outbound.response_running_at ||
    outbound.delivered_at ||
    outbound.enqueued_at ||
    outbound.prepared_at ||
    state?.updated_at ||
    null;
  const staleAt = Date.parse(String(staleFrom || ""));
  if (
    !Number.isFinite(staleAt) ||
    Number(nowMs) - staleAt < Math.max(0, Number(minimumAgeMs) || 0)
  ) {
    return null;
  }

  const idleSnapshot = (snapshot) => Boolean(
    snapshot &&
    snapshot.responseRunning === false &&
    snapshot.assistantBusy === false &&
    snapshot.hasContinueControl !== true &&
    snapshot.loginRequired !== true &&
    snapshot.hasCaptcha !== true &&
    snapshot.hasNetworkError !== true &&
    snapshot.hasTransientError !== true &&
    snapshot.conversationMissing !== true &&
    snapshot.conversationAccessDenied !== true &&
    snapshot.composerReady === true &&
    snapshot.composerTextReadable === true &&
    snapshot.composerHasText === false
  );

  if (!idleSnapshot(firstSnapshot) || !idleSnapshot(secondSnapshot)) {
    return null;
  }

  const firstId = String(assistantFirst?.turn_id || "").trim();
  const secondId = String(assistantSecond?.turn_id || "").trim();
  const firstText = String(assistantFirst?.text || "");
  const secondText = String(assistantSecond?.text || "");
  if (Boolean(firstId) !== Boolean(secondId)) return null;
  if (firstId && firstId !== secondId) return null;
  if (Boolean(firstText) !== Boolean(secondText)) return null;
  if (
    firstText &&
    composerInstructionDigest(firstText) !== composerInstructionDigest(secondText)
  ) {
    return null;
  }
  if (
    assistantTurnConfirmsCycleDelivery(assistantFirst, messageId) ||
    assistantTurnConfirmsCycleDelivery(assistantSecond, messageId)
  ) {
    return null;
  }

  return {
    task_id: taskId,
    kind,
    outbound_state: outboundState,
    message_id: messageId,
    stale_age_ms: Number(nowMs) - staleAt
  };
}

async function resumeEnqueuedTaskMessageAfterRebind({
  adapter,
  page,
  statePath,
  responseTimeoutMs,
  pollMs
} = {}) {
  const state = await readSingleConversationState(statePath);
  if (!canRebindEnqueuedTaskMessage(state)) return null;

  const kind = String(state.outbound.kind || "");
  const label = kind === "TASK_STATUS_CHECK" ? "STATUS_CHECK" : "TASK_EXECUTION";
  let message = reconstructPendingTaskMessage(state);
  let latestUser = null;

  if (!message) {
    latestUser = await boundedRuntimeStep(
      `RESTART_${label}_CAPTURE_USER`,
      () => captureLatestRoleTurn(page, "user"),
      { timeoutMs: 10_000 }
    ).catch((error) => {
      if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
      return null;
    });
    message = reconstructPendingTaskMessage(state, latestUser?.text);
  }

  if (!message) {
    const draft = await boundedRuntimeStep(
      `RESTART_${label}_CAPTURE_DRAFT`,
      () => inspectComposerDraftDigest(page, { timeoutMs: 1_500 }),
      { timeoutMs: 5_000 }
    ).catch((error) => {
      if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
      return null;
    });
    message = reconstructPendingTaskMessage(
      state,
      draft?.normalized_text
    );
  }

  if (!message) {
    throw Object.assign(
      new Error(`pending ${kind} has no exact restart evidence`),
      { code: "RUNTIME_RESTART_ENQUEUED_TASK_UNRESOLVED" }
    );
  }

  if (state.outbound.baseline_user_turn_id && !latestUser) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      latestUser = await boundedRuntimeStep(
        `RESTART_${label}_HYDRATE_USER`,
        () => captureLatestRoleTurn(page, "user"),
        { timeoutMs: 2_000 }
      ).catch((error) => {
        if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
        return null;
      });
      if (latestUser) break;
      await waitForNextCycleDelay(500);
    }
  }

  const messageId = String(state.outbound.message_id);

  // A correlated assistant response is positive proof that ChatGPT accepted
  // this exact Robot request. This is stronger than a failed/mutated user-turn
  // text match and must suppress resend during restart reconciliation.
  const correlatedAssistant = await boundedRuntimeStep(
    `RESTART_${label}_CAPTURE_ASSISTANT_CORRELATION`,
    () => captureAssistantCycleCorrelationEvidence(page, messageId),
    { timeoutMs: 10_000 }
  ).catch(() => null);

  if (
    correlatedAssistant?.confirmed === true &&
    assistantTurnConfirmsCycleDelivery(correlatedAssistant, messageId)
  ) {
    await markExactOnceDelivered(statePath, {
      messageId,
      message,
      userTurnId: null
    });
    await markCorrelatedInFlightTaskResponseVerified(statePath, {
      messageId,
      assistantTurnId: correlatedAssistant.turn_id || null
    });
    return {
      status: "RESPONSE_COMPLETE",
      assistant_turn: correlatedAssistant,
      continue_clicks: 0,
      saw_running: false,
      marker_confirmed: true,
      recovered_from_unique_assistant_cycle_correlation: true
    };
  }

  const delivery = await reconcileExactOnceOutbound({
    statePath,
    page,
    messageId,
    message,
    maxSafeRetries: 1,
    reconciliationProbes: 4,
    reconciliationPollMs: Math.min(500, Math.max(100, pollMs))
  });
  if (!["SEND", "SAFE_RETRY_SENT", "NO_SEND"].includes(delivery.action)) {
    throw Object.assign(
      new Error(`restart ${kind} reconciliation did not reach delivery evidence`),
      { code: "RUNTIME_RESTART_ENQUEUED_TASK_RECONCILE_FAILED" }
    );
  }

  return settleTransactionResponse({
    adapter,
    page,
    statePath,
    messageId,
    message,
    baselineAssistantTurnId: null,
    timeoutMs: responseTimeoutMs,
    pollMs: Math.min(750, Math.max(100, pollMs))
  });
}

async function resumeInFlightProtocolMessageAfterRebind({
  adapter,
  page,
  statePath,
  responseTimeoutMs,
  pollMs
} = {}) {
  const state = await readSingleConversationState(statePath);
  if (!canRebindInFlightProtocolMessage(state)) return null;

  const kind = String(state.outbound.kind || "");
  const messageId = String(state.outbound.message_id || "");

  if (
    ["TASK_EXECUTION", "TASK_STATUS_CHECK"].includes(kind) &&
    ["DELIVERED", "RESPONSE_RUNNING"].includes(
      String(state.outbound.state || "").toUpperCase()
    )
  ) {
    const correlatedAssistant = await boundedRuntimeStep(
      "RESTART_WAIT_RESPONSE_CAPTURE_ASSISTANT_CORRELATION",
      () => captureAssistantCycleCorrelationEvidence(page, messageId),
      { timeoutMs: 10_000 }
    ).catch(() => null);

    if (
      correlatedAssistant?.confirmed === true &&
      assistantTurnConfirmsCycleDelivery(correlatedAssistant, messageId)
    ) {
      await markCorrelatedInFlightTaskResponseVerified(statePath, {
        messageId,
        assistantTurnId: correlatedAssistant.turn_id || null
      });
      return {
        status: "RESPONSE_COMPLETE",
        assistant_turn: correlatedAssistant,
        continue_clicks: 0,
        saw_running: false,
        marker_confirmed: true,
        recovered_from_correlation_without_prompt_reconstruction: true
      };
    }
  }

  let message = reconstructPendingProtocolMessage(state);
  let latestUser = null;

  if (!message) {
    latestUser = await boundedRuntimeStep(
      "RESTART_WAIT_RESPONSE_CAPTURE_USER",
      () => captureLatestRoleTurn(page, "user"),
      { timeoutMs: 10_000 }
    ).catch((error) => {
      if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
      return null;
    });
    message = reconstructPendingProtocolMessage(state, latestUser?.text);
  }

  if (!message) {
    throw Object.assign(
      new Error(`pending ${kind} response has no exact restart reconstruction`),
      { code: "RUNTIME_RESTART_WAIT_RESPONSE_UNRESOLVED" }
    );
  }

  if (["TASK_EXECUTION", "TASK_STATUS_CHECK"].includes(kind)) {
    const matchingUser = await boundedRuntimeStep(
      "RESTART_WAIT_RESPONSE_EXACT_USER_CORRELATION",
      () => captureMatchingUserTurnEvidence(page, message),
      { timeoutMs: 10_000 }
    ).catch((error) => {
      if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
      return null;
    });

    const firstProbe = await boundedRuntimeStep(
      "RESTART_WAIT_RESPONSE_TERMINAL_PROBE_1",
      () => adapter.probePage(page),
      { timeoutMs: 10_000 }
    ).catch((error) => {
      if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
      return null;
    });
    const assistantFirst = await boundedRuntimeStep(
      "RESTART_WAIT_RESPONSE_TERMINAL_ASSISTANT_1",
      () => captureLatestRoleTurn(page, "assistant"),
      { timeoutMs: 10_000 }
    ).catch(() => null);

    if (
      matchingUser?.confirmed === true &&
      firstProbe?.snapshot &&
      assistantFirst?.turn_id
    ) {
      if (typeof page.waitForTimeout === "function") {
        await page.waitForTimeout(1_200);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      }

      const secondProbe = await boundedRuntimeStep(
        "RESTART_WAIT_RESPONSE_TERMINAL_PROBE_2",
        () => adapter.probePage(page),
        { timeoutMs: 10_000 }
      ).catch((error) => {
        if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
        return null;
      });
      const assistantSecond = await boundedRuntimeStep(
        "RESTART_WAIT_RESPONSE_TERMINAL_ASSISTANT_2",
        () => captureLatestRoleTurn(page, "assistant"),
        { timeoutMs: 10_000 }
      ).catch(() => null);

      const recovered = stableUnmarkedTaskResponseCandidate({
        state,
        snapshot: secondProbe?.snapshot || null,
        matchingUser,
        assistantFirst,
        assistantSecond
      });
      if (recovered) {
        await markCorrelatedInFlightTaskResponseVerified(statePath, {
          messageId,
          assistantTurnId: recovered.assistant_turn.turn_id || null
        });
        return {
          status: "RESPONSE_COMPLETE",
          assistant_turn: recovered.assistant_turn,
          continue_clicks: 0,
          saw_running: false,
          marker_confirmed: false,
          recovered_from_exact_user_stable_terminal_task_response: true
        };
      }
    }

    if (
      matchingUser?.confirmed !== true &&
      firstProbe?.snapshot
    ) {
      if (typeof page.waitForTimeout === "function") {
        await page.waitForTimeout(1_200);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      }

      const orphanSecondProbe = await boundedRuntimeStep(
        "RESTART_WAIT_RESPONSE_ORPHAN_PROBE_2",
        () => adapter.probePage(page),
        { timeoutMs: 10_000 }
      ).catch((error) => {
        if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
        return null;
      });
      const orphanAssistantSecond = await boundedRuntimeStep(
        "RESTART_WAIT_RESPONSE_ORPHAN_ASSISTANT_2",
        () => captureLatestRoleTurn(page, "assistant"),
        { timeoutMs: 10_000 }
      ).catch(() => null);

      const orphaned = orphanedInFlightTaskRecoveryCandidate({
        state,
        firstSnapshot: firstProbe.snapshot,
        secondSnapshot: orphanSecondProbe?.snapshot || null,
        matchingUser,
        assistantFirst,
        assistantSecond: orphanAssistantSecond
      });
      if (orphaned) {
        throw Object.assign(
          new Error(
            "in-flight task transaction is stale after restart while ChatGPT is stably idle"
          ),
          {
            code: "RUNTIME_RESTART_ORPHANED_IN_FLIGHT_TASK",
            task_id: orphaned.task_id,
            message_id: orphaned.message_id
          }
        );
      }
    }
  }

  if (
    kind === "SOURCE_OF_TRUTH_TASK_DISCOVERY" &&
    ["DELIVERED", "RESPONSE_RUNNING"].includes(
      String(state.outbound.state || "").toUpperCase()
    ) &&
    Number(state.outbound.retry_count || 0) === 0
  ) {
    if (!latestUser) {
      latestUser = await boundedRuntimeStep(
        "RESTART_FALSE_DELIVERY_CAPTURE_USER",
        () => captureLatestRoleTurn(page, "user"),
        { timeoutMs: 10_000 }
      ).catch((error) => {
        if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
        return null;
      });
    }

    const safeProbe = await boundedRuntimeStep(
      "RESTART_FALSE_DELIVERY_SAFE_PROBE",
      () => adapter.probePage(page),
      { timeoutMs: 10_000 }
    ).catch((error) => {
      if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
      return null;
    });
    const safeSnapshot = safeProbe?.snapshot || {};

    const rewound = safeFalseHistoricalDeliverySnapshot(safeSnapshot)
      ? await rewindFalseHistoricalDiscoveryDelivery(statePath, {
          messageId,
          message,
          latestUserTurnId: latestUser?.turn_id || null,
          composerReady: safeSnapshot.composerReady === true,
          composerReadable: safeSnapshot.composerTextReadable === true,
          composerHasText: safeSnapshot.composerHasText,
          responseRunning: Boolean(safeSnapshot.responseRunning)
        }).then(() => true).catch((error) => {
          if (error?.code === "FALSE_DELIVERY_REWIND_UNVERIFIED") return false;
          throw error;
        })
      : false;

    if (rewound) {
      return resumeEnqueuedTaskDiscoveryAfterRebind({
        adapter,
        page,
        statePath,
        responseTimeoutMs,
        pollMs
      });
    }
  }

  const expectedAssistantMarker =
    kind === "SOURCE_OF_TRUTH_BOOTSTRAP"
      ? `MAGASIN_BOOTSTRAP_CORRELATION_V1 ${messageId}`
      : `MAGASIN_CYCLE_CORRELATION_V1 ${messageId}`;

  // DELIVERED / RESPONSE_RUNNING already has durable positive send evidence.
  // Restart recovery must never actuate the composer again. Rebind the exact
  // conversation identity and only finish observing the existing response.
  return settleTransactionResponse({
    adapter,
    page,
    statePath,
    messageId,
    message,
    baselineAssistantTurnId: null,
    expectedAssistantMarker,
    timeoutMs: responseTimeoutMs,
    pollMs: Math.min(750, Math.max(100, pollMs))
  });
}

export async function probeReusableConversationPage(
  adapter,
  page,
  { maxAttempts = 2, timeoutMs = 12_000, retryDelayMs = 350 } = {}
) {
  if (!page || typeof adapter?.probePage !== "function") return null;

  // Exact opaque runtime identity was checked by the caller. A single DOM/CDP
  // probe can be inconclusive while ChatGPT hydrates under heavy system load.
  // Retry only that read-only probe: never send, rebind an unverified page,
  // clear ENQUEUED or transform inconclusive evidence into non-delivery proof.
  const attempts = Math.max(1, Math.min(2, Number(maxAttempts) || 1));
  const budget = Math.max(1, Math.min(12_000, Number(timeoutMs) || 12_000));
  const pause = Math.max(0, Math.min(1_000, Number(retryDelayMs) || 0));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = await boundedRuntimeStep(
      "RUNTIME_REBIND_REUSABLE_PAGE_PROBE",
      () => adapter.probePage(page),
      { timeoutMs: budget }
    ).catch(() => null);

    if (probe) {
      const snapshot = probe.snapshot || {};
      // A definite auth, identity, missing-page, or full-chat failure is
      // terminal for this rebind attempt; never retry it as "hydration".
      if (
        snapshot.loginRequired ||
        snapshot.hasCaptcha ||
        snapshot.conversationMissing ||
        snapshot.conversationAccessDenied ||
        snapshot.pageClosed ||
        classifyDisposableConversation(snapshot).action !== "KEEP_CHAT"
      ) {
        return null;
      }
      return probe;
    }

    if (attempt + 1 < attempts && pause > 0) {
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
  return null;
}

function runtimeIdMatchesPage(page, expected) {
  try {
    return opaqueRuntimeIdentity(page?.url?.()) === expected;
  } catch {
    return false;
  }
}

function isBlankHomePage(page) {
  try {
    const url = new URL(String(page?.url?.() || ""));
    return url.origin === "https://chatgpt.com" && url.pathname === "/";
  } catch {
    return false;
  }
}

async function recoverConversationFromRecentSidebar({
  adapter,
  expected,
  discoveryPage,
  retries = 60,
  pollMs = 500
} = {}) {
  if (
    !discoveryPage ||
    typeof adapter?.listRecentConversationUrls !== "function" ||
    typeof adapter?.reopenTargetPage !== "function"
  ) {
    return null;
  }

  for (let attempt = 0; attempt < Math.max(1, Number(retries) || 1); attempt += 1) {
    const urls = await boundedRuntimeStep(
      "RUNTIME_REBIND_RECENT_LIST",
      () => adapter.listRecentConversationUrls(discoveryPage, { limit: 50 }),
      { timeoutMs: 5_000 }
    ).catch(() => []);
    const matches = [...new Set(
      (Array.isArray(urls) ? urls : []).filter(
        (url) => opaqueRuntimeIdentity(url) === expected
      )
    )];

    if (matches.length > 1) return null;
    if (matches.length === 1) {
      const recovered = await adapter.reopenTargetPage(matches[0]).catch(() => null);
      if (!recovered || !runtimeIdMatchesPage(recovered, expected)) return null;
      return recovered;
    }

    if (attempt + 1 < Math.max(1, Number(retries) || 1)) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(50, Number(pollMs) || 500))
      );
    }
  }

  return null;
}

async function recoverConversationFromBrowserHistory({
  adapter,
  expected
} = {}) {
  if (
    typeof adapter?.listBrowserHistoryChatGptUrls !== "function" ||
    typeof adapter?.reopenTargetPage !== "function"
  ) {
    return null;
  }

  const urls = await boundedRuntimeStep(
    "RUNTIME_REBIND_HISTORY_LIST",
    () => adapter.listBrowserHistoryChatGptUrls({ limit: 200 }),
    { timeoutMs: 10_000 }
  ).catch(() => []);
  const matches = [...new Set(
    (Array.isArray(urls) ? urls : []).filter(
      (url) => opaqueRuntimeIdentity(url) === expected
    )
  )];

  if (matches.length !== 1) return null;
  const recovered = await adapter.reopenTargetPage(matches[0]).catch(() => null);
  if (!recovered || !runtimeIdMatchesPage(recovered, expected)) return null;
  return recovered;
}

export async function resumeExistingConversationPage({
  adapter,
  state,
  recoveryRetries = 60,
  recoveryPollMs = 500
} = {}) {
  if (!adapter || !state) return null;
  if (String(state?.conversation?.status || "").toUpperCase() !== "ACTIVE") {
    return null;
  }
  if (!safeRebindOutboundState(state)) return null;

  const expected = String(state?.conversation?.runtime_id || "").trim();
  if (!expected) return null;

  const pages = typeof adapter.getChatGptPages === "function"
    ? adapter.getChatGptPages()
    : [];
  const matches = pages.filter((candidate) =>
    runtimeIdMatchesPage(candidate, expected)
  );

  let page = null;
  let recoveredFrom = null;
  let discoveryPage = null;

  if (matches.length === 1) {
    page = matches[0];
    recoveredFrom = "OPEN_PAGE";
  } else if (matches.length > 1) {
    return null;
  } else {
    discoveryPage = typeof adapter.getActivePage === "function"
      ? adapter.getActivePage()
      : pages.at(-1) || null;
    page = await recoverConversationFromRecentSidebar({
      adapter,
      expected,
      discoveryPage,
      retries: recoveryRetries,
      pollMs: recoveryPollMs
    });
    if (page) {
      recoveredFrom = "RECENT_SIDEBAR";
    } else {
      page = await recoverConversationFromBrowserHistory({
        adapter,
        expected
      });
      if (!page) return null;
      recoveredFrom = "BROWSER_HISTORY";
    }
  }

  const selected = typeof adapter.setActivePage === "function"
    ? adapter.setActivePage(page)
    : page;
  if (!(await probeReusableConversationPage(adapter, selected))) return null;

  if (
    ["RECENT_SIDEBAR", "BROWSER_HISTORY"].includes(recoveredFrom) &&
    discoveryPage &&
    discoveryPage !== selected &&
    isBlankHomePage(discoveryPage) &&
    typeof adapter.closePage === "function"
  ) {
    await adapter.closePage(discoveryPage).catch(() => {});
  }

  return {
    page: selected,
    runtime_id: expected,
    generation: Number(state.conversation?.generation || 0),
    recovered_from: recoveredFrom
  };
}

async function captureProtocolBaselines(page) {
  const baselineUser = await boundedRuntimeStep(
    "TASK_CAPTURE_USER",
    () => captureLatestRoleTurn(page, "user"),
    { timeoutMs: 10_000 }
  ).catch((error) => {
    if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
    return null;
  });
  const baselineAssistant = await boundedRuntimeStep(
    "TASK_CAPTURE_ASSISTANT",
    () => captureLatestRoleTurn(page, "assistant"),
    { timeoutMs: 10_000 }
  ).catch((error) => {
    if (error?.code === "CDP_RECOVERY_REQUIRED") throw error;
    return null;
  });
  return { baselineUser, baselineAssistant };
}

async function sendProtocolMessage({
  adapter,
  page,
  statePath,
  message,
  messageId,
  kind,
  taskId = null,
  responseTimeoutMs,
  pollMs,
  initialRetryCount = 0
}) {
  const { baselineUser, baselineAssistant } =
    await captureProtocolBaselines(page);

  // SC-013: a post-bootstrap task cannot be safely replayed after restart
  // unless the prior user+assistant turns are known before PREPARED.
  // Fail closed before writing any outbound transaction or actuating the UI.
  if (
    ["TASK_EXECUTION", "TASK_STATUS_CHECK"].includes(kind) &&
    (!baselineUser?.turn_id || !baselineAssistant?.turn_id)
  ) {
    throw Object.assign(
      new Error("task baseline could not be verified before exact-once PREPARED"),
      { code: "TASK_BASELINE_UNVERIFIED" }
    );
  }

  await prepareExactOnceOutbound(statePath, {
    messageId,
    message,
    kind,
    taskId,
    baselineUserTurnId: baselineUser?.turn_id || null,
    initialRetryCount
  });

  // PREPARED is the only correct state before first reconciliation. The
  // reconciler persists ENQUEUED immediately before browser actuation, which
  // preserves exact-once crash safety without making a fresh transaction look
  // like an ambiguous prior send. If submit was actuated but the rendered user
  // turn lags, stay in the same process and wait for the exact correlated
  // response; never convert that short UI evidence gap into an Owner START.
  const delivery = await reconcileExactOnceOutbound({
    statePath,
    page,
    messageId,
    message,
    maxSafeRetries: 1,
    reconciliationProbes: 4,
    reconciliationPollMs: Math.min(500, Math.max(100, pollMs)),
    allowPendingPostSendConfirmation: true
  });
  if (!["SEND", "SEND_PENDING_CONFIRMATION", "SAFE_RETRY_SENT", "NO_SEND"].includes(delivery.action)) {
    throw new Error("single-conversation transaction did not reach delivery evidence");
  }

  return settleTransactionResponse({
    adapter,
    page,
    statePath,
    messageId,
    message,
    baselineAssistantTurnId: baselineAssistant?.turn_id || null,
    timeoutMs: responseTimeoutMs,
    pollMs: Math.min(750, Math.max(100, pollMs))
  });
}

async function recoverConversationFullTaskByCheck({
  adapter,
  page,
  statePath,
  sourceOfTruthUrl,
  taskId,
  qualificationOnly = false,
  responseTimeoutMs,
  pollMs
} = {}) {
  const task = String(taskId || "").trim();
  if (!task) {
    throw Object.assign(
      new Error("conversation-full task recovery requires task id"),
      { code: "CONVERSATION_FULL_RECOVERY_TASK_ID_MISSING" }
    );
  }

  const replacement = await replaceDisposableConversation({
    adapter,
    page,
    statePath,
    reason: "CONVERSATION_FULL_IN_FLIGHT",
    sourceOfTruthUrl,
    projectId: "LIVE",
    qualificationOnly,
    timeoutMs: responseTimeoutMs,
    pollMs: Math.min(750, Math.max(100, pollMs))
  });

  const checkMessageId = randomUUID();
  const checkMessage = buildSingleConversationTaskInstruction({
    sourceOfTruthUrl,
    taskId: task,
    messageId: checkMessageId,
    checkOnly: true
  });
  const response = await sendProtocolMessage({
    adapter,
    page: replacement.page,
    statePath,
    message: checkMessage,
    messageId: checkMessageId,
    kind: "TASK_STATUS_CHECK",
    taskId: task,
    responseTimeoutMs,
    pollMs
  });

  return {
    page: replacement.page,
    response,
    source_kind: "TASK_STATUS_CHECK",
    task_id: task,
    replacement
  };
}

async function recoverOrphanedInFlightTaskByCheck({
  adapter,
  page,
  statePath,
  sourceOfTruthUrl,
  taskId,
  qualificationOnly = false,
  responseTimeoutMs,
  pollMs
} = {}) {
  const task = String(taskId || "").trim();
  if (!task) {
    throw Object.assign(
      new Error("orphaned in-flight task recovery requires task id"),
      { code: "ORPHANED_IN_FLIGHT_RECOVERY_TASK_ID_MISSING" }
    );
  }

  const replacement = await replaceDisposableConversation({
    adapter,
    page,
    statePath,
    reason: "RUNTIME_RESTART_ORPHANED_IN_FLIGHT_TASK",
    sourceOfTruthUrl,
    projectId: "LIVE",
    qualificationOnly,
    timeoutMs: responseTimeoutMs,
    pollMs: Math.min(750, Math.max(100, pollMs))
  });

  const checkMessageId = randomUUID();
  const checkMessage = buildSingleConversationTaskInstruction({
    sourceOfTruthUrl,
    taskId: task,
    messageId: checkMessageId,
    checkOnly: true
  });
  const response = await sendProtocolMessage({
    adapter,
    page: replacement.page,
    statePath,
    message: checkMessage,
    messageId: checkMessageId,
    kind: "TASK_STATUS_CHECK",
    taskId: task,
    responseTimeoutMs,
    pollMs
  });

  return {
    page: replacement.page,
    response,
    source_kind: "TASK_STATUS_CHECK",
    task_id: task,
    replacement
  };
}

async function discoverTaskControl({
  adapter,
  page,
  statePath,
  sourceOfTruthUrl,
  responseTimeoutMs,
  pollMs
}) {
  const messageId = randomUUID();
  const message = buildSingleConversationTaskDiscoveryInstruction({
    sourceOfTruthUrl,
    messageId
  });
  try {
    const response = await sendProtocolMessage({
      adapter,
      page,
      statePath,
      message,
      messageId,
      kind: "SOURCE_OF_TRUTH_TASK_DISCOVERY",
      responseTimeoutMs,
      pollMs
    });
    return parseTaskControl(response.assistant_turn?.text);
  } catch (error) {
    if (String(error?.code || "").toUpperCase() !== "CONVERSATION_FULL") {
      throw error;
    }

    // Discovery is read-only project work. If the chat fills before the
    // assistant can return a complete task-control block, abandon only that
    // disposable chat, bootstrap a fresh generation from the same SOT, and
    // use the bootstrap task-control result. Never stop for Owner input.
    const replacement = await replaceDisposableConversation({
      adapter,
      page,
      statePath,
      reason: "CONVERSATION_FULL_READ_ONLY_DISCOVERY",
      sourceOfTruthUrl,
      projectId: "LIVE",
      qualificationOnly: false,
      timeoutMs: responseTimeoutMs,
      pollMs: Math.min(750, Math.max(100, pollMs))
    });
    return parseTaskControl(replacement.response?.assistant_turn?.text);
  }
}

export async function runSingleConversationRuntime({
  adapter,
  statePath,
  sourceOfTruthUrl,
  execute = false,
  qualificationOnly = false,
  pollMs = 2_000,
  responseTimeoutMs = 5_400_000,
  maxCycles = 0
} = {}) {
  if (!adapter) throw new Error("adapter is required");
  if (!statePath) throw new Error("statePath is required");
  if (!sourceOfTruthUrl) throw new Error("sourceOfTruthUrl is required");

  const state = await ensureSingleConversationState(statePath, {
    sourceOfTruthUrl,
    projectId: "LIVE"
  });
  if (!execute) {
    return {
      status: "READY",
      mode: state.mode,
      chat_url_required: false
    };
  }

  await persistRuntimeStartupState(statePath, {
    status: "RUNNING",
    phase: "STARTING_BROWSER",
    reason: null,
    errorCode: null,
    errorStage: null
  });

  try {
    await boundedRuntimeStep(
      "RUNTIME_OPEN_CDP",
      () => adapter.open(),
      { timeoutMs: 20_000 }
    );
  } catch (error) {
    const message = String(error?.message || error || "");
    const cdpRecoverable = Boolean(
      String(error?.code || "").toUpperCase() === "CDP_RECOVERY_REQUIRED" ||
      isTransientNavigationError(error) ||
      /real Chrome CDP connection has no browser context|real Chrome CDP connection has no open page/i.test(message)
    );
    const code = cdpRecoverable
      ? "CDP_RECOVERY_REQUIRED"
      : runtimeStartupErrorCode(error);
    await persistRuntimeStartupState(statePath, {
      status: cdpRecoverable ? "RUNNING" : "BLOCKED",
      phase: cdpRecoverable ? "CDP_RECOVERY_REQUIRED" : "BOOTSTRAP_FAILED",
      reason: code,
      errorCode: code,
      errorStage: "RUNTIME_OPEN_CDP"
    }).catch(() => {});
    if (cdpRecoverable) {
      throw Object.assign(
        new Error(message || "CDP startup recovery required"),
        { code, runtime_stage: "RUNTIME_OPEN_CDP", cause: error }
      );
    }
    throw Object.assign(error instanceof Error ? error : new Error(message), {
      runtime_stage: "RUNTIME_OPEN_CDP"
    });
  }

  let page = adapter.getActivePage();
  let current = await readSingleConversationState(statePath);
  let bootstrapResponse = null;

  if (current.conversation.status !== "ACTIVE") {
    const bootstrap = await createInitialBootstrapWithRecovery({
      adapter,
      statePath,
      sourceOfTruthUrl,
      qualificationOnly,
      responseTimeoutMs,
      pollMs
    });
    page = bootstrap.page;
    bootstrapResponse = bootstrap.response;
  } else {
    const pendingPreActuation = canResumePreActuationDiscovery(current)
      ? {
          message_id: String(current.outbound.message_id),
          message_digest: String(current.outbound.message_digest),
          retry_count: Number(current.outbound.retry_count || 0)
        }
      : null;
    const lostBootstrapRecoveryReason = bootstrapRecoveryReasonForState(current);

    const rebound = await resumeExistingConversationPage({
      adapter,
      state: current
    });
    // A previously active conversation may now be full. Do not rebind it
    // merely because its URL still matches the persisted runtime identity.
    const restartProbe = rebound?.page ? null : await (async () => {
      const oldPage = adapter.getChatGptPages?.().find((candidate) =>
        runtimeIdMatchesPage(candidate, current.conversation.runtime_id)
      );
      if (!oldPage) return null;
      const probe = await boundedRuntimeStep(
        "RUNTIME_RESTART_OLD_PAGE_PROBE",
        () => adapter.probePage(oldPage),
        { timeoutMs: 10_000 }
      ).catch(() => null);
      return {
        page: oldPage,
        classification: probe
          ? classifyDisposableConversation(probe.snapshot || {})
          : null
      };
    })();
    const correlatedBootstrapRecovery =
      !rebound?.page &&
      canRecoverCorrelatedPreparedBootstrapDelivery(current)
        ? await recoverCorrelatedPreparedBootstrapDelivery({
            adapter,
            statePath,
            sourceOfTruthUrl,
            qualificationOnly,
            timeoutMs: responseTimeoutMs,
            pollMs: Math.min(750, Math.max(100, pollMs))
          })
        : null;

    if (correlatedBootstrapRecovery?.recovered) {
      page = correlatedBootstrapRecovery.page;
      bootstrapResponse = correlatedBootstrapRecovery.response;
      current = await readSingleConversationState(statePath);
    } else if (rebound?.page) {
      page = rebound.page;
      if (canRebindPreparedProtocolMessage(current)) {
        bootstrapResponse = await resumePreparedProtocolMessageAfterRebind({
          adapter,
          page,
          statePath,
          responseTimeoutMs,
          pollMs
        });
        current = await readSingleConversationState(statePath);
      } else if (canRebindInFlightProtocolMessage(current)) {
        try {
          bootstrapResponse = await resumeInFlightProtocolMessageAfterRebind({
            adapter,
            page,
            statePath,
            responseTimeoutMs,
            pollMs
          });
        } catch (error) {
          if (
            String(error?.code || "").toUpperCase() ===
            "RUNTIME_RESTART_ORPHANED_IN_FLIGHT_TASK"
          ) {
            const taskId = String(
              error?.task_id ||
              current.outbound?.task_id ||
              ""
            ).trim();
            const recovered = await recoverOrphanedInFlightTaskByCheck({
              adapter,
              page,
              statePath,
              sourceOfTruthUrl,
              taskId,
              qualificationOnly,
              responseTimeoutMs,
              pollMs
            });
            page = recovered.page;
            bootstrapResponse = recovered.response;
          } else {
            const replacementReason = replacementReasonForResponseWaitError(error);
            if (!replacementReason) throw error;

            // The user turn is already durably delivered, so never actuate the
            // old task again. Repeated response-surface failure retires only the
            // disposable chat, records the prior outbound transaction as recovery
            // evidence, then bootstraps a fresh generation from authoritative SOT.
            const replacement = await replaceDisposableConversation({
              adapter,
              page,
              statePath,
              reason: replacementReason,
              sourceOfTruthUrl,
              projectId: "LIVE",
              qualificationOnly,
              timeoutMs: responseTimeoutMs,
              pollMs: Math.min(750, Math.max(100, pollMs))
            });
            page = replacement.page;
            bootstrapResponse = replacement.response;
          }
        }
        current = await readSingleConversationState(statePath);
      } else if (canRebindEnqueuedTaskDiscovery(current)) {
        bootstrapResponse = await resumeEnqueuedTaskDiscoveryAfterRebind({
          adapter,
          page,
          statePath,
          responseTimeoutMs,
          pollMs
        });
        current = await readSingleConversationState(statePath);
      } else if (canRebindEnqueuedTaskMessage(current)) {
        bootstrapResponse = await resumeEnqueuedTaskMessageAfterRebind({
          adapter,
          page,
          statePath,
          responseTimeoutMs,
          pollMs
        });
        current = await readSingleConversationState(statePath);
      }
    } else if (canRecoverPreparedBootstrapNonDelivery(current)) {
      // SC-013 production incident: the prior bootstrap submit returned
      // SEND_NOT_ACTUATED and durable state never advanced beyond PREPARED.
      // Retry exactly once only after fresh read-only evidence proves the
      // current ChatGPT surface is still a blank home page with zero turns and
      // an empty composer. This is positive non-delivery evidence, not an
      // ambiguous resend authorization.
      const retryMessageId = String(current.outbound.message_id || "").trim();
      const retryMessage = buildSingleConversationBootstrap({
        sourceOfTruthUrl,
        messageId: retryMessageId,
        qualificationOnly
      });
      if (
        composerInstructionDigest(retryMessage) !==
        String(current.outbound.message_digest || "")
      ) {
        throw Object.assign(
          new Error("prepared bootstrap reconstruction digest mismatch"),
          { code: "OUTBOUND_DIGEST_MISMATCH" }
        );
      }
      if (!preparedBootstrapIsStaleEnough(current)) {
        throw Object.assign(
          new Error("prepared bootstrap is not old enough for bounded non-delivery recovery"),
          { code: "RUNTIME_RESTART_BOOTSTRAP_NON_DELIVERY_UNVERIFIED" }
        );
      }

      const candidatePage =
        adapter.getActivePage?.() ||
        adapter.getChatGptPages?.().find((candidate) => isBlankHomePage(candidate)) ||
        null;
      const verifiedNonDeliveryPage =
        await waitForPositiveBlankBootstrapNonDelivery(
          adapter,
          candidatePage,
          {
            timeoutMs: 90_000,
            pollMs: 750,
            stablePasses: 2,
            expectedInstruction: retryMessage
          }
        );
      if (!verifiedNonDeliveryPage) {
        throw Object.assign(
          new Error("prepared bootstrap non-delivery could not be positively verified"),
          { code: "RUNTIME_RESTART_BOOTSTRAP_NON_DELIVERY_UNVERIFIED" }
        );
      }

      const replacement = await replaceDisposableConversation({
        adapter,
        page: verifiedNonDeliveryPage,
        statePath,
        reason: "BOOTSTRAP_POSITIVE_NON_DELIVERY_RETRY",
        sourceOfTruthUrl,
        projectId: "LIVE",
        messageId: retryMessageId,
        initialRetryCount: Number(current.outbound.retry_count || 0) + 1,
        qualificationOnly,
        timeoutMs: responseTimeoutMs,
        pollMs: Math.min(750, Math.max(100, pollMs))
      });
      page = replacement.page;
      bootstrapResponse = replacement.response;
      current = await readSingleConversationState(statePath);
    } else if (lostBootstrapRecoveryReason) {
      // Production SC-013 incident: ChatGPT replaced/errored the disposable
      // bootstrap surface after delivery, so the persisted runtime identity no
      // longer exists. Bootstrap has no project side effects; retire only that
      // disposable chat and rehydrate from SOT instead of converting this into
      // an Owner BLOCKED/STOP state.
      const replacement = await replaceDisposableConversation({
        adapter,
        page: restartProbe?.page || recoverableBootstrapPage(adapter, current),
        statePath,
        reason: lostBootstrapRecoveryReason,
        sourceOfTruthUrl,
        projectId: "LIVE",
        qualificationOnly,
        timeoutMs: responseTimeoutMs,
        pollMs: Math.min(750, Math.max(100, pollMs))
      });
      page = replacement.page;
      bootstrapResponse = replacement.response;
      current = await readSingleConversationState(statePath);
    } else if (canReplaceLostReadOnlyDiscovery(current)) {
      // If a read-only discovery transaction was already sent but the
      // conversation identity can no longer be rebound (for example after a
      // full-chat surface disappears), there is no project-side-effect risk in
      // retiring that disposable chat. Bootstrap a fresh generation from SOT;
      // do not fail closed on the lost historical chat.
      const replacement = await replaceDisposableConversation({
        adapter,
        page: restartProbe?.page || recoverableBootstrapPage(adapter, current),
        statePath,
        reason: "READ_ONLY_DISCOVERY_IDENTITY_LOST",
        sourceOfTruthUrl,
        projectId: "LIVE",
        qualificationOnly,
        timeoutMs: responseTimeoutMs,
        pollMs: Math.min(750, Math.max(100, pollMs))
      });
      page = replacement.page;
      bootstrapResponse = replacement.response;
      current = await readSingleConversationState(statePath);
    } else if (recoverableConversationFullTask(current)) {
      // The old conversation filled while a task request was already in-flight.
      // Never replay that TASK_EXECUTION. Retire only the full disposable chat,
      // bootstrap a fresh generation from SOT, then CHECK the same authoritative
      // task so partial/complete side effects are reconciled from durable evidence.
      const interrupted = recoverableConversationFullTask(current);
      const recovered = await recoverConversationFullTaskByCheck({
        adapter,
        page:
          restartProbe?.page ||
          recoverableBootstrapPage(adapter, current),
        statePath,
        sourceOfTruthUrl,
        taskId: interrupted.task_id,
        qualificationOnly,
        responseTimeoutMs,
        pollMs
      });
      page = recovered.page;
      bootstrapResponse = recovered.response;
      current = await readSingleConversationState(statePath);
    } else if (
      restartProbe?.classification?.reason === "CONVERSATION_FULL" &&
      ["RESPONSE_COMPLETE", "VERIFIED"].includes(String(current.outbound?.state || "").toUpperCase())
    ) {
      // Only settled outbound work can roll over automatically. In-flight
      // delivery remains fail-closed until its exact-once outcome is known.
      const replacement = await replaceDisposableConversation({
        adapter,
        page: restartProbe.page,
        statePath,
        reason: "CONVERSATION_FULL",
        sourceOfTruthUrl,
        projectId: "LIVE",
        qualificationOnly,
        timeoutMs: responseTimeoutMs,
        pollMs: Math.min(750, Math.max(100, pollMs))
      });
      page = replacement.page;
      bootstrapResponse = replacement.response;
      current = await readSingleConversationState(statePath);
    } else if (canReplaceLostSettledConversation(current)) {
      // A fully settled outbound transaction has no replay risk. If restart
      // identity recovery cannot produce one reusable conversation page within
      // bounded read-only probes, retire only that disposable chat and
      // bootstrap a fresh generation from SOT instead of remaining forever in
      // STARTING_BROWSER.
      const replacement = await replaceDisposableConversation({
        adapter,
        page: restartProbe?.page || recoverableBootstrapPage(adapter, current),
        statePath,
        reason: "SETTLED_CONVERSATION_IDENTITY_LOST",
        sourceOfTruthUrl,
        projectId: "LIVE",
        qualificationOnly,
        timeoutMs: responseTimeoutMs,
        pollMs: Math.min(750, Math.max(100, pollMs))
      });
      page = replacement.page;
      bootstrapResponse = replacement.response;
      current = await readSingleConversationState(statePath);
    } else if (pendingPreActuation) {
      // SC-013: the old chat identity is no longer verifiable, but durable
      // evidence proves this one task-discovery send failed before submit.
      // Bootstrap a disposable replacement from SOT, then replay exactly the
      // same pending discovery correlation once. Never weaken identity checks.
      const pendingMessage = buildSingleConversationTaskDiscoveryInstruction({
        sourceOfTruthUrl,
        messageId: pendingPreActuation.message_id
      });
      if (
        composerInstructionDigest(pendingMessage) !==
        pendingPreActuation.message_digest
      ) {
        throw Object.assign(
          new Error("pre-actuation discovery reconstruction digest mismatch"),
          { code: "OUTBOUND_DIGEST_MISMATCH" }
        );
      }

      const replacement = await replaceDisposableConversation({
        adapter,
        page,
        statePath,
        reason: "RUNTIME_RESTART_IDENTITY_NOT_VERIFIED_PRE_ACTUATION",
        sourceOfTruthUrl,
        projectId: "LIVE",
        qualificationOnly,
        timeoutMs: responseTimeoutMs,
        pollMs: Math.min(750, Math.max(100, pollMs))
      });
      page = replacement.page;

      bootstrapResponse = await sendProtocolMessage({
        adapter,
        page,
        statePath,
        message: pendingMessage,
        messageId: pendingPreActuation.message_id,
        kind: "SOURCE_OF_TRUTH_TASK_DISCOVERY",
        responseTimeoutMs,
        pollMs,
        initialRetryCount: pendingPreActuation.retry_count + 1
      });
      current = await readSingleConversationState(statePath);
    } else {
      // Restart continuity remains fail closed for every case without positive
      // pre-actuation non-delivery evidence.
      throw Object.assign(
        new Error("active conversation identity could not be verified after runtime restart"),
        { code: "RUNTIME_RESTART_IDENTITY_NOT_VERIFIED" }
      );
    }
  }

  // SC-013: a restart may resume exactly one proven pre-actuation discovery
  // transaction. The durable COMPOSER_NOT_READY evidence means no submit was
  // actuated, so exact-once reconciliation may safely perform its one retry.
  current = await readSingleConversationState(statePath);
  if (canResumePreActuationDiscovery(current)) {
    const pendingMessageId = String(current.outbound.message_id);
    const pendingMessage = buildSingleConversationTaskDiscoveryInstruction({
      sourceOfTruthUrl,
      messageId: pendingMessageId
    });
    bootstrapResponse = await sendProtocolMessage({
      adapter,
      page,
      statePath,
      message: pendingMessage,
      messageId: pendingMessageId,
      kind: "SOURCE_OF_TRUTH_TASK_DISCOVERY",
      responseTimeoutMs,
      pollMs
    });
    current = await readSingleConversationState(statePath);
  }

  let cycles = 0;

  if (qualificationOnly) {
    while (maxCycles <= 0 || cycles < maxCycles) {
      const recovery = await boundedRuntimeStep(
        "NEXT_WORK_RECOVERY_PROBE",
        () => recoverDisposableConversationIfNeeded({
          adapter,
          page,
          statePath,
          sourceOfTruthUrl,
          projectId: "LIVE",
          qualificationOnly: true,
          timeoutMs: responseTimeoutMs,
          pollMs: Math.min(750, Math.max(100, pollMs))
        }),
        { timeoutMs: 15_000 }
      );
      page = recovery.page;

      const before = await readSingleConversationState(statePath);
      const messageId = randomUUID();
      const message = buildSingleConversationNextInstruction({
        sourceOfTruthUrl: before.source_of_truth.url,
        messageId,
        qualificationOnly: true
      });
      await sendProtocolMessage({
        adapter,
        page,
        statePath,
        message,
        messageId,
        kind: "SOURCE_OF_TRUTH_NEXT_WORK",
        responseTimeoutMs,
        pollMs
      });
      cycles += 1;
      await waitForNextCycleDelay(pollMs);
    }

    const finalState = await readSingleConversationState(statePath);
    return {
      status: "MAX_CYCLES",
      cycles,
      generation: finalState.conversation.generation
    };
  }

  let control = null;
  if (bootstrapResponse?.assistant_turn?.text) {
    try {
      const settled = await readSingleConversationState(statePath);
      control = await parseTaskResponseControl({
        statePath,
        text: bootstrapResponse.assistant_turn.text,
        expectedTaskId: settled.outbound?.task_id || null,
        sourceKind: settled.outbound?.kind || null
      });
    } catch (error) {
      if (error?.code !== "TASK_PROTOCOL_INVALID") throw error;
      // A completed bootstrap is not a terminal Owner pause merely because
      // ChatGPT omitted or malformed the machine task-control block. The
      // bootstrap itself performs no project work, so safely re-read SOT in
      // the same fresh conversation and ask only for authoritative task control.
      control = await discoverTaskControl({
        adapter,
        page,
        statePath,
        sourceOfTruthUrl,
        responseTimeoutMs,
        pollMs
      });
      cycles += 1;
    }
  } else {
    const latestAssistant = await captureLatestRoleTurn(page, "assistant")
      .catch(() => null);
    try {
      const settled = await readSingleConversationState(statePath);
      control = await parseTaskResponseControl({
        statePath,
        text: latestAssistant?.text,
        expectedTaskId: settled.outbound?.task_id || null,
        sourceKind: settled.outbound?.kind || null
      });
    } catch (error) {
      if (error?.code !== "TASK_PROTOCOL_INVALID") throw error;
      control = await discoverTaskControl({
        adapter,
        page,
        statePath,
        sourceOfTruthUrl,
        responseTimeoutMs,
        pollMs
      });
      cycles += 1;
    }
  }

  while (maxCycles <= 0 || cycles < maxCycles) {
    if (control.status === "DONE") {
      const terminalState = await persistTerminalTaskControl(statePath, control);
      return {
        status: "DONE",
        cycles,
        generation: terminalState.conversation.generation
      };
    }
    if (control.status === "BLOCKED") {
      const terminalState = await persistTerminalTaskControl(statePath, control);
      return {
        status: "WAIT_OWNER",
        cycles,
        generation: terminalState.conversation.generation
      };
    }

    const recovery = await boundedRuntimeStep(
      "TASK_RECOVERY_PROBE",
      () => recoverDisposableConversationIfNeeded({
        adapter,
        page,
        statePath,
        sourceOfTruthUrl,
        projectId: "LIVE",
        qualificationOnly: false,
        timeoutMs: responseTimeoutMs,
        pollMs: Math.min(750, Math.max(100, pollMs))
      }),
      { timeoutMs: 15_000 }
    );
    page = recovery.page;
    if (recovery.recovered) {
      const recoveredState = await readSingleConversationState(statePath);
      control = await parseTaskResponseControl({
        statePath,
        text: recovery.result?.response?.assistant_turn?.text,
        expectedTaskId: recoveredState.outbound?.task_id || null,
        sourceKind: recoveredState.outbound?.kind || null
      });
      continue;
    }

    const checkOnly = control.status === "RUNNING";
    const taskId = checkOnly
      ? control.task_id
      : control.next_task_id;
    if (!taskId) {
      throw Object.assign(
        new Error("task protocol did not provide an executable task id"),
        { code: "TASK_PROTOCOL_INVALID" }
      );
    }

    if (checkOnly) {
      await persistTaskRecheckWait(statePath, {
        taskId,
        seconds: control.check_after_seconds
      });
      const observedWait = await waitForTaskRecheckDelay({
        adapter,
        page,
        statePath,
        sourceOfTruthUrl,
        taskId,
        seconds: control.check_after_seconds,
        qualificationOnly,
        responseTimeoutMs,
        pollMs
      });
      page = observedWait.page;
      await clearTaskRecheckWait(statePath);
    }

    await persistTaskExecutionOptimizationIntent(statePath, {
      taskId,
      checkOnly
    });

    const messageId = randomUUID();
    const message = buildSingleConversationTaskInstruction({
      sourceOfTruthUrl,
      taskId,
      messageId,
      checkOnly
    });
    let response = null;
    let responseSourceKind = checkOnly ? "TASK_STATUS_CHECK" : "TASK_EXECUTION";
    try {
      response = await sendProtocolMessage({
        adapter,
        page,
        statePath,
        message,
        messageId,
        kind: responseSourceKind,
        taskId,
        responseTimeoutMs,
        pollMs
      });
    } catch (error) {
      if (String(error?.code || "").toUpperCase() !== "CONVERSATION_FULL") {
        throw error;
      }
      const interruptedState = await readSingleConversationState(statePath);
      const interrupted = recoverableConversationFullTask(interruptedState);
      if (!interrupted || interrupted.task_id !== taskId) {
        throw error;
      }

      const recovered = await recoverConversationFullTaskByCheck({
        adapter,
        page,
        statePath,
        sourceOfTruthUrl,
        taskId,
        qualificationOnly,
        responseTimeoutMs,
        pollMs
      });
      page = recovered.page;
      response = recovered.response;
      responseSourceKind = recovered.source_kind;
    }
    cycles += 1;
    try {
      control = await parseTaskResponseControl({
        statePath,
        text: response.assistant_turn?.text,
        expectedTaskId: taskId,
        sourceKind: responseSourceKind
      });
    } catch (error) {
      if (error?.code !== "TASK_PROTOCOL_INVALID") throw error;
      // SC-013: the task side effect is already exact-once VERIFIED at this
      // boundary. A malformed/missing task-control block must not terminate
      // autonomy or close the dedicated Chrome. Re-read authoritative SOT in
      // the same conversation and ask only for the next task-control decision.
      control = await discoverTaskControl({
        adapter,
        page,
        statePath,
        sourceOfTruthUrl,
        responseTimeoutMs,
        pollMs
      });
      cycles += 1;
    }

    if (!checkOnly) {
      await waitForNextCycleDelay(pollMs);
    }
  }

  const finalState = await readSingleConversationState(statePath);
  return {
    status: "MAX_CYCLES",
    cycles,
    generation: finalState.conversation.generation
  };
}

const isMain =
  process.argv[1] &&
  import.meta.url === new URL("file://" + path.resolve(process.argv[1]).replace(/\\/g, "/")).href;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.statePath) throw new Error("--state is required");
  if (!args.sourceOfTruthUrl) throw new Error("--source-of-truth is required");
  if (!args.cdpUrl) throw new Error("--cdp-url is required");

  const adapter = new ChatGptUiAdapter({
    cdpUrl: args.cdpUrl,
    settleMs: 400,
    actionTimeoutMs: 10_000,
    timeoutMs: 45_000
  });

  let finalExitCode = 0;
  try {
    const result = await runSingleConversationRuntime({
      adapter,
      statePath: path.resolve(args.statePath),
      sourceOfTruthUrl: args.sourceOfTruthUrl,
      execute: args.execute,
      qualificationOnly: args.qualificationOnly,
      pollMs: args.pollMs,
      responseTimeoutMs: args.responseTimeoutMs,
      maxCycles: args.maxCycles
    });
    console.log("SINGLE_CONVERSATION_RUNTIME_STATUS=" + result.status);
    console.log("SINGLE_CONVERSATION_CHAT_URL_REQUIRED=False");
    if (result.generation !== undefined) {
      console.log("SINGLE_CONVERSATION_GENERATION=" + result.generation);
    }
    if (["DONE", "WAIT_OWNER"].includes(result.status)) {
      finalExitCode = 76;
    }
  } catch (error) {
    const code = String(error?.code || "");
    const stage = String(error?.runtime_stage || "");
    console.error("SINGLE_CONVERSATION_RUNTIME_ERROR=" + (code || error?.name || "Error"));
    const safeMessage = String(error?.message || error || "")
      .replace(/[\r\n]+/g, " ")
      .slice(0, 500);
    if (safeMessage) {
      console.error("SINGLE_CONVERSATION_RUNTIME_ERROR_MESSAGE=" + safeMessage);
    }
    if (code === "TASK_PROTOCOL_INVALID") {
      console.error(
        "SINGLE_CONVERSATION_TASK_PROTOCOL_REASON=" +
        taskProtocolSubreason(error)
      );
    }
    if (stage) {
      console.error("SINGLE_CONVERSATION_RUNTIME_ERROR_STAGE=" + stage);
    }
    finalExitCode =
      code === "CDP_RECOVERY_REQUIRED"
        ? 75
        : code === "TASK_PROTOCOL_INVALID"
          ? 76
          : 1;
  } finally {
    await boundedRuntimeCleanup(() => adapter.close(), 1_500);
  }
  process.exit(finalExitCode);
}