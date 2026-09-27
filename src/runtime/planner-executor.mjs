import fs from "node:fs/promises";
import { atomicJsonWrite } from "./atomic-json-write.mjs";

import {
  composerInstructionDigest,
  inspectComposerDraftDigest,
  sendComposerInstruction
} from "../ui/actions.mjs";
import { captureLatestRoleTurn } from "../ui/latest-turn.mjs";
import {
  assertMachineFrameAction,
  assertMachineFrameCorrelation,
  parseMachineFrame
} from "./machine-frame.mjs";

export { parseMachineFrame } from "./machine-frame.mjs";

export const PLANNER_EXECUTOR_MODE = "PLANNER_EXECUTOR_V1";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

function requireId(value, label) {
  const id = String(value || "").trim();
  if (!ID_RE.test(id)) throw new Error(`invalid ${label}`);
  return id;
}

export function defaultPlannerExecutorState({
  projectId,
  plannerTarget = "",
  executorTarget = ""
} = {}) {
  const project = requireId(projectId || "project", "project_id");
  return {
    schema_version: "planner-executor-state.v1",
    mode: PLANNER_EXECUTOR_MODE,
    project_id: project,
    planner: {
      target: String(plannerTarget || "").trim(),
      target_revision: plannerTarget ? 1 : 0,
      last_seen_assistant_turn_id: null
    },
    executor: {
      target: String(executorTarget || "").trim(),
      target_revision: executorTarget ? 1 : 0,
      last_seen_assistant_turn_id: null
    },
    active_task_id: null,
    assignment: null,
    result: null,
    decision: null,
    last_completed: null
  };
}

export async function readPlannerExecutorState(
  statePath,
  defaults
) {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (
      parsed?.schema_version !== "planner-executor-state.v1" ||
      parsed?.mode !== PLANNER_EXECUTOR_MODE
    ) {
      throw new Error("unsupported Planner/Executor state");
    }
    return parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const state = defaultPlannerExecutorState(defaults);
    await writePlannerExecutorState(statePath, state);
    return state;
  }
}

export async function writePlannerExecutorState(statePath, state) {
  if (!statePath) throw new Error("statePath is required");
  await atomicJsonWrite(statePath, state);
}

function buildExecutorAssignmentMessage({ taskId, assignmentId, body }) {
  const details = String(body || "").trim();
  if (!details) throw new Error("Planner assignment body is empty");
  return [
    `Task ${taskId} · assignment ${assignmentId}`,
    "",
    details,
    "",
    "Thực hiện đúng task này, báo cáo result/evidence rồi dừng.",
    `Dòng cuối bắt buộc: @M {"v":1,"a":"report","t":"${taskId}","i":"${assignmentId}","r":"RESULT-ID","s":"pass|fail|blocked"}`
  ].join("\n");
}

function buildPlannerReviewMessage({ taskId, assignmentId, resultId, body }) {
  return [
    `Review result ${resultId} for task ${taskId} · assignment ${assignmentId}.`,
    "",
    String(body || "").trim(),
    "",
    "VERIFY theo DoD/evidence. Dòng cuối dùng @M.",
    'Nếu ACCEPT và có task kế tiếp: @M {"v":1,"a":"accept_assign","t":"CURRENT","r":"RESULT","n":"NEXT","i":"NEW-ASSIGNMENT"}',
    'Nếu REJECT: @M {"v":1,"a":"reject","t":"CURRENT","r":"RESULT"}'
  ].join("\n");
}

function sameTurn(turn, seen) {
  return Boolean(turn?.turn_id && seen && turn.turn_id === seen);
}

async function reconcileOrSend({
  page,
  pending,
  state,
  statePath,
  persist,
  captureTurn,
  inspectDraft,
  sendInstruction,
  now
}) {
  if (pending.send_confirmed_at) {
    return { status: "CONFIRMED", sent: false };
  }

  const latestUser = await captureTurn(page, "user").catch(() => null);
  if (
    latestUser?.text &&
    composerInstructionDigest(latestUser.text) === pending.message_digest
  ) {
    pending.send_confirmed_at = now();
    pending.send_evidence = "latest-matching-user-turn";
    await persist(statePath, state);
    return { status: "CONFIRMED", sent: false, reconciled: true };
  }

  const draft = await inspectDraft(page).catch(() => null);
  if (draft?.has_text === true && draft.digest !== pending.message_digest) {
    pending.blocked_reason = "foreign-or-owner-draft-present";
    await persist(statePath, state);
    return { status: "BLOCKED_FOREIGN_DRAFT", sent: false };
  }

  const exactPendingDraft = Boolean(
    draft?.has_text === true &&
    draft.digest === pending.message_digest
  );

  if (pending.send_attempted_at && !exactPendingDraft) {
    pending.blocked_reason = "send-outcome-uncertain-no-duplicate";
    await persist(statePath, state);
    return { status: "UNCERTAIN_NO_DUPLICATE", sent: false };
  }

  pending.send_attempted_at = pending.send_attempted_at || now();
  pending.blocked_reason = null;
  await persist(statePath, state);

  const sent = await sendInstruction(page, pending.message, { dryRun: false });
  if (!sent?.executed) {
    pending.last_send_error = String(
      sent?.reason || sent?.rejection_class || "send-not-confirmed"
    ).slice(0, 300);
    await persist(statePath, state);
    return { status: "SEND_NOT_CONFIRMED", sent: false, detail: sent };
  }

  pending.send_confirmed_at = now();
  pending.send_evidence =
    sent.user_turn_evidence || "sendComposerInstruction-confirmed";
  pending.last_send_error = null;
  await persist(statePath, state);
  return { status: "CONFIRMED", sent: true, detail: sent };
}

export async function runPlannerExecutorStep({
  statePath,
  projectId,
  plannerPage,
  executorPage,
  plannerTarget = "",
  executorTarget = "",
  captureTurn = captureLatestRoleTurn,
  inspectDraft = inspectComposerDraftDigest,
  sendInstruction = sendComposerInstruction,
  persist = writePlannerExecutorState,
  now = () => new Date().toISOString()
}) {
  if (!plannerPage || !executorPage) {
    throw new Error("Planner and Executor pages are required");
  }

  const state = await readPlannerExecutorState(statePath, {
    projectId,
    plannerTarget,
    executorTarget
  });

  // Crash/restart recovery always reconciles durable outbound intent before
  // consuming another assistant turn. This prevents a second logical send.
  if (state.assignment && !state.assignment.send_confirmed_at) {
    const outcome = await reconcileOrSend({
      page: executorPage,
      pending: state.assignment,
      state,
      statePath,
      persist,
      captureTurn,
      inspectDraft,
      sendInstruction,
      now
    });
    return { phase: "ASSIGNMENT_SEND_RECOVERY", outcome, state };
  }
  if (state.result && !state.result.relay_confirmed_at) {
    const outcome = await reconcileOrSend({
      page: plannerPage,
      pending: state.result,
      state,
      statePath,
      persist,
      captureTurn,
      inspectDraft,
      sendInstruction,
      now
    });
    if (outcome.status === "CONFIRMED") {
      state.result.relay_confirmed_at =
        state.result.relay_confirmed_at || state.result.send_confirmed_at || now();
      await persist(statePath, state);
    }
    return { phase: "RESULT_RELAY_RECOVERY", outcome, state };
  }

  if (!state.assignment) {
    const turn = await captureTurn(plannerPage, "assistant");
    if (!turn || sameTurn(turn, state.planner.last_seen_assistant_turn_id)) {
      return { phase: "WAIT_PLANNER_ASSIGN", state };
    }

    const parsed = parseMachineFrame(turn.text);
    try {
      assertMachineFrameAction(parsed.frame, ["assign"]);
    } catch {
      return { phase: "WAIT_PLANNER_ASSIGN", ignored_action: parsed.frame.a, state };
    }

    const message = buildExecutorAssignmentMessage({
      taskId: parsed.frame.t,
      assignmentId: parsed.frame.i,
      body: parsed.body
    });

    state.planner.last_seen_assistant_turn_id = turn.turn_id;
    state.active_task_id = parsed.frame.t;
    state.assignment = {
      task_id: parsed.frame.t,
      assignment_id: parsed.frame.i,
      source_turn_id: turn.turn_id,
      planner_body: parsed.body,
      message,
      message_digest: composerInstructionDigest(message),
      persisted_at: now(),
      send_attempted_at: null,
      send_confirmed_at: null,
      send_evidence: null,
      blocked_reason: null
    };
    state.result = null;
    state.decision = null;
    await persist(statePath, state);

    const outcome = await reconcileOrSend({
      page: executorPage,
      pending: state.assignment,
      state,
      statePath,
      persist,
      captureTurn,
      inspectDraft,
      sendInstruction,
      now
    });
    return { phase: "PLANNER_ASSIGN", outcome, state };
  }

  if (!state.result) {
    const turn = await captureTurn(executorPage, "assistant");
    if (!turn || sameTurn(turn, state.executor.last_seen_assistant_turn_id)) {
      return { phase: "WAIT_EXECUTOR_REPORT", state };
    }

    const parsed = parseMachineFrame(turn.text);
    try {
      assertMachineFrameAction(parsed.frame, ["report"]);
    } catch {
      return { phase: "WAIT_EXECUTOR_REPORT", ignored_action: parsed.frame.a, state };
    }
    assertMachineFrameCorrelation(parsed.frame, {
      taskId: state.assignment.task_id,
      assignmentId: state.assignment.assignment_id
    });

    const relayMessage = buildPlannerReviewMessage({
      taskId: parsed.frame.t,
      assignmentId: parsed.frame.i,
      resultId: parsed.frame.r,
      body: parsed.body
    });

    state.executor.last_seen_assistant_turn_id = turn.turn_id;
    state.result = {
      task_id: parsed.frame.t,
      assignment_id: parsed.frame.i,
      result_id: parsed.frame.r,
      status: parsed.frame.s,
      source_turn_id: turn.turn_id,
      executor_body: parsed.body,
      message: relayMessage,
      message_digest: composerInstructionDigest(relayMessage),
      persisted_at: now(),
      send_attempted_at: null,
      send_confirmed_at: null,
      relay_confirmed_at: null,
      blocked_reason: null
    };
    await persist(statePath, state);

    const outcome = await reconcileOrSend({
      page: plannerPage,
      pending: state.result,
      state,
      statePath,
      persist,
      captureTurn,
      inspectDraft,
      sendInstruction,
      now
    });
    if (outcome.status === "CONFIRMED") {
      state.result.relay_confirmed_at =
        state.result.send_confirmed_at || now();
      await persist(statePath, state);
    }
    return { phase: "EXECUTOR_REPORT", outcome, state };
  }

  const plannerTurn = await captureTurn(plannerPage, "assistant");
  if (!plannerTurn || sameTurn(
    plannerTurn,
    state.planner.last_seen_assistant_turn_id
  )) {
    return { phase: "WAIT_PLANNER_DECISION", state };
  }

  const parsed = parseMachineFrame(plannerTurn.text);
  if (parsed.frame.a === "reject") {
    assertMachineFrameCorrelation(parsed.frame, {
      taskId: state.result.task_id,
      resultId: state.result.result_id
    });
    state.planner.last_seen_assistant_turn_id = plannerTurn.turn_id;
    state.decision = {
      action: "reject",
      task_id: parsed.frame.t,
      result_id: parsed.frame.r,
      decided_at: now()
    };
    await persist(statePath, state);
    return { phase: "PLANNER_REJECT", state };
  }

  try {
    assertMachineFrameAction(parsed.frame, ["accept_assign"]);
  } catch {
    return {
      phase: "WAIT_PLANNER_DECISION",
      ignored_action: parsed.frame.a,
      state
    };
  }
  assertMachineFrameCorrelation(parsed.frame, {
    taskId: state.result.task_id,
    resultId: state.result.result_id
  });

  const nextMessage = buildExecutorAssignmentMessage({
    taskId: parsed.frame.n,
    assignmentId: parsed.frame.i,
    body: parsed.body
  });

  state.planner.last_seen_assistant_turn_id = plannerTurn.turn_id;
  state.last_completed = {
    task_id: state.result.task_id,
    assignment_id: state.result.assignment_id,
    result_id: state.result.result_id,
    status: state.result.status,
    accepted_at: now()
  };
  state.decision = {
    action: "accept_assign",
    task_id: parsed.frame.t,
    result_id: parsed.frame.r,
    next_task_id: parsed.frame.n,
    assignment_id: parsed.frame.i,
    decided_at: now()
  };
  state.active_task_id = parsed.frame.n;
  state.assignment = {
    task_id: parsed.frame.n,
    assignment_id: parsed.frame.i,
    source_turn_id: plannerTurn.turn_id,
    planner_body: parsed.body,
    message: nextMessage,
    message_digest: composerInstructionDigest(nextMessage),
    persisted_at: now(),
    send_attempted_at: null,
    send_confirmed_at: null,
    send_evidence: null,
    blocked_reason: null
  };
  state.result = null;
  await persist(statePath, state);

  const outcome = await reconcileOrSend({
    page: executorPage,
    pending: state.assignment,
    state,
    statePath,
    persist,
    captureTurn,
    inspectDraft,
    sendInstruction,
    now
  });
  return { phase: "PLANNER_ACCEPT_ASSIGN", outcome, state };
}
