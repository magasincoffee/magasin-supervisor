import {
  runPlannerExecutorStep,
  readPlannerExecutorState
} from "./planner-executor.mjs";
import { captureLatestRoleTurn } from "../ui/latest-turn.mjs";
import { sendComposerInstruction } from "../ui/actions.mjs";

export function buildPe001PlannerQualificationPrompt() {
  return [
    "PE-001 LIVE QUALIFICATION ONLY.",
    "Do not use tools, apps, connectors, or ChatGPT Work mode.",
    "You are the Planner role in a temporary normal ChatGPT conversation.",
    "Create exactly one harmless Executor assignment.",
    "The assignment body must tell Executor to return a short PASS report and a final @M report frame correlated to the task and assignment.",
    "Use task_id PE001-QUAL-1 and assignment_id A001.",
    "When the result is later relayed to you, ACCEPT it and in the same response assign PE001-QUAL-2 with assignment_id A002.",
    "Include a short non-empty body for the next task.",
    "Your current response must end with this exact machine line and nothing after it:",
    '@M {"v":1,"a":"assign","t":"PE001-QUAL-1","i":"A001"}'
  ].join("\n");
}

export async function waitForNewAssistantTurn(
  page,
  previousTurnId = null,
  {
    captureTurn = captureLatestRoleTurn,
    timeoutMs = 120_000,
    intervalMs = 500
  } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const turn = await captureTurn(page, "assistant").catch(() => null);
    if (turn?.turn_id && turn.turn_id !== previousTurnId && turn.text) {
      return turn;
    }
    if (Date.now() < deadline && typeof page?.waitForTimeout === "function") {
      await page.waitForTimeout(intervalMs);
    } else if (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error("timed out waiting for a new assistant turn");
}

export async function runPe001LiveQualification({
  statePath,
  plannerPage,
  executorPage,
  captureTurn = captureLatestRoleTurn,
  sendInstruction = sendComposerInstruction,
  waitForTurn = waitForNewAssistantTurn,
  persist,
  inspectDraft,
  now
}) {
  if (!statePath) throw new Error("statePath is required");
  if (!plannerPage || !executorPage) {
    throw new Error("Planner and Executor pages are required");
  }

  const initialPlannerTurn = await captureTurn(plannerPage, "assistant")
    .catch(() => null);
  const bootstrap = buildPe001PlannerQualificationPrompt();
  const bootstrapSend = await sendInstruction(
    plannerPage,
    bootstrap,
    { dryRun: false }
  );
  if (!bootstrapSend?.executed) {
    throw new Error(
      `Planner bootstrap send was not confirmed: ${
        bootstrapSend?.reason ||
        bootstrapSend?.rejection_class ||
        "unknown"
      }`
    );
  }

  const plannerAssignmentTurn = await waitForTurn(
    plannerPage,
    initialPlannerTurn?.turn_id || null,
    { captureTurn }
  );

  const common = {
    statePath,
    projectId: "PE001-QUAL",
    plannerPage,
    executorPage,
    captureTurn,
    sendInstruction,
    ...(persist ? { persist } : {}),
    ...(inspectDraft ? { inspectDraft } : {}),
    ...(now ? { now } : {})
  };

  const first = await runPlannerExecutorStep(common);
  if (
    first.phase !== "PLANNER_ASSIGN" ||
    first.outcome?.status !== "CONFIRMED"
  ) {
    throw new Error(
      `Planner assignment did not reach Executor: ${
        first.phase
      } / ${first.outcome?.status || "no-outcome"}`
    );
  }

  const stateAfterAssignment = await readPlannerExecutorState(statePath);
  const executorReportTurn = await waitForTurn(
    executorPage,
    stateAfterAssignment.executor.last_seen_assistant_turn_id,
    { captureTurn }
  );

  const second = await runPlannerExecutorStep(common);
  if (
    second.phase !== "EXECUTOR_REPORT" ||
    second.outcome?.status !== "CONFIRMED"
  ) {
    throw new Error(
      `Executor report did not reach Planner: ${
        second.phase
      } / ${second.outcome?.status || "no-outcome"}`
    );
  }

  const stateAfterReport = await readPlannerExecutorState(statePath);
  const plannerDecisionTurn = await waitForTurn(
    plannerPage,
    stateAfterReport.planner.last_seen_assistant_turn_id,
    { captureTurn }
  );

  const third = await runPlannerExecutorStep(common);
  if (
    third.phase !== "PLANNER_ACCEPT_ASSIGN" ||
    third.outcome?.status !== "CONFIRMED"
  ) {
    throw new Error(
      `Planner accept_assign did not reach Executor: ${
        third.phase
      } / ${third.outcome?.status || "no-outcome"}`
    );
  }

  const finalState = await readPlannerExecutorState(statePath);
  if (
    finalState.last_completed?.task_id !== "PE001-QUAL-1" ||
    finalState.last_completed?.result_id == null ||
    finalState.active_task_id !== "PE001-QUAL-2" ||
    finalState.assignment?.assignment_id !== "A002"
  ) {
    throw new Error("PE-001 qualification final durable state is inconsistent");
  }

  return {
    schema_version: "pe001-live-qualification.v1",
    status: "PASS",
    project_id: "PE001-QUAL",
    bootstrap: {
      user_turn_evidence:
        bootstrapSend.user_turn_evidence || "send-confirmed"
    },
    task_cycle: {
      completed_task_id: finalState.last_completed.task_id,
      result_id: finalState.last_completed.result_id,
      next_task_id: finalState.active_task_id,
      next_assignment_id: finalState.assignment.assignment_id,
      send_count: 3
    },
    observed_turns: {
      planner_assignment_turn_id: plannerAssignmentTurn.turn_id,
      executor_report_turn_id: executorReportTurn.turn_id,
      planner_decision_turn_id: plannerDecisionTurn.turn_id
    },
    gates: {
      normal_chat_conversations: 2,
      chatgpt_work_mode_invocations: 0,
      matching_user_turn_send_verification: true,
      durable_before_send: true,
      accept_assign_combined_next_task: true
    }
  };
}
