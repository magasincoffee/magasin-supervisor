import crypto from "node:crypto";
import { canonicalConversationPathname } from "./recovery.mjs";
import { defaultTaskTiming, normalizeTaskTiming } from "./lane-events.mjs";
import { normalizeWorkTargetMode } from "./work-target-state.mjs";
import {
  defaultWorkWatchdog,
  normalizeWorkWatchdog
} from "./work-watchdog.mjs";
import { normalizeWorkRollover } from "./work-rollover.mjs";
import {
  defaultTargetHealth,
  normalizeTargetHealth
} from "./target-health.mjs";
import {
  defaultProjectProgress,
  normalizeProjectProgress,
  parseProjectPlan
} from "./project-progress.mjs";

export const THREE_LANE_MODE = "THREE_LANE_V1";
export const LANE_DIRECTIVE_START = "<<<MAGASIN_LANE_DIRECTIVE_V1>>>";
export const LANE_DIRECTIVE_END = "<<<END_MAGASIN_LANE_DIRECTIVE_V1>>>";
export const LANE_IDS = Object.freeze(["lane-1", "lane-2", "lane-3"]);

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export function normalizeChatGptConversationUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let url = null;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid ChatGPT conversation URL");
  }
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "chatgpt.com" && !url.hostname.endsWith(".chatgpt.com")) ||
    !/^\/(c|g|project)\//.test(url.pathname)
  ) {
    throw new Error("Brain/Work URL must be a specific ChatGPT conversation");
  }
  return `${url.origin}${canonicalConversationPathname(url.pathname)}`;
}

const DIRECTIVE_TASK_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:\/-]{0,79}$/;
const DIRECTIVE_RELAY_ID_RE = /^[a-f0-9]{16,128}$/i;
const PREVIOUS_RESULT_REASON_CODES = new Set([
  "ACCEPT_DOD_MET",
  "ACCEPT_EVIDENCE_VERIFIED",
  "REJECT_DOD_NOT_MET",
  "REJECT_EVIDENCE_INCOMPLETE",
  "REJECT_CORRECTION_REQUIRED",
  "OWNER_INTERVENTION_REQUIRED"
]);
const IDLE_REASON_CODES = new Set([
  "PROJECT_COMPLETE",
  "NO_SAFE_WORK",
  "DEPENDENCY_BLOCKED",
  "OWNER_REQUIRED"
]);

function assertNarrowObject(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unsupported ${label} field: ${key}`);
  }
}

function parsePreviousResult(value) {
  if (value === undefined) return null;
  assertNarrowObject(
    value,
    new Set(["task_id", "relay_id", "verdict", "reason_code"]),
    "previous_result"
  );
  const taskId = String(value.task_id || "").trim();
  const relayId = String(value.relay_id || "").trim();
  const verdict = String(value.verdict || "").trim().toUpperCase();
  if (!DIRECTIVE_TASK_ID_RE.test(taskId)) throw new Error("invalid previous_result task_id");
  if (!DIRECTIVE_RELAY_ID_RE.test(relayId)) throw new Error("invalid previous_result relay_id");
  if (verdict !== "ACCEPT" && verdict !== "REJECT") {
    throw new Error("previous_result verdict must be ACCEPT or REJECT");
  }
  const reasonCode = value.reason_code === undefined
    ? null
    : String(value.reason_code || "").trim().toUpperCase();
  if (reasonCode && !PREVIOUS_RESULT_REASON_CODES.has(reasonCode)) {
    throw new Error("previous_result reason_code is not allowlisted");
  }
  return {
    task_id: taskId,
    relay_id: relayId,
    verdict,
    reason_code: reasonCode
  };
}

function parseIdleReason(value) {
  if (value === undefined || value === null) return null;
  const reason = String(value || "").trim().toUpperCase();
  if (!IDLE_REASON_CODES.has(reason)) {
    throw new Error("idle_reason is not allowlisted");
  }
  return reason;
}

function parseCorrectionOf(value) {
  if (value === undefined) return null;
  assertNarrowObject(value, new Set(["task_id", "relay_id"]), "correction_of");
  const taskId = String(value.task_id || "").trim();
  const relayId = String(value.relay_id || "").trim();
  if (!DIRECTIVE_TASK_ID_RE.test(taskId)) throw new Error("invalid correction_of task_id");
  if (!DIRECTIVE_RELAY_ID_RE.test(relayId)) throw new Error("invalid correction_of relay_id");
  return { task_id: taskId, relay_id: relayId };
}

export function parseLaneDirective(text) {
  const raw = String(text || "");
  const start = raw.lastIndexOf(LANE_DIRECTIVE_START);
  const end = raw.indexOf(LANE_DIRECTIVE_END, start + LANE_DIRECTIVE_START.length);
  if (start < 0 || end < 0) {
    throw new Error("Brain response missing MAGASIN_LANE_DIRECTIVE_V1 block");
  }

  const jsonText = raw.slice(start + LANE_DIRECTIVE_START.length, end).trim();
  const payload = JSON.parse(jsonText);
  const action = String(payload?.action || "").toUpperCase();

  if (action === "IDLE") {
    assertNarrowObject(
      payload,
      new Set(["action", "previous_result", "project_plan", "idle_reason"]),
      "directive"
    );
    const previousResult = parsePreviousResult(payload.previous_result);
    const projectPlan = parseProjectPlan(payload.project_plan);
    const idleReason = parseIdleReason(payload.idle_reason);
    const result = {
      schema_version: "lane-directive.v1",
      action: "IDLE",
      digest: sha256(jsonText)
    };
    if (previousResult) result.previous_result = previousResult;
    if (projectPlan) result.project_plan = projectPlan;
    if (idleReason) result.idle_reason = idleReason;
    return result;
  }
  if (action !== "WORK") throw new Error("unsupported lane directive action");
  assertNarrowObject(
    payload,
    new Set([
      "action",
      "task_id",
      "instruction",
      "previous_result",
      "correction_of",
      "project_plan"
    ]),
    "directive"
  );

  const taskId = String(payload.task_id || "").trim();
  const instruction = String(payload.instruction || "").trim();
  if (!DIRECTIVE_TASK_ID_RE.test(taskId)) {
    throw new Error("invalid lane task_id");
  }
  if (!instruction) throw new Error("lane WORK instruction is empty");

  const previousResult = parsePreviousResult(payload.previous_result);
  const correctionOf = parseCorrectionOf(payload.correction_of);
  const projectPlan = parseProjectPlan(payload.project_plan);
  if (correctionOf && !previousResult) {
    throw new Error("correction_of requires previous_result");
  }

  const result = {
    schema_version: "lane-directive.v1",
    action: "WORK",
    task_id: taskId,
    instruction,
    instruction_digest: sha256(instruction),
    digest: sha256(jsonText)
  };
  if (previousResult) result.previous_result = previousResult;
  if (correctionOf) result.correction_of = correctionOf;
  if (projectPlan) result.project_plan = projectPlan;
  return result;
}

export function defaultLaneConfig() {
  return {
    schema_version: "three-lane-config.v1",
    mode: THREE_LANE_MODE,
    lanes: LANE_IDS.map((laneId, index) => ({
      lane_id: laneId,
      project_name: `Dự án ${index + 1}`,
      brain_url: "",
      brain_url_revision: 0,
      work_url: "",
      work_url_revision: 0,
      work_url_saved_at: null,
      work_mode: "AUTO",
      work_state_reset_revision: 0,
      relay_retry_rearm_revision: 0,
      relay_retry_rearm_requested_at: null,
      resume_revision: 0,
      resume_requested_at: null,
      enabled: false
    }))
  };
}

export function normalizeLaneConfig(value = {}) {
  const defaults = defaultLaneConfig();
  const input = Array.isArray(value?.lanes) ? value.lanes : [];
  return {
    schema_version: defaults.schema_version,
    mode: THREE_LANE_MODE,
    lanes: LANE_IDS.map((laneId, index) => {
      const lane = input.find((item) => item?.lane_id === laneId) || {};
      return {
        lane_id: laneId,
        project_name: String(lane.project_name || `Dự án ${index + 1}`).slice(0, 120),
        brain_url: String(lane.brain_url || "").trim(),
        brain_url_revision: Number(
          lane.brain_url_revision ?? (String(lane.brain_url || "").trim() ? 1 : 0)
        ),
        work_url: String(lane.work_url || "").trim(),
        work_url_revision: Number(lane.work_url_revision || 0),
        work_url_saved_at: String(lane.work_url_saved_at || "").trim() || null,
        work_mode: normalizeWorkTargetMode(
          lane.work_mode,
          String(lane.work_url || "").trim()
        ),
        work_state_reset_revision: Number(lane.work_state_reset_revision || 0),
        relay_retry_rearm_revision: Number(lane.relay_retry_rearm_revision || 0),
        relay_retry_rearm_requested_at:
          String(lane.relay_retry_rearm_requested_at || "").trim() || null,
        resume_revision: Number(lane.resume_revision || 0),
        resume_requested_at:
          String(lane.resume_requested_at || "").trim() || null,
        enabled: Boolean(lane.enabled)
      };
    })
  };
}

function normalizeStoredConversationUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return normalizeChatGptConversationUrl(raw);
  } catch {
    return raw;
  }
}

export function defaultLaneRegistry() {
  return {
    schema_version: "three-lane-registry.v1",
    mode: THREE_LANE_MODE,
    lanes: Object.fromEntries(LANE_IDS.map((laneId) => [laneId, {
      lane_id: laneId,
      brain_url: "",
      applied_brain_url_revision: 0,
      work_url: "",
      work_generation: 0,
      applied_work_mode: "AUTO",
      applied_work_saved_at: null,
      pending_work_url: "",
      pending_work_url_revision: 0,
      pending_work_saved_at: null,
      pending_work_mode: null,
      applied_work_state_reset_revision: 0,
      task_id: null,
      instruction_digest: null,
      last_brain_directive_digest: null,
      last_work_result_digest: null,
      last_result_relay_id: null,
      last_result_verdict: null,
      last_dispatch_id: null,
      dispatch_inflight: null,
      relay_inflight: null,
      applied_relay_retry_rearm_revision: 0,
      applied_resume_revision: 0,
      brain_resume_recovery_version: 1,
      brain_request_inflight: null,
      brain_request_sent: false,
      project_plan_bootstrap_retries: 0,
      brain_idle_recheck_retries: 0,
      brain_soft_idle_reason: null,
      brain_soft_idle_digest: null,
      brain_soft_idle_recheck_count: 0,
      brain_soft_idle_recheck_not_before: null,
      awaiting_work: false,
      task_timing: defaultTaskTiming(),
      project_progress: defaultProjectProgress(),
      work_watchdog: defaultWorkWatchdog(),
      work_rollover: null,
      brain_target_health: defaultTargetHealth(),
      work_target_health: defaultTargetHealth(),
      applied_work_url_revision: 0
    }]))
  };
}

export function normalizeLaneRegistry(value = {}) {
  const safe = defaultLaneRegistry();
  for (const laneId of LANE_IDS) {
    const lane = value?.lanes?.[laneId] || {};
    safe.lanes[laneId] = {
      lane_id: laneId,
      brain_url: normalizeStoredConversationUrl(lane.brain_url),
      applied_brain_url_revision: Number(lane.applied_brain_url_revision || 0),
      work_url: normalizeStoredConversationUrl(lane.work_url),
      work_generation: Number(lane.work_generation || 0),
      applied_work_mode: normalizeWorkTargetMode(
        lane.applied_work_mode,
        lane.work_url
      ),
      applied_work_saved_at:
        String(lane.applied_work_saved_at || "").trim() || null,
      pending_work_url: normalizeStoredConversationUrl(lane.pending_work_url),
      pending_work_url_revision: Number(lane.pending_work_url_revision || 0),
      pending_work_saved_at:
        String(lane.pending_work_saved_at || "").trim() || null,
      pending_work_mode: Number(lane.pending_work_url_revision || 0) > 0
        ? normalizeWorkTargetMode(lane.pending_work_mode, lane.pending_work_url)
        : null,
      applied_work_state_reset_revision:
        Number(lane.applied_work_state_reset_revision || 0),
      task_id: lane.task_id || null,
      instruction_digest: lane.instruction_digest || null,
      last_brain_directive_digest: lane.last_brain_directive_digest || null,
      last_work_result_digest: lane.last_work_result_digest || null,
      last_result_relay_id: lane.last_result_relay_id || null,
      last_result_verdict: lane.last_result_verdict || null,
      last_dispatch_id: lane.last_dispatch_id || null,
      dispatch_inflight: lane.dispatch_inflight || null,
      relay_inflight: lane.relay_inflight || null,
      applied_relay_retry_rearm_revision:
        Number(lane.applied_relay_retry_rearm_revision || 0),
      applied_resume_revision:
        lane.applied_resume_revision === undefined
          ? -1
          : Number(lane.applied_resume_revision || 0),
      brain_resume_recovery_version:
        lane.brain_resume_recovery_version === undefined
          ? 0
          : Number(lane.brain_resume_recovery_version || 0),
      brain_request_inflight: lane.brain_request_inflight || null,
      brain_request_sent: Boolean(lane.brain_request_sent),
      project_plan_bootstrap_retries: Math.max(
        0,
        Number(lane.project_plan_bootstrap_retries || 0)
      ),
      brain_idle_recheck_retries: Math.max(
        0,
        Number(lane.brain_idle_recheck_retries || 0)
      ),
      brain_soft_idle_reason:
        String(lane.brain_soft_idle_reason || "").trim().toUpperCase() || null,
      brain_soft_idle_digest:
        String(lane.brain_soft_idle_digest || "").trim() || null,
      brain_soft_idle_recheck_count: Math.max(
        0,
        Number(lane.brain_soft_idle_recheck_count || 0)
      ),
      brain_soft_idle_recheck_not_before:
        String(lane.brain_soft_idle_recheck_not_before || "").trim() || null,
      awaiting_work: Boolean(lane.awaiting_work),
      task_timing: normalizeTaskTiming(lane.task_timing),
      project_progress: normalizeProjectProgress(lane.project_progress),
      work_watchdog: normalizeWorkWatchdog(lane.work_watchdog),
      work_rollover: normalizeWorkRollover(lane.work_rollover),
      brain_target_health: normalizeTargetHealth(lane.brain_target_health),
      work_target_health: normalizeTargetHealth(lane.work_target_health),
      applied_work_url_revision: Number(lane.applied_work_url_revision || 0)
    };
  }
  return safe;
}

export function buildLegacyBrainStartRequestV59({ laneId, projectName }) {
  return [
    `Bạn là BỘ NÃO của ${laneId} — ${projectName} trong MAGASIN Supervisor Three-Lane V1.`,
    "Robot chỉ làm việc theo lệnh trong cuộc trò chuyện Brain URL mà Owner đã chọn cho đúng luồng này.",
    "Hãy đọc ngữ cảnh cuộc trò chuyện hiện tại và giao đúng một việc tiếp theo cho Work chat bằng block máy đọc được:",
    LANE_DIRECTIVE_START,
    '{"action":"WORK","task_id":"TASK-ID","instruction":"Chỉ thị đầy đủ, tự đủ ngữ cảnh cho Work chat."}',
    LANE_DIRECTIVE_END,
    "Nếu chưa có việc an toàn để làm, trả:",
    LANE_DIRECTIVE_START,
    '{"action":"IDLE"}',
    LANE_DIRECTIVE_END,
    "Không yêu cầu Robot tự tìm Brain khác. Không yêu cầu Robot tự tạo Brain mới."
  ].join("\n");
}

export function buildLegacyBrainStartRequestPreProjectReview({ laneId, projectName }) {
  return [
    `Bạn là BỘ NÃO của ${laneId} — ${projectName} trong MAGASIN Supervisor Three-Lane V1.`,
    "Robot chỉ làm việc theo lệnh trong cuộc trò chuyện Brain URL mà Owner đã chọn cho đúng luồng này.",
    "Contract: PLAN → DISPATCH → VERIFY → ACCEPT/REJECT → NEXT PLAN. Không cần lộ chain-of-thought; chỉ trả contract/output máy đọc được.",
    "Trước WORK: chọn đúng một primary outcome, dependency đã thỏa hoặc nêu rõ, scope bounded, Definition of Done rõ, evidence phải trả rõ và stop boundary rõ trong instruction.",
    "Target planning: khoảng <=20 phút active implementation nếu chia được; nếu >30 phút và chia an toàn được thì chia nhỏ trước dispatch. Đây KHÔNG phải runtime timeout; long-running hợp lệ vẫn do watchdog activity contract xử lý.",
    "Work phải làm đúng một task rồi trả evidence/result và DỪNG; Work không tự chọn roadmap hoặc tự bắt đầu task tiếp theo.",
    "Hãy giao đúng một việc tiếp theo bằng block:",
    LANE_DIRECTIVE_START,
    '{"action":"WORK","task_id":"TASK-ID","instruction":"Một outcome; dependency; scope; DoD; evidence; safety/stop boundary."}',
    LANE_DIRECTIVE_END,
    "Sau khi Robot relay result, Brain nên VERIFY rồi thêm optional previous_result tương quan task_id + relay_id với verdict ACCEPT hoặc REJECT. REJECT chỉ được dispatch correction cùng task hoặc WORK có correction_of trỏ đúng previous result; nếu cần Owner thì dùng IDLE.",
    "Nếu chưa có việc an toàn để làm, trả:",
    LANE_DIRECTIVE_START,
    '{"action":"IDLE"}',
    LANE_DIRECTIVE_END,
    "Không yêu cầu Robot tự tìm Brain khác. Không yêu cầu Robot tự tạo Brain mới."
  ].join("\n");
}

export function buildBrainStartRequest({ laneId, projectName }) {
  return [
    `Bạn là BỘ NÃO của ${laneId} — ${projectName} trong MAGASIN Supervisor Three-Lane V1.`,
    "Robot chỉ làm việc theo lệnh trong cuộc trò chuyện Brain URL mà Owner đã chọn cho đúng luồng này.",
    "Bạn hãy đọc lại dự án đang thực hiện và giao phần việc tiếp theo cho Work.",
    "Trước khi chọn WORK hoặc IDLE, hãy rà soát trạng thái và tiến độ mới nhất của dự án trong ngữ cảnh Brain hiện tại, xác định phần việc còn thiếu và dependency của bước kế tiếp.",
    "Ở handshake này, bắt buộc kèm project_plan đầy đủ để Robot lưu Source of Truth tiến độ: tasks là toàn bộ task đã biết của dự án theo thứ tự kế hoạch; completed_task_ids là các task đã hoàn thành trước thời điểm handshake. Mỗi task phải có task_id ổn định và title ngắn.",
    'project_plan mẫu: {"tasks":[{"task_id":"TASK-1","title":"Outcome 1"},{"task_id":"TASK-2","title":"Outcome 2"}],"completed_task_ids":["TASK-1"]}',
    "Sau handshake, chỉ cần gửi lại project_plan khi kế hoạch thay đổi. Robot tự đánh dấu ACTIVE khi dispatch và DONE chỉ khi Brain ACCEPT kết quả.",
    "Contract: PLAN → DISPATCH → VERIFY → ACCEPT/REJECT → NEXT PLAN. Không cần lộ chain-of-thought; chỉ trả contract/output máy đọc được.",
    "Trước WORK: chọn đúng một primary outcome, dependency đã thỏa hoặc nêu rõ, scope bounded, Definition of Done rõ, evidence phải trả rõ và stop boundary rõ trong instruction.",
    "Target planning: khoảng <=20 phút active implementation nếu chia được; nếu >30 phút và chia an toàn được thì chia nhỏ trước dispatch. Đây KHÔNG phải runtime timeout; long-running hợp lệ vẫn do watchdog activity contract xử lý.",
    "Work phải làm đúng một task rồi trả evidence/result và DỪNG; Work không tự chọn roadmap hoặc tự bắt đầu task tiếp theo.",
    "Nếu có phần việc an toàn và dependency-ready tiếp theo, phải giao ngay đúng một việc cho Work bằng block; không chỉ tóm tắt, lập kế hoạch bằng prose hoặc chờ Owner nhắc lại.",
    "Hãy giao đúng một việc tiếp theo bằng block:",
    LANE_DIRECTIVE_START,
    '{"action":"WORK","task_id":"TASK-ID","instruction":"Một outcome; dependency; scope; DoD; evidence; safety/stop boundary.","project_plan":{"tasks":[{"task_id":"TASK-ID","title":"Tên task"}],"completed_task_ids":[]}}',
    LANE_DIRECTIVE_END,
    "Sau khi Robot relay result, Brain nên VERIFY rồi thêm optional previous_result tương quan task_id + relay_id với verdict ACCEPT hoặc REJECT. REJECT chỉ được dispatch correction cùng task hoặc WORK có correction_of trỏ đúng previous result; nếu cần Owner thì dùng IDLE.",
    "Chỉ trả IDLE khi thực sự không còn bất kỳ phần việc an toàn/dependency-ready nào trong toàn bộ project_plan hoặc bắt buộc cần Owner; không trả IDLE chỉ vì task kế tiếp theo thứ tự đang bị chặn.",
    "Trước khi trả DEPENDENCY_BLOCKED hoặc NO_SAFE_WORK, bắt buộc rà soát TOÀN BỘ task chưa hoàn thành và chọn một task khác nếu có bất kỳ task nào dependency-ready/an toàn.",
    "Nếu dependency chính là một task chưa DONE trong project_plan, phải giao task dependency đó (hoặc dependency-ready ancestor) cho Work thay vì IDLE. DEPENDENCY_BLOCKED chỉ hợp lệ cho blocker bên ngoài các task mà Brain có thể dispatch.",
    "Nếu project_plan vẫn còn task chưa hoàn thành mà trả IDLE, bắt buộc có idle_reason: DEPENDENCY_BLOCKED, NO_SAFE_WORK hoặc OWNER_REQUIRED. PROJECT_COMPLETE chỉ dùng khi mọi task trong plan đã hoàn thành.",
    "Robot sẽ tự recheck DEPENDENCY_BLOCKED/NO_SAFE_WORK: trước tiên recheck nhanh toàn-plan, sau đó backoff tự động nếu blocker vẫn còn; Owner không cần nhắc Brain tiếp tục.",
    "Nếu chưa có việc an toàn để làm, trả IDLE nhưng handshake đầu/resume vẫn phải kèm project_plan đầy đủ:",
    LANE_DIRECTIVE_START,
    '{"action":"IDLE","idle_reason":"DEPENDENCY_BLOCKED","project_plan":{"tasks":[{"task_id":"TASK-ID","title":"Tên task"}],"completed_task_ids":[]}}',
    LANE_DIRECTIVE_END,
    "Không yêu cầu Robot tự tìm Brain khác. Không yêu cầu Robot tự tạo Brain mới."
  ].join("\n");
}

export function buildWorkRolloverInstruction({ projectName, taskId, instruction }) {
  return [
    `Tiếp tục Work chat cho dự án ${projectName}.`,
    "Work chat trước đã được ChatGPT xác nhận đầy nên Robot tạo chat mới theo đúng guard.",
    `Task: ${taskId}`,
    "",
    instruction
  ].join("\n");
}

export function workDispatchMarker(dispatchId) {
  const id = String(dispatchId || "").trim();
  if (!id) throw new Error("dispatch_id is required");
  return `dispatch_id=${id}`;
}

export function buildWorkDispatchInstruction({
  taskId,
  dispatchId,
  instruction,
  planningContract = true
}) {
  const body = String(instruction || "").trim();
  if (!body) throw new Error("Work instruction is required");
  const header = [
    "MAGASIN_WORK_DISPATCH_V1",
    `task_id=${String(taskId || "").trim()}`,
    workDispatchMarker(dispatchId)
  ];
  if (!planningContract) {
    return [...header, "", body].join("\n");
  }
  return [
    ...header,
    "",
    "WORK_EXECUTION_CONTRACT_V1",
    "Chỉ thực hiện đúng task_id được giao trong envelope này.",
    "Không tự quyết định roadmap, không tự mở rộng sang task khác và không tự bắt đầu task tiếp theo.",
    "Hoàn tất đúng DoD/evidence trong instruction, trả result/evidence rồi DỪNG để Brain VERIFY/ACCEPT/REJECT.",
    "",
    body
  ].join("\n");
}

export function buildLaneResultRelay({
  laneId,
  projectName,
  taskId,
  generation,
  responseText
}) {
  const body = String(responseText || "");
  if (!body.trim()) throw new Error("work result is empty");
  const responseDigest = sha256(body);
  const relayId = sha256([
    laneId,
    taskId,
    generation,
    responseDigest
  ].join("|")).slice(0, 32);

  return {
    relay_id: relayId,
    response_digest: responseDigest,
    text: [
      `KẾT QUẢ WORK — ${laneId} — ${projectName}`,
      `task_id=${taskId}`,
      `relay_id=${relayId}`,
      "",
      "Ảnh đính kèm là ảnh chụp assistant turn cuối của Work chat.",
      "Toàn bộ text kết quả:",
      "",
      body,
      "",
      "VERIFY kết quả này theo DoD/evidence trước khi lập NEXT PLAN. RESULT_RELAY_CONFIRMED chỉ là transport fact, không tự động là ACCEPT.",
      `Nếu hỗ trợ planning contract, directive tiếp theo thêm previous_result={"task_id":"${taskId}","relay_id":"${relayId}","verdict":"ACCEPT|REJECT","reason_code":"ALLOWLISTED_CODE"}.`,
      "Sau ACCEPT có thể trả dependency-correct WORK hoặc IDLE. Sau REJECT chỉ trả correction cùng task_id, hoặc WORK có correction_of={task_id,relay_id} trỏ đúng result bị reject; nếu cần Owner thì IDLE. Nếu roadmap/task list thay đổi, kèm project_plan đầy đủ mới để cập nhật Source of Truth. Không gửi prose ngoài directive khi Robot polling."
    ].join("\n")
  };
}
