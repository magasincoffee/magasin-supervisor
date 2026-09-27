import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { ChatGptUiAdapter } from "../../src/ui/playwright-adapter.mjs";
import { sendComposerInstruction } from "../../src/ui/actions.mjs";
import { captureLatestRoleTurn } from "../../src/ui/latest-turn.mjs";
import {
  parseMachineFrame,
  runPlannerExecutorStep
} from "../../src/runtime/planner-executor.mjs";

const stateRoot = String(process.argv[2] || "").trim();
const revision = String(process.argv[3] || process.env.GITHUB_SHA || "unknown").trim();
if (!stateRoot) throw new Error("state root is required");

const safeRevision = revision.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
const diagDir = path.join(stateRoot, "diagnostics", "pe001-live");
const statePath = path.join(diagDir, `${safeRevision}.state.json`);
const resultPath = path.join(diagDir, `${safeRevision}.result.json`);
const lockPath = path.join(diagDir, `${safeRevision}.lock`);

await fs.mkdir(diagDir, { recursive: true });

function sha(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function log(key, value) {
  const safe = String(value ?? "").replace(/[\r\n|]+/g, " ").slice(0, 500);
  console.log(`${key}=${safe}`);
}

async function writeResult(value) {
  const safe = {
    schema_version: "pe001-live-qualification.v1",
    revision: safeRevision,
    ...value
  };
  await fs.writeFile(resultPath, JSON.stringify(safe, null, 2) + "\n", "utf8");
}

async function readPriorPass() {
  try {
    const prior = JSON.parse(await fs.readFile(resultPath, "utf8"));
    return prior?.status === "PASS" ? prior : null;
  } catch {
    return null;
  }
}

async function waitForAssistantFrame(adapter, page, {
  previousTurnId = null,
  expectedActions = [],
  timeoutMs = 180_000,
  label
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastDigest = null;
  let lastParseError = null;

  while (Date.now() <= deadline) {
    const probe = await adapter.probePage(page).catch(() => null);
    const turn = await captureLatestRoleTurn(page, "assistant").catch(() => null);

    if (
      turn &&
      turn.turn_id !== previousTurnId &&
      turn.digest !== lastDigest &&
      probe &&
      !probe.snapshot?.responseRunning &&
      !probe.snapshot?.assistantBusy
    ) {
      lastDigest = turn.digest;
      try {
        const parsed = parseMachineFrame(turn.text);
        if (
          expectedActions.length === 0 ||
          expectedActions.includes(parsed.frame.a)
        ) {
          log(`${label}_TURN_ID`, turn.turn_id);
          log(`${label}_DIGEST`, turn.digest);
          log(`${label}_ACTION`, parsed.frame.a);
          return { turn, parsed };
        }
        lastParseError = `unexpected action ${parsed.frame.a}`;
      } catch (error) {
        lastParseError = String(error?.message || error);
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    `${label} assistant frame timeout` +
    (lastParseError ? `: ${lastParseError}` : "")
  );
}

async function waitUntilAssistantIdle(adapter, page, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const probe = await adapter.probePage(page).catch(() => null);
    if (
      probe &&
      !probe.snapshot?.responseRunning &&
      !probe.snapshot?.assistantBusy
    ) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

const prior = await readPriorPass();
if (prior) {
  log("PE001_LIVE_PRIOR_PASS", "True");
  log("PE001_LIVE_PRIOR_SEND_COUNT", prior.cycle_send_count);
  process.exit(0);
}

let lock = null;
try {
  lock = await fs.open(lockPath, "wx");
} catch (error) {
  if (error?.code === "EEXIST") {
    log("PE001_LIVE_ALREADY_RUNNING", "True");
    process.exit(0);
  }
  throw error;
}

const adapter = new ChatGptUiAdapter({
  cdpUrl: "http://127.0.0.1:9222",
  settleMs: 600,
  actionTimeoutMs: 10_000,
  timeoutMs: 45_000
});

let plannerPage = null;
let executorPage = null;
let cycleSendCount = 0;
const startedAt = new Date().toISOString();

try {
  await adapter.open();
  const preexistingPages = adapter.getChatGptPageCount();
  log("PE001_LIVE_PREEXISTING_CHATGPT_PAGES", preexistingPages);

  // Current released browser scheduler budget is four. Keep this live proof
  // isolated and fail closed rather than evicting or navigating production tabs.
  if (preexistingPages > 2) {
    throw new Error(
      `live qualification requires <=2 pre-existing ChatGPT pages; found ${preexistingPages}`
    );
  }

  plannerPage = await adapter.newChatPage("https://chatgpt.com/");
  executorPage = await adapter.newChatPage("https://chatgpt.com/");

  const plannerProbe = await adapter.probePage(plannerPage);
  const executorProbe = await adapter.probePage(executorPage);
  if (
    plannerProbe.snapshot?.loginRequired ||
    executorProbe.snapshot?.loginRequired ||
    plannerProbe.snapshot?.hasCaptcha ||
    executorProbe.snapshot?.hasCaptcha
  ) {
    throw new Error("live qualification requires existing authenticated normal ChatGPT session");
  }

  log("PE001_LIVE_NORMAL_CHAT_COUNT", 2);
  log("PE001_LIVE_CHATGPT_WORK_MODE_INVOCATIONS", 0);

  const plannerBaseline = await captureLatestRoleTurn(plannerPage, "assistant")
    .catch(() => null);

  const seed = [
    "PE-001 LIVE QUALIFICATION ONLY. Do not use tools, apps, connectors, or ChatGPT Work mode.",
    "You are the Planner role in a temporary normal ChatGPT conversation.",
    "Create exactly one harmless Executor assignment. The assignment body must tell Executor to return a short PASS report and a final @M report frame correlated to the task and assignment.",
    "Use task_id PE001-QUAL-1 and assignment_id A001.",
    "When the result is later relayed to you, ACCEPT it and in the same response assign PE001-QUAL-2 with assignment_id A002. Include a short non-empty body for the next task.",
    "Your current response must end with this exact machine line and nothing after it:",
    '@M {"v":1,"a":"assign","t":"PE001-QUAL-1","i":"A001"}'
  ].join("\n");

  const seeded = await sendComposerInstruction(plannerPage, seed, { dryRun: false });
  if (!seeded.executed) {
    throw new Error(
      `Planner seed send not confirmed: ${seeded.reason || seeded.rejection_class || "unknown"}`
    );
  }
  log("PE001_LIVE_SEED_USER_TURN", seeded.user_turn_evidence || "confirmed");

  const plannerAssignment = await waitForAssistantFrame(adapter, plannerPage, {
    previousTurnId: plannerBaseline?.turn_id || null,
    expectedActions: ["assign"],
    label: "PE001_PLANNER_ASSIGN"
  });
  if (
    plannerAssignment.parsed.frame.t !== "PE001-QUAL-1" ||
    plannerAssignment.parsed.frame.i !== "A001"
  ) {
    throw new Error("Planner assignment did not preserve qualification correlation");
  }

  const sendInstruction = async (page, message, options) => {
    cycleSendCount += 1;
    log("PE001_LIVE_CYCLE_SEND_BEGIN", cycleSendCount);
    const result = await sendComposerInstruction(page, message, options);
    log("PE001_LIVE_CYCLE_SEND_EXECUTED", result.executed);
    log(
      "PE001_LIVE_CYCLE_SEND_USER_TURN",
      result.user_turn_evidence || result.reason || result.rejection_class || "unknown"
    );
    return result;
  };

  const step1 = await runPlannerExecutorStep({
    statePath,
    projectId: "PE001-LIVE",
    plannerPage,
    executorPage,
    captureTurn: captureLatestRoleTurn,
    sendInstruction
  });
  if (
    step1.phase !== "PLANNER_ASSIGN" ||
    step1.outcome?.status !== "CONFIRMED"
  ) {
    throw new Error(
      `Planner assignment step failed: ${step1.phase}/${step1.outcome?.status || "none"}`
    );
  }

  const executorBaselineId = step1.state.executor.last_seen_assistant_turn_id || null;
  const executorReport = await waitForAssistantFrame(adapter, executorPage, {
    previousTurnId: executorBaselineId,
    expectedActions: ["report"],
    label: "PE001_EXECUTOR_REPORT"
  });
  if (
    executorReport.parsed.frame.t !== "PE001-QUAL-1" ||
    executorReport.parsed.frame.i !== "A001"
  ) {
    throw new Error("Executor report correlation mismatch in live qualification");
  }

  const step2 = await runPlannerExecutorStep({
    statePath,
    projectId: "PE001-LIVE",
    plannerPage,
    executorPage,
    captureTurn: captureLatestRoleTurn,
    sendInstruction
  });
  if (
    step2.phase !== "EXECUTOR_REPORT" ||
    step2.outcome?.status !== "CONFIRMED"
  ) {
    throw new Error(
      `Executor report relay failed: ${step2.phase}/${step2.outcome?.status || "none"}`
    );
  }

  const plannerDecisionBaseline =
    step2.state.planner.last_seen_assistant_turn_id || null;
  const plannerDecision = await waitForAssistantFrame(adapter, plannerPage, {
    previousTurnId: plannerDecisionBaseline,
    expectedActions: ["accept_assign"],
    label: "PE001_PLANNER_ACCEPT_ASSIGN"
  });
  if (
    plannerDecision.parsed.frame.t !== step2.state.result.task_id ||
    plannerDecision.parsed.frame.r !== step2.state.result.result_id
  ) {
    throw new Error("Planner accept_assign result correlation mismatch");
  }

  const step3 = await runPlannerExecutorStep({
    statePath,
    projectId: "PE001-LIVE",
    plannerPage,
    executorPage,
    captureTurn: captureLatestRoleTurn,
    sendInstruction
  });
  if (
    step3.phase !== "PLANNER_ACCEPT_ASSIGN" ||
    step3.outcome?.status !== "CONFIRMED"
  ) {
    throw new Error(
      `Planner accept_assign step failed: ${step3.phase}/${step3.outcome?.status || "none"}`
    );
  }

  if (cycleSendCount !== 3) {
    throw new Error(`happy-path cycle expected exactly 3 sends, got ${cycleSendCount}`);
  }

  await waitUntilAssistantIdle(adapter, executorPage).catch(() => false);

  const finalState = JSON.parse(await fs.readFile(statePath, "utf8"));
  if (
    finalState.last_completed?.task_id !== "PE001-QUAL-1" ||
    finalState.assignment?.task_id !== plannerDecision.parsed.frame.n ||
    !finalState.assignment?.send_confirmed_at
  ) {
    throw new Error("durable final state did not record accepted task and confirmed next assignment");
  }

  const result = {
    status: "PASS",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    normal_chat_count: 2,
    chatgpt_work_mode_invocations: 0,
    cycle_send_count: cycleSendCount,
    planner_assignment_turn_digest: plannerAssignment.turn.digest,
    executor_report_turn_digest: executorReport.turn.digest,
    planner_decision_turn_digest: plannerDecision.turn.digest,
    first_task_id_digest: sha(finalState.last_completed.task_id),
    next_task_id_digest: sha(finalState.assignment.task_id),
    matching_user_turn_required: true,
    production_state_mutated: false,
    production_targets_mutated: false
  };
  await writeResult(result);

  log("PE001_LIVE_STATUS", "PASS");
  log("PE001_LIVE_CYCLE_SEND_COUNT", cycleSendCount);
  log("PE001_LIVE_MATCHING_USER_TURN_REQUIRED", "True");
  log("PE001_LIVE_PRODUCTION_STATE_MUTATED", "False");
  log("PE001_LIVE_PRODUCTION_TARGETS_MUTATED", "False");
} catch (error) {
  await writeResult({
    status: "FAIL",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    cycle_send_count: cycleSendCount,
    error_name: String(error?.name || "Error"),
    error_digest: sha(String(error?.message || error))
  }).catch(() => {});

  log("PE001_LIVE_STATUS", "FAIL");
  log("PE001_LIVE_ERROR_NAME", error?.name || "Error");
  log("PE001_LIVE_ERROR_DIGEST", sha(String(error?.message || error)));
  throw error;
} finally {
  // Only ephemeral qualification pages are closed. Existing production tabs
  // and all production state/targets remain untouched.
  if (executorPage && !executorPage.isClosed()) {
    await adapter.closePage(executorPage).catch(() => {});
  }
  if (plannerPage && !plannerPage.isClosed()) {
    await adapter.closePage(plannerPage).catch(() => {});
  }
  await adapter.close().catch(() => {});
  await lock?.close().catch(() => {});
  await fs.rm(lockPath, { force: true }).catch(() => {});
}
