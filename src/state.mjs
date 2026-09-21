import process from "node:process";

import {
  readProjectAdapter,
  projectStateFromAdapter,
  validateBoundedProjectState
} from "./project-adapter.mjs";

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

export function defaultProjectStatePath(env = process.env) {
  const configured = String(env.SUPERVISOR_PROJECT_ADAPTER_PATH || "").trim();
  if (!configured) {
    throw new Error(
      "SUPERVISOR_PROJECT_ADAPTER_PATH is required; platform core has no Business OS project-state default"
    );
  }
  return configured;
}

export function validateProjectState(value) {
  return validateBoundedProjectState(value);
}

export async function readProjectState(filePath = defaultProjectStatePath()) {
  return projectStateFromAdapter(await readProjectAdapter(filePath));
}
