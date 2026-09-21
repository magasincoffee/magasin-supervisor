import path from "node:path";
import process from "node:process";

export const SUPERVISOR_STATE_ROOT_ENV = "SUPERVISOR_STATE_ROOT";
export const STATE_ROOT_CONTRACT_VERSION = "supervisor-state-root.v1";

function nonEmpty(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function legacySupervisorStateRoot(env = process.env, cwd = process.cwd()) {
  const base = nonEmpty(env.LOCALAPPDATA) || nonEmpty(env.HOME) || cwd;
  return path.join(base, "MAGASIN", "BusinessOS", "supervisor");
}

export function resolveSupervisorStateRoot({
  env = process.env,
  cwd = process.cwd(),
  allowLegacyFallback = true
} = {}) {
  const explicit = nonEmpty(env[SUPERVISOR_STATE_ROOT_ENV]);
  if (explicit) {
    const absolute = path.isAbsolute(explicit) || path.win32.isAbsolute(explicit);
    if (!absolute) {
      throw new TypeError(`${SUPERVISOR_STATE_ROOT_ENV} must be an absolute path`);
    }
    return Object.freeze({
      schema_version: STATE_ROOT_CONTRACT_VERSION,
      path: explicit,
      source: "EXPLICIT_ENV",
      legacy_compatibility: false
    });
  }

  if (!allowLegacyFallback) {
    throw new TypeError(`${SUPERVISOR_STATE_ROOT_ENV} is required`);
  }

  return Object.freeze({
    schema_version: STATE_ROOT_CONTRACT_VERSION,
    path: legacySupervisorStateRoot(env, cwd),
    source: "LEGACY_COMPATIBILITY_FALLBACK",
    legacy_compatibility: true
  });
}

export function supervisorStateRoot(options = {}) {
  return resolveSupervisorStateRoot(options).path;
}

export function supervisorStatePath(...segments) {
  return path.join(supervisorStateRoot(), ...segments);
}
