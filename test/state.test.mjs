import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readProjectState, validateProjectState } from "../src/state.mjs";

function validState(overrides = {}) {
  return {
    project: "Example Project",
    current_phase: "P1",
    current_task: "WORK-001",
    status: "READY",
    autonomy: "AUTO_CONTINUE",
    blocked: false,
    requires_user: false,
    next_task: "WORK-002",
    ...overrides
  };
}

test("validateProjectState accepts canonical state", () => {
  const result = validateProjectState(validState());
  assert.equal(result.current_task, "WORK-001");
  assert.equal(result.autonomy, "AUTO_CONTINUE");
});

test("validateProjectState rejects unsupported status", () => {
  assert.throws(
    () => validateProjectState(validState({ status: "MAGIC" })),
    /unsupported project status/
  );
});

test("validateProjectState requires explicit safety booleans", () => {
  const value = validState();
  delete value.requires_user;
  assert.throws(() => validateProjectState(value), /requires_user/);
});

test("readProjectState parses a state file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-supervisor-"));
  const file = path.join(dir, "state.json");
  await fs.writeFile(file, JSON.stringify(validState()), "utf8");
  const state = await readProjectState(file);
  assert.equal(state.next_task, "WORK-002");
});

test("readProjectState reports invalid JSON", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-supervisor-"));
  const file = path.join(dir, "state.json");
  await fs.writeFile(file, "{broken", "utf8");
  await assert.rejects(() => readProjectState(file), /invalid project-state JSON/);
});
