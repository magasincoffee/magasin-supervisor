import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  PLATFORM_STATE_ROOT_RELATIVE,
  LEGACY_STATE_ROOT_RELATIVE,
  resolveStateRoot,
  stateRootContract
} from "../src/state-root.mjs";

test("explicit state root wins without mutating or relocating state", () => {
  const root = resolveStateRoot({
    env: {},
    explicitRoot: path.resolve("tmp", "explicit-supervisor-root")
  });
  assert.equal(root, path.resolve("tmp", "explicit-supervisor-root"));
});

test("legacy-preserve compatibility resolves the existing production-compatible path", () => {
  const root = resolveStateRoot({
    env: { LOCALAPPDATA: path.join("C:", "Users", "Owner", "AppData", "Local") },
    compatibility: "legacy-preserve"
  });
  assert.equal(root, path.join("C:", "Users", "Owner", "AppData", "Local", LEGACY_STATE_ROOT_RELATIVE));
});

test("platform-default path exists only as an explicit compatibility choice", () => {
  const root = resolveStateRoot({
    env: { LOCALAPPDATA: path.join("C:", "Users", "Owner", "AppData", "Local") },
    compatibility: "platform-default"
  });
  assert.equal(root, path.join("C:", "Users", "Owner", "AppData", "Local", PLATFORM_STATE_ROOT_RELATIVE));
});

test("state-root contract declares zero move/reset semantics", () => {
  const contract = stateRootContract({
    env: { HOME: "/home/example" },
    compatibility: "legacy-preserve"
  });
  assert.equal(contract.schema_version, "supervisor-state-root.v1");
  assert.equal(contract.mutates_or_moves_existing_state, false);
});
