import fs from "node:fs/promises";

const STATUSES = new Set(["READY","RUNNING","TESTING","FIXING","WAIT_CI","WAIT_USER","BLOCKED","DONE"]);
const AUTONOMY = new Set(["AUTO_CONTINUE","MANUAL","PAUSED"]);

function nonEmpty(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${field} must be a non-empty string`);
  return text;
}

export function validateProjectAdapter(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("project adapter must be an object");
  if (value.schema_version !== "supervisor-project-adapter.v1") throw new TypeError("unsupported project adapter schema_version");
  const project = value.project;
  const orchestration = value.orchestration;
  if (!project || typeof project !== "object") throw new TypeError("project adapter project is required");
  if (!orchestration || typeof orchestration !== "object") throw new TypeError("project adapter orchestration is required");
  const normalized = {
    schema_version: value.schema_version,
    project: {
      id: nonEmpty(project.id, "project.id"),
      name: nonEmpty(project.name || project.id, "project.name"),
      repository: project.repository == null ? null : nonEmpty(project.repository, "project.repository")
    },
    orchestration: {
      current_phase: nonEmpty(orchestration.current_phase, "orchestration.current_phase"),
      current_task: nonEmpty(orchestration.current_task, "orchestration.current_task"),
      current_task_title: orchestration.current_task_title == null ? "" : String(orchestration.current_task_title),
      status: nonEmpty(orchestration.status, "orchestration.status"),
      autonomy: nonEmpty(orchestration.autonomy, "orchestration.autonomy"),
      blocked: orchestration.blocked,
      requires_user: orchestration.requires_user,
      next_task: orchestration.next_task == null ? null : String(orchestration.next_task),
      supervisor_orchestration: orchestration.supervisor_orchestration || null
    },
    guidance: value.guidance && typeof value.guidance === "object" ? { ...value.guidance } : {}
  };
  if (!STATUSES.has(normalized.orchestration.status)) throw new TypeError("unsupported project status: " + normalized.orchestration.status);
  if (!AUTONOMY.has(normalized.orchestration.autonomy)) throw new TypeError("unsupported autonomy mode: " + normalized.orchestration.autonomy);
  if (typeof normalized.orchestration.blocked !== "boolean" || typeof normalized.orchestration.requires_user !== "boolean") {
    throw new TypeError("orchestration blocked/requires_user must be boolean");
  }
  return Object.freeze(normalized);
}

export function projectStateFromAdapter(adapter) {
  const value = validateProjectAdapter(adapter);
  return Object.freeze({
    project: value.project.name,
    project_id: value.project.id,
    repository: value.project.repository,
    current_phase: value.orchestration.current_phase,
    current_task: value.orchestration.current_task,
    current_task_title: value.orchestration.current_task_title,
    status: value.orchestration.status,
    autonomy: value.orchestration.autonomy,
    blocked: value.orchestration.blocked,
    requires_user: value.orchestration.requires_user,
    next_task: value.orchestration.next_task,
    supervisor_orchestration: value.orchestration.supervisor_orchestration,
    project_adapter_guidance: Object.freeze({ ...value.guidance })
  });
}

export async function readProjectAdapter(source, { fetchImpl = fetch } = {}) {
  const value = nonEmpty(source, "project adapter source");
  let raw;
  if (/^https:\/\//i.test(value)) {
    const response = await fetchImpl(value, { cache: "no-store", headers: { "user-agent": "MAGASIN-Supervisor/ProjectAdapterV1" } });
    if (!response.ok) throw new Error(`project adapter fetch failed: HTTP ${response.status}`);
    raw = await response.text();
  } else {
    raw = await fs.readFile(value, "utf8");
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) { throw new SyntaxError("invalid project-adapter JSON: " + error.message); }
  return validateProjectAdapter(parsed);
}

export async function readProjectStateFromAdapter(source, options) {
  return projectStateFromAdapter(await readProjectAdapter(source, options));
}
