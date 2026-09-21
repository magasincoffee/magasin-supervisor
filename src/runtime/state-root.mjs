import path from "node:path";
import process from "node:process";

export const STATE_ROOT_ENV = "MAGASIN_SUPERVISOR_STATE_ROOT";
export const STATE_ROOT_SCHEMA = "supervisor-state-root.v1";

function baseDirectory(env = process.env, cwd = process.cwd()) {
  return env.LOCALAPPDATA || env.HOME || cwd;
}

export function legacySupervisorStateRoot(env = process.env, cwd = process.cwd()) {
  return path.join(baseDirectory(env, cwd), "MAGASIN", "BusinessOS", "supervisor");
}

export function platformSupervisorStateRoot(env = process.env, cwd = process.cwd()) {
  return path.join(baseDirectory(env, cwd), "MAGASIN", "Supervisor");
}

export function resolveSupervisorStateRoot({
  env = process.env,
  cwd = process.cwd()
} = {}) {
  const configured = String(env[STATE_ROOT_ENV] || "").trim();
  if (configured) {
    return Object.freeze({
      schema_version: STATE_ROOT_SCHEMA,
      root: path.resolve(configured),
      source: "EXPLICIT_CONFIG",
      legacy_compatibility: false,
      migration_performed: false
    });
  }

  return Object.freeze({
    schema_version: STATE_ROOT_SCHEMA,
    root: legacySupervisorStateRoot(env, cwd),
    source: "LEGACY_COMPATIBILITY",
    legacy_compatibility: true,
    migration_performed: false,
    future_platform_default: platformSupervisorStateRoot(env, cwd)
  });
}

export function supervisorStatePath(name, options = {}) {
  const fileName = String(name || "").trim();
  if (!fileName || path.basename(fileName) !== fileName) {
    throw new TypeError("state file name must be a single non-empty path segment");
  }
  return path.join(resolveSupervisorStateRoot(options).root, fileName);
}
