import fs from "node:fs/promises";
import path from "node:path";

import { acquirePlannerExecutorWarmTabs } from "./planner-executor-session.mjs";

const SAFE_INCIDENT_FIELDS = Object.freeze([
  "type",
  "phase",
  "reason_code",
  "outcome_status",
  "project_id",
  "active_task_id",
  "assignment_id",
  "result_id",
  "error_name",
  "error_message"
]);

function safeScalar(value, max = 240) {
  if (value === null || value === undefined) return null;
  return String(value)
    .replace(/[\r\n|]+/g, " ")
    .slice(0, max);
}

export async function recordPlannerExecutorIncident(filePath, incident = {}) {
  if (!filePath) throw new Error("incident file path is required");
  const safe = {
    schema_version: "planner-executor-incident.v1",
    at: new Date().toISOString()
  };
  for (const field of SAFE_INCIDENT_FIELDS) {
    if (incident[field] === undefined) continue;
    safe[field] = safeScalar(incident[field]);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(safe) + "\n", "utf8");
  return safe;
}

export function plannerExecutorFailureIncident(result, error = null) {
  const state = result?.state || null;
  const outcome = result?.outcome || null;
  if (!error && (!outcome || outcome.status === "CONFIRMED")) return null;

  return {
    type: error ? "RUNTIME_ERROR" : "BOUNDED_OUTCOME",
    phase: result?.phase || null,
    reason_code:
      outcome?.detail?.rejection_class ||
      outcome?.detail?.reason ||
      outcome?.status ||
      error?.code ||
      "UNKNOWN",
    outcome_status: outcome?.status || null,
    project_id: state?.project_id || null,
    active_task_id: state?.active_task_id || null,
    assignment_id: state?.assignment?.assignment_id || null,
    result_id: state?.result?.result_id || null,
    error_name: error?.name || null,
    error_message: error?.message || null
  };
}

export function isPlannerExecutorTerminalPhase(phase) {
  return phase === "PLANNER_DONE" || phase === "PLANNER_STOPPED";
}

export function isPlannerExecutorBlockedPhase(phase) {
  return phase === "PLANNER_BLOCKED" ||
    phase === "PLANNER_REJECT_BLOCKED" ||
    phase === "WAIT_PLANNER_RESUME";
}

export async function recoverPlannerExecutorWarmTabs(
  adapter,
  { plannerUrl, executorUrl, attempts = 2, delayMs = 600 } = {}
) {
  let lastError = null;
  const maxAttempts = Math.max(1, Math.min(3, Number(attempts) || 2));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await acquirePlannerExecutorWarmTabs(adapter, {
        plannerUrl,
        executorUrl
      });
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const page = adapter.getActivePage?.();
        if (page?.waitForTimeout) {
          await page.waitForTimeout(delayMs);
        } else {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
  }
  throw lastError || new Error("Planner/Executor warm-tab recovery failed");
}
