import {
  CHATGPT_BRIDGE_BINDING_SCHEMA,
  validateBridgeRoleBinding
} from "./chatgpt-bridge-binding.mjs";
import { ChatGptBridgeError } from "./chatgpt-bridge-adapter.mjs";

export const CHATGPT_BRIDGE_TRANSPORT_SCHEMA = "chatgpt-bridge-transport.v1";

export const CHATGPT_BRIDGE_TRANSPORT_PHASES = Object.freeze({
  IDLE: "IDLE",
  BOOTSTRAP_PLANNER: "BOOTSTRAP_PLANNER",
  WAIT_PLANNER: "WAIT_PLANNER",
  SEND_EXECUTOR: "SEND_EXECUTOR",
  WAIT_EXECUTOR: "WAIT_EXECUTOR",
  SEND_PLANNER: "SEND_PLANNER",
  WAIT_PLANNER_DECISION: "WAIT_PLANNER_DECISION",
  BLOCKED: "BLOCKED",
  DONE: "DONE",
  STOPPED: "STOPPED"
});

const WAITING_PHASES = new Set([
  CHATGPT_BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER,
  CHATGPT_BRIDGE_TRANSPORT_PHASES.WAIT_EXECUTOR,
  CHATGPT_BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER_DECISION
]);

const TERMINAL_PHASES = new Set([
  CHATGPT_BRIDGE_TRANSPORT_PHASES.DONE,
  CHATGPT_BRIDGE_TRANSPORT_PHASES.STOPPED
]);

export class ChatGptBridgeTransportError extends Error {
  constructor(message, {
    code = "BRIDGE_TRANSPORT_ERROR",
    details = null,
    cause = null
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ChatGptBridgeTransportError";
    this.code = code;
    this.details = details;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nonEmptyText(value, label) {
  const text = String(value ?? "");
  if (!text.trim() || text.length > 100_000) {
    throw new ChatGptBridgeTransportError(
      `${label} must be a non-empty bounded string`,
      { code: "INVALID_MESSAGE" }
    );
  }
  return text;
}

function requireAdapter(adapter) {
  if (
    !adapter ||
    typeof adapter.send !== "function"
  ) {
    throw new ChatGptBridgeTransportError(
      "Bridge adapter with send(page_id, message) is required",
      { code: "INVALID_ADAPTER" }
    );
  }
  return adapter;
}

function requireBinding(binding) {
  try {
    return validateBridgeRoleBinding(binding);
  } catch (error) {
    throw new ChatGptBridgeTransportError(
      "Valid Planner/Executor Bridge binding is required",
      {
        code: "INVALID_BINDING",
        cause: error
      }
    );
  }
}

function rolePageId(binding, role) {
  if (role === "planner") return binding.planner.page_id;
  if (role === "executor") return binding.executor.page_id;
  throw new ChatGptBridgeTransportError("Unknown Bridge transport role", {
    code: "INVALID_ROLE",
    details: { role }
  });
}

function observedAssistantText(observed) {
  const snapshot = observed?.snapshot;
  if (!snapshot || typeof snapshot !== "object") return "";
  const direct = String(snapshot.last_assistant || "").trim();
  if (direct) return direct;
  const turns = Array.isArray(snapshot.recent_turns)
    ? snapshot.recent_turns
    : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (String(turn?.role || "").trim() === "assistant") {
      const text = String(turn?.text || "").trim();
      if (text) return text;
    }
  }
  return "";
}

export function bridgeTransportAssistantText(observed) {
  return observedAssistantText(observed);
}

function compactObservation(role, pageId, observed, at) {
  return {
    role,
    page_id: pageId,
    cmd_id: String(observed?.cmd_id || "").trim() || null,
    observed_at: at,
    response_changed: Boolean(observed?.evidence?.response_changed),
    count_advanced: Boolean(observed?.evidence?.count_advanced),
    digest_changed: Boolean(observed?.evidence?.digest_changed),
    assistant_digest:
      String(observed?.evidence?.assistant_digest || "").trim() || null
  };
}

export function defaultChatGptBridgeTransportState(binding) {
  const safeBinding = requireBinding(binding);
  return {
    schema_version: CHATGPT_BRIDGE_TRANSPORT_SCHEMA,
    binding_schema: CHATGPT_BRIDGE_BINDING_SCHEMA,
    phase: CHATGPT_BRIDGE_TRANSPORT_PHASES.IDLE,
    previous_phase: null,
    resume_phase: null,
    send_count: 0,
    last_response_role: null,
    last_observation: null,
    in_flight: null,
    blocked_reason: null,
    terminal_reason: null,
    role_page_ids: {
      planner: safeBinding.planner.page_id,
      executor: safeBinding.executor.page_id
    }
  };
}

export function validateChatGptBridgeTransportState(state, binding) {
  const safeBinding = requireBinding(binding);
  if (
    !state ||
    state.schema_version !== CHATGPT_BRIDGE_TRANSPORT_SCHEMA
  ) {
    throw new ChatGptBridgeTransportError(
      "Unsupported Bridge transport state",
      { code: "INVALID_TRANSPORT_STATE" }
    );
  }

  if (!Object.values(CHATGPT_BRIDGE_TRANSPORT_PHASES).includes(state.phase)) {
    throw new ChatGptBridgeTransportError(
      "Bridge transport phase is invalid",
      { code: "INVALID_PHASE" }
    );
  }

  if (
    state.role_page_ids?.planner !== safeBinding.planner.page_id ||
    state.role_page_ids?.executor !== safeBinding.executor.page_id
  ) {
    throw new ChatGptBridgeTransportError(
      "Bridge transport state binding no longer matches current role binding",
      { code: "BINDING_STATE_MISMATCH" }
    );
  }

  if (!Number.isInteger(state.send_count) || state.send_count < 0) {
    throw new ChatGptBridgeTransportError(
      "Bridge transport send_count is invalid",
      { code: "INVALID_TRANSPORT_STATE" }
    );
  }

  return state;
}

function assertPhase(state, allowed, operation) {
  if (!allowed.includes(state.phase)) {
    throw new ChatGptBridgeTransportError(
      `${operation} is invalid from phase ${state.phase}`,
      {
        code: "INVALID_TRANSITION",
        details: {
          operation,
          phase: state.phase,
          allowed
        }
      }
    );
  }
}

function transportFailureCode(error) {
  if (error instanceof ChatGptBridgeError) {
    return error.code || "BRIDGE_ERROR";
  }
  if (error instanceof ChatGptBridgeTransportError) {
    return error.code || "BRIDGE_TRANSPORT_ERROR";
  }
  return "TRANSPORT_SEND_FAILED";
}

export class ChatGptBridgeTransportMachine {
  constructor({
    adapter,
    binding,
    state = null,
    now = () => new Date().toISOString()
  } = {}) {
    this.adapter = requireAdapter(adapter);
    this.binding = clone(requireBinding(binding));
    this.now = typeof now === "function"
      ? now
      : () => new Date().toISOString();
    this.state = state
      ? clone(validateChatGptBridgeTransportState(state, this.binding))
      : defaultChatGptBridgeTransportState(this.binding);
  }

  snapshot() {
    return clone(this.state);
  }

  isTerminal() {
    return TERMINAL_PHASES.has(this.state.phase);
  }

  async start(plannerBootstrapMessage) {
    assertPhase(
      this.state,
      [CHATGPT_BRIDGE_TRANSPORT_PHASES.IDLE],
      "start"
    );
    return this.#send({
      role: "planner",
      message: plannerBootstrapMessage,
      sendingPhase: CHATGPT_BRIDGE_TRANSPORT_PHASES.BOOTSTRAP_PLANNER,
      completedPhase: CHATGPT_BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER
    });
  }

  async sendToExecutor(message) {
    assertPhase(
      this.state,
      [
        CHATGPT_BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER,
        CHATGPT_BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER_DECISION
      ],
      "sendToExecutor"
    );
    return this.#send({
      role: "executor",
      message,
      sendingPhase: CHATGPT_BRIDGE_TRANSPORT_PHASES.SEND_EXECUTOR,
      completedPhase: CHATGPT_BRIDGE_TRANSPORT_PHASES.WAIT_EXECUTOR
    });
  }

  async sendToPlanner(message) {
    assertPhase(
      this.state,
      [CHATGPT_BRIDGE_TRANSPORT_PHASES.WAIT_EXECUTOR],
      "sendToPlanner"
    );
    return this.#send({
      role: "planner",
      message,
      sendingPhase: CHATGPT_BRIDGE_TRANSPORT_PHASES.SEND_PLANNER,
      completedPhase:
        CHATGPT_BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER_DECISION
    });
  }

  markBlocked(reason = "blocked") {
    if (this.isTerminal()) {
      throw new ChatGptBridgeTransportError(
        "Terminal Bridge transport cannot become BLOCKED",
        { code: "INVALID_TRANSITION" }
      );
    }
    if (
      !WAITING_PHASES.has(this.state.phase) &&
      this.state.phase !== CHATGPT_BRIDGE_TRANSPORT_PHASES.BLOCKED
    ) {
      throw new ChatGptBridgeTransportError(
        "Bridge transport may be explicitly blocked only from a waiting phase",
        {
          code: "INVALID_TRANSITION",
          details: { phase: this.state.phase }
        }
      );
    }

    if (this.state.phase !== CHATGPT_BRIDGE_TRANSPORT_PHASES.BLOCKED) {
      this.state.resume_phase = this.state.phase;
      this.state.previous_phase = this.state.phase;
    }
    this.state.phase = CHATGPT_BRIDGE_TRANSPORT_PHASES.BLOCKED;
    this.state.blocked_reason =
      String(reason || "blocked").trim().slice(0, 500) || "blocked";
    return this.snapshot();
  }

  resume() {
    assertPhase(
      this.state,
      [CHATGPT_BRIDGE_TRANSPORT_PHASES.BLOCKED],
      "resume"
    );
    if (this.state.in_flight) {
      throw new ChatGptBridgeTransportError(
        "Ambiguous in-flight transport must be reconciled before resume",
        {
          code: "AMBIGUOUS_IN_FLIGHT",
          details: {
            role: this.state.in_flight.role,
            page_id: this.state.in_flight.page_id
          }
        }
      );
    }
    if (!WAITING_PHASES.has(this.state.resume_phase)) {
      throw new ChatGptBridgeTransportError(
        "Bridge transport has no safe waiting phase to resume",
        { code: "INVALID_RESUME_PHASE" }
      );
    }

    this.state.previous_phase = this.state.phase;
    this.state.phase = this.state.resume_phase;
    this.state.resume_phase = null;
    this.state.blocked_reason = null;
    return this.snapshot();
  }

  markDone(reason = "done") {
    assertPhase(
      this.state,
      [
        CHATGPT_BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER,
        CHATGPT_BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER_DECISION
      ],
      "markDone"
    );
    this.state.previous_phase = this.state.phase;
    this.state.phase = CHATGPT_BRIDGE_TRANSPORT_PHASES.DONE;
    this.state.terminal_reason =
      String(reason || "done").trim().slice(0, 500) || "done";
    this.state.blocked_reason = null;
    this.state.resume_phase = null;
    return this.snapshot();
  }

  markStopped(reason = "stopped") {
    if (this.isTerminal()) return this.snapshot();
    if (this.state.in_flight) {
      throw new ChatGptBridgeTransportError(
        "Cannot stop while transport outcome is ambiguous",
        { code: "AMBIGUOUS_IN_FLIGHT" }
      );
    }
    this.state.previous_phase = this.state.phase;
    this.state.phase = CHATGPT_BRIDGE_TRANSPORT_PHASES.STOPPED;
    this.state.terminal_reason =
      String(reason || "stopped").trim().slice(0, 500) || "stopped";
    this.state.blocked_reason = null;
    this.state.resume_phase = null;
    return this.snapshot();
  }

  async #send({
    role,
    message,
    sendingPhase,
    completedPhase
  }) {
    const text = nonEmptyText(message, `${role} message`);
    const fromPhase = this.state.phase;
    const pageId = rolePageId(this.binding, role);
    const startedAt = this.now();

    this.state.previous_phase = fromPhase;
    this.state.phase = sendingPhase;
    this.state.in_flight = {
      role,
      page_id: pageId,
      from_phase: fromPhase,
      sending_phase: sendingPhase,
      started_at: startedAt,
      outcome: "PENDING",
      error_code: null
    };
    this.state.blocked_reason = null;

    try {
      const observed = await this.adapter.send(pageId, text);
      const assistantText = observedAssistantText(observed);
      if (!assistantText) {
        throw new ChatGptBridgeTransportError(
          "Bridge transport observed no assistant response text",
          { code: "EMPTY_ASSISTANT_RESPONSE" }
        );
      }

      const at = this.now();
      this.state.send_count += 1;
      this.state.phase = completedPhase;
      this.state.last_response_role = role;
      this.state.last_observation =
        compactObservation(role, pageId, observed, at);
      this.state.in_flight = null;
      this.state.resume_phase = null;

      return {
        state: this.snapshot(),
        role,
        page_id: pageId,
        response_text: assistantText,
        observed
      };
    } catch (error) {
      const errorCode = transportFailureCode(error);
      this.state.phase = CHATGPT_BRIDGE_TRANSPORT_PHASES.BLOCKED;
      this.state.resume_phase = fromPhase;
      this.state.blocked_reason = "transport-send-ambiguous";
      this.state.in_flight = {
        ...this.state.in_flight,
        outcome: "AMBIGUOUS",
        error_code: errorCode,
        failed_at: this.now()
      };

      throw new ChatGptBridgeTransportError(
        `Bridge transport send to ${role} did not reach a confirmed response`,
        {
          code: "AMBIGUOUS_SEND",
          cause: error,
          details: {
            role,
            page_id: pageId,
            underlying_code: errorCode
          }
        }
      );
    }
  }
}
