/**
 * SC-013 project-fault isolation contract.
 * A project's failure is NOT automatically a Supervisor global failure.
 * Pending exact-once outbound is separately fenced: no resend, reassignment,
 * acknowledgement or new send until that transaction is reconciled.
 *
 * Pure decisions only: this module never clears STOP, edits the transaction
 * ledger, schedules work, or claims a worker is running.
 */
const UNCERTAIN_OUTBOUND = new Set([
  "PREPARED", "ENQUEUED", "DELIVERED", "RESPONSE_RUNNING", "UNKNOWN", "SENDING"
]);
const PROJECT_ERRORS = new Set([
  "TASK_PROTOCOL_INVALID", "PROJECT_CI_FAILED", "PROJECT_QA_FAILED",
  "PROJECT_OWNER_REVIEW_REQUIRED", "PROJECT_SOT_BLOCKED",
  "PROJECT_EXTERNAL_WORK_FAILED", "PROJECT_DEPENDENCY_UNAVAILABLE"
]);
const TRANSPORT_ERRORS = new Set([
  "AMBIGUOUS_ENQUEUED_OUTCOME", "AMBIGUOUS_POST_SEND_DELIVERY",
  "POST_SEND_CONFIRMATION_PENDING", "TASK_BASELINE_UNVERIFIED",
  "OUTBOUND_DIGEST_MISMATCH", "CDP_RECOVERY_REQUIRED",
  "RUNTIME_RESTART_ENQUEUED_TASK_UNRESOLVED"
]);

/**
 * @returns classification independent of current process lifecycle.
 * "monitor_other_projects" is a CAPABILITY requirement, NOT a dispatch grant.
 */
export function classifySupervisorFault({
  projectId = null,
  taskId = null,
  errorCode = null,
  outboundState = "NONE",
  ownerStop = false,
  autostartDisabled = false,
  workerRunning = false,
  independentMonitorAvailable = false
} = {}) {
  const normalizedOutbound = String(outboundState || "UNKNOWN").toUpperCase();
  const code = String(errorCode || "UNKNOWN").toUpperCase();
  const pending = UNCERTAIN_OUTBOUND.has(normalizedOutbound);
  const stop = ownerStop === true || autostartDisabled === true;
  const project = String(projectId || "").trim() || null;
  const task = String(taskId || "").trim() || null;
  const transport = TRANSPORT_ERRORS.has(code) || pending;
  const projectFailure = PROJECT_ERRORS.has(code) && !transport;
  const legitimateProjectId = Boolean(project && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(project));

  // Owner STOP and transaction fences always outrank liveness preferences.
  const dispatchAuthorized = !stop && !transport && !projectFailure &&
    workerRunning === true;
  let category = "SUPERVISOR_RUNTIME_FAULT";
  if (stop) category = "OWNER_STOPPED";
  else if (transport) category = "OUTBOUND_TRANSACTION_QUARANTINED";
  else if (projectFailure) category = "PROJECT_BLOCKED";

  return Object.freeze({
    category,
    task_id: task,
    project_id: legitimateProjectId ? project : null,
    project_blocked: projectFailure || (transport && legitimateProjectId),
    transaction_quarantined: transport,
    pending_outbound: pending,
    may_resend_uncertain_transaction: false,
    may_clear_owner_stop: false,
    may_clear_outbound_ledger: false,
    supervisor_worker_running: workerRunning === true,
    independent_monitor_active: independentMonitorAvailable === true,
    // Read-only, independent health monitoring can remain active during STOP.
    // Never equate it with a live command-sending Supervisor worker.
    independent_monitor_may_observe: independentMonitorAvailable === true,
    worker_dispatch_authorized: dispatchAuthorized,
    // Project isolation needs a separately qualified multi-project scheduler.
    // The existing SINGLE_CONVERSATION_V1 runtime does not provide one.
    can_dispatch_other_projects: false,
    other_projects_dispatch_gate: "SEPARATE_MULTI_PROJECT_EXECUTOR_NOT_QUALIFIED",
    require_owner_lifecycle_for_start: stop,
    explanation: stop
      ? "Owner STOP applies; independent read-only monitoring may continue."
      : transport
        ? "Outbound outcome is ambiguous; quarantine and observe, never replay."
        : projectFailure
          ? "Project fault is isolated in status; do not promote it to a global Supervisor fault."
          : "Supervisor fault requires diagnosis."
  });
}

export function assertNoUnsafeProjectFaultPromotion(result) {
  if (!result || typeof result !== "object") throw Error("fault result missing");
  if (result.transaction_quarantined === true &&
      (result.may_resend_uncertain_transaction !== false ||
       result.worker_dispatch_authorized === true)) {
    throw Error("unsafe transaction promotion");
  }
  if (result.can_dispatch_other_projects === true &&
      result.other_projects_dispatch_gate !== "QUALIFIED") {
    throw Error("unqualified cross-project dispatch");
  }
  if (result.may_clear_owner_stop !== false ||
      result.may_clear_outbound_ledger !== false) {
    throw Error("unsafe Owner or ledger override");
  }
  return result;
}
