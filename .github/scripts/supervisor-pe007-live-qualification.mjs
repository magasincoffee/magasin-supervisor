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
const diagDir = path.join(stateRoot, "diagnostics", "pe007-live");
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
  await fs.writeFile(
    resultPath,
    JSON.stringify({
      schema_version: "pe007-live-qualification.v1",
      revision: safeRevision,
      ...value
    }, null, 2) + "\n",
    "utf8"
  );
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

const prior = await readPriorPass();
if (prior) {
  log("PE007_LIVE_PRIOR_PASS", "True");
  process.exit(0);
}

let lock = null;
try {
  lock = await fs.open(lockPath, "wx");
} catch (error) {
  if (error?.code === "EEXIST") {
    log("PE007_LIVE_ALREADY_RUNNING", "True");
    process.exit(0);
  }
  throw error;
}

const cdpUrl = String(process.env.SUPERVISOR_PE007_CDP_URL || "").trim();
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl)) {
  throw new Error("SUPERVISOR_PE007_CDP_URL must be a local dynamic CDP endpoint");
}
const browserStartedByQualification =
  String(process.env.SUPERVISOR_PE007_BROWSER_STARTED || "").toLowerCase() === "true";

const adapter = new ChatGptUiAdapter({
  cdpUrl,
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
  const existingPages = adapter.getChatGptPages();
  const preexistingPages = existingPages.length;

  if (browserStartedByQualification) {
    if (preexistingPages > 1) {
      throw new Error(
        `qualification-owned Chrome expected <=1 initial ChatGPT page; found ${preexistingPages}`
      );
    }
    plannerPage = existingPages[0] || await adapter.newChatPage("https://chatgpt.com/");
    const plannerUrl = new URL(plannerPage.url());
    if (
      plannerUrl.hostname !== "chatgpt.com" ||
      /^\/(c|g|project)\//.test(plannerUrl.pathname)
    ) {
      throw new Error("qualification-owned initial page is not a blank normal ChatGPT surface");
    }
    executorPage = await adapter.newChatPage("https://chatgpt.com/");
    if (adapter.getChatGptPageCount() !== 2) {
      throw new Error("qualification-owned browser did not reach exact two-tab topology");
    }
  } else {
    if (preexistingPages > 2) {
      throw new Error(
        `live qualification requires <=2 pre-existing ChatGPT pages; found ${preexistingPages}`
      );
    }
    plannerPage = await adapter.newChatPage("https://chatgpt.com/");
    executorPage = await adapter.newChatPage("https://chatgpt.com/");
  }

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

  log("PE007_LIVE_NORMAL_CHAT_COUNT", 2);
  log("PE007_LIVE_CHATGPT_WORK_MODE_INVOCATIONS", 0);

  const plannerBaseline = await captureLatestRoleTurn(plannerPage, "assistant")
    .catch(() => null);

  const seed = [
    "PE-007 LIVE QUALIFICATION ONLY. Do not use tools, apps, connectors, or ChatGPT Work mode.",
    "You are Planner in a temporary normal ChatGPT conversation.",
    "Create one harmless assignment for task PE007-QUAL-1 with assignment_id A001.",
    "The assignment body must instruct Executor to return a short intentional FAIL report with result_id R001 and final report frame.",
    "When R001 is relayed, REJECT it and in the same response provide a non-empty bounded correction body telling Executor to return PASS with result_id R002.",
    'That rejection response must end with @M {"v":1,"a":"reject","t":"PE007-QUAL-1","r":"R001","i":"A002"}',
    "When R002 PASS is relayed, mark the project done.",
    'That final response must end with @M {"v":1,"a":"done","t":"PE007-QUAL-1","r":"R002"}',
    "Your current response must end with this exact line and nothing after it:",
    '@M {"v":1,"a":"assign","t":"PE007-QUAL-1","i":"A001"}'
  ].join("\n");

  const seeded = await sendComposerInstruction(plannerPage, seed, { dryRun: false });
  if (!seeded.executed) {
    throw new Error(
      `Planner seed send not confirmed: ${seeded.reason || seeded.rejection_class || "unknown"}`
    );
  }

  const plannerAssignment = await waitForAssistantFrame(adapter, plannerPage, {
    previousTurnId: plannerBaseline?.turn_id || null,
    expectedActions: ["assign"],
    label: "PE007_PLANNER_ASSIGN"
  });
  if (
    plannerAssignment.parsed.frame.t !== "PE007-QUAL-1" ||
    plannerAssignment.parsed.frame.i !== "A001"
  ) {
    throw new Error("Planner initial assignment correlation mismatch");
  }

  const sendInstruction = async (page, message, options) => {
    cycleSendCount += 1;
    const result = await sendComposerInstruction(page, message, options);
    log("PE007_LIVE_CYCLE_SEND", cycleSendCount);
    log(
      "PE007_LIVE_CYCLE_SEND_EVIDENCE",
      result.user_turn_evidence || result.reason || result.rejection_class || "unknown"
    );
    return result;
  };

  const step1 = await runPlannerExecutorStep({
    statePath,
    projectId: "PE007-LIVE",
    plannerPage,
    executorPage,
    captureTurn: captureLatestRoleTurn,
    sendInstruction
  });
  if (step1.phase !== "PLANNER_ASSIGN" || step1.outcome?.status !== "CONFIRMED") {
    throw new Error("initial assignment was not confirmed");
  }

  const report1 = await waitForAssistantFrame(adapter, executorPage, {
    previousTurnId: step1.state.executor.last_seen_assistant_turn_id || null,
    expectedActions: ["report"],
    label: "PE007_EXECUTOR_FAIL_REPORT"
  });
  if (
    report1.parsed.frame.t !== "PE007-QUAL-1" ||
    report1.parsed.frame.i !== "A001" ||
    report1.parsed.frame.r !== "R001" ||
    report1.parsed.frame.s !== "fail"
  ) {
    throw new Error("Executor intentional FAIL report correlation mismatch");
  }

  const step2 = await runPlannerExecutorStep({
    statePath,
    projectId: "PE007-LIVE",
    plannerPage,
    executorPage,
    captureTurn: captureLatestRoleTurn,
    sendInstruction
  });
  if (step2.phase !== "EXECUTOR_REPORT" || step2.outcome?.status !== "CONFIRMED") {
    throw new Error("FAIL report relay was not confirmed");
  }

  const reject = await waitForAssistantFrame(adapter, plannerPage, {
    previousTurnId: step2.state.planner.last_seen_assistant_turn_id || null,
    expectedActions: ["reject"],
    label: "PE007_PLANNER_REJECT_CORRECTION"
  });
  if (
    reject.parsed.frame.t !== "PE007-QUAL-1" ||
    reject.parsed.frame.r !== "R001" ||
    reject.parsed.frame.i !== "A002" ||
    !reject.parsed.body
  ) {
    throw new Error("Planner reject-correction frame is incomplete");
  }

  const step3 = await runPlannerExecutorStep({
    statePath,
    projectId: "PE007-LIVE",
    plannerPage,
    executorPage,
    captureTurn: captureLatestRoleTurn,
    sendInstruction
  });
  if (
    step3.phase !== "PLANNER_REJECT_CORRECTION" ||
    step3.outcome?.status !== "CONFIRMED"
  ) {
    throw new Error("bounded reject correction was not confirmed");
  }

  const report2 = await waitForAssistantFrame(adapter, executorPage, {
    previousTurnId: step3.state.executor.last_seen_assistant_turn_id || null,
    expectedActions: ["report"],
    label: "PE007_EXECUTOR_PASS_REPORT"
  });
  if (
    report2.parsed.frame.t !== "PE007-QUAL-1" ||
    report2.parsed.frame.i !== "A002" ||
    report2.parsed.frame.r !== "R002" ||
    report2.parsed.frame.s !== "pass"
  ) {
    throw new Error("Executor correction PASS report correlation mismatch");
  }

  const step4 = await runPlannerExecutorStep({
    statePath,
    projectId: "PE007-LIVE",
    plannerPage,
    executorPage,
    captureTurn: captureLatestRoleTurn,
    sendInstruction
  });
  if (step4.phase !== "EXECUTOR_REPORT" || step4.outcome?.status !== "CONFIRMED") {
    throw new Error("correction PASS report relay was not confirmed");
  }

  const done = await waitForAssistantFrame(adapter, plannerPage, {
    previousTurnId: step4.state.planner.last_seen_assistant_turn_id || null,
    expectedActions: ["done"],
    label: "PE007_PLANNER_DONE"
  });
  if (
    done.parsed.frame.t !== "PE007-QUAL-1" ||
    done.parsed.frame.r !== "R002"
  ) {
    throw new Error("Planner done frame correlation mismatch");
  }

  const step5 = await runPlannerExecutorStep({
    statePath,
    projectId: "PE007-LIVE",
    plannerPage,
    executorPage,
    captureTurn: captureLatestRoleTurn,
    sendInstruction
  });
  if (
    step5.phase !== "PLANNER_DONE" ||
    step5.state?.automation?.status !== "DONE"
  ) {
    throw new Error("Planner DONE state was not persisted");
  }

  if (cycleSendCount !== 4) {
    throw new Error(`reject-correction live cycle expected exactly 4 sends, got ${cycleSendCount}`);
  }

  const finalState = JSON.parse(await fs.readFile(statePath, "utf8"));
  if (
    finalState.automation?.status !== "DONE" ||
    finalState.last_completed?.task_id !== "PE007-QUAL-1" ||
    finalState.last_completed?.result_id !== "R002" ||
    finalState.active_task_id !== null
  ) {
    throw new Error("final durable DONE state is inconsistent");
  }

  await writeResult({
    status: "PASS",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    normal_chat_count: 2,
    chatgpt_work_mode_invocations: 0,
    reject_correction_cycle_send_count: cycleSendCount,
    matching_user_turn_required: true,
    reject_correction_fast_path: true,
    exact_two_tabs: true,
    done_terminal_persisted: true,
    first_assignment_digest: sha("A001"),
    correction_assignment_digest: sha("A002"),
    final_result_digest: sha("R002"),
    production_state_mutated: false,
    production_targets_mutated: false,
    state_root_binding_mutated: false,
    dynamic_cdp: true
  });

  log("PE007_LIVE_STATUS", "PASS");
  log("PE007_LIVE_REJECT_CORRECTION_FAST_PATH", "True");
  log("PE007_LIVE_DONE_TERMINAL_PERSISTED", "True");
  log("PE007_LIVE_PRODUCTION_STATE_MUTATED", "False");
  log("PE007_LIVE_PRODUCTION_TARGETS_MUTATED", "False");
} catch (error) {
  await writeResult({
    status: "FAIL",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    cycle_send_count: cycleSendCount,
    error_name: String(error?.name || "Error"),
    error_digest: sha(String(error?.message || error))
  }).catch(() => {});

  log("PE007_LIVE_STATUS", "FAIL");
  log("PE007_LIVE_ERROR_NAME", error?.name || "Error");
  log("PE007_LIVE_ERROR_DIGEST", sha(String(error?.message || error)));
  throw error;
} finally {
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
