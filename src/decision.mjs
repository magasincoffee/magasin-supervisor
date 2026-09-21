import { validateProjectState } from "./state.mjs";

export const OBSERVATIONS = Object.freeze({
  RESPONSE_COMPLETE: "RESPONSE_COMPLETE",
  ASSISTANT_RUNNING: "ASSISTANT_RUNNING",
  USER_PENDING: "USER_PENDING",
  NETWORK_ERROR: "NETWORK_ERROR",
  TRANSIENT_ERROR: "TRANSIENT_ERROR",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  MFA_REQUIRED: "MFA_REQUIRED",
  CAPTCHA: "CAPTCHA",
  DESTRUCTIVE_ACTION: "DESTRUCTIVE_ACTION",
  ADMIN_ESCALATION: "ADMIN_ESCALATION",
  AMBIGUOUS_DECISION: "AMBIGUOUS_DECISION",
  UNKNOWN: "UNKNOWN"
});

export const ACTIONS = Object.freeze({
  CONTINUE: "CONTINUE",
  WAIT: "WAIT",
  RETRY: "RETRY",
  STOP_WAIT_USER: "STOP_WAIT_USER",
  STOP_DONE: "STOP_DONE"
});

export const CANONICAL_CONTINUE_INSTRUCTION =
  "Tiếp tục project theo source-of-truth và policy do project/Brain sở hữu. " +
  "Dùng project input hiện tại chỉ như bounded orchestration context; không suy đoán business policy từ Supervisor. " +
  "Tiếp tục đúng task hiện tại, kiểm chứng thay đổi, cập nhật source-of-truth của project khi project contract yêu cầu, " +
  "và chỉ vượt sang task kế tiếp khi project policy cho phép.";

export const OWNER_DECISION_RECONCILE_INSTRUCTION =
  "RECONCILE QUYẾT ĐỊNH OWNER — project input hiện đang WAIT_USER. " +
  "Đọc ngữ cảnh hội thoại hiện tại và xác định Owner có vừa đưa ra quyết định rõ ràng cho đúng boundary đang chờ hay chưa. " +
  "Nếu và chỉ nếu quyết định đó rõ ràng, reconcile vào source-of-truth theo project-owned contract; Supervisor không tự phát minh business state. " +
  "Nếu Owner chưa quyết định đủ rõ hoặc quyết định không khớp boundary đang chờ, không suy đoán: giữ WAIT_USER và nêu đúng câu hỏi còn thiếu. " +
  "Không lặp lại việc đã hoàn tất.";

export const HANDOFF_RECONCILE_INSTRUCTION =
  "TIẾP QUẢN PHIÊN ĐANG MỞ — không khởi động lại công việc một cách máy móc. " +
  "Trước tiên đọc ngữ cảnh hội thoại hiện tại để xác định Owner vừa yêu cầu gì và phần nào vừa hoàn tất. " +
  "Sau đó reconcile với source-of-truth theo project-owned contract và bounded project input hiện tại. " +
  "Nếu yêu cầu mới nhất làm thay đổi ưu tiên, cập nhật source-of-truth của project trước khi tự tiếp tục. " +
  "Không lặp lại việc đã hoàn tất; chỉ hỏi Owner khi gặp boundary thật.";

export function buildContinueInstruction(projectState = {}) {
  const task = String(projectState.current_task || "").trim();
  const title = String(projectState.current_task_title || "").trim();
  const phase = String(projectState.current_phase || "").trim();
  const focus = [task, title].filter(Boolean).join(" — ");
  const context = [
    phase ? `Phase hiện tại: ${phase}.` : "",
    focus ? `Micro-task repository hiện tại: ${focus}.` : ""
  ].filter(Boolean).join(" ");

  return `${CANONICAL_CONTINUE_INSTRUCTION} ${context}`.trim();
}

const HARD_STOPS = new Set([
  OBSERVATIONS.AUTH_REQUIRED,
  OBSERVATIONS.MFA_REQUIRED,
  OBSERVATIONS.CAPTCHA,
  OBSERVATIONS.DESTRUCTIVE_ACTION,
  OBSERVATIONS.ADMIN_ESCALATION,
  OBSERVATIONS.AMBIGUOUS_DECISION
]);

const TRANSIENT = new Set([
  OBSERVATIONS.NETWORK_ERROR,
  OBSERVATIONS.TRANSIENT_ERROR
]);

export function decideContinuation({
  projectState,
  observation,
  retryCount = 0,
  maxRetries = 2,
  handoff = false,
  ownerReconcile = false
}) {
  const state = validateProjectState(projectState);

  if (!Number.isInteger(retryCount) || retryCount < 0) {
    throw new TypeError("retryCount must be a non-negative integer");
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError("maxRetries must be a non-negative integer");
  }

  if (state.status === "DONE") {
    return { action: ACTIONS.STOP_DONE, reason: "project state is DONE" };
  }

  if (state.blocked || state.status === "BLOCKED") {
    return {
      action: ACTIONS.STOP_WAIT_USER,
      reason: "project state is blocked"
    };
  }

  const waitingForOwner =
    state.requires_user || state.status === "WAIT_USER";

  if (HARD_STOPS.has(observation)) {
    return {
      action: ACTIONS.STOP_WAIT_USER,
      reason: `unsafe or owner-required observation: ${observation}`
    };
  }

  if (TRANSIENT.has(observation)) {
    if (retryCount < maxRetries) {
      return {
        action: ACTIONS.RETRY,
        reason: `transient observation: ${observation}`,
        nextRetryCount: retryCount + 1
      };
    }
    return {
      action: ACTIONS.STOP_WAIT_USER,
      reason: "transient retry budget exhausted"
    };
  }

  if (waitingForOwner) {
    if (!ownerReconcile) {
      return {
        action: ACTIONS.STOP_WAIT_USER,
        reason: "project state requires owner intervention"
      };
    }

    if (observation === OBSERVATIONS.RESPONSE_COMPLETE) {
      return {
        action: ACTIONS.CONTINUE,
        reason: "owner boundary is waiting; reconcile any explicit live Owner decision into repository state",
        instruction: OWNER_DECISION_RECONCILE_INSTRUCTION
      };
    }

    if (observation === OBSERVATIONS.ASSISTANT_RUNNING) {
      return {
        action: ACTIONS.WAIT,
        reason: "Owner/ChatGPT decision exchange is still running"
      };
    }

    if (observation === OBSERVATIONS.USER_PENDING) {
      return {
        action: ACTIONS.WAIT,
        reason: "latest visible message is from Owner; wait for decision exchange to settle before reconciliation"
      };
    }

    return {
      action: ACTIONS.WAIT,
      reason: "owner boundary UI state is not safely reconcilable yet"
    };
  }

  if (state.autonomy !== "AUTO_CONTINUE") {
    return {
      action: ACTIONS.WAIT,
      reason: `autonomy mode is ${state.autonomy}`
    };
  }

  if (observation === OBSERVATIONS.RESPONSE_COMPLETE) {
    return {
      action: ACTIONS.CONTINUE,
      reason: handoff
        ? "active conversation is idle; reconcile live Owner/chat context before autonomous continuation"
        : "assistant response completed and autonomous continuation is allowed",
      instruction: handoff
        ? HANDOFF_RECONCILE_INSTRUCTION
        : buildContinueInstruction(state)
    };
  }

  if (observation === OBSERVATIONS.ASSISTANT_RUNNING) {
    return { action: ACTIONS.WAIT, reason: "assistant is still running" };
  }

  if (observation === OBSERVATIONS.USER_PENDING) {
    return {
      action: ACTIONS.WAIT,
      reason: "latest visible message is from Owner; wait for ChatGPT to answer before takeover"
    };
  }

  return {
    action: ACTIONS.WAIT,
    reason: "unknown UI state; fail closed"
  };
}
