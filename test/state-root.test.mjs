import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  STATE_ROOT_ENV,
  legacySupervisorStateRoot,
  platformSupervisorStateRoot,
  resolveSupervisorStateRoot,
  supervisorStatePath
} from "../src/runtime/state-root.mjs";

test("state-root contract preserves legacy production path when no explicit config exists", () => {
  const env = { LOCALAPPDATA: path.join("C:", "Users", "Owner", "AppData", "Local") };
  const resolved = resolveSupervisorStateRoot({ env, cwd: "C:\\repo" });
  assert.equal(resolved.source, "LEGACY_COMPATIBILITY");
  assert.equal(resolved.legacy_compatibility, true);
  assert.equal(resolved.migration_performed, false);
  assert.equal(resolved.root, legacySupervisorStateRoot(env, "C:\\repo"));
  assert.notEqual(resolved.root, platformSupervisorStateRoot(env, "C:\\repo"));
});

test("state-root contract uses explicit configurable root without mutating legacy root", () => {
  const env = {
    LOCALAPPDATA: path.join("C:", "Users", "Owner", "AppData", "Local"),
    [STATE_ROOT_ENV]: path.join("D:", "SupervisorState")
  };
  const resolved = resolveSupervisorStateRoot({ env, cwd: "C:\\repo" });
  assert.equal(resolved.source, "EXPLICIT_CONFIG");
  assert.equal(resolved.legacy_compatibility, false);
  assert.equal(resolved.migration_performed, false);
  assert.equal(resolved.root, path.resolve(env[STATE_ROOT_ENV]));
});

test("state-root helper returns child file path without creating or moving anything", () => {
  const env = { HOME: "/tmp/example-home" };
  assert.equal(
    supervisorStatePath("lane-status.json", { env, cwd: "/tmp/repo" }),
    path.join(legacySupervisorStateRoot(env, "/tmp/repo"), "lane-status.json")
  );
  assert.throws(() => supervisorStatePath("../escape.json", { env }), /single non-empty path segment/);
});
