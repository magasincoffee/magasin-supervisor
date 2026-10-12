# MPC-004 — Owner-facing project-tree UI, SOURCE/QA candidate
Authority: MAGASIN PROJECT CONTROL backlog on main; Supervisor ROOT SOT and each domain SOT remain separately authoritative.

## Implementation boundary
- Add the existing Control Center browser assets `src/control-center/web/index.html` and `styles.css`, previously missing from repository despite being served by `server.py`. This repairs static source packaging and supports the existing robot dashboard; there is **no H4 staging/apply or installed-product acceptance**.
- Add dedicated read-only navigation `/projects` and GET `/api/projects`. The GET only invokes `project_tree_catalogue.read_only_project_catalogue`; it does not call robot control, project selection, authentication mutations, remote execution or GitHub write operations.
- Catalogue is explicitly navigation/metadata only with 3 allowlisted project links (Supervisor, Workforce, independently governed OPS-WebApp). Only real existing MPC task IDs and names are read from the locally checked-out subordinate project plan. A missing/corrupt/duplicated local plan fails closed to an empty feature list; it does not invent status. **Every item remains `UNKNOWN` even when a local plan contains words such as VERIFIED.** Neither progress counts nor a completion claim are synthesized from that text. The current-main verified read model and per-project evidence integration will be added under MPC-005.
- The browser navigation exposes Vietnamese `Dự án`, project > feature > task tree, input search with accent/case-insensitive matching, collapse/expand with `aria-expanded`, selected breadcrumb, and canonical SOT links. Mobile layouts under 840px/430px use flexible wrapping and avoid nested horizontal scrolling. No task-edit, Owner intent submission, START, dispatch or SOT writeback appears here. A boolean pending-refresh latch ensures navigation to /projects during robot polling still loads the catalogue immediately after the current refresh. Until data arrives, an explicit loading message is shown. The existing `/robot/<id>` navigation and STOP logic are not modified.

## QA and release boundaries
Synthetic Node tests cover tree hierarchy, search, collapse, breadcrumb, XSS/URL sanitization, fail-closed unavailable states, asset routes, desktop/mobile CSS breakpoints and preservation of existing robot write-route boundaries. Python tests cover static allowlists, real task-ID parsing, duplicated/missing/bad UTF-8 SOT inputs and UNKNOWN statuses. Required four hosted Supervisor CI workflows at the exact head, independently reviewed PR, merge, exact-main readback are the source/QA completion gate.
This release does not deploy to local machines, authorize Supervisor START, or qualify operational acceptance.

## MPC-004 post-review route/accessibility checks
All browser-history popstate transitions revalidate the current destination via a read-only refresh, preventing stale robot actions after leaving the project view. Tree project/feature/task/breadcrumb selection now restores keyboard focus to the corresponding replacement button (or the search field if the selected root breadcrumb is no longer a button).

## Polling and screen-reader hardening
- Every automatic project-tree rerender captures the active search field (including caret selection) or project row/toggle key, then restores focus after rendering using the corresponding data attribute and `preventScroll`. Keyboard focus outside project content is not moved.
- The main interactive container is no longer an `aria-live` region; periodic status updates remain confined to the adjacent `role="status"` element. Neither change activates robot controls or writes project data.

## Announce route changes without poll noise
Client-side page navigation now has a separate visually hidden Vietnamese status node (not inside polled main) with aria-live polite. The application announces only explicit navigation (sidebar clicks/history popstate), not the 20-second refresh. This preserves the strict separation between navigation announcements and operational/verification status.

## Mainline reconciliation
The candidate is reconciled against the mainline Supervisor SOT cost-policy change dated 2026-10-12. Preserve that mainline authority and the improved historical MPC-002/003 test evidence. Historical proof tests must not lock a transient NEXT_TASK_ID; they now assert MPC-004's canonical task row rather than MPC-004 permanently remaining NEXT.
