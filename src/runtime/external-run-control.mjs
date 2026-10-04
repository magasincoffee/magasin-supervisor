const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TOKEN_RE = /^[A-Za-z0-9._:/-]{1,240}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const RUN_ID_RE = /^\d+$/;

export const EXTERNAL_RUN_HEADER = "MAGASIN_EXTERNAL_RUN_V1";
export const EXTERNAL_RUN_FOOTER = "END_MAGASIN_EXTERNAL_RUN_V1";

export const ACTIVE_EXTERNAL_STATUSES = new Set([
  "queued",
  "pending",
  "requested",
  "waiting",
  "in_progress"
]);

export const TERMINAL_EXTERNAL_CONCLUSIONS = new Set([
  "success",
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "neutral",
  "skipped",
  "stale",
  "startup_failure"
]);

function normalizeNone(value) {
  const raw = String(value ?? "").trim();
  return !raw || raw.toUpperCase() === "NONE" ? null : raw;
}

function normalizeTaskId(value, field, { nullable = true } = {}) {
  const raw = normalizeNone(value);
  if (!raw) {
    if (nullable) return null;
    throw Object.assign(new Error(`${field} is required`), {
      code: "EXTERNAL_RUN_PROTOCOL_INVALID"
    });
  }
  if (!TASK_ID_RE.test(raw)) {
    throw Object.assign(new Error(`invalid ${field}`), {
      code: "EXTERNAL_RUN_PROTOCOL_INVALID"
    });
  }
  return raw;
}

function normalizeToken(value, field, { nullable = true, max = 240 } = {}) {
  const raw = normalizeNone(value);
  if (!raw) {
    if (nullable) return null;
    throw Object.assign(new Error(`${field} is required`), {
      code: "EXTERNAL_RUN_PROTOCOL_INVALID"
    });
  }
  if (raw.length > max || !TOKEN_RE.test(raw)) {
    throw Object.assign(new Error(`invalid ${field}`), {
      code: "EXTERNAL_RUN_PROTOCOL_INVALID"
    });
  }
  return raw;
}

function normalizeIso(value) {
  const raw = normalizeNone(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw Object.assign(new Error("invalid LAST_PROGRESS_AT"), {
      code: "EXTERNAL_RUN_PROTOCOL_INVALID"
    });
  }
  return parsed.toISOString();
}

function parseFields(body, renderedWhitespaceFallback) {
  const fields = new Map();
  const rows = renderedWhitespaceFallback
    ? String(body || "").trim().split(/\s+/)
    : String(body || "").split(/\r?\n/);

  for (const raw of rows) {
    const line = raw.trim();
    if (!line) continue;
    const match = renderedWhitespaceFallback
      ? /^([A-Z_]+)=(\S*)$/.exec(line)
      : /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match) {
      throw Object.assign(new Error("malformed external-run line"), {
        code: "EXTERNAL_RUN_PROTOCOL_INVALID"
      });
    }
    fields.set(match[1], match[2].trim());
  }
  return fields;
}

export function parseExternalRunControl(text) {
  const source = String(text || "")
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\r\n/g, "\n");

  const canonical = /(?:^|\n)MAGASIN_EXTERNAL_RUN_V1\n([\s\S]*?)\nEND_MAGASIN_EXTERNAL_RUN_V1(?=\n|$)/g;
  let match = null;
  let renderedWhitespaceFallback = false;
  for (const candidate of source.matchAll(canonical)) match = candidate;

  if (!match) {
    const rendered = /(?:^|\s)MAGASIN_EXTERNAL_RUN_V1\s+([\s\S]*?)\s+END_MAGASIN_EXTERNAL_RUN_V1(?=\s|$)/g;
    for (const candidate of source.matchAll(rendered)) match = candidate;
    renderedWhitespaceFallback = Boolean(match);
  }

  if (!match) return null;

  const fields = parseFields(match[1], renderedWhitespaceFallback);
  const required = [
    "TASK_ID",
    "CHECKPOINT_ID",
    "REPO",
    "COMMIT_SHA",
    "WORKFLOW_RUN_ID",
    "WORKFLOW_NAME",
    "WORKFLOW_STATUS",
    "WORKFLOW_CONCLUSION",
    "FAILURE_SIGNATURE",
    "FAILURE_COUNT",
    "LAST_ACTION",
    "NEXT_ACTION",
    "LAST_PROGRESS_AT",
    "OWNER_REQUIRED"
  ];
  for (const key of required) {
    if (!fields.has(key)) {
      throw Object.assign(new Error(`external-run block missing ${key}`), {
        code: "EXTERNAL_RUN_PROTOCOL_INVALID"
      });
    }
  }

  const taskId = normalizeTaskId(fields.get("TASK_ID"), "TASK_ID", {
    nullable: false
  });
  const checkpointId = normalizeTaskId(fields.get("CHECKPOINT_ID"), "CHECKPOINT_ID");
  const repo = normalizeNone(fields.get("REPO"));
  if (!repo || !REPO_RE.test(repo)) {
    throw Object.assign(new Error("invalid REPO"), {
      code: "EXTERNAL_RUN_PROTOCOL_INVALID"
    });
  }

  const commitSha = normalizeNone(fields.get("COMMIT_SHA"));
  if (commitSha && !SHA_RE.test(commitSha)) {
    throw Object.assign(new Error("invalid COMMIT_SHA"), {
      code: "EXTERNAL_RUN_PROTOCOL_INVALID"
    });
  }

  const workflowRunId = normalizeNone(fields.get("WORKFLOW_RUN_ID"));
  if (workflowRunId && !RUN_ID_RE.test(workflowRunId)) {
    throw Object.assign(new Error("invalid WORKFLOW_RUN_ID"), {
      code: "EXTERNAL_RUN_PROTOCOL_INVALID"
    });
  }

  const workflowName = normalizeToken(
    fields.get("WORKFLOW_NAME"),
    "WORKFLOW_NAME",
    { nullable: false, max: 160 }
  );

  const workflowStatus = String(fields.get("WORKFLOW_STATUS") || "")
    .trim()
    .toLowerCase();
  if (
    !ACTIVE_EXTERNAL_STATUSES.has(workflowStatus) &&
    !["completed", "not_found", "unknown"].includes(workflowStatus)
  ) {
    throw Object.assign(new Error("invalid WORKFLOW_STATUS"), {
      code: "EXTERNAL_RUN_PROTOCOL_INVALID"
    });
  }

  const conclusionRaw = normalizeNone(fields.get("WORKFLOW_CONCLUSION"));
  const workflowConclusion = conclusionRaw
    ? conclusionRaw.toLowerCase()
    : null;
  if (
    workflowConclusion &&
    !TERMINAL_EXTERNAL_CONCLUSIONS.has(workflowConclusion)
  ) {
    throw Object.assign(new Error("invalid WORKFLOW_CONCLUSION"), {
      code: "EXTERNAL_RUN_PROTOCOL_INVALID"
    });
  }
  if (ACTIVE_EXTERNAL_STATUSES.has(workflowStatus) && workflowConclusion) {
    throw Object.assign(new Error("active external run cannot have a conclusion"), {
      code: "EXTERNAL_RUN_PROTOCOL_INVALID"
    });
  }
  if (workflowStatus === "completed" && !workflowConclusion) {
    throw Object.assign(new Error("completed external run requires a conclusion"), {
      code: "EXTERNAL_RUN_PROTOCOL_INVALID"
    });
  }

  const failureSignature = normalizeToken(
    fields.get("FAILURE_SIGNATURE"),
    "FAILURE_SIGNATURE",
    { nullable: true, max: 200 }
  );
  const failureCount = Number(fields.get("FAILURE_COUNT"));
  if (!Number.isInteger(failureCount) || failureCount < 0 || failureCount > 999) {
    throw Object.assign(new Error("invalid FAILURE_COUNT"), {
      code: "EXTERNAL_RUN_PROTOCOL_INVALID"
    });
  }

  const lastAction = normalizeToken(fields.get("LAST_ACTION"), "LAST_ACTION", {
    nullable: true,
    max: 120
  });
  const nextAction = normalizeToken(fields.get("NEXT_ACTION"), "NEXT_ACTION", {
    nullable: true,
    max: 120
  });
  const lastProgressAt = normalizeIso(fields.get("LAST_PROGRESS_AT"));

  const ownerRequiredRaw = String(fields.get("OWNER_REQUIRED") || "")
    .trim()
    .toLowerCase();
  if (!["true", "false"].includes(ownerRequiredRaw)) {
    throw Object.assign(new Error("invalid OWNER_REQUIRED"), {
      code: "EXTERNAL_RUN_PROTOCOL_INVALID"
    });
  }

  return {
    task_id: taskId,
    checkpoint_id: checkpointId,
    repo,
    commit_sha: commitSha,
    workflow_run_id: workflowRunId,
    workflow_name: workflowName,
    workflow_status: workflowStatus,
    workflow_conclusion: workflowConclusion,
    failure_signature: failureSignature,
    failure_count: failureCount,
    last_action: lastAction,
    next_action: nextAction,
    last_progress_at: lastProgressAt,
    owner_required: ownerRequiredRaw === "true"
  };
}

export function externalRunContractLines() {
  return [
    "When STATUS=RUNNING is based on an external CI/deployment/job, append exactly one external-run block after the task-control block.",
    "For a terminal external run, append the same block even when STATUS is READY/BLOCKED/COMPLETE so the Supervisor can persist the evidence.",
    EXTERNAL_RUN_HEADER,
    "TASK_ID=<same authoritative SOT task id>",
    "CHECKPOINT_ID=<internal checkpoint id or NONE>",
    "REPO=<owner/repo>",
    "COMMIT_SHA=<git sha or NONE>",
    "WORKFLOW_RUN_ID=<numeric run id or NONE>",
    "WORKFLOW_NAME=<single_token_name>",
    "WORKFLOW_STATUS=<queued|pending|requested|waiting|in_progress|completed|not_found|unknown>",
    "WORKFLOW_CONCLUSION=<success|failure|cancelled|timed_out|action_required|neutral|skipped|stale|startup_failure|NONE>",
    "FAILURE_SIGNATURE=<stable_token_or_hash_or_NONE>",
    "FAILURE_COUNT=<0-999>",
    "LAST_ACTION=<single_token_or_NONE>",
    "NEXT_ACTION=<single_token_or_NONE>",
    "LAST_PROGRESS_AT=<ISO-8601 timestamp or NONE>",
    "OWNER_REQUIRED=<true|false>",
    EXTERNAL_RUN_FOOTER,
    "External-run state rules: queued/pending/requested/waiting/in_progress => RUNNING; completed+success => verify/advance; completed+failure => READY for the same TASK_ID so AUTO_REPAIR executes; cancelled/timed_out/action_required => retry/repair unless OWNER_REQUIRED=true; not_found => READY for the same TASK_ID to diagnose/trigger rather than wait.",
    "Never report RUNNING merely because PASS is absent. A completed failed run is terminal evidence, not a wait condition."
  ];
}

function sameRun(previous = {}, evidence = {}) {
  const prevRun = String(previous.workflow_run_id || "");
  const nextRun = String(evidence.workflow_run_id || "");
  if (prevRun || nextRun) return prevRun === nextRun;
  return (
    String(previous.commit_sha || "") === String(evidence.commit_sha || "") &&
    String(previous.workflow_name || "") === String(evidence.workflow_name || "")
  );
}

function failureKey(evidence) {
  if (evidence.failure_signature) return evidence.failure_signature;
  if (evidence.workflow_status === "not_found") {
    return `NO_RUN:${evidence.workflow_name}:${evidence.commit_sha || "NONE"}`;
  }
  return `${evidence.workflow_conclusion || "unknown"}:${evidence.workflow_name}`;
}

function progressToken(evidence) {
  return [
    evidence.commit_sha || "NONE",
    evidence.workflow_run_id || "NONE",
    evidence.workflow_status || "unknown",
    evidence.workflow_conclusion || "NONE",
    evidence.last_action || "NONE"
  ].join("|");
}

function appendHistory(previous = {}, evidence, nowIso) {
  const history = Array.isArray(previous.history)
    ? previous.history.map((item) => ({ ...item }))
    : [];
  if (
    evidence.workflow_status !== "completed" &&
    evidence.workflow_status !== "not_found"
  ) {
    return history.slice(-8);
  }

  const key = [
    evidence.workflow_run_id || "NONE",
    evidence.commit_sha || "NONE",
    evidence.workflow_conclusion || evidence.workflow_status
  ].join("|");
  const exists = history.some((item) => item.key === key);
  if (!exists) {
    history.push({
      key,
      workflow_run_id: evidence.workflow_run_id,
      commit_sha: evidence.commit_sha,
      conclusion: evidence.workflow_conclusion || evidence.workflow_status,
      failure_signature: evidence.failure_signature,
      observed_at: nowIso
    });
  }
  return history.slice(-8);
}

export function reconcileExternalRunState({
  previous = null,
  evidence,
  sourceKind = "TASK_STATUS_CHECK",
  maxRepairAttempts = 3,
  now = () => new Date().toISOString()
} = {}) {
  if (!evidence) return { decision: "NONE", external_work: previous || null };
  const at = new Date(typeof now === "function" ? now() : now).toISOString();
  const prior = previous || {};
  const active = ACTIVE_EXTERNAL_STATUSES.has(evidence.workflow_status);
  const terminalFailure = (
    evidence.workflow_status === "completed" &&
    evidence.workflow_conclusion !== "success"
  );
  const noRun = evidence.workflow_status === "not_found";
  const signature = terminalFailure || noRun ? failureKey(evidence) : null;
  const sameFailure = Boolean(
    signature && prior.failure_signature && prior.failure_signature === signature
  );
  const sameObservedRun = sameRun(prior, evidence);
  const sameProgress =
    String(prior.progress_token || "") === progressToken(evidence);

  let repairAttempt = Number(prior.repair_attempt || 0);
  if (terminalFailure || noRun) {
    if (!sameFailure) {
      repairAttempt = 1;
    } else if (!sameObservedRun) {
      repairAttempt += 1;
    } else if (
      String(sourceKind || "").toUpperCase() === "TASK_EXECUTION" &&
      sameProgress
    ) {
      // An execution turn returned the same terminal evidence without a new
      // commit/run/evidence token: that repair attempt made no concrete progress.
      repairAttempt += 1;
    } else {
      repairAttempt = Math.max(1, repairAttempt);
    }
  } else if (
    evidence.workflow_status === "completed" &&
    evidence.workflow_conclusion === "success"
  ) {
    repairAttempt = 0;
  }

  let decision = "NONE";
  if (active) {
    decision = "WAIT_EXTERNAL";
  } else if (
    evidence.workflow_status === "completed" &&
    evidence.workflow_conclusion === "success"
  ) {
    decision = "VERIFY_EXTERNAL_SUCCESS";
  } else if (evidence.owner_required) {
    decision = "BLOCKED_OWNER";
  } else if (terminalFailure || noRun) {
    decision = repairAttempt > maxRepairAttempts
      ? "BLOCKED_REPAIR_LIMIT"
      : (noRun ? "TRIGGER_EXTERNAL_RUN" : "AUTO_REPAIR");
  } else {
    decision = "AUTO_REPAIR";
  }

  return {
    decision,
    external_work: {
      task_id: evidence.task_id,
      checkpoint_id: evidence.checkpoint_id,
      repo: evidence.repo,
      commit_sha: evidence.commit_sha,
      workflow_run_id: evidence.workflow_run_id,
      workflow_name: evidence.workflow_name,
      workflow_status: evidence.workflow_status,
      workflow_conclusion: evidence.workflow_conclusion,
      failure_signature: signature || prior.failure_signature || null,
      failure_count: evidence.failure_count,
      repair_attempt: repairAttempt,
      max_repair_attempts: maxRepairAttempts,
      last_action: evidence.last_action,
      next_action: evidence.next_action,
      last_progress_at: evidence.last_progress_at || at,
      owner_required: evidence.owner_required,
      decision,
      progress_token: progressToken(evidence),
      observed_at: at,
      history: appendHistory(prior, evidence, at)
    }
  };
}

export function reconcileTaskControlWithExternalRun({
  taskControl,
  evidence,
  externalWork,
  expectedTaskId,
  defaultCheckAfterSeconds = 120
} = {}) {
  if (!taskControl) throw new Error("taskControl is required");
  if (!evidence || !externalWork) return taskControl;

  const expected = String(expectedTaskId || taskControl.task_id || taskControl.next_task_id || "").trim();
  if (!expected || evidence.task_id !== expected) {
    throw Object.assign(
      new Error("external-run TASK_ID does not match the active authoritative task"),
      { code: "EXTERNAL_RUN_TASK_MISMATCH" }
    );
  }

  const decision = String(externalWork.decision || "");
  if (decision === "WAIT_EXTERNAL") {
    const delay = taskControl.status === "RUNNING" && taskControl.check_after_seconds > 0
      ? taskControl.check_after_seconds
      : defaultCheckAfterSeconds;
    return {
      status: "RUNNING",
      task_id: expected,
      next_task_id: null,
      check_after_seconds: Math.max(1, Math.min(3600, Number(delay) || 120))
    };
  }

  if (decision === "BLOCKED_OWNER" || decision === "BLOCKED_REPAIR_LIMIT") {
    return {
      status: "BLOCKED",
      task_id: expected,
      next_task_id: null,
      check_after_seconds: 0
    };
  }

  if (decision === "VERIFY_EXTERNAL_SUCCESS") {
    if (["COMPLETE", "DONE", "BLOCKED"].includes(taskControl.status)) {
      return taskControl;
    }
    return {
      status: "READY",
      task_id: null,
      next_task_id: expected,
      check_after_seconds: 0
    };
  }

  if (["AUTO_REPAIR", "TRIGGER_EXTERNAL_RUN"].includes(decision)) {
    return {
      status: "READY",
      task_id: null,
      next_task_id: expected,
      check_after_seconds: 0
    };
  }

  return taskControl;
}
