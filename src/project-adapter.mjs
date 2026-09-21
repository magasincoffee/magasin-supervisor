import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const PROJECT_INPUT_SCHEMA_VERSION = "supervisor-project-input.v1";

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

export class ProjectInputError extends Error {
  constructor(message, { code = "PROJECT_INPUT_INVALID", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ProjectInputError";
    this.code = code;
  }
}

function requiredString(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new ProjectInputError(`project input field ${field} must be a non-empty string`);
  return text;
}

function optionalString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function safeStringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function boundedOrchestration(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectInputError("project input orchestration must be an object or null");
  }

  const workers = value.workers && typeof value.workers === "object"
    ? {
        max_parallel_workers: Number.isInteger(value.workers.max_parallel_workers)
          ? value.workers.max_parallel_workers
          : null
      }
    : null;

  return Object.freeze({
    mode: optionalString(value.mode),
    lane_count: Number.isInteger(value.lane_count) ? value.lane_count : null,
    brain_autodiscovery:
      typeof value.brain_autodiscovery === "boolean"
        ? value.brain_autodiscovery
        : null,
    workers
  });
}

export function validateProjectInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectInputError("project input must be a JSON object");
  }
  if (value.schema_version !== PROJECT_INPUT_SCHEMA_VERSION) {
    throw new ProjectInputError(
      `unsupported project input schema: ${String(value.schema_version || "")}`,
      { code: "PROJECT_INPUT_SCHEMA_UNSUPPORTED" }
    );
  }

  const output = {
    schema_version: PROJECT_INPUT_SCHEMA_VERSION,
    project: requiredString(value.project, "project"),
    repository: optionalString(value.repository),
    current_phase: requiredString(value.current_phase, "current_phase"),
    current_task: requiredString(value.current_task, "current_task"),
    current_task_title: optionalString(value.current_task_title),
    next_task: optionalString(value.next_task),
    status: requiredString(value.status, "status"),
    autonomy: requiredString(value.autonomy, "autonomy"),
    blocked: value.blocked,
    requires_user: value.requires_user,
    pause_reason: optionalString(value.pause_reason),
    owner_boundary: Object.freeze({
      pending: safeStringList(value?.owner_boundary?.pending)
    }),
    activation_boundary: Object.freeze({
      reason: optionalString(value?.activation_boundary?.reason),
      pending: safeStringList(value?.activation_boundary?.pending)
    }),
    supervisor_orchestration: boundedOrchestration(value.supervisor_orchestration)
  };

  if (!PROJECT_STATUSES.has(output.status)) {
    throw new ProjectInputError(`unsupported project status: ${output.status}`);
  }
  if (!AUTONOMY_MODES.has(output.autonomy)) {
    throw new ProjectInputError(`unsupported autonomy mode: ${output.autonomy}`);
  }
  for (const field of ["blocked", "requires_user"]) {
    if (typeof output[field] !== "boolean") {
      throw new ProjectInputError(`project input field ${field} must be boolean`);
    }
  }

  return Object.freeze(output);
}

export function adaptProjectDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectInputError("project document must be a JSON object");
  }

  return validateProjectInput({
    schema_version: PROJECT_INPUT_SCHEMA_VERSION,
    project: value.project,
    repository: value.repository ?? null,
    current_phase: value.current_phase,
    current_task: value.current_task,
    current_task_title: value.current_task_title ?? null,
    next_task: value.next_task ?? null,
    status: value.status,
    autonomy: value.autonomy,
    blocked: value.blocked,
    requires_user: value.requires_user,
    pause_reason:
      value.pause_reason ??
      value?.night_run?.temporal_gate?.reason ??
      null,
    owner_boundary: {
      pending: safeStringList(value?.owner_boundary?.pending)
    },
    activation_boundary: {
      reason: value?.activation_boundary?.reason ?? null,
      pending: safeStringList(value?.activation_boundary?.pending)
    },
    supervisor_orchestration: value.supervisor_orchestration ?? null
  });
}

export function selectProjectInputSource({
  filePath = null,
  url = null,
  env = process.env
} = {}) {
  const explicitFile = optionalString(filePath) || optionalString(env.SUPERVISOR_PROJECT_INPUT_FILE);
  const explicitUrl = optionalString(url) || optionalString(env.SUPERVISOR_PROJECT_INPUT_URL);

  if (explicitFile && explicitUrl) {
    throw new ProjectInputError(
      "configure exactly one project input source: file or URL",
      { code: "PROJECT_INPUT_SOURCE_AMBIGUOUS" }
    );
  }
  if (!explicitFile && !explicitUrl) {
    throw new ProjectInputError(
      "explicit project input source is required",
      { code: "PROJECT_INPUT_SOURCE_REQUIRED" }
    );
  }
  if (explicitUrl) {
    let parsed;
    try {
      parsed = new URL(explicitUrl);
    } catch (error) {
      throw new ProjectInputError("project input URL is invalid", {
        code: "PROJECT_INPUT_URL_INVALID",
        cause: error
      });
    }
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new ProjectInputError("project input URL must be an HTTP(S) URL without embedded credentials", {
        code: "PROJECT_INPUT_URL_INVALID"
      });
    }
    return Object.freeze({ kind: "URL", value: parsed.toString() });
  }

  const resolved = path.resolve(explicitFile);
  return Object.freeze({ kind: "FILE", value: resolved });
}

async function parseProjectDocument(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ProjectInputError(`invalid project input JSON: ${error.message}`, {
      code: "PROJECT_INPUT_JSON_INVALID",
      cause: error
    });
  }
  return adaptProjectDocument(parsed);
}

export async function readProjectInput(filePath) {
  if (!filePath) {
    throw new ProjectInputError("project input file path is required", {
      code: "PROJECT_INPUT_SOURCE_REQUIRED"
    });
  }
  try {
    return await parseProjectDocument(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof ProjectInputError) throw error;
    throw new ProjectInputError("project input file is unavailable", {
      code: "PROJECT_INPUT_UNAVAILABLE",
      cause: error
    });
  }
}

export async function fetchProjectInput(url, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(url, {
      cache: "no-store",
      headers: { "user-agent": "Supervisor-ProjectAdapter/1.0" }
    });
    if (!response.ok) {
      throw new ProjectInputError(`project input fetch failed: HTTP ${response.status}`, {
        code: "PROJECT_INPUT_UNAVAILABLE"
      });
    }
    return adaptProjectDocument(await response.json());
  } catch (error) {
    if (error instanceof ProjectInputError) throw error;
    throw new ProjectInputError("project input fetch temporarily unavailable", {
      code: "PROJECT_INPUT_UNAVAILABLE",
      cause: error
    });
  }
}

export async function loadProjectInput({
  filePath = null,
  url = null,
  env = process.env,
  fetchImpl = fetch
} = {}) {
  const source = selectProjectInputSource({ filePath, url, env });
  if (source.kind === "FILE") return readProjectInput(source.value);
  return fetchProjectInput(source.value, { fetchImpl });
}
