import process from "node:process";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

import { ChatGptUiAdapter } from "../ui/playwright-adapter.mjs";
import { captureLatestRoleTurn } from "../ui/latest-turn.mjs";
import {
  composerInstructionDigest,
  inspectComposerDraftDigest,
  sendComposerInstruction
} from "../ui/actions.mjs";
import { resolveStateRoot } from "../state-root.mjs";
import { atomicJsonWrite } from "./atomic-json-write.mjs";
import {
  readPlannerExecutorState,
  runPlannerExecutorStep,
  writePlannerExecutorState
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

async function ensureProductionPlannerBootstrap({
  statePath,
  state,
  plannerPage
}) {
  const bootstrap = state?.cutover_bootstrap;
  if (!bootstrap?.required || bootstrap.completed_at) return state;

  const message = String(bootstrap.message || "").trim();
  if (!message) {
    throw new Error("production cutover bootstrap message is missing");
  }
  const expectedDigest = composerInstructionDigest(message);
  if (
    bootstrap.message_digest &&
    bootstrap.message_digest !== expectedDigest
  ) {
    throw new Error("production cutover bootstrap digest mismatch");
  }
  bootstrap.message_digest = expectedDigest;

  if (!bootstrap.baseline_captured_at) {
    const [assistant, user] = await Promise.all([
      captureLatestRoleTurn(plannerPage, "assistant").catch(() => null),
      captureLatestRoleTurn(plannerPage, "user").catch(() => null)
    ]);
    bootstrap.baseline_assistant_turn_id = assistant?.turn_id || null;
    bootstrap.baseline_user_turn_id = user?.turn_id || null;
    bootstrap.baseline_captured_at = new Date().toISOString();
    state.planner.last_seen_assistant_turn_id =
      bootstrap.baseline_assistant_turn_id;
    await writePlannerExecutorState(statePath, state);
  }

  if (!bootstrap.send_confirmed_at) {
    const latestUser = await captureLatestRoleTurn(plannerPage, "user")
      .catch(() => null);
    const matchingNewUserTurn = Boolean(
      latestUser?.turn_id &&
      latestUser.turn_id !== bootstrap.baseline_user_turn_id &&
      latestUser?.text &&
      composerInstructionDigest(latestUser.text) === expectedDigest
    );
    if (matchingNewUserTurn) {
      bootstrap.send_confirmed_at = new Date().toISOString();
      bootstrap.send_evidence = "matching-user-turn-observed";
      await writePlannerExecutorState(statePath, state);
    } else {
      const draft = await inspectComposerDraftDigest(plannerPage)
        .catch(() => null);
      if (
        draft?.has_text === true &&
        draft.digest !== expectedDigest
      ) {
        throw new Error(
          "production cutover bootstrap blocked by foreign or Owner draft"
        );
      }
      const exactPendingDraft = Boolean(
        draft?.has_text === true &&
        draft.digest === expectedDigest
      );
      if (bootstrap.send_attempted_at && !exactPendingDraft) {
        throw new Error(
          "production cutover bootstrap send outcome is ambiguous; refusing duplicate"
        );
      }

      bootstrap.send_attempted_at =
        bootstrap.send_attempted_at || new Date().toISOString();
      await writePlannerExecutorState(statePath, state);

      const sent = await sendComposerInstruction(plannerPage, message, {
        dryRun: false
      });
      if (!sent?.executed) {
        bootstrap.last_send_error = String(
          sent?.reason || sent?.rejection_class || "bootstrap-send-not-confirmed"
        ).slice(0, 300);
        await writePlannerExecutorState(statePath, state);
        throw new Error("production cutover Planner bootstrap send was not confirmed");
      }
      bootstrap.send_confirmed_at = new Date().toISOString();
      bootstrap.send_evidence =
        sent.user_turn_evidence || "sendComposerInstruction-confirmed";
      bootstrap.last_send_error = null;
      await writePlannerExecutorState(statePath, state);
    }
  }

  safeLog("PLANNER_EXECUTOR_CUTOVER_BOOTSTRAP", "SENT_CONFIRMED");
  return state;
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
const startupFailurePath = path.join(
  path.dirname(statePath),
  "planner-executor-startup-failure.json"
);

function errorDigest(error) {
  return crypto
    .createHash("sha256")
    .update(String(error?.message || error || ""), "utf8")
    .digest("hex");
}

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

let startupStage = "ACQUIRE_WARM_TABS";
await fs.rm(startupFailurePath, { force: true }).catch(() => {});

try {
  let warm = await acquirePlannerExecutorWarmTabs(adapter, {
    plannerUrl,
    executorUrl
  });
  safeLog("PLANNER_EXECUTOR_MODE", "PLANNER_EXECUTOR_V1");
  safeLog("PLANNER_EXECUTOR_CHATGPT_TABS", warm.pageCount);
  safeLog("PLANNER_EXECUTOR_CHATGPT_WORK_MODE_INVOCATIONS", 0);
  startupStage = "CUTOVER_BOOTSTRAP";

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

  await ensureProductionPlannerBootstrap({
    statePath,
    state: existing,
    plannerPage: warm.plannerPage
  });
  startupStage = "RUN_LOOP";

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
      production_cutover: true,
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
} catch (error) {
  const durable = await readPlannerExecutorState(statePath, {
    projectId,
    plannerTarget: plannerUrl,
    executorTarget: executorUrl
  }).catch(() => existing);
  const bootstrap = durable?.cutover_bootstrap || {};
  const safeFailure = {
    schema_version: "planner-executor-startup-failure.v1",
    stage: startupStage,
    error_name: String(error?.name || "Error").slice(0, 120),
    error_digest: errorDigest(error),
    project_id: durable?.project_id || projectId || null,
    active_task_id: durable?.active_task_id || null,
    handoff_mode: durable?.production_cutover?.handoff_mode || null,
    automation_status: durable?.automation?.status || null,
    bootstrap_required: Boolean(bootstrap.required),
    bootstrap_baseline_captured: Boolean(bootstrap.baseline_captured_at),
    bootstrap_send_attempted: Boolean(bootstrap.send_attempted_at),
    bootstrap_send_confirmed: Boolean(bootstrap.send_confirmed_at),
    bootstrap_send_evidence: bootstrap.send_evidence
      ? String(bootstrap.send_evidence).slice(0, 120)
      : null,
    bootstrap_last_send_error_digest: bootstrap.last_send_error
      ? crypto.createHash("sha256")
          .update(String(bootstrap.last_send_error), "utf8")
          .digest("hex")
      : null,
    observed_chatgpt_tabs: adapter.getChatGptPageCount(),
    chatgpt_work_mode_invocations: 0,
    recorded_at: new Date().toISOString()
  };
  await atomicJsonWrite(startupFailurePath, safeFailure).catch(() => {});
  safeLog("PLANNER_EXECUTOR_STARTUP_FAILURE_STAGE", startupStage);
  safeLog("PLANNER_EXECUTOR_STARTUP_FAILURE_NAME", safeFailure.error_name);
  safeLog("PLANNER_EXECUTOR_STARTUP_FAILURE_DIGEST", safeFailure.error_digest);
  throw error;
} finally {
  await adapter.close().catch(() => {});
}
