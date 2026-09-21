import path from "node:path";
import process from "node:process";

export const STATE_ROOT_SCHEMA = "supervisor-state-root.v1";
export const LEGACY_STATE_ROOT_RELATIVE = path.join("MAGASIN", "BusinessOS", "supervisor");
export const PLATFORM_STATE_ROOT_RELATIVE = path.join("MAGASIN", "Supervisor");

export function resolveStateRoot({
  env = process.env,
  explicitRoot = null,
  compatibility = "legacy-preserve"
} = {}) {
  const configured = String(explicitRoot || env.SUPERVISOR_STATE_ROOT || "").trim();
  if (configured) return path.resolve(configured);

  const base = env.LOCALAPPDATA || env.HOME || process.cwd();
  if (compatibility === "legacy-preserve") {
    return path.join(base, LEGACY_STATE_ROOT_RELATIVE);
  }
  if (compatibility === "platform-default") {
    return path.join(base, PLATFORM_STATE_ROOT_RELATIVE);
  }
  throw new Error(`unsupported state-root compatibility mode: ${compatibility}`);
}

export function stateRootContract(options = {}) {
  return Object.freeze({
    schema_version: STATE_ROOT_SCHEMA,
    root: resolveStateRoot(options),
    compatibility: options.compatibility || "legacy-preserve",
    mutates_or_moves_existing_state: false
  });
}
