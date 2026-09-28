import {
  bindPlannerExecutorBridgePages
} from "./chatgpt-bridge-binding.mjs";
import {
  createPlannerExecutorBridgeTransportStateMachine,
  BRIDGE_TRANSPORT_PHASES
} from "./planner-executor-bridge-transport.mjs";
import {
  createPlannerExecutorBridgeProtocolController
} from "./planner-executor-bridge-protocol.mjs";
import {
  buildExecutorAssignmentMessage,
  buildPlannerReviewMessage
} from "./planner-executor.mjs";

export class BridgeProjectBootstrapError extends Error {
  constructor(message, {
    code = "BRIDGE_PROJECT_BOOTSTRAP_ERROR",
    cause = null,
    details = null
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "BridgeProjectBootstrapError";
    this.code = code;
    this.details = details;
  }
}

function validateSourceUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch (error) {
    throw new BridgeProjectBootstrapError("Source of Truth URL is invalid", {
      code: "INVALID_SOURCE_OF_TRUTH_URL",
      cause: error
    });
  }
  if (url.protocol !== "https:") {
    throw new BridgeProjectBootstrapError(
      "Source of Truth URL must use HTTPS",
      { code: "INVALID_SOURCE_OF_TRUTH_URL" }
    );
  }
  url.hash = "";
  return url.toString();
}

function runtimeState(sourceOfTruthUrl, {
  projectId = "LIVE",
  projectGeneration = 1
} = {}) {
  return {
    project_id: String(projectId || "LIVE").trim(),
    project_generation: Number(projectGeneration) || 1,
    project_context: {
      source_of_truth_url: sourceOfTruthUrl,
      strict_correlation: true
    }
  };
}

export function classifyBridgeBootstrapSnapshot(snapshot, expectedMessageDigest, digestFn) {
  if (!snapshot || typeof snapshot !== "object") {
    return { state: "UNAVAILABLE" };
  }
  if (typeof digestFn !== "function") {
    throw new TypeError("digestFn is required");
  }

  const expected = String(expectedMessageDigest || "").trim();
  const turns = Array.isArray(snapshot.recent_turns)
    ? snapshot.recent_turns
    : Array.isArray(snapshot.recentTurns)
      ? snapshot.recentTurns
      : [];

  let matchingUserIndex = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i] || {};
    if (String(turn.role || "").trim() !== "user") continue;
    const text = String(turn.text || "");
    if (!text.trim()) continue;
    if (String(digestFn(text)) === expected) {
      matchingUserIndex = i;
      break;
    }
  }

  if (matchingUserIndex < 0) {
    return {
      state: "NO_MATCHING_USER_TURN",
      generating: Boolean(snapshot.is_generating ?? snapshot.isGenerating)
    };
  }

  for (let i = matchingUserIndex + 1; i < turns.length; i += 1) {
    const turn = turns[i] || {};
    if (
      String(turn.role || "").trim() === "assistant" &&
      String(turn.text || "").trim()
    ) {
      return {
        state: "CONFIRMED_RESPONSE",
        matching_user_index: matchingUserIndex,
        assistant_index: i,
        generating: Boolean(snapshot.is_generating ?? snapshot.isGenerating)
      };
    }
  }

  return {
    state: "MATCHING_USER_NO_RESPONSE",
    matching_user_index: matchingUserIndex,
    generating: Boolean(snapshot.is_generating ?? snapshot.isGenerating)
  };
}

export function buildBridgeProjectContextBootstrapMessage({
  sourceOfTruthUrl,
  projectId = "LIVE",
  projectGeneration = 1
} = {}) {
  const sourceUrl = validateSourceUrl(sourceOfTruthUrl);
  const state = runtimeState(sourceUrl, { projectId, projectGeneration });
  return [
    "MAGASIN_PROJECT_BOOTSTRAP_V1",
    "project_id=" + state.project_id,
    "project_generation=" + state.project_generation,
    "source_of_truth=" + sourceUrl,
    "",
    "Đây là LINK-ONLY LIVE SESSION. Không dùng project/profile/state cục bộ làm authority.",
    "Đọc Source of Truth ở link trên từ đầu trước khi lập kế hoạch. Source of Truth là authority duy nhất cho scope, trạng thái task và dependency.",
    "Xác định tổng số task và số task đã hoàn tất trực tiếp từ Source of Truth; pc/pt phải phản ánh đúng Source of Truth để Control Center cập nhật thanh tiến độ.",
    "QUY ƯỚC TRANSPORT: token <AT> bên dưới đại diện cho ký tự U+0040 (commercial at). Khi TRẢ LỜI, không được xuất chuỗi <AT>; hãy thay nó bằng đúng ký tự U+0040 ngay trước chữ M ở machine frame cuối cùng.",
    "Nếu còn việc: giao đúng MỘT task kế tiếp cho Executor và kết thúc bằng machine frame có p/g/pc/pt:",
    '<AT>M {"v":1,"a":"assign","p":"' + state.project_id +
      '","g":' + state.project_generation +
      ',"t":"TASK-ID","i":"NEW-ASSIGNMENT-ID","pc":COMPLETED,"pt":TOTAL}',
    "Nếu dự án đã hoàn tất và không có task đang chạy: kết thúc bằng:",
    '<AT>M {"v":1,"a":"done","p":"' + state.project_id +
      '","g":' + state.project_generation +
      ',"pc":TOTAL,"pt":TOTAL}'
  ].join("\n");
}

function executorMessageBuilder(state) {
  return ({ frame, body, kind }) => {
    const taskId = kind === "accept_assign" ? frame.n : frame.t;
    return buildExecutorAssignmentMessage({
      taskId,
      assignmentId: frame.i,
      body,
      state
    });
  };
}

function plannerMessageBuilder(state) {
  return ({ frame, body }) => buildPlannerReviewMessage({
    taskId: frame.t,
    assignmentId: frame.i,
    resultId: frame.r,
    body,
    state
  });
}

export async function startBridgeLinkOnlyProjectSession(adapter, {
  sourceOfTruthUrl,
  plannerUrl,
  executorUrl,
  projectId = "LIVE",
  projectGeneration = 1,
  requireExactPageSet = true
} = {}) {
  if (!adapter || typeof adapter.send !== "function") {
    throw new BridgeProjectBootstrapError("Bridge adapter with send() is required", {
      code: "INVALID_ADAPTER"
    });
  }

  const sourceUrl = validateSourceUrl(sourceOfTruthUrl);
  const state = runtimeState(sourceUrl, { projectId, projectGeneration });
  const binding = await bindPlannerExecutorBridgePages(adapter, {
    plannerUrl,
    executorUrl,
    requireExactPageSet
  });

  const transport = createPlannerExecutorBridgeTransportStateMachine({
    adapter,
    binding
  });
  transport.start();

  const message = buildBridgeProjectContextBootstrapMessage({
    sourceOfTruthUrl: sourceUrl,
    projectId: state.project_id,
    projectGeneration: state.project_generation
  });

  let bootstrapResult;
  try {
    bootstrapResult = await adapter.send(binding.planner.page_id, message);
  } catch (error) {
    throw new BridgeProjectBootstrapError(
      "Planner project bootstrap outcome is ambiguous; do not resend automatically",
      {
        code: "BOOTSTRAP_SEND_AMBIGUOUS",
        cause: error,
        details: {
          planner_page_id: binding.planner.page_id
        }
      }
    );
  }

  transport.plannerBootstrapDispatched();
  if (transport.snapshot().phase !== BRIDGE_TRANSPORT_PHASES.WAIT_PLANNER) {
    throw new BridgeProjectBootstrapError("Bridge transport did not enter WAIT_PLANNER", {
      code: "BOOTSTRAP_PHASE_MISMATCH"
    });
  }

  const protocol = createPlannerExecutorBridgeProtocolController({
    transport,
    projectId: state.project_id,
    projectGeneration: state.project_generation,
    strictProjectCorrelation: true,
    requirePlannerProgress: true,
    buildExecutorMessage: executorMessageBuilder(state),
    buildPlannerMessage: plannerMessageBuilder(state)
  });

  return {
    mode: "LINK_ONLY_EPHEMERAL",
    project_id: state.project_id,
    project_generation: state.project_generation,
    source_of_truth_url: sourceUrl,
    binding,
    transport,
    protocol,
    bootstrap_message: message,
    bootstrap_result: bootstrapResult
  };
}
