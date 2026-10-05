export const ADAPTIVE_POLL_SEQUENCE_SECONDS = Object.freeze([20, 30, 60, 120]);

const ACTIVE_STATUSES = new Set([
  "queued",
  "pending",
  "requested",
  "waiting",
  "in_progress"
]);

function boundedInt(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
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

export function deriveRunAuthority({
  authoritativeSha = null,
  evidenceSha = null
} = {}) {
  const authoritative = String(authoritativeSha || "").trim().toLowerCase();
  const observed = String(evidenceSha || "").trim().toLowerCase();
  if (!authoritative || !observed) return "UNKNOWN";
  return authoritative === observed ? "AUTHORITATIVE" : "OBSOLETE";
}

export const CHANGE_IMPACT_MATRIX = Object.freeze([
  Object.freeze({
    id: "DATABASE_SCHEMA",
    pattern: /(^|\/)(supabase|migrations?|database|db|schema)(\/|$)|\.sql$/i,
    qa_scope: "database_schema_migration",
    breadth: "BROAD"
  }),
  Object.freeze({
    id: "AUTH_RPC_SECURITY",
    pattern: /(^|\/|[-_.])(auth|rls|rpc|permission|security|policy)(\/|$|[-_.])/i,
    qa_scope: "auth_rpc_dependents",
    breadth: "BROAD"
  }),
  Object.freeze({
    id: "SHARED_DEPENDENCY",
    pattern: /(^|\/)(shared|components?\/shared|lib|utils?|hooks?)(\/|$)/i,
    qa_scope: "shared_dependents",
    breadth: "DEPENDENT"
  }),
  Object.freeze({
    id: "SCHEDULING_CALENDAR",
    pattern: /(calendar|schedule|scheduling|workforce|shift)/i,
    qa_scope: "scheduling_calendar",
    breadth: "TARGETED"
  })
]);

const BREADTH_RANK = Object.freeze({
  TARGETED: 1,
  DEPENDENT: 2,
  BROAD: 3
});

export function classifyChangeImpact(paths = []) {
  const normalized = Array.isArray(paths)
    ? paths.map((value) => String(value || "").trim()).filter(Boolean)
    : [];

  if (normalized.length === 0) {
    return {
      breadth: "BROAD",
      confidence: "LOW",
      qa_scopes: ["broad_regression_fallback"],
      matched_rules: [],
      fallback: true
    };
  }

  const matches = [];
  for (const path of normalized) {
    for (const rule of CHANGE_IMPACT_MATRIX) {
      if (rule.pattern.test(path)) {
        matches.push({ path, rule });
      }
    }
  }

  if (matches.length === 0) {
    return {
      breadth: "BROAD",
      confidence: "LOW",
      qa_scopes: ["broad_regression_fallback"],
      matched_rules: [],
      fallback: true
    };
  }

  const breadth = matches.reduce(
    (current, item) =>
      BREADTH_RANK[item.rule.breadth] > BREADTH_RANK[current]
        ? item.rule.breadth
        : current,
    "TARGETED"
  );

  return {
    breadth,
    confidence: matches.length >= normalized.length ? "HIGH" : "MEDIUM",
    qa_scopes: [...new Set(matches.map((item) => item.rule.qa_scope))],
    matched_rules: [...new Set(matches.map((item) => item.rule.id))],
    fallback: false
  };
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
    evidence.checkpoint_id ||
    evidence.workflow_name ||
    "UNKNOWN_MODULE"
  ).trim();

  return [workflow, gate, signature, relevantModule]
    .join("|")
    .replace(/\s+/g, "_")
    .slice(0, 190);
}

export function deriveFailureFingerprint(evidence = {}) {
  const root = deriveFailureRootKey(evidence);
  const commit = String(evidence.commit_sha || "NO_SHA").trim().toLowerCase();
  return `${root}|sha:${commit}`.slice(0, 240);
}

export function executionOptimizationPolicyLines() {
  return [
    "Execution optimization policy (internal only; do not change MAGASIN protocol, TASK_ID, NEXT_TASK_ID, or SOT task boundaries):",
    "Before launching durable CI, inspect the changed paths and dependency impact. Run the narrowest task-specific/impacted QA that is safe; if impact is uncertain, widen/fallback to broader regression rather than under-test.",
    "Change-impact baseline: calendar/schedule/workforce/shift paths -> scheduling/calendar QA; auth/RPC/RLS/security/policy paths -> auth plus dependent modules; database/schema/migrations/Supabase/SQL -> database/migration QA plus broad regression; shared components/lib/utils/hooks -> dependent-role/module QA; unknown or mixed impact -> broad fallback.",
    "Within this EXECUTE turn, repair targeted-QA failures immediately and rerun targeted QA until green before creating a release/full-regression candidate when the available tools allow it.",
    "When a QA/CI run has multiple failures, collect all currently available failing jobs/steps/log evidence before editing, group failures by root cause, and repair related failures as one batch.",
    "Prefer one coherent batch commit at a repair boundary. Do not create a commit merely because one file/update operation completed; when Git tree or multi-file commit tooling is available, use it.",
    "Do not launch required/full regression after every small edit. Launch required release/full regression only after targeted QA is green or a coherent RC candidate exists, while still running every SOT/project-required gate before COMPLETE.",
    "Distinguish PRODUCT REGRESSION from STALE TEST only from current SOT/code contract evidence. If a test is stale, update that test to authoritative behavior; never revert correct product behavior solely to satisfy historical assertions.",
    "When a newer commit supersedes an older task commit, treat the newer SHA as authoritative and do not keep waiting on obsolete runs. Cancel obsolete queued/in-progress non-release runs only when the provider supports it and cancellation is clearly safe; never cancel ambiguous release/production jobs.",
    "Use internal checkpoints only as runtime execution evidence. Never create checkpoint IDs as new SOT tasks and never substitute them for TASK_ID/NEXT_TASK_ID.",
    "When recording a failure, keep the stable root signature for loop comparison and the instance fingerprint with workflow/gate/error/module plus commit SHA; if job/test detail is known, encode it into the existing FAILURE_SIGNATURE token without changing the external-run block schema.",
    "If the same root failure repeats, use persisted fingerprint/attempt evidence to change repair strategy instead of repeating the identical repair indefinitely.",
    "Final required/full regression and exact-main verification remain mandatory whenever required by SOT/project policy; targeted QA never authorizes COMPLETE by itself."
  ];
}
