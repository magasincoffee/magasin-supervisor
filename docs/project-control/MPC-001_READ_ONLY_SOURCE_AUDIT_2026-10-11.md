# MPC-001 — Read-only Control Center source audit
Date: 2026-10-11 (Asia/Ho_Chi_Minh)
Scope: source inspection only, no H4/runtime/production interaction.
Branch baseline: 90785ed60e8c1cb47a080b92b7602bb0de6e4800
Task authority: subordinate MPC backlog; SC-013 SOURCE_OF_TRUTH.md remains the only Supervisor authority.

## Verified exact paths / integration surface
- `src/control-center/server.py`: Python `ThreadingHTTPServer`, HOST `127.0.0.1`, PORT `8781`. GET `/healthz`, `/api/overview`, `/api/monitor`, `/api/robot/<allowlisted id>`, `/`, `/robot/<id>`, `/app.js`, `/styles.css`. POST `/api/supervisor/project/link`, `/api/supervisor/project/check`, `/api/supervisor/control`, `/api/coordinator/control`. No general project-tree route currently present.
- `src/control-center/web/app.js`: plain JS in-page renderer, browser history under `/robot/<id>`; `currentPage()`, `openPage()`, `refresh()`, `nav-robots` are the concrete extension seams. Display strings are Vietnamese. No independent read-model framework.
- `src/control-center/supervisor_project_links.py`: project-SOT link proposal registry; `PENDING_SOT_REVIEW` is not an active binding. `src/control-center/supervisor_project_activation.py`: NON-ACTUATING SOT preflight; neither is a canonical multi-project progress adapter.
- `src/control-center/cutover_preflight.py` and `docs/control-center/UNIFIED_CUTOVER_MATRIX_V1.json`: separated specialist read-only cutover/qualification evidence, not a task-completion authority.
- Browser served shell: `server.py` reads `src/control-center/web/index.html` and `styles.css`, but both paths returned GitHub 404 in this branch's contents API. **Resolve and verify asset packaging/source before any UI implementation/deployment.** `app.js` exists.
- Canonical current Supervisor constraints: `SOURCE_OF_TRUTH.md` SC-013/P1 source-and-QA-only, project selection and START not qualified. The subordinate MPC plan does not authorize those gates.

## Security boundary / blockers for later phases
- `Handler.do_GET` validates Host against localhost; `do_POST` additionally checks Origin, Sec-Fetch-Site, `X-MAGASIN-CSRF`, confirmation and per-endpoint payload length. CSRF token is generated in-process and exposed by `GET /api/overview` without a separate authenticated Owner session.
- Thus loopback restrictions/CSRF are **not** an Owner-vs-viewer authorization boundary. Any Owner-edit/write endpoint (MPC-006+) requires separately designed authenticated session, server-side Owner RBAC, audit, input validation/rate limits, attachment handling and CSRF; do not reuse the existing CSRF token as proof of Owner identity.
- For MPC-002/003, introduce a side-effect-free read model/adapter module, consumed by a dedicated `GET /api/projects` (and bounded detail GET) with fixed allowlist + revision/evidence provenance, rejecting ambiguous statuses as UNKNOWN/CONFLICT. Never call activation or control helpers from this GET; never expose tokens.
- For MPC-004/005, add a `Dự án` nav item and `/projects` / optional `/projects/<id>` browser history routes via existing `app.js` renderer; preserve current `/robot` navigation. Do not add mutation controls during read-only phases.
- Catalogue seed is metadata only: Supervisor repo/root SOT; Workforce repo/its own scheduling SOT; OPS-WebApp repo/root SOT strictly link-only and separated across auth/DB/roles/operations. Unknown external-project states remain UNKNOWN.
- Status dimensions must stay separate: task scope verified evidence, worker transport/heartbeat, actual CI, release/Owner acceptance. Never synthesize DONE from a PR closure or heartbeat.

## QA/release inventory
- Relevant existing fixtures: `test/sc013-supervisor-project-links-ui.test.mjs`, `test/sc013-control-center-consolidation-policy.test.mjs`, `test/sc013-project-activation-safe-preflight.test.mjs`, `test/test_sc013_supervisor_project_links.py`, `test/test_sc013_project_activation_preflight.py`.
- Hosted required gates: `.github/workflows/supervisor-tests.yml` (Supervisor Tests), `supervisor-integrity.yml` (Supervisor Integrity), `supervisor-lifecycle-acceptance.yml` (Supervisor Lifecycle Acceptance), `supervisor-autostart-install.yml` (Supervisor Autostart Install). On this branch their PR path filters include src/test/windows but not docs-only updates; docs-only work does not by itself trigger all four. Required gates must be explicitly evidenced at exact PR SHA before declaring release/merge qualified.
- Original G0 inventory was source-only. Follow-up acceptance requires MPC-001 Node contract in mandatory hosted CI at exact head; PR #407's four GREEN runs alone did not exercise that contract. No H4 readback, deployment or operational Owner acceptance is claimed.

## MPC-001 evidence and handoff
G0 deliverable: exact route/auth/files/test/workflow inventory and safe read-only seam, documented here. G0 **source audit VERIFIED** after PR #407 reviewed merge and exact-main readback (`7bd3ccf3b2349dfe6aa7ec71fed1429b07be7a64`), four hosted GREEN runs at head `a06690c81e00ab09e406021579f36e11022f3542`, and the MPC-001 scoped contract included in required CI in the follow-up verification candidate. This does not qualify production release, H4 apply, project selection, or Supervisor START.
Next dependency-eligible task after the reviewed/merged follow-up G0 record: **MPC-002** (SOURCE/QA ONLY). Do not execute MPC-002 within MPC-001.
