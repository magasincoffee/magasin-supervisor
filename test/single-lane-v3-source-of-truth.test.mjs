import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CANONICAL_MD = "docs/SUPERVISOR_SINGLE_LANE_CHATGPT_FIRST_V3_SOURCE_OF_TRUTH.md";
const CANONICAL_JSON = "docs/SUPERVISOR_SINGLE_LANE_CHATGPT_FIRST_V3_SOURCE_OF_TRUTH.json";
const CANONICAL_FILES = [CANONICAL_MD, CANONICAL_JSON];

const REMOVED_SOURCES = [
  "docs/THREE_LANE_V1_ARCHITECTURE.md",
  "docs/ROBOT_BROWSER_SCHEDULER_OBSERVABILITY_ARCHITECTURE.md",
  "docs/RBT_010_TEXT_ONLY_RELAY_PLAN.md",
  "docs/RBT_010_TEXT_ONLY_RELAY_AUTHORITY.json",
  "docs/SUPERVISOR_RUNTIME_V2_SELF_UPGRADE_PLAN.md",
  "docs/SUPERVISOR_RUNTIME_V2_SELF_UPGRADE_PLAN.json"
];

const TOMBSTONES = [
  {
    path: "docs/ROBOT_LIFECYCLE_TRUTH_ARCHITECTURE.md",
    status: /Status:\s*\*\*SUPERSEDED \/ NON-CANONICAL\*\*/i,
    disclaimer: /no longer authority/i
  },
  {
    path: "docs/MIG_007_FINAL_CLEANUP_PLAN.md",
    status: /Status:\s*\*\*HISTORICAL \/ NON-CANONICAL\*\*/i,
    disclaimer: /not current planning authority/i
  }
];

const EXPECTED_INVARIANTS = [
  "OWNER_STOP_AUTOSTART_DISABLED_PRECEDENCE",
  "ONE_BOUNDED_TASK_BRAIN_CONTRACT",
  "DETERMINISTIC_EXACT_ONCE_DISPATCH_RELAY_IDENTITY",
  "TEXT_ONLY_RESULT_RELAY",
  "DURABLE_INTENT_BEFORE_REPLAY_SENSITIVE_EFFECT",
  "EXACT_TARGET_IDENTITY_BOUNDED_RECOVERY_NO_RELOAD_STORM",
  "AUTH_MFA_CAPTCHA_SECURITY_FAIL_CLOSED",
  "PRIVACY_NO_SECRETS_PRIVATE_URLS_CHAT_BODIES_IN_GIT",
  "PROCESS_TRUTH_OUTRANKS_PERSISTED_RECOVERY",
  "OWNER_EXPLICIT_MERGE_DEPLOY"
];

const EXPECTED_TASK_IDS = [
  "SL3-P0-A1","SL3-P0-A2","SL3-P0-A3","SL3-P0-A4",
  "SL3-P1-A1","SL3-P1-A2","SL3-P1-A3","SL3-P1-A4","SL3-P1-A5",
  "SL3-P1-A6","SL3-P1-A7","SL3-P1-A8","SL3-P1-A9","SL3-P1-A10",
  "SL3-P2-A1","SL3-P2-A2","SL3-P2-A3","SL3-P2-A4","SL3-P2-A5",
  "SL3-P2-A6","SL3-P2-A7","SL3-P2-A8","SL3-P2-A9","SL3-P2-A10",
  "SL3-P2-A11","SL3-P2-A12",
  "SL3-P3-A1","SL3-P3-A2","SL3-P3-A3","SL3-P3-A4","SL3-P3-A5",
  "SL3-P3-A6","SL3-P3-A7","SL3-P3-A8",
  "SL3-P4-A1","SL3-P4-A2","SL3-P4-A3","SL3-P4-A4","SL3-P4-A5","SL3-P4-A6",
  "SL3-P5-A1","SL3-P5-A2","SL3-P5-A3","SL3-P5-A4","SL3-P5-A5",
  "SL3-P6-A1","SL3-P6-A2","SL3-P6-A3","SL3-P6-A4","SL3-P6-A5","SL3-P6-A6",
  "SL3-P7-A1","SL3-P7-A2","SL3-P7-A3","SL3-P7-A4","SL3-P7-A5","SL3-P7-A6"
];

const EXPECTED_ROLLBACK_ENTRY_POINTS = [
  "windows/run-supervisor.ps1",
  "src/runtime/three-lane-cli.mjs",
  "src/runtime/three-lane.mjs"
];

const SINGLE_LANE_STATE_MODULE = "src/runtime/single-lane-state.mjs";

const EXPECTED_A4_LEGACY_RUNTIME_FREEZE = {
  "schema_version": "sl3-p0-a4-legacy-runtime-freeze.v1",
  "task_id": "SL3-P0-A4",
  "state": "READY_FOR_VERIFY",
  "accepted_a3_head": "067e22af981c5042f17d06adaf6ae5e7ba42ec5c",
  "released_three_lane_baseline": "1b5779fb1652e691f25cc5f0f5b586a74b1fc012",
  "rollback_source_authority": "magasincoffee/magasin-supervisor@1b5779fb1652e691f25cc5f0f5b586a74b1fc012",
  "legacy_role": "ROLLBACK_ONLY_UNTIL_V3_OWNER_CUTOVER",
  "production_runtime_before_cutover": "THREE_LANE_V1",
  "forward_architecture": "SINGLE_LANE_CHATGPT_FIRST_V3",
  "automatic_v3_activation": false,
  "v3_qualification_required": true,
  "owner_explicit_cutover_required": true,
  "legacy_forward_feature_development": false,
  "runtime_behavior_changed": false,
  "rollback_entry_points": [
    "windows/run-supervisor.ps1",
    "src/runtime/three-lane-cli.mjs",
    "src/runtime/three-lane.mjs"
  ],
  "rollback_source_rule": {
    "immutable_released_snapshot_required": true,
    "exact_snapshot": "magasincoffee/magasin-supervisor@1b5779fb1652e691f25cc5f0f5b586a74b1fc012",
    "separately_qualified_replacement_allowed": true,
    "mixed_tree_rollback_allowed": false,
    "rule": "Rollback must materialize the exact immutable released snapshot or a separately qualified replacement; an old legacy entrypoint must never be combined with newer V3/shared runtime files into an unqualified mixed tree."
  },
  "rollback_preservation": {
    "must_preserve": [
      "Owner STOP latch",
      "AUTOSTART_DISABLED latch",
      "active task",
      "dispatch_inflight",
      "relay_inflight",
      "Brain exact target",
      "Work exact target",
      "target revisions",
      "dedicated browser profile",
      "canonical state root",
      "durable exact-once identities and unresolved effect intent"
    ],
    "must_not": [
      "clear or bypass STOP",
      "clear or bypass AUTOSTART_DISABLED",
      "reset active task",
      "reset dispatch_inflight",
      "reset relay_inflight",
      "replace Brain target",
      "replace Work target",
      "reset target revisions",
      "delete or reset dedicated browser profile",
      "destroy canonical state root",
      "replay unresolved browser effect before durable-intent/latch reconciliation",
      "restore Three-Lane/RBT documentation as forward Source of Truth"
    ],
    "durable_state_before_effect": true,
    "unresolved_effect_reconciliation_required": true
  },
  "forward_development_boundary": {
    "three_lane_production_baseline_until_cutover": true,
    "three_lane_role": "ROLLBACK_ONLY",
    "three_lane_v3_feature_development_allowed": false,
    "single_lane_v3_is_only_forward_architecture": true,
    "new_implementation_roadmap": "SL3-P1+",
    "convert_legacy_three_lane_to_single_lane_by_flags_allowed": false
  },
  "semantic_sync": {
    "markdown_section": "3.3 Legacy Three-Lane rollback freeze — SL3-P0-A4",
    "json_field": "legacy_runtime_freeze",
    "required_equivalence": true
  },
  "stop_boundary": "READY_FOR_VERIFY",
  "next_task": "SL3-P1-A1",
  "next_task_started": false
};

const SUPPORTING_ACTIVE_SURFACES = [
  "README.md",
  "docs/MAGASIN_LANE_DIRECTIVE_V1_PROTOCOL.md",
  "docs/PROJECT_ADAPTER_V1.md",
  "docs/STATE_ROOT_V1.md",
  ...TOMBSTONES.map((item) => item.path)
];

function rel(root, file) {
  return path.join(root, ...file.split("/"));
}

async function exists(root, file) {
  try {
    await fs.access(rel(root, file));
    return true;
  } catch {
    return false;
  }
}

async function read(root, file) {
  return fs.readFile(rel(root, file), "utf8");
}

function addError(errors, ok, message) {
  if (!ok) errors.push(message);
}

function sameMembers(actual, expected) {
  if (actual.length !== expected.length) return false;
  const a = [...actual].sort();
  const b = [...expected].sort();
  return a.every((value, index) => value === b[index]);
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJson(value[key])])
  );
}

function sameJson(actual, expected) {
  return JSON.stringify(stableJson(actual)) === JSON.stringify(stableJson(expected));
}

function isHistoricalEvidence(file, sot) {
  if ((sot?.source_cleanup?.retain_historical_evidence || []).includes(file)) return true;
  const base = path.posix.basename(file);
  return /(?:EVIDENCE|CLOSURE|MANIFEST|PROVENANCE|RELEASE_REQUEST|RELEASE_EVIDENCE)/i.test(base);
}

async function walkDocs(root, dir = "docs") {
  const start = rel(root, dir);
  let entries = [];
  try {
    entries = await fs.readdir(start, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const child = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walkDocs(root, child));
    } else if (/\.(?:md|json)$/i.test(entry.name)) {
      out.push(child);
    }
  }
  return out;
}

async function auditRepository(root) {
  const errors = [];

  for (const file of CANONICAL_FILES) {
    addError(errors, await exists(root, file), `A canonical file missing: ${file}`);
  }

  let md = "";
  let sot = null;

  if (await exists(root, CANONICAL_MD)) {
    md = await read(root, CANONICAL_MD);
    addError(errors, md.trim().length > 0, "A canonical Markdown is empty");
  }

  if (await exists(root, CANONICAL_JSON)) {
    const raw = await read(root, CANONICAL_JSON);
    try {
      sot = JSON.parse(raw);
    } catch (error) {
      errors.push(`A canonical JSON malformed: ${error.message}`);
    }
  }

  if (!sot) return errors;

  addError(
    errors,
    sot.schema_version === "supervisor-single-lane-chatgpt-first-v3.sot.v1",
    "A schema_version drift"
  );

  const arch = sot.architecture || {};
  const architectureChecks = [
    ["product_center", arch.product_center, "CHATGPT_PLUS"],
    ["api_cost_policy", arch.api_cost_policy, "NO_PAID_OPENAI_API_IN_PRODUCTION_PATH"],
    ["lane_count", arch.lane_count, 1],
    ["active_project_count", arch.active_project_count, 1],
    ["active_task_count", arch.active_task_count, 1],
    ["chatgpt_tabs.brain", arch.chatgpt_tabs?.brain, 1],
    ["chatgpt_tabs.work", arch.chatgpt_tabs?.work, 1],
    ["chatgpt_tabs.persistent_warm", arch.chatgpt_tabs?.persistent_warm, true],
    ["normal_path", arch.normal_path, "EVENT_DRIVEN"],
    ["normal_path_polling", arch.normal_path_polling, false],
    ["deployment_authority", sot.deployment_authority, "OWNER_EXPLICIT_ONLY"],
    ["execution_policy.robot_may_merge_or_deploy", sot.execution_policy?.robot_may_merge_or_deploy, false],
    ["execution_policy.exact_once_required", sot.execution_policy?.exact_once_required, true]
  ];
  for (const [name, actual, expected] of architectureChecks) {
    addError(errors, actual === expected, `B architecture lock drift: ${name}`);
  }

  const lock = sot.invariant_rollback_lock;
  addError(errors, Boolean(lock), "C invariant_rollback_lock missing");
  if (lock) {
    const invariantIds = (lock.invariant_evidence || []).map((item) => item?.invariant_id);
    addError(errors, invariantIds.length === 10, "C invariant count must be exactly 10");
    addError(errors, new Set(invariantIds).size === invariantIds.length, "C invariant IDs must not duplicate");
    addError(errors, sameMembers(invariantIds, EXPECTED_INVARIANTS), "C accepted invariant IDs drift");

    addError(
      errors,
      lock.released_three_lane_baseline_main_sha === "1b5779fb1652e691f25cc5f0f5b586a74b1fc012",
      "D released rollback baseline drift"
    );
    addError(
      errors,
      lock.accepted_v3_source_of_truth_head === "c801604ab0de442215f1bccf32210aae0cb6279a",
      "D accepted V3 SoT parent drift"
    );

    const rb = lock.rollback_boundary || {};
    addError(errors, rb.delete_legacy_before_v3_qualification === false, "D legacy deletion-before-qualification guard drift");
    addError(
      errors,
      sameMembers(rb.rollback_only_legacy_entry_points || [], EXPECTED_ROLLBACK_ENTRY_POINTS),
      "D rollback-only entry points drift"
    );

    const mustNot = (rb.rollback_must_not || []).join("\n");
    addError(errors, /STOP\/AUTOSTART_DISABLED/i.test(mustNot), "D rollback must preserve Owner STOP boundary");
    addError(errors, /task\/latches\/targets\/profile/i.test(mustNot), "D rollback must preserve task/latches/targets/profile");
    addError(errors, /qualification/i.test(mustNot), "D rollback must preserve V3 qualification boundary");
  }

  const tasks = Array.isArray(sot.tasks) ? sot.tasks : [];
  const taskIds = tasks.map((item) => item?.task_id);
  addError(errors, tasks.length === 57, "E roadmap must contain exactly 57 tasks");
  addError(errors, new Set(taskIds).size === taskIds.length, "E roadmap task_id values must be unique");
  addError(
    errors,
    taskIds.length === EXPECTED_TASK_IDS.length &&
      taskIds.every((value, index) => value === EXPECTED_TASK_IDS[index]),
    "E accepted 57-task roadmap order drift"
  );

  const seen = new Set();
  for (const task of tasks) {
    for (const dependency of task?.depends_on || []) {
      addError(
        errors,
        seen.has(dependency),
        `E dependency ${dependency} for ${task?.task_id} must point to an earlier task`
      );
    }
    seen.add(task?.task_id);
  }

  addError(
    errors,
    taskIds.slice(0, 4).join("|") === "SL3-P0-A1|SL3-P0-A2|SL3-P0-A3|SL3-P0-A4",
    "E SL3-P0 A1→A2→A3→A4 ordering drift"
  );
  const a4 = tasks.find((item) => item?.task_id === "SL3-P0-A4");
  addError(errors, Boolean(a4), "E SL3-P0-A4 missing");
  if (a4) {
    addError(errors, JSON.stringify(a4.depends_on || []) === JSON.stringify(["SL3-P0-A3"]), "E SL3-P0-A4 dependency drift");
  }
  const p1a1 = tasks.find((item) => item?.task_id === "SL3-P1-A1");
  addError(errors, Boolean(p1a1), "E SL3-P1-A1 missing");
  if (p1a1) {
    addError(
      errors,
      JSON.stringify(p1a1.depends_on || []) === JSON.stringify(["SL3-P0-A4"]),
      "E SL3-P1-A1 dependency drift"
    );
  }
  const p1a2 = tasks.find((item) => item?.task_id === "SL3-P1-A2");
  addError(errors, Boolean(p1a2), "E SL3-P1-A2 missing");
  if (p1a2) {
    addError(
      errors,
      JSON.stringify(p1a2.depends_on || []) === JSON.stringify(["SL3-P1-A1"]),
      "E SL3-P1-A2 dependency drift"
    );
    const p1a2State = String(p1a2.state || p1a2.status || "").toUpperCase();
    addError(
      errors,
      !["ACTIVE","STARTED","DONE","COMPLETE","COMPLETED"].includes(p1a2State),
      "E SL3-P1-A2 must remain NOT STARTED"
    );
    addError(
      errors,
      p1a2.started !== true && p1a2.completed !== true,
      "E SL3-P1-A2 must not be marked started/completed"
    );
  }
  addError(errors, sot.task_id === "SL3-P1-A1", "E canonical current task must be SL3-P1-A1");
  addError(errors, sot.state === "READY_FOR_VERIFY", "E canonical state must be READY_FOR_VERIFY");

  const freeze = sot.legacy_runtime_freeze;
  addError(errors, Boolean(freeze), "I legacy_runtime_freeze missing");
  if (freeze) {
    addError(
      errors,
      sameJson(freeze, EXPECTED_A4_LEGACY_RUNTIME_FREEZE),
      "I accepted A4 legacy freeze semantic drift"
    );
    const freezeChecks = [
      ["schema_version", freeze.schema_version, "sl3-p0-a4-legacy-runtime-freeze.v1"],
      ["task_id", freeze.task_id, "SL3-P0-A4"],
      ["state", freeze.state, "READY_FOR_VERIFY"],
      ["accepted_a3_head", freeze.accepted_a3_head, "067e22af981c5042f17d06adaf6ae5e7ba42ec5c"],
      ["released_three_lane_baseline", freeze.released_three_lane_baseline, "1b5779fb1652e691f25cc5f0f5b586a74b1fc012"],
      ["legacy_role", freeze.legacy_role, "ROLLBACK_ONLY_UNTIL_V3_OWNER_CUTOVER"],
      ["production_runtime_before_cutover", freeze.production_runtime_before_cutover, "THREE_LANE_V1"],
      ["forward_architecture", freeze.forward_architecture, "SINGLE_LANE_CHATGPT_FIRST_V3"],
      ["automatic_v3_activation", freeze.automatic_v3_activation, false],
      ["v3_qualification_required", freeze.v3_qualification_required, true],
      ["owner_explicit_cutover_required", freeze.owner_explicit_cutover_required, true],
      ["legacy_forward_feature_development", freeze.legacy_forward_feature_development, false],
      ["runtime_behavior_changed", freeze.runtime_behavior_changed, false]
    ];
    for (const [name, actual, expected] of freezeChecks) {
      addError(errors, actual === expected, `I legacy freeze drift: ${name}`);
    }

    addError(
      errors,
      freeze.rollback_source_authority === "magasincoffee/magasin-supervisor@1b5779fb1652e691f25cc5f0f5b586a74b1fc012",
      "I immutable rollback source authority drift"
    );
    addError(
      errors,
      sameMembers(freeze.rollback_entry_points || [], EXPECTED_ROLLBACK_ENTRY_POINTS),
      "I legacy rollback entry points drift"
    );
    for (const entry of EXPECTED_ROLLBACK_ENTRY_POINTS) {
      addError(errors, await exists(root, entry), `I legacy rollback entry point missing: ${entry}`);
    }

    const sourceRule = freeze.rollback_source_rule || {};
    addError(errors, sourceRule.immutable_released_snapshot_required === true, "I rollback source must require immutable released snapshot");
    addError(
      errors,
      sourceRule.exact_snapshot === "magasincoffee/magasin-supervisor@1b5779fb1652e691f25cc5f0f5b586a74b1fc012",
      "I rollback exact snapshot drift"
    );
    addError(errors, sourceRule.mixed_tree_rollback_allowed === false, "I mixed-tree rollback must remain forbidden");

    const preservation = freeze.rollback_preservation || {};
    const preserveText = [
      ...(preservation.must_preserve || []),
      ...(preservation.must_not || [])
    ].join("\n");
    for (const [token, regex] of [
      ["STOP", /\bSTOP\b/i],
      ["AUTOSTART_DISABLED", /AUTOSTART_DISABLED/i],
      ["active task", /active task/i],
      ["dispatch_inflight", /dispatch_inflight/i],
      ["relay_inflight", /relay_inflight/i],
      ["Brain target", /Brain.*target/i],
      ["Work target", /Work.*target/i],
      ["target revisions", /target revisions/i],
      ["browser profile", /browser profile/i],
      ["canonical state root", /canonical state root/i],
      ["reconciliation", /reconcil/i]
    ]) {
      addError(errors, regex.test(preserveText), `I rollback preservation missing ${token}`);
    }
  }

  addError(errors, md.includes("### 3.3 Legacy Three-Lane rollback freeze — SL3-P0-A4"), "I Markdown legacy freeze section missing");
  addError(errors, md.includes("magasincoffee/magasin-supervisor@1b5779fb1652e691f25cc5f0f5b586a74b1fc012"), "I Markdown immutable rollback source missing");
  addError(errors, /LEGACY \/ ROLLBACK-ONLY/i.test(md), "I Markdown rollback-only role missing");
  addError(errors, /mixed tree/i.test(md), "I Markdown mixed-tree prohibition missing");

  const stateSchema = sot.single_lane_state_schema;
  addError(errors, Boolean(stateSchema), "J single_lane_state_schema missing");
  if (stateSchema) {
    const schemaChecks = [
      ["schema_version", stateSchema.schema_version, "sl3-p1-a1-single-lane-state-schema.v1"],
      ["task_id", stateSchema.task_id, "SL3-P1-A1"],
      ["state", stateSchema.state, "READY_FOR_VERIFY"],
      ["accepted_a4_head", stateSchema.accepted_a4_head, "09deca9adb977cb2ef0f93c6b7ad33425b1fb720"],
      ["module_path", stateSchema.module_path, SINGLE_LANE_STATE_MODULE],
      ["runtime_mode", stateSchema.runtime_mode, "SINGLE_LANE_V3"],
      ["config_schema", stateSchema.config_schema, "single-lane-config.v1"],
      ["registry_schema", stateSchema.registry_schema, "single-lane-registry.v1"],
      ["config_filename", stateSchema.config_filename, "single-lane-config.json"],
      ["registry_filename", stateSchema.registry_filename, "single-lane-registry.json"],
      ["legacy_config_filename", stateSchema.legacy_config_filename, "lanes.json"],
      ["legacy_registry_filename", stateSchema.legacy_registry_filename, "lane-registry.json"],
      ["legacy_state_mutated", stateSchema.legacy_state_mutated, false],
      ["automatic_migration", stateSchema.automatic_migration, false],
      ["automatic_runtime_activation", stateSchema.automatic_runtime_activation, false],
      ["runtime_behavior_changed", stateSchema.runtime_behavior_changed, false],
      ["next_task", stateSchema.next_task, "SL3-P1-A2"],
      ["next_task_started", stateSchema.next_task_started, false]
    ];
    for (const [name, actual, expected] of schemaChecks) {
      addError(errors, actual === expected, `J single-lane state schema drift: ${name}`);
    }

    addError(
      errors,
      stateSchema.config_filename !== stateSchema.legacy_config_filename,
      "J V3 config filename must remain isolated from lanes.json"
    );
    addError(
      errors,
      stateSchema.registry_filename !== stateSchema.legacy_registry_filename,
      "J V3 registry filename must remain isolated from lane-registry.json"
    );

    const topology = stateSchema.topology_policy || {};
    addError(errors, topology.exactly_one_project_config === true, "J exactly-one-project config lock drift");
    addError(errors, topology.lanes_field_allowed === false, "J lanes topology must remain forbidden");
    addError(errors, topology.lane_id_allowed === false, "J lane_id topology must remain forbidden");
    addError(errors, topology.scheduler_metadata_allowed === false, "J scheduler metadata must remain forbidden");
    addError(errors, topology.fairness_or_page_budget_state_allowed === false, "J fairness/page-budget state must remain forbidden");
    addError(errors, topology.cross_lane_state_allowed === false, "J cross-lane state must remain forbidden");

    const isolation = stateSchema.state_file_isolation || {};
    addError(errors, isolation.v3_files_must_differ_from_legacy === true, "J V3/legacy state-file isolation drift");
    addError(errors, isolation.legacy_files_read_in_a1 === false, "J A1 must not read legacy state files");
    addError(errors, isolation.legacy_files_written_in_a1 === false, "J A1 must not write legacy state files");
    addError(errors, isolation.legacy_files_renamed_in_a1 === false, "J A1 must not rename legacy state files");
    addError(errors, isolation.legacy_files_deleted_in_a1 === false, "J A1 must not delete legacy state files");

    addError(
      errors,
      stateSchema.process_truth_policy === "NOT_PERSISTED_AS_RUNTIME_LIVENESS_AUTHORITY",
      "J process truth policy drift"
    );
  }

  addError(errors, await exists(root, SINGLE_LANE_STATE_MODULE), "J single-lane state module missing");
  addError(errors, md.includes("### 3.4 Single-Lane config and durable registry schema — SL3-P1-A1"), "J Markdown P1-A1 schema section missing");
  addError(errors, md.includes("09deca9adb977cb2ef0f93c6b7ad33425b1fb720"), "J Markdown accepted A4 head missing");
  addError(errors, /single-lane-config\.json/i.test(md) && /single-lane-registry\.json/i.test(md), "J Markdown V3 filenames missing");
  addError(errors, /lanes\.json/i.test(md) && /lane-registry\.json/i.test(md), "J Markdown legacy filename isolation missing");
  addError(errors, /Process truth is not registry authority/i.test(md), "J Markdown process-truth boundary missing");
  addError(errors, /SL3-P1-A2[^\n]*NOT STARTED/i.test(md), "J Markdown must keep SL3-P1-A2 NOT STARTED");

  for (const file of REMOVED_SOURCES) {
    addError(errors, !(await exists(root, file)), `F removed source reintroduced: ${file}`);
  }

  const activeDocs = await walkDocs(root);
  const scanFiles = new Set(["README.md", ...activeDocs]);
  for (const file of scanFiles) {
    if (CANONICAL_FILES.includes(file)) continue;
    if (isHistoricalEvidence(file, sot)) continue;
    if (!(await exists(root, file))) continue;
    const text = await read(root, file);
    for (const removed of REMOVED_SOURCES) {
      const base = path.posix.basename(removed);
      addError(
        errors,
        !text.includes(removed) && !text.includes(base),
        `F stale removed-source reference in active surface ${file}: ${removed}`
      );
    }
  }

  for (const tombstone of TOMBSTONES) {
    addError(errors, await exists(root, tombstone.path), `G compatibility tombstone missing: ${tombstone.path}`);
    if (!(await exists(root, tombstone.path))) continue;
    const text = await read(root, tombstone.path);
    addError(errors, tombstone.status.test(text), `G tombstone status promoted: ${tombstone.path}`);
    addError(errors, tombstone.disclaimer.test(text), `G tombstone authority disclaimer missing: ${tombstone.path}`);
    addError(errors, text.includes(CANONICAL_MD), `G tombstone missing V3 Markdown pointer: ${tombstone.path}`);
    addError(errors, text.includes(CANONICAL_JSON), `G tombstone missing V3 JSON pointer: ${tombstone.path}`);
    addError(errors, text.length < 2500, `G tombstone expanded beyond compatibility-pointer scope: ${tombstone.path}`);
  }

  if (await exists(root, "README.md")) {
    const readme = await read(root, "README.md");
    addError(errors, readme.includes(CANONICAL_MD), "H README missing canonical V3 Markdown authority");
    addError(errors, readme.includes(CANONICAL_JSON), "H README missing canonical V3 JSON authority");
    addError(errors, /only active forward architecture\/source-of-truth/i.test(readme), "H README must identify V3 as sole forward authority");
    addError(errors, /Single-Lane ChatGPT-First Runtime V3/i.test(readme), "H README must identify Single-Lane V3 target");
    addError(errors, /Three-Lane[^\n]*(?:historical|rollback|until.*V3 cutover)/i.test(readme), "H README must keep Three-Lane historical/rollback-only");
    addError(errors, !/Runtime V2[^\n]*(?:current|canonical|target|authority)/i.test(readme), "H README must not restore Runtime V2 forward authority");
  } else {
    errors.push("H README missing");
  }

  return errors;
}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sl3-a3-sot-"));
  const seed = new Set([
    ...CANONICAL_FILES,
    ...SUPPORTING_ACTIVE_SURFACES,
    ...EXPECTED_ROLLBACK_ENTRY_POINTS,
    SINGLE_LANE_STATE_MODULE
  ]);
  for (const file of seed) {
    await fs.mkdir(path.dirname(rel(root, file)), { recursive: true });
    await fs.copyFile(rel(REPO_ROOT, file), rel(root, file));
  }
  return root;
}

async function mutateJson(root, mutate) {
  const file = rel(root, CANONICAL_JSON);
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  mutate(data);
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

test("A-H canonical Single-Lane V3 Source of Truth guard passes repository", async () => {
  const errors = await auditRepository(REPO_ROOT);
  assert.deepEqual(errors, []);
});

test("A missing or malformed canonical JSON fails closed", async (t) => {
  await t.test("missing", async () => {
    const root = await makeFixture();
    await fs.unlink(rel(root, CANONICAL_JSON));
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /canonical file missing/i.test(error)));
  });
  await t.test("malformed", async () => {
    const root = await makeFixture();
    await fs.writeFile(rel(root, CANONICAL_JSON), "{not-json", "utf8");
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /canonical JSON malformed/i.test(error)));
  });
});

test("B architecture-lock drift fails closed", async () => {
  const root = await makeFixture();
  await mutateJson(root, (data) => {
    data.architecture.lane_count = 3;
    data.architecture.normal_path_polling = true;
  });
  const errors = await auditRepository(root);
  assert.ok(errors.some((error) => /architecture lock drift: lane_count/i.test(error)));
  assert.ok(errors.some((error) => /architecture lock drift: normal_path_polling/i.test(error)));
});

test("C invariant deletion or duplication fails closed", async () => {
  const root = await makeFixture();
  await mutateJson(root, (data) => {
    data.invariant_rollback_lock.invariant_evidence.pop();
    data.invariant_rollback_lock.invariant_evidence.push(
      structuredClone(data.invariant_rollback_lock.invariant_evidence[0])
    );
  });
  const errors = await auditRepository(root);
  assert.ok(errors.some((error) => /invariant IDs must not duplicate/i.test(error)));
  assert.ok(errors.some((error) => /accepted invariant IDs drift/i.test(error)));
});

test("D rollback boundary drift fails closed", async () => {
  const root = await makeFixture();
  await mutateJson(root, (data) => {
    data.invariant_rollback_lock.rollback_boundary.delete_legacy_before_v3_qualification = true;
    data.invariant_rollback_lock.rollback_boundary.rollback_only_legacy_entry_points = [];
  });
  const errors = await auditRepository(root);
  assert.ok(errors.some((error) => /legacy deletion-before-qualification/i.test(error)));
  assert.ok(errors.some((error) => /rollback-only entry points drift/i.test(error)));
});

test("E roadmap dependency drift and P1-A2 premature start fail closed", async () => {
  const root = await makeFixture();
  await mutateJson(root, (data) => {
    data.tasks[5].depends_on = ["SL3-P1-A3"];
    data.tasks[5].state = "ACTIVE";
  });
  const errors = await auditRepository(root);
  assert.ok(errors.some((error) => /dependency SL3-P1-A3.*must point to an earlier task/i.test(error)));
  assert.ok(errors.some((error) => /SL3-P1-A2 must remain NOT STARTED/i.test(error)));
});

test("F stale-source reintroduction or active README reference fails closed", async (t) => {
  await t.test("removed file reintroduced", async () => {
    const root = await makeFixture();
    const stale = REMOVED_SOURCES[0];
    await fs.mkdir(path.dirname(rel(root, stale)), { recursive: true });
    await fs.writeFile(rel(root, stale), "# resurrected authority\n", "utf8");
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /removed source reintroduced/i.test(error)));
  });
  await t.test("README points back to removed authority", async () => {
    const root = await makeFixture();
    await fs.appendFile(
      rel(root, "README.md"),
      `\nCurrent canonical target: ${REMOVED_SOURCES[1]}\n`,
      "utf8"
    );
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /stale removed-source reference in active surface README\.md/i.test(error)));
  });
});

test("F historical evidence references are intentional exclusions, not false positives", async () => {
  const root = await makeFixture();
  const historical = "docs/MIG_999_EVIDENCE.md";
  await fs.writeFile(
    rel(root, historical),
    `Historical provenance only: ${REMOVED_SOURCES[0]}\n`,
    "utf8"
  );
  const errors = await auditRepository(root);
  assert.deepEqual(errors, []);
});

test("G tombstone promotion back to active authority fails closed", async () => {
  const root = await makeFixture();
  const file = rel(root, TOMBSTONES[0].path);
  const text = await fs.readFile(file, "utf8");
  await fs.writeFile(
    file,
    text.replace("Status: **SUPERSEDED / NON-CANONICAL**", "Status: **ACTIVE / CANONICAL**"),
    "utf8"
  );
  const errors = await auditRepository(root);
  assert.ok(errors.some((error) => /tombstone status promoted/i.test(error)));
});

test("H README authority remains V3-only", async () => {
  const errors = await auditRepository(REPO_ROOT);
  assert.equal(errors.filter((error) => error.startsWith("H ")).length, 0);
});


test("I legacy Three-Lane freeze authority remains exact historical A4 semantics", async () => {
  const errors = await auditRepository(REPO_ROOT);
  assert.equal(errors.filter((error) => error.startsWith("I ")).length, 0);
});

test("I accepted A4 freeze mutations still fail closed", async (t) => {
  await t.test("released baseline drift", async () => {
    const root = await makeFixture();
    await mutateJson(root, (data) => {
      data.legacy_runtime_freeze.released_three_lane_baseline = "0".repeat(40);
    });
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /accepted A4 legacy freeze semantic drift|released_three_lane_baseline/i.test(error)));
  });

  await t.test("legacy role promoted", async () => {
    const root = await makeFixture();
    await mutateJson(root, (data) => {
      data.legacy_runtime_freeze.legacy_role = "ACTIVE_FORWARD";
    });
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /accepted A4 legacy freeze semantic drift|legacy_role/i.test(error)));
  });

  await t.test("mixed-tree rollback re-enabled", async () => {
    const root = await makeFixture();
    await mutateJson(root, (data) => {
      data.legacy_runtime_freeze.rollback_source_rule.mixed_tree_rollback_allowed = true;
    });
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /accepted A4 legacy freeze semantic drift|mixed-tree rollback/i.test(error)));
  });

  await t.test("historical freeze metadata changed", async () => {
    const root = await makeFixture();
    await mutateJson(root, (data) => {
      data.legacy_runtime_freeze.semantic_sync.required_equivalence = false;
    });
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /accepted A4 legacy freeze semantic drift/i.test(error)));
  });
});

test("J P1-A1 single-lane state schema authority passes exact locks", async () => {
  const errors = await auditRepository(REPO_ROOT);
  assert.equal(errors.filter((error) => error.startsWith("J ")).length, 0);
});

test("J P1-A1 state-schema drift fixtures fail closed", async (t) => {
  const cases = [
    ["runtime mode becomes Three-Lane", (data) => {
      data.single_lane_state_schema.runtime_mode = "THREE_LANE_V1";
    }, /runtime_mode/],
    ["config schema drifts", (data) => {
      data.single_lane_state_schema.config_schema = "single-lane-config.v2";
    }, /config_schema/],
    ["registry schema drifts", (data) => {
      data.single_lane_state_schema.registry_schema = "single-lane-registry.v2";
    }, /registry_schema/],
    ["V3 config aliases lanes.json", (data) => {
      data.single_lane_state_schema.config_filename = "lanes.json";
    }, /config_filename|config filename/],
    ["V3 registry aliases lane-registry.json", (data) => {
      data.single_lane_state_schema.registry_filename = "lane-registry.json";
    }, /registry_filename|registry filename/],
    ["automatic migration enabled", (data) => {
      data.single_lane_state_schema.automatic_migration = true;
    }, /automatic_migration/],
    ["automatic runtime activation enabled", (data) => {
      data.single_lane_state_schema.automatic_runtime_activation = true;
    }, /automatic_runtime_activation/],
    ["legacy state mutation enabled", (data) => {
      data.single_lane_state_schema.legacy_state_mutated = true;
    }, /legacy_state_mutated/],
    ["runtime behavior changed", (data) => {
      data.single_lane_state_schema.runtime_behavior_changed = true;
    }, /runtime_behavior_changed/],
    ["accepted A4 head drifts", (data) => {
      data.single_lane_state_schema.accepted_a4_head = "0".repeat(40);
    }, /accepted_a4_head/],
    ["P1-A2 promoted early", (data) => {
      data.tasks[5].state = "ACTIVE";
      data.single_lane_state_schema.next_task_started = true;
    }, /SL3-P1-A2 must remain NOT STARTED|next_task_started/],
    ["A4 freeze altered", (data) => {
      data.legacy_runtime_freeze.owner_explicit_cutover_required = false;
    }, /accepted A4 legacy freeze semantic drift|owner_explicit_cutover_required/]
  ];

  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async () => {
      const root = await makeFixture();
      await mutateJson(root, mutate);
      const errors = await auditRepository(root);
      assert.ok(errors.some((error) => pattern.test(error)), errors.join("\n"));
    });
  }
});
