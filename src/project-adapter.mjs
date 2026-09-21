import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const PROJECT_ADAPTER_SCHEMA = "supervisor-project-adapter.v1";

const PROJECT_STATUSES = new Set([
  "READY", "RUNNING", "TESTING", "FIXING", "WAIT_CI", "WAIT_USER", "BLOCKED", "DONE"
]);
const AUTONOMY_MODES = new Set(["AUTO_CONTINUE", "MANUAL", "PAUSED"]);

function nonEmptyString(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${field} must be a non-empty string`);
  return text;
}

function optionalString(value, field) {
  if (value == null) return null;
  if (typeof value !== "string") throw new TypeError(`${field} must be string or null`);
  return value;
}

function optionalInstruction(value, field) {
  const text = optionalString(value, field);
  if (text == null) return null;
  if (text.length > 12000) throw new TypeError(`${field} exceeds 12000 characters`);
  return text;
}

function validateInstructions(value) {
  if (value == null) return Object.freeze({});
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("project_state.instructions must be an object");
  }
  return Object.freeze({
    continue: optionalInstruction(value.continue, "project_state.instructions.continue"),
    owner_reconcile: optionalInstruction(value.owner_reconcile, "project_state.instructions.owner_reconcile"),
    handoff: optionalInstruction(value.handoff, "project_state.instructions.handoff"),
    brain_bootstrap: optionalInstruction(value.brain_bootstrap, "project_state.instructions.brain_bootstrap")
  });
}

export function validateBoundedProjectState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("project_state must be an object");
  }

  const state = {
    project: nonEmptyString(value.project, "project_state.project"),
    repository: optionalString(value.repository, "project_state.repository"),
    current_phase: nonEmptyString(value.current_phase, "project_state.current_phase"),
    current_task: nonEmptyString(value.current_task, "project_state.current_task"),
    current_task_title: optionalString(value.current_task_title, "project_state.current_task_title"),
    next_task: optionalString(value.next_task, "project_state.next_task"),
    status: nonEmptyString(value.status, "project_state.status"),
    autonomy: nonEmptyString(value.autonomy, "project_state.autonomy"),
    blocked: value.blocked,
    requires_user: value.requires_user,
    supervisor_orchestration: value.supervisor_orchestration || null,
    owner_boundary: value.owner_boundary || null,
    activation_boundary: value.activation_boundary || null,
    instructions: validateInstructions(value.instructions)
  };

  if (!PROJECT_STATUSES.has(state.status)) {
    throw new TypeError(`unsupported project status: ${state.status}`);
  }
  if (!AUTONOMY_MODES.has(state.autonomy)) {
    throw new TypeError(`unsupported autonomy mode: ${state.autonomy}`);
  }
  for (const key of ["blocked", "requires_user"]) {
    if (typeof state[key] !== "boolean") {
      throw new TypeError(`project_state.${key} must be boolean`);
    }
  }
  if (
    state.repository != null &&
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(state.repository)
  ) {
    throw new TypeError("project_state.repository must be owner/name when provided");
  }

  return Object.freeze(state);
}

export function validateProjectAdapter(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("project adapter must be a JSON object");
  }
  if (value.schema_version !== PROJECT_ADAPTER_SCHEMA) {
    throw new TypeError(`unsupported project adapter schema: ${String(value.schema_version || "")}`);
  }
  if (!value.project_state) {
    throw new TypeError("project adapter project_state is required");
  }
  const projectState = validateBoundedProjectState(value.project_state);
  return Object.freeze({
    schema_version: PROJECT_ADAPTER_SCHEMA,
    project_state: projectState,
    metadata: value.metadata && typeof value.metadata === "object"
      ? Object.freeze({ ...value.metadata })
      : Object.freeze({})
  });
}

export function projectStateFromAdapter(adapter) {
  return validateProjectAdapter(adapter).project_state;
}

export async function readProjectAdapter(filePath) {
  const explicitPath = String(filePath || "").trim();
  if (!explicitPath) {
    throw new Error("project adapter path is required; no platform default is allowed");
  }
  const raw = await fs.readFile(path.resolve(explicitPath), "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SyntaxError(`invalid project-adapter JSON: ${error.message}`);
  }
  return validateProjectAdapter(parsed);
}

export async function fetchProjectAdapter(url, { fetchImpl = globalThis.fetch } = {}) {
  const explicitUrl = String(url || "").trim();
  if (!explicitUrl) {
    throw new Error("project adapter URL is required; no platform default is allowed");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  const response = await fetchImpl(explicitUrl, {
    cache: "no-store",
    headers: { "user-agent": "MAGASIN-Supervisor-ProjectAdapter/1.0" }
  });
  if (!response.ok) throw new Error(`project adapter fetch failed: HTTP ${response.status}`);
  return validateProjectAdapter(await response.json());
}

export function resolveProjectAdapterSource({
  env = process.env,
  pathValue = null,
  urlValue = null
} = {}) {
  const adapterPath = String(pathValue || env.SUPERVISOR_PROJECT_ADAPTER_PATH || "").trim();
  const adapterUrl = String(urlValue || env.SUPERVISOR_PROJECT_ADAPTER_URL || "").trim();

  if (adapterPath && adapterUrl) {
    throw new Error("configure exactly one project adapter source: path or URL");
  }
  if (!adapterPath && !adapterUrl) {
    throw new Error(
      "project adapter source required via --project-adapter/--project-adapter-url or SUPERVISOR_PROJECT_ADAPTER_PATH/URL"
    );
  }
  return adapterPath
    ? Object.freeze({ type: "path", value: adapterPath })
    : Object.freeze({ type: "url", value: adapterUrl });
}

export async function loadProjectStateFromSource(source, options = {}) {
  if (!source || !source.type || !source.value) {
    throw new TypeError("explicit project adapter source is required");
  }
  const adapter = source.type === "path"
    ? await readProjectAdapter(source.value)
    : source.type === "url"
      ? await fetchProjectAdapter(source.value, options)
      : (() => { throw new TypeError("unsupported project adapter source type"); })();
  return projectStateFromAdapter(adapter);
}
