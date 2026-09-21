import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  STATE_ROOT_ENV,
  legacyBusinessOsStateRoot,
  platformStateRoot,
  resolveSupervisorStateRoot,
  stateRootCandidates
} from "../src/runtime/state-root.mjs";

const env = { LOCALAPPDATA: "C:\\Users\\Owner\\AppData\\Local" };

test("explicit state root has highest priority", () => {
  const value = resolveSupervisorStateRoot({
    ...env,
    [STATE_ROOT_ENV]: "D:\\SupervisorState"
  }, { existsSync: () => true });
  assert.equal(value, "D:\\SupervisorState");
});

test("existing legacy root is reused without moving state", () => {
  const legacy = legacyBusinessOsStateRoot(env);
  const value = resolveSupervisorStateRoot(env, {
    existsSync: (candidate) => candidate === legacy
  });
  assert.equal(value, legacy);
});

test("fresh environments use platform-owned root when legacy state does not exist", () => {
  const value = resolveSupervisorStateRoot(env, { existsSync: () => false });
  assert.equal(value, platformStateRoot(env));
  assert.match(value, /MAGASIN[\\/]Supervisor$/);
});

test("compatibility candidates include explicit, legacy, then platform roots without mutation", () => {
  const candidates = stateRootCandidates({
    ...env,
    [STATE_ROOT_ENV]: "D:\\ExplicitSupervisor"
  });
  assert.deepEqual(candidates, [
    "D:\\ExplicitSupervisor",
    legacyBusinessOsStateRoot(env),
    platformStateRoot(env)
  ]);
  assert.equal(path.basename(candidates.at(-1)), "Supervisor");
});
