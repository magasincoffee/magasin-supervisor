import crypto, { randomUUID } from "node:crypto";

import {
  composerInstructionDigest,
  sendComposerInstruction
} from "../ui/actions.mjs";
import { captureLatestRoleTurn } from "../ui/latest-turn.mjs";
import { isChatGptUrl } from "../ui/playwright-adapter.mjs";
import {
  beginConversationGeneration,
  ensureSingleConversationState,
  readSingleConversationState,
  writeSingleConversationState
} from "./single-conversation-state.mjs";

const HOME_URL = "https://chatgpt.com/";

function nowIso(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error("invalid timestamp");
  return date.toISOString();
}

function opaqueRuntimeIdentity(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (!isChatGptUrl(parsed.toString())) return null;
    if (!/^\/(?:c|g|project)\//.test(parsed.pathname)) return null;
    return "chat:" + crypto
      .createHash("sha256")
      .update(parsed.origin + parsed.pathname, "utf8")
      .digest("hex")
      .slice(0, 32);
  } catch {
    return null;
  }
}

function pageUrl(page) {
  try {
    return String(page?.url?.() || "");
  } catch {
    return "";
  }
}

function isHomeChatGptPage(page) {
  try {
    const url = new URL(pageUrl(page));
    return isChatGptUrl(url.toString()) && url.pathname === "/";
  } catch {
    return false;
  }
}

function safeErrorCode(error) {
  const explicit = String(error?.code || "").trim();
  if (explicit) return explicit.slice(0, 120);
  const message = String(error?.message || error || "");
  if (/login|required|auth/i.test(message)) return "AUTH_REQUIRED";
  if (/captcha|human/i.test(message)) return "CAPTCHA_REQUIRED";
  if (/composer/i.test(message)) return "COMPOSER_NOT_READY";
  if (/timeout/i.test(message)) return "RESPONSE_TIMEOUT";
  return "BOOTSTRAP_FAILED";
}

export function buildSingleConversationBootstrap({
  sourceOfTruthUrl,
  messageId = randomUUID(),
  qualificationOnly = false
} = {}) {
  const source = String(sourceOfTruthUrl || "").trim();
  const id = String(messageId || "").trim();
  if (!source) throw new Error("sourceOfTruthUrl is required");
  if (!id) throw new Error("messageId is required");

  const common = [
    "MAGASIN_SINGLE_CONVERSATION_BOOTSTRAP_V1",
    `message_id=${id}`,
    `source_of_truth=${source}`,
    "Read the Source of Truth URL above from the beginning before deciding or doing project work.",
    "Treat that Source of Truth as the only project authority.",
    "Ignore stale project state from prior chats, memory, README, or historical documents when they conflict with the Source of Truth."
  ];

  if (qualificationOnly) {
    return [
      ...common,
      "LIVE QUALIFICATION ONLY.",
      "Do not use tools, apps, connectors, ChatGPT Work mode, or write to any external system.",
      "After reading the Source of Truth, reply briefly with its current Architecture generation.",
      `End with exactly: MAGASIN_BOOTSTRAP_CORRELATION_V1 ${id}`
    ].join(" ");
  }

  return [
    ...common,
    "Derive the current project state and next approved work directly from the Source of Truth.",
    "Perform or propose only one bounded next unit of work; if blocked, state the blocker.",
    `Keep this correlation in the final response: MAGASIN_BOOTSTRAP_CORRELATION_V1 ${id}`
  ].join(" ");
}

async function assertBlankNewChatSurface(adapter, page) {
  const probe = await adapter.probePage(page);
  const snapshot = probe?.snapshot || {};

  if (snapshot.loginRequired) throw new Error("ChatGPT login is required");
  if (snapshot.hasCaptcha) throw new Error("ChatGPT CAPTCHA requires Owner intervention");
  if (snapshot.conversationAccessDenied) {
    throw new Error("ChatGPT access is denied");
  }
  if (snapshot.conversationMissing) {
    throw new Error("ChatGPT conversation surface is missing");
  }
  if (!snapshot.composerReady) {
    throw new Error("ChatGPT New Chat composer is not ready");
  }
  if (snapshot.responseRunning) {
    throw new Error("ChatGPT New Chat surface is unexpectedly generating");
  }
  if (Number(snapshot.userMessageCount || 0) !== 0 ||
      Number(snapshot.assistantMessageCount || 0) !== 0) {
    throw new Error("ChatGPT surface is not a blank New Chat");
  }

  return probe;
}

export async function acquireBlankNewChatSurface(adapter, {
  forceNewPage = false
} = {}) {
  if (!adapter) throw new Error("adapter is required");
  await adapter.open();

  let page = adapter.getActivePage?.() || null;
  if (!forceNewPage && page && isHomeChatGptPage(page)) {
    try {
      await assertBlankNewChatSurface(adapter, page);
      return { page, created: false, reused_home: true };
    } catch (error) {
      if (/login|required|CAPTCHA|access is denied/i.test(String(error?.message || ""))) {
        throw error;
      }
    }
  }

  page = await adapter.newChatPage(HOME_URL);
  await assertBlankNewChatSurface(adapter, page);
  return { page, created: true, reused_home: false };
}

async function persistPreparedBootstrap(statePath, {
  messageId,
  message,
  baselineUserTurnId,
  now
}) {
  const state = await readSingleConversationState(statePath);
  const at = nowIso(now);
  state.source_of_truth.sync_status = "SYNCING";
  state.outbound = {
    state: "PREPARED",
    message_id: messageId,
    message_digest: composerInstructionDigest(message),
    kind: "SOURCE_OF_TRUTH_BOOTSTRAP",
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
  state.automation.phase = "SEND_BOOTSTRAP";
  state.automation.reason = null;
  state.automation.updated_at = at;
  return writeSingleConversationState(statePath, state, { now });
}

async function persistBootstrapFailure(statePath, error, now) {
  const state = await readSingleConversationState(statePath);
  const at = nowIso(now);
  state.outbound.last_error_code = safeErrorCode(error);
  state.automation.status = "BLOCKED";
  state.automation.phase = "BOOTSTRAP_FAILED";
  state.automation.reason = state.outbound.last_error_code;
  state.automation.updated_at = at;
  return writeSingleConversationState(statePath, state, { now });
}

async function persistDelivered(statePath, {
  userTurnId,
  runtimeId,
  now
}) {
  const state = await readSingleConversationState(statePath);
  const at = nowIso(now);
  state.outbound.state = "DELIVERED";
  state.outbound.delivered_user_turn_id = userTurnId || null;
  state.outbound.delivered_at = at;
  state.outbound.last_error_code = null;
  state.conversation.runtime_id = runtimeId || state.conversation.runtime_id || null;
  state.conversation.last_seen_at = at;
  state.automation.phase = "WAIT_RESPONSE";
  state.automation.updated_at = at;
  return writeSingleConversationState(statePath, state, { now });
}

async function persistResponseRunning(statePath, now) {
  const state = await readSingleConversationState(statePath);
  if (state.outbound.state === "RESPONSE_RUNNING") return state;
  const at = nowIso(now);
  state.outbound.state = "RESPONSE_RUNNING";
  state.outbound.response_running_at =
    state.outbound.response_running_at || at;
  state.automation.phase = "WAIT_RESPONSE";
  state.automation.updated_at = at;
  return writeSingleConversationState(statePath, state, { now });
}

async function persistResponseComplete(statePath, {
  assistantTurnId,
  now
}) {
  const state = await readSingleConversationState(statePath);
  const at = nowIso(now);
  state.outbound.state = "RESPONSE_COMPLETE";
  state.outbound.response_complete_at = at;
  state.automation.phase = "BOOTSTRAP_RESPONSE_COMPLETE";
  state.automation.reason = null;
  state.automation.updated_at = at;
  state.conversation.last_seen_at = at;
  // Assistant turn identity is runtime evidence only. Keep it under
  // automation diagnostics rather than creating a second project authority.
  state.automation.last_assistant_turn_id = assistantTurnId || null;
  return writeSingleConversationState(statePath, state, { now });
}

export async function waitForBootstrapResponse({
  adapter,
  page,
  statePath,
  baselineAssistantTurnId = null,
  captureTurn = captureLatestRoleTurn,
  timeoutMs = 180_000,
  pollMs = 750,
  now = () => new Date().toISOString()
} = {}) {
  const started = Date.now();
  let sawRunning = false;

  while (Date.now() - started <= timeoutMs) {
    const probe = await adapter.probePage(page);
    const snapshot = probe?.snapshot || {};

    if (snapshot.loginRequired) throw new Error("ChatGPT login is required");
    if (snapshot.hasCaptcha) throw new Error("ChatGPT CAPTCHA requires Owner intervention");
    if (snapshot.conversationAccessDenied) throw new Error("ChatGPT access is denied");
    if (snapshot.conversationMissing) throw new Error("ChatGPT conversation is missing");
    if (snapshot.hasNetworkError) throw new Error("ChatGPT network error during bootstrap");
    if (snapshot.hasTransientError && !snapshot.responseRunning) {
      throw new Error("ChatGPT transient error during bootstrap");
    }

    if (snapshot.responseRunning) {
      sawRunning = true;
      await persistResponseRunning(statePath, now);
    } else {
      const assistant = await captureTurn(page, "assistant").catch(() => null);
      if (
        assistant?.turn_id &&
        assistant.turn_id !== baselineAssistantTurnId
      ) {
        if (snapshot.hasContinueControl) {
          return {
            status: "CONTINUE_REQUIRED",
            assistant_turn: assistant,
            saw_running: sawRunning
          };
        }
        await persistResponseComplete(statePath, {
          assistantTurnId: assistant.turn_id,
          now
        });
        return {
          status: "RESPONSE_COMPLETE",
          assistant_turn: assistant,
          saw_running: sawRunning
        };
      }
    }

    if (typeof page?.waitForTimeout === "function") {
      await page.waitForTimeout(pollMs);
    } else {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  throw Object.assign(new Error("bootstrap assistant response timed out"), {
    code: "RESPONSE_TIMEOUT"
  });
}

export async function createNewChatAndBootstrap({
  adapter,
  statePath,
  sourceOfTruthUrl,
  projectId = "LIVE",
  messageId = randomUUID(),
  qualificationOnly = false,
  forceNewPage = false,
  sendInstruction = sendComposerInstruction,
  captureTurn = captureLatestRoleTurn,
  timeoutMs = 180_000,
  pollMs = 750,
  now = () => new Date().toISOString(),
  onPageAcquired = null
} = {}) {
  if (!adapter) throw new Error("adapter is required");
  if (!statePath) throw new Error("statePath is required");

  const state = await ensureSingleConversationState(statePath, {
    sourceOfTruthUrl,
    projectId,
    now
  });

  try {
    const surface = await acquireBlankNewChatSurface(adapter, { forceNewPage });
    const page = surface.page;
    if (typeof onPageAcquired === "function") {
      await onPageAcquired(page, surface);
    }

    await beginConversationGeneration(statePath, {
      runtimeId: null,
      pageId: null,
      at: now
    });

    const baselineUser = await captureTurn(page, "user").catch(() => null);
    const baselineAssistant = await captureTurn(page, "assistant").catch(() => null);
    if (baselineUser || baselineAssistant) {
      throw new Error("New Chat acquired with unexpected existing turns");
    }

    const message = buildSingleConversationBootstrap({
      sourceOfTruthUrl: state.source_of_truth.url,
      messageId,
      qualificationOnly
    });
    await persistPreparedBootstrap(statePath, {
      messageId,
      message,
      baselineUserTurnId: baselineUser?.turn_id || null,
      now
    });

    const sendResult = await sendInstruction(page, message, { dryRun: false });
    if (!sendResult?.executed) {
      throw Object.assign(
        new Error(sendResult?.reason || "bootstrap send was not confirmed"),
        { code: sendResult?.rejection_class || "SEND_NOT_CONFIRMED" }
      );
    }

    const userTurn = await captureTurn(page, "user").catch(() => null);
    if (!userTurn?.turn_id) {
      throw Object.assign(
        new Error("bootstrap matching user turn could not be captured after confirmed send"),
        { code: "USER_TURN_NOT_CAPTURED" }
      );
    }

    await persistDelivered(statePath, {
      userTurnId: userTurn.turn_id,
      runtimeId: opaqueRuntimeIdentity(pageUrl(page)),
      now
    });

    const response = await waitForBootstrapResponse({
      adapter,
      page,
      statePath,
      baselineAssistantTurnId: baselineAssistant?.turn_id || null,
      captureTurn,
      timeoutMs,
      pollMs,
      now
    });

    return {
      page,
      message_id: messageId,
      message,
      surface,
      send: sendResult,
      response
    };
  } catch (error) {
    await persistBootstrapFailure(statePath, error, now).catch(() => {});
    throw error;
  }
}
