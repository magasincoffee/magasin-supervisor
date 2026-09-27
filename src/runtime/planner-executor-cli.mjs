import process from "node:process";
import path from "node:path";
import fs from "node:fs/promises";

import { ChatGptUiAdapter } from "../ui/playwright-adapter.mjs";
import { captureLatestRoleTurn } from "../ui/latest-turn.mjs";
import { resolveStateRoot } from "../state-root.mjs";
import { atomicJsonWrite } from "./atomic-json-write.mjs";
import {
  readPlannerExecutorState,
  runPlannerExecutorStep
} from "./planner-executor.mjs";
import {
  acquirePlannerExecutorWarmTabs,
  assertPlannerExecutorWarmTabs,
  createIdleAwareTurnCapture,
  expectedWaitRole
} from "./planner-executor-session.mjs";
import {
  isPlannerExecutorTerminalPhase,
  plannerExecutorFailureIncident,
  recordPlannerExecutorIncident,
  recoverPlannerExecutorWarmTabs
} from "./planner-executor-automation.mjs";

function parseArgs(argv) {
  const out = {
    execute: false,
    pollMs: 500,
    cdpUrl: null,
    statePath: null,
    projectId: null,
    plannerUrl: null,
    executorUrl: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--execute") out.execute = true;
    else if (arg === "--cdp-url") out.cdpUrl = argv[++i];
    else if (arg === "--state") out.statePath = argv[++i];
    else if (arg === "--project-id") out.projectId = argv[++i];
    else if (arg === "--planner-url") out.plannerUrl = argv[++i];
    else if (arg === "--executor-url") out.executorUrl = argv[++i];
    else if (arg === "--poll-ms") out.pollMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function safeLog(key, value) {
  const safe = String(value ?? "")
    .replace(/[\r\n|]+/g, " ")
    .slice(0, 300);
  console.log(`${key}=${safe}`);
}

const args = parseArgs(process.argv.slice(2));
if (!args.cdpUrl) throw new Error("--cdp-url is required");
if (!Number.isFinite(args.pollMs) || args.pollMs < 100 || args.pollMs > 10_000) {
  throw new Error("--poll-ms must be between 100 and 10000");
}

const root = resolveStateRoot({ compatibility: "platform-default" });
const statePath = path.resolve(
  args.statePath || path.join(root, "planner-executor-state.json")
);
const statusPath = path.join(path.dirname(statePath), "planner-executor-status.json");
const incidentPath = path.join(
  path.dirname(statePath),
  "planner-executor-incidents.ndjson"
);

const stateExists = await fs.access(statePath).then(() => true).catch(() => false);
if (
  !stateExists &&
  (!args.projectId || !args.plannerUrl || !args.executorUrl)
) {
  throw new Error(
    "--project-id, --planner-url and --executor-url are required on first start"
  );
}

const existing = await readPlannerExecutorState(statePath, {
  projectId: args.projectId,
  plannerTarget: args.plannerUrl,
  executorTarget: args.executorUrl
});

if (
  args.projectId &&
  existing.project_id &&
  args.projectId !== existing.project_id
) {
  throw new Error("project_id override conflicts with durable state");
}
if (
  args.plannerUrl &&
  existing.planner?.target &&
  args.plannerUrl !== existing.planner.target
) {
  throw new Error("Planner target override conflicts with durable state");
}
if (
  args.executorUrl &&
  existing.executor?.target &&
  args.executorUrl !== existing.executor.target
) {
  throw new Error("Executor target override conflicts with durable state");
}

const projectId = existing.project_id;
const plannerUrl = existing.planner?.target;
const executorUrl = existing.executor?.target;
if (!projectId || !plannerUrl || !executorUrl) {
  throw new Error("durable Planner/Executor state is missing required targets");
}

const adapter = new ChatGptUiAdapter({
  cdpUrl: args.cdpUrl,
  settleMs: 500,
  actionTimeoutMs: 10_000,
  timeoutMs: 45_000
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; });
}

try {
  let warm = await acquirePlannerExecutorWarmTabs(adapter, {
    plannerUrl,
    executorUrl
  });
  safeLog("PLANNER_EXECUTOR_MODE", "PLANNER_EXECUTOR_V1");
  safeLog("PLANNER_EXECUTOR_CHATGPT_TABS", warm.pageCount);
  safeLog("PLANNER_EXECUTOR_CHATGPT_WORK_MODE_INVOCATIONS", 0);

  if (!args.execute) {
    await atomicJsonWrite(statusPath, {
      schema_version: "planner-executor-status.v1",
      mode: "PLANNER_EXECUTOR_V1",
      project_id: projectId,
      phase: "READY_DRY_RUN",
      chatgpt_tabs: 2,
      chatgpt_work_mode_invocations: 0,
      production_cutover: false,
      updated_at: new Date().toISOString()
    });
    safeLog("PLANNER_EXECUTOR_DRY_RUN_READY", true);
    process.exit(0);
  }

  const captureTurn = createIdleAwareTurnCapture(
    adapter,
    captureLatestRoleTurn
  );

  while (!stopping) {
    try {
      assertPlannerExecutorWarmTabs(adapter, warm);
    } catch (error) {
      await recordPlannerExecutorIncident(incidentPath, {
        type: "TOPOLOGY_RECOVERY",
        phase: "PRE_STEP",
        reason_code: "WARM_TAB_GUARD_FAILED",
        project_id: projectId,
        error_name: error?.name,
        error_message: error?.message
      }).catch(() => {});

      warm = await recoverPlannerExecutorWarmTabs(adapter, {
        plannerUrl,
        executorUrl,
        attempts: 2
      });
      safeLog("PLANNER_EXECUTOR_HEALTH_RECOVERY", "RECOVERED");
      continue;
    }

    let result = null;
    try {
      result = await runPlannerExecutorStep({
        statePath,
        projectId,
        plannerPage: warm.plannerPage,
        executorPage: warm.executorPage,
        plannerTarget: plannerUrl,
        executorTarget: executorUrl,
        captureTurn
      });
    } catch (error) {
      const durable = await readPlannerExecutorState(statePath, {
        projectId,
        plannerTarget: plannerUrl,
        executorTarget: executorUrl
      }).catch(() => null);
      await recordPlannerExecutorIncident(
        incidentPath,
        plannerExecutorFailureIncident({ state: durable }, error)
      ).catch(() => {});
      throw error;
    }

    const incident = plannerExecutorFailureIncident(result);
    if (incident) {
      await recordPlannerExecutorIncident(incidentPath, incident)
        .catch(() => {});
    }

    await atomicJsonWrite(statusPath, {
      schema_version: "planner-executor-status.v1",
      mode: "PLANNER_EXECUTOR_V1",
      project_id: projectId,
      phase: result.phase,
      active_task_id: result.state?.active_task_id || null,
      automation_status: result.state?.automation?.status || "RUNNING",
      automation_reason: result.state?.automation?.reason || null,
      chatgpt_tabs: adapter.getChatGptPageCount(),
      chatgpt_work_mode_invocations: 0,
      production_cutover: false,
      updated_at: new Date().toISOString()
    });

    if (isPlannerExecutorTerminalPhase(result.phase)) {
      safeLog("PLANNER_EXECUTOR_TERMINAL_PHASE", result.phase);
      break;
    }

    const waitRole = expectedWaitRole(result.phase);
    const page = waitRole === "planner"
      ? warm.plannerPage
      : waitRole === "executor"
        ? warm.executorPage
        : null;
    await (page || warm.plannerPage).waitForTimeout(args.pollMs);
  }
} finally {
  await adapter.close().catch(() => {});
}
