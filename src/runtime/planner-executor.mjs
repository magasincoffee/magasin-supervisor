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
  assertMachineFrameCorrelation
} from "./machine-frame.mjs";
import { captureNewestMachineFrame } from "./latest-machine-turn.mjs";

export { parseMachineFrame } from "./machine-frame.mjs";

export const PLANNER_EXECUTOR_MODE = "PLANNER_EXECUTOR_V1";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const IDENTITY_HISTORY_LIMIT = 128;

function requireId(value, label) {
  const id = String(value || "").trim();
  if (!ID_RE.test(id)) throw new Error(`invalid ${label}`);
  return id;
}

function pushBoundedIdentity(list, value) {
  const id = String(value || "").trim();
  if (!id || list.includes(id)) return;
  list.push(id);
  if (list.length > IDENTITY_HISTORY_LIMIT) {
    list.splice(0, list.length - IDENTITY_HISTORY_LIMIT);
  }
}

function ensureIdentityHistory(state) {
  if (!state.identity_history || typeof state.identity_history !== "object") {
    state.identity_history = {
      assignment_ids: [],
      result_ids: []
    };
  }
  if (!Array.isArray(state.identity_history.assignment_ids)) {
    state.identity_history.assignment_ids = [];
  }
  if (!Array.isArray(state.identity_history.result_ids)) {
    state.identity_history.result_ids = [];
  }

  // Seed additive PE-004 history from durable identities that may predate
  // this field. This preserves restart compatibility without regenerating IDs.
  pushBoundedIdentity(
    state.identity_history.assignment_ids,
    state.last_completed?.assignment_id
  );
  pushBoundedIdentity(
    state.identity_history.result_ids,
    state.last_completed?.result_id
  );
  pushBoundedIdentity(
    state.identity_history.assignment_ids,
    state.assignment?.assignment_id
  );
  pushBoundedIdentity(
    state.identity_history.result_ids,
    state.result?.result_id
  );
  return state.identity_history;
}

function assertFreshIdentity(state, kind, value) {
  const id = requireId(value, kind);
  const history = ensureIdentityHistory(state);
  const list = kind === "assignment_id"
    ? history.assignment_ids
    : history.result_ids;
  if (list.includes(id)) {
    throw new Error(`${kind} reuse is not allowed: ${id}`);
  }
  return id;
}

function rememberIdentity(state, kind, value) {
  const history = ensureIdentityHistory(state);
  const list = kind === "assignment_id"
    ? history.assignment_ids
    : history.result_ids;
  pushBoundedIdentity(list, value);
}

async function captureOutboundBaseline(page, captureTurn) {
  const latest = await captureTurn(page, "user").catch(() => null);
  return {
    baseline_captured: true,
    baseline_user_turn_id: latest?.turn_id || null,
    baseline_user_turn_digest: latest?.text
      ? composerInstructionDigest(latest.text)
      : null
  };
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
    last_completed: null,
    automation: {
      status: "RUNNING",
      reason: null,
      updated_at: null
    },
    identity_history: {
      assignment_ids: [],
      result_ids: []
    }
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
    'Nếu REJECT và correction có thể giao ngay: viết body correction không rỗng rồi dùng @M {"v":1,"a":"reject","t":"CURRENT","r":"RESULT","i":"NEW-CORRECTION-ASSIGNMENT"}.',
    'Nếu REJECT nhưng cần Owner/dependency ngoài Executor: dùng @M {"v":1,"a":"blocked","t":"CURRENT","r":"RESULT"}.',
    'Nếu dự án hoàn tất: @M {"v":1,"a":"done","t":"CURRENT","r":"RESULT"}.'
  ].join("\n");
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
  const latestUserIsNew = Boolean(
    pending.baseline_captured === true &&
    latestUser?.turn_id &&
    latestUser.turn_id !== pending.baseline_user_turn_id
  );
  if (
    latestUserIsNew &&
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
  ensureIdentityHistory(state);

  if (state.automation?.status === "DONE") {
    return { phase: "PLANNER_DONE", state };
  }
  if (state.automation?.status === "STOPPED") {
    return { phase: "PLANNER_STOPPED", state };
  }
  if (state.automation?.status === "BLOCKED") {
    const latestControl = await captureNewestMachineFrame(
      plannerPage,
      "assistant",
      {
        lastSeenTurnId: state.planner.last_seen_assistant_turn_id,
        captureTurn
      }
    );
    if (!latestControl) {
      return { phase: "WAIT_PLANNER_RESUME", state };
    }
    if (latestControl.frame.a !== "resume") {
      return {
        phase: "WAIT_PLANNER_RESUME",
        ignored_action: latestControl.frame.a,
        state
      };
    }
    if (latestControl.frame.t && state.active_task_id) {
      assertMachineFrameCorrelation(latestControl.frame, {
        taskId: state.active_task_id
      });
    }
    state.planner.last_seen_assistant_turn_id = latestControl.turn.turn_id;
    state.automation = {
      status: "RUNNING",
      reason: null,
      updated_at: now()
    };
    state.decision = {
      action: "resume",
      task_id: latestControl.frame.t || state.active_task_id,
      decided_at: now()
    };
    await persist(statePath, state);
    return { phase: "PLANNER_RESUMED", state };
  }

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
    const latest = await captureNewestMachineFrame(
      plannerPage,
      "assistant",
      {
        lastSeenTurnId: state.planner.last_seen_assistant_turn_id,
        captureTurn
      }
    );
    if (!latest) {
      return { phase: "WAIT_PLANNER_ASSIGN", state };
    }

    try {
      assertMachineFrameAction(latest.frame, ["assign"]);
    } catch {
      return { phase: "WAIT_PLANNER_ASSIGN", ignored_action: latest.frame.a, state };
    }

    const assignmentId = assertFreshIdentity(
      state,
      "assignment_id",
      latest.frame.i
    );
    const message = buildExecutorAssignmentMessage({
      taskId: latest.frame.t,
      assignmentId,
      body: latest.body
    });
    const baseline = await captureOutboundBaseline(
      executorPage,
      captureTurn
    );

    state.planner.last_seen_assistant_turn_id = latest.turn.turn_id;
    state.active_task_id = latest.frame.t;
    state.assignment = {
      task_id: latest.frame.t,
      assignment_id: assignmentId,
      source_turn_id: latest.turn.turn_id,
      planner_body: latest.body,
      message,
      message_digest: composerInstructionDigest(message),
      persisted_at: now(),
      send_attempted_at: null,
      send_confirmed_at: null,
      send_evidence: null,
      blocked_reason: null,
      ...baseline
    };
    rememberIdentity(state, "assignment_id", assignmentId);
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
    const latest = await captureNewestMachineFrame(
      executorPage,
      "assistant",
      {
        lastSeenTurnId: state.executor.last_seen_assistant_turn_id,
        captureTurn
      }
    );
    if (!latest) {
      return { phase: "WAIT_EXECUTOR_REPORT", state };
    }

    try {
      assertMachineFrameAction(latest.frame, ["report"]);
    } catch {
      return { phase: "WAIT_EXECUTOR_REPORT", ignored_action: latest.frame.a, state };
    }
    assertMachineFrameCorrelation(latest.frame, {
      taskId: state.assignment.task_id,
      assignmentId: state.assignment.assignment_id
    });
    const resultId = assertFreshIdentity(state, "result_id", latest.frame.r);

    const relayMessage = buildPlannerReviewMessage({
      taskId: latest.frame.t,
      assignmentId: latest.frame.i,
      resultId,
      body: latest.body
    });
    const baseline = await captureOutboundBaseline(
      plannerPage,
      captureTurn
    );

    state.executor.last_seen_assistant_turn_id = latest.turn.turn_id;
    state.result = {
      task_id: latest.frame.t,
      assignment_id: latest.frame.i,
      result_id: resultId,
      status: latest.frame.s,
      source_turn_id: latest.turn.turn_id,
      executor_body: latest.body,
      message: relayMessage,
      message_digest: composerInstructionDigest(relayMessage),
      persisted_at: now(),
      send_attempted_at: null,
      send_confirmed_at: null,
      relay_confirmed_at: null,
      blocked_reason: null,
      ...baseline
    };
    rememberIdentity(state, "result_id", resultId);
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

  const latest = await captureNewestMachineFrame(
    plannerPage,
    "assistant",
    {
      lastSeenTurnId: state.planner.last_seen_assistant_turn_id,
      captureTurn
    }
  );
  if (!latest) {
    return { phase: "WAIT_PLANNER_DECISION", state };
  }

  if (latest.frame.a === "blocked") {
    assertMachineFrameCorrelation(latest.frame, {
      taskId: state.result.task_id,
      resultId: state.result.result_id
    });
    state.planner.last_seen_assistant_turn_id = latest.turn.turn_id;
    state.automation = {
      status: "BLOCKED",
      reason: latest.body || "planner-blocked",
      updated_at: now()
    };
    state.decision = {
      action: "blocked",
      task_id: latest.frame.t,
      result_id: latest.frame.r,
      decided_at: now()
    };
    await persist(statePath, state);
    return { phase: "PLANNER_BLOCKED", state };
  }

  if (latest.frame.a === "done") {
    assertMachineFrameCorrelation(latest.frame, {
      taskId: state.result.task_id,
      resultId: state.result.result_id
    });
    state.planner.last_seen_assistant_turn_id = latest.turn.turn_id;
    state.last_completed = {
      task_id: state.result.task_id,
      assignment_id: state.result.assignment_id,
      result_id: state.result.result_id,
      status: state.result.status,
      accepted_at: now()
    };
    state.active_task_id = null;
    state.automation = {
      status: "DONE",
      reason: latest.body || "project-complete",
      updated_at: now()
    };
    state.decision = {
      action: "done",
      task_id: latest.frame.t,
      result_id: latest.frame.r,
      decided_at: now()
    };
    await persist(statePath, state);
    return { phase: "PLANNER_DONE", state };
  }

  if (latest.frame.a === "stop") {
    state.planner.last_seen_assistant_turn_id = latest.turn.turn_id;
    state.automation = {
      status: "STOPPED",
      reason: latest.body || "planner-stop",
      updated_at: now()
    };
    state.decision = {
      action: "stop",
      task_id: latest.frame.t || state.result.task_id,
      result_id: latest.frame.r || state.result.result_id,
      decided_at: now()
    };
    await persist(statePath, state);
    return { phase: "PLANNER_STOPPED", state };
  }

  if (latest.frame.a === "reject") {
    assertMachineFrameCorrelation(latest.frame, {
      taskId: state.result.task_id,
      resultId: state.result.result_id
    });

    // Fast correction path: one Planner response both rejects the result and
    // creates a fresh correction assignment for the same task. The existing
    // @M reject action carries optional i=NEW-ASSIGNMENT, avoiding another
    // Planner round trip while preserving exact-once assignment identity.
    if (latest.frame.i && latest.body) {
      const correctionAssignmentId = assertFreshIdentity(
        state,
        "assignment_id",
        latest.frame.i
      );
      const correctionMessage = buildExecutorAssignmentMessage({
        taskId: state.result.task_id,
        assignmentId: correctionAssignmentId,
        body: latest.body
      });
      const baseline = await captureOutboundBaseline(
        executorPage,
        captureTurn
      );

      state.planner.last_seen_assistant_turn_id = latest.turn.turn_id;
      state.decision = {
        action: "reject_correction",
        task_id: latest.frame.t,
        result_id: latest.frame.r,
        assignment_id: correctionAssignmentId,
        decided_at: now()
      };
      state.automation = {
        status: "RUNNING",
        reason: null,
        updated_at: now()
      };
      state.active_task_id = state.result.task_id;
      state.assignment = {
        task_id: state.result.task_id,
        assignment_id: correctionAssignmentId,
        correction_of_result_id: state.result.result_id,
        source_turn_id: latest.turn.turn_id,
        planner_body: latest.body,
        message: correctionMessage,
        message_digest: composerInstructionDigest(correctionMessage),
        persisted_at: now(),
        send_attempted_at: null,
        send_confirmed_at: null,
        send_evidence: null,
        blocked_reason: null,
        ...baseline
      };
      rememberIdentity(state, "assignment_id", correctionAssignmentId);
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
      return { phase: "PLANNER_REJECT_CORRECTION", outcome, state };
    }

    state.planner.last_seen_assistant_turn_id = latest.turn.turn_id;
    state.automation = {
      status: "BLOCKED",
      reason: "reject-missing-bounded-correction",
      updated_at: now()
    };
    state.decision = {
      action: "reject",
      task_id: latest.frame.t,
      result_id: latest.frame.r,
      decided_at: now()
    };
    await persist(statePath, state);
    return { phase: "PLANNER_REJECT_BLOCKED", state };
  }

  try {
    assertMachineFrameAction(latest.frame, ["accept_assign"]);
  } catch {
    return {
      phase: "WAIT_PLANNER_DECISION",
      ignored_action: latest.frame.a,
      state
    };
  }
  assertMachineFrameCorrelation(latest.frame, {
    taskId: state.result.task_id,
    resultId: state.result.result_id
  });

  const nextAssignmentId = assertFreshIdentity(
    state,
    "assignment_id",
    latest.frame.i
  );
  const nextMessage = buildExecutorAssignmentMessage({
    taskId: latest.frame.n,
    assignmentId: nextAssignmentId,
    body: latest.body
  });
  const baseline = await captureOutboundBaseline(
    executorPage,
    captureTurn
  );

  state.planner.last_seen_assistant_turn_id = latest.turn.turn_id;
  state.automation = {
    status: "RUNNING",
    reason: null,
    updated_at: now()
  };
  state.last_completed = {
    task_id: state.result.task_id,
    assignment_id: state.result.assignment_id,
    result_id: state.result.result_id,
    status: state.result.status,
    accepted_at: now()
  };
  state.decision = {
    action: "accept_assign",
    task_id: latest.frame.t,
    result_id: latest.frame.r,
    next_task_id: latest.frame.n,
    assignment_id: nextAssignmentId,
    decided_at: now()
  };
  state.active_task_id = latest.frame.n;
  state.assignment = {
    task_id: latest.frame.n,
    assignment_id: nextAssignmentId,
    source_turn_id: latest.turn.turn_id,
    planner_body: latest.body,
    message: nextMessage,
    message_digest: composerInstructionDigest(nextMessage),
    persisted_at: now(),
    send_attempted_at: null,
    send_confirmed_at: null,
    send_evidence: null,
    blocked_reason: null,
    ...baseline
  };
  rememberIdentity(state, "assignment_id", nextAssignmentId);
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
