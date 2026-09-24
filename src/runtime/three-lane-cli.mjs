import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import {
  ChatGptUiAdapter,
  isTransientNavigationError
} from "../ui/playwright-adapter.mjs";
import {
  SEND_REJECTION_CLASSES,
  classifyComposerSendRejection,
  sendComposerInstruction,
  sendComposerWithAttachment
} from "../ui/actions.mjs";
import {
  captureCompletedAssistantTurn,
  captureCompletedAssistantTurnScreenshot,
  captureRecentConversationTurns,
  captureUserTurnDigests,
  captureUserTurnTexts
} from "../ui/message-capture.mjs";
import { collectSafeUiSnapshot } from "../ui/snapshot.mjs";
import { OBSERVATIONS } from "../decision.mjs";
import {
  isPersistableConversationUrl,
  pageMatchesTarget,
  targetFromUrl
} from "./recovery.mjs";
import {
  THREE_LANE_MODE,
  LANE_IDS,
  sha256,
  normalizeChatGptConversationUrl,
  parseLaneDirective,
  defaultLaneConfig,
  normalizeLaneConfig,
  defaultLaneRegistry,
  normalizeLaneRegistry,
  evaluateBrainDirectiveAdoptionEvidence,
  buildBrainStartRequest,
  buildLegacyBrainStartRequestV59,
  buildWorkRolloverInstruction,
  buildWorkDispatchInstruction,
  workDispatchMarker,
  buildLaneResultRelay
} from "./three-lane.mjs";
import {
  classifyRelayMarkerState,
  activeRelayScreenshotPaths,
  migrateLegacyBlockedRelayLatches
} from "./relay-reconciliation.mjs";
import {
  RELAY_REARM_STATES,
  RELAY_RETRY_STATES,
  beginRelaySendAttempt,
  rearmRelayRetry,
  relayRetryState,
  scheduleRelayRetry
} from "./relay-retry.mjs";
import {
  LANE_EVENT_TYPES,
  beginTaskAssignment,
  buildSafeWorkObservation,
  createLaneEventSink,
  markRelayConfirmed,
  markTaskCompleted,
  markTaskStarted,
  normalizeTaskTiming,
  observeWorkActivity,
  taskTimingMetrics
} from "./lane-events.mjs";
import {
  WORK_TARGET_MODES,
  acceptOwnerWorkTargetRevision,
  applyPendingWorkTargetIfSafe,
  resolveWorkTargetPolicy
} from "./work-target-state.mjs";
import {
  BrowserScheduler,
  DEFAULT_CHATGPT_PAGE_BUDGET
} from "./browser-scheduler.mjs";
import {
  WORK_WATCHDOG_DECISIONS,
  beginWatchdogReloadIntent,
  evaluateWorkWatchdog,
  markWatchdogPostReloadProbe,
  markWatchdogReloaded,
  normalizeWorkWatchdog
} from "./work-watchdog.mjs";
import {
  WORK_CAPACITY_STATES,
  evaluateWorkCapacity,
  workCapacitySignalsFromSnapshot
} from "./work-capacity.mjs";
import {
  WORK_ROLLOVER_REASONS,
  WORK_ROLLOVER_STAGES,
  beginWorkRollover,
  markBlankTargetCreating,
  markRolloverDispatchConfirmed,
  markRolloverDispatchLatchPersisted,
  markRolloverIntentPersisted,
  markRolloverTargetPersisted,
  normalizeWorkRollover,
  rolloverMatchesDirective
} from "./work-rollover.mjs";
import { projectLaneOperationalStatus } from "./status-projection.mjs";
import {
  TARGET_AVAILABILITY,
  TARGET_HEALTH_REASONS,
  adoptTargetHealthIdentity,
  defaultTargetHealth,
  evaluateTargetAvailability,
  isTargetQuarantined,
  markTargetHealthy,
  quarantineTarget,
  targetHealthIdentity
} from "./target-health.mjs";
import {
  evaluateBrainVerdictTransition
} from "./brain-planning.mjs";

const SUPERVISOR_RUNTIME_VERSION = "2026-09-20.60";

let laneEventSink = null;
let laneEventErrorLogPath = null;

function parseArgs(argv) {
  const result = {
    cdpUrl: "http://127.0.0.1:9222",
    execute: false,
    pollMs: 4000,
    workTargetFixture: false,
    browserSchedulerFixture: false,
    workWatchdogFixture: false,
    relayRearmFixture: false,
    workFullFixture: false,
    staleTargetFixture: false,
    pageBudget: DEFAULT_CHATGPT_PAGE_BUDGET
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--cdp-url") result.cdpUrl = argv[++i];
    else if (key === "--execute") result.execute = true;
    else if (key === "--poll-ms") result.pollMs = Number(argv[++i]);
    else if (key === "--work-target-fixture") result.workTargetFixture = true;
    else if (key === "--browser-scheduler-fixture") result.browserSchedulerFixture = true;
    else if (key === "--work-watchdog-fixture") result.workWatchdogFixture = true;
    else if (key === "--relay-rearm-fixture") result.relayRearmFixture = true;
    else if (key === "--work-full-fixture") result.workFullFixture = true;
    else if (key === "--stale-target-fixture") result.staleTargetFixture = true;
    else if (key === "--page-budget") result.pageBudget = Number(argv[++i]);
    else throw new Error(`unknown argument: ${key}`);
  }
  return result;
}

function localRoot() {
  const base = process.env.LOCALAPPDATA || process.env.HOME || process.cwd();
  return path.join(base, "MAGASIN", "BusinessOS", "supervisor");
}

async function atomicJsonWrite(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(temp, filePath);
}

function parseJsonText(text) {
  return JSON.parse(String(text || "").replace(/^\uFEFF/, ""));
}

async function readJson(filePath, fallback) {
  try {
    return parseJsonText(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return fallback;
  }
}

async function safeLog(filePath, event = {}) {
  const safe = {
    timestamp: new Date().toISOString(),
    type: String(event.type || "EVENT"),
    lane_id: event.laneId || undefined,
    task_id: event.taskId || undefined,
    relay_id: event.relayId || undefined,
    digest: event.digest || undefined,
    reason: event.reason || undefined,
    reason_code: event.reasonCode || undefined,
    revision: Number.isInteger(event.revision) ? event.revision : undefined,
    turn: Number.isInteger(event.turn) ? event.turn : undefined,
    error_name: event.errorName || undefined
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(safe) + "\n", "utf8");
}

function ensureLaneTaskTiming(registryLane, taskId = null) {
  registryLane.task_timing = normalizeTaskTiming(registryLane.task_timing);
  const timing = registryLane.task_timing;
  if (!timing.task_id && taskId) timing.task_id = String(taskId);
  if (timing.task_id && taskId && timing.task_id !== String(taskId)) {
    registryLane.task_timing = normalizeTaskTiming({ task_id: String(taskId) });
  }
  return registryLane.task_timing;
}

function timingEventFields(timing, at = new Date().toISOString()) {
  const metrics = taskTimingMetrics(timing, { now: at });
  return {
    ...(Number.isInteger(metrics.total_elapsed_ms)
      ? { elapsed_ms: metrics.total_elapsed_ms }
      : {}),
    ...(Number.isInteger(metrics.queue_time_ms)
      ? { queue_time_ms: metrics.queue_time_ms }
      : {}),
    ...(Number.isInteger(metrics.execution_time_ms)
      ? { execution_time_ms: metrics.execution_time_ms }
      : {})
  };
}

async function emitLaneEvent(event) {
  if (!laneEventSink) return false;
  const result = await laneEventSink.emit(event);
  if (!result.ok && laneEventErrorLogPath) {
    await safeLog(laneEventErrorLogPath, {
      type: "LANE_EVENT_SINK_ERROR",
      laneId: event.lane_id,
      reason: "EVENT_SINK_WRITE_FAILED"
    }).catch(() => {});
  }
  return result.ok;
}

function hardStopObservation(observation) {
  return new Set([
    OBSERVATIONS.AUTH_REQUIRED,
    OBSERVATIONS.MFA_REQUIRED,
    OBSERVATIONS.CAPTCHA,
    OBSERVATIONS.DESTRUCTIVE_ACTION,
    OBSERVATIONS.ADMIN_ESCALATION,
    OBSERVATIONS.AMBIGUOUS_DECISION
  ]).has(observation);
}

function accessDeniedMessage({ brain = false } = {}) {
  return brain
    ? "Bộ não này không mở được trong Chrome Robot. Hãy dùng link Brain mà tài khoản trong Chrome Robot có quyền truy cập."
    : "Work này không mở được trong Chrome Robot. Dừng luồng rồi dán LINK WORK khác hoặc bấm TỰ TẠO WORK để Robot tạo chat mới.";
}

function targetRole(brain) {
  return brain ? "BRAIN" : "WORK";
}

function targetHealthField(brain) {
  return brain ? "brain_target_health" : "work_target_health";
}

function targetReasonCode(reason) {
  if (reason === TARGET_HEALTH_REASONS.CONVERSATION_MISSING) {
    return "TARGET_CONVERSATION_MISSING";
  }
  if (reason === TARGET_HEALTH_REASONS.CONVERSATION_ACCESS_DENIED) {
    return "TARGET_CONVERSATION_ACCESS_DENIED";
  }
  if (reason === TARGET_HEALTH_REASONS.STABLE_REDIRECT_AWAY) {
    return "TARGET_STABLE_REDIRECT_AWAY";
  }
  return "TARGET_QUARANTINED";
}

function exactTargetHealthIdentity({
  brain,
  normalizedUrl,
  targetRevision,
  generation
}) {
  return targetHealthIdentity({
    role: targetRole(brain),
    targetDigest: sha256(normalizedUrl),
    targetRevision,
    workGeneration: brain ? 0 : generation
  });
}

function quarantinedTargetMessage({ brain = false, registryLane = null } = {}) {
  if (brain) {
    return "BỘ NÃO KHÔNG CÒN TỒN TẠI/ĐƯỢC TRUY CẬP — Robot đã ngừng mở lại link này. Hãy dán Brain URL mới và LƯU BỘ NÃO.";
  }
  const pending = Number(registryLane?.pending_work_url_revision || 0) > 0
    ? " Pending Work mới vẫn được giữ nguyên nhưng chưa thể thay thế active exact-once transaction cũ."
    : "";
  const active = Boolean(
    registryLane?.awaiting_work ||
    registryLane?.dispatch_inflight ||
    registryLane?.relay_inflight
  )
    ? " Task/latch/result hiện tại được giữ nguyên; Robot không tự chuyển task sang Work khác."
    : "";
  return "WORK KHÔNG CÒN TỒN TẠI/ĐƯỢC TRUY CẬP — Robot đã ngừng mở lại link này. Hãy LƯU WORK mới hoặc dùng TỰ TẠO WORK khi safe boundary cho phép." + active + pending;
}

function targetQuarantineError({ brain = false, registryLane = null } = {}) {
  const error = new Error(quarantinedTargetMessage({ brain, registryLane }));
  error.name = "TargetQuarantinedError";
  error.code = "TARGET_QUARANTINED";
  return error;
}

async function persistTargetQuarantine({
  laneId,
  brain,
  identity,
  reasonCode,
  registryLane,
  registry,
  registryPath,
  scheduler,
  adapter,
  page,
  normalizedUrl
}) {
  const field = targetHealthField(brain);
  const outcome = quarantineTarget(registryLane[field], identity, {
    reasonCode,
    at: new Date().toISOString()
  });
  registryLane[field] = outcome.health;
  if (outcome.changed) {
    await atomicJsonWrite(registryPath, registry);
    await emitLaneEvent({
      lane_id: laneId,
      actor: "SUPERVISOR",
      event_type: LANE_EVENT_TYPES.TARGET_QUARANTINED,
      task_id: registryLane.task_id || undefined,
      phase: "ERROR",
      reason_code: targetReasonCode(reasonCode),
      work_generation: Number(registryLane.work_generation || 0),
      target_role: identity.role,
      target_digest: identity.target_digest,
      target_revision: identity.target_revision
    });
  }

  if (scheduler?.invalidateExactPage) {
    await scheduler.invalidateExactPage({
      page,
      url: normalizedUrl
    }).catch(() => false);
  } else if (adapter?.invalidateTargetRecoveryPage) {
    await adapter.invalidateTargetRecoveryPage(normalizedUrl, {
      page,
      close: true
    }).catch(() => false);
  }
  return outcome;
}

async function markExactTargetHealthyOnce({
  brain,
  identity,
  registryLane,
  registry,
  registryPath
}) {
  const field = targetHealthField(brain);
  const before = registryLane[field];
  if (before?.state === "HEALTHY" && before?.target_digest === identity.target_digest) {
    return false;
  }
  registryLane[field] = markTargetHealthy(before, identity, {
    at: new Date().toISOString()
  });
  await atomicJsonWrite(registryPath, registry);
  return true;
}

async function openExactConversation(adapter, url, {
  brain = false,
  scheduler = null,
  laneId = null,
  targetRevision = 0,
  generation = 0,
  registryLane,
  registry,
  registryPath
} = {}) {
  if (!registryLane || !registry || !registryPath) {
    throw new Error("exact target acquisition requires durable target-health context");
  }

  const normalized = normalizeChatGptConversationUrl(url);
  const target = targetFromUrl(normalized);
  const role = targetRole(brain);
  const identity = exactTargetHealthIdentity({
    brain,
    normalizedUrl: normalized,
    targetRevision,
    generation
  });
  const field = targetHealthField(brain);

  if (isTargetQuarantined(registryLane[field], identity)) {
    throw targetQuarantineError({ brain, registryLane });
  }

  const page = scheduler
    ? await scheduler.acquireExactPage({
        laneId,
        role,
        url: normalized,
        target,
        targetRevision,
        generation
      })
    : adapter.findPageForTarget(target) || await adapter.reopenTargetPage(normalized);

  const firstProbe = await adapter.probePage(page);
  const firstUrl = page.url();
  if (typeof page.waitForTimeout === "function") {
    await page.waitForTimeout(160);
  }
  const secondProbe = await adapter.probePage(page);
  const secondUrl = page.url();

  const availability = evaluateTargetAvailability({
    firstSnapshot: firstProbe.snapshot,
    secondSnapshot: secondProbe.snapshot,
    firstExact: pageMatchesTarget(firstUrl, target),
    secondExact: pageMatchesTarget(secondUrl, target),
    stableRedirectLocation: firstUrl === secondUrl
  });

  if (availability.state === TARGET_AVAILABILITY.DETERMINISTIC_UNAVAILABLE) {
    await persistTargetQuarantine({
      laneId,
      brain,
      identity,
      reasonCode: availability.reason_code,
      registryLane,
      registry,
      registryPath,
      scheduler,
      adapter,
      page,
      normalizedUrl: normalized
    });
    throw targetQuarantineError({ brain, registryLane });
  }

  if (!pageMatchesTarget(page.url(), target)) {
    throw new Error(
      brain
        ? "Không thể mở đúng cuộc trò chuyện Bộ não trong Chrome Robot."
        : "Không thể mở đúng cuộc trò chuyện Work trong Chrome Robot. Dừng luồng rồi dán LINK WORK khác hoặc bấm TỰ TẠO WORK."
    );
  }

  if (availability.state === TARGET_AVAILABILITY.AVAILABLE) {
    await markExactTargetHealthyOnce({
      brain,
      identity,
      registryLane,
      registry,
      registryPath
    });
  }

  return page;
}

async function runBrowserMutation(
  scheduler,
  { laneId = null, role = "UNKNOWN", page = null, reason = "UI_MUTATION" } = {},
  operation
) {
  if (!scheduler) return operation();
  return scheduler.withMutationLease(
    { laneId, role, page, reason },
    operation
  );
}

function chatGptRateLimitError() {
  const error = new Error("CHATGPT_RATE_LIMITED");
  error.code = "CHATGPT_RATE_LIMITED";
  return error;
}

async function assertPageNotRateLimited(page) {
  const snapshot = await collectSafeUiSnapshot(page).catch(() => null);
  if (snapshot?.rateLimited) throw chatGptRateLimitError();
  return snapshot;
}

async function waitForConversationUrl(page) {
  const deadline = Date.now() + 45_000;
  while (
    Date.now() <= deadline &&
    !isPersistableConversationUrl(String(page.url()))
  ) {
    await assertPageNotRateLimited(page);
    await page.waitForURL(
      (value) => isPersistableConversationUrl(String(value)),
      { timeout: 1_000 }
    ).catch(() => {});
  }
  await assertPageNotRateLimited(page);
  if (!isPersistableConversationUrl(String(page.url()))) {
    const error = new Error("AUTO_WORK_TARGET_CREATE_NOT_CONFIRMED");
    error.code = "AUTO_WORK_TARGET_CREATE_NOT_CONFIRMED";
    throw error;
  }

  // ChatGPT may briefly expose an internal /c/WEB:<uuid> route while a new
  // conversation is still being created. That route is not authoritative for
  // future reopen. Persist only the final canonical conversation URL emitted
  // by ChatGPT itself; never synthesize it from a transient WEB route.
  const target = targetFromUrl(page.url());
  if (!/^\/c\/[A-Za-z0-9:_-]+$/.test(target.pathname)) {
    const error = new Error("AUTO Work target did not resolve to canonical /c/ identity");
    error.code = "AUTO_WORK_TARGET_NOT_CANONICAL_C";
    throw error;
  }
  return `${target.origin}${target.pathname}`;
}

function laneStatus(configLane, registryLane, status, message, extra = {}) {
  const updatedAt = new Date().toISOString();
  const projection = projectLaneOperationalStatus(
    configLane,
    registryLane,
    status,
    extra,
    { now: updatedAt }
  );
  return {
    lane_id: configLane.lane_id,
    project_name: configLane.project_name,
    enabled: Boolean(configLane.enabled),
    status,
    message,
    brain_url: String(registryLane.brain_url || configLane.brain_url || ""),
    work_url: String(registryLane.work_url || ""),
    work_url_revision: Number(configLane.work_url_revision || 0),
    task_id: registryLane.task_id || null,
    awaiting_work: Boolean(registryLane.awaiting_work),
    updated_at: updatedAt,
    ...projection
  };
}

async function writeLaneStatus(statusPath, statuses, scheduler = null) {
  await atomicJsonWrite(statusPath, {
    schema_version: "three-lane-status.v1",
    mode: THREE_LANE_MODE,
    supervisor_runtime_version: SUPERVISOR_RUNTIME_VERSION,
    truth_order: ["PROCESS_TRUTH", "LANE_TRUTH", "PERSISTED_RECOVERY_STATE"],
    persisted_state_role: "RECOVERY_ONLY",
    process_truth_required: true,
    scheduler: scheduler ? scheduler.snapshot() : null,
    updated_at: new Date().toISOString(),
    lanes: LANE_IDS.map((laneId) => statuses[laneId] || {
      lane_id: laneId,
      status: "STOPPED",
      message: "Luồng chưa khởi động."
    })
  });
}

async function assertConversationSafe(adapter, page, {
  brain = false,
  allowFull = false
} = {}) {
  const probe = await adapter.probePage(page);
  if (probe.snapshot.rateLimited) {
    throw chatGptRateLimitError();
  }
  if (hardStopObservation(probe.classification.observation)) {
    throw new Error("Owner/security boundary detected");
  }
  if (probe.snapshot.conversationAccessDenied) {
    throw new Error(accessDeniedMessage({ brain }));
  }
  if (probe.snapshot.conversationMissing) {
    throw new Error(brain
      ? "Brain conversation is missing; Owner must provide a valid Brain URL"
      : "Work conversation is missing; automatic replacement is denied");
  }
  if (probe.snapshot.conversationFull && !allowFull) {
    throw new Error(brain
      ? "Brain conversation is full; Owner must provide a replacement Brain URL"
      : "Work conversation is full");
  }
  return probe;
}

async function probeStableWorkCapacity({
  adapter,
  page,
  expectedUrl,
  sendRejectionCapacity = false
}) {
  const expectedTarget = targetFromUrl(expectedUrl);
  const first = await assertConversationSafe(adapter, page, {
    brain: false,
    allowFull: true
  });
  const firstTargetStable = pageMatchesTarget(page.url(), expectedTarget);

  // Two bounded probes are enough to reject one-frame/transient UI states.
  // This is not a retry loop and performs no UI mutation.
  if (typeof page.waitForTimeout === "function") {
    await page.waitForTimeout(160);
  }
  const second = await assertConversationSafe(adapter, page, {
    brain: false,
    allowFull: true
  });
  const secondTargetStable = pageMatchesTarget(page.url(), expectedTarget);

  const firstSignals = workCapacitySignalsFromSnapshot(first.snapshot, {
    sendRejectionCapacity
  });
  const secondSignals = workCapacitySignalsFromSnapshot(second.snapshot, {
    sendRejectionCapacity
  });
  const decision = evaluateWorkCapacity({
    first: firstSignals,
    second: secondSignals,
    stableIdentity: firstTargetStable && secondTargetStable,
    stableProbeCount: 2
  });

  return {
    decision,
    first,
    second,
    stable_identity: firstTargetStable && secondTargetStable
  };
}

async function captureSendBaseline(adapter, page) {
  const digests = await captureUserTurnDigests(page).catch(() => []);
  const probe = await adapter.probePage(page).catch(() => null);
  return {
    pre_user_count: digests.length,
    pre_max_turn_ordinal: Number(
      probe?.snapshot?.maxConversationTurnOrdinal || 0
    )
  };
}

async function waitForUserTurnDigest(
  page,
  digest,
  { timeoutMs = 6000, intervalMs = 250 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const digests = await captureUserTurnDigests(page).catch(() => []);
    if (digests.includes(digest)) return true;
    await delay(intervalMs);
  }
  return false;
}

async function hasUserTurnMarker(page, marker) {
  const expected = String(marker || "");
  if (!expected) return false;
  const texts = await captureUserTurnTexts(page).catch(() => []);
  return texts.some((text) => String(text).includes(expected));
}

async function waitForUserTurnMarker(
  page,
  marker,
  { timeoutMs = 6000, intervalMs = 250 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await hasUserTurnMarker(page, marker)) return true;
    await delay(intervalMs);
  }
  return false;
}

function normalizeWorkInstructionText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function relayMarker(relayId) {
  return `relay_id=${relayId}`;
}

async function unlinkRelayScreenshot(latch) {
  const screenshotPath = String(latch?.screenshot_path || "").trim();
  if (!screenshotPath) return false;
  await fs.unlink(screenshotPath).catch(() => {});
  return true;
}

async function clearRelayInflight(registryLane) {
  const latch = registryLane?.relay_inflight || null;
  if (latch) await unlinkRelayScreenshot(latch);
  if (registryLane) registryLane.relay_inflight = null;
  return latch;
}

async function finalizeConfirmedRelay({
  registryLane,
  registry,
  registryPath,
  latch
}) {
  const confirmedAt = new Date().toISOString();
  const timing = ensureLaneTaskTiming(registryLane, registryLane.task_id);
  const confirmed = markRelayConfirmed(timing, {
    taskId: registryLane.task_id,
    at: confirmedAt
  });

  registryLane.last_result_relay_id = latch.relay_id;
  registryLane.last_work_result_digest = latch.response_digest;
  registryLane.awaiting_work = false;
  await clearRelayInflight(registryLane);
  await atomicJsonWrite(registryPath, registry);

  if (confirmed.changed) {
    await emitLaneEvent({
      timestamp: confirmedAt,
      lane_id: registryLane.lane_id,
      actor: "SUPERVISOR",
      event_type: LANE_EVENT_TYPES.RESULT_RELAY_CONFIRMED,
      task_id: registryLane.task_id,
      phase: "RELAYED",
      work_generation: Number(registryLane.work_generation || 0),
      relay_id: latch.relay_id,
      ...timingEventFields(timing, confirmedAt)
    });
  }
}

async function applyBrainVerdictDirective({
  lane,
  registryLane,
  directive,
  registry,
  registryPath
}) {
  const transition = evaluateBrainVerdictTransition(registryLane, directive);
  if (transition.state === "LEGACY" || !transition.changed) return transition;

  registryLane.last_result_verdict = transition.record;
  await atomicJsonWrite(registryPath, registry);
  await emitLaneEvent({
    timestamp: transition.record.recorded_at,
    lane_id: lane.lane_id,
    actor: "BRAIN",
    event_type: transition.record.verdict === "ACCEPT"
      ? LANE_EVENT_TYPES.BRAIN_RESULT_ACCEPTED
      : LANE_EVENT_TYPES.BRAIN_RESULT_REJECTED,
    task_id: transition.record.task_id,
    phase: transition.record.verdict === "ACCEPT" ? "ACCEPTED" : "REJECTED",
    reason_code: transition.record.reason_code || undefined,
    relay_id: transition.record.relay_id,
    work_generation: Number(registryLane.work_generation || 0)
  });
  return transition;
}

async function cleanupOrphanRelayEvidence({
  evidenceDir,
  registry,
  logPath,
  maxDeletes = 24
}) {
  await fs.mkdir(evidenceDir, { recursive: true });
  const active = new Set(
    [...activeRelayScreenshotPaths(registry)].map((item) => path.resolve(item))
  );
  const entries = await fs.readdir(evidenceDir, { withFileTypes: true })
    .catch(() => []);
  let deleted = 0;
  for (const entry of entries) {
    if (deleted >= maxDeletes) break;
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".png")) continue;
    const candidate = path.resolve(evidenceDir, entry.name);
    if (active.has(candidate)) continue;
    await fs.unlink(candidate).catch(() => {});
    deleted += 1;
  }
  if (deleted > 0) {
    await safeLog(logPath, {
      type: "LANE_RELAY_ORPHAN_EVIDENCE_CLEANED",
      reason: `count=${deleted}`
    });
  }
  return deleted;
}

async function hasRelayMarker(page, relayId) {
  const marker = relayMarker(relayId);
  const texts = await captureUserTurnTexts(page).catch(() => []);
  return texts.some((text) => text.includes(marker));
}

async function waitForRelayMarker(
  page,
  relayId,
  { timeoutMs = 6000, intervalMs = 250 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await hasRelayMarker(page, relayId)) return true;
    await delay(intervalMs);
  }
  return false;
}

async function waitForStableSendSurface(
  adapter,
  page,
  { brain = false, timeoutMs = 15_000, intervalMs = 400 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let lastProbe = null;
  let lastDigests = [];

  while (Date.now() <= deadline) {
    lastDigests = await captureUserTurnDigests(page).catch(() => []);
    lastProbe = await assertConversationSafe(adapter, page, {
      brain,
      allowFull: !brain
    }).catch(() => null);

    if (lastProbe) {
      const stable = Boolean(
        lastProbe.snapshot.composerReady &&
        !lastProbe.snapshot.responseRunning &&
        lastProbe.snapshot.lastMessageRole !== "user" &&
        lastProbe.classification.observation === OBSERVATIONS.RESPONSE_COMPLETE
      );
      if (stable) return { stable: true, probe: lastProbe, digests: lastDigests };
    }

    await delay(intervalMs);
  }

  return { stable: false, probe: lastProbe, digests: lastDigests };
}

async function inspectKnownTargetSendOutcome({
  adapter,
  page,
  digest,
  marker = null,
  preUserCount,
  preMaxTurnOrdinal,
  brain = false,
  reload = false
}) {
  if (marker && await hasUserTurnMarker(page, marker)) {
    return "CONFIRMED";
  }
  if (!marker && await waitForUserTurnDigest(page, digest, { timeoutMs: 1200 })) {
    return "CONFIRMED";
  }

  if (reload) {
    await page.reload({
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });
  }

  const observed = await waitForStableSendSurface(adapter, page, {
    brain,
    timeoutMs: reload ? 15_000 : 4_000
  });
  const digests = observed.digests || [];
  if (marker && await hasUserTurnMarker(page, marker)) return "CONFIRMED";
  if (!marker && digests.includes(digest)) return "CONFIRMED";
  if (!observed.stable || !observed.probe) return "PENDING";

  // Marker-backed Work sends are unambiguous. Once the exact Work page is
  // stable, absence of the marker proves this dispatch was not persisted,
  // even if unrelated Work activity changed the baseline in the meantime.
  if (marker) return "NOT_CONFIRMED";

  const probe = observed.probe;
  const baselineKnown =
    Number.isFinite(Number(preUserCount)) &&
    Number.isFinite(Number(preMaxTurnOrdinal));

  if (baselineKnown) {
    const noNewUserTurn =
      digests.length <= Number(preUserCount) &&
      Number(probe.snapshot.maxConversationTurnOrdinal || 0) <=
        Number(preMaxTurnOrdinal);
    if (noNewUserTurn) return "NOT_CONFIRMED";
    return "UNCERTAIN";
  }

  // Legacy v34/v35 latches may lack a baseline. Once the exact conversation
  // has been hard-reloaded and reaches a stable assistant-complete surface,
  // absence of the exact digest proves the attempted send was not persisted.
  return "NOT_CONFIRMED";
}

async function finalizeConfirmedDispatch({
  foundUrl,
  registryLane,
  latch,
  registry,
  registryPath
}) {
  const startedAt = new Date().toISOString();
  const timing = ensureLaneTaskTiming(registryLane, latch.task_id);
  const started = markTaskStarted(timing, {
    taskId: latch.task_id,
    directiveDigest: latch.directive_digest,
    at: startedAt
  });

  if (foundUrl) registryLane.work_url = foundUrl;
  let rolloverConfirmed = false;
  const rollover = normalizeWorkRollover(registryLane.work_rollover);
  if (
    rollover?.stage === WORK_ROLLOVER_STAGES.DISPATCH_LATCH_PERSISTED &&
    rollover.dispatch_id === latch.dispatch_id
  ) {
    registryLane.work_rollover = markRolloverDispatchConfirmed(rollover, {
      dispatchId: latch.dispatch_id,
      at: startedAt
    });
    rolloverConfirmed = true;
  }
  registryLane.task_id = latch.task_id;
  registryLane.instruction_digest =
    latch.directive_instruction_digest || latch.instruction_digest;
  registryLane.last_brain_directive_digest =
    latch.directive_digest || registryLane.last_brain_directive_digest;
  registryLane.last_dispatch_id = latch.dispatch_id || registryLane.last_dispatch_id || null;
  registryLane.awaiting_work = true;
  registryLane.dispatch_inflight = null;
  await atomicJsonWrite(registryPath, registry);

  if (started.changed) {
    const correlation = latch.dispatch_id
      ? { dispatch_id: latch.dispatch_id }
      : {};
    const common = {
      timestamp: startedAt,
      lane_id: registryLane.lane_id,
      task_id: latch.task_id,
      work_generation: Number(registryLane.work_generation || 0),
      ...correlation,
      ...timingEventFields(timing, startedAt)
    };
    await emitLaneEvent({
      ...common,
      actor: "SUPERVISOR",
      event_type: LANE_EVENT_TYPES.WORK_DISPATCH_CONFIRMED,
      phase: "STARTED"
    });
    await emitLaneEvent({
      ...common,
      actor: "WORK",
      event_type: LANE_EVENT_TYPES.WORK_STARTED,
      phase: "STARTED"
    });
  }

  if (rolloverConfirmed) {
    await emitLaneEvent({
      timestamp: startedAt,
      lane_id: registryLane.lane_id,
      actor: "SUPERVISOR",
      event_type: LANE_EVENT_TYPES.WORK_ROLLOVER_DISPATCH_CONFIRMED,
      task_id: latch.task_id,
      phase: "ROLLOVER",
      reason_code: "ROLLOVER_DISPATCH_CONFIRMED",
      work_generation: Number(registryLane.work_generation || 0),
      dispatch_id: latch.dispatch_id
    });
    if (rollover?.reason === "NO_WORK_TARGET") {
      await emitLaneEvent({
        timestamp: startedAt,
        lane_id: registryLane.lane_id,
        actor: "SUPERVISOR",
        event_type: LANE_EVENT_TYPES.AUTO_WORK_DISPATCH_CONFIRMED,
        task_id: latch.task_id,
        phase: "ROLLOVER",
        reason_code: "AUTO_WORK_DISPATCH_CONFIRMED",
        work_generation: Number(registryLane.work_generation || 0),
        work_url_revision: Number(registryLane.applied_work_url_revision || 0),
        dispatch_id: latch.dispatch_id
      });
    }
  }
}

async function reconcileBrainRequest({
  adapter,
  page,
  lane,
  registryLane,
  registry,
  registryPath,
  logPath,
  scheduler = null
}) {
  const latch = registryLane.brain_request_inflight;
  if (!latch) return "NONE";

  if (latch.reconcile_blocked) return "BLOCKED";

  let currentBrainUrl = "";
  let configuredBrainUrl = "";
  try {
    currentBrainUrl = normalizeChatGptConversationUrl(registryLane.brain_url);
    configuredBrainUrl = normalizeChatGptConversationUrl(lane.brain_url);
  } catch {
    latch.reconcile_blocked = true;
    await atomicJsonWrite(registryPath, registry);
    await safeLog(logPath, {
      type: "LANE_BRAIN_SEND_RECONCILE_BLOCKED",
      laneId: lane.lane_id,
      digest: latch.digest,
      reasonCode: "BRAIN_TARGET_IDENTITY_AMBIGUOUS"
    });
    return "BLOCKED";
  }

  const currentTargetDigest = sha256(currentBrainUrl);
  const configuredTargetDigest = sha256(configuredBrainUrl);
  const appliedRevision = Number(registryLane.applied_brain_url_revision || 0);
  const configuredRevision = Number(lane.brain_url_revision || 0);
  const identityMismatch =
    currentTargetDigest !== configuredTargetDigest ||
    configuredRevision !== appliedRevision ||
    (latch.brain_target_digest &&
      latch.brain_target_digest !== currentTargetDigest) ||
    (latch.brain_url_revision !== undefined &&
      latch.brain_url_revision !== null &&
      Number(latch.brain_url_revision) !== appliedRevision);

  if (identityMismatch) {
    latch.reconcile_blocked = true;
    await atomicJsonWrite(registryPath, registry);
    await safeLog(logPath, {
      type: "LANE_BRAIN_SEND_RECONCILE_BLOCKED",
      laneId: lane.lane_id,
      digest: latch.digest,
      reasonCode: "BRAIN_HANDSHAKE_IDENTITY_MISMATCH",
      revision: appliedRevision
    });
    return "BLOCKED";
  }
  const reload = !latch.reconcile_reloaded;
  if (reload) {
    latch.reconcile_reloaded = true;
    latch.reconcile_started_at = new Date().toISOString();
    await atomicJsonWrite(registryPath, registry);
    await safeLog(logPath, {
      type: "LANE_BRAIN_SEND_RECONCILE_RELOAD",
      laneId: lane.lane_id,
      digest: latch.digest
    });
  }

  const inspect = () => inspectKnownTargetSendOutcome({
    adapter,
    page,
    digest: latch.digest,
    preUserCount: latch.pre_user_count,
    preMaxTurnOrdinal: latch.pre_max_turn_ordinal,
    brain: true,
    reload
  });
  const outcome = reload
    ? await runBrowserMutation(
        scheduler,
        { laneId: lane.lane_id, role: "BRAIN", page, reason: "BRAIN_RECONCILE_RELOAD" },
        inspect
      )
    : await inspect();

  if (outcome === "PENDING") return "PENDING";

  if (outcome === "CONFIRMED") {
    registryLane.brain_request_sent = true;
    registryLane.brain_request_inflight = null;
    await atomicJsonWrite(registryPath, registry);
    return "CONFIRMED";
  }

  if (outcome === "NOT_CONFIRMED") {
    registryLane.brain_request_inflight = null;
    await atomicJsonWrite(registryPath, registry);
    await safeLog(logPath, {
      type: "LANE_BRAIN_SEND_NOT_CONFIRMED_RETRY",
      laneId: lane.lane_id,
      digest: latch.digest
    });
    return "NOT_CONFIRMED";
  }

  latch.reconcile_blocked = true;
  await atomicJsonWrite(registryPath, registry);
  await safeLog(logPath, {
    type: "LANE_BRAIN_SEND_RECONCILE_BLOCKED",
    laneId: lane.lane_id,
    digest: latch.digest,
    reason: "stable target changed without matching digest"
  });
  return "BLOCKED";
}

async function adoptExistingBrainDirective({
  adapter,
  page,
  lane,
  registryLane,
  registry,
  registryPath,
  logPath
}) {
  const probe = await assertConversationSafe(adapter, page, { brain: true })
    .catch(() => null);
  if (!probe || probe.snapshot.responseRunning) return null;

  let currentBrainUrl = "";
  let configuredBrainUrl = "";
  try {
    currentBrainUrl = normalizeChatGptConversationUrl(registryLane.brain_url);
    configuredBrainUrl = normalizeChatGptConversationUrl(lane.brain_url);
  } catch {
    return null;
  }

  const currentTarget = targetFromUrl(currentBrainUrl);
  if (!pageMatchesTarget(page.url(), currentTarget)) {
    await safeLog(logPath, {
      type: "LANE_BRAIN_DIRECTIVE_ADOPTION_BLOCKED",
      laneId: lane.lane_id,
      reasonCode: "BRAIN_PAGE_TARGET_MISMATCH",
      revision: Number(registryLane.applied_brain_url_revision || 0)
    });
    return null;
  }

  const turns = await captureRecentConversationTurns(page, { limit: 30 })
    .catch(() => []);
  if (!turns.length) return null;

  const expectedStartDigests = [
    sha256(buildBrainStartRequest({
      laneId: lane.lane_id,
      projectName: lane.project_name
    })),
    sha256(buildLegacyBrainStartRequestV59({
      laneId: lane.lane_id,
      projectName: lane.project_name
    }))
  ];
  const staleLatch = registryLane.brain_request_inflight || null;
  const evidence = evaluateBrainDirectiveAdoptionEvidence({
    turns,
    expectedHandshakeDigests: expectedStartDigests,
    currentTargetDigest: sha256(currentBrainUrl),
    configuredTargetDigest: sha256(configuredBrainUrl),
    configuredRevision: Number(lane.brain_url_revision || 0),
    appliedRevision: Number(registryLane.applied_brain_url_revision || 0),
    brainRequestInflight: staleLatch,
    adoptedRecord: registryLane.brain_directive_adopted || null,
    activeExactOnce: Boolean(
      registryLane.dispatch_inflight ||
      registryLane.relay_inflight ||
      registryLane.awaiting_work
    )
  });

  if (!evidence.adopt) {
    if (evidence.reason_code !== "NO_VALID_DIRECTIVE") {
      await safeLog(logPath, {
        type: "LANE_BRAIN_DIRECTIVE_ADOPTION_BLOCKED",
        laneId: lane.lane_id,
        taskId: registryLane.task_id || undefined,
        reasonCode: evidence.reason_code,
        revision: Number(registryLane.applied_brain_url_revision || 0)
      });
    }
    return null;
  }

  const candidate = evidence.directive;
  const alreadyAdopted =
    registryLane.brain_directive_adopted?.directive_digest === candidate.digest;

  registryLane.brain_request_sent = true;
  registryLane.brain_request_inflight = null;
  if (!alreadyAdopted) {
    registryLane.brain_directive_adopted = {
      directive_digest: candidate.digest,
      action: candidate.action,
      task_id: candidate.action === "WORK" ? candidate.task_id : null,
      instruction_digest:
        candidate.action === "WORK" ? candidate.instruction_digest : null,
      brain_target_digest: sha256(currentBrainUrl),
      brain_url_revision: Number(registryLane.applied_brain_url_revision || 0),
      adopted_at: new Date().toISOString(),
      assistant_turn: Number(evidence.candidate_turn || 0),
      later_robot_handshake_count:
        Number(evidence.later_robot_handshake_count || 0)
    };
  }
  await atomicJsonWrite(registryPath, registry);

  if (staleLatch) {
    await safeLog(logPath, {
      type: "LANE_BRAIN_STALE_HANDSHAKE_SUPERSEDED",
      laneId: lane.lane_id,
      taskId: candidate.action === "WORK" ? candidate.task_id : undefined,
      digest: candidate.digest,
      reasonCode: evidence.reason_code
    });
  }
  await safeLog(logPath, {
    type: "LANE_BRAIN_DIRECTIVE_ADOPTED",
    laneId: lane.lane_id,
    taskId: candidate.action === "WORK" ? candidate.task_id : undefined,
    digest: candidate.digest,
    reasonCode: evidence.reason_code
  });
  return candidate;
}


async function recoverPersistedAdoptedBrainDirective({
  page,
  lane,
  registryLane
}) {
  const adopted = registryLane.brain_directive_adopted || null;
  if (!adopted?.directive_digest) return null;

  let currentBrainUrl = "";
  let configuredBrainUrl = "";
  try {
    currentBrainUrl = normalizeChatGptConversationUrl(registryLane.brain_url);
    configuredBrainUrl = normalizeChatGptConversationUrl(lane.brain_url);
  } catch {
    return null;
  }

  if (!pageMatchesTarget(page.url(), targetFromUrl(currentBrainUrl))) {
    return null;
  }

  const turns = await captureRecentConversationTurns(page, { limit: 30 })
    .catch(() => []);
  if (!turns.length) return null;

  const evidence = evaluateBrainDirectiveAdoptionEvidence({
    turns,
    expectedHandshakeDigests: [
      sha256(buildBrainStartRequest({
        laneId: lane.lane_id,
        projectName: lane.project_name
      })),
      sha256(buildLegacyBrainStartRequestV59({
        laneId: lane.lane_id,
        projectName: lane.project_name
      }))
    ],
    currentTargetDigest: sha256(currentBrainUrl),
    configuredTargetDigest: sha256(configuredBrainUrl),
    configuredRevision: Number(lane.brain_url_revision || 0),
    appliedRevision: Number(registryLane.applied_brain_url_revision || 0),
    brainRequestInflight: null,
    adoptedRecord: adopted,
    activeExactOnce: Boolean(
      registryLane.dispatch_inflight ||
      registryLane.relay_inflight ||
      registryLane.awaiting_work
    )
  });

  if (!evidence.adopt) return null;
  if (evidence.directive.digest !== adopted.directive_digest) return null;
  return evidence.directive;
}

async function ensureBrainRequest({
  adapter,
  page,
  lane,
  registryLane,
  execute,
  registry,
  registryPath,
  logPath,
  scheduler = null
}) {
  if (registryLane.brain_request_sent) return null;

  const existingDirective = await adoptExistingBrainDirective({
    adapter,
    page,
    lane,
    registryLane,
    registry,
    registryPath,
    logPath
  });
  if (existingDirective) return existingDirective;

  if (registryLane.brain_request_inflight) {
    const outcome = await reconcileBrainRequest({
      adapter,
      page,
      lane,
      registryLane,
      registry,
      registryPath,
      logPath,
      scheduler
    });
    if (outcome === "CONFIRMED") return null;
    if (outcome === "PENDING" || outcome === "BLOCKED") {
      const directiveAfterReconcile = await adoptExistingBrainDirective({
        adapter,
        page,
        lane,
        registryLane,
        registry,
        registryPath,
        logPath
      });
      return directiveAfterReconcile;
    }
  }

  const probe = await assertConversationSafe(adapter, page, { brain: true });
  if (probe.classification.observation !== OBSERVATIONS.RESPONSE_COMPLETE) {
    return null;
  }

  const request = buildBrainStartRequest({
    laneId: lane.lane_id,
    projectName: lane.project_name
  });
  const digest = sha256(request);
  const baseline = await captureSendBaseline(adapter, page);
  registryLane.brain_request_inflight = {
    digest,
    ...baseline,
    brain_target_digest: sha256(
      normalizeChatGptConversationUrl(registryLane.brain_url)
    ),
    brain_url_revision: Number(registryLane.applied_brain_url_revision || 0)
  };
  await atomicJsonWrite(registryPath, registry);

  if (!execute) return null;
  let sent = null;
  try {
    sent = await runBrowserMutation(
      scheduler,
      { laneId: lane.lane_id, role: "BRAIN", page, reason: "BRAIN_REQUEST_SEND" },
      () => sendComposerInstruction(page, request, { dryRun: false })
    );
  } catch (error) {
    await safeLog(logPath, {
      type: "LANE_BRAIN_SEND_ATTEMPT_ERROR",
      laneId: lane.lane_id,
      digest,
      errorName: error?.name || "Error",
      reason: String(error?.message || error).slice(0, 220)
    });
    return null;
  }
  if (!sent.executed) return null;

  const confirmed = await waitForUserTurnDigest(page, digest);
  if (!confirmed) {
    await safeLog(logPath, {
      type: "LANE_BRAIN_SEND_PENDING_CONFIRMATION",
      laneId: lane.lane_id,
      digest
    });
    const directiveAfterSend = await adoptExistingBrainDirective({
      adapter,
      page,
      lane,
      registryLane,
      registry,
      registryPath,
      logPath
    });
    return directiveAfterSend;
  }

  registryLane.brain_request_sent = true;
  registryLane.brain_request_inflight = null;
  await atomicJsonWrite(registryPath, registry);
  await safeLog(logPath, {
    type: "LANE_BRAIN_REQUEST_SENT",
    laneId: lane.lane_id,
    digest
  });
  return null;
}

async function findWorkConversationForLatch(adapter, latch) {
  const candidates = [];
  const marker = latch.dispatch_id ? workDispatchMarker(latch.dispatch_id) : null;
  for (const page of adapter.getChatGptPages()) {
    let matched = false;
    if (marker) {
      matched = await hasUserTurnMarker(page, marker);
    } else {
      const digests = await captureUserTurnDigests(page).catch(() => []);
      matched = digests.includes(latch.instruction_digest);
    }
    if (!matched) continue;
    try {
      const target = targetFromUrl(page.url());
      const candidateUrl = `${target.origin}${target.pathname}`;
      if (
        latch.work_target_digest &&
        sha256(candidateUrl) !== latch.work_target_digest
      ) {
        continue;
      }
      candidates.push({
        page,
        url: candidateUrl
      });
    } catch {
      // Ignore non-conversation pages.
    }
  }

  const unique = new Map(candidates.map((item) => [item.url, item]));
  if (unique.size > 1) {
    throw new Error("multiple Work conversations match an uncertain dispatch");
  }
  return unique.size === 1 ? [...unique.values()][0] : null;
}

async function recoverActiveWorkDirective(brainPage, registryLane) {
  if (!brainPage || !registryLane?.task_id || !registryLane?.last_brain_directive_digest) {
    return null;
  }

  const turns = await captureRecentConversationTurns(brainPage, { limit: 40 })
    .catch(() => []);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.role !== "assistant") continue;

    let directive = null;
    try {
      directive = parseLaneDirective(turn.text);
    } catch {
      continue;
    }
    if (
      directive.action !== "WORK" ||
      directive.task_id !== registryLane.task_id ||
      directive.digest !== registryLane.last_brain_directive_digest ||
      directive.instruction_digest !== registryLane.instruction_digest
    ) {
      continue;
    }

    const newerUserTurn = turns
      .slice(index + 1)
      .some((item) => item.role === "user");
    if (newerUserTurn) return null;
    return directive;
  }
  return null;
}

function activeReplacementRollover(registryLane) {
  const rollover = normalizeWorkRollover(registryLane?.work_rollover);
  if (!rollover) return null;
  return [
    WORK_ROLLOVER_REASONS.UNUSABLE_TARGET,
    WORK_ROLLOVER_REASONS.POSSIBLY_STALLED,
    WORK_ROLLOVER_REASONS.IDENTITY_FAILURE
  ].includes(rollover.reason)
    ? rollover
    : null;
}

async function beginActiveWorkReplacement({
  lane,
  registryLane,
  directive,
  reason,
  evidenceCode,
  registry,
  registryPath,
  logPath
}) {
  if (!registryLane.awaiting_work || registryLane.relay_inflight) {
    return { status: "UNSAFE_BOUNDARY" };
  }
  if (
    !directive ||
    directive.action !== "WORK" ||
    directive.task_id !== registryLane.task_id ||
    directive.digest !== registryLane.last_brain_directive_digest ||
    directive.instruction_digest !== registryLane.instruction_digest
  ) {
    return { status: "DIRECTIVE_IDENTITY_UNAVAILABLE" };
  }

  const existing = normalizeWorkRollover(registryLane.work_rollover);
  if (existing) {
    return rolloverMatchesDirective(existing, directive)
      ? { status: "EXISTING", rollover: existing }
      : { status: "IDENTITY_MISMATCH" };
  }

  registryLane.work_rollover = beginWorkRollover({
    reason,
    taskId: directive.task_id,
    directiveDigest: directive.digest,
    directiveInstructionDigest: directive.instruction_digest,
    oldWorkGeneration: Number(registryLane.work_generation || 0),
    oldWorkUrlRevision: Number(registryLane.applied_work_url_revision || 0),
    oldWorkTargetDigest: registryLane.work_url
      ? sha256(registryLane.work_url)
      : null,
    capacityEvidenceCodes: evidenceCode ? [evidenceCode] : [],
    at: new Date().toISOString()
  });
  await atomicJsonWrite(registryPath, registry);
  await emitLaneEvent({
    lane_id: lane.lane_id,
    actor: "SUPERVISOR",
    event_type: LANE_EVENT_TYPES.WORK_ROLLOVER_INTENT,
    task_id: directive.task_id,
    phase: "ROLLOVER",
    reason_code: "ROLLOVER_INTENT_PERSISTED",
    work_generation: Number(registryLane.work_generation || 0),
    work_url_revision: Number(registryLane.applied_work_url_revision || 0)
  });
  await safeLog(logPath, {
    type: "LANE_WORK_REPLACEMENT_INTENT",
    laneId: lane.lane_id,
    taskId: directive.task_id,
    digest: directive.digest,
    reasonCode: String(evidenceCode || reason)
  });
  return {
    status: "STARTED",
    rollover: normalizeWorkRollover(registryLane.work_rollover)
  };
}

async function findBrainDirectiveForLatch(brainPage, latch, currentDirective = null) {
  if (
    currentDirective &&
    currentDirective.action === "WORK" &&
    currentDirective.digest === latch.directive_digest
  ) {
    return currentDirective;
  }
  if (!brainPage) return null;

  const turns = await captureRecentConversationTurns(brainPage, { limit: 30 })
    .catch(() => []);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role !== "assistant") continue;
    try {
      const directive = parseLaneDirective(turns[index].text);
      if (
        directive.action === "WORK" &&
        directive.digest === latch.directive_digest
      ) {
        return directive;
      }
    } catch {
      // Ignore non-directive assistant turns.
    }
  }
  return null;
}

async function reconcileDispatchInflight({
  adapter,
  lane,
  registryLane,
  registry,
  registryPath,
  logPath,
  brainPage = null,
  directive = null,
  scheduler = null
}) {
  const latch = registryLane.dispatch_inflight;
  if (!latch) return "NONE";

  if (
    latch.work_generation !== undefined &&
    Number(latch.work_generation) !== Number(registryLane.work_generation || 0)
  ) {
    return "BLOCKED";
  }
  if (
    latch.work_target_digest &&
    registryLane.work_url &&
    sha256(registryLane.work_url) !== latch.work_target_digest
  ) {
    return "BLOCKED";
  }
  if (
    latch.rollover_generation &&
    !latch.send_attempted_at &&
    (latch.send_state === "PERSISTED_NOT_SENT" || latch.send_state === "NOT_CONFIRMED")
  ) {
    return "RETRY_READY";
  }

  const found = await findWorkConversationForLatch(adapter, latch);
  if (found) {
    await finalizeConfirmedDispatch({
      foundUrl: found.url,
      registryLane,
      latch,
      registry,
      registryPath
    });
    return "CONFIRMED";
  }

  if (!registryLane.work_url) {
    throw new Error(
      "Robot chưa có exact Work target để xác minh lần gửi mới; giữ an toàn để không tạo/gửi trùng."
    );
  }

  const page = await openExactConversation(
    adapter,
    registryLane.work_url,
    {
      brain: false,
      scheduler,
      laneId: lane.lane_id,
      targetRevision: Number(registryLane.applied_work_url_revision || 0),
      generation: Number(registryLane.work_generation || 0),
      registryLane,
      registry,
      registryPath
    }
  );

  // v42 and older could permanently block when unrelated Work activity
  // changed the baseline after an unconfirmed send. On the first v43 pass,
  // recover only a known existing Work target: if the exact Brain directive
  // can be recovered and its normalized instruction is absent from a stable
  // Work conversation, the old latch is safe to discard and retry.
  if (latch.reconcile_blocked && !latch.dispatch_id && !latch.create_new) {
    const legacyDirective = await findBrainDirectiveForLatch(
      brainPage,
      latch,
      directive
    );
    const stable = await waitForStableSendSurface(adapter, page, {
      brain: false,
      timeoutMs: 4_000
    });
    if (!stable.stable || !stable.probe) return "PENDING";
    if (!legacyDirective) return "BLOCKED";

    const userTexts = await captureUserTurnTexts(page).catch(() => []);
    const normalizedExpected = normalizeWorkInstructionText(
      legacyDirective.instruction
    );
    const legacySendExists = userTexts.some((text) =>
      normalizeWorkInstructionText(text) === normalizedExpected
    );
    if (legacySendExists) {
      await finalizeConfirmedDispatch({
        foundUrl: registryLane.work_url,
        registryLane,
        latch: {
          ...latch,
          directive_instruction_digest: legacyDirective.instruction_digest
        },
        registry,
        registryPath
      });
      await safeLog(logPath, {
        type: "LANE_WORK_LEGACY_BLOCKED_LATCH_CONFIRMED",
        laneId: lane.lane_id,
        taskId: latch.task_id,
        digest: latch.instruction_digest
      });
      return "CONFIRMED";
    }

    registryLane.dispatch_inflight = null;
    await atomicJsonWrite(registryPath, registry);
    await safeLog(logPath, {
      type: "LANE_WORK_LEGACY_BLOCKED_LATCH_REBASED",
      laneId: lane.lane_id,
      taskId: latch.task_id,
      digest: latch.instruction_digest
    });
    return "NOT_CONFIRMED";
  }

  if (latch.reconcile_blocked) return "BLOCKED";
  const reload = !latch.reconcile_reloaded;
  if (reload) {
    latch.reconcile_reloaded = true;
    latch.reconcile_started_at = new Date().toISOString();
    await atomicJsonWrite(registryPath, registry);
    await safeLog(logPath, {
      type: "LANE_WORK_SEND_RECONCILE_RELOAD",
      laneId: lane.lane_id,
      taskId: latch.task_id,
      digest: latch.instruction_digest
    });
  }

  const inspect = () => inspectKnownTargetSendOutcome({
    adapter,
    page,
    digest: latch.instruction_digest,
    marker: latch.dispatch_id ? workDispatchMarker(latch.dispatch_id) : null,
    preUserCount: latch.pre_user_count,
    preMaxTurnOrdinal: latch.pre_max_turn_ordinal,
    brain: false,
    reload
  });
  const outcome = reload
    ? await runBrowserMutation(
        scheduler,
        { laneId: lane.lane_id, role: "WORK", page, reason: "WORK_RECONCILE_RELOAD" },
        inspect
      )
    : await inspect();

  if (outcome === "PENDING") {
    await safeLog(logPath, {
      type: "LANE_WORK_SEND_RECONCILE_PENDING",
      laneId: lane.lane_id,
      taskId: latch.task_id,
      digest: latch.instruction_digest
    });
    return "PENDING";
  }

  if (outcome === "CONFIRMED") {
    await finalizeConfirmedDispatch({
      foundUrl: registryLane.work_url,
      registryLane,
      latch,
      registry,
      registryPath
    });
    return "CONFIRMED";
  }

  if (outcome === "NOT_CONFIRMED") {
    if (latch.rollover_generation) {
      latch.send_attempted_at = null;
      latch.send_state = "NOT_CONFIRMED";
      latch.reconcile_reloaded = false;
      delete latch.reconcile_started_at;
      await atomicJsonWrite(registryPath, registry);
      await safeLog(logPath, {
        type: "LANE_WORK_ROLLOVER_SEND_NOT_CONFIRMED",
        laneId: lane.lane_id,
        taskId: latch.task_id,
        digest: latch.instruction_digest,
        reason: "same_latch_retry_ready"
      });
      return "NOT_CONFIRMED";
    }

    if (!latch.planning_contract_version) {
      latch.send_attempted_at = null;
      latch.send_state = "NOT_CONFIRMED";
      latch.reconcile_reloaded = false;
      delete latch.reconcile_started_at;
      await atomicJsonWrite(registryPath, registry);
      await safeLog(logPath, {
        type: "LANE_WORK_LEGACY_SEND_NOT_CONFIRMED_RETRY_SAME_IDENTITY",
        laneId: lane.lane_id,
        taskId: latch.task_id,
        digest: latch.instruction_digest
      });
      return "NOT_CONFIRMED";
    }

    registryLane.dispatch_inflight = null;
    await atomicJsonWrite(registryPath, registry);
    await safeLog(logPath, {
      type: "LANE_WORK_SEND_NOT_CONFIRMED_RETRY",
      laneId: lane.lane_id,
      taskId: latch.task_id,
      digest: latch.instruction_digest
    });
    return "NOT_CONFIRMED";
  }

  latch.reconcile_blocked = true;
  await atomicJsonWrite(registryPath, registry);
  await safeLog(logPath, {
    type: "LANE_WORK_SEND_RECONCILE_BLOCKED",
    laneId: lane.lane_id,
    taskId: latch.task_id,
    digest: latch.instruction_digest,
    reason: "stable target changed without matching digest"
  });
  return "BLOCKED";
}

async function emitWorkCapacityDecision({
  lane,
  registryLane,
  taskId,
  decision
}) {
  if (!decision || decision.state === WORK_CAPACITY_STATES.NOT_FULL) return;

  for (const reasonCode of decision.evidence_codes || []) {
    await emitLaneEvent({
      lane_id: lane.lane_id,
      actor: "SUPERVISOR",
      event_type: LANE_EVENT_TYPES.WORK_FULL_EVIDENCE,
      task_id: taskId,
      phase: decision.state === WORK_CAPACITY_STATES.FULL_CONFIRMED
        ? "FULL_CONFIRMED"
        : "RECOVERY",
      reason_code: reasonCode,
      work_generation: Number(registryLane.work_generation || 0),
      work_url_revision: Number(registryLane.applied_work_url_revision || 0)
    });
  }

  await emitLaneEvent({
    lane_id: lane.lane_id,
    actor: "SUPERVISOR",
    event_type: decision.state === WORK_CAPACITY_STATES.FULL_CONFIRMED
      ? LANE_EVENT_TYPES.WORK_FULL_CONFIRMED
      : LANE_EVENT_TYPES.WORK_FULL_AMBIGUOUS,
    task_id: taskId,
    phase: decision.state === WORK_CAPACITY_STATES.FULL_CONFIRMED
      ? "FULL_CONFIRMED"
      : "RECOVERY",
    reason_code: decision.state === WORK_CAPACITY_STATES.FULL_CONFIRMED
      ? (
          decision.strong
            ? "EXPLICIT_FULL_LIMIT_UI"
            : "CAPACITY_MULTI_SIGNAL"
        )
      : "CAPACITY_AMBIGUOUS",
    work_generation: Number(registryLane.work_generation || 0),
    work_url_revision: Number(registryLane.applied_work_url_revision || 0)
  });
}

async function beginFullRollover({
  lane,
  registryLane,
  directive,
  decision,
  registry,
  registryPath,
  logPath
}) {
  const at = new Date().toISOString();
  registryLane.work_rollover = beginWorkRollover({
    reason: "FULL_CONFIRMED",
    taskId: directive.task_id,
    directiveDigest: directive.digest,
    directiveInstructionDigest: directive.instruction_digest,
    oldWorkGeneration: Number(registryLane.work_generation || 0),
    oldWorkUrlRevision: Number(registryLane.applied_work_url_revision || 0),
    oldWorkTargetDigest: registryLane.work_url
      ? sha256(registryLane.work_url)
      : null,
    capacityEvidenceCodes: decision.evidence_codes,
    at
  });
  await atomicJsonWrite(registryPath, registry);
  await emitWorkCapacityDecision({
    lane,
    registryLane,
    taskId: directive.task_id,
    decision
  });
  await safeLog(logPath, {
    type: "LANE_WORK_FULL_CONFIRMED",
    laneId: lane.lane_id,
    taskId: directive.task_id,
    digest: directive.digest,
    reason: decision.strong ? "strong_structured_ui" : "multi_signal"
  });
}

function rolloverOldTargetMatches(registryLane, rollover) {
  if (!rollover) return false;
  if (
    Number(registryLane.work_generation || 0) !==
    Number(rollover.old_work_generation || 0)
  ) {
    return false;
  }
  if (rollover.reason === "NO_WORK_TARGET") {
    return !String(registryLane.work_url || "").trim();
  }
  if (!registryLane.work_url || !rollover.old_work_target_digest) return false;
  return sha256(registryLane.work_url) === rollover.old_work_target_digest;
}

async function primeBlankWorkConversation({
  adapter,
  page,
  lane,
  expectedGeneration
}) {
  const marker = [
    "MAGASIN_WORK_BOOTSTRAP_V1",
    `lane_id=${lane.lane_id}`,
    `generation=${expectedGeneration}`
  ].join(" ");
  const body = [
    marker,
    "Initialize this Work conversation only.",
    "Reply exactly MAGASIN_WORK_READY.",
    "Do not execute any business task from this bootstrap message."
  ].join("\n");

  const sent = await sendComposerInstruction(page, body, { dryRun: false });
  if (!sent?.executed) {
    if (sent?.rejection_class === SEND_REJECTION_CLASSES.RATE_LIMITED) {
      throw chatGptRateLimitError();
    }
    const error = new Error("AUTO_WORK_BOOTSTRAP_NOT_EXECUTED");
    error.code = "AUTO_WORK_BOOTSTRAP_NOT_EXECUTED";
    throw error;
  }

  const markerConfirmed = await waitForUserTurnMarker(
    page,
    marker,
    { timeoutMs: 15_000, intervalMs: 250 }
  );
  if (!markerConfirmed) {
    const error = new Error("AUTO_WORK_BOOTSTRAP_SEND_NOT_CONFIRMED");
    error.code = "AUTO_WORK_BOOTSTRAP_SEND_NOT_CONFIRMED";
    throw error;
  }

  // The durable acceptance condition is the canonical conversation identity,
  // not the model's bootstrap reply text. A new ChatGPT thread may remain on
  // /c/WEB:<uuid> while the server has already published its canonical /c/<id>
  // link in the conversation list.
  const identityDeadline = Date.now() + 90_000;
  let canonicalUrl = null;
  while (Date.now() <= identityDeadline) {
    await assertPageNotRateLimited(page);

    if (isPersistableConversationUrl(String(page.url()))) {
      const target = targetFromUrl(page.url());
      canonicalUrl = `${target.origin}${target.pathname}`;
      break;
    }

    let transientTarget = null;
    try {
      transientTarget = targetFromUrl(page.url());
    } catch {}

    if (transientTarget?.pathname?.startsWith("/c/")) {
      const matched = await adapter.findExactConversationUrlByPath(
        page,
        transientTarget.pathname
      ).catch(() => null);
      if (
        matched &&
        isPersistableConversationUrl(String(matched)) &&
        pageMatchesTarget(String(matched), transientTarget)
      ) {
        const target = targetFromUrl(matched);
        canonicalUrl = `${target.origin}${target.pathname}`;
        break;
      }
    }

    await delay(500);
  }

  if (!canonicalUrl) {
    const error = new Error("AUTO_WORK_BOOTSTRAP_CANONICAL_IDENTITY_NOT_CONFIRMED");
    error.code = "AUTO_WORK_BOOTSTRAP_CANONICAL_IDENTITY_NOT_CONFIRMED";
    throw error;
  }

  if (!pageMatchesTarget(page.url(), targetFromUrl(canonicalUrl))) {
    await page.goto(canonicalUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });
    await page.waitForTimeout(800);
    await assertPageNotRateLimited(page);
  }

  if (
    !isPersistableConversationUrl(String(page.url())) ||
    !pageMatchesTarget(page.url(), targetFromUrl(canonicalUrl)) ||
    !await hasUserTurnMarker(page, marker)
  ) {
    const error = new Error("AUTO_WORK_BOOTSTRAP_CANONICAL_RELOAD_NOT_CONFIRMED");
    error.code = "AUTO_WORK_BOOTSTRAP_CANONICAL_RELOAD_NOT_CONFIRMED";
    throw error;
  }

  return marker;
}

async function createBlankWorkTarget({
  adapter,
  scheduler,
  lane,
  registryLane,
  expectedGeneration
}) {
  if (!scheduler) {
    const page = await adapter.newChatPage("https://chatgpt.com/", {
      allowTransientRetry: false
    });
    await primeBlankWorkConversation({
      adapter,
      page,
      lane,
      expectedGeneration
    });
    const url = await waitForConversationUrl(page);
    return { page, url, generation: expectedGeneration };
  }

  const created = await scheduler.createPageUnderMutation({
    laneId: lane.lane_id,
    role: "WORK",
    url: "https://chatgpt.com/",
    targetRevision: Number(registryLane.applied_work_url_revision || 0),
    generation: expectedGeneration
  }, async (page) => {
    // Bootstrap creates only the canonical conversation identity. The business
    // task is still dispatched later under the persisted dispatch latch.
    await primeBlankWorkConversation({
      adapter,
      page,
      lane,
      expectedGeneration
    });
    return waitForConversationUrl(page);
  });
  return {
    page: created.page,
    url: created.result,
    generation: expectedGeneration
  };
}

async function dispatchWork({
  adapter,
  lane,
  registryLane,
  directive,
  execute,
  registry,
  registryPath,
  logPath,
  scheduler = null,
  stopPath = null,
  configPath = null
}) {
  let rollover = normalizeWorkRollover(registryLane.work_rollover);
  const activeReplacement = activeReplacementRollover(registryLane);
  const replacementContinuation = Boolean(
    registryLane.awaiting_work &&
    activeReplacement &&
    rolloverMatchesDirective(activeReplacement, directive) &&
    registryLane.task_id === directive.task_id &&
    registryLane.instruction_digest === directive.instruction_digest
  );

  if (registryLane.relay_inflight || (registryLane.awaiting_work && !replacementContinuation)) {
    if (
      registryLane.awaiting_work &&
      !registryLane.relay_inflight &&
      registryLane.task_id === directive.task_id &&
      registryLane.instruction_digest === directive.instruction_digest
    ) {
      return;
    }
    throw new Error("Brain issued a new task while the previous Work result is unresolved");
  }

  if (rollover && !rolloverMatchesDirective(rollover, directive)) {
    throw new Error("Work rollover directive identity mismatch; fail-closed");
  }

  if (registryLane.dispatch_inflight) {
    const existing = registryLane.dispatch_inflight;
    const reusableRolloverLatch = Boolean(
      existing.rollover_generation &&
      !existing.send_attempted_at &&
      (existing.send_state === "PERSISTED_NOT_SENT" || existing.send_state === "NOT_CONFIRMED")
    );
    if (!reusableRolloverLatch) {
      const outcome = await reconcileDispatchInflight({
        adapter,
        lane,
        registryLane,
        registry,
        registryPath,
        logPath,
        directive,
        scheduler
      });
      if (
        outcome === "CONFIRMED" ||
        outcome === "PENDING" ||
        outcome === "BLOCKED"
      ) {
        return;
      }
    }
  }

  const assignedAt = new Date().toISOString();
  const timing = ensureLaneTaskTiming(registryLane, directive.task_id);
  const assigned = beginTaskAssignment(timing, {
    taskId: directive.task_id,
    directiveDigest: directive.digest,
    at: assignedAt
  });

  const emitAssigned = async () => {
    if (!assigned.changed) return;
    await emitLaneEvent({
      timestamp: assignedAt,
      lane_id: lane.lane_id,
      actor: "BRAIN",
      event_type: LANE_EVENT_TYPES.BRAIN_TASK_ASSIGNED,
      task_id: directive.task_id,
      phase: "ASSIGNED",
      work_generation: Number(registryLane.work_generation || 0)
    });
  };

  rollover = normalizeWorkRollover(registryLane.work_rollover);

  if (rollover?.stage === WORK_ROLLOVER_STAGES.FULL_CONFIRMED) {
    registryLane.work_rollover = markRolloverIntentPersisted(rollover, {
      at: new Date().toISOString()
    });
    await atomicJsonWrite(registryPath, registry);
    await emitAssigned();
    await emitLaneEvent({
      lane_id: lane.lane_id,
      actor: "SUPERVISOR",
      event_type: LANE_EVENT_TYPES.WORK_ROLLOVER_INTENT,
      task_id: directive.task_id,
      phase: "ROLLOVER",
      reason_code: "ROLLOVER_INTENT_PERSISTED",
      work_generation: Number(registryLane.work_generation || 0),
      work_url_revision: Number(registryLane.applied_work_url_revision || 0)
    });
    return;
  }

  rollover = normalizeWorkRollover(registryLane.work_rollover);
  if (
    rollover &&
    (
      rollover.stage === WORK_ROLLOVER_STAGES.INTENT_PERSISTED ||
      rollover.stage === WORK_ROLLOVER_STAGES.BLANK_TARGET_CREATING
    )
  ) {
    if (!rolloverOldTargetMatches(registryLane, rollover)) {
      throw new Error("Work rollover old target/generation identity mismatch");
    }

    const workTargetPolicy = resolveWorkTargetPolicy(registryLane);
    if (
      rollover.reason === "NO_WORK_TARGET" &&
      workTargetPolicy.mode !== WORK_TARGET_MODES.AUTO
    ) {
      await safeLog(logPath, {
        type: "LANE_OWNER_WORK_TARGET_REQUIRED",
        laneId: lane.lane_id,
        taskId: directive.task_id,
        digest: directive.digest,
        reasonCode: "OWNER_WORK_TARGET_REQUIRED"
      });
      return;
    }

    let autoCreationClaimedThisTurn = false;
    if (rollover.stage === WORK_ROLLOVER_STAGES.INTENT_PERSISTED) {
      registryLane.work_rollover = markBlankTargetCreating(rollover, {
        at: new Date().toISOString()
      });
      await atomicJsonWrite(registryPath, registry);
      await emitAssigned();
      rollover = normalizeWorkRollover(registryLane.work_rollover);
      if (rollover.reason === "NO_WORK_TARGET") {
        autoCreationClaimedThisTurn = true;
        await emitLaneEvent({
          lane_id: lane.lane_id,
          actor: "SUPERVISOR",
          event_type: LANE_EVENT_TYPES.AUTO_WORK_CREATE_REQUESTED,
          task_id: directive.task_id,
          phase: "ROLLOVER",
          reason_code: "AUTO_WORK_CREATE_REQUESTED",
          work_generation: Number(registryLane.work_generation || 0),
          work_url_revision: Number(registryLane.applied_work_url_revision || 0)
        });
        await safeLog(logPath, {
          type: "LANE_AUTO_WORK_CREATE_REQUESTED",
          laneId: lane.lane_id,
          taskId: directive.task_id,
          digest: directive.digest,
          reasonCode: "AUTO_WORK_CREATE_REQUESTED"
        });
      }
    } else if (rollover.reason === "NO_WORK_TARGET") {
      await emitLaneEvent({
        lane_id: lane.lane_id,
        actor: "SUPERVISOR",
        event_type: LANE_EVENT_TYPES.AUTO_WORK_CREATE_AMBIGUOUS,
        task_id: directive.task_id,
        phase: "ERROR",
        reason_code: "AUTO_WORK_CREATE_RESTART_AMBIGUOUS",
        work_generation: Number(registryLane.work_generation || 0),
        work_url_revision: Number(registryLane.applied_work_url_revision || 0)
      });
      await safeLog(logPath, {
        type: "LANE_AUTO_WORK_CREATE_AMBIGUOUS",
        laneId: lane.lane_id,
        taskId: directive.task_id,
        digest: directive.digest,
        reasonCode: "AUTO_WORK_CREATE_RESTART_AMBIGUOUS"
      });
      return;
    }

    if (!execute) return;
    if (rollover.reason === "NO_WORK_TARGET" && !autoCreationClaimedThisTurn) {
      return;
    }
    if (!await isLaneMutationAllowed({
      stopPath,
      configPath,
      laneId: lane.lane_id
    })) {
      return;
    }

    const expectedGeneration = Number(rollover.old_work_generation || 0) + 1;
    let created = null;
    try {
      created = await createBlankWorkTarget({
        adapter,
        scheduler,
        lane,
        registryLane,
        expectedGeneration
      });
    } catch (error) {
      if (error?.code === "CHATGPT_RATE_LIMITED") {
        await safeLog(logPath, {
          type: "LANE_CHATGPT_RATE_LIMIT_DETECTED",
          laneId: lane.lane_id,
          taskId: directive.task_id,
          digest: directive.digest,
          reasonCode: "CHATGPT_RATE_LIMITED"
        });
      }
      await safeLog(logPath, {
        type: "LANE_WORK_ROLLOVER_BLANK_CREATE_ERROR",
        laneId: lane.lane_id,
        taskId: directive.task_id,
        digest: directive.digest,
        errorName: error?.name || "Error",
        reason: String(error?.code || error?.message || error).slice(0, 120)
      });
      return;
    }

    const canonicalUrl = normalizeChatGptConversationUrl(created.url);
    registryLane.work_url = canonicalUrl;
    registryLane.work_generation = expectedGeneration;
    registryLane.work_watchdog = normalizeWorkWatchdog(null);
    adoptCurrentTargetHealth(registryLane, { brain: false });
    registryLane.work_rollover = markRolloverTargetPersisted(
      registryLane.work_rollover,
      {
        newWorkGeneration: expectedGeneration,
        newWorkTargetDigest: sha256(canonicalUrl),
        at: new Date().toISOString()
      }
    );
    await atomicJsonWrite(registryPath, registry);
    await emitLaneEvent({
      lane_id: lane.lane_id,
      actor: "SUPERVISOR",
      event_type: LANE_EVENT_TYPES.WORK_ROLLOVER_TARGET_PERSISTED,
      task_id: directive.task_id,
      phase: "ROLLOVER",
      reason_code: "ROLLOVER_TARGET_PERSISTED",
      work_generation: expectedGeneration,
      work_url_revision: Number(registryLane.applied_work_url_revision || 0)
    });
    if (rollover.reason === "NO_WORK_TARGET") {
      await emitLaneEvent({
        lane_id: lane.lane_id,
        actor: "SUPERVISOR",
        event_type: LANE_EVENT_TYPES.AUTO_WORK_TARGET_PERSISTED,
        task_id: directive.task_id,
        phase: "ROLLOVER",
        reason_code: "AUTO_WORK_TARGET_PERSISTED",
        work_generation: expectedGeneration,
        work_url_revision: Number(registryLane.applied_work_url_revision || 0),
        target_role: "WORK",
        target_digest: sha256(canonicalUrl)
      });
      await safeLog(logPath, {
        type: "LANE_AUTO_WORK_TARGET_PERSISTED",
        laneId: lane.lane_id,
        taskId: directive.task_id,
        digest: sha256(canonicalUrl),
        reasonCode: "AUTO_WORK_TARGET_PERSISTED",
        revision: Number(registryLane.applied_work_url_revision || 0)
      });
    }
    await safeLog(logPath, {
      type: "LANE_WORK_ROLLOVER_TARGET_PERSISTED",
      laneId: lane.lane_id,
      taskId: directive.task_id,
      digest: sha256(canonicalUrl),
      reason: `generation=${expectedGeneration}`
    });
    return;
  }

  rollover = normalizeWorkRollover(registryLane.work_rollover);
  if (rollover?.stage === WORK_ROLLOVER_STAGES.DISPATCH_CONFIRMED) {
    return;
  }

  let page = null;
  if (!rollover && !registryLane.work_url) {
    const workTargetPolicy = resolveWorkTargetPolicy(registryLane);
    if (!workTargetPolicy.auto_create_allowed) {
      await safeLog(logPath, {
        type: "LANE_OWNER_WORK_TARGET_REQUIRED",
        laneId: lane.lane_id,
        taskId: directive.task_id,
        digest: directive.digest,
        reasonCode: "OWNER_WORK_TARGET_REQUIRED"
      });
      return;
    }
    registryLane.work_rollover = beginWorkRollover({
      reason: "NO_WORK_TARGET",
      taskId: directive.task_id,
      directiveDigest: directive.digest,
      directiveInstructionDigest: directive.instruction_digest,
      oldWorkGeneration: Number(registryLane.work_generation || 0),
      oldWorkUrlRevision: Number(registryLane.applied_work_url_revision || 0),
      at: new Date().toISOString()
    });
    await atomicJsonWrite(registryPath, registry);
    await emitAssigned();
    await emitLaneEvent({
      lane_id: lane.lane_id,
      actor: "SUPERVISOR",
      event_type: LANE_EVENT_TYPES.WORK_ROLLOVER_INTENT,
      task_id: directive.task_id,
      phase: "ROLLOVER",
      reason_code: "ROLLOVER_INTENT_PERSISTED",
      work_generation: Number(registryLane.work_generation || 0),
      work_url_revision: Number(registryLane.applied_work_url_revision || 0)
    });
    return;
  }

  rollover = normalizeWorkRollover(registryLane.work_rollover);

  if (!await isLaneMutationAllowed({
    stopPath,
    configPath,
    laneId: lane.lane_id
  })) {
    return;
  }

  if (!rollover) {
    const targetBeforeOpen = targetFromUrl(registryLane.work_url);
    page = await openExactConversation(adapter, registryLane.work_url, {
      brain: false,
      scheduler,
      laneId: lane.lane_id,
      targetRevision: Number(registryLane.applied_work_url_revision || 0),
      generation: Number(registryLane.work_generation || 0),
      registryLane,
      registry,
      registryPath
    });
    if (!pageMatchesTarget(page.url(), targetBeforeOpen)) {
      throw new Error("Work target changed during capacity probe");
    }

    const capacity = await probeStableWorkCapacity({
      adapter,
      page,
      expectedUrl: registryLane.work_url
    });

    if (capacity.decision.state === WORK_CAPACITY_STATES.FULL_CONFIRMED) {
      await beginFullRollover({
        lane,
        registryLane,
        directive,
        decision: capacity.decision,
        registry,
        registryPath,
        logPath
      });
      await emitAssigned();
      return;
    }

    if (capacity.decision.state === WORK_CAPACITY_STATES.AMBIGUOUS) {
      await emitWorkCapacityDecision({
        lane,
        registryLane,
        taskId: directive.task_id,
        decision: capacity.decision
      });
    }

    if (
      capacity.first.classification.observation !== OBSERVATIONS.RESPONSE_COMPLETE ||
      capacity.second.classification.observation !== OBSERVATIONS.RESPONSE_COMPLETE
    ) {
      throw new Error("Work conversation is not safely idle for dispatch");
    }
  } else {
    if (
      rollover.stage !== WORK_ROLLOVER_STAGES.TARGET_PERSISTED &&
      rollover.stage !== WORK_ROLLOVER_STAGES.DISPATCH_LATCH_PERSISTED
    ) {
      throw new Error(`unsupported Work rollover stage: ${rollover.stage}`);
    }
    if (
      Number(registryLane.work_generation || 0) !==
        Number(rollover.new_work_generation || 0) ||
      !registryLane.work_url ||
      sha256(registryLane.work_url) !== rollover.new_work_target_digest
    ) {
      throw new Error("persisted rollover target identity mismatch");
    }

    page = await openExactConversation(adapter, registryLane.work_url, {
      brain: false,
      scheduler,
      laneId: lane.lane_id,
      targetRevision: Number(registryLane.applied_work_url_revision || 0),
      generation: Number(registryLane.work_generation || 0),
      registryLane,
      registry,
      registryPath
    });
    await assertConversationSafe(adapter, page, {
      brain: false,
      allowFull: true
    });
  }

  const workBody = rollover?.reason === "FULL_CONFIRMED"
    ? buildWorkRolloverInstruction({
        projectName: lane.project_name,
        taskId: directive.task_id,
        instruction: directive.instruction
      })
    : directive.instruction;

  const existingDispatchLatch = registryLane.dispatch_inflight || null;
  const coreDispatchDigest = sha256(JSON.stringify({
    action: "WORK",
    task_id: directive.task_id,
    instruction: directive.instruction
  }));
  const dispatchIdentityDigest = existingDispatchLatch?.directive_digest
    || coreDispatchDigest;
  const dispatchId = existingDispatchLatch?.dispatch_id || sha256([
    lane.lane_id,
    directive.task_id,
    dispatchIdentityDigest
  ].join("|")).slice(0, 32);
  const planningContract = existingDispatchLatch
    ? Number(existingDispatchLatch.planning_contract_version || 0) >= 1
    : true;
  const outgoingInstruction = buildWorkDispatchInstruction({
    taskId: directive.task_id,
    dispatchId,
    instruction: workBody,
    planningContract
  });
  const instructionDigest = sha256(outgoingInstruction);
  const targetDigest = sha256(registryLane.work_url);

  let latch = registryLane.dispatch_inflight;
  if (latch) {
    if (
      latch.dispatch_id !== dispatchId ||
      latch.instruction_digest !== instructionDigest ||
      Number(latch.work_generation || 0) !==
        Number(registryLane.work_generation || 0) ||
      latch.work_target_digest !== targetDigest
    ) {
      throw new Error("persisted Work dispatch latch identity mismatch");
    }
  } else {
    const baseline = await captureSendBaseline(adapter, page);
    latch = {
      task_id: directive.task_id,
      dispatch_id: dispatchId,
      instruction_digest: instructionDigest,
      directive_instruction_digest: directive.instruction_digest,
      directive_digest: directive.digest,
      dispatch_identity_digest: dispatchIdentityDigest,
      planning_contract_version: 1,
      create_new: Boolean(rollover),
      work_generation: Number(registryLane.work_generation || 0),
      work_url_revision: Number(registryLane.applied_work_url_revision || 0),
      work_target_digest: targetDigest,
      rollover_generation: rollover
        ? Number(registryLane.work_generation || 0)
        : null,
      send_state: "PERSISTED_NOT_SENT",
      send_attempted_at: null,
      ...baseline
    };
    registryLane.dispatch_inflight = latch;

    if (rollover?.stage === WORK_ROLLOVER_STAGES.TARGET_PERSISTED) {
      registryLane.work_rollover = markRolloverDispatchLatchPersisted(
        rollover,
        {
          dispatchId,
          instructionDigest,
          at: new Date().toISOString()
        }
      );
    }
    await atomicJsonWrite(registryPath, registry);
    await emitAssigned();

    if (rollover) {
      await emitLaneEvent({
        lane_id: lane.lane_id,
        actor: "SUPERVISOR",
        event_type: LANE_EVENT_TYPES.WORK_ROLLOVER_INTENT,
        task_id: directive.task_id,
        phase: "ROLLOVER",
        reason_code: "ROLLOVER_DISPATCH_LATCH_PERSISTED",
        work_generation: Number(registryLane.work_generation || 0),
        dispatch_id: dispatchId
      });
    }
  }

  if (!execute) return;
  if (!await isLaneMutationAllowed({
    stopPath,
    configPath,
    laneId: lane.lane_id
  })) {
    return;
  }

  if (await hasUserTurnMarker(page, workDispatchMarker(dispatchId))) {
    await finalizeConfirmedDispatch({
      foundUrl: registryLane.work_url,
      registryLane,
      latch,
      registry,
      registryPath
    });
    return;
  }

  latch.send_attempted_at = new Date().toISOString();
  latch.send_state = "SEND_INTENT_PERSISTED";
  await atomicJsonWrite(registryPath, registry);

  let sent = null;
  try {
    sent = await runBrowserMutation(
      scheduler,
      {
        laneId: lane.lane_id,
        role: "WORK",
        page,
        reason: rollover ? "WORK_ROLLOVER_DISPATCH_SEND" : "WORK_DISPATCH_SEND"
      },
      () => sendComposerInstruction(
        page,
        outgoingInstruction,
        { dryRun: false }
      )
    );
  } catch (error) {
    if (await hasUserTurnMarker(page, workDispatchMarker(dispatchId))) {
      await finalizeConfirmedDispatch({
        foundUrl: registryLane.work_url,
        registryLane,
        latch,
        registry,
        registryPath
      });
      return;
    }

    const rejectionProbe = await adapter.probePage(page).catch(() => null);
    const rejectionClass = classifyComposerSendRejection(
      rejectionProbe?.snapshot || {}
    );
    latch.last_send_rejection = rejectionClass;

    if (rejectionClass === SEND_REJECTION_CLASSES.RATE_LIMITED) {
      latch.reconcile_blocked = true;
      latch.send_state = "RATE_LIMITED";
      latch.send_attempted_at = null;
      await atomicJsonWrite(registryPath, registry);
      await safeLog(logPath, {
        type: "LANE_CHATGPT_RATE_LIMIT_DETECTED",
        laneId: lane.lane_id,
        taskId: directive.task_id,
        digest: instructionDigest,
        reasonCode: "CHATGPT_RATE_LIMITED"
      });
      return;
    }

    if (
      !rollover &&
      rejectionClass === SEND_REJECTION_CLASSES.CAPACITY_REJECTED
    ) {
      const capacity = await probeStableWorkCapacity({
        adapter,
        page,
        expectedUrl: registryLane.work_url,
        sendRejectionCapacity: true
      });
      if (capacity.decision.state === WORK_CAPACITY_STATES.FULL_CONFIRMED) {
        registryLane.dispatch_inflight = null;
        await beginFullRollover({
          lane,
          registryLane,
          directive,
          decision: capacity.decision,
          registry,
          registryPath,
          logPath
        });
        return;
      }
    }

    await atomicJsonWrite(registryPath, registry);
    await safeLog(logPath, {
      type: "LANE_WORK_SEND_ATTEMPT_ERROR",
      laneId: lane.lane_id,
      taskId: directive.task_id,
      digest: instructionDigest,
      errorName: error?.name || "Error",
      reason: rejectionClass
    });
    return;
  }

  if (!sent.executed) {
    const rejectionProbe = await adapter.probePage(page).catch(() => null);
    const rejectionClass = classifyComposerSendRejection(
      rejectionProbe?.snapshot || {}
    );
    latch.last_send_rejection = rejectionClass;

    if (rejectionClass === SEND_REJECTION_CLASSES.RATE_LIMITED) {
      latch.reconcile_blocked = true;
      latch.send_state = "RATE_LIMITED";
      latch.send_attempted_at = null;
      await atomicJsonWrite(registryPath, registry);
      await safeLog(logPath, {
        type: "LANE_CHATGPT_RATE_LIMIT_DETECTED",
        laneId: lane.lane_id,
        taskId: directive.task_id,
        digest: instructionDigest,
        reasonCode: "CHATGPT_RATE_LIMITED"
      });
      return;
    }

    if (rejectionClass === SEND_REJECTION_CLASSES.CAPACITY_REJECTED) {
      const capacity = await probeStableWorkCapacity({
        adapter,
        page,
        expectedUrl: registryLane.work_url,
        sendRejectionCapacity: true
      });

      if (
        !rollover &&
        capacity.decision.state === WORK_CAPACITY_STATES.FULL_CONFIRMED
      ) {
        registryLane.dispatch_inflight = null;
        await beginFullRollover({
          lane,
          registryLane,
          directive,
          decision: capacity.decision,
          registry,
          registryPath,
          logPath
        });
        return;
      }

      latch.reconcile_blocked = true;
      latch.send_state = "CAPACITY_AMBIGUOUS";
      latch.send_attempted_at = null;
      await atomicJsonWrite(registryPath, registry);
      await emitWorkCapacityDecision({
        lane,
        registryLane,
        taskId: directive.task_id,
        decision: capacity.decision
      });
      return;
    }

    if (rejectionClass === SEND_REJECTION_CLASSES.AUTH_SECURITY) {
      latch.reconcile_blocked = true;
      latch.send_state = "SECURITY_BLOCKED";
    } else {
      latch.send_attempted_at = null;
      latch.send_state = "NOT_CONFIRMED";
    }
    await atomicJsonWrite(registryPath, registry);
    await safeLog(logPath, {
      type: "LANE_WORK_SEND_NOT_EXECUTED",
      laneId: lane.lane_id,
      taskId: directive.task_id,
      digest: instructionDigest,
      reason: rejectionClass
    });
    return;
  }

  latch.send_state = "SEND_CLICKED";
  await atomicJsonWrite(registryPath, registry);

  const confirmed = await waitForUserTurnMarker(
    page,
    workDispatchMarker(dispatchId)
  );
  if (!confirmed) {
    await safeLog(logPath, {
      type: "LANE_WORK_SEND_PENDING_CONFIRMATION",
      laneId: lane.lane_id,
      taskId: directive.task_id,
      digest: instructionDigest
    });
    return;
  }

  await finalizeConfirmedDispatch({
    foundUrl: registryLane.work_url,
    registryLane,
    latch,
    registry,
    registryPath
  });
  await safeLog(logPath, {
    type: rollover
      ? "LANE_WORK_ROLLOVER_DISPATCHED"
      : "LANE_WORK_DISPATCHED",
    laneId: lane.lane_id,
    taskId: directive.task_id,
    digest: instructionDigest
  });
}

async function reconcileRelayInflight({
  adapter,
  lane,
  brainPage,
  registryLane,
  registry,
  registryPath,
  logPath
}) {
  const latch = registryLane.relay_inflight;
  if (!latch) return "NONE";

  // v43 and older may have persisted a terminal reconcile_blocked latch after
  // unrelated Brain activity changed the old text/baseline heuristic. Relay
  // recovery remains marker-authoritative; blocked is migration metadata only.
  if (latch.reconcile_blocked) {
    latch.reconcile_blocked = false;
    delete latch.reconcile_started_at;
    delete latch.reconcile_reloaded;
    delete latch.reconcile_runtime_version;
    await atomicJsonWrite(registryPath, registry);
    await safeLog(logPath, {
      type: "LANE_RESULT_RELAY_BLOCKED_LATCH_RECOVERED",
      laneId: lane.lane_id,
      taskId: registryLane.task_id,
      relayId: latch.relay_id,
      digest: latch.response_digest
    });
  }

  let markerPresent = await hasRelayMarker(brainPage, latch.relay_id);
  if (markerPresent) {
    await finalizeConfirmedRelay({
      registryLane,
      registry,
      registryPath,
      latch
    });
    await safeLog(logPath, {
      type: "LANE_RESULT_RELAY_RECONCILE_CONFIRMED",
      laneId: lane.lane_id,
      taskId: registryLane.task_id,
      relayId: latch.relay_id,
      digest: latch.response_digest
    });
    return "CONFIRMED";
  }

  const retryState = relayRetryState(latch);
  if (retryState === RELAY_RETRY_STATES.EXHAUSTED) {
    return "EXHAUSTED";
  }
  if (retryState === RELAY_RETRY_STATES.WAIT) {
    return "PENDING";
  }

  // A latch with no completed send attempt (including a pre-v48 latch left
  // behind by a pre-send UI failure) is safe to retry with the same evidence.
  if (
    Number(latch.attempt_count || 0) === 0 ||
    latch.last_attempt_state === "RETRY_SCHEDULED" ||
    latch.last_attempt_state === "PRE_SEND_FAILED"
  ) {
    return "RETRY_READY";
  }

  const observed = await waitForStableSendSurface(adapter, brainPage, {
    brain: true,
    timeoutMs: 4_000
  });
  markerPresent = await hasRelayMarker(brainPage, latch.relay_id);

  const outcome = classifyRelayMarkerState({
    markerPresent,
    brainStable: Boolean(observed.stable && observed.probe)
  });

  if (outcome === "CONFIRMED") {
    await finalizeConfirmedRelay({
      registryLane,
      registry,
      registryPath,
      latch
    });
    await safeLog(logPath, {
      type: "LANE_RESULT_RELAY_RECONCILE_CONFIRMED",
      laneId: lane.lane_id,
      taskId: registryLane.task_id,
      relayId: latch.relay_id,
      digest: latch.response_digest
    });
    return "CONFIRMED";
  }

  if (outcome === "PENDING") {
    await safeLog(logPath, {
      type: "LANE_RESULT_RELAY_RECONCILE_PENDING",
      laneId: lane.lane_id,
      taskId: registryLane.task_id,
      relayId: latch.relay_id,
      digest: latch.response_digest
    });
    return "PENDING";
  }

  // Stable Brain + missing relay marker proves the previous send did not
  // persist. Keep the same latch/screenshot, back off, and count the attempt
  // instead of clearing evidence and recapturing forever.
  const scheduled = scheduleRelayRetry(latch);
  await atomicJsonWrite(registryPath, registry);
  await safeLog(logPath, {
    type: scheduled === RELAY_RETRY_STATES.EXHAUSTED
      ? "LANE_RESULT_RELAY_RETRY_EXHAUSTED"
      : "LANE_RESULT_RELAY_NOT_CONFIRMED_RETRY",
    laneId: lane.lane_id,
    taskId: registryLane.task_id,
    relayId: latch.relay_id,
    digest: latch.response_digest,
    reason: `attempts=${Number(latch.attempt_count || 0)}`
  });
  if (scheduled === RELAY_RETRY_STATES.EXHAUSTED) {
    await emitRelayRearmExhaustedIfRelevant({ lane, registryLane, latch });
  }
  return scheduled === RELAY_RETRY_STATES.EXHAUSTED
    ? "EXHAUSTED"
    : "PENDING";
}

async function relayWorkResult({
  adapter,
  lane,
  brainPage,
  workPage,
  registryLane,
  captured,
  execute,
  registry,
  registryPath,
  evidenceDir,
  logPath,
  scheduler = null
}) {
  const relay = buildLaneResultRelay({
    laneId: lane.lane_id,
    projectName: lane.project_name,
    taskId: registryLane.task_id,
    generation: registryLane.work_generation,
    responseText: captured.text
  });

  if (
    registryLane.last_result_relay_id === relay.relay_id ||
    await hasRelayMarker(brainPage, relay.relay_id)
  ) {
    await finalizeConfirmedRelay({
      registryLane,
      registry,
      registryPath,
      latch: {
        relay_id: relay.relay_id,
        response_digest: relay.response_digest
      }
    });
    await safeLog(logPath, {
      type: "LANE_RESULT_RELAY_DEDUPED_BY_MARKER",
      laneId: lane.lane_id,
      taskId: registryLane.task_id,
      relayId: relay.relay_id,
      digest: relay.response_digest
    });
    return "CONFIRMED";
  }

  let latch = registryLane.relay_inflight;
  if (latch) {
    const outcome = await reconcileRelayInflight({
      adapter,
      lane,
      brainPage,
      registryLane,
      registry,
      registryPath,
      logPath
    });
    if (
      outcome === "CONFIRMED" ||
      outcome === "PENDING" ||
      outcome === "EXHAUSTED"
    ) {
      return outcome;
    }
    latch = registryLane.relay_inflight;
    if (latch) {
      const reconstructedTextDigest = sha256(relay.text);
      if (
        relay.relay_id !== latch.relay_id ||
        relay.response_digest !== latch.response_digest ||
        reconstructedTextDigest !== latch.text_digest
      ) {
        latch.retry_exhausted = true;
        latch.retry_not_before = null;
        latch.last_attempt_state = "RESULT_IDENTITY_MISMATCH";
        await atomicJsonWrite(registryPath, registry);
        await safeLog(logPath, {
          type: "LANE_RESULT_RELAY_IDENTITY_MISMATCH",
          laneId: lane.lane_id,
          taskId: registryLane.task_id,
          relayId: latch.relay_id,
          reason: "FAIL_CLOSED_RECONSTRUCTED_RESULT_MISMATCH"
        });
        return "EVIDENCE_MISMATCH";
      }
    }
  }

  const brainProbe = await assertConversationSafe(adapter, brainPage, { brain: true });
  if (brainProbe.classification.observation !== OBSERVATIONS.RESPONSE_COMPLETE) {
    return "PENDING";
  }

  if (!latch) {
    await fs.mkdir(evidenceDir, { recursive: true });
    const screenshotPath = path.join(
      evidenceDir,
      `${lane.lane_id}-${relay.relay_id}.png`
    );
    await captureCompletedAssistantTurnScreenshot(workPage, screenshotPath);
    const screenshotStat = await fs.stat(screenshotPath);
    if (!screenshotStat.isFile() || screenshotStat.size <= 0) {
      await fs.unlink(screenshotPath).catch(() => {});
      throw new Error("Work result screenshot was not created correctly");
    }
    await safeLog(logPath, {
      type: "LANE_RESULT_SCREENSHOT_CAPTURED",
      laneId: lane.lane_id,
      taskId: registryLane.task_id,
      relayId: relay.relay_id,
      digest: relay.response_digest
    });

    const relayBaseline = await captureSendBaseline(adapter, brainPage);
    latch = {
      relay_id: relay.relay_id,
      response_digest: relay.response_digest,
      text_digest: sha256(relay.text),
      screenshot_path: screenshotPath,
      attempt_count: 0,
      retry_not_before: null,
      retry_exhausted: false,
      last_attempt_state: "READY",
      ...relayBaseline
    };
    registryLane.relay_inflight = latch;
    await atomicJsonWrite(registryPath, registry);
  }

  if (relayRetryState(latch) === RELAY_RETRY_STATES.EXHAUSTED) {
    return "EXHAUSTED";
  }

  const screenshotPath = String(latch.screenshot_path || "").trim();
  const screenshotStat = screenshotPath
    ? await fs.stat(screenshotPath).catch(() => null)
    : null;
  if (!screenshotStat?.isFile() || screenshotStat.size <= 0) {
    latch.retry_exhausted = true;
    latch.retry_not_before = null;
    latch.last_attempt_state = "EVIDENCE_MISSING";
    await atomicJsonWrite(registryPath, registry);
    await safeLog(logPath, {
      type: "LANE_RESULT_RELAY_EVIDENCE_MISSING",
      laneId: lane.lane_id,
      taskId: registryLane.task_id,
      relayId: relay.relay_id,
      digest: relay.response_digest,
      reason: "FAIL_CLOSED_LATCH_PRESERVED"
    });
    return "EVIDENCE_MISSING";
  }

  if (!execute) return "PENDING";

  beginRelaySendAttempt(latch);
  await atomicJsonWrite(registryPath, registry);

  let sent = null;
  try {
    sent = await runBrowserMutation(
      scheduler,
      { laneId: lane.lane_id, role: "BRAIN", page: brainPage, reason: "RESULT_RELAY_SEND" },
      () => sendComposerWithAttachment(
        brainPage,
        relay.text,
        screenshotPath,
        { dryRun: false }
      )
    );
  } catch (error) {
    latch.last_attempt_state = "PRE_SEND_FAILED";
    const scheduled = scheduleRelayRetry(latch);
    await atomicJsonWrite(registryPath, registry);
    await safeLog(logPath, {
      type: "LANE_RESULT_RELAY_ATTEMPT_ERROR",
      laneId: lane.lane_id,
      taskId: registryLane.task_id,
      relayId: relay.relay_id,
      digest: relay.response_digest,
      errorName: error?.name || "Error",
      reason: String(error?.message || error).slice(0, 180)
    });
    if (scheduled === RELAY_RETRY_STATES.EXHAUSTED) {
      await safeLog(logPath, {
        type: "LANE_RESULT_RELAY_RETRY_EXHAUSTED",
        laneId: lane.lane_id,
        taskId: registryLane.task_id,
        relayId: relay.relay_id,
        digest: relay.response_digest,
        reason: `attempts=${latch.attempt_count}`
      });
      await emitRelayRearmExhaustedIfRelevant({ lane, registryLane, latch });
      return "EXHAUSTED";
    }
    return "PENDING";
  }

  if (!sent.executed) {
    latch.last_attempt_state = "PRE_SEND_FAILED";
    const scheduled = scheduleRelayRetry(latch);
    await atomicJsonWrite(registryPath, registry);
    await safeLog(logPath, {
      type: "LANE_RESULT_RELAY_NOT_EXECUTED",
      laneId: lane.lane_id,
      taskId: registryLane.task_id,
      relayId: relay.relay_id,
      digest: relay.response_digest,
      reason: sent.reason || "unknown"
    });
    if (scheduled === RELAY_RETRY_STATES.EXHAUSTED) {
      await safeLog(logPath, {
        type: "LANE_RESULT_RELAY_RETRY_EXHAUSTED",
        laneId: lane.lane_id,
        taskId: registryLane.task_id,
        relayId: relay.relay_id,
        digest: relay.response_digest,
        reason: `attempts=${latch.attempt_count}`
      });
      await emitRelayRearmExhaustedIfRelevant({ lane, registryLane, latch });
      return "EXHAUSTED";
    }
    return "PENDING";
  }

  latch.last_attempt_state = "SEND_CLICKED";
  latch.retry_not_before = null;
  await atomicJsonWrite(registryPath, registry);
  await safeLog(logPath, {
    type: "LANE_RESULT_RELAY_SEND_CLICKED",
    laneId: lane.lane_id,
    taskId: registryLane.task_id,
    relayId: relay.relay_id,
    digest: relay.response_digest
  });

  const relayConfirmed = await waitForRelayMarker(
    brainPage,
    relay.relay_id
  );
  if (!relayConfirmed) {
    await safeLog(logPath, {
      type: "LANE_RESULT_RELAY_PENDING_CONFIRMATION",
      laneId: lane.lane_id,
      taskId: registryLane.task_id,
      relayId: relay.relay_id,
      digest: relay.response_digest
    });
    return "PENDING";
  }

  await finalizeConfirmedRelay({
    registryLane,
    registry,
    registryPath,
    latch: {
      relay_id: relay.relay_id,
      response_digest: relay.response_digest
    }
  });
  await safeLog(logPath, {
    type: "LANE_WORK_RESULT_RELAYED",
    laneId: lane.lane_id,
    taskId: registryLane.task_id,
    relayId: relay.relay_id,
    digest: relay.response_digest
  });
  return "CONFIRMED";
}

function currentTargetHealthIdentity(registryLane, { brain = false } = {}) {
  const raw = String(brain ? registryLane.brain_url : registryLane.work_url || "").trim();
  if (!raw) return null;
  let normalized = null;
  try {
    normalized = normalizeChatGptConversationUrl(raw);
  } catch {
    return null;
  }
  return exactTargetHealthIdentity({
    brain,
    normalizedUrl: normalized,
    targetRevision: Number(
      brain
        ? registryLane.applied_brain_url_revision
        : registryLane.applied_work_url_revision
      || 0
    ),
    generation: brain ? 0 : Number(registryLane.work_generation || 0)
  });
}

function currentTargetIsQuarantined(registryLane, { brain = false } = {}) {
  const identity = currentTargetHealthIdentity(registryLane, { brain });
  if (!identity) return false;
  return isTargetQuarantined(
    registryLane[targetHealthField(brain)],
    identity
  );
}

function adoptCurrentTargetHealth(
  registryLane,
  {
    brain = false,
    at = new Date().toISOString()
  } = {}
) {
  const field = targetHealthField(brain);
  const identity = currentTargetHealthIdentity(registryLane, { brain });
  if (!identity) {
    const wasQuarantined = registryLane[field]?.state === "QUARANTINED";
    registryLane[field] = defaultTargetHealth();
    return { cleared: wasQuarantined, identity: null };
  }

  const before = registryLane[field];
  const wasQuarantined = before?.state === "QUARANTINED";
  const changedCanonical = Boolean(
    before?.target_digest &&
    before.target_digest !== identity.target_digest
  );
  registryLane[field] = adoptTargetHealthIdentity(before, identity, { at });
  return {
    cleared: Boolean(wasQuarantined && changedCanonical),
    identity
  };
}

async function emitTargetQuarantineCleared({
  lane,
  registryLane,
  brain,
  identity
}) {
  if (!identity) return;
  await emitLaneEvent({
    lane_id: lane.lane_id,
    actor: "SUPERVISOR",
    event_type: LANE_EVENT_TYPES.TARGET_QUARANTINE_CLEARED,
    task_id: registryLane.task_id || undefined,
    phase: "APPLIED",
    reason_code: "TARGET_NEW_CANONICAL_IDENTITY",
    work_generation: Number(registryLane.work_generation || 0),
    target_role: identity.role,
    target_digest: identity.target_digest,
    target_revision: identity.target_revision
  });
}

async function applyOwnerBrainTarget({
  lane,
  registryLane,
  registry,
  registryPath,
  logPath
}) {
  const revision = Number(lane.brain_url_revision || 0);
  if (revision <= Number(registryLane.applied_brain_url_revision || 0)) {
    return false;
  }

  const raw = String(lane.brain_url || "").trim();
  let configuredUrl = "";
  if (raw) {
    try {
      configuredUrl = normalizeChatGptConversationUrl(raw);
    } catch {
      throw new Error("LINK BỘ NÃO không hợp lệ. Hãy dán link cuộc trò chuyện ChatGPT dùng làm Bộ não.");
    }
  }

  const changed = configuredUrl !== String(registryLane.brain_url || "");
  if (changed) {
    await clearRelayInflight(registryLane);

    registryLane.brain_url = configuredUrl;
    registryLane.brain_request_sent = false;
    registryLane.brain_request_inflight = null;
    registryLane.brain_directive_adopted = null;
    registryLane.last_brain_directive_digest = null;
    registryLane.work_rollover = null;

    // A blocked Work-dispatch latch belongs to the old Brain directive. An
    // explicit Owner Brain change is the authority to abandon that blocked
    // directive, but only when no Work result is actively pending.
    if (
      !registryLane.awaiting_work &&
      registryLane.dispatch_inflight?.reconcile_blocked
    ) {
      await safeLog(logPath, {
        type: "LANE_OWNER_BRAIN_REBASE_CANCELLED_BLOCKED_DISPATCH",
        laneId: lane.lane_id,
        taskId: registryLane.dispatch_inflight.task_id,
        digest: registryLane.dispatch_inflight.instruction_digest
      });
      registryLane.dispatch_inflight = null;
      registryLane.task_id = null;
      registryLane.instruction_digest = null;
      registryLane.task_timing = normalizeTaskTiming(null);
      registryLane.work_watchdog = normalizeWorkWatchdog(null);
    }

    // A relay latch is target-specific. When Owner changes Brain, its evidence
    // has already been cleaned above; keep the active Work task/result pending
    // so it can be relayed to the newly selected Brain exactly once.

    await safeLog(logPath, {
      type: "LANE_OWNER_BRAIN_TARGET_CHANGED",
      laneId: lane.lane_id,
      digest: configuredUrl ? sha256(configuredUrl) : "NONE"
    });
  }

  registryLane.applied_brain_url_revision = revision;
  const brainHealth = adoptCurrentTargetHealth(registryLane, {
    brain: true
  });
  await atomicJsonWrite(registryPath, registry);
  if (brainHealth.cleared) {
    await emitTargetQuarantineCleared({
      lane,
      registryLane,
      brain: true,
      identity: brainHealth.identity
    });
  }
  return changed;
}

async function emitWorkTargetTransition({
  lane,
  registryLane,
  eventType,
  phase,
  reasonCode,
  revision
}) {
  await emitLaneEvent({
    lane_id: lane.lane_id,
    actor: "SUPERVISOR",
    event_type: eventType,
    task_id: registryLane.task_id || undefined,
    phase,
    reason_code: reasonCode,
    work_generation: Number(registryLane.work_generation || 0),
    work_url_revision: Number(revision || 0)
  });
}

async function applyOwnerWorkStateReset({
  lane,
  registryLane,
  registry,
  registryPath,
  logPath
}) {
  const revision = Number(lane.work_state_reset_revision || 0);
  if (revision <= Number(registryLane.applied_work_state_reset_revision || 0)) {
    return false;
  }

  // Destructive state reset is reserved for the explicit Owner-authorized
  // maintenance workflow. Work target save/hot-swap never enters this path.
  await clearRelayInflight(registryLane);
  registryLane.task_id = null;
  registryLane.instruction_digest = null;
  registryLane.last_brain_directive_digest = null;
  registryLane.last_work_result_digest = null;
  registryLane.last_result_relay_id = null;
  registryLane.last_dispatch_id = null;
  registryLane.dispatch_inflight = null;
  registryLane.brain_request_inflight = null;
  registryLane.brain_directive_adopted = null;
  registryLane.awaiting_work = false;
  registryLane.task_timing = normalizeTaskTiming(null);
  registryLane.work_watchdog = normalizeWorkWatchdog(null);
  registryLane.work_rollover = null;
  registryLane.pending_work_url = "";
  registryLane.pending_work_url_revision = 0;
  registryLane.pending_work_saved_at = null;
  registryLane.pending_work_mode = null;
  registryLane.work_generation = Number(registryLane.work_generation || 0) + 1;
  registryLane.applied_work_state_reset_revision = revision;

  await atomicJsonWrite(registryPath, registry);
  await safeLog(logPath, {
    type: "LANE_OWNER_MAINTENANCE_WORK_STATE_RESET",
    laneId: lane.lane_id,
    reason: `reset_revision=${revision}`
  });
  return true;
}

async function emitRelayRearmLifecycleEvent({
  lane,
  registryLane,
  latch,
  eventType,
  reasonCode,
  phase = "RECOVERY"
}) {
  await emitLaneEvent({
    lane_id: lane.lane_id,
    actor: "SUPERVISOR",
    event_type: eventType,
    task_id: registryLane.task_id || undefined,
    phase,
    reason_code: reasonCode,
    work_generation: Number(registryLane.work_generation || 0),
    relay_id: latch?.relay_id || undefined
  });
}

async function emitRelayRearmExhaustedIfRelevant({
  lane,
  registryLane,
  latch
}) {
  if (!Number(latch?.owner_rearm_revision || 0)) return false;
  await emitRelayRearmLifecycleEvent({
    lane,
    registryLane,
    latch,
    eventType: LANE_EVENT_TYPES.RELAY_REARM_EXHAUSTED,
    reasonCode: "OWNER_RELAY_REARM_EXHAUSTED",
    phase: "ERROR"
  });
  return true;
}

async function applyOwnerRelayRetryRearm({
  adapter,
  lane,
  brainPage = null,
  registryLane,
  registry,
  registryPath,
  logPath
}) {
  const revision = Number(lane.relay_retry_rearm_revision || 0);
  const appliedRevision = Number(
    registryLane.applied_relay_retry_rearm_revision || 0
  );
  if (revision <= appliedRevision) {
    return { status: "NONE", revision: appliedRevision };
  }

  const latch = registryLane.relay_inflight;
  if (!latch || !latch.retry_exhausted) {
    const outcome = rearmRelayRetry(latch, {
      revision,
      appliedRevision
    });
    registryLane.applied_relay_retry_rearm_revision = outcome.applied_revision;
    await atomicJsonWrite(registryPath, registry);
    await safeLog(logPath, {
      type: "LANE_OWNER_RELAY_REARM_NOOP",
      laneId: lane.lane_id,
      taskId: registryLane.task_id,
      relayId: latch?.relay_id,
      reason: outcome.status
    });
    return { status: "NOOP", revision: outcome.applied_revision };
  }

  if (!brainPage) {
    throw new Error("Exact Brain page is required before applying relay rearm");
  }

  await assertConversationSafe(adapter, brainPage, { brain: true });

  if (await hasRelayMarker(brainPage, latch.relay_id)) {
    registryLane.applied_relay_retry_rearm_revision = revision;
    await finalizeConfirmedRelay({
      registryLane,
      registry,
      registryPath,
      latch
    });
    await emitRelayRearmLifecycleEvent({
      lane,
      registryLane,
      latch,
      eventType: LANE_EVENT_TYPES.RELAY_REARM_DEDUPED,
      reasonCode: "OWNER_RELAY_REARM_DEDUPED"
    });
    await safeLog(logPath, {
      type: "LANE_OWNER_RELAY_REARM_DEDUPED",
      laneId: lane.lane_id,
      taskId: registryLane.task_id,
      relayId: latch.relay_id,
      reason: `revision=${revision}`
    });
    return { status: "DEDUPED", revision };
  }

  const stableBrain = await waitForStableSendSurface(adapter, brainPage, {
    brain: true,
    timeoutMs: 4_000
  });
  if (!stableBrain.stable || !stableBrain.probe) {
    await safeLog(logPath, {
      type: "LANE_OWNER_RELAY_REARM_BRAIN_NOT_READY",
      laneId: lane.lane_id,
      taskId: registryLane.task_id,
      relayId: latch.relay_id,
      reason: `revision=${revision};intent_pending=true`
    });
    return { status: "BRAIN_NOT_READY", revision };
  }

  // Brain may have persisted the previous send while the stable-surface probe
  // was running. Reconcile the deterministic marker again before opening a
  // fresh retry epoch.
  if (await hasRelayMarker(brainPage, latch.relay_id)) {
    registryLane.applied_relay_retry_rearm_revision = revision;
    await finalizeConfirmedRelay({
      registryLane,
      registry,
      registryPath,
      latch
    });
    await emitRelayRearmLifecycleEvent({
      lane,
      registryLane,
      latch,
      eventType: LANE_EVENT_TYPES.RELAY_REARM_DEDUPED,
      reasonCode: "OWNER_RELAY_REARM_DEDUPED"
    });
    return { status: "DEDUPED", revision };
  }

  const screenshotPath = String(latch.screenshot_path || "").trim();
  const screenshotStat = screenshotPath
    ? await fs.stat(screenshotPath).catch(() => null)
    : null;
  if (!screenshotStat?.isFile() || screenshotStat.size <= 0) {
    registryLane.applied_relay_retry_rearm_revision = revision;
    latch.retry_exhausted = true;
    latch.retry_not_before = null;
    latch.last_attempt_state = "EVIDENCE_MISSING";
    await atomicJsonWrite(registryPath, registry);
    await safeLog(logPath, {
      type: "LANE_OWNER_RELAY_REARM_EVIDENCE_MISSING",
      laneId: lane.lane_id,
      taskId: registryLane.task_id,
      relayId: latch.relay_id,
      reason: `revision=${revision};fail_closed=true`
    });
    return { status: "EVIDENCE_MISSING", revision };
  }

  const outcome = rearmRelayRetry(latch, {
    revision,
    appliedRevision
  });
  if (outcome.status !== RELAY_REARM_STATES.REARMED) {
    throw new Error(`Unexpected relay rearm transition: ${outcome.status}`);
  }

  registryLane.applied_relay_retry_rearm_revision = outcome.applied_revision;
  await atomicJsonWrite(registryPath, registry);
  await emitRelayRearmLifecycleEvent({
    lane,
    registryLane,
    latch,
    eventType: LANE_EVENT_TYPES.RELAY_REARM_APPLIED,
    reasonCode: "OWNER_RELAY_REARM"
  });
  await safeLog(logPath, {
    type: "LANE_OWNER_RELAY_REARM_APPLIED",
    laneId: lane.lane_id,
    taskId: registryLane.task_id,
    relayId: latch.relay_id,
    reason: `revision=${revision};epoch=${outcome.retry_epoch}`
  });
  return {
    status: "REARMED",
    revision: outcome.applied_revision,
    retry_epoch: outcome.retry_epoch
  };
}

async function applyOwnerWorkTarget({
  lane,
  registryLane,
  registry,
  registryPath,
  logPath
}) {
  const revision = Number(lane.work_url_revision || 0);
  const latestSeenRevision = Math.max(
    Number(registryLane.applied_work_url_revision || 0),
    Number(registryLane.pending_work_url_revision || 0)
  );
  if (revision <= latestSeenRevision) {
    return false;
  }

  const mode = String(lane.work_mode || "").toUpperCase() === WORK_TARGET_MODES.AUTO
    ? WORK_TARGET_MODES.AUTO
    : WORK_TARGET_MODES.OWNER;
  const raw = String(lane.work_url || "").trim();
  let configuredUrl = "";

  if (mode === WORK_TARGET_MODES.OWNER) {
    if (!raw) {
      throw new Error("LINK WORK không hợp lệ. LƯU WORK cần một cuộc trò chuyện ChatGPT cụ thể.");
    }
    try {
      configuredUrl = normalizeChatGptConversationUrl(raw);
    } catch {
      throw new Error("LINK WORK không hợp lệ. Hãy dán link cuộc trò chuyện ChatGPT hoặc dùng TỰ TẠO WORK.");
    }
  }

  const outcome = acceptOwnerWorkTargetRevision(registryLane, {
    url: configuredUrl,
    mode,
    revision,
    saved_at: lane.work_url_saved_at || null
  });

  if (outcome.status === "NOOP") return false;

  if (
    outcome.status !== "PENDING" &&
    !registryLane.awaiting_work &&
    !registryLane.dispatch_inflight &&
    !registryLane.relay_inflight
  ) {
    registryLane.work_rollover = null;
  }

  const workHealth = outcome.status === "PENDING"
    ? { cleared: false, identity: null }
    : adoptCurrentTargetHealth(registryLane, { brain: false });

  await atomicJsonWrite(registryPath, registry);
  if (workHealth.cleared) {
    await emitTargetQuarantineCleared({
      lane,
      registryLane,
      brain: false,
      identity: workHealth.identity
    });
  }
  await safeLog(logPath, {
    type: "LANE_OWNER_WORK_TARGET_REVISION",
    laneId: lane.lane_id,
    taskId: registryLane.task_id,
    reason: `revision=${revision};state=${outcome.status};mode=${mode}`
  });

  await emitWorkTargetTransition({
    lane,
    registryLane,
    eventType: LANE_EVENT_TYPES.WORK_TARGET_SAVED,
    phase: "SAVED",
    reasonCode: "OWNER_WORK_REVISION",
    revision
  });

  if (outcome.status === "PENDING") {
    await emitWorkTargetTransition({
      lane,
      registryLane,
      eventType: LANE_EVENT_TYPES.WORK_TARGET_PENDING,
      phase: "PENDING",
      reasonCode: "ACTIVE_WORK_PRESERVED",
      revision
    });
  } else {
    await emitWorkTargetTransition({
      lane,
      registryLane,
      eventType: LANE_EVENT_TYPES.WORK_TARGET_APPLIED,
      phase: "APPLIED",
      reasonCode: outcome.status === "ACKNOWLEDGED"
        ? "SAME_TARGET_NO_CHURN"
        : "OWNER_WORK_REVISION",
      revision
    });
  }

  return true;
}

async function applyPendingWorkTargetAtSafeBoundary({
  lane,
  registryLane,
  registry,
  registryPath,
  logPath
}) {
  const outcome = applyPendingWorkTargetIfSafe(registryLane);
  if (outcome.status === "NONE" || outcome.status === "PENDING") {
    return outcome;
  }

  // NOOP may clear a stale pending revision; persist that normalization.
  if (
    outcome.status === "APPLIED" &&
    !registryLane.awaiting_work &&
    !registryLane.dispatch_inflight &&
    !registryLane.relay_inflight
  ) {
    registryLane.work_rollover = null;
  }
  const workHealth = outcome.status === "APPLIED"
    ? adoptCurrentTargetHealth(registryLane, { brain: false })
    : { cleared: false, identity: null };
  await atomicJsonWrite(registryPath, registry);
  if (workHealth.cleared) {
    await emitTargetQuarantineCleared({
      lane,
      registryLane,
      brain: false,
      identity: workHealth.identity
    });
  }

  if (outcome.status === "APPLIED") {
    await safeLog(logPath, {
      type: "LANE_OWNER_WORK_TARGET_APPLIED",
      laneId: lane.lane_id,
      taskId: registryLane.task_id,
      reason: `revision=${outcome.revision};mode=${outcome.mode};safe_boundary=true`
    });
    await emitWorkTargetTransition({
      lane,
      registryLane,
      eventType: LANE_EVENT_TYPES.WORK_TARGET_APPLIED,
      phase: "APPLIED",
      reasonCode: "SAFE_BOUNDARY",
      revision: outcome.revision
    });
  }

  return outcome;
}

async function isOwnerStopRequested(stopPath) {
  if (!stopPath) return false;
  try {
    await fs.access(stopPath);
    return true;
  } catch {
    return false;
  }
}

async function isLaneMutationAllowed({
  stopPath,
  configPath,
  laneId
}) {
  if (await isOwnerStopRequested(stopPath)) return false;
  if (!configPath) return true;
  const latest = normalizeLaneConfig(
    await readJson(configPath, defaultLaneConfig())
  );
  const lane = latest.lanes.find((item) => item.lane_id === laneId);
  return Boolean(lane?.enabled);
}

async function isWatchdogRecoveryAllowed(args) {
  return isLaneMutationAllowed(args);
}

function watchdogIdentity(registryLane) {
  return {
    task_id: registryLane.task_id || null,
    work_url: String(registryLane.work_url || ""),
    work_generation: Number(registryLane.work_generation || 0),
    work_url_revision: Number(registryLane.applied_work_url_revision || 0)
  };
}

function watchdogIdentityMatches(registryLane, expected) {
  const current = watchdogIdentity(registryLane);
  return (
    current.task_id === expected.task_id &&
    current.work_url === expected.work_url &&
    current.work_generation === expected.work_generation &&
    current.work_url_revision === expected.work_url_revision
  );
}

async function emitWatchdogDecisionEvents({
  lane,
  registryLane,
  timing,
  decision,
  at
}) {
  const common = {
    timestamp: at,
    lane_id: lane.lane_id,
    actor: "SUPERVISOR",
    task_id: registryLane.task_id,
    work_generation: Number(registryLane.work_generation || 0),
    work_url_revision: Number(registryLane.applied_work_url_revision || 0),
    ...timingEventFields(timing, at)
  };

  if (decision.emit_long_running) {
    await emitLaneEvent({
      ...common,
      event_type: LANE_EVENT_TYPES.WORK_LONG_RUNNING,
      phase: "WORKING_LONG",
      reason_code: "WATCHDOG_OBSERVATION_BAND"
    });
  }
  if (decision.emit_stall_check) {
    await emitLaneEvent({
      ...common,
      event_type: LANE_EVENT_TYPES.WATCHDOG_STALL_CHECK,
      phase: "STALL_CHECK",
      reason_code: "WATCHDOG_STALL_ELIGIBLE"
    });
  }
  if (decision.emit_rearmed) {
    await emitLaneEvent({
      ...common,
      event_type: LANE_EVENT_TYPES.WATCHDOG_PROGRESS_REARMED,
      phase: "WORKING_LONG",
      reason_code: "WATCHDOG_PROGRESS_REARMED"
    });
  }
  if (decision.emit_possibly_stalled) {
    await emitLaneEvent({
      ...common,
      event_type: LANE_EVENT_TYPES.POSSIBLY_STALLED,
      phase: "POSSIBLY_STALLED",
      reason_code: decision.reason_code
    });
  }
}

async function evaluateAndPersistWorkWatchdog({
  lane,
  registryLane,
  registry,
  registryPath,
  timing,
  observation,
  activityChanged,
  ownerStopped = false,
  securityBlocked = false,
  at = new Date().toISOString()
}) {
  const before = JSON.stringify(normalizeWorkWatchdog(registryLane.work_watchdog));
  const decision = evaluateWorkWatchdog({
    now: at,
    awaitingWork: Boolean(registryLane.awaiting_work),
    dispatchConfirmed: Boolean(
      registryLane.awaiting_work &&
      !registryLane.dispatch_inflight &&
      timing?.started_at
    ),
    taskId: registryLane.task_id,
    workGeneration: Number(registryLane.work_generation || 0),
    workUrlRevision: Number(registryLane.applied_work_url_revision || 0),
    timing,
    observation,
    activityChanged,
    ownerStopped,
    securityBlocked,
    watchdog: registryLane.work_watchdog
  });
  registryLane.work_watchdog = decision.state;
  const after = JSON.stringify(decision.state);
  if (before !== after) {
    await atomicJsonWrite(registryPath, registry);
  }
  await emitWatchdogDecisionEvents({
    lane,
    registryLane,
    timing,
    decision,
    at
  });
  return decision;
}

async function executeWatchdogReload({
  adapter,
  lane,
  registryLane,
  registry,
  registryPath,
  logPath,
  scheduler,
  stopPath,
  configPath,
  workPage,
  expectedIdentity
}) {
  if (currentTargetIsQuarantined(registryLane, { brain: false })) {
    return { status: "TARGET_QUARANTINED" };
  }

  if (!(await isWatchdogRecoveryAllowed({
    stopPath,
    configPath,
    laneId: lane.lane_id
  }))) {
    return { status: "OWNER_STOP" };
  }
  if (!watchdogIdentityMatches(registryLane, expectedIdentity)) {
    return { status: "IDENTITY_MISMATCH" };
  }

  let releaseMutation = null;
  try {
    releaseMutation = scheduler
      ? scheduler.acquireMutationLease({
          laneId: lane.lane_id,
          role: "WORK",
          page: workPage,
          reason: "WATCHDOG_RECOVERY_RELOAD"
        })
      : () => {};
  } catch (error) {
    if (error?.code === "MUTATION_LEASE_BUSY") {
      return { status: "MUTATION_BUSY" };
    }
    throw error;
  }

  try {
    if (!(await isWatchdogRecoveryAllowed({
    stopPath,
    configPath,
    laneId: lane.lane_id
  }))) {
      return { status: "OWNER_STOP" };
    }
    if (!watchdogIdentityMatches(registryLane, expectedIdentity)) {
      return { status: "IDENTITY_MISMATCH" };
    }

    const intentAt = new Date().toISOString();
    registryLane.work_watchdog = beginWatchdogReloadIntent(
      registryLane.work_watchdog,
      { now: intentAt }
    );
    await atomicJsonWrite(registryPath, registry);

    await emitLaneEvent({
      timestamp: intentAt,
      lane_id: lane.lane_id,
      actor: "SUPERVISOR",
      event_type: LANE_EVENT_TYPES.PAGE_RECOVERY_RELOAD,
      task_id: registryLane.task_id,
      phase: "RECOVERY",
      reason_code: "WATCHDOG_RELOAD_ELIGIBLE",
      work_generation: Number(registryLane.work_generation || 0),
      work_url_revision: Number(registryLane.applied_work_url_revision || 0),
      ...timingEventFields(registryLane.task_timing, intentAt)
    });

    await safeLog(logPath, {
      type: "WORK_WATCHDOG_RECOVERY_RELOAD",
      laneId: lane.lane_id,
      taskId: registryLane.task_id,
      reason: `epoch=${registryLane.work_watchdog.recovery_epoch};reload=1`
    });

    await workPage.reload({
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });

    const reloadedAt = new Date().toISOString();
    registryLane.work_watchdog = markWatchdogReloaded(
      registryLane.work_watchdog,
      { now: reloadedAt }
    );
    await atomicJsonWrite(registryPath, registry);
  } finally {
    releaseMutation?.({ durable: true });
  }

  if (!watchdogIdentityMatches(registryLane, expectedIdentity)) {
    return { status: "IDENTITY_MISMATCH" };
  }

  const exactTarget = targetFromUrl(expectedIdentity.work_url);
  if (!pageMatchesTarget(workPage.url(), exactTarget)) {
    return { status: "IDENTITY_MISMATCH" };
  }

  const probe = await assertConversationSafe(adapter, workPage, {
    brain: false,
    allowFull: true
  });

  if (registryLane.last_dispatch_id) {
    const markerPresent = await waitForUserTurnMarker(
      workPage,
      workDispatchMarker(registryLane.last_dispatch_id),
      { timeoutMs: 4000, intervalMs: 250 }
    );
    if (!markerPresent) {
      const stalledAt = new Date().toISOString();
      const state = normalizeWorkWatchdog(registryLane.work_watchdog);
      state.phase = "POSSIBLY_STALLED";
      if (!state.possibly_stalled_at) state.possibly_stalled_at = stalledAt;
      registryLane.work_watchdog = state;
      await atomicJsonWrite(registryPath, registry);
      await emitLaneEvent({
        timestamp: stalledAt,
        lane_id: lane.lane_id,
        actor: "SUPERVISOR",
        event_type: LANE_EVENT_TYPES.POSSIBLY_STALLED,
        task_id: registryLane.task_id,
        phase: "POSSIBLY_STALLED",
        reason_code: "WATCHDOG_DISPATCH_MARKER_MISSING",
        work_generation: Number(registryLane.work_generation || 0),
        work_url_revision: Number(registryLane.applied_work_url_revision || 0),
        ...timingEventFields(registryLane.task_timing, stalledAt)
      });
      return { status: "MARKER_MISSING", probe };
    }
  }

  const postProbeAt = new Date().toISOString();
  registryLane.work_watchdog = markWatchdogPostReloadProbe(
    registryLane.work_watchdog,
    { now: postProbeAt }
  );
  await atomicJsonWrite(registryPath, registry);
  return { status: "RELOADED", probe, at: postProbeAt };
}

async function processLaneTurn({
  adapter,
  lane,
  registryLane,
  execute,
  registry,
  registryPath,
  evidenceDir,
  logPath,
  scheduler = null,
  stopPath = null,
  configPath = null
}) {
  if (!lane.enabled) {
    return laneStatus(lane, registryLane, "STOPPED", "Luồng đang dừng.");
  }

  const completedRollover = normalizeWorkRollover(registryLane.work_rollover);
  if (
    completedRollover?.stage === WORK_ROLLOVER_STAGES.DISPATCH_CONFIRMED &&
    !registryLane.dispatch_inflight
  ) {
    registryLane.work_rollover = null;
    await atomicJsonWrite(registryPath, registry);
    return laneStatus(
      lane,
      registryLane,
      registryLane.awaiting_work ? "WORKING" : "READY",
      "Work rollover đã qua durable dispatch confirmation boundary; recovery intent được finalize."
    );
  }

  if (await applyOwnerBrainTarget({
    lane,
    registryLane,
    registry,
    registryPath,
    logPath
  })) {
    return laneStatus(
      lane,
      registryLane,
      "WAITING_BRAIN",
      "Đã áp dụng Brain target mới; turn kế tiếp sẽ mở exact target."
    );
  }

  let brainUrl = null;
  try {
    brainUrl = normalizeChatGptConversationUrl(registryLane.brain_url);
  } catch (error) {
    return laneStatus(lane, registryLane, "NEED_BRAIN_URL", error.message);
  }
  if (!brainUrl) {
    return laneStatus(
      lane,
      registryLane,
      "NEED_BRAIN_URL",
      "Nhập URL cuộc trò chuyện Bộ não rồi bấm LƯU BỘ NÃO hoặc BẮT ĐẦU LUỒNG."
    );
  }

  if (await applyOwnerWorkStateReset({
    lane,
    registryLane,
    registry,
    registryPath,
    logPath
  })) {
    return laneStatus(
      lane,
      registryLane,
      "READY",
      "Đã áp dụng Owner-authorized Work state reset."
    );
  }

  if (await applyOwnerWorkTarget({
    lane,
    registryLane,
    registry,
    registryPath,
    logPath
  })) {
    return laneStatus(
      lane,
      registryLane,
      registryLane.pending_work_url_revision ? "WORKING" : "READY",
      registryLane.pending_work_url_revision
        ? "Đã lưu Work target mới; task hiện tại tiếp tục exact Work cũ đến safe boundary."
        : "Đã áp dụng Work target mới."
    );
  }

  const pendingBefore = Number(registryLane.pending_work_url_revision || 0);
  const pendingOutcome = await applyPendingWorkTargetAtSafeBoundary({
    lane,
    registryLane,
    registry,
    registryPath,
    logPath
  });
  if (
    pendingBefore > 0 &&
    (pendingOutcome.status === "APPLIED" || pendingOutcome.status === "NOOP")
  ) {
    return laneStatus(
      lane,
      registryLane,
      "READY",
      pendingOutcome.status === "APPLIED"
        ? "Pending Work target đã áp dụng đúng safe boundary."
        : "Pending Work target stale đã được normalize an toàn."
    );
  }

  if (currentTargetIsQuarantined(registryLane, { brain: true })) {
    return laneStatus(
      lane,
      registryLane,
      "WAIT_OWNER",
      quarantinedTargetMessage({ brain: true, registryLane }),
      { target_quarantined_role: "BRAIN" }
    );
  }

  if (
    registryLane.work_url &&
    currentTargetIsQuarantined(registryLane, { brain: false }) &&
    !registryLane.awaiting_work &&
    !activeReplacementRollover(registryLane)
  ) {
    return laneStatus(
      lane,
      registryLane,
      "WAIT_OWNER",
      quarantinedTargetMessage({ brain: false, registryLane }),
      { target_quarantined_role: "WORK" }
    );
  }

  let brainPage = null;
  let brainProbe = null;
  const ensureBrainPage = async () => {
    if (!brainPage) {
      brainPage = await openExactConversation(adapter, brainUrl, {
        brain: true,
        scheduler,
        laneId: lane.lane_id,
        targetRevision: Number(registryLane.applied_brain_url_revision || 0),
        generation: 0,
        registryLane,
        registry,
        registryPath
      });
      brainProbe = await assertConversationSafe(adapter, brainPage, { brain: true });
    }
    return brainPage;
  };

  const replacementRollover = activeReplacementRollover(registryLane);
  if (
    replacementRollover &&
    replacementRollover.stage !== WORK_ROLLOVER_STAGES.DISPATCH_CONFIRMED
  ) {
    await ensureBrainPage();
    const replacementDirective = await recoverActiveWorkDirective(
      brainPage,
      registryLane
    );
    if (!replacementDirective) {
      return laneStatus(
        lane,
        registryLane,
        "WAIT_OWNER",
        "Không thể khôi phục exact Brain directive cho Work replacement; giữ nguyên task và không tạo/gửi Work mới."
      );
    }
    await dispatchWork({
      adapter,
      lane,
      registryLane,
      directive: replacementDirective,
      execute,
      registry,
      registryPath,
      logPath,
      scheduler,
      stopPath,
      configPath
    });
    const afterReplacement = normalizeWorkRollover(registryLane.work_rollover);
    return laneStatus(
      lane,
      registryLane,
      afterReplacement?.stage === WORK_ROLLOVER_STAGES.DISPATCH_CONFIRMED
        ? "WORKING"
        : "RECOVERING",
      "Đang thay Work không dùng được bằng target mới, giữ nguyên exact task identity."
    );
  }

    const relayRearmRevision = Number(lane.relay_retry_rearm_revision || 0);
  const appliedRelayRearmRevision = Number(
    registryLane.applied_relay_retry_rearm_revision || 0
  );
  if (relayRearmRevision > appliedRelayRearmRevision) {
    if (registryLane.relay_inflight?.retry_exhausted) {
      await ensureBrainPage();
    }
    const rearmOutcome = await applyOwnerRelayRetryRearm({
      adapter,
      lane,
      brainPage,
      registryLane,
      registry,
      registryPath,
      logPath
    });
    if (rearmOutcome.status === "DEDUPED") {
      return laneStatus(
        lane,
        registryLane,
        "WAITING_BRAIN",
        "KẾT QUẢ ĐÃ ĐƯỢC XÁC NHẬN — marker relay đã tồn tại; Robot không gửi lại."
      );
    }
    if (rearmOutcome.status === "REARMED") {
      return laneStatus(
        lane,
        registryLane,
        "RECOVERING",
        `ĐÃ YÊU CẦU THỬ LẠI RELAY — revision ${rearmOutcome.revision}; giữ nguyên relay_id và task, lane yield trước retry.`
      );
    }
    if (rearmOutcome.status === "BRAIN_NOT_READY") {
      return laneStatus(
        lane,
        registryLane,
        "RECOVERING",
        `ĐÃ YÊU CẦU THỬ LẠI RELAY — revision ${rearmOutcome.revision}; Brain chưa ổn định nên chưa mở retry epoch, intent vẫn pending.`
      );
    }
    if (rearmOutcome.status === "EVIDENCE_MISSING") {
      return laneStatus(
        lane,
        registryLane,
        "WAIT_OWNER",
        "Relay evidence hiện tại bị thiếu/hỏng. Robot giữ nguyên task và relay latch, không reset và không gửi lại."
      );
    }
  }

  if (registryLane.relay_inflight) {
    await ensureBrainPage();
    const relayOutcome = await reconcileRelayInflight({
      adapter,
      lane,
      brainPage,
      registryLane,
      registry,
      registryPath,
      logPath
    });
    if (relayOutcome === "EXHAUSTED") {
      return laneStatus(
        lane,
        registryLane,
        "WAIT_OWNER",
        "RELAY HẾT LƯỢT THỬ — kiểm tra Brain rồi bấm THỬ LẠI RELAY. Robot không tự retry thêm và không gửi trùng."
      );
    }
    if (relayOutcome === "PENDING") {
      return laneStatus(
        lane,
        registryLane,
        "RECOVERING",
        "Đang chờ xác minh/backoff lần gửi kết quả trước; lane đã yield scheduler."
      );
    }
    if (relayOutcome !== "RETRY_READY") {
      return laneStatus(
        lane,
        registryLane,
        "WAITING_BRAIN",
        "Relay marker đã reconcile; lane yield trước bước tiếp theo."
      );
    }
    // RETRY_READY is the precondition for one bounded relay attempt. Continue
    // this turn only far enough to reconstruct the persisted Work result and
    // execute that one mutation; retry/backoff WAIT already yielded above.
  }

  if (registryLane.dispatch_inflight) {
    await ensureBrainPage();
    const dispatchOutcome = await reconcileDispatchInflight({
      adapter,
      lane,
      registryLane,
      registry,
      registryPath,
      logPath,
      brainPage,
      scheduler
    });
    if (dispatchOutcome === "PENDING") {
      return laneStatus(
        lane,
        registryLane,
        "RECOVERING",
        "Đang tự xác minh lần gửi Work trước; chỉ quan sát, không tải lại trang lặp lại; lane yield scheduler."
      );
    }
    if (dispatchOutcome === "BLOCKED") {
      return laneStatus(
        lane,
        registryLane,
        "WAIT_OWNER",
        "Work chat có thay đổi ngoài dự kiến; Robot đã dừng tự gửi lại để tránh trùng."
      );
    }
    if (dispatchOutcome === "CONFIRMED") {
      return laneStatus(
        lane,
        registryLane,
        "WORKING",
        "Dispatch marker đã xác nhận; Work chạy độc lập, lane đã yield scheduler."
      );
    }
    if (dispatchOutcome !== "RETRY_READY") {
      return laneStatus(
        lane,
        registryLane,
        "STARTING",
        "Lần gửi trước được chứng minh chưa persist; retry chỉ được xét ở turn kế tiếp."
      );
    }
    // Rollover latch is durably persisted and marker absence was proven (or
    // no send was attempted yet). Continue this bounded turn only to recover
    // the exact Brain directive and perform at most one send mutation.
  }

  if (registryLane.awaiting_work) {
    if (!registryLane.work_url) {
      throw new Error("Work URL is missing while a result is pending");
    }

    let workPage = null;
    try {
      workPage = await openExactConversation(adapter, registryLane.work_url, {
        brain: false,
        scheduler,
        laneId: lane.lane_id,
        targetRevision: Number(registryLane.applied_work_url_revision || 0),
        generation: Number(registryLane.work_generation || 0),
        registryLane,
        registry,
        registryPath
      });
    } catch (error) {
      if (!currentTargetIsQuarantined(registryLane, { brain: false })) {
        throw error;
      }

      await ensureBrainPage();
      const replacementDirective = await recoverActiveWorkDirective(
        brainPage,
        registryLane
      );
      if (!replacementDirective) {
        return laneStatus(
          lane,
          registryLane,
          "WAIT_OWNER",
          "Work đã được xác nhận không dùng được nhưng exact Brain directive không còn đủ bằng chứng để tự thay Work."
        );
      }
      const reasonCode = String(
        registryLane.work_target_health?.reason_code || "TARGET_QUARANTINED"
      );
      const replacement = await beginActiveWorkReplacement({
        lane,
        registryLane,
        directive: replacementDirective,
        reason: WORK_ROLLOVER_REASONS.UNUSABLE_TARGET,
        evidenceCode: reasonCode,
        registry,
        registryPath,
        logPath
      });
      if (replacement.status === "IDENTITY_MISMATCH") {
        return laneStatus(
          lane,
          registryLane,
          "WAIT_OWNER",
          "Work replacement bị chặn vì durable task identity không còn khớp."
        );
      }
      await dispatchWork({
        adapter,
        lane,
        registryLane,
        directive: replacementDirective,
        execute,
        registry,
        registryPath,
        logPath,
        scheduler,
        stopPath,
        configPath
      });
      return laneStatus(
        lane,
        registryLane,
        "RECOVERING",
        "Work cũ đã được xác nhận không dùng được; rollover intent đã persist và Robot đang tạo Work thay thế."
      );
    }
    const workProbe = await assertConversationSafe(adapter, workPage, {
      brain: false,
      allowFull: true
    });

    const activityAt = new Date().toISOString();
    const timing = ensureLaneTaskTiming(registryLane, registryLane.task_id);
    const safeObservation = buildSafeWorkObservation(
      workProbe.snapshot,
      workProbe.classification.observation === OBSERVATIONS.RESPONSE_COMPLETE
    );
    const activity = observeWorkActivity(
      timing,
      safeObservation,
      { at: activityAt }
    );
    if (activity.baseline_initialized || activity.changed) {
      await atomicJsonWrite(registryPath, registry);
      if (activity.event_due) {
        await emitLaneEvent({
          timestamp: activityAt,
          lane_id: lane.lane_id,
          actor: "WORK",
          event_type: LANE_EVENT_TYPES.WORK_ACTIVITY,
          task_id: registryLane.task_id,
          phase: "WORKING",
          reason_code: activity.reason_code,
          work_generation: Number(registryLane.work_generation || 0),
          ...timingEventFields(timing, activityAt)
        });
      }
    }

    if (hardStopObservation(workProbe.classification.observation)) {
      return laneStatus(
        lane,
        registryLane,
        "WAIT_OWNER",
        "Work chat cần bạn xử lý đăng nhập/xác minh hoặc điều kiện an toàn."
      );
    }

    const recoveryAllowed = await isWatchdogRecoveryAllowed({
      stopPath,
      configPath,
      laneId: lane.lane_id
    });
    let watchdogDecision = await evaluateAndPersistWorkWatchdog({
      lane,
      registryLane,
      registry,
      registryPath,
      timing,
      observation: safeObservation,
      activityChanged: activity.changed,
      ownerStopped: !recoveryAllowed,
      securityBlocked: false,
      at: activityAt
    });

    if (watchdogDecision.decision === WORK_WATCHDOG_DECISIONS.BLOCKED_OWNER_STOP) {
      return laneStatus(
        lane,
        registryLane,
        "STOPPED",
        "Owner STOP/lane disable đã chặn watchdog recovery.",
        {
          watchdog_phase: registryLane.work_watchdog.phase,
          task_elapsed_ms: watchdogDecision.elapsed_ms
        }
      );
    }

    if (watchdogDecision.decision === WORK_WATCHDOG_DECISIONS.IDENTITY_MISMATCH) {
      return laneStatus(
        lane,
        registryLane,
        "WAIT_OWNER",
        "Watchdog từ chối recovery vì task/Work revision/generation không còn khớp exact execution target.",
        {
          watchdog_phase: registryLane.work_watchdog.phase,
          task_elapsed_ms: watchdogDecision.elapsed_ms
        }
      );
    }

    if (watchdogDecision.decision === WORK_WATCHDOG_DECISIONS.STALL_CHECK) {
      return laneStatus(
        lane,
        registryLane,
        "STALL_CHECK",
        "Work đã >=30 phút và không có safe activity >=5 phút; watchdog chỉ đánh dấu STALL_CHECK ở turn này.",
        {
          watchdog_phase: registryLane.work_watchdog.phase,
          task_elapsed_ms: watchdogDecision.elapsed_ms,
          last_activity_at: timing.last_activity_at
        }
      );
    }

    if (
      watchdogDecision.decision === WORK_WATCHDOG_DECISIONS.STALL_CHECK_COOLDOWN ||
      watchdogDecision.decision === WORK_WATCHDOG_DECISIONS.RECOVERY_UNCERTAIN
    ) {
      return laneStatus(
        lane,
        registryLane,
        "WORKING_LONG",
        watchdogDecision.decision === WORK_WATCHDOG_DECISIONS.RECOVERY_UNCERTAIN
          ? "Watchdog recovery intent đã persist; không tự replay reload sau restart/crash."
          : "Work vẫn long-running; watchdog đang trong reload cooldown, không reload.",
        {
          watchdog_phase: registryLane.work_watchdog.phase,
          task_elapsed_ms: watchdogDecision.elapsed_ms,
          last_activity_at: timing.last_activity_at
        }
      );
    }

    if (watchdogDecision.decision === WORK_WATCHDOG_DECISIONS.POSSIBLY_STALLED) {
      await ensureBrainPage();
      const replacementDirective = await recoverActiveWorkDirective(
        brainPage,
        registryLane
      );
      if (!replacementDirective) {
        return laneStatus(
          lane,
          registryLane,
          "POSSIBLY_STALLED",
          "Work có thể đã stalled sau bounded recovery nhưng exact Brain directive không đủ bằng chứng để tự thay Work.",
          {
            watchdog_phase: registryLane.work_watchdog.phase,
            task_elapsed_ms: watchdogDecision.elapsed_ms,
            last_activity_at: timing.last_activity_at
          }
        );
      }
      const replacement = await beginActiveWorkReplacement({
        lane,
        registryLane,
        directive: replacementDirective,
        reason: WORK_ROLLOVER_REASONS.POSSIBLY_STALLED,
        evidenceCode: watchdogDecision.reason_code || "WATCHDOG_NO_PROGRESS_AFTER_RELOAD",
        registry,
        registryPath,
        logPath
      });
      if (replacement.status === "IDENTITY_MISMATCH") {
        return laneStatus(
          lane,
          registryLane,
          "WAIT_OWNER",
          "Watchdog replacement bị chặn vì durable task identity không khớp."
        );
      }
      await dispatchWork({
        adapter,
        lane,
        registryLane,
        directive: replacementDirective,
        execute,
        registry,
        registryPath,
        logPath,
        scheduler,
        stopPath,
        configPath
      });
      return laneStatus(
        lane,
        registryLane,
        "RECOVERING",
        "Work stalled đã qua bounded recovery; rollover intent đã persist và cùng task đang được chuyển sang Work mới.",
        {
          watchdog_phase: registryLane.work_watchdog.phase,
          task_elapsed_ms: watchdogDecision.elapsed_ms,
          last_activity_at: timing.last_activity_at
        }
      );
    }

    if (watchdogDecision.decision === WORK_WATCHDOG_DECISIONS.RELOAD_ELIGIBLE) {
      if (!execute) {
        return laneStatus(
          lane,
          registryLane,
          "STALL_CHECK",
          "Watchdog đủ điều kiện reload nhưng runtime đang dry-run; không mutation.",
          {
            watchdog_phase: registryLane.work_watchdog.phase,
            task_elapsed_ms: watchdogDecision.elapsed_ms
          }
        );
      }

      const expectedIdentity = watchdogIdentity(registryLane);
      const recovery = await executeWatchdogReload({
        adapter,
        lane,
        registryLane,
        registry,
        registryPath,
        logPath,
        scheduler,
        stopPath,
        configPath,
        workPage,
        expectedIdentity
      });

      if (recovery.status === "OWNER_STOP") {
        return laneStatus(
          lane,
          registryLane,
          "STOPPED",
          "Owner STOP/lane disable đã thắng race trước watchdog reload; không mutation."
        );
      }
      if (recovery.status === "MUTATION_BUSY") {
        return laneStatus(
          lane,
          registryLane,
          "STALL_CHECK",
          "Global mutation lease đang bận; watchdog yield và thử lại ở turn sau, không spin."
        );
      }
      if (recovery.status === "IDENTITY_MISMATCH") {
        return laneStatus(
          lane,
          registryLane,
          "WAIT_OWNER",
          "Watchdog huỷ recovery vì exact task/Work/generation thay đổi trước mutation."
        );
      }
      if (recovery.status === "MARKER_MISSING") {
        return laneStatus(
          lane,
          registryLane,
          "POSSIBLY_STALLED",
          "Sau reload exact Work, dispatch marker không được xác minh. Robot fail-closed, không resend."
        );
      }

      const postObservation = buildSafeWorkObservation(
        recovery.probe.snapshot,
        recovery.probe.classification.observation === OBSERVATIONS.RESPONSE_COMPLETE
      );
      const postActivity = observeWorkActivity(
        timing,
        postObservation,
        { at: recovery.at }
      );
      if (postActivity.baseline_initialized || postActivity.changed) {
        await atomicJsonWrite(registryPath, registry);
        if (postActivity.event_due) {
          await emitLaneEvent({
            timestamp: recovery.at,
            lane_id: lane.lane_id,
            actor: "WORK",
            event_type: LANE_EVENT_TYPES.WORK_ACTIVITY,
            task_id: registryLane.task_id,
            phase: "WORKING_LONG",
            reason_code: postActivity.reason_code,
            work_generation: Number(registryLane.work_generation || 0),
            ...timingEventFields(timing, recovery.at)
          });
        }
      }

      watchdogDecision = await evaluateAndPersistWorkWatchdog({
        lane,
        registryLane,
        registry,
        registryPath,
        timing,
        observation: postObservation,
        activityChanged: postActivity.changed,
        ownerStopped: false,
        securityBlocked: false,
        at: recovery.at
      });

      return laneStatus(
        lane,
        registryLane,
        watchdogDecision.decision === WORK_WATCHDOG_DECISIONS.POSSIBLY_STALLED
          ? "POSSIBLY_STALLED"
          : "WORKING_LONG",
        watchdogDecision.decision === WORK_WATCHDOG_DECISIONS.WORKING_LONG
          ? "Watchdog reload bounded hoàn tất; có fresh progress/running evidence. Không resend task."
          : "Watchdog reload bounded hoàn tất; đang observation post-reload, không reload lần hai.",
        {
          watchdog_phase: registryLane.work_watchdog.phase,
          task_elapsed_ms: watchdogDecision.elapsed_ms,
          last_activity_at: timing.last_activity_at
        }
      );
    }

    if (workProbe.classification.observation !== OBSERVATIONS.RESPONSE_COMPLETE) {
      const longRunning =
        watchdogDecision.decision === WORK_WATCHDOG_DECISIONS.WORKING_LONG;
      return laneStatus(
        lane,
        registryLane,
        longRunning ? "WORKING_LONG" : "WORKING",
        longRunning
          ? `Work đang chạy lâu hợp lệ cho ${registryLane.task_id || "task hiện tại"}; chỉ bounded observation rồi yield.`
          : `Đang thực hiện ${registryLane.task_id || "công việc hiện tại"}; observation xong và lane đã yield.`,
        {
          watchdog_phase: registryLane.work_watchdog.phase,
          task_elapsed_ms: watchdogDecision.elapsed_ms,
          last_activity_at: timing.last_activity_at
        }
      );
    }

    const captured = await captureCompletedAssistantTurn(workPage);
    if (!captured) {
      return laneStatus(
        lane,
        registryLane,
        "WORKING",
        "Đang chờ Work chat hoàn tất câu trả lời."
      );
    }

    if (
      captured.digest === registryLane.last_work_result_digest &&
      registryLane.last_result_relay_id
    ) {
      registryLane.awaiting_work = false;
      await atomicJsonWrite(registryPath, registry);
      return laneStatus(
        lane,
        registryLane,
        "WAITING_BRAIN",
        "Result đã được relay trước đó; exact-once state đã reconcile."
      );
    }

    const completedAt = new Date().toISOString();
    const completionTiming = ensureLaneTaskTiming(
      registryLane,
      registryLane.task_id
    );
    const completed = markTaskCompleted(completionTiming, {
      taskId: registryLane.task_id,
      at: completedAt
    });
    if (completed.changed) {
      await atomicJsonWrite(registryPath, registry);
      await emitLaneEvent({
        timestamp: completedAt,
        lane_id: lane.lane_id,
        actor: "WORK",
        event_type: LANE_EVENT_TYPES.WORK_COMPLETED,
        task_id: registryLane.task_id,
        phase: "COMPLETED",
        work_generation: Number(registryLane.work_generation || 0),
        ...timingEventFields(completionTiming, completedAt)
      });
      return laneStatus(
        lane,
        registryLane,
        "RELAYING_RESULT",
        "Đã capture completed result; relay mutation được tách sang bounded turn kế tiếp."
      );
    }

    await ensureBrainPage();
    const relayOutcome = await relayWorkResult({
      adapter,
      lane,
      brainPage,
      workPage,
      registryLane,
      captured,
      execute,
      registry,
      registryPath,
      evidenceDir,
      logPath,
      scheduler
    });

    if (registryLane.awaiting_work) {
      if (relayOutcome === "EXHAUSTED") {
        return laneStatus(
          lane,
          registryLane,
          "WAIT_OWNER",
          "RELAY HẾT LƯỢT THỬ — kiểm tra Brain rồi bấm THỬ LẠI RELAY. Robot không tự retry thêm và không gửi trùng."
        );
      }
      if (
        relayOutcome === "EVIDENCE_MISSING" ||
        relayOutcome === "EVIDENCE_MISMATCH"
      ) {
        return laneStatus(
          lane,
          registryLane,
          "WAIT_OWNER",
          relayOutcome === "EVIDENCE_MISMATCH"
            ? "Kết quả Work hiện tại không còn khớp relay latch đã persist. Robot fail-closed, giữ nguyên task/evidence và không gửi."
            : "Relay evidence bị thiếu/hỏng. Robot giữ nguyên relay latch và task; không destructive reset."
        );
      }
      return laneStatus(
        lane,
        registryLane,
        relayOutcome === "PENDING" ? "RECOVERING" : "RELAYING_RESULT",
        relayOutcome === "PENDING"
          ? "Kết quả Work đã sẵn sàng; Robot đang backoff/xác minh lần gửi trước."
          : "Đã thực hiện một relay attempt; lane yield scheduler."
      );
    }

    return laneStatus(
      lane,
      registryLane,
      "WAITING_BRAIN",
      "Đã gửi kết quả về Bộ não; pending Work target sẽ được xét ở turn kế tiếp."
    );
  }

  await ensureBrainPage();

  if (!registryLane.brain_request_sent) {
    const directive = await ensureBrainRequest({
      adapter,
      page: brainPage,
      lane,
      registryLane,
      execute,
      registry,
      registryPath,
      logPath,
      scheduler
    });
    return laneStatus(
      lane,
      registryLane,
      "WAITING_BRAIN",
      directive
        ? "Đã nhận Brain directive; dispatch được tách sang bounded turn kế tiếp."
        : "Đang chờ Bộ não giao công việc đầu tiên."
    );
  }

  if (brainProbe.classification.observation !== OBSERVATIONS.RESPONSE_COMPLETE) {
    return laneStatus(
      lane,
      registryLane,
      "WAITING_BRAIN",
      "Bộ não đang trả lời hoặc chưa sẵn sàng."
    );
  }

  let directive = await recoverPersistedAdoptedBrainDirective({
    page: brainPage,
    lane,
    registryLane
  });

  if (!directive) {
    const captured = await captureCompletedAssistantTurn(brainPage);
    if (!captured) {
      return laneStatus(
        lane,
        registryLane,
        "WAITING_BRAIN",
        "Đang chờ Bộ não trả lệnh."
      );
    }

    try {
      directive = parseLaneDirective(captured.text);
    } catch {
      return laneStatus(
        lane,
        registryLane,
        "WAITING_BRAIN",
        "Bộ não chưa trả block MAGASIN_LANE_DIRECTIVE_V1 hợp lệ."
      );
    }
  }

  await applyBrainVerdictDirective({
    lane,
    registryLane,
    directive,
    registry,
    registryPath
  });

  if (directive.digest === registryLane.last_brain_directive_digest) {
    return laneStatus(
      lane,
      registryLane,
      directive.action === "IDLE" ? "READY" : "WAITING_BRAIN",
      directive.action === "IDLE"
        ? "Bộ não chưa có công việc mới."
        : "Đang chờ trạng thái Work thay đổi."
    );
  }

  if (directive.action === "IDLE") {
    registryLane.last_brain_directive_digest = directive.digest;
    registryLane.task_id = null;
    registryLane.instruction_digest = null;
    await atomicJsonWrite(registryPath, registry);
    return laneStatus(
      lane,
      registryLane,
      "READY",
      "Bộ não chưa có công việc mới."
    );
  }

  await dispatchWork({
    adapter,
    lane,
    registryLane,
    directive,
    execute,
    registry,
    registryPath,
    logPath,
    scheduler,
    stopPath,
    configPath
  });

  return laneStatus(
    lane,
    registryLane,
    registryLane.awaiting_work ? "WORKING" : "STARTING",
    registryLane.awaiting_work
      ? `Đang thực hiện ${registryLane.task_id}; mutation lease đã release tại durable boundary.`
      : "Đã thực hiện một dispatch attempt; lane yield scheduler."
  );
}

async function processLane(args) {
  const scheduler = args.scheduler || null;
  try {
    return await processLaneTurn(args);
  } finally {
    scheduler?.releaseLaneObservations(args.lane?.lane_id);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.workTargetFixture) {
  await import("./work-target-acceptance-cli.mjs");
  process.exit(0);
}
if (args.browserSchedulerFixture) {
  await import("./browser-scheduler-acceptance-cli.mjs");
  process.exit(0);
}
if (args.workWatchdogFixture) {
  await import("./work-watchdog-acceptance-cli.mjs");
  process.exit(0);
}
if (args.relayRearmFixture) {
  await import("./relay-rearm-acceptance-cli.mjs");
  process.exit(0);
}
if (args.workFullFixture) {
  await import("./work-full-acceptance-cli.mjs");
  process.exit(0);
}
if (args.staleTargetFixture) {
  await import("./stale-target-acceptance-cli.mjs");
  process.exit(0);
}
if (!Number.isFinite(args.pollMs) || args.pollMs < 1000) {
  throw new TypeError("poll-ms must be at least 1000");
}
if (!Number.isInteger(args.pageBudget) || args.pageBudget < 1) {
  throw new TypeError("page-budget must be a positive integer");
}

const root = localRoot();
const configPath = path.join(root, "lanes.json");
const registryPath = path.join(root, "lane-registry.json");
const statusPath = path.join(root, "lane-status.json");
const evidenceDir = path.join(root, "lane-evidence");
const logPath = path.join(root, "supervisor.log");
const eventPath = path.join(root, "lane-events.ndjson");
const stopPath = path.join(root, "STOP");

laneEventErrorLogPath = logPath;
laneEventSink = createLaneEventSink({ filePath: eventPath });

let config = normalizeLaneConfig(
  await readJson(configPath, defaultLaneConfig())
);
let registry = normalizeLaneRegistry(
  await readJson(registryPath, defaultLaneRegistry())
);
const startupRelayMigrations = migrateLegacyBlockedRelayLatches(registry);
await atomicJsonWrite(configPath, config);
await atomicJsonWrite(registryPath, registry);
if (startupRelayMigrations > 0) {
  await safeLog(logPath, {
    type: "RUNTIME_RELAY_BLOCKED_LATCHES_MIGRATED",
    reason: `count=${startupRelayMigrations}`
  });
}
await cleanupOrphanRelayEvidence({
  evidenceDir,
  registry,
  logPath
});

const statuses = {};
let evidenceCleanupTicks = 0;
let adapter = null;
let scheduler = null;
let cdpRecoveryFailures = 0;
let restartRequested = false;

await safeLog(logPath, {
  type: "RUNTIME_BOOT",
  reason: `version=${SUPERVISOR_RUNTIME_VERSION};mode=${THREE_LANE_MODE};page_budget=${args.pageBudget}`
});
await emitLaneEvent({
  actor: "SUPERVISOR",
  event_type: LANE_EVENT_TYPES.RECOVERY,
  phase: "RECOVERY",
  reason_code: "RUNTIME_BOOT"
});

try {
  adapter = new ChatGptUiAdapter({ cdpUrl: args.cdpUrl });
  await adapter.open();
  const liveMutationPacingMs = Number.parseInt(
    process.env.P2_LIVE_MUTATION_PACING_MS || "0",
    10
  );
  scheduler = new BrowserScheduler({
    adapter,
    pageBudget: args.pageBudget,
    laneOrder: LANE_IDS,
    mutationMinIntervalMs: Number.isInteger(liveMutationPacingMs) &&
      liveMutationPacingMs >= 0
      ? liveMutationPacingMs
      : 0
  });
  await scheduler.reconstructFromBrowser();

  while (true) {
    try {
      await fs.access(stopPath);
      for (const lane of config.lanes) {
        statuses[lane.lane_id] = laneStatus(
          lane,
          registry.lanes[lane.lane_id],
          "STOPPED",
          "Supervisor đã dừng."
        );
      }
      await writeLaneStatus(statusPath, statuses, scheduler);
      break;
    } catch {}

    config = normalizeLaneConfig(
      await readJson(configPath, defaultLaneConfig())
    );
    registry = normalizeLaneRegistry(
      await readJson(registryPath, defaultLaneRegistry())
    );

    for (const lane of config.lanes) {
      if (!lane.enabled) {
        statuses[lane.lane_id] = laneStatus(
          lane,
          registry.lanes[lane.lane_id],
          "STOPPED",
          "Luồng đang dừng."
        );
      }
    }

    const loopRelayMigrations = migrateLegacyBlockedRelayLatches(registry);
    if (loopRelayMigrations > 0) {
      await atomicJsonWrite(registryPath, registry);
      await safeLog(logPath, {
        type: "RUNTIME_RELAY_BLOCKED_LATCHES_MIGRATED",
        reason: `count=${loopRelayMigrations}`
      });
    }

    evidenceCleanupTicks += 1;
    if (evidenceCleanupTicks >= 12) {
      await cleanupOrphanRelayEvidence({
        evidenceDir,
        registry,
        logPath
      });
      evidenceCleanupTicks = 0;
    }

    const turn = scheduler.nextEnabledTurn(config.lanes);
    if (!turn.lane_id) {
      await scheduler.trimToBudget();
      await writeLaneStatus(statusPath, statuses, scheduler);
      await delay(args.pollMs);
      continue;
    }

    const lane = config.lanes.find((item) => item.lane_id === turn.lane_id);
    const registryLane = registry.lanes[turn.lane_id];

    try {
      statuses[lane.lane_id] = await processLane({
        adapter,
        lane,
        registryLane,
        execute: args.execute,
        registry,
        registryPath,
        evidenceDir,
        logPath,
        scheduler,
        stopPath,
        configPath
      });
      cdpRecoveryFailures = 0;
    } catch (error) {
      const transient = isTransientNavigationError(error);
      let reconnected = false;
      if (transient) {
        reconnected = await adapter.reconnectOverCdp()
          .then(async () => {
            await scheduler.reconstructFromBrowser();
            return true;
          })
          .catch(() => false);
        if (reconnected) {
          cdpRecoveryFailures = 0;
        } else {
          cdpRecoveryFailures += 1;
        }
      }
      statuses[lane.lane_id] = laneStatus(
        lane,
        registryLane,
        transient ? "RECOVERING" : "WAIT_OWNER",
        transient
          ? "Mất kết nối tạm thời; Robot đang tự kết nối lại và sẽ thử tiếp; scheduler rebuild page leases từ durable lane truth."
          : String(error?.message || error).slice(0, 220),
        { error_name: error?.name || "Error" }
      );
      await safeLog(logPath, {
        type: "LANE_ERROR",
        laneId: lane.lane_id,
        taskId: registryLane.task_id,
        errorName: error?.name || "Error",
        reason: String(error?.message || error).slice(0, 240)
      });
      await emitLaneEvent({
        lane_id: lane.lane_id,
        actor: "SUPERVISOR",
        event_type: transient
          ? LANE_EVENT_TYPES.RECOVERY
          : LANE_EVENT_TYPES.ERROR,
        task_id: registryLane.task_id,
        phase: transient ? "RECOVERY" : "ERROR",
        reason_code: transient
          ? "TRANSIENT_NAVIGATION_ERROR"
          : "LANE_PROCESSING_ERROR",
        work_generation: Number(registryLane.work_generation || 0)
      });

      if (transient && !reconnected && cdpRecoveryFailures >= 3) {
        restartRequested = true;
        await safeLog(logPath, {
          type: "RUNTIME_CDP_RESTART_REQUESTED",
          laneId: lane.lane_id,
          taskId: registryLane.task_id,
          reason: "bounded transient CDP reconnect budget exhausted"
        });
        await emitLaneEvent({
          lane_id: lane.lane_id,
          actor: "SUPERVISOR",
          event_type: LANE_EVENT_TYPES.RECOVERY,
          task_id: registryLane.task_id,
          phase: "RECOVERY",
          reason_code: "CDP_RESTART_REQUESTED",
          work_generation: Number(registryLane.work_generation || 0)
        });
      }
    }

    await scheduler.trimToBudget();
    await writeLaneStatus(statusPath, statuses, scheduler);

    if (restartRequested) {
      process.exitCode = 75;
      break;
    }

    if (turn.round_complete) {
      await delay(args.pollMs);
    }
  }
} finally {
  await adapter?.close().catch(() => {});
}
