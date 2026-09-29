import { randomUUID } from "node:crypto";

import {
  discardComposerDraftIfDigest,
  inspectComposerDraftDigest
} from "../ui/actions.mjs";
import { createNewChatAndBootstrap } from "./single-conversation-bootstrap.mjs";
import {
  readSingleConversationState,
  retireConversation,
  writeSingleConversationState
} from "./single-conversation-state.mjs";

function nowIso(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error("invalid timestamp");
  return date.toISOString();
}

export function classifyDisposableConversation(snapshot = {}, {
  consecutiveTransientFailures = 0,
  transientFailureThreshold = 3
} = {}) {
  if (snapshot.loginRequired) {
    return { action: "WAIT_OWNER", reason: "AUTH_REQUIRED" };
  }
  if (snapshot.hasCaptcha) {
    return { action: "WAIT_OWNER", reason: "CAPTCHA_REQUIRED" };
  }

  if (
    snapshot.pageClosed ||
    snapshot.unrecoverableStalePage
  ) {
    return { action: "REPLACE_CHAT", reason: "STALE_OR_CLOSED_PAGE" };
  }
  if (
    snapshot.pageIdentityAmbiguous ||
    snapshot.conversationIdentityAmbiguous
  ) {
    return { action: "REPLACE_CHAT", reason: "AMBIGUOUS_PAGE_IDENTITY" };
  }

  if (snapshot.conversationMissing) {
    return { action: "REPLACE_CHAT", reason: "CONVERSATION_MISSING" };
  }
  if (snapshot.conversationAccessDenied) {
    return { action: "REPLACE_CHAT", reason: "CONVERSATION_ACCESS_DENIED" };
  }
  if (snapshot.conversationFull) {
    return { action: "REPLACE_CHAT", reason: "CONVERSATION_FULL" };
  }

  if (
    !snapshot.responseRunning &&
    snapshot.composerReady === false &&
    snapshot.conversationPath
  ) {
    return { action: "REPLACE_CHAT", reason: "COMPOSER_UNAVAILABLE" };
  }

  const failures = Number(consecutiveTransientFailures || 0);
  const threshold = Math.max(1, Number(transientFailureThreshold || 3));
  if (
    (snapshot.hasNetworkError || snapshot.hasTransientError) &&
    failures >= threshold
  ) {
    return {
      action: "REPLACE_CHAT",
      reason: snapshot.hasNetworkError
        ? "REPEATED_NETWORK_FAILURE"
        : "REPEATED_TRANSIENT_FAILURE"
    };
  }

  return { action: "KEEP_CHAT", reason: "USABLE_OR_RETRYABLE" };
}

async function persistRecoveryEvidence(statePath, {
  reason,
  now
}) {
  const state = await readSingleConversationState(statePath);
  const at = nowIso(now);
  const prior = state.outbound || {};
  state.recovery = {
    schema_version: "single-conversation-recovery.v1",
    retired_generation: Number(state.conversation?.generation || 0),
    reason: String(reason || "UNUSABLE").slice(0, 120),
    recorded_at: at,
    prior_outbound: {
      state: prior.state || "NONE",
      message_id: prior.message_id || null,
      message_digest: prior.message_digest || null,
      kind: prior.kind || null,
      cmd_id: prior.cmd_id || null,
      baseline_user_turn_id: prior.baseline_user_turn_id || null,
      delivered_user_turn_id: prior.delivered_user_turn_id || null,
      retry_count: Number(prior.retry_count || 0)
    },
    rehydrated_generation: null,
    rehydrated_at: null
  };
  state.automation.status = "RUNNING";
  state.automation.phase = "REPLACE_CHAT";
  state.automation.reason = String(reason || "UNUSABLE").slice(0, 120);
  state.automation.updated_at = at;
  return writeSingleConversationState(statePath, state, { now });
}

async function persistRehydrated(statePath, now) {
  const state = await readSingleConversationState(statePath);
  const at = nowIso(now);
  if (!state.recovery || typeof state.recovery !== "object") {
    state.recovery = {
      schema_version: "single-conversation-recovery.v1"
    };
  }
  state.recovery.rehydrated_generation =
    Number(state.conversation?.generation || 0);
  state.recovery.rehydrated_at = at;
  state.automation.reason = null;
  state.automation.updated_at = at;
  return writeSingleConversationState(statePath, state, { now });
}

async function clearRobotOwnedDraftBeforeRetire(page, state) {
  if (!page) return { cleared: false, reason: "NO_PAGE" };

  const draft = await inspectComposerDraftDigest(page).catch(() => ({
    ready: false,
    has_text: null,
    digest: null,
    reason: "draft inspection failed"
  }));

  if (!draft.has_text) {
    return { cleared: false, reason: "NO_DRAFT" };
  }

  const expected = String(state?.outbound?.message_digest || "").trim();
  if (!expected || draft.digest !== expected) {
    throw Object.assign(
      new Error("unowned composer draft blocks disposable-chat replacement"),
      { code: "UNOWNED_DRAFT_PRESENT" }
    );
  }

  const discarded = await discardComposerDraftIfDigest(page, expected);
  if (!discarded?.discarded) {
    throw Object.assign(
      new Error(discarded?.reason || "Robot-owned draft could not be discarded"),
      { code: "ROBOT_DRAFT_DISCARD_FAILED" }
    );
  }
  return { cleared: true, reason: "ROBOT_DRAFT_DISCARDED" };
}

export async function replaceDisposableConversation({
  adapter,
  page,
  statePath,
  reason,
  sourceOfTruthUrl = null,
  projectId = "LIVE",
  messageId = randomUUID(),
  sendInstruction,
  captureTurn,
  qualificationOnly = false,
  onPageAcquired = null,
  timeoutMs = 180_000,
  pollMs = 750,
  now = () => new Date().toISOString()
} = {}) {
  if (!adapter) throw new Error("adapter is required");
  if (!statePath) throw new Error("statePath is required");
  if (!reason) throw new Error("replacement reason is required");

  const before = await readSingleConversationState(statePath);
  if (!["ACTIVE", "UNUSABLE", "RETIRED"].includes(before.conversation?.status)) {
    throw new Error("disposable-chat replacement requires an existing conversation generation");
  }
  const source = sourceOfTruthUrl || before.source_of_truth?.url;
  if (!source) throw new Error("Source of Truth is required for conversation replacement");

  await persistRecoveryEvidence(statePath, { reason, now });

  if (page && !page.isClosed?.()) {
    await clearRobotOwnedDraftBeforeRetire(page, before);
  }

  await retireConversation(statePath, { reason, at: now });

  // SC-012: never close the current/last Chrome page before a replacement
  // page exists. In the dedicated Supervisor Chrome, closing the final tab can
  // terminate Chrome/CDP itself; the subsequent bootstrap then runs against a
  // dead browser and the wrapper can enter a replacement/restart storm.
  //
  // createNewChatAndBootstrap invokes onPageAcquired immediately after the
  // fresh page is committed and before it starts the new generation or sends
  // the bootstrap. Close the retired page at that boundary: a live replacement
  // page already keeps Chrome/CDP alive, while steady state still returns to a
  // single Robot-controlled ChatGPT page before any new message mutation.
  const closeRetiredPageAfterReplacementAcquired = async (
    replacementPage,
    surface
  ) => {
    if (
      page &&
      page !== replacementPage &&
      !page.isClosed?.()
    ) {
      const closed = await adapter.closePage(page);
      if (closed === false) {
        throw Object.assign(
          new Error("retired ChatGPT page could not be closed"),
          { code: "RETIRED_PAGE_CLOSE_FAILED" }
        );
      }
    }

    if (typeof onPageAcquired === "function") {
      await onPageAcquired(replacementPage, surface);
    }
  };

  const result = await createNewChatAndBootstrap({
    adapter,
    statePath,
    sourceOfTruthUrl: source,
    projectId,
    messageId,
    qualificationOnly,
    forceNewPage: true,
    onPageAcquired: closeRetiredPageAfterReplacementAcquired,
    sendInstruction,
    captureTurn,
    timeoutMs,
    pollMs,
    now
  });

  await persistRehydrated(statePath, now);

  const after = await readSingleConversationState(statePath);
  if (after.conversation.generation <= before.conversation.generation) {
    throw new Error("conversation replacement did not advance generation");
  }

  return {
    ...result,
    replaced_generation: before.conversation.generation,
    active_generation: after.conversation.generation,
    replacement_reason: String(reason)
  };
}

export async function recoverDisposableConversationIfNeeded({
  adapter,
  page,
  statePath,
  consecutiveTransientFailures = 0,
  transientFailureThreshold = 3,
  ...replacementOptions
} = {}) {
  if (!adapter) throw new Error("adapter is required");
  if (!page) throw new Error("page is required");

  const pageClosed =
    typeof page.isClosed === "function" && page.isClosed();
  let probe = null;
  if (pageClosed) {
    probe = { snapshot: { pageClosed: true } };
  } else {
    try {
      probe = await adapter.probePage(page);
    } catch (error) {
      // The page can close after the isClosed() check but before Playwright
      // evaluates the probe. Treat that narrow race exactly like a page that
      // was already closed so disposable-chat recovery can replace it.
      const closedNow =
        typeof page.isClosed === "function" && page.isClosed();
      const message = String(error?.message || error || "");
      if (
        closedNow ||
        /page is required|target page.*(?:closed|context)|browser has been closed/i.test(message)
      ) {
        probe = { snapshot: { pageClosed: true } };
      } else {
        throw error;
      }
    }
  }
  const classification = classifyDisposableConversation(
    probe?.snapshot || {},
    { consecutiveTransientFailures, transientFailureThreshold }
  );

  if (classification.action === "KEEP_CHAT") {
    return { recovered: false, classification, page };
  }
  if (classification.action === "WAIT_OWNER") {
    throw Object.assign(
      new Error("conversation recovery requires Owner intervention"),
      { code: classification.reason }
    );
  }

  const result = await replaceDisposableConversation({
    adapter,
    page,
    statePath,
    reason: classification.reason,
    ...replacementOptions
  });
  return {
    recovered: true,
    classification,
    page: result.page,
    result
  };
}
