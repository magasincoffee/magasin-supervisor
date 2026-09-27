import { ChatGptBridgeError } from "./chatgpt-bridge-adapter.mjs";
import { validateBridgeRoleBinding } from "./chatgpt-bridge-binding.mjs";

export const BRIDGE_TRANSPORT_PHASES = Object.freeze({
  IDLE: "IDLE",
  BOOTSTRAP_PLANNER: "BOOTSTRAP_PLANNER",
  WAIT_PLANNER: "WAIT_PLANNER",
  SEND_EXECUTOR: "SEND_EXECUTOR",
  WAIT_EXECUTOR: "WAIT_EXECUTOR",
  SEND_PLANNER: "SEND_PLANNER",
  WAIT_PLANNER_DECISION: "WAIT_PLANNER_DECISION",
  BLOCKED: "BLOCKED",
  DONE: "DONE"
});

export class BridgeTransportStateError extends Error {
  constructor(message, {
    code = "BRIDGE_TRANSPORT_STATE_ERROR",
    details = null,
    cause = null
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "BridgeTransportStateError";
    this.code = code;
    this.details = details;
  }
}

function requireText(value, label) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 100_000) {
    throw new BridgeTransportStateError(label + " must be non-empty bounded text", {
      code: "INVALID_EVENT"
    });
  }
  return text;
}

function requireAction(value, allowed) {
  const action = String(value || "").trim();
  if (!allowed.includes(action)) {
    throw new BridgeTransportStateError("Unexpected transport action: " + action, {
      code: "INVALID_EVENT",
      details: { action, allowed }
    });
  }
  return action;
}

function requireAdapter(adapter) {
  if (!adapter || typeof adapter.send !== "function") {
    throw new BridgeTransportStateError("Bridge adapter with send() is required", {
      code: "INVALID_ADAPTER"
    });
  }
  return adapter;
}

function rolePageId(binding, role) {
  const value = binding?.[role]?.page_id;
  if (!String(value || "").trim()) {
    throw new BridgeTransportStateError("Missing " + role + " Bridge page_id", {
      code: "INVALID_BINDING"
    });
  }
  return String(value).trim();
}

function phaseAllowed(current, allowed) {
  if (!allowed.includes(current)) {
    throw new BridgeTransportStateError(
      "Transport event is invalid in phase " + current,
      {
        code: "INVALID_PHASE",
        details: { current, allowed }
      }
    );
  }
}

export class PlannerExecutorBridgeTransportStateMachine {
  constructor({
    adapter,
    binding,
    phase = BRIDGE_TRANSPORT_PHASES.IDLE
  } = {}) {
    this.adapter = requireAdapter(adapter);
    this.binding = validateBridgeRoleBinding(binding);
    if (!Object.values(BRIDGE_TRANSPORT_PHASES).includes(phase)) {
      throw new BridgeTransportStateError("Unknown initial transport phase", {
        code: "INVALID_PHASE"
      });
    }
    this.phase = phase;
    this.last_transport = null;
  }

  snapshot() {
    return {
      phase: this.phase,
      planner_page_id: rolePageId(this.binding, "planner"),
      executor_page_id: rolePageId(this.binding, "executor"),
      last_transport: this.last_transport
        ? {
            from_role: this.last_transport.from_role,
            to_role: this.last_transport.to_role,
            action: this.last_transport.action,
            cmd_id: this.last_transport.cmd_id || null
          }
        : null
    };
  }

  replaceBinding(binding) {
    const next = validateBridgeRoleBinding(binding);
    if (
      next.planner.canonical_target !== this.binding.planner.canonical_target ||
      next.executor.canonical_target !== this.binding.executor.canonical_target
    ) {
      throw new BridgeTransportStateError(
        "Binding replacement changed canonical role identity",
        { code: "ROLE_IDENTITY_CHANGED" }
      );
    }
    this.binding = next;
    return this.snapshot();
  }

  start() {
    phaseAllowed(this.phase, [BRIDGE_TRANSPORT_PHASES.IDLE]);
    this.phase = BRIDGE_TRANSPORT_PHASES.BOOTSTRAP_PLANNER;
    return this.snapshot();
  }

  plannerBootstrapDispatched() {
    phaseAllowed(this.phase, [BRIDGE_TRANSPORT_PHASES.BOOTSTRAP_PLANNER]);
    this.phase = BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER;
    return this.snapshot();
  }

  async plannerEvent(event = {}) {
    phaseAllowed(this.phase, [
      BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER,
      BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER_DECISION
    ]);

    const isInitial = this.phase === BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER;
    const allowed = isInitial
      ? ["assign", "done", "blocked"]
      : ["accept_assign", "reject", "done", "blocked"];
    const action = requireAction(event.action, allowed);

    if (action === "done") {
      this.phase = BRIDGE_TRANSPORT_PHASES.DONE;
      return this.snapshot();
    }
    if (action === "blocked") {
      this.phase = BRIDGE_TRANSPORT_PHASES.BLOCKED;
      return this.snapshot();
    }

    const message = requireText(event.message, "Planner outbound message");
    this.phase = BRIDGE_TRANSPORT_PHASES.SEND_EXECUTOR;

    let result;
    try {
      result = await this.adapter.send(
        rolePageId(this.binding, "executor"),
        message,
        event.send_options || {}
      );
    } catch (error) {
      this.phase = isInitial
        ? BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER
        : BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER_DECISION;
      throw new BridgeTransportStateError(
        "Planner-to-Executor Bridge transport failed",
        {
          code: "TRANSPORT_SEND_FAILED",
          cause: error,
          details: { from_role: "planner", to_role: "executor", action }
        }
      );
    }

    this.last_transport = {
      from_role: "planner",
      to_role: "executor",
      action,
      cmd_id: result?.cmd_id || null
    };
    this.phase = BRIDGE_TRANSPORT_PHASES.WAIT_EXECUTOR;
    return { ...this.snapshot(), transport_result: result };
  }

  async executorEvent(event = {}) {
    phaseAllowed(this.phase, [BRIDGE_TRANSPORT_PHASES.WAIT_EXECUTOR]);
    const action = requireAction(event.action, ["report"]);
    const message = requireText(event.message, "Executor outbound message");
    this.phase = BRIDGE_TRANSPORT_PHASES.SEND_PLANNER;

    let result;
    try {
      result = await this.adapter.send(
        rolePageId(this.binding, "planner"),
        message,
        event.send_options || {}
      );
    } catch (error) {
      this.phase = BRIDGE_TRANSPORT_PHASES.WAIT_EXECUTOR;
      throw new BridgeTransportStateError(
        "Executor-to-Planner Bridge transport failed",
        {
          code: "TRANSPORT_SEND_FAILED",
          cause: error,
          details: { from_role: "executor", to_role: "planner", action }
        }
      );
    }

    this.last_transport = {
      from_role: "executor",
      to_role: "planner",
      action,
      cmd_id: result?.cmd_id || null
    };
    this.phase = BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER_DECISION;
    return { ...this.snapshot(), transport_result: result };
  }

  resumePlanner() {
    phaseAllowed(this.phase, [BRIDGE_TRANSPORT_PHASES.BLOCKED]);
    this.phase = BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER;
    return this.snapshot();
  }
}

export function createPlannerExecutorBridgeTransportStateMachine(options) {
  try {
    return new PlannerExecutorBridgeTransportStateMachine(options);
  } catch (error) {
    if (error instanceof BridgeTransportStateError) throw error;
    if (error instanceof ChatGptBridgeError) {
      throw new BridgeTransportStateError("Bridge transport initialization failed", {
        code: "INVALID_BINDING",
        cause: error
      });
    }
    throw error;
  }
}
