import fs from "node:fs/promises";

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

export function validateProjectState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("project state must be a JSON object");
  }

  const requiredStrings = ["project", "current_phase", "current_task", "status", "autonomy"];
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string" || !value[key].trim()) {
      throw new TypeError(`project state field ${key} must be a non-empty string`);
    }
  }

  if (!PROJECT_STATUSES.has(value.status)) {
    throw new TypeError(`unsupported project status: ${value.status}`);
  }

  if (!AUTONOMY_MODES.has(value.autonomy)) {
    throw new TypeError(`unsupported autonomy mode: ${value.autonomy}`);
  }

  for (const key of ["blocked", "requires_user"]) {
    if (typeof value[key] !== "boolean") {
      throw new TypeError(`project state field ${key} must be boolean`);
    }
  }

  if (value.next_task != null && typeof value.next_task !== "string") {
    throw new TypeError("project state field next_task must be string or null");
  }

  return Object.freeze({ ...value });
}

export async function readProjectState(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) throw new TypeError("explicit project-state path is required");
  const raw = await fs.readFile(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SyntaxError(`invalid project-state JSON: ${error.message}`);
  }
  return validateProjectState(parsed);
}
