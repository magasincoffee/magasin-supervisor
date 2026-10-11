// MAGASIN AUTO-REVIEW gate (policy v1). Pure classification, NEVER merges or approves.
export const REQUIRED_CI = Object.freeze(["Supervisor Tests", "Supervisor Integrity", "Supervisor Lifecycle Acceptance", "Supervisor Autostart Install"]);
export const POLICY_VERSION = "MAGASIN_AUTOREVIEW_V1";
const sha = v => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const allowed = path => {
  if(typeof path !== "string" || path.includes("..") || path.startsWith("/")) return "HIGH";
  if(/^test\/mpc[0-9]{3}[-\w]*\.test\.mjs$/.test(path)) return "LOW";
  if(/^docs\/project-control\/MPC-[0-9]{3}_[A-Z0-9_-]+\.md$/.test(path)) return "LOW";
  if(path === "src/control-center/project_read_model.mjs") return "MEDIUM";
  return "HIGH"; // SOT, workflows, auth, SQL, worker, deployment, and unknown paths fail closed
};
export function classifyPaths(files) {
  if(!Array.isArray(files) || files.length === 0 || files.length > 100 || new Set(files).size !== files.length) return "HIGH";
  const risks=files.map(allowed);
  return risks.includes("HIGH") ? "HIGH" : risks.includes("MEDIUM") ? "MEDIUM" : "LOW";
}
export function assessAutoMergeGate(input) {
  const x=input && typeof input === "object" ? input : {};
  const risk=classifyPaths(x.files);
  const reasons=[];
  if(risk === "HIGH") reasons.push("OWNER_REQUIRED_HIGH_OR_UNCLASSIFIED_CHANGE");
  if(!sha(x.headSha) || x.base !== "main" || x.state !== "open" || x.draft !== false || x.author !== "magasincoffee") reasons.push("INVALID_PR_SCOPE_OR_HEAD");
  if(x.explicitDelegation !== true) reasons.push("DELEGATION_NOT_VERIFIED");
  const checks=Array.isArray(x.ciRuns) ? x.ciRuns : [];
  for(const name of REQUIRED_CI) {
    const hits=checks.filter(r=>r && r.name === name && r.headSha === x.headSha);
    if(hits.length === 0 || !hits.some(r=>r.status === "completed" && r.conclusion === "success") || hits.some(r=>r.status === "completed" && r.conclusion !== "success")) reasons.push("CI_NOT_GREEN_"+name.replaceAll(" ","_").toUpperCase());
  }
  const ai=x.aiReview||{};
  if(ai.provider !== "chatgpt-codex-connector" || ai.completed !== true || ai.headSha !== x.headSha || ai.unresolvedThreads !== 0 || ai.reviewHasFindings === true) reasons.push("AI_REVIEW_NOT_CLEAN_AT_HEAD");
  const approvals=Array.isArray(x.approvals) ? x.approvals : [];
  if(!approvals.some(a=>a && a.state === "APPROVED" && a.headSha === x.headSha && a.author && a.author !== x.author && a.author !== "github-actions[bot]")) reasons.push("INDEPENDENT_APPROVAL_NOT_VERIFIED");
  if(x.changesRequested === true) reasons.push("CHANGES_REQUESTED");
  if(x.branchProtectionPassed !== true) reasons.push("GITHUB_BRANCH_PROTECTION_UNVERIFIED");
  if(x.autoMergeEnabled !== true) reasons.push("GITHUB_AUTOMERGE_DISABLED");
  if(x.releaseOrStartRequested === true) reasons.push("PRODUCTION_OR_START_REQUIRES_OWNER");
  return Object.freeze({version:POLICY_VERSION,risk,decision:reasons.length?"HOLD":"ELIGIBLE_FOR_AUTOMERGE",reasons});
}
