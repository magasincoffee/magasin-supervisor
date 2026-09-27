import {
  assertMachineFrameAction,
  assertMachineFrameCorrelation,
  parseMachineFrame
} from "./machine-frame.mjs";
import {
  BRIDGE_TRANSPORT_PHASES,
  BridgeTransportStateError
} from "./planner-executor-bridge-transport.mjs";

export class BridgeProtocolIntegrationError extends Error {
  constructor(message, {
    code = "BRIDGE_PROTOCOL_INTEGRATION_ERROR",
    cause = null,
    details = null
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "BridgeProtocolIntegrationError";
    this.code = code;
    this.details = details;
  }
}

function requireTurnId(value) {
  const id = String(value || "").trim();
  if (!id || id.length > 512) {
    throw new BridgeProtocolIntegrationError("assistant turn id is required", {
      code: "INVALID_TURN_ID"
    });
  }
  return id;
}

function projectCorrelation(frame, context) {
  if (!context.strict_project_correlation) return;
  if (frame.p !== context.project_id) {
    throw new BridgeProtocolIntegrationError("project_id correlation mismatch", {
      code: "PROJECT_CORRELATION_MISMATCH"
    });
  }
  if (frame.g !== context.project_generation) {
    throw new BridgeProtocolIntegrationError("project_generation correlation mismatch", {
      code: "PROJECT_CORRELATION_MISMATCH"
    });
  }
}

function parse(text) {
  try {
    return parseMachineFrame(text);
  } catch (error) {
    throw new BridgeProtocolIntegrationError("invalid machine frame", {
      code: "INVALID_MACHINE_FRAME",
      cause: error
    });
  }
}

function assertAction(frame, allowed) {
  try {
    return assertMachineFrameAction(frame, allowed);
  } catch (error) {
    throw new BridgeProtocolIntegrationError("machine action invalid for current phase", {
      code: "INVALID_ACTION_FOR_PHASE",
      cause: error,
      details: { action: frame?.a, allowed }
    });
  }
}

function correlate(frame, expected) {
  try {
    return assertMachineFrameCorrelation(frame, expected);
  } catch (error) {
    throw new BridgeProtocolIntegrationError("machine correlation mismatch", {
      code: "FRAME_CORRELATION_MISMATCH",
      cause: error
    });
  }
}

export class PlannerExecutorBridgeProtocolController {
  constructor({
    transport,
    projectId = "LIVE",
    projectGeneration = 1,
    strictProjectCorrelation = false,
    buildExecutorMessage = ({ body }) => String(body || "").trim(),
    buildPlannerMessage = ({ body }) => String(body || "").trim()
  } = {}) {
    if (!transport || typeof transport.plannerEvent !== "function" ||
        typeof transport.executorEvent !== "function") {
      throw new BridgeProtocolIntegrationError("Bridge transport state machine is required", {
        code: "INVALID_TRANSPORT"
      });
    }
    if (typeof buildExecutorMessage !== "function" ||
        typeof buildPlannerMessage !== "function") {
      throw new BridgeProtocolIntegrationError("message builders must be functions", {
        code: "INVALID_MESSAGE_BUILDER"
      });
    }

    this.transport = transport;
    this.context = {
      project_id: String(projectId || "").trim(),
      project_generation: Number(projectGeneration),
      strict_project_correlation: Boolean(strictProjectCorrelation),
      current_task_id: null,
      current_assignment_id: null,
      current_result_id: null,
      seen_assignment_ids: new Set(),
      seen_result_ids: new Set(),
      seen_turn_ids: new Set()
    };
    this.buildExecutorMessage = buildExecutorMessage;
    this.buildPlannerMessage = buildPlannerMessage;
  }

  snapshot() {
    return {
      transport: this.transport.snapshot(),
      project_id: this.context.project_id,
      project_generation: this.context.project_generation,
      current_task_id: this.context.current_task_id,
      current_assignment_id: this.context.current_assignment_id,
      current_result_id: this.context.current_result_id
    };
  }

  #beginTurn(turnId) {
    const id = requireTurnId(turnId);
    if (this.context.seen_turn_ids.has(id)) {
      throw new BridgeProtocolIntegrationError("duplicate assistant turn", {
        code: "DUPLICATE_TURN"
      });
    }
    return id;
  }

  #commitTurn(turnId) {
    this.context.seen_turn_ids.add(turnId);
  }

  #freshAssignment(id) {
    if (this.context.seen_assignment_ids.has(id)) {
      throw new BridgeProtocolIntegrationError("assignment_id reuse is not allowed", {
        code: "DUPLICATE_ASSIGNMENT_ID"
      });
    }
  }

  #freshResult(id) {
    if (this.context.seen_result_ids.has(id)) {
      throw new BridgeProtocolIntegrationError("result_id reuse is not allowed", {
        code: "DUPLICATE_RESULT_ID"
      });
    }
  }

  async consumePlannerTurn(text, { turnId } = {}) {
    const id = this.#beginTurn(turnId);
    const parsed = parse(text);
    const { frame, body } = parsed;
    projectCorrelation(frame, this.context);

    const phase = this.transport.snapshot().phase;
    const initial = phase === BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER;
    const decision = phase === BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER_DECISION;
    if (!initial && !decision) {
      throw new BridgeProtocolIntegrationError("Planner turn arrived in impossible phase", {
        code: "IMPOSSIBLE_PHASE",
        details: { phase }
      });
    }

    assertAction(
      frame,
      initial
        ? ["assign", "blocked", "done"]
        : ["accept_assign", "reject", "blocked", "done"]
    );

    if (frame.a === "assign") {
      this.#freshAssignment(frame.i);
      const message = this.buildExecutorMessage({ frame, body, kind: "assign" });
      const outcome = await this.transport.plannerEvent({
        action: "assign",
        message
      });
      this.context.current_task_id = frame.t;
      this.context.current_assignment_id = frame.i;
      this.context.current_result_id = null;
      this.context.seen_assignment_ids.add(frame.i);
      this.#commitTurn(id);
      return { parsed, outcome };
    }

    if (frame.a === "accept_assign") {
      correlate(frame, {
        taskId: this.context.current_task_id,
        resultId: this.context.current_result_id
      });
      this.#freshAssignment(frame.i);
      const message = this.buildExecutorMessage({
        frame,
        body,
        kind: "accept_assign"
      });
      const outcome = await this.transport.plannerEvent({
        action: "accept_assign",
        message
      });
      this.context.current_task_id = frame.n;
      this.context.current_assignment_id = frame.i;
      this.context.current_result_id = null;
      this.context.seen_assignment_ids.add(frame.i);
      this.#commitTurn(id);
      return { parsed, outcome };
    }

    if (frame.a === "reject") {
      correlate(frame, {
        taskId: this.context.current_task_id,
        resultId: this.context.current_result_id
      });
      if (frame.i && body) {
        this.#freshAssignment(frame.i);
        const message = this.buildExecutorMessage({
          frame,
          body,
          kind: "reject"
        });
        const outcome = await this.transport.plannerEvent({
          action: "reject",
          message
        });
        this.context.current_assignment_id = frame.i;
        this.context.current_result_id = null;
        this.context.seen_assignment_ids.add(frame.i);
        this.#commitTurn(id);
        return { parsed, outcome };
      }

      const outcome = await this.transport.plannerEvent({ action: "blocked" });
      this.#commitTurn(id);
      return { parsed, outcome, bounded_correction: false };
    }

    if (frame.a === "done" && decision) {
      correlate(frame, {
        taskId: this.context.current_task_id,
        resultId: this.context.current_result_id
      });
    }

    const outcome = await this.transport.plannerEvent({ action: frame.a });
    this.#commitTurn(id);
    return { parsed, outcome };
  }

  async consumeExecutorTurn(text, { turnId } = {}) {
    const id = this.#beginTurn(turnId);
    const parsed = parse(text);
    const { frame, body } = parsed;
    projectCorrelation(frame, this.context);

    if (this.transport.snapshot().phase !== BRIDGE_TRANSPORT_PHASES.WAIT_EXECUTOR) {
      throw new BridgeProtocolIntegrationError("Executor turn arrived in impossible phase", {
        code: "IMPOSSIBLE_PHASE"
      });
    }

    assertAction(frame, ["report"]);
    correlate(frame, {
      taskId: this.context.current_task_id,
      assignmentId: this.context.current_assignment_id
    });
    this.#freshResult(frame.r);

    const message = this.buildPlannerMessage({ frame, body, kind: "report" });
    const outcome = await this.transport.executorEvent({
      action: "report",
      message
    });
    this.context.current_result_id = frame.r;
    this.context.seen_result_ids.add(frame.r);
    this.#commitTurn(id);
    return { parsed, outcome };
  }
}

export function createPlannerExecutorBridgeProtocolController(options) {
  try {
    return new PlannerExecutorBridgeProtocolController(options);
  } catch (error) {
    if (error instanceof BridgeProtocolIntegrationError) throw error;
    if (error instanceof BridgeTransportStateError) {
      throw new BridgeProtocolIntegrationError("Bridge transport rejected protocol initialization", {
        code: "INVALID_TRANSPORT",
        cause: error
      });
    }
    throw error;
  }
}
