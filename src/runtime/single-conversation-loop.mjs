import { randomUUID } from "node:crypto";

import { ACTIONS } from "../decision.mjs";
import {
  composerInstructionDigest,
  executeDecision,
  sendComposerInstruction
} from "../ui/actions.mjs";
import { captureLatestRoleTurn } from "../ui/latest-turn.mjs";
import {
  readSingleConversationState,
  writeSingleConversationState
} from "./single-conversation-state.mjs";

function nowIso(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error("invalid timestamp");
  return date.toISOString();
}

function safeErrorCode(error) {
  const code = String(error?.code || "").trim();
  if (code) return code.slice(0, 120);
  const message = String(error?.message || error || "");
  if (/login|required|auth/i.test(message)) return "AUTH_REQUIRED";
  if (/captcha|human/i.test(message)) return "CAPTCHA_REQUIRED";
  if (/network/i.test(message)) return "NETWORK_ERROR";
  if (/timeout/i.test(message)) return "RESPONSE_TIMEOUT";
  if (/continue/i.test(message)) return "CONTINUE_FAILED";
  if (/composer/i.test(message)) return "COMPOSER_NOT_READY";
  return "CYCLE_FAILED";
}

function assertActiveConversation(state) {
  if (state?.conversation?.status !== "ACTIVE") {
    throw new Error("single-conversation cycle requires an ACTIVE conversation");
  }
  if (!state?.source_of_truth?.url) {
    throw new Error("single-conversation cycle requires Source of Truth");
  }
}

export const TASK_CONTROL_HEADER = "MAGASIN_TASK_CONTROL_V1";
export const TASK_CONTROL_FOOTER = "END_MAGASIN_TASK_CONTROL_V1";

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const TASK_STATUSES = new Set(["READY", "RUNNING", "COMPLETE", "BLOCKED", "DONE"]);

function normalizeTaskId(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.toUpperCase() === "NONE") return null;
  if (!TASK_ID_RE.test(raw)) {
    throw Object.assign(new Error("invalid task id in task-control block"), {
      code: "TASK_PROTOCOL_INVALID"
    });
  }
  return raw;
}

export function parseTaskControl(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const canonicalPattern = /(?:^|\n)MAGASIN_TASK_CONTROL_V1\n([\s\S]*?)\nEND_MAGASIN_TASK_CONTROL_V1(?=\n|$)/g;
  let match = null;
  let renderedWhitespaceFallback = false;
  for (const candidate of source.matchAll(canonicalPattern)) {
    match = candidate;
  }

  // Current ChatGPT Markdown rendering can preserve the visible line layout
  // while exposing soft line breaks through innerText as ordinary whitespace.
  // Accept that presentation-only mutation without weakening the machine
  // contract: the fallback body must still consist exclusively of KEY=VALUE
  // tokens bounded by the exact header/footer.
  if (!match) {
    const renderedPattern = /(?:^|\s)MAGASIN_TASK_CONTROL_V1\s+([\s\S]*?)\s+END_MAGASIN_TASK_CONTROL_V1(?=\s|$)/g;
    for (const candidate of source.matchAll(renderedPattern)) {
      match = candidate;
    }
    renderedWhitespaceFallback = Boolean(match);
  }

  if (!match) {
    throw Object.assign(new Error("complete task-control block is missing"), {
      code: "TASK_PROTOCOL_INVALID"
    });
  }

  const body = match[1];
  const fields = new Map();
  const rawFields = renderedWhitespaceFallback
    ? body.trim().split(/\s+/)
    : body.split(/\r?\n/);

  for (const rawLine of rawFields) {
    const line = rawLine.trim();
    if (!line) continue;
    const fieldMatch = renderedWhitespaceFallback
      ? /^([A-Z_]+)=(\S*)$/.exec(line)
      : /^([A-Z_]+)=(.*)$/.exec(line);
    if (!fieldMatch) {
      throw Object.assign(new Error("malformed task-control line"), {
        code: "TASK_PROTOCOL_INVALID"
      });
    }
    fields.set(fieldMatch[1], fieldMatch[2].trim());
  }

  const status = String(fields.get("STATUS") || "").toUpperCase();
  if (!TASK_STATUSES.has(status)) {
    throw Object.assign(new Error("invalid task-control status"), {
      code: "TASK_PROTOCOL_INVALID"
    });
  }

  const taskId = normalizeTaskId(fields.get("TASK_ID"));
  const nextTaskId = normalizeTaskId(fields.get("NEXT_TASK_ID"));
  const checkAfter = Number(fields.get("CHECK_AFTER_SECONDS") || 0);
  if (!Number.isInteger(checkAfter) || checkAfter < 0 || checkAfter > 3600) {
    throw Object.assign(new Error("invalid CHECK_AFTER_SECONDS"), {
      code: "TASK_PROTOCOL_INVALID"
    });
  }

  if (status === "READY" && !nextTaskId) {
    throw Object.assign(new Error("READY requires NEXT_TASK_ID"), {
      code: "TASK_PROTOCOL_INVALID"
    });
  }
  if (status === "RUNNING" && (!taskId || checkAfter < 1)) {
    throw Object.assign(new Error("RUNNING requires TASK_ID and positive CHECK_AFTER_SECONDS"), {
      code: "TASK_PROTOCOL_INVALID"
    });
  }
  if (status === "COMPLETE" && (!taskId || !nextTaskId)) {
    throw Object.assign(new Error("COMPLETE requires TASK_ID and NEXT_TASK_ID"), {
      code: "TASK_PROTOCOL_INVALID"
    });
  }
  if (status === "COMPLETE" && taskId === nextTaskId) {
    throw Object.assign(new Error("COMPLETE cannot repeat the same TASK_ID as NEXT_TASK_ID"), {
      code: "TASK_PROTOCOL_INVALID"
    });
  }
  if ((status === "DONE" || status === "BLOCKED") && nextTaskId) {
    throw Object.assign(new Error(status + " must not include NEXT_TASK_ID"), {
      code: "TASK_PROTOCOL_INVALID"
    });
  }

  return {
    status,
    task_id: taskId,
    next_task_id: nextTaskId,
    check_after_seconds: checkAfter
  };
}

function taskControlContractLines() {
  return [
    "End the response with exactly one machine-readable block:",
    TASK_CONTROL_HEADER,
    "STATUS=<READY|RUNNING|COMPLETE|BLOCKED|DONE>",
    "TASK_ID=<existing SOT task id or NONE>",
    "NEXT_TASK_ID=<existing SOT task id or NONE>",
    "CHECK_AFTER_SECONDS=<0-3600>",
    TASK_CONTROL_FOOTER
  ];
}

export function buildSingleConversationTaskDiscoveryInstruction({
  sourceOfTruthUrl,
  messageId = randomUUID()
} = {}) {
  const source = String(sourceOfTruthUrl || "").trim();
  const id = String(messageId || "").trim();
  if (!source) throw new Error("sourceOfTruthUrl is required");
  if (!id) throw new Error("messageId is required");

  return [
    "MAGASIN_DISCOVER_TASK_V1",
    `id=${id}`,
    `SOT=${source}`,
    "Re-read SOT from the beginning.",
    "SOT is the sole project authority.",
    "Do not execute project work in this turn.",
    "Identify exactly one authoritative next executable task ID already present in SOT.",
    "If a task is available, use STATUS=READY and put it in NEXT_TASK_ID.",
    "If the project is finished, use STATUS=DONE. If Owner input is required, use STATUS=BLOCKED.",
    ...taskControlContractLines(),
    `End with: MAGASIN_CYCLE_CORRELATION_V1 ${id}`
  ].join("\n");
}

export function buildSingleConversationTaskInstruction({
  sourceOfTruthUrl,
  taskId,
  messageId = randomUUID(),
  checkOnly = false
} = {}) {
  const source = String(sourceOfTruthUrl || "").trim();
  const task = normalizeTaskId(taskId);
  const id = String(messageId || "").trim();
  if (!source) throw new Error("sourceOfTruthUrl is required");
  if (!task) throw new Error("taskId is required");
  if (!id) throw new Error("messageId is required");

  const common = [
    checkOnly ? "MAGASIN_CHECK_TASK_V1" : "MAGASIN_EXECUTE_TASK_V1",
    `id=${id}`,
    `TASK_ID=${task}`,
    `SOT=${source}`,
    "Re-read SOT only to validate this TASK_ID against current authoritative state.",
    "Do not select or execute a different task in this turn."
  ];

  if (checkOnly) {
    return [
      ...common,
      "Inspect the durable execution evidence for this same task.",
      "If it is still running, use STATUS=RUNNING with the same TASK_ID and a bounded CHECK_AFTER_SECONDS.",
      "If it completed, verify the result and use STATUS=COMPLETE with the next authoritative SOT task ID.",
      "If this completion finishes the whole project, use STATUS=DONE. If Owner input is required, use STATUS=BLOCKED.",
      ...taskControlContractLines(),
      `End with: MAGASIN_CYCLE_CORRELATION_V1 ${id}`
    ].join("\n");
  }

  return [
    ...common,
    "If valid, execute this task now using the available tools; do not merely report or recommend the work.",
    "Verify concrete completion evidence before declaring COMPLETE.",
    "For work expected to take more than about 5 minutes, prefer launching a durable external job/run when available, then return promptly with STATUS=RUNNING instead of holding the chat turn open.",
    "When STATUS=RUNNING, keep TASK_ID unchanged and choose a practical CHECK_AFTER_SECONDS (normally 30-600).",
    "After completion, report exactly one next authoritative task ID from SOT. If no work remains, use STATUS=DONE.",
    ...taskControlContractLines(),
    `End with: MAGASIN_CYCLE_CORRELATION_V1 ${id}`
  ].join("\n");
}

export function buildSingleConversationNextInstruction({
  sourceOfTruthUrl,
  messageId = randomUUID(),
  qualificationOnly = false
} = {}) {
  const source = String(sourceOfTruthUrl || "").trim();
  const id = String(messageId || "").trim();
  if (!source) throw new Error("sourceOfTruthUrl is required");
  if (!id) throw new Error("messageId is required");

  const common = [
    "MAGASIN_SINGLE_CONVERSATION_NEXT_V1",
    `id=${id}`,
    `SOT=${source}`,
    "Re-read SOT from the beginning before selecting the next action.",
    "SOT is the sole project authority; ignore stale chat state when it conflicts.",
    "Continue only from current authoritative state."
  ];

  if (qualificationOnly) {
    return [
      ...common,
      "QUALIFICATION ONLY: use read-only web access if needed; do not write to external systems.",
      "Report the Architecture generation read from SOT.",
      `End exactly: MAGASIN_CYCLE_CORRELATION_V1 ${id}`
    ].join(" ");
  }

  return [
    ...common,
    "Do exactly one bounded next unit allowed by SOT, or state DONE/BLOCKED.",
    `End with: MAGASIN_CYCLE_CORRELATION_V1 ${id}`
  ].join(" ");
}

async function persistAutomation(statePath, mutate, now) {
  const state = await readSingleConversationState(statePath);
  const at = nowIso(now);
  mutate(state, at);
  state.automation.updated_at = at;
  state.conversation.last_seen_at = at;
  return writeSingleConversationState(statePath, state, { now });
}

async function persistCyclePrepared(statePath, {
  messageId,
  message,
  baselineUserTurnId,
  now
}) {
  return persistAutomation(statePath, (state, at) => {
    assertActiveConversation(state);
    state.source_of_truth.sync_status = "SYNCING";
    state.outbound = {
      state: "PREPARED",
      message_id: messageId,
      message_digest: composerInstructionDigest(message),
      kind: "SOURCE_OF_TRUTH_NEXT_WORK",
      cmd_id: null,
      baseline_user_turn_id: baselineUserTurnId || null,
      delivered_user_turn_id: null,
      prepared_at: at,
      enqueued_at: null,
      delivered_at: null,
      response_running_at: null,
      response_complete_at: null,
      verified_at: null,
      retry_count: 0,
      last_error_code: null
    };
    state.automation.status = "RUNNING";
    state.automation.phase = "SEND_WORK";
    state.automation.reason = null;
  }, now);
}

async function persistCycleDelivered(statePath, {
  userTurnId,
  now
}) {
  return persistAutomation(statePath, (state, at) => {
    state.outbound.state = "DELIVERED";
    state.outbound.delivered_user_turn_id = userTurnId || null;
    state.outbound.delivered_at = at;
    state.outbound.last_error_code = null;
    state.automation.phase = "WAIT_RESPONSE";
  }, now);
}

async function persistCycleResponseRunning(statePath, now) {
  const state = await readSingleConversationState(statePath);
  if (state.outbound.state === "RESPONSE_RUNNING") return state;
  return persistAutomation(statePath, (next, at) => {
    next.outbound.state = "RESPONSE_RUNNING";
    next.outbound.response_running_at =
      next.outbound.response_running_at || at;
    next.automation.phase = "WAIT_RESPONSE";
  }, now);
}

async function persistContinueClick(statePath, count, now) {
  return persistAutomation(statePath, (state) => {
    state.automation.phase = "CONTINUE_RESPONSE";
    state.automation.continue_click_count = count;
  }, now);
}

async function persistCycleComplete(statePath, {
  assistantTurnId,
  now
}) {
  return persistAutomation(statePath, (state, at) => {
    state.outbound.state = "RESPONSE_COMPLETE";
    state.outbound.response_complete_at = at;
    state.outbound.last_error_code = null;
    state.source_of_truth.sync_status = "VERIFIED";
    state.source_of_truth.last_verified_at = at;
    state.automation.phase = "VERIFY_SOURCE_OF_TRUTH";
    state.automation.reason = null;
    state.automation.last_assistant_turn_id = assistantTurnId || null;
  }, now);
}

async function persistCycleFailure(statePath, error, now) {
  return persistAutomation(statePath, (state) => {
    const code = safeErrorCode(error);
    state.outbound.last_error_code = code;
    state.source_of_truth.sync_status =
      state.source_of_truth.sync_status === "SYNCING" ? "FAILED" : state.source_of_truth.sync_status;
    state.automation.status = "BLOCKED";
    state.automation.phase = "CYCLE_FAILED";
    state.automation.reason = code;
  }, now);
}

function assertSafeSnapshot(snapshot = {}) {
  if (snapshot.loginRequired) throw Object.assign(
    new Error("ChatGPT login is required"), { code: "AUTH_REQUIRED" }
  );
  if (snapshot.hasCaptcha) throw Object.assign(
    new Error("ChatGPT CAPTCHA requires Owner intervention"), { code: "CAPTCHA_REQUIRED" }
  );
  if (snapshot.conversationAccessDenied) throw Object.assign(
    new Error("ChatGPT access is denied"), { code: "ACCESS_DENIED" }
  );
  if (snapshot.conversationMissing) throw Object.assign(
    new Error("ChatGPT conversation is missing"), { code: "CONVERSATION_MISSING" }
  );
  if (snapshot.conversationFull) throw Object.assign(
    new Error("ChatGPT conversation is full"), { code: "CONVERSATION_FULL" }
  );
  if (snapshot.hasNetworkError) throw Object.assign(
    new Error("ChatGPT network error"), { code: "NETWORK_ERROR" }
  );
  if (snapshot.hasTransientError && !snapshot.responseRunning) throw Object.assign(
    new Error("ChatGPT transient error"), { code: "TRANSIENT_ERROR" }
  );
}

export async function waitForSingleConversationResponse({
  adapter,
  page,
  statePath,
  baselineAssistantTurnId = null,
  captureTurn = captureLatestRoleTurn,
  executeUiDecision = executeDecision,
  expectedAssistantMarker = null,
  assistantSettleMs = 8_000,
  timeoutMs = 180_000,
  pollMs = 600,
  maxContinueClicks = 8,
  transientFailureThreshold = 3,
  now = () => new Date().toISOString()
} = {}) {
  if (!adapter) throw new Error("adapter is required");
  if (!page) throw new Error("page is required");
  if (!statePath) throw new Error("statePath is required");

  const started = Date.now();
  let continueClicks = 0;
  let sawRunning = false;
  let consecutiveTransientFailures = 0;
  const transientLimit = Math.max(1, Number(transientFailureThreshold || 3));
  const expectedMarker = String(expectedAssistantMarker || "").trim();
  let stableAssistantDigest = null;
  let stableAssistantSince = 0;

  while (Date.now() - started <= timeoutMs) {
    const probe = await adapter.probePage(page);
    const snapshot = probe?.snapshot || {};

    // A single ChatGPT transient/network banner is not an unrecoverable
    // conversation fault. SOT replacement policy requires repeated failure.
    // Tolerate a bounded sequence while still failing closed at the threshold.
    const retryableTransient =
      !snapshot.responseRunning &&
      (snapshot.hasTransientError || snapshot.hasNetworkError);
    if (retryableTransient) {
      // ChatGPT can leave a transient/network banner rendered after the actual
      // assistant turn has completed. Exact cycle correlation is stronger
      // completion evidence than that stale banner, so reconcile it before
      // counting the transient toward the unrecoverable threshold.
      if (expectedMarker) {
        const assistant = await captureTurn(page, "assistant").catch(() => null);
        const assistantText = String(assistant?.text || "");
        if (
          assistant?.turn_id &&
          assistant.turn_id !== baselineAssistantTurnId &&
          assistantText.includes(expectedMarker)
        ) {
          await persistCycleComplete(statePath, {
            assistantTurnId: assistant.turn_id,
            now
          });
          return {
            status: "RESPONSE_COMPLETE",
            assistant_turn: assistant,
            continue_clicks: continueClicks,
            saw_running: sawRunning,
            marker_confirmed: true,
            stale_transient_banner_ignored: true
          };
        }
      }

      consecutiveTransientFailures += 1;
      if (consecutiveTransientFailures >= transientLimit) {
        assertSafeSnapshot(snapshot);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    consecutiveTransientFailures = 0;
    assertSafeSnapshot(snapshot);

    if (snapshot.responseRunning) {
      sawRunning = true;
      await persistCycleResponseRunning(statePath, now);
    } else if (snapshot.hasContinueControl) {
      if (continueClicks >= maxContinueClicks) {
        throw Object.assign(
          new Error("Continue generating click budget exhausted"),
          { code: "CONTINUE_BUDGET_EXHAUSTED" }
        );
      }

      const clicked = await executeUiDecision({
        page,
        decision: {
          action: ACTIONS.CONTINUE,
          // executeDecision uses this only if the safe Continue control
          // disappears between probe and actuation.
          instruction: "Continue the current response."
        },
        dryRun: false
      });
      if (!clicked?.executed || clicked.target !== "SAFE_CONTINUE_CONTROL") {
        throw Object.assign(
          new Error("safe Continue generating control was not actuated"),
          { code: "CONTINUE_NOT_ACTUATED" }
        );
      }
      continueClicks += 1;
      await persistContinueClick(statePath, continueClicks, now);
    } else {
      const assistant = await captureTurn(page, "assistant").catch(() => null);
      if (
        assistant?.turn_id &&
        assistant.turn_id !== baselineAssistantTurnId
      ) {
        const assistantText = String(assistant.text || "");
        const markerConfirmed =
          !expectedMarker || assistantText.includes(expectedMarker);

        if (!markerConfirmed && expectedMarker) {
          // SC-013: correlated requests are not complete until the exact
          // cycle marker appears. ChatGPT tool-use can briefly look idle and
          // expose stable intermediate assistant text while GitHub/Supabase
          // work is still in progress. Treat that as in-flight, never as a
          // completed turn, so no new Robot request can overlap the task.
          const digest = String(
            assistant.digest || assistant.turn_id || assistantText
          );
          const observedAt = Date.now();
          if (digest !== stableAssistantDigest) {
            stableAssistantDigest = digest;
            stableAssistantSince = observedAt;
          }
        } else {
          await persistCycleComplete(statePath, {
            assistantTurnId: assistant.turn_id,
            now
          });
          return {
            status: "RESPONSE_COMPLETE",
            assistant_turn: assistant,
            continue_clicks: continueClicks,
            saw_running: sawRunning,
            marker_confirmed: expectedMarker ? true : null
          };
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw Object.assign(new Error("single-conversation response timed out"), {
    code: "RESPONSE_TIMEOUT"
  });
}

export async function runSingleConversationCycle({
  adapter,
  page,
  statePath,
  messageId = randomUUID(),
  qualificationOnly = false,
  sendInstruction = sendComposerInstruction,
  captureTurn = captureLatestRoleTurn,
  executeUiDecision = executeDecision,
  timeoutMs = 180_000,
  pollMs = 600,
  maxContinueClicks = 8,
  now = () => new Date().toISOString()
} = {}) {
  if (!adapter) throw new Error("adapter is required");
  if (!page) throw new Error("page is required");
  if (!statePath) throw new Error("statePath is required");

  const state = await readSingleConversationState(statePath);
  assertActiveConversation(state);

  try {
    // Do not send a new user turn while the previous assistant answer is still
    // running or has an explicit Continue generating control. Settle it first.
    const preProbe = await adapter.probePage(page);
    assertSafeSnapshot(preProbe?.snapshot || {});
    if (
      preProbe?.snapshot?.responseRunning ||
      preProbe?.snapshot?.hasContinueControl
    ) {
      await waitForSingleConversationResponse({
        adapter,
        page,
        statePath,
        baselineAssistantTurnId: null,
        captureTurn,
        executeUiDecision,
        timeoutMs,
        pollMs,
        maxContinueClicks,
        now
      });
    }

    const baselineUser = await captureTurn(page, "user").catch(() => null);
    const baselineAssistant = await captureTurn(page, "assistant").catch(() => null);
    const message = buildSingleConversationNextInstruction({
      sourceOfTruthUrl: state.source_of_truth.url,
      messageId,
      qualificationOnly
    });

    await persistCyclePrepared(statePath, {
      messageId,
      message,
      baselineUserTurnId: baselineUser?.turn_id || null,
      now
    });

    const sent = await sendInstruction(page, message, { dryRun: false });
    if (!sent?.executed) {
      throw Object.assign(
        new Error(sent?.reason || "next-work send was not confirmed"),
        { code: sent?.rejection_class || "SEND_NOT_CONFIRMED" }
      );
    }

    const delivered = await captureTurn(page, "user").catch(() => null);
    if (!delivered?.turn_id) {
      throw Object.assign(
        new Error("next-work matching user turn could not be captured"),
        { code: "USER_TURN_NOT_CAPTURED" }
      );
    }
    await persistCycleDelivered(statePath, {
      userTurnId: delivered.turn_id,
      now
    });

    const response = await waitForSingleConversationResponse({
      adapter,
      page,
      statePath,
      baselineAssistantTurnId: baselineAssistant?.turn_id || null,
      captureTurn,
      executeUiDecision,
      expectedAssistantMarker:
        `MAGASIN_CYCLE_CORRELATION_V1 ${messageId}`,
      timeoutMs,
      pollMs,
      maxContinueClicks,
      now
    });

    return {
      message_id: messageId,
      message,
      send: sent,
      response
    };
  } catch (error) {
    await persistCycleFailure(statePath, error, now).catch(() => {});
    throw error;
  }
}

export async function runSingleConversationCycles({
  cycles = 1,
  ...options
} = {}) {
  const count = Number(cycles);
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error("cycles must be an integer between 1 and 20");
  }

  const results = [];
  for (let index = 0; index < count; index += 1) {
    const result = await runSingleConversationCycle({
      ...options,
      messageId: options.messageIdFactory
        ? options.messageIdFactory(index)
        : randomUUID()
    });
    results.push(result);
  }
  return results;
}
