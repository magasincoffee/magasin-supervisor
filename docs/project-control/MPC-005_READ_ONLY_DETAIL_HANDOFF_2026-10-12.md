# MPC-005 — Read-only feature/task details: execution handoff
Date: 2026-10-12 (Asia/Ho_Chi_Minh)
Task authority: `docs/project-control/MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md` (MPC-005). This is **handoff planning**, not implementation, Owner acceptance, or production authorization.

## Desired Owner experience
Tap a project → feature → task in Control Center's **Dự án** tree. Show a compact Vietnamese detail panel explaining what the task is, the requested outcome, which SOT/revision governs it, what is verified versus unknown, the linked PR/CI/evidence and which human/system gate remains. Keep technical IDs secondary. Support mobile and keyboard without nested horizontal scroll. A missing/restricted source should visibly show **Chưa xác minh** or **Xung đột nguồn**; it must never become **Hoàn thành**.

## Authority and data boundaries
1. Read the existing source contracts `src/control-center/project_read_model.mjs` (MPC-002) and `src/control-center/project_sot_adapter.mjs` (MPC-003) from their verified `main` revisions. Reuse fail-closed status/evidence semantics instead of interpreting the local MPC-004 navigation catalogue as task truth.
2. The current `GET /api/projects` is **LOCAL_UNVERIFIED navigation-only**. Keep it that way until exact-revision, allowlisted canonical proof is implemented. The Python Control Center server currently does not invoke the Node GitHub/SOT adapter; before wiring a bounded detail reader, explicitly audit/process-boundary-test any bridge. Never place GitHub tokens in the browser, expose arbitrary repository paths or introduce Owner edit endpoints.
3. Show separate dimensions: scope completion/DoD, worker transport, hosted CI at exact head, merge/exact-main, Owner/release acceptance. A PR merge, a passing CI or a heartbeat alone proves none of the other dimensions.
4. Each domain retains its own canonical SOT; OPS-WebApp remains independent. Any unsupported or contradictory source stays UNKNOWN/CONFLICT; no fabricated DONE or cross-project auth/DB/dispatch.
5. Keep Supervisor STOP/AUTOSTART_DISABLED, project selection, H4 apply, deployment, business dispatch and Owner mutation flows outside MPC-005.

## Proposed task-sized SOURCE/QA acceptance checkpoints (not new SOT task IDs)
- Inventory current detail projection + allowed sources, links and target routes; document status definitions and their negative cases.
- Implement strictly read-only detail projection for an allowlisted selected project/feature/task, with safe navigable SOT/PR/CI/evidence links, pinned source revision, and explicit unverifiable/404/rate-limit/main-diverged errors.
- Add synthetic fixtures for truthful UNKNOWN/CONFLICT, proof-backed VERIFIED_DONE, stale version divergence, hostile HTML/URLs, cross-project isolation and mobile keyboard flow; verify the route remains read-only.
- Require scoped tests, **all four** hosted Supervisor CI workflows GREEN on exact PR head, independent review, reviewed merge and exact-main verification. Local stage/apply or operational acceptance require **separate Owner approval**.

This handoff creates no new task, starts no MPC-005 code, and does not change Supervisor runtime.
