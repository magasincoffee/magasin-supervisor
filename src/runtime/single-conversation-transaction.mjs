import {
  captureMatchingUserTurnEvidence,
  composerInstructionDigest,
  composerRenderedInstructionDigest,
  inspectComposerDraftDigest,
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

function requireMessageId(value) {
  const id = String(value || "").trim();
  if (!id) throw new Error("messageId is required");
  return id;
}

function requireMessage(value) {
  const message = String(value || "");
  if (!message.trim()) throw new Error("message is required");
  return message;
}

function transactionCode(error) {
  const code = String(error?.code || "").trim();
  return code || "EXACT_ONCE_FAILED";
}

async function mutateState(statePath, mutate, now) {
  const state = await readSingleConversationState(statePath);
  const at = nowIso(now);
  mutate(state, at);
  state.updated_at = at;
  return writeSingleConversationState(statePath, state, { now });
}

function assertSameTransaction(state, messageId, message) {
  const id = requireMessageId(messageId);
  const text = requireMessage(message);
  const digest = composerInstructionDigest(text);
  if (state.outbound?.message_id !== id) {
    throw Object.assign(new Error("outbound message_id mismatch"), {
      code: "OUTBOUND_ID_MISMATCH"
    });
  }
  if (state.outbound?.message_digest !== digest) {
    throw Object.assign(new Error("outbound message digest mismatch"), {
      code: "OUTBOUND_DIGEST_MISMATCH"
    });
  }
  return { id, text, digest };
}

export async function prepareExactOnceOutbound(statePath, {
  messageId,
  message,
  kind,
  taskId = null,
  baselineUserTurnId = null,
  initialRetryCount = 0,
  now = () => new Date().toISOString()
} = {}) {
  const id = requireMessageId(messageId);
  const text = requireMessage(message);
  const digest = composerInstructionDigest(text);
  const outboundKind = String(kind || "SINGLE_CONVERSATION_MESSAGE").trim();
  const outboundTaskId = String(taskId || "").trim() || null;
  const startingRetryCount = Number(initialRetryCount || 0);
  if (
    !Number.isInteger(startingRetryCount) ||
    startingRetryCount < 0 ||
    startingRetryCount > 1
  ) {
    throw Object.assign(
      new Error("initial retry count must be 0 or 1"),
      { code: "INVALID_INITIAL_RETRY_COUNT" }
    );
  }

  return mutateState(statePath, (state, at) => {
    const current = String(state.outbound?.state || "NONE").toUpperCase();
    if (!["NONE", "RESPONSE_COMPLETE", "VERIFIED"].includes(current)) {
      if (
        state.outbound?.message_id === id &&
        state.outbound?.message_digest === digest
      ) {
        return;
      }
      throw Object.assign(
        new Error("another outbound transaction is still active"),
        { code: "OUTBOUND_TRANSACTION_ACTIVE" }
      );
    }
    state.outbound = {
      state: "PREPARED",
      message_id: id,
      message_digest: digest,
      kind: outboundKind.slice(0, 80),
      task_id: outboundTaskId,
      cmd_id: null,
      baseline_user_turn_id: baselineUserTurnId || null,
      delivered_user_turn_id: null,
      prepared_at: at,
      enqueued_at: null,
      delivered_at: null,
      response_running_at: null,
      response_complete_at: null,
      verified_at: null,
      retry_count: startingRetryCount,
      last_error_code: null,
      last_error_stage: null,
      last_pre_actuation_error_code: null,
      last_pre_actuation_error_stage: null
    };
    state.automation.status = "RUNNING";
    state.automation.phase = "SEND_WORK";
    state.automation.reason = null;
    state.automation.updated_at = at;
  }, now);
}

export async function markExactOnceEnqueued(statePath, {
  messageId,
  message,
  retry = false,
  now = () => new Date().toISOString()
} = {}) {
  return mutateState(statePath, (state, at) => {
    const { id } = assertSameTransaction(state, messageId, message);
    const current = String(state.outbound.state || "").toUpperCase();
    if (!["PREPARED", "ENQUEUED"].includes(current)) {
      throw Object.assign(
        new Error("outbound transaction cannot be enqueued from current state"),
        { code: "INVALID_ENQUEUE_STATE" }
      );
    }
    state.outbound.state = "ENQUEUED";
    state.outbound.cmd_id = state.outbound.cmd_id || `ui:${id}`;
    state.outbound.enqueued_at = state.outbound.enqueued_at || at;
    if (retry) {
      state.outbound.retry_count = Number(state.outbound.retry_count || 0) + 1;
    }
    state.outbound.last_error_code = null;
    state.outbound.last_error_stage = null;
    state.automation.status = "RUNNING";
    state.automation.reason = null;
    state.automation.phase = "SEND_WORK";
    state.automation.updated_at = at;
  }, now);
}

export async function markExactOnceDelivered(statePath, {
  messageId,
  message,
  userTurnId,
  now = () => new Date().toISOString()
} = {}) {
  return mutateState(statePath, (state, at) => {
    assertSameTransaction(state, messageId, message);
    const current = String(state.outbound.state || "").toUpperCase();
    if (!["ENQUEUED", "DELIVERED", "RESPONSE_RUNNING"].includes(current)) {
      throw Object.assign(new Error("invalid delivery transition"), {
        code: "INVALID_DELIVERY_STATE"
      });
    }
    state.outbound.state = "DELIVERED";
    state.outbound.delivered_user_turn_id =
      userTurnId || state.outbound.delivered_user_turn_id || null;
    state.outbound.delivered_at = state.outbound.delivered_at || at;
    state.outbound.last_error_code = null;
    state.outbound.last_error_stage = null;
    state.outbound.last_pre_actuation_error_code = null;
    state.outbound.last_pre_actuation_error_stage = null;
    state.automation.status = "RUNNING";
    state.automation.reason = null;
    state.automation.phase = "WAIT_RESPONSE";
    state.automation.updated_at = at;
  }, now);
}

export async function rewindFalseHistoricalDiscoveryDelivery(statePath, {
  messageId,
  message,
  latestUserTurnId,
  composerReady,
  composerHasText,
  now = () => new Date().toISOString()
} = {}) {
  const latestId = String(latestUserTurnId || "").trim();
  if (!latestId) {
    throw Object.assign(new Error("latest user turn id is required for false-delivery rewind"), {
      code: "FALSE_DELIVERY_REWIND_UNVERIFIED"
    });
  }
  if (composerReady !== true || composerHasText !== false) {
    throw Object.assign(new Error("composer must be readable and empty for false-delivery rewind"), {
      code: "FALSE_DELIVERY_REWIND_UNVERIFIED"
    });
  }

  return mutateState(statePath, (state, at) => {
    assertSameTransaction(state, messageId, message);
    const outbound = state.outbound || {};
    const current = String(outbound.state || "").toUpperCase();
    const baselineId = String(outbound.baseline_user_turn_id || "").trim();
    const deliveredId = String(outbound.delivered_user_turn_id || "").trim();

    const provenFalseHistoricalDelivery = Boolean(
      String(state?.conversation?.status || "").toUpperCase() === "ACTIVE" &&
      ["DELIVERED", "RESPONSE_RUNNING"].includes(current) &&
      String(outbound.kind || "") === "SOURCE_OF_TRUTH_TASK_DISCOVERY" &&
      Number(outbound.retry_count || 0) === 0 &&
      baselineId &&
      deliveredId &&
      deliveredId !== baselineId &&
      latestId === baselineId
    );

    if (!provenFalseHistoricalDelivery) {
      throw Object.assign(new Error("false historical delivery could not be positively proven"), {
        code: "FALSE_DELIVERY_REWIND_UNVERIFIED"
      });
    }

    state.outbound.state = "ENQUEUED";
    state.outbound.delivered_user_turn_id = null;
    state.outbound.delivered_at = null;
    state.outbound.response_running_at = null;
    state.outbound.response_complete_at = null;
    state.outbound.verified_at = null;
    state.outbound.last_error_code = "SEND_NOT_ACTUATED";
    state.outbound.last_error_stage = "HISTORICAL_USER_TURN_FALSE_DELIVERY";
    state.automation.status = "RUNNING";
    state.automation.phase = "SEND_WORK";
    state.automation.reason = null;
    state.automation.updated_at = at;
  }, now);
}

export async function markExactOnceResponseComplete(statePath, {
  messageId,
  message,
  now = () => new Date().toISOString()
} = {}) {
  return mutateState(statePath, (state, at) => {
    assertSameTransaction(state, messageId, message);
    if (!["DELIVERED", "RESPONSE_RUNNING", "RESPONSE_COMPLETE"].includes(
      String(state.outbound.state || "").toUpperCase()
    )) {
      throw Object.assign(new Error("invalid response-complete transition"), {
        code: "INVALID_RESPONSE_COMPLETE_STATE"
      });
    }
    state.outbound.state = "RESPONSE_COMPLETE";
    state.outbound.response_complete_at =
      state.outbound.response_complete_at || at;
    state.outbound.last_error_code = null;
    state.automation.phase = "VERIFY_SOURCE_OF_TRUTH";
    state.automation.updated_at = at;
  }, now);
}

export async function markExactOnceVerified(statePath, {
  messageId,
  message,
  now = () => new Date().toISOString()
} = {}) {
  return mutateState(statePath, (state, at) => {
    assertSameTransaction(state, messageId, message);
    if (!["RESPONSE_COMPLETE", "VERIFIED"].includes(
      String(state.outbound.state || "").toUpperCase()
    )) {
      throw Object.assign(new Error("invalid verified transition"), {
        code: "INVALID_VERIFIED_STATE"
      });
    }
    state.outbound.state = "VERIFIED";
    state.outbound.verified_at = state.outbound.verified_at || at;
    state.outbound.last_error_code = null;
    state.source_of_truth.sync_status = "VERIFIED";
    state.source_of_truth.last_verified_at = at;
    state.automation.phase = "NEXT_WORK";
    state.automation.updated_at = at;
  }, now);
}

async function persistExactOnceFailure(statePath, error, now) {
  return mutateState(statePath, (state, at) => {
    const code = transactionCode(error).slice(0, 120);
    const stage = String(error?.failure_stage || "").trim().slice(0, 120) || null;
    state.outbound.last_error_code = code;
    state.outbound.last_error_stage = stage;
    if (error?.pre_actuation === true) {
      state.outbound.last_pre_actuation_error_code = code;
      state.outbound.last_pre_actuation_error_stage = stage;
    }
    state.automation.status = "BLOCKED";
    state.automation.reason = state.outbound.last_error_code;
    state.automation.updated_at = at;
  }, now);
}

function latestTurnMatchesMessage(turn, digest) {
  if (!turn?.text) return false;
  return composerInstructionDigest(turn.text) === digest;
}

function baselineStillCurrent(turn, baselineUserTurnId) {
  const baseline = String(baselineUserTurnId || "").trim();
  if (!baseline) return !turn;
  return String(turn?.turn_id || "") === baseline;
}

function currentMatchingUserTurnId(matching, latestUser, digest) {
  const latestTurnId = String(latestUser?.turn_id || "").trim();
  if (latestTurnMatchesMessage(latestUser, digest)) {
    return latestTurnId || null;
  }
  if (!matching?.confirmed) return null;

  const matchingTurnId = String(matching?.turn_id || "").trim();
  return (
    matchingTurnId &&
    latestTurnId &&
    matchingTurnId === latestTurnId
  )
    ? matchingTurnId
    : null;
}

export async function reconcileExactOnceOutbound({
  statePath,
  page,
  messageId,
  message,
  sendInstruction = sendComposerInstruction,
  captureTurn = captureLatestRoleTurn,
  captureMatchingTurn = captureMatchingUserTurnEvidence,
  inspectDraft = inspectComposerDraftDigest,
  maxSafeRetries = 1,
  reconciliationProbes = 5,
  reconciliationPollMs = 200,
  now = () => new Date().toISOString()
} = {}) {
  if (!statePath) throw new Error("statePath is required");
  if (!page) throw new Error("page is required");
  const id = requireMessageId(messageId);
  const text = requireMessage(message);

  try {
    let state = await readSingleConversationState(statePath);
    const { digest } = assertSameTransaction(state, id, text);
    const renderedDigest = composerRenderedInstructionDigest(text);
    let current = String(state.outbound.state || "").toUpperCase();

    if (["DELIVERED", "RESPONSE_RUNNING", "RESPONSE_COMPLETE", "VERIFIED"].includes(current)) {
      return {
        action: "NO_SEND",
        state: current,
        cmd_id: state.outbound.cmd_id || null,
        reason: "already-delivered-or-later"
      };
    }
    if (!["PREPARED", "ENQUEUED"].includes(current)) {
      throw Object.assign(new Error("outbound state is not reconcilable"), {
        code: "OUTBOUND_NOT_RECONCILABLE"
      });
    }

    let latestUser = null;
    let draft = null;
    let positiveNonDelivery = false;

    const probes = Math.max(1, Number(reconciliationProbes) || 1);
    for (let index = 0; index < probes; index += 1) {
      const matching = await captureMatchingTurn(page, text).catch(() => null);
      latestUser = await captureTurn(page, "user").catch(() => null);
      const currentMatchingTurnId =
        currentMatchingUserTurnId(matching, latestUser, digest);
      if (currentMatchingTurnId) {
        if (current === "PREPARED") {
          await markExactOnceEnqueued(statePath, {
            messageId: id,
            message: text,
            now
          });
        }
        await markExactOnceDelivered(statePath, {
          messageId: id,
          message: text,
          userTurnId: currentMatchingTurnId,
          now
        });
        const delivered = await readSingleConversationState(statePath);
        return {
          action: "NO_SEND",
          state: "DELIVERED",
          cmd_id: delivered.outbound.cmd_id,
          reason: "matching-user-turn-reconciled"
        };
      }

      draft = await inspectDraft(page).catch(() => ({
        ready: false,
        has_text: null,
        digest: null
      }));

      if (
        current === "ENQUEUED" &&
        draft?.has_text &&
        draft.digest !== digest &&
        draft.rendered_digest !== renderedDigest
      ) {
        throw Object.assign(
          new Error("different composer draft makes outbound delivery ambiguous"),
          { code: "AMBIGUOUS_COMPOSER_DRAFT" }
        );
      }

      if (
        !draft?.has_text &&
        baselineStillCurrent(latestUser, state.outbound.baseline_user_turn_id)
      ) {
        positiveNonDelivery = true;
      } else {
        positiveNonDelivery = false;
      }

      if (index < probes - 1 && typeof page.waitForTimeout === "function") {
        await page.waitForTimeout(reconciliationPollMs);
      }
    }

    state = await readSingleConversationState(statePath);
    current = String(state.outbound.state || "").toUpperCase();

    let retry = false;
    if (current === "ENQUEUED") {
      if (
        state.outbound.last_error_code === "AMBIGUOUS_POST_SEND_DELIVERY"
      ) {
        throw Object.assign(
          new Error("prior post-send delivery outcome remains ambiguous"),
          { code: "AMBIGUOUS_POST_SEND_DELIVERY" }
        );
      }
      const durablePreActuationEvidence =
        String(state.outbound.last_pre_actuation_error_code || "") ===
        "COMPOSER_NOT_READY";
      if (
        !positiveNonDelivery &&
        !draft?.has_text &&
        !durablePreActuationEvidence
      ) {
        throw Object.assign(
          new Error("prior ENQUEUED send outcome remains ambiguous"),
          { code: "AMBIGUOUS_ENQUEUED_OUTCOME" }
        );
      }
      const retries = Number(state.outbound.retry_count || 0);
      if (retries >= maxSafeRetries) {
        throw Object.assign(
          new Error("exact-once safe retry budget exhausted"),
          { code: "SAFE_RETRY_BUDGET_EXHAUSTED" }
        );
      }
      retry = true;
    }

    await markExactOnceEnqueued(statePath, {
      messageId: id,
      message: text,
      retry,
      now
    });

    const sent = await sendInstruction(page, text, { dryRun: false });
    if (!sent?.executed) {
      throw Object.assign(
        new Error(sent?.reason || "outbound send was not confirmed"),
        {
          code: sent?.rejection_class || "SEND_NOT_CONFIRMED",
          failure_stage: sent?.failure_stage || null,
          pre_actuation:
            sent?.rejection_class === "COMPOSER_NOT_READY"
        }
      );
    }

    let deliveredTurn = null;
    let matchingDelivery = null;
    const deliveryProbes = Math.max(
      5,
      Number(reconciliationProbes) || 1
    );
    for (let index = 0; index < deliveryProbes; index += 1) {
      matchingDelivery = await captureMatchingTurn(page, text).catch(() => null);
      deliveredTurn = await captureTurn(page, "user").catch(() => null);
      if (
        matchingDelivery?.confirmed ||
        latestTurnMatchesMessage(deliveredTurn, digest)
      ) break;
      if (
        index < deliveryProbes - 1 &&
        typeof page.waitForTimeout === "function"
      ) {
        await page.waitForTimeout(reconciliationPollMs);
      }
    }

    if (
      !matchingDelivery?.confirmed &&
      !latestTurnMatchesMessage(deliveredTurn, digest)
    ) {
      throw Object.assign(
        new Error("send succeeded but durable delivery evidence remains ambiguous"),
        { code: "AMBIGUOUS_POST_SEND_DELIVERY" }
      );
    }

    await markExactOnceDelivered(statePath, {
      messageId: id,
      message: text,
      userTurnId: latestTurnMatchesMessage(deliveredTurn, digest)
        ? deliveredTurn?.turn_id || null
        : matchingDelivery?.turn_id || null,
      now
    });

    const deliveredState = await readSingleConversationState(statePath);
    return {
      action: retry ? "SAFE_RETRY_SENT" : "SEND",
      state: "DELIVERED",
      cmd_id: deliveredState.outbound.cmd_id,
      retry_count: deliveredState.outbound.retry_count,
      send: sent
    };
  } catch (error) {
    await persistExactOnceFailure(statePath, error, now).catch(() => {});
    throw error;
  }
}
