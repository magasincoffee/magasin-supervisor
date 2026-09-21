import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readProjectState, validateProjectState } from "../src/state.mjs";

function validState(overrides = {}) {
  return {
    project: "Example Project",
    repository: "example/project",
    current_phase: "BUILD",
    current_task: "PLATFORM-002",
    status: "READY",
    autonomy: "AUTO_CONTINUE",
    blocked: false,
    requires_user: false,
    next_task: "PLATFORM-003",
    ...overrides
  };
}

test("validateProjectState accepts bounded project input", () => {
  const result = validateProjectState(validState());
  assert.equal(result.current_task, "PLATFORM-002");
  assert.equal(result.autonomy, "AUTO_CONTINUE");
  assert.equal(result.repository, "example/project");
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

test("readProjectState parses an explicit state/input file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-project-input-"));
  const file = path.join(dir, "input.json");
  await fs.writeFile(file, JSON.stringify(validState()), "utf8");
  const state = await readProjectState(file, { env: {} });
  assert.equal(state.next_task, "PLATFORM-003");
});

test("readProjectState reports invalid project-input JSON", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-project-input-"));
  const file = path.join(dir, "input.json");
  await fs.writeFile(file, "{broken", "utf8");
  await assert.rejects(
    () => readProjectState(file, { env: {} }),
    /invalid project-input JSON/
  );
});
