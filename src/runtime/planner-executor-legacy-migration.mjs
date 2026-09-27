import fs from "node:fs/promises";
import path from "node:path";

import {
  THREE_LANE_MODE,
  normalizeChatGptConversationUrl
} from "./three-lane.mjs";
import { defaultPlannerExecutorState } from "./planner-executor.mjs";

const LEGACY_CONFIG_SCHEMA = "three-lane-config.v1";
const LEGACY_REGISTRY_SCHEMA = "three-lane-registry.v1";
const LANE_IDS = new Set(["lane-1", "lane-2", "lane-3"]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function assertRevision(value, label) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return revision;
}

function assertLaneId(value) {
  const laneId = String(value || "").trim();
  if (!LANE_IDS.has(laneId)) {
    throw new TypeError(
      "laneId must be explicitly set to lane-1, lane-2, or lane-3"
    );
  }
  return laneId;
}

function parseJson(text, label) {
  try {
    return JSON.parse(String(text || "").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new TypeError(`${label} is malformed JSON: ${error.message}`);
  }
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function normalizeLegacyTarget(value, label) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return normalizeChatGptConversationUrl(raw);
  } catch (error) {
    throw new TypeError(`${label} is not a valid ChatGPT conversation target`);
  }
}

function uniqueStrings(values) {
  return [...new Set(
    values
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
}

export function parseLegacyPlannerExecutorSource({
  configText,
  registryText,
  laneId
} = {}) {
  const selectedLaneId = assertLaneId(laneId);
  const config = assertPlainObject(
    parseJson(configText, "legacy lanes.json"),
    "legacy lanes.json"
  );
  const registry = assertPlainObject(
    parseJson(registryText, "legacy lane-registry.json"),
    "legacy lane-registry.json"
  );

  if (
    config.schema_version !== LEGACY_CONFIG_SCHEMA ||
    config.mode !== THREE_LANE_MODE
  ) {
    throw new TypeError("unsupported legacy lanes.json schema/mode");
  }
  if (
    registry.schema_version !== LEGACY_REGISTRY_SCHEMA ||
    registry.mode !== THREE_LANE_MODE
  ) {
    throw new TypeError("unsupported legacy lane-registry.json schema/mode");
  }
  if (!Array.isArray(config.lanes)) {
    throw new TypeError("legacy lanes.json lanes must be an array");
  }

  const configMatches = config.lanes.filter(
    (lane) => lane?.lane_id === selectedLaneId
  );
  if (configMatches.length !== 1) {
    throw new TypeError(
      `selected ${selectedLaneId} is absent or ambiguous in lanes.json`
    );
  }

  const configLane = assertPlainObject(
    configMatches[0],
    `legacy config ${selectedLaneId}`
  );
  const registryLane = assertPlainObject(
    registry?.lanes?.[selectedLaneId],
    `legacy registry ${selectedLaneId}`
  );
  if (registryLane.lane_id !== selectedLaneId) {
    throw new TypeError("legacy registry lane_id conflicts with selected lane");
  }

  return {
    laneId: selectedLaneId,
    configLane,
    registryLane
  };
}

function resolveActiveTargets(configLane, registryLane) {
  const configuredPlannerRevision = assertRevision(
    configLane.brain_url_revision || 0,
    "legacy planner configured revision"
  );
  const appliedPlannerRevision = assertRevision(
    registryLane.applied_brain_url_revision || 0,
    "legacy planner applied revision"
  );
  if (appliedPlannerRevision > configuredPlannerRevision) {
    throw new TypeError(
      "legacy applied Planner revision exceeds configured revision"
    );
  }

  const configuredExecutorRevision = assertRevision(
    configLane.work_url_revision || 0,
    "legacy executor configured revision"
  );
  const appliedExecutorRevision = assertRevision(
    registryLane.applied_work_url_revision || 0,
    "legacy executor applied revision"
  );
  if (appliedExecutorRevision > configuredExecutorRevision) {
    throw new TypeError(
      "legacy applied Executor revision exceeds configured revision"
    );
  }

  const configuredPlanner = normalizeLegacyTarget(
    configLane.brain_url,
    "legacy configured Planner target"
  );
  const appliedPlanner = normalizeLegacyTarget(
    registryLane.brain_url,
    "legacy applied Planner target"
  );
  const configuredExecutor = normalizeLegacyTarget(
    configLane.work_url,
    "legacy configured Executor target"
  );
  const appliedExecutor = normalizeLegacyTarget(
    registryLane.work_url,
    "legacy applied Executor target"
  );

  if (
    appliedPlannerRevision === configuredPlannerRevision &&
    appliedPlanner &&
    configuredPlanner &&
    appliedPlanner !== configuredPlanner
  ) {
    throw new TypeError(
      "legacy Planner target identity conflicts at the same revision"
    );
  }

  if (
    appliedExecutorRevision === configuredExecutorRevision &&
    appliedExecutor &&
    configuredExecutor &&
    appliedExecutor !== configuredExecutor
  ) {
    throw new TypeError(
      "legacy Executor target identity conflicts at the same revision"
    );
  }

  return {
    planner: {
      activeTarget: appliedPlanner || configuredPlanner,
      activeRevision: appliedPlanner
        ? appliedPlannerRevision
        : configuredPlannerRevision,
      requestedTarget: configuredPlanner,
      requestedRevision: configuredPlannerRevision
    },
    executor: {
      activeTarget: appliedExecutor || configuredExecutor,
      activeRevision: appliedExecutor
        ? appliedExecutorRevision
        : configuredExecutorRevision,
      requestedTarget: configuredExecutor,
      requestedRevision: configuredExecutorRevision
    }
  };
}

function buildCutoverBlockers({
  targets,
  configLane,
  registryLane,
  ownerStop
}) {
  const blockers = [];

  if (!targets.planner.activeTarget) blockers.push("MISSING_PLANNER_TARGET");
  if (!targets.executor.activeTarget) blockers.push("MISSING_EXECUTOR_TARGET");

  if (
    targets.planner.requestedRevision >
    targets.planner.activeRevision
  ) {
    blockers.push("PENDING_PLANNER_TARGET_REVISION");
  }

  const pendingWorkRevision = assertRevision(
    registryLane.pending_work_url_revision || 0,
    "legacy pending Executor revision"
  );
  if (
    pendingWorkRevision > 0 ||
    targets.executor.requestedRevision >
    targets.executor.activeRevision
  ) {
    blockers.push("PENDING_EXECUTOR_TARGET_REVISION");
  }

  if (registryLane.task_id) blockers.push("ACTIVE_LEGACY_TASK");
  if (registryLane.awaiting_work) blockers.push("LEGACY_AWAITING_EXECUTOR");
  if (registryLane.dispatch_inflight) blockers.push("LEGACY_ASSIGNMENT_INFLIGHT");
  if (registryLane.relay_inflight) blockers.push("LEGACY_RESULT_RELAY_INFLIGHT");
  if (registryLane.brain_request_inflight) {
    blockers.push("LEGACY_PLANNER_REQUEST_INFLIGHT");
  }
  if (registryLane.brain_request_sent) {
    blockers.push("LEGACY_PLANNER_REQUEST_SENT_UNCONSUMED");
  }
  if (ownerStop.blocked) blockers.push("OWNER_STOP");

  return [...new Set(blockers)];
}

export function migrateLegacyLaneToPlannerExecutor({
  legacyConfig,
  legacyRegistry,
  laneId,
  ownerStop = {}
} = {}) {
  const selectedLaneId = assertLaneId(laneId);
  const source = parseLegacyPlannerExecutorSource({
    configText: JSON.stringify(legacyConfig),
    registryText: JSON.stringify(legacyRegistry),
    laneId: selectedLaneId
  });
  const { configLane, registryLane } = source;
  const targets = resolveActiveTargets(configLane, registryLane);

  const projectId = String(
    configLane.project_name || selectedLaneId
  ).trim() || selectedLaneId;

  // Project names may contain spaces and are display labels, while project_id
  // has a narrow machine identity grammar. Preserve the label separately and
  // use the explicit selected lane as the migration-safe machine project ID.
  const state = defaultPlannerExecutorState({
    projectId: selectedLaneId,
    plannerTarget: targets.planner.activeTarget,
    executorTarget: targets.executor.activeTarget
  });
  state.project_name = projectId;
  state.planner.target_revision = targets.planner.activeRevision;
  state.executor.target_revision = targets.executor.activeRevision;
  state.active_task_id = registryLane.task_id || null;

  const assignmentIds = uniqueStrings([
    registryLane.last_dispatch_id,
    registryLane.dispatch_inflight?.dispatch_id,
    registryLane.last_result_verdict?.dispatch_id
  ]);
  const resultIds = uniqueStrings([
    registryLane.last_result_relay_id,
    registryLane.relay_inflight?.relay_id,
    registryLane.last_result_verdict?.relay_id
  ]);
  state.identity_history = {
    assignment_ids: assignmentIds.slice(-128),
    result_ids: resultIds.slice(-128)
  };

  const stopPresent = Boolean(ownerStop.stop_present);
  const autostartDisabledPresent = Boolean(
    ownerStop.autostart_disabled_present
  );
  state.owner_stop = {
    stop_present: stopPresent,
    autostart_disabled_present: autostartDisabledPresent,
    blocked: stopPresent || autostartDisabledPresent
  };

  state.legacy_migration = {
    schema_version: "planner-executor-legacy-migration.v1",
    source_mode: THREE_LANE_MODE,
    source_lane_id: selectedLaneId,
    planner_requested_target: targets.planner.requestedTarget,
    planner_requested_revision: targets.planner.requestedRevision,
    executor_requested_target: targets.executor.requestedTarget,
    executor_requested_revision: targets.executor.requestedRevision,
    pending_executor_target: normalizeLegacyTarget(
      registryLane.pending_work_url,
      "legacy pending Executor target"
    ),
    pending_executor_revision: assertRevision(
      registryLane.pending_work_url_revision || 0,
      "legacy pending Executor revision"
    ),
    executor_generation: assertRevision(
      registryLane.work_generation || 0,
      "legacy Executor generation"
    ),
    instruction_digest: registryLane.instruction_digest || null,
    last_planner_directive_digest:
      registryLane.last_brain_directive_digest || null,
    last_executor_result_digest:
      registryLane.last_work_result_digest || null,
    last_result_verdict: cloneJson(
      registryLane.last_result_verdict || null
    ),
    assignment_inflight: cloneJson(
      registryLane.dispatch_inflight || null
    ),
    result_relay_inflight: cloneJson(
      registryLane.relay_inflight || null
    ),
    planner_request_inflight: cloneJson(
      registryLane.brain_request_inflight || null
    ),
    planner_request_sent: Boolean(registryLane.brain_request_sent),
    awaiting_executor: Boolean(registryLane.awaiting_work),
    project_progress: cloneJson(
      registryLane.project_progress || null
    ),
    task_timing: cloneJson(
      registryLane.task_timing || null
    )
  };

  const blockers = buildCutoverBlockers({
    targets,
    configLane,
    registryLane,
    ownerStop: state.owner_stop
  });

  return {
    schema_version: "planner-executor-migration-candidate.v1",
    source_lane_id: selectedLaneId,
    state,
    cutover_ready: blockers.length === 0,
    blockers
  };
}

export function migrateLegacyPlannerExecutorJson({
  configText,
  registryText,
  laneId,
  ownerStop = {}
} = {}) {
  const parsed = parseLegacyPlannerExecutorSource({
    configText,
    registryText,
    laneId
  });

  return migrateLegacyLaneToPlannerExecutor({
    legacyConfig: {
      schema_version: LEGACY_CONFIG_SCHEMA,
      mode: THREE_LANE_MODE,
      lanes: [cloneJson(parsed.configLane)]
    },
    legacyRegistry: {
      schema_version: LEGACY_REGISTRY_SCHEMA,
      mode: THREE_LANE_MODE,
      lanes: {
        [parsed.laneId]: cloneJson(parsed.registryLane)
      }
    },
    laneId: parsed.laneId,
    ownerStop
  });
}

async function fileExists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

export async function readLegacyPlannerExecutorCandidate({
  root,
  laneId
} = {}) {
  const selectedLaneId = assertLaneId(laneId);
  const stateRoot = String(root || "").trim();
  if (!stateRoot) {
    throw new TypeError("legacy state root is required");
  }

  const configPath = path.join(stateRoot, "lanes.json");
  const registryPath = path.join(stateRoot, "lane-registry.json");
  const [configText, registryText, stopPresent, autostartDisabledPresent] =
    await Promise.all([
      fs.readFile(configPath, "utf8"),
      fs.readFile(registryPath, "utf8"),
      fileExists(path.join(stateRoot, "STOP")),
      fileExists(path.join(stateRoot, "AUTOSTART_DISABLED"))
    ]);

  return migrateLegacyPlannerExecutorJson({
    configText,
    registryText,
    laneId: selectedLaneId,
    ownerStop: {
      stop_present: stopPresent,
      autostart_disabled_present: autostartDisabledPresent
    }
  });
}
