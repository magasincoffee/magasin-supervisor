import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";

import { ChatGptUiAdapter } from "../ui/playwright-adapter.mjs";
import {
  composerInstructionDigest
} from "../ui/actions.mjs";
import {
  ChatGptBridgeAdapter,
  CHATGPT_BRIDGE_PINNED_UPSTREAM_COMMIT
} from "./chatgpt-bridge-adapter.mjs";
import {
  prepareBridgeBrowserRuntime,
  MAGASIN_BRIDGE_USERSCRIPT_PATCH
} from "./chatgpt-bridge-page-runtime.mjs";
import {
  buildBridgeProjectContextBootstrapMessage,
  bridgeBootstrapSnapshotBaseline,
  bridgeBootstrapBaselineUnchanged,
  canMigrateLegacyAmbiguousBridgeBootstrap,
  classifyBridgeBootstrapSnapshot
} from "./planner-executor-bridge-bootstrap.mjs";
import {
  readPlannerExecutorState,
  runPlannerExecutorStep,
  writePlannerExecutorState
} from "./planner-executor.mjs";
import { atomicJsonWrite } from "./atomic-json-write.mjs";
import {
  isPlannerExecutorTerminalPhase,
  plannerExecutorFailureIncident,
  recordPlannerExecutorIncident
} from "./planner-executor-automation.mjs";

function parseArgs(argv) {
  const out = {
    execute: false,
    cdpUrl: null,
    bridgeUrl: "http://127.0.0.1:5000",
    bridgeRoot: null,
    statePath: null,
    pollMs: 500
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--execute") out.execute = true;
    else if (arg === "--cdp-url") out.cdpUrl = argv[++i];
    else if (arg === "--bridge-url") out.bridgeUrl = argv[++i];
    else if (arg === "--bridge-root") out.bridgeRoot = argv[++i];
    else if (arg === "--state") out.statePath = argv[++i];
    else if (arg === "--poll-ms") out.pollMs = Number(argv[++i]);
    else throw new Error("unknown argument: " + arg);
  }
  return out;
}

function sha(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function safeLog(key, value) {
  const safe = String(value ?? "").replace(/[\r\n|]+/g, " ").slice(0, 400);
  console.log(key + "=" + safe);
}

function bridgeTurnId(page, role, snapshot, text) {
  const digest = sha(text);
  const ordinal = role === "assistant"
    ? Number(snapshot.assistant_count || 0)
    : snapshot.recent_turns.filter((turn) => turn.role === "user").length;
  return "bridge:" + page.role + ":" + role + ":" + ordinal + ":" + digest.slice(0, 20);
}

function createBridgeTurnCapture(bridge) {
  return async (page, role) => {
    const snapshot = await bridge.getSnapshot(page.page_id);
    if (role === "assistant" && snapshot.is_generating) return null;

    let text = "";
    for (let i = snapshot.recent_turns.length - 1; i >= 0; i -= 1) {
      if (snapshot.recent_turns[i].role === role) {
        text = String(snapshot.recent_turns[i].text || "").trim();
        if (text) break;
      }
    }
    if (!text && role === "assistant") {
      text = String(snapshot.last_assistant || "").trim();
    }
    if (!text) return null;

    const digest = sha(text);
    return {
      turn_id: bridgeTurnId(page, role, snapshot, text),
      digest,
      text
    };
  };
}

function createBridgeDraftInspector(bridge) {
  return async (page) => {
    const snapshot = await bridge.getSnapshot(page.page_id);
    const text = String(snapshot.editor_text || "");
    const normalized = text.trim();
    return {
      has_text: Boolean(normalized),
      digest: normalized ? composerInstructionDigest(normalized) : null,
      normalized_text: normalized
    };
  };
}

async function loadPinnedUserscript(bridgeRoot) {
  if (!bridgeRoot) throw new Error("--bridge-root is required");
  const root = path.resolve(bridgeRoot);
  const markerPath = path.join(root, ".magasin-upstream-commit");
  const marker = (await fs.readFile(markerPath, "utf8")).trim();
  if (marker !== CHATGPT_BRIDGE_PINNED_UPSTREAM_COMMIT) {
    throw new Error("Installed Bridge commit does not match pinned upstream");
  }
  const source = await fs.readFile(
    path.join(root, "userscript", "chatgpt_bridge.user.js"),
    "utf8"
  );
  return { source, root };
}

async function persistStatus(statusPath, state, phase, extra = {}) {
  const measuredChatGptTabs = Math.max(
    0,
    Number(extra?.chatgpt_tabs ?? 0) || 0
  );
  const statusExtra = { ...extra };
  delete statusExtra.chatgpt_tabs;
  await atomicJsonWrite(statusPath, {
    schema_version: "planner-executor-status.v1",
    mode: "PLANNER_EXECUTOR_V1",
    transport: "CHATGPT_BRIDGE_V1",
    bridge_upstream_commit: CHATGPT_BRIDGE_PINNED_UPSTREAM_COMMIT,
    bridge_userscript_patch: MAGASIN_BRIDGE_USERSCRIPT_PATCH,
    project_id: state.project_id,
    project_generation: state.project_generation || 1,
    phase,
    active_task_id: state.active_task_id || null,
    automation_status: state.automation?.status || "RUNNING",
    automation_reason: state.automation?.reason || null,
    project_progress: state.project_progress || null,
    chatgpt_tabs: measuredChatGptTabs,
    chatgpt_work_mode_invocations: 0,
    production_cutover: true,
    ...statusExtra,
    updated_at: new Date().toISOString()
  });
}

async function ensureBridgeProjectBootstrap({
  statePath,
  state,
  bridge,
  plannerPage,
  sourceUrl
}) {
  const bootstrap = state.project_context_bootstrap;
  if (!bootstrap?.required || bootstrap.completed_at) return state;

  const message = buildBridgeProjectContextBootstrapMessage({
    sourceOfTruthUrl: sourceUrl,
    projectId: state.project_id,
    projectGeneration: state.project_generation || 1
  });
  const digest = composerInstructionDigest(message);
  const persistedDigest = String(bootstrap.message_digest || "").trim();
  let hasAmbiguousAttempt = Boolean(
    bootstrap.send_attempted_at && !bootstrap.send_confirmed_at
  );
  const attemptedDigest =
    hasAmbiguousAttempt && persistedDigest ? persistedDigest : digest;

  if (hasAmbiguousAttempt) {
    const snapshot = await bridge.getSnapshot(plannerPage.page_id);
    const evidence = classifyBridgeBootstrapSnapshot(
      snapshot,
      attemptedDigest,
      composerInstructionDigest
    );
    const digestMatches = Boolean(persistedDigest) && persistedDigest === digest;
    const baselineUnchanged = bridgeBootstrapBaselineUnchanged(
      snapshot,
      bootstrap.baseline_snapshot,
      composerInstructionDigest
    );

    startupDiagnostics = {
      bootstrap_reconciliation_state: evidence.state,
      bootstrap_snapshot_generating: evidence.generating === true,
      bootstrap_persisted_digest_matches_current: digestMatches,
      bootstrap_baseline_unchanged: baselineUnchanged
    };
    safeLog(
      "PLANNER_EXECUTOR_BRIDGE_BOOTSTRAP_RECONCILIATION",
      [
        evidence.state,
        "generating=" + String(evidence.generating === true),
        "digest_match=" + String(digestMatches),
        "baseline_unchanged=" + String(baselineUnchanged)
      ].join(";")
    );

    if (
      evidence.state === "CONFIRMED_RESPONSE" &&
      evidence.generating !== true
    ) {
      bootstrap.send_confirmed_at = new Date().toISOString();
      bootstrap.send_evidence = "bridge-bootstrap-reconciled-from-planner-turns";
      bootstrap.completed_at = bootstrap.send_confirmed_at;
      bootstrap.last_send_error = null;
      state.project_context.strict_correlation = true;
      state.automation = {
        status: "RUNNING",
        reason: null,
        updated_at: bootstrap.completed_at
      };
      await writePlannerExecutorState(statePath, state);
      safeLog(
        "PLANNER_EXECUTOR_BRIDGE_PROJECT_BOOTSTRAP",
        "RECONCILED_CONFIRMED"
      );
      return state;
    }

    if (baselineUnchanged && digestMatches) {
      bootstrap.send_attempted_at = null;
      bootstrap.send_confirmed_at = null;
      bootstrap.send_evidence = null;
      bootstrap.retry_count = Number(bootstrap.retry_count || 0) + 1;
      bootstrap.last_send_error =
        "rearmed-after-bridge-snapshot-baseline-unchanged";
      await writePlannerExecutorState(statePath, state);
      hasAmbiguousAttempt = false;
      safeLog(
        "PLANNER_EXECUTOR_BRIDGE_PROJECT_BOOTSTRAP",
        "REARMED_BASELINE_UNCHANGED"
      );
    } else if (canMigrateLegacyAmbiguousBridgeBootstrap({
      state,
      bootstrap,
      evidence,
      persistedDigest,
      currentDigest: digest
    })) {
      // MBV1 Bridge releases before baseline_snapshot could durably latch
      // send_attempted_at before Bridge enqueue. Migrate that historical state
      // once, and only before any downstream assignment/result/decision exists.
      bootstrap.send_attempted_at = null;
      bootstrap.send_confirmed_at = null;
      bootstrap.send_evidence = null;
      bootstrap.retry_count = Number(bootstrap.retry_count || 0) + 1;
      bootstrap.legacy_ambiguous_migrated_at = new Date().toISOString();
      bootstrap.last_send_error =
        "migrated-pre-baseline-bridge-bootstrap-stale-attempt";
      await writePlannerExecutorState(statePath, state);
      hasAmbiguousAttempt = false;
      safeLog(
        "PLANNER_EXECUTOR_BRIDGE_PROJECT_BOOTSTRAP",
        "MIGRATED_PRE_BASELINE_STALE_ATTEMPT"
      );
    } else {
      throw new Error(
        "Bridge bootstrap send outcome is ambiguous from prior process; refusing automatic resend"
      );
    }
  }

  if (!hasAmbiguousAttempt) {
    bootstrap.message_digest = digest;
    if (!bootstrap.baseline_snapshot) {
      const baselineSnapshot = await bridge.getSnapshot(plannerPage.page_id);
      if (baselineSnapshot.is_generating) {
        throw new Error("Bridge Planner bootstrap baseline is generating");
      }
      bootstrap.baseline_snapshot = bridgeBootstrapSnapshotBaseline(
        baselineSnapshot,
        composerInstructionDigest
      );
      bootstrap.baseline_captured_at = new Date().toISOString();
      await writePlannerExecutorState(statePath, state);
    }
  }

  bootstrap.send_attempted_at =
    bootstrap.send_attempted_at || new Date().toISOString();
  await writePlannerExecutorState(statePath, state);

  const result = await bridge.send(plannerPage.page_id, message);
  if (!result?.evidence?.response_changed) {
    throw new Error("Bridge Planner bootstrap lacks new-response evidence");
  }

  bootstrap.send_confirmed_at = new Date().toISOString();
  bootstrap.send_evidence = "bridge-new-assistant-response-observed";
  bootstrap.completed_at = bootstrap.send_confirmed_at;
  bootstrap.last_send_error = null;
  state.project_context.strict_correlation = true;
  state.automation = {
    status: "RUNNING",
    reason: null,
    updated_at: bootstrap.completed_at
  };
  await writePlannerExecutorState(statePath, state);
  safeLog("PLANNER_EXECUTOR_BRIDGE_PROJECT_BOOTSTRAP", "SENT_CONFIRMED");
  return state;
}

const args = parseArgs(process.argv.slice(2));
if (!args.cdpUrl) throw new Error("--cdp-url is required");
if (!args.bridgeRoot) throw new Error("--bridge-root is required");
if (!Number.isFinite(args.pollMs) || args.pollMs < 100 || args.pollMs > 10_000) {
  throw new Error("--poll-ms must be between 100 and 10000");
}

const statePath = path.resolve(args.statePath || "planner-executor-state.json");
const root = path.dirname(statePath);
const statusPath = path.join(root, "planner-executor-status.json");
const incidentPath = path.join(root, "planner-executor-incidents.ndjson");
const startupFailurePath = path.join(root, "planner-executor-startup-failure.json");
const stopPath = path.join(root, "STOP");
const autostartDisabledPath = path.join(root, "AUTOSTART_DISABLED");

const state = await readPlannerExecutorState(statePath, { projectId: "LIVE" });
if (
  !state.project_context?.source_of_truth_url ||
  !state.planner?.target ||
  !state.executor?.target
) {
  throw new Error("link-only Planner/Executor state is missing Source/Planner/Executor links");
}

const { source: userscriptSource } = await loadPinnedUserscript(args.bridgeRoot);
const bridge = new ChatGptBridgeAdapter({
  baseUrl: args.bridgeUrl,
  requestTimeoutMs: 10_000,
  responseTimeoutMs: 180_000,
  pollIntervalMs: Math.max(250, Math.min(1000, args.pollMs))
});
const browser = new ChatGptUiAdapter({
  cdpUrl: args.cdpUrl,
  settleMs: 400,
  actionTimeoutMs: 10_000,
  timeoutMs: 45_000
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; });
}

let pageRuntime = null;
let startupStage = "BRIDGE_HEALTH";
let startupDiagnostics = {};
// Preserve the most recent startup failure across wrapper restarts. The live
// wrapper may immediately relaunch this CLI after a failure; deleting the file
// here erases the only durable stage evidence before diagnostics can observe it.
// Clear it only after the full Bridge bootstrap has completed successfully.
try {
  const health = await bridge.status();
  if (health.supervisor_running) {
    throw new Error("Upstream Bridge supervisor must remain disabled");
  }
  safeLog("PLANNER_EXECUTOR_BRIDGE_HEALTH", "PASS");

  startupStage = "BRIDGE_PAGE_INJECTION";
  pageRuntime = await prepareBridgeBrowserRuntime({
    browserAdapter: browser,
    bridgeAdapter: bridge,
    plannerUrl: state.planner.target,
    executorUrl: state.executor.target,
    userscriptSource,
    previousPlannerUrl: state.planner.previous_target || "",
    previousExecutorUrl: state.executor.previous_target || "",
    requireExactPageSet: true
  });

  const plannerPage = { role: "planner", page_id: pageRuntime.binding.planner.page_id };
  const executorPage = { role: "executor", page_id: pageRuntime.binding.executor.page_id };

  safeLog("PLANNER_EXECUTOR_MODE", "PLANNER_EXECUTOR_V1");
  safeLog("PLANNER_EXECUTOR_TRANSPORT", "CHATGPT_BRIDGE_V1");
  safeLog("PLANNER_EXECUTOR_CHATGPT_TABS", 2);
  safeLog("PLANNER_EXECUTOR_CHATGPT_WORK_MODE_INVOCATIONS", 0);

  if (!args.execute) {
    await persistStatus(statusPath, state, "BRIDGE_READY_DRY_RUN", {
      chatgpt_tabs: browser.getChatGptPageCount(),
      bridge_pages_alive: 2
    });
    process.exit(0);
  }

  startupStage = "BRIDGE_PROJECT_BOOTSTRAP";
  await persistStatus(statusPath, state, "BRIDGE_PROJECT_BOOTSTRAP", {
    chatgpt_tabs: browser.getChatGptPageCount(),
    bridge_pages_alive: 2
  });
  await ensureBridgeProjectBootstrap({
    statePath,
    state,
    bridge,
    plannerPage,
    sourceUrl: state.project_context.source_of_truth_url
  });
  // A prior failure is stale only once page topology, Bridge binding, and the
  // project bootstrap have all converged in the current process.
  await fs.rm(startupFailurePath, { force: true }).catch(() => {});

  const captureTurn = createBridgeTurnCapture(bridge);
  const inspectDraft = createBridgeDraftInspector(bridge);

  const syncVirtualPageIds = () => {
    plannerPage.page_id = pageRuntime.binding.planner.page_id;
    executorPage.page_id = pageRuntime.binding.executor.page_id;
  };

  const ensurePreSend = async (page) => {
    try {
      const current = await bridge.getState(page.page_id);
      if (!current.alive) throw new Error("Bridge page is not alive");
    } catch {
      const recovered = await pageRuntime.recover();
      syncVirtualPageIds();
      safeLog(
        "PLANNER_EXECUTOR_BRIDGE_PAGE_RECOVERY",
        recovered.reinjected ? "REINJECTED" : "REACQUIRED"
      );
    }
  };

  const sendInstruction = async (page, message) => {
    // Recovery is safe only before enqueue. Once adapter.send starts, any
    // timeout/unreachable error is ambiguous and must bubble into the durable
    // exact-once guard without automatic retry.
    await ensurePreSend(page);
    const result = await bridge.send(page.page_id, message);
    return {
      executed: true,
      user_turn_evidence: "bridge-new-assistant-response-observed",
      cmd_id: result.cmd_id,
      response_evidence: result.evidence
    };
  };

  startupStage = "RUN_LOOP";
  while (!stopping) {
    if (
      await fs.access(stopPath).then(() => true).catch(() => false) ||
      await fs.access(autostartDisabledPath).then(() => true).catch(() => false)
    ) {
      safeLog("PLANNER_EXECUTOR_BRIDGE_OWNER_STOP", "True");
      break;
    }

    try {
      const refreshed = await pageRuntime.refresh();
      syncVirtualPageIds();
      if (refreshed.recovered) {
        safeLog(
          "PLANNER_EXECUTOR_BRIDGE_PAGE_RECOVERY",
          refreshed.reinjected ? "REINJECTED" : "REACQUIRED"
        );
      }
    } catch (error) {
      await recordPlannerExecutorIncident(incidentPath, {
        type: "BRIDGE_TOPOLOGY_RECOVERY",
        phase: "PRE_STEP",
        reason_code: error?.code || "BRIDGE_RECOVERY_FAILED",
        project_id: state.project_id,
        error_name: error?.name,
        error_message: error?.message
      }).catch(() => {});
      throw error;
    }

    let result;
    try {
      result = await runPlannerExecutorStep({
        statePath,
        projectId: state.project_id,
        plannerPage,
        executorPage,
        plannerTarget: state.planner.target,
        executorTarget: state.executor.target,
        captureTurn,
        inspectDraft,
        sendInstruction
      });
    } catch (error) {
      const durable = await readPlannerExecutorState(statePath, {
        projectId: state.project_id
      }).catch(() => state);
      await recordPlannerExecutorIncident(
        incidentPath,
        plannerExecutorFailureIncident({ state: durable }, error)
      ).catch(() => {});
      throw error;
    }

    const incident = plannerExecutorFailureIncident(result);
    if (incident) {
      await recordPlannerExecutorIncident(incidentPath, incident).catch(() => {});
    }
    await persistStatus(statusPath, result.state || state, result.phase, {
      chatgpt_tabs: browser.getChatGptPageCount(),
      bridge_pages_alive: 2
    });

    if (isPlannerExecutorTerminalPhase(result.phase)) {
      safeLog("PLANNER_EXECUTOR_TERMINAL_PHASE", result.phase);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, args.pollMs));
  }

} catch (error) {
  await persistStatus(statusPath, state, "STARTUP_FAILED", {
    chatgpt_tabs: browser.getChatGptPageCount(),
    bridge_pages_alive: 0,
    startup_failure_stage: startupStage
  }).catch(() => {});
  await atomicJsonWrite(startupFailurePath, {
    schema_version: "planner-executor-startup-failure.v1",
    transport: "CHATGPT_BRIDGE_V1",
    stage: startupStage,
    error_name: String(error?.name || "Error").slice(0, 120),
    error_digest: sha(error?.message || error),
    project_id: state?.project_id || null,
    active_task_id: state?.active_task_id || null,
    bridge_upstream_commit: CHATGPT_BRIDGE_PINNED_UPSTREAM_COMMIT,
    ...startupDiagnostics,
    recorded_at: new Date().toISOString()
  }).catch(() => {});
  safeLog("PLANNER_EXECUTOR_BRIDGE_FAILURE_STAGE", startupStage);
  safeLog("PLANNER_EXECUTOR_BRIDGE_FAILURE_DIGEST", sha(error?.message || error));
  throw error;
} finally {
  await browser.close().catch(() => {});
}
