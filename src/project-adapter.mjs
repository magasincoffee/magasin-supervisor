import fs from "node:fs/promises";

export const PROJECT_INPUT_SCHEMA = "supervisor-project-input.v1";
export const PROJECT_INPUT_PATH_ENV = "MAGASIN_SUPERVISOR_PROJECT_INPUT";
export const PROJECT_INPUT_URL_ENV = "MAGASIN_SUPERVISOR_PROJECT_INPUT_URL";

export const PROJECT_STATUSES = new Set([
  "READY",
  "RUNNING",
  "TESTING",
  "FIXING",
  "WAIT_CI",
  "WAIT_USER",
  "BLOCKED",
  "DONE"
]);

export const AUTONOMY_MODES = new Set([
  "AUTO_CONTINUE",
  "MANUAL",
  "PAUSED"
]);

function requireString(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`project input field ${field} must be a non-empty string`);
  return text;
}

function optionalString(value, field) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new TypeError(`project input field ${field} must be string or null`);
  }
  return value.trim() || null;
}

function sanitizeBoundary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({ pending: [] });
  }
  const pending = Array.isArray(value.pending)
    ? value.pending.map((item) => String(item)).filter(Boolean)
    : [];
  return Object.freeze({ pending });
}

function sanitizeOrchestration(value) {
  const legacyMax = value?.workers?.max_parallel_workers;
  const directMax = value?.max_parallel_workers;
  const candidate = directMax ?? legacyMax ?? 3;
  const maxParallelWorkers = Number(candidate);
  if (!Number.isInteger(maxParallelWorkers) || maxParallelWorkers < 1 || maxParallelWorkers > 12) {
    throw new TypeError("project input orchestration.max_parallel_workers must be an integer between 1 and 12");
  }

  const mode = optionalString(value?.mode, "orchestration.mode");
  const bootstrapAuthorized = Boolean(value?.brain?.bootstrap_authorized);

  return Object.freeze({
    mode,
    brain: Object.freeze({ bootstrap_authorized: bootstrapAuthorized }),
    max_parallel_workers: maxParallelWorkers
  });
}

export function validateProjectInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("project input must be a JSON object");
  }

  const status = requireString(value.status, "status");
  const autonomy = requireString(value.autonomy, "autonomy");
  if (!PROJECT_STATUSES.has(status)) {
    throw new TypeError(`unsupported project status: ${status}`);
  }
  if (!AUTONOMY_MODES.has(autonomy)) {
    throw new TypeError(`unsupported autonomy mode: ${autonomy}`);
  }
  for (const key of ["blocked", "requires_user"]) {
    if (typeof value[key] !== "boolean") {
      throw new TypeError(`project input field ${key} must be boolean`);
    }
  }

  const project = requireString(value.project, "project");
  const currentPhase = requireString(value.current_phase, "current_phase");
  const currentTask = requireString(value.current_task, "current_task");

  const temporalGateReason =
    optionalString(value.temporal_gate_reason, "temporal_gate_reason") ??
    optionalString(value?.night_run?.temporal_gate?.reason, "night_run.temporal_gate.reason");

  return Object.freeze({
    schema_version: PROJECT_INPUT_SCHEMA,
    project,
    repository: optionalString(value.repository, "repository"),
    current_phase: currentPhase,
    current_task: currentTask,
    current_task_title: optionalString(value.current_task_title, "current_task_title"),
    next_task: optionalString(value.next_task, "next_task"),
    status,
    autonomy,
    blocked: value.blocked,
    requires_user: value.requires_user,
    owner_boundary: sanitizeBoundary(value.owner_boundary),
    activation_boundary: Object.freeze({
      reason: optionalString(value?.activation_boundary?.reason, "activation_boundary.reason"),
      pending: sanitizeBoundary(value.activation_boundary).pending
    }),
    orchestration: sanitizeOrchestration(value.orchestration ?? value.supervisor_orchestration),
    temporal_gate_reason: temporalGateReason
  });
}

export function resolveProjectInputSource({
  filePath = null,
  url = null,
  env = process.env
} = {}) {
  const explicitFile = String(filePath || env[PROJECT_INPUT_PATH_ENV] || "").trim();
  const explicitUrl = String(url || env[PROJECT_INPUT_URL_ENV] || "").trim();

  if (explicitFile && explicitUrl) {
    throw new Error("project input is ambiguous: configure exactly one file path or URL");
  }
  if (!explicitFile && !explicitUrl) {
    throw new Error(
      `project input is required: pass --project-input/--project-input-url or set ${PROJECT_INPUT_PATH_ENV}/${PROJECT_INPUT_URL_ENV}`
    );
  }
  if (explicitFile) return Object.freeze({ type: "FILE", value: explicitFile });
  return Object.freeze({ type: "URL", value: explicitUrl });
}

export async function loadProjectInput({
  value,
  filePath = null,
  url = null,
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  if (value !== undefined) {
    if (filePath || url) throw new Error("project input value cannot be combined with file/url source");
    return validateProjectInput(value);
  }

  const source = resolveProjectInputSource({ filePath, url, env });
  if (source.type === "FILE") {
    const raw = await fs.readFile(source.value, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new SyntaxError(`invalid project-input JSON: ${error.message}`);
    }
    return validateProjectInput(parsed);
  }

  if (typeof fetchImpl !== "function") {
    throw new Error("project input URL requires a fetch implementation");
  }
  const response = await fetchImpl(source.value, {
    cache: "no-store",
    headers: { "user-agent": "MAGASIN-Supervisor/ProjectAdapter-V1" }
  });
  if (!response?.ok) {
    throw new Error(`project input fetch failed: HTTP ${response?.status ?? "UNKNOWN"}`);
  }
  return validateProjectInput(await response.json());
}
