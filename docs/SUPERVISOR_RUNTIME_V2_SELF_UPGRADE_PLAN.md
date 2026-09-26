# Supervisor Runtime V2 — Self-Upgrade Execution Plan

Status: **PLANNED / NOT DEPLOYED**  
Owner authority: **deployment requires an explicit Owner request**  
Execution mode: **Robot may modify Supervisor on an isolated branch and run CI/verification, but may not deploy itself**  
Source-of-Truth sync baseline: `1b5779fb1652e691f25cc5f0f5b586a74b1fc012`
SV2-P0-E1 execution sync: **READY_FOR_VERIFY** from planning PR #99 / head `f5d93822ca66e5baad3e4bb75cf8c56e2c063b12`; implementation branch `sv2/sv2-p0-e1-source-of-truth-sync-20260926`.

## Objective

Upgrade MAGASIN Supervisor toward `Observer → Correlator → Pure Reducer → Durable Transition → Effect Executor → Confirmation → Next State`, while preserving exact-once behavior, restart safety, active-lane protection, and Owner deployment authority.

## Non-negotiable safety rules

1. **No automatic production deploy.** Robot may create branches, commits, tests, PRs, diagnostics, and verification evidence, but must stop at `READY_FOR_OWNER_DEPLOY`.
2. **Protect active lanes.** Do not interrupt `dispatch_inflight`, `relay_inflight`, an unconsumed Work result, or an unsafe mutation boundary.
3. **Minimal downtime.** Prefer source hotpatch / Three-Lane child replacement; wrapper restart only when required; Chrome restart is last resort.
4. **Exact-once remains authoritative.** Preserve Brain → Work → RESULT → VERIFY → ACCEPT/REJECT → NEXT PLAN and correlate mutations to durable identities.
5. **Owner STOP always wins.**

## Brain operating contract

- Select exactly one bounded task at a time from this ordered roadmap.
- Prefer approximately 10–20 minutes of active implementation when safely decomposable.
- VERIFY evidence before ACCEPT/REJECT and before starting any next task.
- Development may continue without production impact; disruptive steps are `DEFER_UNTIL_OWNER_DEPLOY`.
- `deployment_authority=OWNER_EXPLICIT_ONLY`; no plan text authorizes merge/deploy/hotpatch by itself.

## Granular roadmap

### SV2-P0-E — Repository Source-of-Truth cleanup

Priority: **P0** · Broad estimate retained: **1–2 hours** · Production impact during development: **none**.

- [ ] `SV2-P0-E1` — Synchronize repository Source of Truth with granular Runtime V2 roadmap
### SV2-P0-A — Runtime V2 state-machine extraction

Priority: **P0** · Broad estimate retained: **6–9 hours** · Production impact during development: **none**.

- [ ] `SV2-P0-A1` — Inventory current runtime responsibilities and parity fixtures
- [ ] `SV2-P0-A2` — Extract observation boundary
- [ ] `SV2-P0-A3` — Extract correlation boundary
- [ ] `SV2-P0-A4` — Define pure reducer transition contract
- [ ] `SV2-P0-A5` — Add durable transition adapter
- [ ] `SV2-P0-A6` — Extract effect executor
- [ ] `SV2-P0-A7` — Add confirmation stage
- [ ] `SV2-P0-A8` — Rewire compatibility shell
- [ ] `SV2-P0-A9` — Pass state-machine parity regression gate
### SV2-P0-B — End-to-end causality and trace correlation

Priority: **P0** · Broad estimate retained: **3–4 hours** · Production impact during development: **none**.

- [ ] `SV2-P0-B1` — Define causal identifier schema
- [ ] `SV2-P0-B2` — Correlate Brain request to directive
- [ ] `SV2-P0-B3` — Correlate directive to Work dispatch
- [ ] `SV2-P0-B4` — Correlate dispatch to Work result
- [ ] `SV2-P0-B5` — Correlate Work result to Brain relay
- [ ] `SV2-P0-B6` — Correlate Brain relay to verdict
- [ ] `SV2-P0-B7` — Persist and reconcile trace chain across restart
- [ ] `SV2-P0-B8` — Reject stale cross-task responses
- [ ] `SV2-P0-B9` — Expose privacy-safe trace diagnostics
- [ ] `SV2-P0-B10` — Pass causality regression gate
### SV2-P0-C — Dispatch self-heal and bounded repair escalation

Priority: **P0** · Broad estimate retained: **4–6 hours** · Production impact during development: **none**.

- [ ] `SV2-P0-C1` — Reconcile self-heal prerequisites with issues #62-#68
- [ ] `SV2-P0-C2` — Emit heartbeat and progress evidence
- [ ] `SV2-P0-C3` — Emit no-progress warning after 180 seconds
- [ ] `SV2-P0-C4` — Transition eligible work to STALLED after 300 seconds
- [ ] `SV2-P0-C5` — Persist bounded recovery-attempt state
- [ ] `SV2-P0-C6` — Reconcile durable and GitHub truth before every retry
- [ ] `SV2-P0-C7` — Choose safe resume, resend, or Work-replacement action without blind mutation
- [ ] `SV2-P0-C8` — Enter maintenance lock and create one bounded repair incident after recovery exhaustion
- [ ] `SV2-P0-C9` — Require Brain VERIFY/ACCEPT for Supervisor repair result
- [ ] `SV2-P0-C10` — Resume frozen product task from reconciled durable state after accepted repair
- [ ] `SV2-P0-C11` — Provide rollback path and pass induced-stall/restart acceptance
### SV2-P0-D — ChatGPT DOM compatibility layer

Priority: **P0** · Broad estimate retained: **3–4 hours** · Production impact during development: **none**.

- [ ] `SV2-P0-D1` — Capture current ChatGPT DOM fixture corpus
- [ ] `SV2-P0-D2` — Define selector profile and capability contract
- [ ] `SV2-P0-D3` — Implement modern message-turn adapter
- [ ] `SV2-P0-D4` — Implement legacy fallback message-turn adapter
- [ ] `SV2-P0-D5` — Select adapters by ordered capability detection
- [ ] `SV2-P0-D6` — Fail closed with explicit DOM_UNSUPPORTED state
- [ ] `SV2-P0-D7` — Add bounded DOM recovery without reload storms
- [ ] `SV2-P0-D8` — Pass DOM compatibility fixture and regression gate
### SV2-P0-E — Repository Source-of-Truth cleanup

Priority: **P0** · Broad estimate retained: **1–2 hours** · Production impact during development: **none**.

- [ ] `SV2-P0-E2` — Verify PR #80 supersession against main and reconcile disposition
- [ ] `SV2-P0-E3` — Verify PR #95 supersession against main and reconcile disposition
- [ ] `SV2-P0-E4` — Reconcile PR #15 and issues #62-#68 against main without losing parent history
- [ ] `SV2-P0-E5` — Consolidate canonical Runtime V2 roadmap references for Brain and Robot
- [ ] `SV2-P0-E6` — Validate Source-of-Truth consumers and stale-plan guards
### SV2-P1-A — Pipeline latency telemetry

Priority: **P1** · Broad estimate retained: **3–5 hours** · Production impact during development: **none**.

- [ ] `SV2-P1-A1` — Define canonical latency stage timestamps
- [ ] `SV2-P1-A2` — Instrument Brain response completion to detection latency
- [ ] `SV2-P1-A3` — Instrument Work dispatch intent to confirmed-send latency
- [ ] `SV2-P1-A4` — Instrument Work response completion to capture and Brain relay latency
- [ ] `SV2-P1-A5` — Instrument Brain relay to verdict and next-directive latency
- [ ] `SV2-P1-A6` — Persist and aggregate latency telemetry
- [ ] `SV2-P1-A7` — Expose current-step latency telemetry in Control Center
- [ ] `SV2-P1-A8` — Pass telemetry regression gate
### SV2-P1-B — Priority and event-assisted scheduler

Priority: **P1** · Broad estimate retained: **4–6 hours** · Production impact during development: **none**.

- [ ] `SV2-P1-B1` — Define scheduler priority contract
- [ ] `SV2-P1-B2` — Add event-assisted wakeup for result-ready and relay confirmation
- [ ] `SV2-P1-B3` — Add event-assisted wakeup for dispatch confirmation and send recovery
- [ ] `SV2-P1-B4` — Add event-assisted wakeup for Brain directive adoption
- [ ] `SV2-P1-B5` — Add idle-planning wakeup path
- [ ] `SV2-P1-B6` — Keep bounded polling watchdog fallback with fairness
- [ ] `SV2-P1-B7` — Pass scheduler priority and recovery regression gate
### SV2-P1-C — Transaction revision and recovery journal

Priority: **P1** · Broad estimate retained: **3–5 hours** · Production impact during development: **none**.

- [ ] `SV2-P1-C1` — Add monotonic state_revision
- [ ] `SV2-P1-C2` — Add append-only transition journal
- [ ] `SV2-P1-C3` — Persist transition intent before effect execution
- [ ] `SV2-P1-C4` — Confirm effects against journaled transition identity
- [ ] `SV2-P1-C5` — Resume from last committed transition after crash or restart
- [ ] `SV2-P1-C6` — Migrate ambiguous boolean combinations toward explicit transition states
- [ ] `SV2-P1-C7` — Pass crash/restart journal regression gate
### SV2-P1-D — Control Center WHY NOT MOVING view

Priority: **P1** · Broad estimate retained: **3–5 hours** · Production impact during development: **none**.

- [ ] `SV2-P1-D1` — Define WHY NOT MOVING projection contract
- [ ] `SV2-P1-D2` — Project current step, waiting-for reason, and state age
- [ ] `SV2-P1-D3` — Project retry count and last confirmed action
- [ ] `SV2-P1-D4` — Project safe reason code and project progress
- [ ] `SV2-P1-D5` — Project runtime, process, and CDP truth independently
- [ ] `SV2-P1-D6` — Render WHY NOT MOVING in Control Center
- [ ] `SV2-P1-D7` — Pass Control Center observability regression gate
### SV2-P1-E — Event and log lifecycle hardening

Priority: **P1** · Broad estimate retained: **2–3 hours** · Production impact during development: **none**.

- [ ] `SV2-P1-E1` — Define bounded append-only event segment rotation
- [ ] `SV2-P1-E2` — Normalize correlation fields across runtime diagnostics
- [ ] `SV2-P1-E3` — Enforce privacy-safe redaction for chat bodies, tokens, and private URLs
- [ ] `SV2-P1-E4` — Reconstruct incidents from sanitized identifiers and timestamps
- [ ] `SV2-P1-E5` — Pass rotation, boundedness, and privacy regression gate
### SV2-P1-F — Runtime identity and canonical state-root cleanup

Priority: **P1** · Broad estimate retained: **2–3 hours** · Production impact during development: **none**.

- [ ] `SV2-P1-F1` — Expose exact runtime Git SHA and build manifest
- [ ] `SV2-P1-F2` — Audit canonical Supervisor state root
- [ ] `SV2-P1-F3` — Define migration-safety guard for legacy BusinessOS fallback
- [ ] `SV2-P1-F4` — Remove state-root ambiguity after migration guard passes
- [ ] `SV2-P1-F5` — Pass runtime identity and state-root regression gate
### SV2-P2 — Optional fast browser executor

Priority: **P2** · Broad estimate retained: **6–10 hours** · Production impact during development: **none**.

- [ ] `SV2-P21` — Define optional executor benchmark harness
- [ ] `SV2-P22` — Implement optional fast executor adapter behind feature gate
- [ ] `SV2-P23` — Preserve current Chromium/CDP executor as fallback
- [ ] `SV2-P24` — Compare correctness, latency, and recovery parity
- [ ] `SV2-P25` — Pass optional-executor acceptance gate
### DEPLOY — Owner deployment gate

- [ ] `SV2-DEPLOY` — Owner-authorized production deployment and live acceptance


## Supersession audit

This is a **proposed reconciliation audit only**. This task does not close, merge, or otherwise mutate any PR or issue.

| Item | Observed state | Proposed status | Evidence / note |
|---|---|---|---|
| PR #80 | OPEN | `CANDIDATE_SUPERSEDED_BY_MAIN` | Main `1b5779fb1652e691f25cc5f0f5b586a74b1fc012` contains Owner-resume fresh-project-review behavior and regression coverage. |
| PR #95 | OPEN | `CANDIDATE_SUPERSEDED_BY_MAIN` | Main `1b5779fb1652e691f25cc5f0f5b586a74b1fc012` contains blocker recheck/whole-plan rescan behavior and regression coverage; exact scheduling/backoff semantics still require reconciliation before disposition. |
| PR #15 | OPEN DRAFT | `PARENT_SELFHEAL_REFERENCE` | Keep as parent/self-heal reference; no state change in this task. |
| PR #13 | OPEN DRAFT | `FUTURE_OPTIONAL_EXECUTOR` | Keep as future optional executor reference; no state change in this task. |
| Issue #62 | OPEN | `BACKLOG_RECONCILE_NO_CLOSE` | SUP-SELFHEAL-P2 — Owner/AUTO Work target policy; reconcile by evidence, do not close in this task. |
| Issue #63 | OPEN | `BACKLOG_RECONCILE_NO_CLOSE` | SUP-SELFHEAL-P3 — Automatic Work replacement; reconcile by evidence, do not close in this task. |
| Issue #64 | OPEN | `BACKLOG_RECONCILE_NO_CLOSE` | SUP-SELFHEAL-P4 — Runtime/status self-heal; reconcile by evidence, do not close in this task. |
| Issue #65 | OPEN | `BACKLOG_RECONCILE_NO_CLOSE` | SUP-SELFHEAL-P5 — Control Panel observability; reconcile by evidence, do not close in this task. |
| Issue #66 | OPEN | `BACKLOG_RECONCILE_NO_CLOSE` | SUP-SELFHEAL-P6 — RESET WORK STATE UI completion; reconcile by evidence, do not close in this task. |
| Issue #67 | OPEN | `BACKLOG_RECONCILE_NO_CLOSE` | SUP-SELFHEAL-P7 — Persistent sanitized diagnostics; reconcile by evidence, do not close in this task. |
| Issue #68 | OPEN | `BACKLOG_RECONCILE_NO_CLOSE` | SUP-SELFHEAL-P8 — Dispatch watchdog, heartbeat, bounded recovery, and repair escalation; reconcile by evidence, do not close in this task. |

## Deployment gate

The self-upgrade project stops at `READY_FOR_OWNER_DEPLOY` after selected work is verified. `SV2-DEPLOY` may execute only after an explicit Owner instruction. The deployment plan must state exact main/head SHA, active-lane safety state, restart scope, expected interruption, rollback path, and post-deploy live acceptance checks.
