import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const STATE_ROOT_ENV = "MAGASIN_SUPERVISOR_STATE_ROOT";

export function platformStateRoot(env = process.env) {
  const base = env.LOCALAPPDATA || env.HOME || process.cwd();
  return path.join(base, "MAGASIN", "Supervisor");
}

export function legacyBusinessOsStateRoot(env = process.env) {
  const base = env.LOCALAPPDATA || env.HOME || process.cwd();
  return path.join(base, "MAGASIN", "BusinessOS", "supervisor");
}

export function stateRootCandidates(env = process.env) {
  const explicit = String(env[STATE_ROOT_ENV] || "").trim();
  return [...new Set([explicit || null, legacyBusinessOsStateRoot(env), platformStateRoot(env)].filter(Boolean))];
}

export function resolveSupervisorStateRoot(env = process.env, { existsSync = fs.existsSync } = {}) {
  const explicit = String(env[STATE_ROOT_ENV] || "").trim();
  if (explicit) return explicit;
  const legacy = legacyBusinessOsStateRoot(env);
  if (existsSync(legacy)) return legacy;
  return platformStateRoot(env);
}
