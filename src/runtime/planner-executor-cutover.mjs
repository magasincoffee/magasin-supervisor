import { composerInstructionDigest } from "../ui/actions.mjs";
import { readLegacyPlannerExecutorCandidate } from "./planner-executor-legacy-migration.mjs";

function sameBlockers(actual, expected) {
  const left = [...new Set((actual || []).map(String))].sort();
  const right = [...new Set((expected || []).map(String))].sort();
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function currentLegacyReviewBoundary(migrated) {
  if (!migrated?.state) return null;
  const state = migrated.state;
  const legacy = state.legacy_migration || {};
  if (!sameBlockers(migrated.blockers, [
    "ACTIVE_LEGACY_TASK",
    "LEGACY_PLANNER_REQUEST_SENT_UNCONSUMED"
  ])) {
    return null;
  }

  if (
    !state.active_task_id ||
    legacy.awaiting_executor ||
    legacy.assignment_inflight ||
    legacy.result_relay_inflight ||
    legacy.planner_request_inflight ||
    !legacy.planner_request_sent ||
    !legacy.last_executor_result_digest
  ) {
    return null;
  }

  const assignmentIds = Array.isArray(state.identity_history?.assignment_ids)
    ? state.identity_history.assignment_ids
    : [];
  const resultIds = Array.isArray(state.identity_history?.result_ids)
    ? state.identity_history.result_ids
    : [];
  const assignmentId = String(assignmentIds.at(-1) || "").trim();
  const resultId = String(resultIds.at(-1) || "").trim();
  if (!assignmentId || !resultId) return null;

  const verdict = legacy.last_result_verdict || null;
  if (
    verdict &&
    String(verdict.task_id || "") === String(state.active_task_id) &&
    String(verdict.relay_id || "") === resultId
  ) {
    return null;
  }

  return {
    task_id: String(state.active_task_id),
    assignment_id: assignmentId,
    result_id: resultId
  };
}

function adoptLegacyReviewBoundary(state, boundary, at) {
  state.active_task_id = boundary.task_id;
  state.assignment = {
    task_id: boundary.task_id,
    assignment_id: boundary.assignment_id,
    source_turn_id: null,
    planner_body: "legacy-cutover-review-boundary",
    message: "",
    message_digest: null,
    persisted_at: at,
    send_attempted_at: at,
    send_confirmed_at: at,
    send_evidence: "legacy-result-proves-assignment",
    blocked_reason: null
  };
  state.result = {
    task_id: boundary.task_id,
    assignment_id: boundary.assignment_id,
    result_id: boundary.result_id,
    status: "legacy_relayed",
    source_turn_id: null,
    executor_body: "",
    message: "",
    message_digest: null,
    persisted_at: at,
    send_attempted_at: at,
    send_confirmed_at: at,
    relay_confirmed_at: at,
    send_evidence: "legacy-result-relay-confirmed",
    blocked_reason: null
  };
  state.decision = null;
  state.legacy_migration.review_boundary_adopted = true;
  state.legacy_migration.review_boundary = {
    schema_version: "legacy-review-boundary.v1",
    task_id: boundary.task_id,
    assignment_id: boundary.assignment_id,
    result_id: boundary.result_id,
    adopted_at: at
  };
}

export function buildProductionPlannerBootstrap({
  projectName,
  sourceLaneId,
  reviewBoundary = null
} = {}) {
  const label = String(projectName || sourceLaneId || "project").trim();

  if (reviewBoundary) {
    return [
      "MAGASIN PLANNER/EXECUTOR V1 PRODUCTION REVIEW HANDOFF",
      "",
      "Bạn là Planner trong kiến trúc MAGASIN Supervisor Planner/Executor V1.",
      `Dự án hiện tại: ${label}.`,
      "Supervisor legacy đã relay kết quả Executor vào chính cuộc trò chuyện Planner này nhưng chưa consume verdict trước cutover.",
      `Task đang chờ review: ${reviewBoundary.task_id}; result_id=${reviewBoundary.result_id}.`,
      "Không gửi lại result, không giao lại task cũ và không dùng ChatGPT Work mode.",
      "Hãy đọc result/evidence ngay trước handoff trong ngữ cảnh chat rồi quyết định:",
      "Nếu ACCEPT và còn task kế tiếp: viết body assignment mới không rỗng rồi kết thúc bằng:",
      `@M {"v":1,"a":"accept_assign","t":"${reviewBoundary.task_id}","r":"${reviewBoundary.result_id}","n":"NEXT-TASK-ID","i":"NEW-ASSIGNMENT-ID"}`,
      "Nếu REJECT và có correction bounded: viết body correction không rỗng rồi kết thúc bằng:",
      `@M {"v":1,"a":"reject","t":"${reviewBoundary.task_id}","r":"${reviewBoundary.result_id}","i":"NEW-CORRECTION-ASSIGNMENT-ID"}`,
      "Nếu dự án hoàn tất, kết thúc bằng:",
      `@M {"v":1,"a":"done","t":"${reviewBoundary.task_id}","r":"${reviewBoundary.result_id}"}`,
      "Nếu cần Owner/dependency ngoài Executor, kết thúc bằng:",
      `@M {"v":1,"a":"blocked","t":"${reviewBoundary.task_id}","r":"${reviewBoundary.result_id}"}`,
      "Chỉ dùng đúng một machine frame @M ở dòng cuối."
    ].join("\n");
  }

  return [
    "MAGASIN PLANNER/EXECUTOR V1 PRODUCTION BOOTSTRAP",
    "",
    "Bạn là Planner trong kiến trúc MAGASIN Supervisor Planner/Executor V1.",
    `Dự án hiện tại: ${label}.`,
    "Đây là cuộc trò chuyện Planner hiện hữu; hãy dùng ngữ cảnh dự án đã có trong chat này.",
    "Rà soát trạng thái mới nhất, dependency và phần việc còn thiếu, rồi giao đúng MỘT task tiếp theo cho Executor.",
    "Không dùng ChatGPT Work mode. Không tự thực thi task thay Executor.",
    "Nội dung assignment phải đủ để Executor thực hiện độc lập và báo cáo evidence.",
    "Phản hồi ngắn gọn; dòng cuối bắt buộc là machine frame:",
    '@M {"v":1,"a":"assign","t":"TASK-ID","i":"ASSIGNMENT-ID"}'
  ].join("\n");
}

export async function preparePlannerExecutorProductionCutover({
  root,
  laneId,
  authorizedAt,
  sourceRevision
} = {}) {
  const migrated = await readLegacyPlannerExecutorCandidate({
    root,
    laneId
  });

  const state = structuredClone(migrated.state);
  const adoptedAt = new Date().toISOString();
  const reviewBoundary = currentLegacyReviewBoundary(migrated);
  if (reviewBoundary) {
    adoptLegacyReviewBoundary(state, reviewBoundary, adoptedAt);
  }

  const bootstrapMessage = buildProductionPlannerBootstrap({
    projectName: state.project_name,
    sourceLaneId: migrated.source_lane_id,
    reviewBoundary
  });

  state.production_cutover = {
    schema_version: "planner-executor-production-cutover.v1",
    authorized: true,
    authorized_at: String(authorizedAt || "").trim() || null,
    source_revision: String(sourceRevision || "").trim() || null,
    source_lane_id: migrated.source_lane_id,
    handoff_mode: reviewBoundary ? "LEGACY_RESULT_REVIEW" : "IDLE",
    cutover_started_at: null,
    cutover_completed_at: null,
    rollback_snapshot: null
  };
  state.cutover_bootstrap = {
    required: true,
    message: bootstrapMessage,
    message_digest: composerInstructionDigest(bootstrapMessage),
    baseline_assistant_turn_id: null,
    baseline_user_turn_id: null,
    baseline_captured_at: null,
    send_attempted_at: null,
    send_confirmed_at: null,
    send_evidence: null,
    completed_at: null,
    last_send_error: null
  };

  return {
    schema_version: "planner-executor-production-cutover-candidate.v1",
    source_lane_id: migrated.source_lane_id,
    cutover_ready: Boolean(migrated.cutover_ready || reviewBoundary),
    blockers: reviewBoundary ? [] : migrated.blockers,
    resolved_blockers: reviewBoundary ? migrated.blockers : [],
    handoff_mode: reviewBoundary ? "LEGACY_RESULT_REVIEW" : "IDLE",
    state
  };
}
