import test from "node:test";
import assert from "node:assert/strict";

import {
  applyProjectPlan,
  defaultProjectProgress,
  markProjectTaskAccepted,
  markProjectTaskActive,
  parseProjectPlan,
  projectProgressSummary
} from "../src/runtime/project-progress.mjs";

const PLAN = {
  tasks: [
    { task_id: "TASK-1", title: "Foundation" },
    { task_id: "TASK-2", title: "Runtime" },
    { task_id: "TASK-3", title: "Acceptance" }
  ],
  completed_task_ids: ["TASK-1"]
};

test("project plan parser keeps bounded unique task truth", () => {
  const parsed = parseProjectPlan(PLAN);
  assert.equal(parsed.schema_version, "project-plan.v1");
  assert.equal(parsed.tasks.length, 3);
  assert.deepEqual(parsed.completed_task_ids, ["TASK-1"]);

  assert.throws(() => parseProjectPlan({
    tasks: [
      { task_id: "TASK-1", title: "A" },
      { task_id: "TASK-1", title: "B" }
    ]
  }), /duplicate/);

  assert.throws(() => parseProjectPlan({
    tasks: [{ task_id: "TASK-1", title: "A" }],
    completed_task_ids: ["TASK-9"]
  }), /not present/);
});

test("project plan bootstraps durable progress and remains idempotent", () => {
  const first = applyProjectPlan(defaultProjectProgress(), PLAN, {
    at: "2026-09-26T03:00:00.000Z"
  });
  assert.equal(first.changed, true);
  assert.equal(first.progress.plan_known, true);
  assert.deepEqual(first.progress.tasks.map((task) => task.state), [
    "DONE", "PENDING", "PENDING"
  ]);

  const second = applyProjectPlan(first.progress, PLAN, {
    at: "2026-09-26T04:00:00.000Z"
  });
  assert.equal(second.changed, false);
  assert.equal(second.progress.updated_at, "2026-09-26T03:00:00.000Z");
});

test("dispatch marks only a planned task ACTIVE and ACCEPT marks it DONE", () => {
  const planned = applyProjectPlan(defaultProjectProgress(), PLAN, {
    at: "2026-09-26T03:00:00.000Z"
  }).progress;

  const active = markProjectTaskActive(planned, "TASK-2", {
    at: "2026-09-26T03:05:00.000Z"
  });
  assert.equal(active.changed, true);
  assert.equal(
    active.progress.tasks.find((task) => task.task_id === "TASK-2").state,
    "ACTIVE"
  );

  const accepted = markProjectTaskAccepted(active.progress, "TASK-2", {
    at: "2026-09-26T03:20:00.000Z"
  });
  assert.equal(accepted.changed, true);
  assert.equal(
    accepted.progress.tasks.find((task) => task.task_id === "TASK-2").state,
    "DONE"
  );

  assert.deepEqual(projectProgressSummary(accepted.progress), {
    known: true,
    total_tasks: 3,
    completed_tasks: 2,
    percent: 67,
    active_task_id: null,
    updated_at: "2026-09-26T03:20:00.000Z"
  });
});

test("unplanned dispatch does not invent a fake project denominator", () => {
  const outcome = markProjectTaskActive(
    defaultProjectProgress(),
    "TASK-UNKNOWN"
  );
  assert.equal(outcome.changed, false);
  assert.deepEqual(projectProgressSummary(outcome.progress), {
    known: false,
    total_tasks: 0,
    completed_tasks: 0,
    percent: null,
    active_task_id: null,
    updated_at: null
  });
});
