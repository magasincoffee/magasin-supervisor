import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  projectStateFromAdapter,
  readProjectAdapter,
  validateProjectAdapter
} from "../src/project-adapter.mjs";

function adapter(overrides = {}) {
  return {
    schema_version: "supervisor-project-adapter.v1",
    project: {
      id: "example-project",
      name: "Example Project",
      repository: "example/example-project"
    },
    orchestration: {
      current_phase: "PHASE-1",
      current_task: "WORK-001",
      current_task_title: "Example bounded work",
      status: "READY",
      autonomy: "AUTO_CONTINUE",
      blocked: false,
      requires_user: false,
      next_task: "WORK-002",
      supervisor_orchestration: { workers: { max_parallel_workers: 2 } }
    },
    guidance: {
      source_of_truth: ["docs/project-state.json"]
    },
    ...overrides
  };
}

test("project adapter validates bounded orchestration input", () => {
  const value = validateProjectAdapter(adapter());
  assert.equal(value.project.id, "example-project");
  assert.equal(value.orchestration.current_task, "WORK-001");
  assert.equal(value.guidance.source_of_truth[0], "docs/project-state.json");
});

test("project adapter fails closed on unsupported schema or missing booleans", () => {
  assert.throws(() => validateProjectAdapter(adapter({ schema_version: "legacy" })), /schema_version/);
  const broken = adapter();
  delete broken.orchestration.requires_user;
  assert.throws(() => validateProjectAdapter(broken), /blocked\/requires_user/);
});

test("project state projection contains orchestration truth without copying business documents", () => {
  const state = projectStateFromAdapter(adapter());
  assert.equal(state.project, "Example Project");
  assert.equal(state.repository, "example/example-project");
  assert.equal(state.current_task, "WORK-001");
  assert.equal(state.status, "READY");
  assert.equal(state.autonomy, "AUTO_CONTINUE");
  assert.equal(state.project_adapter_guidance.source_of_truth[0], "docs/project-state.json");
  assert.equal("business_truth" in state, false);
});

test("project adapter reads explicit local source", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-adapter-"));
  const file = path.join(dir, "adapter.json");
  await fs.writeFile(file, JSON.stringify(adapter()), "utf8");
  const value = await readProjectAdapter(file);
  assert.equal(value.project.name, "Example Project");
});

test("project adapter reads explicit HTTPS source through injected fetch and fails on HTTP error", async () => {
  const ok = await readProjectAdapter("https://example.invalid/adapter.json", {
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify(adapter()) })
  });
  assert.equal(ok.orchestration.current_task, "WORK-001");

  await assert.rejects(
    () => readProjectAdapter("https://example.invalid/adapter.json", {
      fetchImpl: async () => ({ ok: false, status: 503 })
    }),
    /HTTP 503/
  );
});
