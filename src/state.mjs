import process from "node:process";

import {
  AUTONOMY_MODES,
  PROJECT_INPUT_PATH_ENV,
  PROJECT_STATUSES,
  loadProjectInput,
  resolveProjectInputSource,
  validateProjectInput
} from "./project-adapter.mjs";

export { AUTONOMY_MODES, PROJECT_STATUSES };

export function validateProjectState(value) {
  return validateProjectInput(value);
}

export function defaultProjectStatePath(env = process.env) {
  const source = resolveProjectInputSource({ env });
  if (source.type !== "FILE") {
    throw new Error("defaultProjectStatePath requires explicit file-backed project input");
  }
  return source.value;
}

export async function readProjectState(filePath = null, options = {}) {
  return loadProjectInput({
    filePath,
    url: options.url || null,
    env: options.env || process.env,
    fetchImpl: options.fetchImpl
  });
}

export { PROJECT_INPUT_PATH_ENV };
