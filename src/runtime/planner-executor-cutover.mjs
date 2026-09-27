import crypto from "node:crypto";

import { readLegacyPlannerExecutorCandidate } from "./planner-executor-legacy-migration.mjs";

function normalizedDigest(value) {
  const normalized = String(value || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function buildProductionPlannerBootstrap({
  projectName,
  sourceLaneId
} = {}) {
  const label = String(projectName || sourceLaneId || "project").trim();
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
  const bootstrapMessage = buildProductionPlannerBootstrap({
    projectName: state.project_name,
    sourceLaneId: migrated.source_lane_id
  });

  state.production_cutover = {
    schema_version: "planner-executor-production-cutover.v1",
    authorized: true,
    authorized_at: String(authorizedAt || "").trim() || null,
    source_revision: String(sourceRevision || "").trim() || null,
    source_lane_id: migrated.source_lane_id,
    cutover_started_at: null,
    cutover_completed_at: null,
    rollback_snapshot: null
  };
  state.cutover_bootstrap = {
    required: true,
    message: bootstrapMessage,
    message_digest: normalizedDigest(bootstrapMessage),
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
    cutover_ready: migrated.cutover_ready,
    blockers: migrated.blockers,
    state
  };
}
