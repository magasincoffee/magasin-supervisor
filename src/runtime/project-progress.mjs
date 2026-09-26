import { createHash } from "node:crypto";

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const TASK_STATES = new Set(["PENDING", "ACTIVE", "DONE"]);

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unsupported ${label} field: ${key}`);
  }
}

function normalizeTaskId(value, label = "task_id") {
  const taskId = String(value || "").trim();
  if (!TASK_ID_RE.test(taskId)) throw new Error(`invalid ${label}`);
  return taskId;
}

function normalizeTitle(value, taskId) {
  const title = String(value || "").replace(/\s+/g, " ").trim();
  return (title || taskId).slice(0, 180);
}

export function parseProjectPlan(value) {
  if (value === undefined || value === null) return null;
  assertObject(value, "project_plan");
  assertFields(value, new Set(["schema_version", "tasks", "completed_task_ids"]), "project_plan");
  if (value.schema_version !== undefined && value.schema_version !== "project-plan.v1") {
    throw new Error("unsupported project_plan schema_version");
  }

  if (!Array.isArray(value.tasks)) {
    throw new Error("project_plan.tasks must be an array");
  }
  if (value.tasks.length > 200) {
    throw new Error("project_plan.tasks exceeds 200 tasks");
  }

  const seen = new Set();
  const tasks = value.tasks.map((item, index) => {
    assertObject(item, `project_plan.tasks[${index}]`);
    assertFields(item, new Set(["task_id", "title"]), `project_plan.tasks[${index}]`);
    const taskId = normalizeTaskId(item.task_id, "project_plan task_id");
    if (seen.has(taskId)) throw new Error("duplicate project_plan task_id");
    seen.add(taskId);
    return {
      task_id: taskId,
      title: normalizeTitle(item.title, taskId)
    };
  });

  const completedInput = value.completed_task_ids ?? [];
  if (!Array.isArray(completedInput)) {
    throw new Error("project_plan.completed_task_ids must be an array");
  }
  if (completedInput.length > 200) {
    throw new Error("project_plan.completed_task_ids exceeds 200 tasks");
  }

  const completed = [];
  const completedSeen = new Set();
  for (const raw of completedInput) {
    const taskId = normalizeTaskId(raw, "project_plan completed task_id");
    if (!seen.has(taskId)) {
      throw new Error("project_plan completed task_id is not present in tasks");
    }
    if (!completedSeen.has(taskId)) {
      completedSeen.add(taskId);
      completed.push(taskId);
    }
  }

  return {
    schema_version: "project-plan.v1",
    tasks,
    completed_task_ids: completed
  };
}

export function defaultProjectProgress() {
  return {
    schema_version: "project-progress.v1",
    plan_known: false,
    plan_digest: null,
    tasks: [],
    updated_at: null
  };
}

export function normalizeProjectProgress(value = null) {
  const safe = defaultProjectProgress();
  if (!value || typeof value !== "object" || Array.isArray(value)) return safe;

  const tasks = [];
  const seen = new Set();
  for (const item of Array.isArray(value.tasks) ? value.tasks.slice(0, 200) : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const taskId = String(item.task_id || "").trim();
    if (!TASK_ID_RE.test(taskId) || seen.has(taskId)) continue;
    seen.add(taskId);
    const state = String(item.state || "PENDING").toUpperCase();
    tasks.push({
      task_id: taskId,
      title: normalizeTitle(item.title, taskId),
      state: TASK_STATES.has(state) ? state : "PENDING",
      completed_at: item.completed_at ? String(item.completed_at) : null
    });
  }

  return {
    schema_version: "project-progress.v1",
    plan_known: Boolean(value.plan_known),
    plan_digest: value.plan_digest ? String(value.plan_digest) : null,
    tasks,
    updated_at: value.updated_at ? String(value.updated_at) : null
  };
}

function canonicalPlanDigest(plan) {
  return digest(JSON.stringify({
    tasks: plan.tasks.map((task) => ({
      task_id: task.task_id,
      title: task.title
    })),
    completed_task_ids: [...plan.completed_task_ids].sort()
  }));
}

export function applyProjectPlan(
  current,
  plan,
  { activeTaskId = null, at = new Date().toISOString() } = {}
) {
  if (!plan) {
    return { progress: normalizeProjectProgress(current), changed: false };
  }
  const parsed = parseProjectPlan(plan);
  const previous = normalizeProjectProgress(current);
  const oldById = new Map(previous.tasks.map((task) => [task.task_id, task]));
  const completed = new Set(parsed.completed_task_ids);
  const active = String(activeTaskId || "").trim();

  const tasks = parsed.tasks.map((task) => {
    const old = oldById.get(task.task_id);
    const done = completed.has(task.task_id) || old?.state === "DONE";
    const state = done
      ? "DONE"
      : active === task.task_id
        ? "ACTIVE"
        : "PENDING";
    return {
      task_id: task.task_id,
      title: task.title,
      state,
      completed_at: done ? (old?.completed_at || at) : null
    };
  });

  const candidate = {
    schema_version: "project-progress.v1",
    plan_known: true,
    plan_digest: canonicalPlanDigest(parsed),
    tasks,
    updated_at: previous.updated_at
  };
  const changed = JSON.stringify({
    ...previous,
    updated_at: null
  }) !== JSON.stringify({
    ...candidate,
    updated_at: null
  });
  if (!changed) return { progress: previous, changed: false };
  return {
    progress: { ...candidate, updated_at: at },
    changed: true
  };
}

export function markProjectTaskActive(
  current,
  taskId,
  { at = new Date().toISOString() } = {}
) {
  const progress = normalizeProjectProgress(current);
  if (!progress.plan_known) return { progress, changed: false };
  const id = String(taskId || "").trim();
  let changed = false;
  const tasks = progress.tasks.map((task) => {
    if (task.task_id !== id || task.state === "DONE" || task.state === "ACTIVE") {
      return task;
    }
    changed = true;
    return { ...task, state: "ACTIVE" };
  });
  if (!changed) return { progress, changed: false };
  return {
    progress: { ...progress, tasks, updated_at: at },
    changed: true
  };
}

export function markProjectTaskAccepted(
  current,
  taskId,
  { at = new Date().toISOString() } = {}
) {
  const progress = normalizeProjectProgress(current);
  if (!progress.plan_known) return { progress, changed: false };
  const id = String(taskId || "").trim();
  let changed = false;
  const tasks = progress.tasks.map((task) => {
    if (task.task_id !== id || task.state === "DONE") return task;
    changed = true;
    return {
      ...task,
      state: "DONE",
      completed_at: at
    };
  });
  if (!changed) return { progress, changed: false };
  return {
    progress: { ...progress, tasks, updated_at: at },
    changed: true
  };
}

export function projectProgressSummary(current) {
  const progress = normalizeProjectProgress(current);
  const total = progress.tasks.length;
  const completed = progress.tasks.filter((task) => task.state === "DONE").length;
  const active = progress.tasks.find((task) => task.state === "ACTIVE") || null;
  return {
    known: Boolean(progress.plan_known),
    total_tasks: total,
    completed_tasks: completed,
    percent: progress.plan_known && total > 0
      ? Math.round((completed / total) * 100)
      : null,
    active_task_id: active?.task_id || null,
    updated_at: progress.updated_at
  };
}
