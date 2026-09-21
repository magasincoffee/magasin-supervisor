import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  STATE_ROOT_CONTRACT_VERSION,
  legacySupervisorStateRoot,
  resolveSupervisorStateRoot,
  supervisorStateRoot
} from "../src/state-root.mjs";

test("explicit platform state root wins without touching legacy state", () => {
  const root = resolveSupervisorStateRoot({
    env: {
      SUPERVISOR_STATE_ROOT: "C:\\SupervisorData"
    },
    cwd: "/tmp"
  });
  assert.equal(root.schema_version, STATE_ROOT_CONTRACT_VERSION);
  assert.equal(root.path, "C:\\SupervisorData");
  assert.equal(root.source, "EXPLICIT_ENV");
  assert.equal(root.legacy_compatibility, false);
});

test("legacy production state root remains the compatibility fallback", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\Owner\\AppData\\Local" };
  const descriptor = resolveSupervisorStateRoot({ env, cwd: "/tmp" });
  assert.equal(descriptor.source, "LEGACY_COMPATIBILITY_FALLBACK");
  assert.equal(descriptor.legacy_compatibility, true);
  assert.equal(
    descriptor.path,
    legacySupervisorStateRoot(env, "/tmp")
  );
  assert.match(descriptor.path, /MAGASIN[\\/]BusinessOS[\\/]supervisor$/);
});

test("relative explicit state root fails closed", () => {
  assert.throws(
    () => supervisorStateRoot({ env: { SUPERVISOR_STATE_ROOT: "relative/path" } }),
    /absolute path/
  );
});

test("contract can require explicit root without creating or migrating anything", () => {
  assert.throws(
    () => resolveSupervisorStateRoot({ env: {}, cwd: path.resolve("/tmp"), allowLegacyFallback: false }),
    /SUPERVISOR_STATE_ROOT is required/
  );
});
