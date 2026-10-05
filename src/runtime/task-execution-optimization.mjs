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

export function deriveFailureFingerprint(evidence = {}) {
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
    .slice(0, 240);
}

export function executionOptimizationPolicyLines() {
  return [
    "Execution optimization policy (internal only; do not change MAGASIN protocol, TASK_ID, NEXT_TASK_ID, or SOT task boundaries):",
    "Before launching durable CI, inspect the changed paths and dependency impact. Run the narrowest task-specific/impacted QA that is safe; if impact is uncertain, widen/fallback to broader regression rather than under-test.",
    "Within this EXECUTE turn, repair targeted-QA failures immediately and rerun targeted QA until green before creating a release/full-regression candidate when the available tools allow it.",
    "When a QA/CI run has multiple failures, collect all currently available failing jobs/steps/log evidence before editing, group failures by root cause, and repair related failures as one batch.",
    "Prefer one coherent batch commit at a repair boundary. Do not create a commit merely because one file/update operation completed; when Git tree or multi-file commit tooling is available, use it.",
    "Do not launch required/full regression after every small edit. Launch required release/full regression only after targeted QA is green or a coherent RC candidate exists, while still running every SOT/project-required gate before COMPLETE.",
    "Distinguish PRODUCT REGRESSION from STALE TEST only from current SOT/code contract evidence. If a test is stale, update that test to authoritative behavior; never revert correct product behavior solely to satisfy historical assertions.",
    "When a newer commit supersedes an older task commit, treat the newer SHA as authoritative and do not keep waiting on obsolete runs. Cancel obsolete queued/in-progress non-release runs only when the provider supports it and cancellation is clearly safe; never cancel ambiguous release/production jobs.",
    "Use internal checkpoints only as runtime execution evidence. Never create checkpoint IDs as new SOT tasks and never substitute them for TASK_ID/NEXT_TASK_ID.",
    "If the same root failure repeats, use persisted fingerprint/attempt evidence to change repair strategy instead of repeating the identical repair indefinitely.",
    "Final required/full regression and exact-main verification remain mandatory whenever required by SOT/project policy; targeted QA never authorizes COMPLETE by itself."
  ];
}
