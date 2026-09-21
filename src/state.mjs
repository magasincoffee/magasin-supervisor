import path from "node:path";
import process from "node:process";

import {
  AUTONOMY_MODES,
  PROJECT_INPUT_SCHEMA_VERSION,
  PROJECT_STATUSES,
  adaptProjectDocument,
  readProjectInput,
  validateProjectInput
} from "./project-adapter.mjs";

export {
  AUTONOMY_MODES,
  PROJECT_INPUT_SCHEMA_VERSION,
  PROJECT_STATUSES
};

export function defaultProjectStatePath(env = process.env) {
  const configured = String(env.SUPERVISOR_PROJECT_INPUT_FILE || "").trim();
  return configured ? path.resolve(configured) : null;
}

// Compatibility API for existing platform modules/tests. The returned object is
// always the bounded project-adapter contract; arbitrary project/business fields
// are intentionally discarded.
export function validateProjectState(value) {
  return value?.schema_version === PROJECT_INPUT_SCHEMA_VERSION
    ? validateProjectInput(value)
    : adaptProjectDocument(value);
}

export async function readProjectState(filePath = defaultProjectStatePath()) {
  if (!filePath) {
    throw new TypeError("explicit project input file is required");
  }
  return readProjectInput(filePath);
}
