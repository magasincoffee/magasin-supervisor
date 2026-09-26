import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";


test("Three-Lane runtime honors SUPERVISOR_STATE_ROOT before legacy fallback", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /process\.env\.SUPERVISOR_STATE_ROOT/);
  assert.match(source, /if \(configured\) return path\.resolve\(configured\)/);
  assert.match(source, /MAGASIN", "BusinessOS", "supervisor"/);
});

test("active Three-Lane runtime contains no Brain auto-discovery path", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(source, /findBrainBy/);
  assert.doesNotMatch(source, /listRecentConversationUrls/);
  assert.doesNotMatch(source, /getVisibleChatGptPages/);
  assert.doesNotMatch(source, /BRAIN_REBIND/);
  assert.match(source, /normalizeChatGptConversationUrl\(registryLane\.brain_url\)/);
  assert.match(source, /openExactConversation\(adapter, brainUrl/);
  assert.match(source, /brain: true/);
  assert.match(source, /scheduler/);
});

test("Work URL is Robot-managed and rollover requires FULL_CONFIRMED rather than one regex", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /registryLane\.work_url/);
  assert.match(source, /probeStableWorkCapacity/);
  assert.match(source, /WORK_CAPACITY_STATES\.FULL_CONFIRMED/);
  assert.doesNotMatch(source, /if \(probe\.snapshot\.conversationFull\)/);
  assert.doesNotMatch(source, /createNew = true/);
  assert.match(source, /buildWorkRolloverInstruction/);
  assert.match(source, /Work conversation is missing; automatic replacement is denied/);
});

test("RBT-010 Work result relay sends full text only with exact-once identity", async () => {
  const runtime = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  const capture = await fs.readFile(
    new URL("../src/ui/message-capture.mjs", import.meta.url),
    "utf8"
  );
  const actions = await fs.readFile(
    new URL("../src/ui/actions.mjs", import.meta.url),
    "utf8"
  );

  assert.match(runtime, /buildLaneResultRelay/);
  assert.match(runtime, /sendComposerInstruction/);
  assert.match(runtime, /response_digest/);
  assert.match(runtime, /text_digest/);
  assert.doesNotMatch(runtime, /captureCompletedAssistantTurnScreenshot|sendComposerWithAttachment|screenshot_path|LANE_RESULT_SCREENSHOT_CAPTURED/);
  assert.doesNotMatch(capture, /locator\.screenshot|captureCompletedAssistantTurnScreenshot/);
  assert.doesNotMatch(actions, /setInputFiles|COMPOSER_ATTACHMENT_SEND|sendComposerWithAttachment/);
});

test("dispatch and relay use exact-once inflight latches", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /dispatch_inflight/);
  assert.match(source, /relay_inflight/);
  assert.match(source, /captureUserTurnDigests/);
  assert.match(source, /inspectKnownTargetSendOutcome/);
  assert.match(source, /LANE_WORK_SEND_NOT_CONFIRMED_RETRY/);
  assert.match(source, /last_result_relay_id/);
});

test("one lane error is caught without terminating the other lane loop", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /scheduler\.nextEnabledTurn\(config\.lanes\)/);
  assert.match(source, /const lane = config\.lanes\.find\(\(item\) => item\.lane_id === turn\.lane_id\)/);
  assert.match(source, /statuses\[lane\.lane_id\] = await processLane/);
  assert.match(source, /type: "LANE_ERROR"/);
});

test("WORKING status requires enabled lane with an active pending Work result", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /if \(!lane\.enabled\)/);
  assert.match(source, /if \(registryLane\.awaiting_work\)/);
  assert.match(source, /laneStatus\([\s\S]*?"WORKING"/);
});


test("new Work URLs are stored through canonical target normalization", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /const target = targetFromUrl\(page\.url\(\)\)/);
  assert.match(source, /return \`\$\{target\.origin\}\$\{target\.pathname\}\`/);
  assert.match(source, /internal \/c\/WEB:<uuid> route/);
});



test("v43 Owner Brain URL override is revisioned and can hot-swap during active Work", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /async function applyOwnerBrainTarget/);
  assert.match(source, /brain_url_revision/);
  assert.match(source, /applied_brain_url_revision/);
  assert.match(source, /LANE_OWNER_BRAIN_TARGET_CHANGED/);
  assert.match(source, /registryLane\.brain_request_sent = false/);
  assert.match(source, /registryLane\.brain_request_inflight = null/);
  assert.match(source, /registryLane\.relay_inflight = null/);
  assert.doesNotMatch(source, /Không đổi Bộ não khi Work đang chạy/);
  assert.match(source, /normalizeChatGptConversationUrl\(registryLane\.brain_url\)/);
});

test("v45 active Brain status comes from persisted registry target", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /brain_url: String\(registryLane\.brain_url \|\| configLane\.brain_url \|\| ""\)/);
  assert.match(source, /2026-09-20\.60/);
});

test("v43 valid completed Brain directive can complete a stuck first-handshake without duplicate Brain send", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /async function adoptExistingBrainDirective/);
  assert.match(source, /LANE_BRAIN_DIRECTIVE_ADOPTED_AS_HANDSHAKE/);
  assert.match(source, /directive = parseLaneDirective\(captured\.text\)/);
  assert.match(source, /registryLane\.brain_request_sent = true/);
  assert.match(source, /registryLane\.brain_request_inflight = null/);
  assert.match(source, /const existingDirective = await adoptExistingBrainDirective/);
  assert.match(source, /const directiveAfterReconcile = await adoptExistingBrainDirective/);
  assert.match(source, /const directiveAfterSend = await adoptExistingBrainDirective/);
  assert.match(source, /const directive = await ensureBrainRequest/);
  assert.match(source, /Đã nhận Brain directive; dispatch được tách sang bounded turn kế tiếp/);
});


test("Brain resume recovery is bounded and not durably consumed before the recovery scan completes", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /BRAIN_RESUME_OBSERVATION_TIMEOUT_MS = 15_000/);
  assert.match(source, /async function withBoundedObservation/);
  assert.match(source, /Brain resume safety probe/);
  assert.match(source, /Brain resume directive scan/);
  assert.match(source, /Brain post-resume probe/);
  assert.match(source, /error\.code = "ETIMEDOUT"/);
  assert.match(source, /async function finalizeBrainResumeRecovery/);

  const resyncStart = source.indexOf("async function resyncBrainAfterOwnerResume");
  const finalizeStart = source.indexOf("async function finalizeBrainResumeRecovery");
  const resyncOnly = source.slice(resyncStart, finalizeStart);
  assert.doesNotMatch(resyncOnly, /registryLane\.applied_resume_revision\s*=\s*(?!=)/);
  assert.doesNotMatch(resyncOnly, /registryLane\.brain_resume_recovery_version\s*=\s*1/);

  const resumedScan = source.indexOf("const resumedDirective = await adoptExistingBrainDirective");
  const finalizeAfterScan = source.indexOf("await finalizeBrainResumeRecovery", resumedScan);
  assert.ok(resumedScan >= 0 && finalizeAfterScan > resumedScan);
});

test("lane STOP then START reloads Brain once and adopts an already-visible unconsumed directive", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /async function resyncBrainAfterOwnerResume/);
  assert.match(source, /LANE_OWNER_RESUME_BRAIN_RESYNC_INTENT/);
  assert.match(source, /OWNER_LANE_RESUME_BRAIN_RESYNC/);
  assert.match(source, /brainPage\.reload/);
  assert.match(source, /async function finalizeBrainResumeRecovery/);
  assert.match(source, /registryLane\.applied_resume_revision = Number/);
  assert.match(source, /resumeResync\.revision \|\| 0/);
  assert.match(source, /registryLane\.brain_resume_recovery_version = 1/);
  assert.match(source, /needsMigrationRecovery/);
  assert.match(source, /allowResumeRecovery/);
  assert.match(source, /LANE_BRAIN_DIRECTIVE_RESUME_RECOVERY/);
  assert.match(source, /const resumedDirective = await adoptExistingBrainDirective/);
  assert.match(source, /allowResumeRecovery: Boolean\(resumeResync\.recoveryAuthority\)/);
  assert.match(source, /directive: resumedDirective/);
  assert.match(source, /Đã đồng bộ lại lệnh Brain/);
  assert.doesNotMatch(
    source.slice(
      source.indexOf("async function resyncBrainAfterOwnerResume"),
      source.indexOf("async function emitWorkTargetTransition")
    ),
    /last_brain_directive_digest\s*=\s*null/
  );
});

test("idle Owner resume rearms the Brain handshake when no directive is available", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /const ownerResume = revision > applied/);
  assert.match(source, /resumeHandshakeSafelyIdle/);
  assert.match(source, /Boolean\(resumeResync\.ownerResume\)/);
  assert.match(source, /registryLane\.brain_request_sent = false/);
  assert.match(source, /LANE_OWNER_RESUME_BRAIN_HANDSHAKE_REARMED/);
  assert.match(source, /idle_no_directive=1/);
  assert.match(source, /buildLegacyBrainStartRequestPreProjectReview/);

  const rearm = source.indexOf("LANE_OWNER_RESUME_BRAIN_HANDSHAKE_REARMED");
  const finalize = source.indexOf("await finalizeBrainResumeRecovery", rearm);
  const requestGate = source.indexOf("if (!registryLane.brain_request_sent)", finalize);
  assert.ok(rearm > -1 && finalize > rearm && requestGate > finalize);
});


test("v43 explicit Brain rebind clears only a blocked old-Brain dispatch when no Work result is pending", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /LANE_OWNER_BRAIN_REBASE_CANCELLED_BLOCKED_DISPATCH/);
  assert.match(source, /!registryLane\.awaiting_work/);
  assert.match(source, /registryLane\.dispatch_inflight\?\.reconcile_blocked/);
  assert.match(source, /registryLane\.dispatch_inflight = null/);
  assert.match(source, /registryLane\.task_id = null/);
  assert.match(source, /registryLane\.instruction_digest = null/);
});


test("Owner Work URL revision stages active target without clearing task or exact-once latches", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("async function applyOwnerWorkTarget");
  const end = source.indexOf("async function applyPendingWorkTargetAtSafeBoundary", start);
  const applyWork = source.slice(start, end);

  assert.match(applyWork, /acceptOwnerWorkTargetRevision/);
  assert.match(applyWork, /pending_work_url_revision/);
  assert.match(applyWork, /WORK_TARGET_SAVED/);
  assert.match(applyWork, /WORK_TARGET_PENDING/);
  assert.doesNotMatch(applyWork, /clearRelayInflight\(registryLane\)/);
  assert.doesNotMatch(applyWork, /registryLane\.task_id = null/);
  assert.doesNotMatch(applyWork, /registryLane\.dispatch_inflight = null/);
  assert.doesNotMatch(applyWork, /registryLane\.relay_inflight = null/);
  assert.doesNotMatch(applyWork, /registryLane\.awaiting_work = false/);
});

test("transient fetch and CDP failures recover instead of escalating to Owner", async () => {
  const runtime = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  const adapter = await fs.readFile(
    new URL("../src/ui/playwright-adapter.mjs", import.meta.url),
    "utf8"
  );

  assert.match(adapter, /fetch failed/);
  assert.match(adapter, /ECONNRESET/);
  assert.match(adapter, /ETIMEDOUT/);
  assert.match(runtime, /transient \? "RECOVERING" : "WAIT_OWNER"/);
  assert.match(runtime, /reconnectOverCdp/);
  assert.match(runtime, /Robot đang tự kết nối lại và sẽ thử tiếp/);
});


test("exhausted transient CDP recovery exits 75 so Windows wrapper relaunches Robot Chrome", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /cdpRecoveryFailures/);
  assert.match(source, /cdpRecoveryFailures >= 3/);
  assert.match(source, /RUNTIME_CDP_RESTART_REQUESTED/);
  assert.match(source, /process\.exitCode = 75/);
  assert.match(source, /bounded transient CDP reconnect budget exhausted/);
});


test("inaccessible Brain or Work conversations surface plain-language Owner guidance", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /function accessDeniedMessage/);
  assert.match(source, /Work này không mở được trong Chrome Robot/);
  assert.match(source, /Bộ não này không mở được trong Chrome Robot/);
  assert.match(source, /conversationAccessDenied/);
  assert.match(source, /TỰ TẠO WORK/);
});


test("v36 reloads each unconfirmed Work send at most once and then only observes", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /reconcile_reloaded/);
  assert.match(source, /const reload = !latch\.reconcile_reloaded/);
  assert.match(source, /LANE_WORK_SEND_RECONCILE_RELOAD/);
  assert.match(source, /LANE_WORK_SEND_RECONCILE_PENDING/);
  assert.match(source, /LANE_WORK_SEND_RECONCILE_PENDING/);
  assert.match(source, /return "PENDING"/);
  assert.match(source, /chỉ quan sát, không tải lại trang lặp lại/);
});

test("v36 waits for a stable ChatGPT surface before deciding send outcome", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /async function waitForStableSendSurface/);
  assert.match(source, /timeoutMs = 15_000/);
  assert.match(source, /composerReady/);
  assert.match(source, /responseRunning/);
  assert.match(source, /RESPONSE_COMPLETE/);
  assert.match(source, /if \(!observed\.stable \|\| !observed\.probe\) return "PENDING"/);
});

test("v44 keeps bounded exact-once semantics across Brain, Work and result relay", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /LANE_BRAIN_SEND_RECONCILE_RELOAD/);
  assert.match(source, /LANE_WORK_SEND_RECONCILE_RELOAD/);
  assert.match(source, /LANE_BRAIN_SEND_NOT_CONFIRMED_RETRY/);
  assert.match(source, /LANE_WORK_SEND_NOT_CONFIRMED_RETRY/);
  assert.match(source, /LANE_RESULT_RELAY_NOT_CONFIRMED_RETRY/);
  assert.match(source, /LANE_RESULT_RELAY_RECONCILE_CONFIRMED/);
  assert.match(source, /LANE_RESULT_RELAY_RECONCILE_PENDING/);
  assert.match(source, /classifyRelayMarkerState/);
  assert.doesNotMatch(source, /LANE_RESULT_RELAY_RECONCILE_RELOAD/);
  assert.doesNotMatch(source, /LANE_RESULT_RELAY_RECONCILE_BLOCKED/);
});

test("legacy v34-v35 latch can self-heal after one hard reload", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /Legacy v34\/v35 latches may lack a baseline/);
  assert.match(source, /return "NOT_CONFIRMED"/);
  assert.doesNotMatch(source, /Work chat đã thay đổi trong lúc xác minh lần gửi/);
});


test("v37 strips a UTF-8 BOM before parsing local JSON state", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /function parseJsonText/);
  assert.match(source, /replace\(\/\^\\uFEFF\//);
  assert.match(source, /parseJsonText\(await fs\.readFile\(filePath, "utf8"\)\)/);
});


test("v38 result relay uses relay_id marker rather than full DOM text digest for exact-once dedupe", async () => {
  const runtime = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  const capture = await fs.readFile(
    new URL("../src/ui/message-capture.mjs", import.meta.url),
    "utf8"
  );

  assert.match(runtime, /function relayMarker/);
  assert.match(runtime, /hasRelayMarker/);
  assert.match(runtime, /waitForRelayMarker/);
  assert.match(runtime, /LANE_RESULT_RELAY_DEDUPED_BY_MARKER/);
  assert.match(runtime, /relay_id=\$\{relayId\}/);
  assert.match(capture, /export async function captureUserTurnTexts/);
  assert.doesNotMatch(runtime, /const relayConfirmed = await waitForUserTurnDigest\(\s*brainPage,\s*sha256\(relay\.text\)/);
});


test("RBT-010 result relay keeps bounded send lifecycle without screenshot gates", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /LANE_RESULT_RELAY_NOT_EXECUTED/);
  assert.match(source, /LANE_RESULT_RELAY_SEND_CLICKED/);
  assert.match(source, /reconcile_runtime_version/);
  assert.doesNotMatch(source, /LANE_RESULT_SCREENSHOT_CAPTURED|screenshotStat|EVIDENCE_MISSING|screenshot_path/);
});

test("v43 can recover the latest valid directive when only duplicate Robot handshake turns follow it", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /captureRecentConversationTurns/);
  assert.match(source, /expectedStartDigests = new Set/);
  assert.match(source, /buildBrainStartRequest/);
  assert.match(source, /buildLegacyBrainStartRequestV59/);
  assert.match(source, /onlyRobotHandshakeAfterDirective/);
  assert.match(source, /turn\.role === "user" && expectedStartDigests\.has\(turn\.digest\)/);
  assert.match(source, /LANE_BRAIN_DIRECTIVE_RECOVERED_BEFORE_DUPLICATE_HANDSHAKE/);
  assert.match(source, /if \(laterTurns\.length && !onlyRobotHandshakeAfterDirective\) return null/);
});


test("Brain handshake uses a unique marker and safely rearms a blocked idle latch", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /randomUUID/);
  assert.match(source, /brain_request_id=/);
  assert.match(source, /marker,\s*\.\.\.baseline/s);
  assert.match(source, /waitForUserTurnMarker\(page, marker\)/);
  assert.match(source, /LANE_BRAIN_SEND_CONFIRMED_BY_MARKER/);
  assert.match(source, /LANE_BRAIN_BLOCKED_HANDSHAKE_REARMED/);
  assert.match(source, /!registryLane\.task_id/);
  assert.match(source, /!registryLane\.awaiting_work/);
  assert.match(source, /registryLane\.brain_request_inflight = null/);
});

test("v43 Work dispatch uses marker confirmation and repairs legacy blocked latches", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /buildWorkDispatchInstruction/);
  assert.match(source, /workDispatchMarker/);
  assert.match(source, /dispatch_id/);
  assert.match(source, /waitForUserTurnMarker/);
  assert.match(source, /marker: latch\.dispatch_id \? workDispatchMarker/);
  assert.match(source, /if \(marker\) return "NOT_CONFIRMED"/);
  assert.match(source, /LANE_WORK_LEGACY_BLOCKED_LATCH_REBASED/);
  assert.match(source, /LANE_WORK_LEGACY_BLOCKED_LATCH_CONFIRMED/);
  assert.match(source, /last_brain_directive_digest/);
  assert.match(source, /directive_instruction_digest/);
});

test("v43 a reconciled Work dispatch records the Brain directive digest to prevent redispatch", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /registryLane\.last_brain_directive_digest =\s*latch\.directive_digest/);
  assert.match(source, /registryLane\.instruction_digest =\s*latch\.directive_instruction_digest/);
});


test("RBT-003 same canonical Work revision is acknowledged without reset or generation churn", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  const state = await fs.readFile(
    new URL("../src/runtime/work-target-state.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /applyPendingWorkTargetAtSafeBoundary/);
  assert.match(source, /SAME_TARGET_NO_CHURN/);
  assert.match(state, /status: "ACKNOWLEDGED"/);
  assert.match(state, /sameAsCurrent/);
  assert.match(state, /clearPending\(lane\)/);
  assert.doesNotMatch(state, /task_id\s*=/);
  assert.doesNotMatch(state, /dispatch_inflight\s*=/);
  assert.doesNotMatch(state, /relay_inflight\s*=/);
  assert.doesNotMatch(state, /awaiting_work\s*=/);
});


test("v47 new Work persistence waits past transient WEB route", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /isPersistableConversationUrl/);
  assert.match(source, /waitForURL\([\s\S]*?isPersistableConversationUrl/);
  assert.doesNotMatch(source, /Store only the canonical target/);
});


test("v48 relay exhaustion is a stable Owner stop rather than an infinite retry loop", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /LANE_RESULT_RELAY_RETRY_EXHAUSTED/);
  assert.match(source, /RELAY HẾT LƯỢT THỬ/);
  assert.match(source, /relayRetryState/);
  assert.match(source, /retry_not_before/);
});


test("Owner resume consumes historical IDLE then requests a fresh project review", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  const resumedScan = source.indexOf("const resumedDirective = await adoptExistingBrainDirective");
  const requestGate = source.indexOf("if (!registryLane.brain_request_sent)", resumedScan);
  const resumePath = source.slice(resumedScan, requestGate);

  assert.match(resumePath, /resumedDirective\.action === "IDLE"/);
  assert.match(resumePath, /if \(resumeResync\.ownerResume\)/);
  assert.match(resumePath, /registryLane\.last_brain_directive_digest = resumedDirective\.digest/);
  assert.match(resumePath, /registryLane\.brain_request_sent = false/);
  assert.match(resumePath, /registryLane\.brain_request_inflight = null/);
  assert.match(resumePath, /LANE_OWNER_RESUME_BRAIN_FRESH_PROJECT_REVIEW/);
  assert.doesNotMatch(
    resumePath,
    /Đã đồng bộ lại Brain sau khi bật luồng; hiện chưa có công việc mới/
  );
});

test("Brain start request explicitly requires project reread and immediate Work assignment", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane.mjs", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("export function buildBrainStartRequest");
  const end = source.indexOf("export function buildWorkRolloverInstruction", start);
  const prompt = source.slice(start, end);

  assert.match(prompt, /Bạn hãy đọc lại dự án đang thực hiện và giao phần việc tiếp theo cho Work\./);
  assert.match(prompt, /phải giao ngay đúng một việc cho Work/);
  assert.match(prompt, /không chỉ tóm tắt, lập kế hoạch bằng prose hoặc chờ Owner nhắc lại/);
  assert.match(prompt, /Chỉ trả IDLE khi thực sự chưa có việc an toàn\/dependency-ready hoặc bắt buộc cần Owner/);
});

test("project source-of-truth updates from Brain plan, dispatch and ACCEPT lifecycle", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  const verdictStart = source.indexOf("async function applyBrainVerdictDirective");
  const verdictEnd = source.indexOf("async function hasRelayMarker", verdictStart);
  const verdictPath = source.slice(verdictStart, verdictEnd);
  assert.match(verdictPath, /applyProjectPlan/);
  assert.match(verdictPath, /directive\.project_plan/);
  assert.match(verdictPath, /markProjectTaskAccepted/);
  assert.match(verdictPath, /transition\.record\.verdict === "ACCEPT"/);

  const dispatchStart = source.indexOf("async function finalizeConfirmedDispatch");
  const dispatchEnd = source.indexOf("async function reconcileBrainRequest", dispatchStart);
  const dispatchPath = source.slice(dispatchStart, dispatchEnd);
  assert.match(dispatchPath, /markProjectTaskActive/);
  assert.match(dispatchPath, /registryLane\.project_progress/);
  assert.match(dispatchPath, /latch\.task_id/);
});

test("completed Work relays to Brain in the same scheduler turn", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  const completedStart = source.indexOf("if (completed.changed)");
  const relayStart = source.indexOf("await ensureBrainPage();", completedStart);
  const segment = source.slice(completedStart, relayStart + "await ensureBrainPage();".length);

  assert.match(segment, /LANE_WORK_COMPLETED_FAST_RELAY/);
  assert.match(segment, /continue_same_turn_to_brain_relay/);
  assert.doesNotMatch(segment, /return laneStatus/);
  assert.match(segment, /await ensureBrainPage\(\)/);
});

test("legacy or duplicate IDLE cannot freeze READY before project Source of Truth exists", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /MAX_PROJECT_PLAN_BOOTSTRAP_RETRIES = 3/);
  assert.match(source, /async function rearmMissingProjectPlanAfterIdle/);
  assert.match(source, /directive\?\.action !== "IDLE"/);
  assert.match(source, /registryLane\.project_progress\?\.plan_known/);
  assert.match(source, /LANE_PROJECT_PLAN_BOOTSTRAP_REARMED/);
  assert.match(source, /idle_without_project_plan/);
  assert.match(source, /LANE_PROJECT_PLAN_BOOTSTRAP_EXHAUSTED/);

  const duplicateStart = source.indexOf(
    "if (directive.digest === registryLane.last_brain_directive_digest)"
  );
  const duplicateEnd = source.indexOf(
    "await applyBrainVerdictDirective",
    duplicateStart
  );
  const duplicatePath = source.slice(duplicateStart, duplicateEnd);
  assert.match(duplicatePath, /rearmMissingProjectPlanAfterIdle/);
  assert.match(duplicatePath, /"WAITING_BRAIN"/);
  assert.match(duplicatePath, /IDLE cũ chưa có kế hoạch dự án/);

  const freshIdleStart = source.indexOf(
    'if (directive.action === "IDLE")',
    duplicateEnd
  );
  const freshIdleEnd = source.indexOf("await dispatchWork", freshIdleStart);
  const freshIdlePath = source.slice(freshIdleStart, freshIdleEnd);
  assert.match(freshIdlePath, /rearmMissingProjectPlanAfterIdle/);
  assert.match(freshIdlePath, /Brain trả IDLE nhưng chưa có project_plan/);
});

test("receiving a project_plan clears bootstrap retry debt", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("async function applyBrainVerdictDirective");
  const end = source.indexOf("async function rearmMissingProjectPlanAfterIdle", start);
  const segment = source.slice(start, end);

  assert.match(segment, /if \(directive\.project_plan\)/);
  assert.match(segment, /registryLane\.project_plan_bootstrap_retries = 0/);
});

test("incomplete project IDLE without a blocker is rechecked instead of freezing READY", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /MAX_BRAIN_IDLE_RECHECK_RETRIES = 3/);
  assert.match(source, /async function rearmIncompleteProjectIdle/);
  assert.match(source, /LANE_BRAIN_IDLE_CONTRACT_REARMED/);
  assert.match(source, /idle_without_blocking_reason/);
  assert.match(source, /project_complete_with_pending_tasks/);
  assert.match(source, /LANE_BRAIN_IDLE_CONTRACT_EXHAUSTED/);
  assert.match(source, /Project còn task chưa hoàn thành; Robot đang yêu cầu Brain giao WORK hoặc nêu blocker hợp lệ/);
  assert.match(source, /Brain liên tục trả IDLE không hợp lệ trong khi dự án còn task/);
});

test("explicit dependency or Owner blockers stop re-prompting cleanly", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("async function rearmIncompleteProjectIdle");
  const end = source.indexOf("async function hasRelayMarker", start);
  const segment = source.slice(start, end);

  assert.match(segment, /reason === "OWNER_REQUIRED"/);
  assert.match(segment, /reason === "DEPENDENCY_BLOCKED" \|\| reason === "NO_SAFE_WORK"/);
  assert.match(segment, /accepted_blocker: true/);
  assert.match(segment, /owner_required: true/);
});

test("Brain directive parse errors are observable instead of silently swallowed", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /LANE_BRAIN_DIRECTIVE_PARSE_ERROR/);
  assert.match(source, /captured\.digest/);
  assert.match(source, /captured\.chars/);
});

