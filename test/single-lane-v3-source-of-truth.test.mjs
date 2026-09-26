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
    addError(errors, JSON.stringify(p1a1.depends_on || []) === JSON.stringify(["SL3-P0-A4"]), "E SL3-P1-A1 dependency drift");
    const p1State = String(p1a1.state || p1a1.status || "").toUpperCase();
    addError(errors, !["ACTIVE","STARTED","DONE","COMPLETE","COMPLETED"].includes(p1State), "E SL3-P1-A1 must remain NOT STARTED");
    addError(errors, p1a1.started !== true && p1a1.completed !== true, "E SL3-P1-A1 must not be marked started/completed");
  }
  addError(errors, sot.task_id === "SL3-P0-A4", "E canonical current task must be SL3-P0-A4");
  addError(errors, sot.state === "READY_FOR_VERIFY", "E canonical state must be READY_FOR_VERIFY");

  const freeze = sot.legacy_runtime_freeze;
  addError(errors, Boolean(freeze), "I legacy_runtime_freeze missing");
  if (freeze) {
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
    addError(errors, /mixed tree/i.test(String(sourceRule.rule || "")), "I mixed-tree prohibition rule missing");

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
    addError(errors, preservation.durable_state_before_effect === true, "I durable-state-before-effect rollback lock drift");
    addError(errors, preservation.unresolved_effect_reconciliation_required === true, "I unresolved-effect reconciliation lock drift");

    const boundary = freeze.forward_development_boundary || {};
    addError(errors, boundary.three_lane_production_baseline_until_cutover === true, "I Three-Lane production-baseline boundary drift");
    addError(errors, boundary.three_lane_role === "ROLLBACK_ONLY", "I Three-Lane forward role drift");
    addError(errors, boundary.three_lane_v3_feature_development_allowed === false, "I legacy forward feature boundary drift");
    addError(errors, boundary.single_lane_v3_is_only_forward_architecture === true, "I V3 forward architecture boundary drift");
    addError(errors, boundary.new_implementation_roadmap === "SL3-P1+", "I V3 implementation roadmap boundary drift");
    addError(errors, boundary.convert_legacy_three_lane_to_single_lane_by_flags_allowed === false, "I flag-conversion boundary drift");
    addError(errors, freeze.next_task === "SL3-P1-A1", "I next task must be SL3-P1-A1");
    addError(errors, freeze.next_task_started === false, "I SL3-P1-A1 must remain NOT STARTED");
  }

  addError(errors, md.includes("### 3.3 Legacy Three-Lane rollback freeze — SL3-P0-A4"), "I Markdown legacy freeze section missing");
  addError(errors, md.includes("magasincoffee/magasin-supervisor@1b5779fb1652e691f25cc5f0f5b586a74b1fc012"), "I Markdown immutable rollback source missing");
  addError(errors, md.includes("067e22af981c5042f17d06adaf6ae5e7ba42ec5c"), "I Markdown accepted A3 head missing");
  addError(errors, /LEGACY \/ ROLLBACK-ONLY/i.test(md), "I Markdown rollback-only role missing");
  addError(errors, /mixed tree/i.test(md), "I Markdown mixed-tree prohibition missing");
  addError(errors, /SL3-P1-A1[^\n]*NOT STARTED/i.test(md), "I Markdown must keep SL3-P1-A1 NOT STARTED");

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
    ...EXPECTED_ROLLBACK_ENTRY_POINTS
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

test("E roadmap dependency drift and P1-A1 premature start fail closed", async () => {
  const root = await makeFixture();
  await mutateJson(root, (data) => {
    data.tasks[3].depends_on = ["SL3-P1-A1"];
    data.tasks[4].state = "ACTIVE";
  });
  const errors = await auditRepository(root);
  assert.ok(errors.some((error) => /dependency SL3-P1-A1.*must point to an earlier task/i.test(error)));
  assert.ok(errors.some((error) => /SL3-P1-A1 must remain NOT STARTED/i.test(error)));
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


test("I legacy Three-Lane freeze authority passes exact accepted locks", async () => {
  const errors = await auditRepository(REPO_ROOT);
  assert.equal(errors.filter((error) => error.startsWith("I ")).length, 0);
});

test("I legacy freeze drift fixtures fail closed", async (t) => {
  await t.test("baseline SHA drift", async () => {
    const root = await makeFixture();
    await mutateJson(root, (data) => {
      data.legacy_runtime_freeze.released_three_lane_baseline = "0".repeat(40);
    });
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /released_three_lane_baseline/i.test(error)));
  });

  await t.test("legacy role promoted to forward", async () => {
    const root = await makeFixture();
    await mutateJson(root, (data) => {
      data.legacy_runtime_freeze.legacy_role = "ACTIVE_FORWARD";
    });
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /legacy_role/i.test(error)));
  });

  await t.test("automatic V3 activation enabled", async () => {
    const root = await makeFixture();
    await mutateJson(root, (data) => {
      data.legacy_runtime_freeze.automatic_v3_activation = true;
    });
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /automatic_v3_activation/i.test(error)));
  });

  await t.test("qualification requirement removed", async () => {
    const root = await makeFixture();
    await mutateJson(root, (data) => {
      data.legacy_runtime_freeze.v3_qualification_required = false;
    });
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /v3_qualification_required/i.test(error)));
  });

  await t.test("Owner cutover requirement removed", async () => {
    const root = await makeFixture();
    await mutateJson(root, (data) => {
      data.legacy_runtime_freeze.owner_explicit_cutover_required = false;
    });
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /owner_explicit_cutover_required/i.test(error)));
  });

  await t.test("legacy forward feature development enabled", async () => {
    const root = await makeFixture();
    await mutateJson(root, (data) => {
      data.legacy_runtime_freeze.legacy_forward_feature_development = true;
    });
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /legacy_forward_feature_development/i.test(error)));
  });

  await t.test("rollback entry point removed", async () => {
    const root = await makeFixture();
    await fs.unlink(rel(root, EXPECTED_ROLLBACK_ENTRY_POINTS[1]));
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /legacy rollback entry point missing/i.test(error)));
  });

  await t.test("STOP and AUTOSTART_DISABLED preservation removed", async () => {
    const root = await makeFixture();
    await mutateJson(root, (data) => {
      data.legacy_runtime_freeze.rollback_preservation.must_preserve =
        data.legacy_runtime_freeze.rollback_preservation.must_preserve
          .filter((value) => !/STOP|AUTOSTART_DISABLED/i.test(value));
      data.legacy_runtime_freeze.rollback_preservation.must_not =
        data.legacy_runtime_freeze.rollback_preservation.must_not
          .filter((value) => !/STOP|AUTOSTART_DISABLED/i.test(value));
    });
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /rollback preservation missing STOP/i.test(error)));
    assert.ok(errors.some((error) => /rollback preservation missing AUTOSTART_DISABLED/i.test(error)));
  });

  await t.test("mixed-tree rollback allowed", async () => {
    const root = await makeFixture();
    await mutateJson(root, (data) => {
      data.legacy_runtime_freeze.rollback_source_rule.mixed_tree_rollback_allowed = true;
    });
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /mixed-tree rollback must remain forbidden/i.test(error)));
  });

  await t.test("canonical current task jumps to SL3-P1-A1", async () => {
    const root = await makeFixture();
    await mutateJson(root, (data) => {
      data.task_id = "SL3-P1-A1";
      data.state = "READY_FOR_VERIFY";
      data.legacy_runtime_freeze.next_task_started = true;
    });
    const errors = await auditRepository(root);
    assert.ok(errors.some((error) => /canonical current task must be SL3-P0-A4/i.test(error)));
    assert.ok(errors.some((error) => /SL3-P1-A1 must remain NOT STARTED/i.test(error)));
  });
});
