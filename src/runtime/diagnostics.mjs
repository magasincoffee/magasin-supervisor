import fs from "node:fs/promises";
import path from "node:path";

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeProject(projectState = {}) {
  return {
    current_phase: String(projectState.current_phase || ""),
    current_task: String(projectState.current_task || ""),
    current_task_title: String(projectState.current_task_title || ""),
    status: String(projectState.status || ""),
    autonomy: String(projectState.autonomy || ""),
    blocked: Boolean(projectState.blocked),
    requires_user: Boolean(projectState.requires_user),
    owner_boundary_pending:
      Array.isArray(projectState?.owner_boundary?.pending)
        ? projectState.owner_boundary.pending.map((value) => String(value))
        : [],
    activation_boundary_reason:
      String(projectState?.activation_boundary?.reason || ""),
    activation_boundary_pending:
      Array.isArray(projectState?.activation_boundary?.pending)
        ? projectState.activation_boundary.pending.map((value) => String(value))
        : []
  };
}

function safeUi(probe = {}) {
  const snapshot = probe.snapshot || {};
  const classification = probe.classification || {};
  return {
    ui_state: String(classification.uiState || ""),
    observation: String(classification.observation || ""),
    response_running: Boolean(snapshot.responseRunning),
    main_busy: Boolean(snapshot.mainBusy),
    has_stop_control: Boolean(snapshot.hasStopControl),
    composer_ready: Boolean(snapshot.composerReady),
    path_kind: String(snapshot.pathKind || ""),
    user_message_count: safeNumber(snapshot.userMessageCount),
    assistant_message_count: safeNumber(snapshot.assistantMessageCount),
    last_message_role: String(snapshot.lastMessageRole || ""),
    last_message_char_count: safeNumber(snapshot.lastMessageCharCount),
    last_assistant_char_count: safeNumber(snapshot.lastAssistantCharCount),
    max_conversation_turn_ordinal: safeNumber(snapshot.maxConversationTurnOrdinal)
  };
}

function safeResult(result = {}) {
  return {
    effective_observation: String(result.effectiveObservation || ""),
    work_ui_settled: Boolean(result.workUiSettled),
    decision_action: String(result?.decision?.action || ""),
    decision_reason: String(result?.decision?.reason || ""),
    execution_executed: Boolean(result?.execution?.executed),
    execution_target: String(result?.execution?.target || ""),
    execution_reason: String(result?.execution?.reason || "")
  };
}

function safeController(controller) {
  return {
    armed: Boolean(controller?.armed),
    assistant_count_at_action:
      controller?.assistantCountAtAction == null
        ? null
        : safeNumber(controller.assistantCountAtAction),
    turn_ordinal_at_action:
      controller?.turnOrdinalAtAction == null
        ? null
        : safeNumber(controller.turnOrdinalAtAction),
    saw_running_after_action: Boolean(controller?.sawRunningAfterAction),
    user_pending_saw_progress: Boolean(controller?.userPendingSawProgress),
    last_action_at_ms: safeNumber(controller?.lastActionAt)
  };
}

function safeOwnerState(ownerReconcileState, manualOwnerRecheck) {
  return {
    manual_recheck_marker: Boolean(manualOwnerRecheck),
    boundary_present: Boolean(ownerReconcileState),
    attempted: Boolean(ownerReconcileState?.attempted),
    awaiting_response: Boolean(ownerReconcileState?.awaitingResponse),
    settled_turn:
      ownerReconcileState?.settledTurn == null
        ? null
        : safeNumber(ownerReconcileState.settledTurn)
  };
}

function safeRecovery(recovery) {
  return {
    blocked: Boolean(recovery?.blocked),
    last_action: String(recovery?.lastAction || "")
  };
}

function isoFilePart(value) {
  return value.replace(/[:.]/g, "-");
}

export class SupervisorDiagnostics {
  constructor({
    root,
    runtimeVersion,
    incidentThreshold = 3,
    incidentCooldownMs = 60_000,
    now = () => Date.now()
  }) {
    this.root = path.join(root, "diagnostics");
    this.incidentsDir = path.join(this.root, "incidents");
    this.latestPath = path.join(this.root, "latest.json");
    this.incidentLogPath = path.join(this.root, "incidents.ndjson");
    this.runtimeVersion = runtimeVersion;
    this.incidentThreshold = incidentThreshold;
    this.incidentCooldownMs = incidentCooldownMs;
    this.now = now;
    this.lastSignature = "";
    this.sameSignatureCount = 0;
    this.lastIncidentSignature = "";
    this.lastIncidentAt = 0;
  }

  async ensure() {
    await fs.mkdir(this.incidentsDir, { recursive: true });
  }

  buildSnapshot({
    projectState,
    probe,
    result,
    controller,
    ownerReconcileState,
    manualOwnerRecheck = false,
    recovery
  }) {
    return {
      timestamp: new Date(this.now()).toISOString(),
      runtime_version: this.runtimeVersion,
      project: safeProject(projectState),
      ui: safeUi(probe),
      step: safeResult(result),
      controller: safeController(controller),
      owner_reconcile: safeOwnerState(
        ownerReconcileState,
        manualOwnerRecheck
      ),
      recovery: safeRecovery(recovery)
    };
  }

  classifyIncident(snapshot) {
    const reason = snapshot.step.execution_reason;
    if (
      snapshot.owner_reconcile.awaiting_response &&
      snapshot.step.effective_observation === "RESPONSE_COMPLETE" &&
      !snapshot.controller.armed
    ) {
      return "OWNER_RECONCILE_LATCH_STALL";
    }
    if (
      snapshot.step.decision_action === "CONTINUE" &&
      !snapshot.step.execution_executed &&
      reason === "awaiting observable assistant progress"
    ) {
      return "CONTINUE_PROGRESS_LATCH_STALL";
    }
    if (
      snapshot.project.status === "WAIT_USER" &&
      snapshot.ui.observation === "RESPONSE_COMPLETE" &&
      snapshot.step.decision_action === "STOP_WAIT_USER" &&
      (
        snapshot.owner_reconcile.awaiting_response ||
        snapshot.owner_reconcile.manual_recheck_marker
      )
    ) {
      return "WAIT_USER_RECONCILE_STALL";
    }
    return "";
  }

  async writeLatest(snapshot) {
    await this.ensure();
    const temp = this.latestPath + ".tmp";
    await fs.writeFile(temp, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    await fs.rename(temp, this.latestPath);
  }

  async recordStep(context) {
    const snapshot = this.buildSnapshot(context);
    await this.writeLatest(snapshot);

    const kind = this.classifyIncident(snapshot);
    if (!kind) {
      this.lastSignature = "";
      this.sameSignatureCount = 0;
      return { incident: false, kind: "" };
    }

    const signature = [
      kind,
      snapshot.project.current_task,
      snapshot.project.status,
      snapshot.ui.observation,
      snapshot.step.decision_action,
      snapshot.step.execution_reason,
      String(snapshot.controller.armed),
      String(snapshot.owner_reconcile.awaiting_response)
    ].join("|");

    if (signature === this.lastSignature) {
      this.sameSignatureCount += 1;
    } else {
      this.lastSignature = signature;
      this.sameSignatureCount = 1;
    }

    if (this.sameSignatureCount < this.incidentThreshold) {
      return { incident: false, kind };
    }

    const now = this.now();
    if (
      signature === this.lastIncidentSignature &&
      now - this.lastIncidentAt < this.incidentCooldownMs
    ) {
      return { incident: false, kind };
    }

    const incident = {
      ...snapshot,
      incident: {
        kind,
        repeated_steps: this.sameSignatureCount
      }
    };
    const stamp = isoFilePart(incident.timestamp);
    const filePath = path.join(
      this.incidentsDir,
      `${stamp}__${kind}.json`
    );

    await fs.writeFile(filePath, JSON.stringify(incident, null, 2) + "\n", "utf8");
    await fs.appendFile(
      this.incidentLogPath,
      JSON.stringify({
        timestamp: incident.timestamp,
        kind,
        current_task: incident.project.current_task,
        project_status: incident.project.status,
        observation: incident.ui.observation,
        decision_action: incident.step.decision_action,
        execution_reason: incident.step.execution_reason,
        file: path.basename(filePath)
      }) + "\n",
      "utf8"
    );

    this.lastIncidentSignature = signature;
    this.lastIncidentAt = now;
    return { incident: true, kind, filePath };
  }

  async recordError({
    projectState,
    error,
    ownerReconcileState,
    recovery
  }) {
    const snapshot = {
      timestamp: new Date(this.now()).toISOString(),
      runtime_version: this.runtimeVersion,
      project: safeProject(projectState),
      error: {
        name: String(error?.name || "Error"),
        message: String(error?.message || "").slice(0, 500)
      },
      owner_reconcile: safeOwnerState(ownerReconcileState, false),
      recovery: safeRecovery(recovery)
    };
    await this.ensure();
    const stamp = isoFilePart(snapshot.timestamp);
    const filePath = path.join(
      this.incidentsDir,
      `${stamp}__LOOP_ERROR.json`
    );
    await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    await fs.appendFile(
      this.incidentLogPath,
      JSON.stringify({
        timestamp: snapshot.timestamp,
        kind: "LOOP_ERROR",
        current_task: snapshot.project.current_task,
        project_status: snapshot.project.status,
        error_name: snapshot.error.name,
        file: path.basename(filePath)
      }) + "\n",
      "utf8"
    );
    return filePath;
  }
}
