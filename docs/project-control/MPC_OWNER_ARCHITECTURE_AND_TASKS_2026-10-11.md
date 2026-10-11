# MAGASIN PROJECT CONTROL — Owner-approved architecture and execution backlog
Date: 2026-10-11 Asia/Ho_Chi_Minh
Status: OWNER APPROVED DESIGN; MPC-001 G0 VERIFIED (SOURCE/QA ONLY); MPC-002 NEXT, NOT STARTED
Authority: This is a subordinate implementation plan. `SOURCE_OF_TRUTH.md` is the sole authority for Supervisor SC-013. Every domain project retains its own canonical SOT. No content here grants START, production deployment, merge, business dispatch, or change to STOP/AUTOSTART_DISABLED.

## Owner outcome
An Owner-facing Vietnamese project tree inside the existing Supervisor Control Center. Owner can navigate business area > project > feature > task, see evidence-backed progress, click the exact feature to request a change in natural language with screenshots, and approve only real decision gates. GitHub and technical codes are behind the UI.

## Architecture boundaries
1. Reuse `src/control-center` rather than creating a second standalone application; inspect its existing routes, authentication and storage before coding.
2. READ-ONLY FIRST. Project catalogue and task projections only; never infer DONE from a closed PR, test fixture, old transcript or monitor heartbeat. Each visible status must link to latest verified canonical SOT/task plus relevant head/main and QA evidence; show UNKNOWN or CONFLICT when sources differ.
3. Each project retains a canonical SOT and repository, no new cross-project authority. `magasincoffee/OPS-WebApp` must remain independent from MAGASIN Coffee in auth, DB, roles, deployment and operations. Aggregation is metadata/link-only.
4. Supervisor SC-013 currently STOPPED; project selection P1 and autonomous execution P2–P6 are separately gated. Saving a project/SOT link means PENDING_SOT_REVIEW only, not selecting, dispatching, or START. Never revive retired XSTORE-019J outbound.
5. Phase-specific code changes: targeted QA, mandatory hosted CI (four Supervisor workflows at exact PR SHA), reviewed merge, exact-main, independently authorized H4 hash-pinned stage/apply/rollback and post-apply readback. No automatic production deployment or silent Owner STOP latch changes.
6. Protect auth: Owner-only mutation endpoints, authenticated sessions, server-side authorization, CSRF protection, audit records, request validation and limits; no credentials/tokens in UI/client. Viewer/editor boundary distinct from production executor authority.
7. Requests are immutable Owner intents with attachments/revision and explicit accept/reject; derived technical issues/tasks remain traceable, idempotent, deduplicated, linked to approved canonical SOT change where needed. Do not mutate canonical SOT automatically without the applicable gate.
8. Reporting separate dimensions: scope status (PLANNED/READY/IN_PROGRESS/BLOCKED/WAITING_OWNER/VERIFIED_DONE/UNKNOWN), worker transport status, actual CI status, release acceptance status. UI NEVER translates 'monitor alive' to 'work running' or 'CI GREEN' to Owner approved.

## Source contracts / inventory seed (not completion claims)
- Supervisor: `magasincoffee/magasin-supervisor` `SOURCE_OF_TRUTH.md`, SC-013, P1 next (SOURCE/QA ONLY), worker STOP.
- Workforce scheduling: `magasincoffee/magasincoffee.github.io`, `01_DOCS/MAGASIN/05_SYSTEM/WORKFORCE_CROSS_STORE_SCHEDULING_TEMP_SOURCE_OF_TRUTH.md`, XSTORE-019O pre-release incomplete, XSTORE-020 gated.
- Print-shop OPS: `magasincoffee/OPS-WebApp`, `SOURCE_OF_TRUTH.md`, architecture generation 4, explicitly independent.
- Other projects: DISCOVERY ONLY until their current canonical SOT/repository/revision is verified; do not assign fabricated statuses.

## Delivery tasks (small, serializable; each task requires scoped QA and evidence)
| ID | Dependency | Deliverable | Acceptance gate |
|---|---|---|---|
| MPC-001 (G0 VERIFIED) | none | Inspect Control Center routes/auth, build/release workflows, source inventory; document exact paths and authority | read-only audit, no write endpoints |
| MPC-002 | 001 | Canonical read model/schema for project > feature > task, revision/evidence/status separation | schema fixtures for UNKNOWN/conflicts |
| MPC-003 | 002 | Safe read-only GitHub/SOT adapter with allowlisted repositories and bounded caching/retries | 404/rate limit/stale/main-diverged fail visibly |
| MPC-004 | 003 | Owner-facing project tree UI, search, expand/collapse, breadcrumb | desktop/mobile UI QA, no writes |
| MPC-005 | 004 | Feature/task detail with authoritative links, status explanation, PR/CI/evidence provenance | reject synthetic DONE and unverified status |
| MPC-006 | 001,005 | Owner-only request draft form, screenshot references, idempotent submission with audit | CSRF/RBAC/duplicate/attachment validation |
| MPC-007 | 006 | Map approved Owner intents to draft issue/technical task and project-SOT change proposal; Owner approval gate | no unsolicited canonical SOT write or dispatch |
| MPC-008 | 005,007 | Supervisor read-only telemetry integration: STOP, selected SOT, pending gate, heartbeat vs actual work | prove STOP never appears as RUNNING |
| MPC-009 | 008 + separately qualified SC-013 P1–P3 | Dispatch proposal and task-cycle linkage under explicit authorization | no dispatch before separate Owner START & business executor gates |
| MPC-010 | 004–009 (as eligible) | Cross-role/accessibility/mobile/regression and protected release rehearsal | CI exact-head GREEN, reviewed PR, exact-main, Owner acceptance, authorized deployment only |

## Owner acceptance / operational UX
- Entry in existing Control Center navigation labeled `Dự án`.
- Owner chooses a feature, types Vietnamese request, optionally provides screenshot, selects priority, and submits. Technical IDs are hidden by default but preserved in audit.
- Summary shows `Đang thực hiện`, `Bị chặn`, `Cần Owner duyệt`, `Hoàn thành đã xác minh`; counts must derive from verifiable indexed items, never estimates.
- Owner can open one item and see: what was requested, date, what changed, links to SOT and PR, CI and preview, Owner approval status, actionable next step.
- Browser/mobile navigation usable without nested horizontal scrolling; missing data clearly marked unknown.
- A task is VERIFIED_DONE only on all project-specific definition-of-done gates; production is not implied by merge.

## Release gate sequence
G0: source audit and authority review (MPC-001)
G1: read model / adapter and failure-mode tests (002-003)
G2: UI readonly smoke + mobile + auth regression (004-005)
G3: safe request capture/dedupe/approval + security test (006-007)
G4: status truth/SC-013 compatibility and STOP fail-closed (008)
G5: conditional dispatch only after separately approved SC-013 operational gates (009)
G6: four required hosted Supervisor CI GREEN at exact head -> reviewed merge -> exact-main verification -> Owner-approved local stage/apply with rollback -> Owner acceptance (010).
A failing gate pauses only its dependent tasks; independent read-only functionality may progress.

## Immediate next work
After independently reviewed MPC-001 G0 audit acceptance, **MPC-002 is the sole next executable task (SOURCE/QA ONLY)**. MPC-002 may design the canonical read model/schema and fixtures, but cannot activate Supervisor, switch projects, deploy H4, introduce write endpoints or bypass the separate release/Owner gates.


## MPC-001 execution evidence (2026-10-11)

Source audit report: [MPC-001_READ_ONLY_SOURCE_AUDIT_2026-10-11.md](MPC-001_READ_ONLY_SOURCE_AUDIT_2026-10-11.md). The inspected baseline is 90785ed60e8c1cb47a080b92b7602bb0de6e4800. Inventory confirms existing Python loopback server and JS UI seam, no authenticated Owner RBAC for project write actions, and unresolved `web/index.html` / `web/styles.css` source-path 404s. **MPC-001 G0 source audit VERIFIED (not a deployed-product acceptance).** PR #407 approved and merged on 2026-10-11: exact PR head `a06690c81e00ab09e406021579f36e11022f3542`; four hosted Supervisor gates successful (`38149412397`, `38149412390`, `38149412395`, `38149412389`); reviewed squash merge `7bd3ccf3b2349dfe6aa7ec71fed1429b07be7a64`; exact-main audit file confirmed. No H4 installation or operational release is in scope for G0. Future product deployment/Owner acceptance remains separately gated. No Supervisor START, selection, dispatch, H4 apply, or production mutations performed. MPC-002 remains dependent on verified G0.
