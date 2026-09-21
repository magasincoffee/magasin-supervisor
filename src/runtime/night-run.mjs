export class NightRunContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "NightRunContractError";
  }
}

export class NightRunLeaseBusyError extends Error {
  constructor(message = "night-run cursor lease is active") {
    super(message);
    this.name = "NightRunLeaseBusyError";
  }
}

export const PROJECT_REGISTRY_SCHEMAS = new Set([
  "supervisor-project-registry.v1",
  "business-os-project-registry.v1"
]);

export const EXECUTION_CURSOR_SCHEMAS = new Set([
  "supervisor-execution-cursor.v1",
  "business-os-execution-cursor.v1"
]);

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new NightRunContractError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function instant(value, label) {
  const text = requireString(value, label);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    throw new NightRunContractError(`${label} must be a valid ISO timestamp`);
  }
  return ms;
}

function unique(values) {
  return new Set(values).size === values.length;
}

export function validateNightRunContract({ contract, registry, cursor }) {
  if (!contract || contract.schema_version !== "night-run.v2") {
    throw new NightRunContractError("unsupported night-run contract");
  }
  const runId = requireString(contract.id, "contract.id");
  const startMs = instant(contract.start_at, "contract.start_at");
  const stopMs = instant(contract.stop_at, "contract.stop_at");
  if (startMs >= stopMs) {
    throw new NightRunContractError("night-run start must be before stop");
  }
  if (contract.hard_stop !== true) {
    throw new NightRunContractError("night-run must be hard-stop bounded");
  }

  const allowed = Array.isArray(contract.allowed_projects)
    ? contract.allowed_projects
    : [];
  if (allowed.length === 0) {
    throw new NightRunContractError("night-run must allow at least one project");
  }
  const allowedIds = allowed.map((item, index) =>
    requireString(item?.id, `allowed_projects[${index}].id`)
  );
  if (!unique(allowedIds)) {
    throw new NightRunContractError("allowed project ids must be unique");
  }

  if (!registry || !PROJECT_REGISTRY_SCHEMAS.has(registry.schema_version)) {
    throw new NightRunContractError("unsupported project registry");
  }
  if (registry.discovery_policy !== "DENY_UNREGISTERED") {
    throw new NightRunContractError("project registry must deny unregistered projects");
  }
  const registeredIds = new Set(
    (registry.projects || [])
      .filter((item) => item?.enabled)
      .map((item) => item.id)
  );
  for (const id of allowedIds) {
    if (!registeredIds.has(id)) {
      throw new NightRunContractError(`allowed project is not registered: ${id}`);
    }
  }

  const execution = Array.isArray(contract.execution) ? contract.execution : [];
  if (execution.length === 0) {
    throw new NightRunContractError("night-run execution queue is empty");
  }
  const orders = execution.map((item) => Number(item?.order));
  if (orders.some((value) => !Number.isInteger(value) || value <= 0) || !unique(orders)) {
    throw new NightRunContractError("execution order values must be unique positive integers");
  }
  const sorted = [...execution].sort((a, b) => a.order - b.order);
  let previousStop = startMs;
  for (const item of sorted) {
    requireString(item.task, `execution[${item.order}].task`);
    const itemStart = instant(item.start_at, `execution[${item.order}].start_at`);
    const itemStop = instant(item.stop_at, `execution[${item.order}].stop_at`);
    if (itemStart < startMs || itemStop > stopMs || itemStart >= itemStop) {
      throw new NightRunContractError(`execution slot ${item.order} is outside the night window`);
    }
    if (itemStart < previousStop) {
      throw new NightRunContractError(`execution slot ${item.order} overlaps the previous slot`);
    }
    previousStop = itemStop;
  }

  const requiredForbidden = [
    "SECRET_EXPOSURE",
    "MFA_BYPASS",
    "CAPTCHA_BYPASS",
    "DESTRUCTIVE_PRODUCTION_DB",
    "LIVE_SAYDIVOICE_GENERATE",
    "LIVE_SAYDIVOICE_DOWNLOAD",
    "THIRD_PROJECT_EXECUTION"
  ];
  const forbidden = new Set(contract.forbidden || []);
  for (const rule of requiredForbidden) {
    if (!forbidden.has(rule)) {
      throw new NightRunContractError(`missing forbidden guardrail: ${rule}`);
    }
  }

  if (!cursor || !EXECUTION_CURSOR_SCHEMAS.has(cursor.schema_version)) {
    throw new NightRunContractError("unsupported execution cursor");
  }
  if (cursor.night_run_id !== runId) {
    throw new NightRunContractError("cursor night-run id does not match schedule");
  }
  if (!allowedIds.includes(cursor.project_id)) {
    throw new NightRunContractError("cursor project is outside the approved night run");
  }
  const scheduledTasks = new Set(execution.map((item) => item.task));
  if (!scheduledTasks.has(cursor.task)) {
    throw new NightRunContractError("cursor task is not in the approved execution queue");
  }

  return Object.freeze({
    id: runId,
    startMs,
    stopMs,
    allowedProjectIds: Object.freeze([...allowedIds]),
    execution: Object.freeze(sorted.map((item) => Object.freeze({ ...item })))
  });
}

export function nightRunWindowState(contract, now = new Date()) {
  const startMs = instant(contract.start_at, "contract.start_at");
  const stopMs = instant(contract.stop_at, "contract.stop_at");
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("now must be a valid date");
  }
  if (nowMs < startMs) return "BEFORE";
  if (nowMs >= stopMs) return "EXPIRED";
  return "ACTIVE";
}

export function shouldHardStop(contract, now = new Date()) {
  return nightRunWindowState(contract, now) === "EXPIRED";
}

function normalizedNow(now) {
  const value = new Date(now);
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError("now must be a valid date");
  }
  return value;
}

export function acquireCursorLease(
  cursor,
  { holder, now = new Date(), ttlMs = 10 * 60_000 } = {}
) {
  const leaseHolder = requireString(holder, "lease holder");
  if (!Number.isFinite(ttlMs) || ttlMs < 30_000) {
    throw new TypeError("lease ttl must be at least 30000ms");
  }

  const at = normalizedNow(now);
  const existing = cursor?.lease || null;
  if (existing) {
    const expiresMs = instant(existing.expires_at, "cursor.lease.expires_at");
    if (expiresMs > at.getTime() && existing.holder !== leaseHolder) {
      throw new NightRunLeaseBusyError();
    }
  }

  const acquiredAt = at.toISOString();
  const expiresAt = new Date(at.getTime() + ttlMs).toISOString();
  return {
    ...cursor,
    lease: {
      holder: leaseHolder,
      acquired_at: acquiredAt,
      expires_at: expiresAt
    },
    updated_at: acquiredAt
  };
}

export function checkpointCursor(
  cursor,
  {
    holder,
    projectId,
    task,
    microTask,
    checkpoint,
    lastCommit,
    status = "IN_PROGRESS",
    now = new Date()
  } = {}
) {
  const at = normalizedNow(now);
  const lease = cursor?.lease || null;
  if (lease && holder !== lease.holder) {
    throw new NightRunLeaseBusyError("cursor checkpoint requires the active lease holder");
  }

  return {
    ...cursor,
    project_id: requireString(projectId, "projectId"),
    task: requireString(task, "task"),
    micro_task: requireString(microTask, "microTask"),
    checkpoint: requireString(checkpoint, "checkpoint"),
    last_commit: requireString(lastCommit, "lastCommit"),
    status: requireString(status, "status"),
    updated_at: at.toISOString()
  };
}

export function releaseCursorLease(cursor, { holder, now = new Date() } = {}) {
  if (!cursor?.lease) return { ...cursor, lease: null };
  if (cursor.lease.holder !== holder) {
    throw new NightRunLeaseBusyError("only the active lease holder may release the cursor");
  }
  const at = normalizedNow(now);
  return {
    ...cursor,
    lease: null,
    updated_at: at.toISOString()
  };
}

export function reconcileStaleCursorLease(
  cursor,
  {
    now = new Date(),
    headVerified = false,
    ciVerified = false
  } = {}
) {
  const at = normalizedNow(now);
  const lease = cursor?.lease || null;
  if (!lease) {
    return { action: "NO_LEASE", cursor: { ...cursor } };
  }

  const expiresMs = instant(lease.expires_at, "cursor.lease.expires_at");
  if (expiresMs > at.getTime()) {
    return { action: "LEASE_ACTIVE", cursor: { ...cursor } };
  }

  if (!headVerified || !ciVerified) {
    return {
      action: "WAIT_RECONCILE_HEAD_CI",
      cursor: { ...cursor }
    };
  }

  return {
    action: "STALE_LEASE_RELEASED",
    cursor: {
      ...cursor,
      lease: null,
      updated_at: at.toISOString()
    }
  };
}
