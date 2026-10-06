export const ADAPTIVE_POLL_SEQUENCE_SECONDS = Object.freeze([20, 30, 60, 120]);

const ACTIVE_STATUSES = new Set([
  "queued",
  "pending",
  "requested",
  "waiting",
  "in_progress"
]);

export const CHANGE_IMPACT_MATRIX = Object.freeze([
  {
    id: "database",
    patterns: [
      /(^|\/)(supabase|migrations?|sql)(\/|$)/i,
      /\.sql$/i,
      /schema/i,
      /rpc/i
    ],
    modules: ["database", "auth-dependent", "data-dependent"],
    qa: ["migration/schema QA", "database contract QA", "dependent-module QA"],
    risk: "WIDE"
  },
  {
    id: "auth",
    patterns: [
      /(^|\/)(auth|rbac|permissions?|session)(\/|$)/i,
      /auth/i,
      /role/i,
      /permission/i
    ],
    modules: ["auth", "role-dependent"],
    qa: ["auth/RBAC QA", "dependent-role QA"],
    risk: "WIDE"
  },
  {
    id: "shared-ui",
    patterns: [
      /(^|\/)(components?|shared|ui)(\/|$)/i,
      /layout/i,
      /shell/i
    ],
    modules: ["shared-ui", "consumer-roles"],
    qa: ["shared-component QA", "consumer-role QA"],
    risk: "MEDIUM"
  },
  {
    id: "calendar-scheduling",
    patterns: [
      /calendar/i,
      /schedul/i,
      /shift/i,
      /workforce/i
    ],
    modules: ["calendar", "scheduling"],
    qa: ["calendar/scheduling targeted QA"],
    risk: "NARROW"
  },
  {
    id: "test-only",
    patterns: [
      /(^|\/)(test|tests|__tests__)(\/|$)/i,
      /\.test\.[cm]?[jt]sx?$/i,
      /\.spec\.[cm]?[jt]sx?$/i
    ],
    modules: ["tests"],
    qa: ["affected test contract"],
    risk: "NARROW"
  }
]);

function boundedInt(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function cleanPath(value) {
  return String(value || "").trim().replaceAll("\\", "/");
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

export function adaptiveExternalPollSeconds({
  workflowStatus,
  pollAttempt = 1,
  requestedSeconds = 0
} = {}) {
  const status = String(workflowStatus || "").trim().toLowerCase();
  if (!ACTIVE_STATUSES.has(status)) return 0;
  const attempt = Math.max(1, boundedInt(pollAttempt, 1, 1, 999));
  const index = Math.min(attempt - 1, ADAPTIVE_POLL_SEQUENCE_SECONDS.length - 1);
  const adaptive = ADAPTIVE_POLL_SEQUENCE_SECONDS[index];
  const requested = boundedInt(requestedSeconds, 0, 0, 3600);
  return requested > 0 ? Math.min(requested, adaptive) : adaptive;
}

export function classifyChangeImpact(paths = []) {
  const normalized = unique((Array.isArray(paths) ? paths : [paths]).map(cleanPath));
  if (normalized.length === 0) {
    return {
      confidence: "LOW",
      risk: "WIDE",
      matched_rules: [],
      modules: ["unknown"],
      targeted_qa: ["broad regression fallback"],
      fallback_broad: true
    };
  }

  const matched = CHANGE_IMPACT_MATRIX.filter((rule) =>
    normalized.some((path) => rule.patterns.some((pattern) => pattern.test(path)))
  );

  if (matched.length === 0) {
    return {
      confidence: "LOW",
      risk: "WIDE",
      matched_rules: [],
      modules: ["unknown"],
      targeted_qa: ["broad regression fallback"],
      fallback_broad: true
    };
  }

  const riskOrder = { NARROW: 1, MEDIUM: 2, WIDE: 3 };
  const risk = matched.reduce(
    (max, rule) => riskOrder[rule.risk] > riskOrder[max] ? rule.risk : max,
    "NARROW"
  );

  return {
    confidence: risk === "WIDE" ? "HIGH" : "MEDIUM",
    risk,
    matched_rules: matched.map((rule) => rule.id),
    modules: unique(matched.flatMap((rule) => rule.modules)),
    targeted_qa: unique(matched.flatMap((rule) => rule.qa)),
    fallback_broad: false
  };
}

export function deriveRunAuthority({
  authoritativeSha = null,
  evidenceSha = null
} = {}) {
  const authoritative = String(authoritativeSha || "").trim().toLowerCase();
  const observed = String(evidenceSha || "").trim().toLowerCase();
  if (!authoritative || !observed) return "UNKNOWN";
  return authoritative === observed ? "AUTHORITATIVE" : "OBSOLETE";
}

export function deriveFailureRootKey(evidence = {}) {
  const workflow = String(evidence.workflow_name || "UNKNOWN_WORKFLOW").trim();
  const gate = String(
    evidence.checkpoint_id ||
    evidence.workflow_name ||
    "UNKNOWN_GATE"
  ).trim();
  const signature = String(
    evidence.failure_signature ||
    evidence.workflow_conclusion ||
    evidence.workflow_status ||
    "UNKNOWN_FAILURE"
  ).trim();
  const relevantModule = String(
    evidence.relevant_module ||
    evidence.checkpoint_id ||
    evidence.workflow_name ||
    "UNKNOWN_MODULE"
  ).trim();

  return [workflow, gate, signature, relevantModule]
    .join("|")
    .replace(/\s+/g, "_")
    .slice(0, 200);
}

export function deriveFailureFingerprint(evidence = {}) {
  const root = deriveFailureRootKey(evidence);
  const sha = String(evidence.commit_sha || "NO_SHA").trim();
  return [root, sha]
    .join("|")
    .replace(/\s+/g, "_")
    .slice(0, 240);
}

export function groupFailureEvidence(failures = []) {
  const groups = new Map();
  for (const failure of Array.isArray(failures) ? failures : []) {
    const root = deriveFailureRootKey(failure);
    const current = groups.get(root) || {
      root_key: root,
      occurrences: 0,
      workflow_names: [],
      commit_shas: [],
      evidence: []
    };
    current.occurrences += 1;
    current.workflow_names = unique([
      ...current.workflow_names,
      String(failure?.workflow_name || "").trim()
    ]);
    current.commit_shas = unique([
      ...current.commit_shas,
      String(failure?.commit_sha || "").trim()
    ]);
    current.evidence.push({ ...failure });
    groups.set(root, current);
  }
  return [...groups.values()];
}

export function releaseGateDecision({
  targetedQaStatus = "PENDING",
  requiredRegressionStatus = "PENDING",
  exactMainStatus = "PENDING"
} = {}) {
  const targeted = String(targetedQaStatus || "PENDING").toUpperCase();
  const regression = String(requiredRegressionStatus || "PENDING").toUpperCase();
  const exactMain = String(exactMainStatus || "PENDING").toUpperCase();

  if (targeted !== "GREEN") {
    return { phase: "TARGETED_QA", may_complete: false };
  }
  if (regression !== "GREEN") {
    return { phase: "REQUIRED_REGRESSION", may_complete: false };
  }
  if (exactMain !== "GREEN") {
    return { phase: "EXACT_MAIN_VERIFY", may_complete: false };
  }
  return { phase: "COMPLETE_ELIGIBLE", may_complete: true };
}

export function executionOptimizationPolicyLines() {
  return [
    "Execution optimization policy (internal only; do not change MAGASIN protocol, TASK_ID, NEXT_TASK_ID, or SOT task boundaries):",
    "Internal execution sequence is: inspect changed paths/dependencies -> classify impact -> run targeted/impacted QA -> batch-repair targeted failures in the same EXECUTE turn -> targeted GREEN -> form one coherent RC candidate -> launch every SOT/project-required regression/release gate -> exact-main verification -> COMPLETE eligibility.",
    "Change-impact matrix: calendar/scheduling/shift/workforce paths => calendar/scheduling QA; auth/RBAC/session/shared RPC => auth plus dependent-role/module QA; database/schema/migration/SQL => migration/schema plus dependent-module regression; shared UI/component/layout/shell => component plus all consumer-role QA; test-only changes => affected contract tests. If a path/dependency cannot be classified with confidence, widen to broader regression instead of under-testing.",
    "Before launching durable CI, inspect the changed paths and dependency impact. Run the narrowest task-specific/impacted QA that is safe; if impact is uncertain, widen/fallback to broader regression rather than under-test.",
    "Within this EXECUTE turn, repair targeted-QA failures immediately and rerun targeted QA until green before creating a release/full-regression candidate when the available tools allow it. Do not return RUNNING merely for local/ephemeral QA that can be completed in this turn.",
    "When a QA/CI run has multiple failures, collect every currently available failing job/step/log before editing, group failures by root cause, and repair related failures as one batch. Preserve the full failure evidence so the next repair does not fix failures one-by-one.",
    "Before repairing a terminal authoritative GitHub Actions result, inspect the other workflow runs/checks already created for the same authoritative SHA. If sibling runs for that SHA are still active, use bounded read-only observation to collect their terminal evidence before waking another repair turn when safe. Repair from the aggregate same-SHA failure set, not from the first terminal workflow alone.",
    "Prefer one coherent batch commit at a repair boundary. Do not create a commit merely because one file/update operation completed; when Git tree/multi-file commit or equivalent tooling is available, stage the related edits and commit once.",
    "Do not launch required/full regression after every small edit. Launch required release/full regression only after targeted QA is green or a coherent RC candidate exists, while still running every SOT/project-required gate before COMPLETE.",
    "Targeted QA GREEN alone never authorizes COMPLETE. If release/full regression or exact-main verification fails, remain on this same TASK_ID and repair/verify until the required gates are GREEN.",
    "Distinguish PRODUCT REGRESSION from STALE TEST only from current SOT/code contract evidence. If a test is stale, update that test to authoritative behavior and retain evidence; never revert correct product behavior solely to satisfy historical assertions and never delete/skip an assertion without authority.",
    "When a newer commit supersedes an older task commit, treat the newer SHA as authoritative and do not keep waiting on obsolete runs. Cancel obsolete queued/in-progress non-release runs only when the provider/tool supports it and cancellation is clearly safe; never cancel ambiguous release/production jobs.",
    "Use internal checkpoints only as runtime execution evidence. Never create checkpoint IDs as new SOT tasks and never substitute them for TASK_ID/NEXT_TASK_ID.",
    "For repeated failures, fingerprint root cause from workflow/job or gate, error signature, relevant module/checkpoint, and commit SHA. If the same root failure survives 2-3 repair candidates, change repair strategy using new evidence; do not repeat the identical repair indefinitely. BLOCKED is allowed only for a genuine Owner-required condition or exhausted safe repair strategy.",
    "Final required/full regression and exact-main verification remain mandatory whenever required by SOT/project policy; targeted QA never lowers those acceptance standards."
  ];
}
