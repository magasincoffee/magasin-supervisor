import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PROJECT_INPUT_SCHEMA_VERSION,
  ProjectInputError,
  adaptProjectDocument,
  loadProjectInput,
  selectProjectInputSource,
  validateProjectInput
} from "../src/project-adapter.mjs";

function raw(overrides = {}) {
  return {
    project: "Example Project",
    repository: "example/project",
    current_phase: "PHASE-1",
    current_task: "PLATFORM-001",
    current_task_title: "Generic platform task",
    next_task: "PLATFORM-002",
    status: "READY",
    autonomy: "AUTO_CONTINUE",
    blocked: false,
    requires_user: false,
    supervisor_orchestration: {
      mode: "BRAIN_WORKER_V1",
      workers: { max_parallel_workers: 2 }
    },
    ...overrides
  };
}

test("adapter exposes only bounded orchestration input", () => {
  const input = adaptProjectDocument({
    ...raw(),
    secret_business_truth: "MUST_NOT_COPY",
    task_queue: ["private"],
    night_run: { temporal_gate: { reason: "legacy pause reason" } }
  });
  assert.equal(input.schema_version, PROJECT_INPUT_SCHEMA_VERSION);
  assert.equal(input.current_task, "PLATFORM-001");
  assert.equal(input.pause_reason, "legacy pause reason");
  assert.equal("secret_business_truth" in input, false);
  assert.equal("task_queue" in input, false);
});

test("project input schema fails closed on missing safety booleans", () => {
  const value = {
    ...adaptProjectDocument(raw()),
    schema_version: PROJECT_INPUT_SCHEMA_VERSION
  };
  delete value.requires_user;
  assert.throws(() => validateProjectInput(value), ProjectInputError);
});

test("project input source must be explicit and unambiguous", () => {
  assert.throws(
    () => selectProjectInputSource({ env: {} }),
    /explicit project input source is required/
  );
  assert.throws(
    () => selectProjectInputSource({ filePath: "a.json", url: "https://example.test/input.json", env: {} }),
    /exactly one/
  );
});

test("project input URL has no platform repository default", () => {
  const source = selectProjectInputSource({
    url: "https://example.test/project-input.json",
    env: {}
  });
  assert.equal(source.kind, "URL");
  assert.equal(source.value, "https://example.test/project-input.json");
});

test("loadProjectInput reads an explicit file and strips unbounded fields", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-project-input-"));
  const file = path.join(dir, "input.json");
  await fs.writeFile(file, JSON.stringify({ ...raw(), private_blob: "x" }), "utf8");
  const input = await loadProjectInput({ filePath: file, env: {} });
  assert.equal(input.project, "Example Project");
  assert.equal("private_blob" in input, false);
});
