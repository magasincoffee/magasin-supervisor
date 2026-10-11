# MAGASIN Auto-review and auto-merge — delegated policy implementation
Owner approval: 2026-10-11. Canonical authority: root `SOURCE_OF_TRUTH.md`, never this document.
## G0 — Policy and fixture checks
Only MPC-specific allowlisted source-only/project-read-model, docs and tests qualify for the initial low/medium **candidate** class. A changed SOT, GitHub workflow, auth, deployment, database, runtime, business code or an unrecognized path is HIGH and needs explicit Owner handling.
`assessAutoMergeGate` is pure and fail-closed: demands one exact immutable head SHA; all four hosted Supervisor CI runs GREEN at that head; clean completed independent Codex review at the head with zero unresolved comments; separate approved review from an authorized reviewer; branch-protection confirmation; enabled GitHub auto-merge; explicit delegation; no START/STOP/deployment/financial/credential or business mutation. Successful classification is **not** approval, merge, release or project DONE.
GitHub `allow_auto_merge=false` at inspection. GitHub App cannot read repo branch-protection rules (403). A valid independent approving reviewer is not currently configured for PR #409; Codex feedback there has four unresolved findings. Do not silently promote Codex COMMENTED to APPROVED.
## Rollout gates
- G0: SOT policy + pure decision engine + positive/negative fixtures; 4 required hosted CI GREEN; reviewed PR and exact-main. No auto-merge runtime changes.
- G1: read-only scheduled GitHub readiness audit, verified against real PR evidence and fail-closed on rate limit/authorization/stale head.
- G2: one-time repo Auto-merge setting and legitimate independent approver/App authorized by Owner, branch-protection verified. Do not relax protection or approval requirements.
- G3: only after G0–G2 and separate verified enablement, install automated request-to-merge executor, idempotent exact-head gating, GitHub-native merge protection and dry-run/live negative tests. An executor MUST NOT approve its own PR, self-merge on AI COMMENTED, or deploy.
- G4: observed autonomous MPC low/medium source-only cycle, exact-main verification and regression. Owner checkpoints remain on high-risk work and all live operations.
This is an incremental rollout; no pilot gate alone confers production or merge permission.
