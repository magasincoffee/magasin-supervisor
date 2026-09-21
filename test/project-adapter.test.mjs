import test from "node:test";
import assert from "node:assert/strict";

import {
  PROJECT_INPUT_SCHEMA,
  loadProjectInput,
  resolveProjectInputSource,
  validateProjectInput
} from "../src/project-adapter.mjs";

const valid = {
  project: "Example Project",
  repository: "owner/repo",
  current_phase: "BUILD",
  current_task: "EXAMPLE-001",
  current_task_title: "Example",
  next_task: "EXAMPLE-002",
  status: "READY",
  autonomy: "AUTO_CONTINUE",
  blocked: false,
  requires_user: false,
  supervisor_orchestration: { workers: { max_parallel_workers: 3 } },
  owner_boundary: { pending: ["OWNER_DECISION"] },
  activation_boundary: { reason: "WAIT_SAFE_GATE", pending: ["SAFE_GATE"] }
};

test("project adapter projects only bounded orchestration fields", () => {
  const input = validateProjectInput({
    ...valid,
    secret_business_truth: "must-not-pass-through",
    night_run: { temporal_gate: { reason: "AFTER_HOURS" } }
  });
  assert.equal(input.schema_version, PROJECT_INPUT_SCHEMA);
  assert.equal(input.project, "Example Project");
  assert.equal(input.repository, "owner/repo");
  assert.equal(input.orchestration.max_parallel_workers, 3);
  assert.equal(input.temporal_gate_reason, "AFTER_HOURS");
  assert.equal("secret_business_truth" in input, false);
  assert.equal("night_run" in input, false);
});

test("project adapter fails closed without an explicit source", () => {
  assert.throws(
    () => resolveProjectInputSource({ env: {} }),
    /project input is required/
  );
});

test("project adapter rejects ambiguous file and URL sources", () => {
  assert.throws(
    () => resolveProjectInputSource({ filePath: "input.json", url: "https://example.invalid/input.json", env: {} }),
    /ambiguous/
  );
});

test("project adapter accepts explicit URL through injected fetch without repository defaults", async () => {
  const seen = [];
  const result = await loadProjectInput({
    url: "https://example.invalid/project-input.json",
    env: {},
    fetchImpl: async (url) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => valid };
    }
  });
  assert.deepEqual(seen, ["https://example.invalid/project-input.json"]);
  assert.equal(result.current_task, "EXAMPLE-001");
});

test("project adapter validates status/autonomy and owner booleans", () => {
  assert.throws(() => validateProjectInput({ ...valid, status: "MAGIC" }), /unsupported project status/);
  assert.throws(() => validateProjectInput({ ...valid, autonomy: "MAGIC" }), /unsupported autonomy mode/);
  assert.throws(() => validateProjectInput({ ...valid, blocked: "false" }), /must be boolean/);
});
