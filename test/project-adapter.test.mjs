import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PROJECT_ADAPTER_SCHEMA,
  loadProjectStateFromSource,
  projectStateFromAdapter,
  readProjectAdapter,
  resolveProjectAdapterSource,
  validateProjectAdapter
} from "../src/project-adapter.mjs";

function adapter(overrides = {}) {
  return {
    schema_version: PROJECT_ADAPTER_SCHEMA,
    project_state: {
      project: "Example Project",
      repository: "example/project",
      current_phase: "P1",
      current_task: "WORK-001",
      current_task_title: "Contract validation",
      next_task: "WORK-002",
      status: "READY",
      autonomy: "AUTO_CONTINUE",
      blocked: false,
      requires_user: false,
      supervisor_orchestration: {
        mode: "BRAIN_WORKER_V1"
      },
      ...overrides
    }
  };
}

test("project adapter accepts bounded orchestration inputs", () => {
  const value = validateProjectAdapter(adapter());
  assert.equal(value.project_state.current_task, "WORK-001");
  assert.equal(value.project_state.repository, "example/project");
});

test("project adapter rejects missing schema or safety booleans", () => {
  assert.throws(
    () => validateProjectAdapter({ project_state: adapter().project_state }),
    /unsupported project adapter schema/
  );
  const invalid = adapter();
  delete invalid.project_state.requires_user;
  assert.throws(() => validateProjectAdapter(invalid), /requires_user/);
});

test("project-owned instructions are optional and length bounded", () => {
  const value = adapter({
    instructions: {
      continue: "Continue only the authorized work item.",
      handoff: "Reconcile explicit Owner direction."
    }
  });
  const state = projectStateFromAdapter(value);
  assert.equal(state.instructions.continue, "Continue only the authorized work item.");
  assert.throws(
    () => validateProjectAdapter(adapter({
      instructions: { continue: "x".repeat(12001) }
    })),
    /exceeds 12000/
  );
});

test("project adapter path source is explicit and fail-closed when absent", () => {
  assert.throws(
    () => resolveProjectAdapterSource({ env: {} }),
    /project adapter source required/
  );
  assert.deepEqual(
    resolveProjectAdapterSource({
      env: {},
      pathValue: "./adapter.json"
    }),
    { type: "path", value: "./adapter.json" }
  );
});

test("path and URL sources are mutually exclusive", () => {
  assert.throws(
    () => resolveProjectAdapterSource({
      env: {},
      pathValue: "./adapter.json",
      urlValue: "https://example.test/adapter.json"
    }),
    /exactly one/
  );
});

test("readProjectAdapter and loadProjectStateFromSource read only explicit adapter input", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-adapter-"));
  const file = path.join(dir, "adapter.json");
  await fs.writeFile(file, JSON.stringify(adapter()), "utf8");
  const parsed = await readProjectAdapter(file);
  assert.equal(parsed.schema_version, PROJECT_ADAPTER_SCHEMA);
  const state = await loadProjectStateFromSource({ type: "path", value: file });
  assert.equal(state.project, "Example Project");
});

test("URL adapter validates remote schema before exposing state", async () => {
  const state = await loadProjectStateFromSource(
    { type: "url", value: "https://example.test/adapter.json" },
    {
      fetchImpl: async () => ({
        ok: true,
        async json() { return adapter(); }
      })
    }
  );
  assert.equal(state.current_task, "WORK-001");
});
