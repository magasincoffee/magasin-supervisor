import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import {
  ACTIONS,
  CANONICAL_CONTINUE_INSTRUCTION,
  OBSERVATIONS
} from "../decision.mjs";
import { loadProjectInput } from "../project-adapter.mjs";
import { executeDecision } from "../ui/actions.mjs";
import { SupervisorSession } from "./session.mjs";
import { SupervisorLoopController } from "./loop.mjs";
import { SupervisorDiagnostics } from "./diagnostics.mjs";
import {
  RECOVERY_ACTIONS,
  SupervisorRecoveryController,
  pageMatchesTarget,
  targetFromUrl
} from "./recovery.mjs";
import {
  buildRuntimeStatus,
  defaultRuntimeStatusPath,
  writeRuntimeStatus
} from "./status.mjs";
import { resolveSupervisorStateRoot } from "./state-root.mjs";

const SUPERVISOR_RUNTIME_VERSION = "2026-09-19.29";

const ROLLOVER_INSTRUCTION =
  "Tiếp tục dự án MAGASIN trong cuộc trò chuyện mới vì cuộc trò chuyện trước đã đầy, bị kẹt hoặc không thể khôi phục. " +
  CANONICAL_CONTINUE_INSTRUCTION +
  " Không yêu cầu Owner lặp lại bối cảnh nếu repository source of truth đã đủ.";

function parseArgs(argv) {
  const result = {
    cdpUrl: "http://127.0.0.1:9222",
    projectInputPath: null,
    projectInputUrl: null,
    execute: false,
    pollMs: 5000,
    stallMs: 4 * 60_000,
    unavailableGraceMs: 90_000
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--cdp-url") result.cdpUrl = argv[++i];
    else if (key === "--project-input" || key === "--state") result.projectInputPath = argv[++i];
    else if (key === "--project-input-url" || key === "--state-url") result.projectInputUrl = argv[++i];
    else if (key === "--target") result.targetPath = argv[++i];
    else if (key === "--execute") result.execute = true;
    else if (key === "--poll-ms") result.pollMs = Number(argv[++i]);
    else if (key === "--stall-ms") result.stallMs = Number(argv[++i]);
    else if (key === "--unavailable-grace-ms") result.unavailableGraceMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${key}`);
  }
  return result;
}

function localRoot() {
  return resolveSupervisorStateRoot().root;
}

async function fetchProjectState({ filePath = null, url = null } = {}) {
  return loadProjectInput({ filePath, url });
}

function validateTarget(value) {
  if (!value || value.origin !== "https://chatgpt.com") {
    throw new Error("invalid local ChatGPT target origin");
  }
  return targetFromUrl(`${value.origin}${value.pathname}`);
}

async function writeTarget(filePath, target) {
  const temporary = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    temporary,
    JSON.stringify({
      origin: target.origin,
      pathname: target.pathname,
      updated_at: new Date().toISOString()
    }, null, 2) + "\n",
    "utf8"
  );
  await fs.rename(temporary, filePath);
}

async function safeAppendLog(logPath, event) {
  const safe = {
    timestamp: new Date().toISOString(),
    type: String(event.type || "EVENT"),
    action: event.action || undefined,
    target: event.target || undefined,
    executed: typeof event.executed === "boolean" ? event.executed : undefined,
    reason: event.reason || undefined,
    errorName: event.errorName || undefined,
    errorCause: event.errorCause || undefined
  };
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, JSON.stringify(safe) + "\n", "utf8");
}

function statusForStep(result, probe) {
  const action = result?.decision?.action;
  const observation =
    result?.effectiveObservation || probe?.classification?.observation;
  if (action === "STOP_DONE") return "DONE";
  if (action === "STOP_WAIT_USER") return "WAIT_USER";
  if (action === "RETRY") return "RETRYING";
  if (observation === "ASSISTANT_RUNNING") return "RUNNING";
  if (action === "CONTINUE") {
    return result?.execution?.executed ? "RUNNING" : "READY";
  }
  return "READY";
}

function recoveryReason(action) {
  switch (action) {
    case RECOVERY_ACTIONS.RELOAD_STALLED:
      return "ChatGPT response stayed running too long; reload the same conversation once, then re-evaluate.";
    case RECOVERY_ACTIONS.RELOAD_UNAVAILABLE:
      return "Conversation UI stayed unavailable after grace period; reload once before rollover.";
    case RECOVERY_ACTIONS.ROLLOVER_CONVERSATION_FULL:
      return "ChatGPT reports the current conversation is full; create a fresh conversation and continue from repository state.";
    case RECOVERY_ACTIONS.WAIT_TARGET:
      return "Retrying target conversation navigation within a bounded budget.";
    case RECOVERY_ACTIONS.WAIT_USER_RECOVERY_EXHAUSTED:
      return "Automatic recovery budget exhausted; Owner intervention is required.";
    default:
      return null;
  }
}

function recoveryPayload(recovery, action, reason = recoveryReason(action)) {
  return {
    ...recovery.status(action),
    reason
  };
}

function isOwnerWaitState(projectState = {}) {
  return Boolean(
    !projectState.blocked &&
    projectState.status !== "BLOCKED" &&
    (projectState.requires_user || projectState.status === "WAIT_USER")
  );
}

function ownerBoundaryKey(projectState = {}) {
  return [
    String(projectState.current_phase || ""),
    String(projectState.current_task || ""),
    String(projectState.current_task_title || ""),
    String(projectState.status || ""),
    String(Boolean(projectState.requires_user))
  ].join("|");
}

function safeTurnMarker(probe) {
  return Number(
    probe?.snapshot?.maxConversationTurnOrdinal ||
    probe?.snapshot?.userMessageCount ||
    0
  );
}

function isHardStopObservation(observation) {
  return new Set([
    OBSERVATIONS.AUTH_REQUIRED,
    OBSERVATIONS.MFA_REQUIRED,
    OBSERVATIONS.CAPTCHA,
    OBSERVATIONS.DESTRUCTIVE_ACTION,
    OBSERVATIONS.ADMIN_ESCALATION,
    OBSERVATIONS.AMBIGUOUS_DECISION
  ]).has(observation);
}

async function createFreshConversation({
  page,
  targetPath,
  controller,
  execute,
  projectState,
  recoveryAction
}) {
  if (recoveryAction !== RECOVERY_ACTIONS.ROLLOVER_CONVERSATION_FULL) {
    throw new Error("conversation rollover denied without conversationFull evidence");
  }
  await page.goto("https://chatgpt.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });
  await page.waitForTimeout(1500);

  const execution = await executeDecision({
    page,
    decision: {
      action: ACTIONS.CONTINUE,
      reason: recoveryReason(recoveryAction),
      instruction: ROLLOVER_INSTRUCTION
    },
    dryRun: !execute
  });

  if (!execute) {
    return { target: null, execution };
  }

  if (!execution.executed) {
    throw new Error(`fresh conversation instruction was not sent: ${execution.reason || "unknown reason"}`);
  }

  controller.markExternalContinuation(0, "ROLLOVER_COMPOSER_SEND");

  await page.waitForURL(
    (value) => {
      try {
        targetFromUrl(value);
        return true;
      } catch {
        return false;
      }
    },
    { timeout: 45_000 }
  );

  const newTarget = targetFromUrl(page.url());
  await writeTarget(targetPath, newTarget);

  return {
    target: newTarget,
    execution,
    project: projectState.project || "MAGASIN Business OS"
  };
}

const args = parseArgs(process.argv.slice(2));
if (!Number.isFinite(args.pollMs) || args.pollMs < 1000) {
  throw new TypeError("poll-ms must be at least 1000");
}
if (!Number.isFinite(args.stallMs) || args.stallMs < 60_000) {
  throw new TypeError("stall-ms must be at least 60000");
}
if (!Number.isFinite(args.unavailableGraceMs) || args.unavailableGraceMs < 15_000) {
  throw new TypeError("unavailable-grace-ms must be at least 15000");
}

const root = localRoot();
const targetPath = args.targetPath || path.join(root, "target.json");
const stopPath = path.join(root, "STOP");
const ownerResolvedPath = path.join(root, "OWNER_RESOLVED.request.json");
const logPath = path.join(root, "supervisor.log");
const runtimeStatusPath = defaultRuntimeStatusPath();
const diagnostics = new SupervisorDiagnostics({
  root,
  runtimeVersion: SUPERVISOR_RUNTIME_VERSION
});
let target = validateTarget(JSON.parse(await fs.readFile(targetPath, "utf8")));

const session = new SupervisorSession({
  cdpUrl: args.cdpUrl,
  maxConnectRetries: 2,
  onEvent: (event) => {
    safeAppendLog(logPath, event).catch(() => {});
  }
});

const controller = new SupervisorLoopController({
  execute: args.execute,
  onEvent: (event) => {
    safeAppendLog(logPath, event).catch(() => {});
  }
});

const recovery = new SupervisorRecoveryController({
  stallMs: args.stallMs,
  unavailableGraceMs: args.unavailableGraceMs
});

let retryCount = 0;
let lastProjectState = {};
let consecutiveConnectFailures = 0;
let handoffPending = true;
let ownerReconcileState = null;

await safeAppendLog(logPath, {
  type: "RUNTIME_BOOT",
  reason: `version=${SUPERVISOR_RUNTIME_VERSION}`
}).catch(() => {});

await writeRuntimeStatus(
  buildRuntimeStatus({
    projectState: lastProjectState,
    status: args.execute ? "STARTING" : "DRY_RUN",
    recovery: recoveryPayload(recovery, RECOVERY_ACTIONS.NONE)
  }),
  runtimeStatusPath
).catch(() => {});

while (true) {
  try {
    await fs.access(stopPath);
    await safeAppendLog(logPath, { type: "STOP_SENTINEL" });
    await writeRuntimeStatus(
      buildRuntimeStatus({
        projectState: lastProjectState,
        status: "STOPPED",
        retryCount,
        recovery: recoveryPayload(recovery, RECOVERY_ACTIONS.NONE)
      }),
      runtimeStatusPath
    ).catch(() => {});
    process.exitCode = 0;
    break;
  } catch {}

  try {
    const projectState = await fetchProjectState({
      filePath: args.projectInputPath,
      url: args.projectInputUrl
    });
    lastProjectState = projectState;

    if (projectState.status === "DONE") {
      await writeRuntimeStatus(
        buildRuntimeStatus({
          projectState,
          status: "DONE",
          retryCount,
          recovery: recoveryPayload(recovery, RECOVERY_ACTIONS.NONE)
        }),
        runtimeStatusPath
      ).catch(() => {});
      await delay(args.pollMs);
      continue;
    }

    if (projectState.autonomy === "PAUSED") {
      const pauseReason =
        projectState?.temporal_gate_reason ||
        "repository autonomy is PAUSED";
      await safeAppendLog(logPath, {
        type: "AUTONOMY_PAUSED",
        action: ACTIONS.WAIT,
        reason: pauseReason
      });
      await writeRuntimeStatus(
        buildRuntimeStatus({
          projectState,
          status: "PAUSED",
          decision: {
            action: ACTIONS.WAIT,
            reason: pauseReason
          },
          retryCount,
          recovery: recoveryPayload(recovery, RECOVERY_ACTIONS.NONE)
        }),
        runtimeStatusPath
      ).catch(() => {});
      process.exitCode = 76;
      break;
    }

    const ownerWait = isOwnerWaitState(projectState);

    if (projectState.blocked || projectState.status === "BLOCKED") {
      ownerReconcileState = null;
      await safeAppendLog(logPath, {
        type: "WAIT_USER",
        reason: "Project is BLOCKED; no automatic Owner reconciliation is allowed."
      });
      await writeRuntimeStatus(
        buildRuntimeStatus({
          projectState,
          status: "WAIT_USER",
          retryCount,
          recovery: recoveryPayload(recovery, RECOVERY_ACTIONS.NONE)
        }),
        runtimeStatusPath
      ).catch(() => {});
      await delay(args.pollMs);
      continue;
    }

    if (ownerWait) {
      const key = ownerBoundaryKey(projectState);
      if (!ownerReconcileState || ownerReconcileState.key !== key) {
        ownerReconcileState = {
          key,
          attempted: false,
          awaitingResponse: false,
          settledTurn: null
        };
        await safeAppendLog(logPath, {
          type: "OWNER_BOUNDARY_OBSERVED",
          reason: "WAIT_USER remains fail-closed, but the live chat will be observed for an explicit Owner decision."
        });
      }
    } else {
      ownerReconcileState = null;
      await fs.unlink(ownerResolvedPath).catch(() => {});
    }

    if (recovery.blocked) {
      const action = RECOVERY_ACTIONS.WAIT_USER_RECOVERY_EXHAUSTED;
      await safeAppendLog(logPath, {
        type: "RECOVERY_BLOCKED",
        action,
        reason: recoveryReason(action)
      });
      await writeRuntimeStatus(
        buildRuntimeStatus({
          projectState,
          status: "WAIT_USER",
          retryCount,
          recovery: recoveryPayload(recovery, action)
        }),
        runtimeStatusPath
      ).catch(() => {});
      await delay(args.pollMs);
      continue;
    }

    const adapter = await session.connect();
    consecutiveConnectFailures = 0;
    const page = adapter.getActivePage();
    if (!page) throw new Error("no active ChatGPT page");

    const wanted = `${target.origin}${target.pathname}`;
    let matched = pageMatchesTarget(page.url(), target);
    let navigationErrorName = null;

    if (!matched) {
      let activeTarget = null;
      try {
        activeTarget = targetFromUrl(page.url());
      } catch {}

      if (activeTarget) {
        const activeProbe = await session.probe().catch(() => null);
        const activeObservation = activeProbe?.classification?.observation;
        const activeSnapshot = activeProbe?.snapshot || {};
        const activeConversationIsUsable = Boolean(
          activeProbe &&
          !isHardStopObservation(activeObservation) &&
          !activeSnapshot.conversationMissing &&
          !activeSnapshot.conversationFull &&
          !activeSnapshot.loginRequired &&
          !activeSnapshot.hasCaptcha
        );

        if (activeConversationIsUsable) {
          target = activeTarget;
          await writeTarget(targetPath, target);
          recovery.noteConversationAdopted();
          matched = true;
          await safeAppendLog(logPath, {
            type: "TARGET_ADOPTED",
            action: "RECOVERY",
            target: "ACTIVE_CONVERSATION_PATH",
            executed: true,
            reason: "Dedicated Supervisor Chrome is already on a usable ChatGPT conversation; adopt it instead of navigating back to a stale target."
          });
        }
      }
    }

    if (!matched) {
      try {
        const response = await page.goto(wanted, {
          waitUntil: "domcontentloaded",
          timeout: 60_000
        });
        await page.waitForTimeout(1200);
        matched = pageMatchesTarget(page.url(), target) &&
          (!response || response.status() < 400);
      } catch (error) {
        navigationErrorName = error?.name || "Error";
        matched = false;
      }

      if (!matched) {
        const mismatchProbe = await session.probe().catch(() => null);
        const mismatchObservation = mismatchProbe?.classification?.observation;

        if (isHardStopObservation(mismatchObservation)) {
          const decision = {
            action: ACTIONS.STOP_WAIT_USER,
            reason: `owner-required observation while recovering target: ${mismatchObservation}`
          };
          await safeAppendLog(logPath, {
            type: "WAIT_USER",
            action: decision.action,
            reason: decision.reason,
            errorName: navigationErrorName || undefined
          });
          await writeRuntimeStatus(
            buildRuntimeStatus({
              projectState,
              status: "WAIT_USER",
              uiState: mismatchProbe?.classification?.uiState || null,
              observation: mismatchObservation || null,
              decision,
              retryCount,
              recovery: recoveryPayload(recovery, RECOVERY_ACTIONS.WAIT_TARGET)
            }),
            runtimeStatusPath
          ).catch(() => {});
          await delay(args.pollMs);
          continue;
        }

        const targetRecovery = recovery.observeTarget({ matched: false });
        await safeAppendLog(logPath, {
          type: "TARGET_RECOVERY",
          action: targetRecovery,
          reason: recoveryReason(targetRecovery),
          errorName: navigationErrorName || undefined
        });

        if (targetRecovery === RECOVERY_ACTIONS.WAIT_TARGET) {
          await writeRuntimeStatus(
            buildRuntimeStatus({
              projectState,
              status: "RECOVERING",
              retryCount,
              recovery: recoveryPayload(recovery, targetRecovery)
            }),
            runtimeStatusPath
          ).catch(() => {});
          await delay(args.pollMs);
          continue;
        }

        if (targetRecovery === RECOVERY_ACTIONS.WAIT_USER_RECOVERY_EXHAUSTED) {
          await safeAppendLog(logPath, {
            type: "RECOVERY_BLOCKED",
            action: targetRecovery,
            reason: "Target recovery exhausted; new conversation is denied without conversationFull evidence."
          });
          await writeRuntimeStatus(
            buildRuntimeStatus({
              projectState,
              status: "WAIT_USER",
              retryCount,
              recovery: recoveryPayload(
                recovery,
                targetRecovery,
                "Target recovery exhausted; new conversation is denied without conversationFull evidence."
              )
            }),
            runtimeStatusPath
          ).catch(() => {});
          await delay(args.pollMs);
          continue;
        }
      } else {
        recovery.observeTarget({ matched: true });
      }
    } else {
      recovery.observeTarget({ matched: true });
    }

    const probe = await session.probe();
    const recoveryAction = recovery.observeProbe(probe);

    if (
      recoveryAction === RECOVERY_ACTIONS.RELOAD_STALLED ||
      recoveryAction === RECOVERY_ACTIONS.RELOAD_UNAVAILABLE
    ) {
      recovery.record(recoveryAction);
      await safeAppendLog(logPath, {
        type: "RECOVERY_RELOAD",
        action: recoveryAction,
        reason: recoveryReason(recoveryAction)
      });
      await writeRuntimeStatus(
        buildRuntimeStatus({
          projectState,
          status: "RECOVERING",
          uiState: probe.classification.uiState,
          observation: probe.classification.observation,
          retryCount,
          recovery: recoveryPayload(recovery, recoveryAction)
        }),
        runtimeStatusPath
      ).catch(() => {});

      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: 60_000
      });
      await page.waitForTimeout(1500);
      await delay(args.pollMs);
      continue;
    }

    if (recoveryAction === RECOVERY_ACTIONS.ROLLOVER_CONVERSATION_FULL) {
      try {
        const rollover = await createFreshConversation({
          page,
          targetPath,
          controller,
          execute: args.execute,
          projectState,
          recoveryAction
        });
        if (rollover.target) target = rollover.target;
        recovery.record(recoveryAction, { success: true });
        await safeAppendLog(logPath, {
          type: "CONVERSATION_ROLLOVER",
          action: recoveryAction,
          executed: Boolean(rollover.execution?.executed),
          target: rollover.execution?.target || undefined,
          reason: recoveryReason(recoveryAction)
        });
        await writeRuntimeStatus(
          buildRuntimeStatus({
            projectState,
            status: args.execute ? "ROLLOVER" : "DRY_RUN",
            uiState: probe.classification.uiState,
            observation: probe.classification.observation,
            execution: rollover.execution,
            retryCount,
            recovery: recoveryPayload(recovery, recoveryAction)
          }),
          runtimeStatusPath
        ).catch(() => {});
      } catch (error) {
        recovery.record(recoveryAction, { success: false });
        await safeAppendLog(logPath, {
          type: "ROLLOVER_FAILED",
          action: recoveryAction,
          reason: recoveryReason(recoveryAction),
          errorName: error?.name || "Error"
        });
        await writeRuntimeStatus(
          buildRuntimeStatus({
            projectState,
            status: recovery.blocked ? "WAIT_USER" : "RECOVERING",
            uiState: probe.classification.uiState,
            observation: probe.classification.observation,
            retryCount,
            recovery: recoveryPayload(recovery, recoveryAction),
            errorName: error?.name || "Error"
          }),
          runtimeStatusPath
        ).catch(() => {});
      }
      await delay(args.pollMs);
      continue;
    }

    if (recoveryAction === RECOVERY_ACTIONS.WAIT_USER_RECOVERY_EXHAUSTED) {
      await writeRuntimeStatus(
        buildRuntimeStatus({
          projectState,
          status: "WAIT_USER",
          uiState: probe.classification.uiState,
          observation: probe.classification.observation,
          retryCount,
          recovery: recoveryPayload(recovery, recoveryAction)
        }),
        runtimeStatusPath
      ).catch(() => {});
      await delay(args.pollMs);
      continue;
    }

    const currentTurn = safeTurnMarker(probe);
    const currentLastRole = String(probe?.snapshot?.lastMessageRole || "");
    const manualOwnerRecheck = ownerWait
      ? await fs.access(ownerResolvedPath).then(() => true).catch(() => false)
      : false;
    let ownerReconcileRequested = false;

    if (ownerWait && ownerReconcileState) {
      if (!ownerReconcileState.awaitingResponse) {
        if (
          manualOwnerRecheck ||
          !ownerReconcileState.attempted ||
          (
            currentLastRole === "user" &&
            currentTurn > Number(ownerReconcileState.settledTurn || 0)
          )
        ) {
          ownerReconcileRequested = true;
        }
      }
    }

    const ownerReconcileActive = Boolean(
      ownerWait &&
      ownerReconcileState &&
      (ownerReconcileRequested || ownerReconcileState.awaitingResponse)
    );

    if (manualOwnerRecheck) {
      await safeAppendLog(logPath, {
        type: "OWNER_RECHECK_ARMED",
        reason: "Owner pressed the local resolved/recheck control; verify the live boundary without bypassing safety."
      });
    }

    const result = await controller.step({
      page,
      projectState,
      probe,
      retryCount,
      maxRetries: 2,
      handoff: handoffPending && !ownerWait,
      ownerReconcile: ownerReconcileActive,
      ownerRecheck: manualOwnerRecheck,
      ownerReconcileAwaitingResponse: Boolean(
        ownerReconcileState?.awaitingResponse
      )
    });

    if (
      ownerWait &&
      ownerReconcileState &&
      ownerReconcileRequested &&
      result.decision.action === "CONTINUE" &&
      result.execution.executed
    ) {
      ownerReconcileState.attempted = true;
      ownerReconcileState.awaitingResponse = true;
      handoffPending = false;
      await fs.unlink(ownerResolvedPath).catch(() => {});
      await safeAppendLog(logPath, {
        type: "OWNER_RECONCILE_SENT",
        action: "CONTINUE",
        target: result.execution.target || undefined,
        executed: true,
        reason: "Sent one fail-closed reconciliation request for the current Owner boundary."
      });
    }

    if (
      ownerWait &&
      ownerReconcileState?.awaitingResponse &&
      controller.armed &&
      result.effectiveObservation === OBSERVATIONS.RESPONSE_COMPLETE
    ) {
      ownerReconcileState.awaitingResponse = false;
      ownerReconcileState.settledTurn = currentTurn;
      await safeAppendLog(logPath, {
        type: "OWNER_RECONCILE_SETTLED",
        reason: "Owner reconciliation response settled; wait for repository state or a newer Owner turn."
      });
    }

    if (
      handoffPending &&
      !ownerWait &&
      result.decision.action === "CONTINUE" &&
      result.execution.executed
    ) {
      handoffPending = false;
      await safeAppendLog(logPath, {
        type: "HANDOFF_RECONCILED",
        action: "CONTINUE",
        target: result.execution.target || undefined,
        executed: true,
        reason: "Observed the active chat first, then handed control back to ChatGPT with live-conversation + repository reconciliation."
      });
    }

    if (
      result.decision.action === "CONTINUE" &&
      result.execution.executed &&
      result.execution.target === "COMPOSER_SEND"
    ) {
      await page.waitForTimeout(1200);
      try {
        const observedTarget = targetFromUrl(page.url());
        if (!pageMatchesTarget(page.url(), target)) {
          target = observedTarget;
          await writeTarget(targetPath, target);
          recovery.noteConversationAdopted();
          await safeAppendLog(logPath, {
            type: "TARGET_ADOPTED",
            action: "CONTINUE",
            target: "NEW_CONVERSATION_PATH",
            executed: true,
            reason: "ChatGPT created a new conversation after a Supervisor send; local target updated atomically."
          });
        }
      } catch {}
    }

    if (result.decision.action === "RETRY" && result.execution.executed) {
      retryCount += 1;
    } else if (
      probe.classification.observation !== "NETWORK_ERROR" &&
      probe.classification.observation !== "TRANSIENT_ERROR"
    ) {
      retryCount = 0;
    }

    await safeAppendLog(logPath, {
      type: "STEP",
      action: result.decision.action,
      target: result.execution.target || undefined,
      executed: Boolean(result.execution.executed),
      reason: result.execution.reason || undefined
    });

    const diagnosticResult = await diagnostics.recordStep({
      projectState,
      probe,
      result,
      controller,
      ownerReconcileState,
      manualOwnerRecheck,
      recovery
    }).catch(() => ({ incident: false }));

    if (diagnosticResult?.incident) {
      await safeAppendLog(logPath, {
        type: "DIAGNOSTIC_INCIDENT",
        reason: diagnosticResult.kind
      }).catch(() => {});
    }

    await writeRuntimeStatus(
      buildRuntimeStatus({
        projectState,
        status: ownerWait
          ? (result.execution?.executed ? "RUNNING" : "WAIT_USER")
          : statusForStep(result, probe),
        uiState: probe.classification.uiState,
        observation:
          result.effectiveObservation || probe.classification.observation,
        decision: result.decision,
        execution: result.execution,
        retryCount,
        recovery: recoveryPayload(recovery, RECOVERY_ACTIONS.NONE)
      }),
      runtimeStatusPath
    ).catch(() => {});
  } catch (error) {
    if (error?.name === "RetryBudgetExhaustedError") {
      consecutiveConnectFailures += 1;
    } else {
      consecutiveConnectFailures = 0;
    }

    await diagnostics.recordError({
      projectState: lastProjectState,
      error,
      ownerReconcileState,
      recovery
    }).catch(() => {});

    await safeAppendLog(logPath, {
      type: "LOOP_ERROR",
      errorName: error?.name || "Error",
      reason: consecutiveConnectFailures >= 3
        ? "CDP connection failed repeatedly; exit the loop so the Windows supervisor can restart its dedicated Chrome."
        : undefined
    });
    await writeRuntimeStatus(
      buildRuntimeStatus({
        projectState: lastProjectState,
        status: "ERROR",
        retryCount,
        recovery: recoveryPayload(recovery, RECOVERY_ACTIONS.NONE),
        errorName: error?.name || "Error"
      }),
      runtimeStatusPath
    ).catch(() => {});
    await session.disconnect().catch(() => {});

    if (consecutiveConnectFailures >= 3) {
      await safeAppendLog(logPath, {
        type: "CDP_RESTART_REQUESTED",
        errorName: error?.name || "Error",
        reason: "Repeated CDP connection failures exceeded the bounded restart threshold."
      }).catch(() => {});
      process.exitCode = 75;
      break;
    }
  }

  await delay(args.pollMs);
}

await session.disconnect().catch(() => {});
