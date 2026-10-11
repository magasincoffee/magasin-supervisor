# SC-013 — Owner-approved Supervisor autonomous operation roadmap
Date: 2026-10-11 (Asia/Ho_Chi_Minh)
Owner decision: approved P0–P6 execution in dependency order.
Authority: `SOURCE_OF_TRUTH.md` remains sole task authority. This roadmap is subordinate to that document and does not itself authorize Supervisor START, Owner STOP removal, task dispatch, or a project SOT switch.

## Baseline and invariants
- Target: `DESKTOP-H4A16IL`, Windows user `DESKTOP-H4A16IL\admin`.
- Architecture: Owner -> Coordinator/Robot Tổng -> Supervisor SINGLE_CONVERSATION_V1 -> local MCP -> dedicated Chrome ChatGPT -> QA/CI -> project SOT.
- Owner has selected the Chrome display profile `Toi123`, presently stored under Chrome directory `Profile 3`; do not silently use `Profile 7`.
- No OpenAI API dependency is approved; use existing browser/MCP architecture.
- The previous XSTORE-019J Supervisor session was deliberately retired and cold-archived. Its outbound must never be recovered as a new task or reissued.
- Owner `STOP` and `AUTOSTART_DISABLED` remain binding. No robot starts simply because a SOT link has been saved.
- Current Supervisor business execution and Coordinator dispatch remain unqualified. A monitoring heartbeat is not proof of work execution.
- Source changes: focused QA, four Supervisor hosted CI gates GREEN at exact PR head, reviewed merge, exact-main, pinned stage/backup, explicit narrow apply, independent live acceptance, rollback.
- Do not modify SAYDI/SAPO production workers, real finance/audio records, or unrelated Chrome profiles.

## P0 — Repair the SOT-link form (DONE: helper-only release; Owner screen visual optional)
**Issue:** `UNASSIGNED` after legitimate Owner unlink incorrectly caused `ACTIVE_SOT_NOT_QUALIFIED` and disabled the new SOT input.
**Source gate:** PR #394, merge commit `98561b262f046b59311033d999113d48795f21c5`; four hosted workflows GREEN; 15 Python tests and four JS UI tests passed.
**H4 R2 live acceptance:** 2026-10-11 16:10 +07. Release root `D:\MAGASIN_ROBOTS\deploy\sc013-unassigned-sot-link-r2\98561b262f046b59311033d999113d48795f21c5\`; receipt `apply-receipt.json` status `APPLIED_HELPER_ONLY_GREEN`.
- Live helper SHA256: `ae352eab4b6e5fe892bfe9fd1301120313b45c03ed605b9dbeec403cc4367acf`.
- Preserved rollback helper SHA256: `35b121c739027635761eef2cd7a345f8bb659ae55c6a676ccf5112bbe1ba517a`.
- Local Control Center `/healthz` HTTP 200; `/api/robot/supervisor`: `project_links.save_allowed=true`, `status=OWNER_UNLINKED_SAFE_TO_SAVE_LINK_REQUEST_ONLY`, `active=null`.
- `Supervisor=STOPPED`, `worker_start_allowed=false`, `business_dispatch_authorized=false`; STOP and AUTOSTART_DISABLED physically present; both live control and durable state SHA256 unchanged across APPLY.
**Remaining Owner-visible acceptance:** refresh the single Control Center screen and verify the new SOT input/button can be used. Do not invent or submit a project URL on the Owner's behalf.

## P1 — Verify and activate a new project (NEXT: SOURCE/DESIGN ONLY, NOT START)
Deliver a separate, reviewable Owner project-selection workflow after a **pending** canonical GitHub SOT proposal. Read the exact repo, `main` commit/revision and SOT, validate authority and READY task, select one project only, and create a fresh distinct conversation/session and exact-once identity. Reject missing/unverified SOT, multiple active bindings, Owner STOP removal not separately authorized, ambiguous historical outbound, active worker, divergent revision, foreign host and old retired-task reactivation. Preserve cold archive and allow reversible staging.
**Acceptance:** request can be validated and explicitly Owner approved without starting execution; pending is never treated as active. Produce separate selection QA and Owner-controlled activation proof. Do not infer Owner START from project selection.

## P2 — Qualify local Chrome transport and ChatGPT roundtrip
Only after exact `Toi123` Chrome profile verification and signed-in ChatGPT session, use local MCP/approved dedicated browser control. In an isolated test send the Owner-approved phrase `xin chào tôi là AI local` **once** and correlate rendered sent turn, response and durable transaction ledger. Preserve exact-once behavior on browser/profile mismatch, timeout, refresh, restart and ambiguous send. Require explicit evidence of a real response; assistant typing alone is not proof of local-AI dispatch.
**Acceptance:** one controlled send, response correlated, zero duplicates, logout/Chrome-close fail safely. No business execution authorization from this greeting.

## P3 — Qualify Coordinator and real business executor
Restore the canonical `DISCOVER -> EXECUTE -> CHECK -> COMPLETE` protocol with exactly one verified SOT READY task, task/source identity, idempotent checkpoints, bounded GitHub CI checks and task-scoped auto-repair. An independent Coordinator monitors and dispatches only after an approved authority gate; no legacy Planner/Executor reactivation, no unauthorized cross-project work.
**Acceptance:** at least two consecutive bounded task cycles from a **new approved project**, evidence for SOT selection, user message IDs, reply, source/PR/CI, verified completion and next-task advance. No task or response forgery.

## P4 — Repair Watchdog and bounded recovery
Diagnose the live `Watchdog=INTERNAL_ERROR`, with a safe read-only monitoring lane separate from project execution. Recover detectable Chrome/app/browser disconnects, server/robot process failures, resource waits, CI terminal failures and exhausted conversations under bounded retries/backoff. Unknown outbound never causes resend; STOP always blocks rearm; no endless CHECK on completed CI.
**Acceptance:** fault-injection suite for browser loss, offline network, Chrome identity mismatch, restart during send, ambiguous outbound, completed CI failure, stalled timer and insufficient RAM. Each case either recovers without duplicate side effects or transitions to an explicit Owner-required/blocking state.

## P5 — Continuous service and reboot semantics
Provide an Owner-readable Control Center status: selected SOT + revision, active task/checkpoint, phase, last valid heartbeat, last outbound/response, elapsed wait, CI job, repair attempt, stop reason, alerts and latest QA evidence. Test Windows startup/cold recovery with saved authority. Owner STOP remains STOP after reboot; a previously authorized run may auto-resume only when its identity/session/transaction evidence is valid. Keep monitoring independent from executable authority.
**Acceptance:** offline/online/reboot/power interruption acceptance without duplicate messages, project switch, spontaneous worker start while STOP, lost checkpoints or misleading RUNNING badges.

## P6 — Production E2E acceptance and Owner signoff
Run a controlled 72-hour observation after earlier gates GREEN, including at least two verified task cycles, one cold reboot, a browser/disconnect fault, a CI repair, dashboard evidence and STOP/START tests. Report time-to-recovery, duplicate-send count (must be zero), terminal stuck-wait count (must be zero), SOT authority and selected task revisions, worker uptime, unresolved Owner escalations and exact GitHub artifact links.
**Acceptance:** no major unhandled safety faults; no duplicate send or unauthorized dispatch; all recorded gates PASS and Owner explicitly accepts the evidence. Mark SC-013 COMPLETE only after this evidence exists, not on docs, isolated unit tests or an operational heartbeat.

## Workstream status / sequencing
- P0: **DONE, helper release accepted**; browser visual confirmation optional.
- P1: **NEXT — DESIGN/QA, project selection and authorization not qualified**.
- P2–P6: **BLOCKED BY PREDECESSOR**; work on source/tests may proceed independently but no production actuators.
- Overall SC-013: **IN_PROGRESS**.

## Execution optimization (preserve MAGASIN protocol)
Do one coherent code change for each tested surface. Run impacted/unit QA before broad suites. Avoid redundant GitHub Actions fanout, batch common-root repairs, query actual external run state with bounded adaptive checks, retry at most within SOT-approved limits, and never poll an already completed failed workflow indefinitely. Hosted full acceptance and exact-main checks still apply to every release gate.
