# H4 Control Center viewer release — authorization and field acceptance proposal

Date: 2026-10-14 Asia/Ho_Chi_Minh. Status: **PROPOSAL / NOT AUTHORIZED FOR APPLY**.
Authority: root `SOURCE_OF_TRUTH.md` on current `main`. MPC-010 currently authorizes SOURCE/QA only; this document does not supersede it. PR #443 merged as `0ec9c551c5b29901b1efb0389c60b90bf42f5cf3` with four exact-head CI PASS and final Codex clean, but this is **NOT** an H4 deployment approval.

## Owner requested outcome
Replace only the existing H4 Control Center viewer (not the Supervisor worker) so Owner can open the Vietnamese `Dự án` tree, browse MPC tasks and status evidence, and see STOP/UNKNOWN truth. Keep existing `STOP`, `AUTOSTART_DISABLED`, business-executor/worker HOLD, unrelated SC-013 local Gateway, existing SQLite, project authority, and SAYDI/SAPO state unchanged.

## Gate 0: separately approve scope in canonical root SOT
First land a distinct root-SOT-reviewed release authorization naming this exact 12-file viewer bundle, Windows identity `DESKTOP-H4A16IL\admin`, exact allowlisted target `D:\MAGASIN_ROBOTS\control-center`, hash-pinned source commit, field stage/backup/apply scripts, rollback and negative fixtures, separate scoped Owner acceptance. No other approved deployment workflow/script may be silently repurposed. No deployment merely from a PR merge. If approval not present, status HOLD and no stage or apply.

## Gate 1: source/code and dependency closeout
- Use current exact main SHA, not a previous head. Require four current hosted Supervisor CI PASS and independent Codex review of the release mechanism; no P1/P2 unresolved.
- Exact candidate content: `src/control-center/server.py`, `owner_request_drafts.py`, `project_tree_catalogue.py`, `supervisor_project_activation.py`, `web/app.js`, `web/index.html`, `web/styles.css`, four `web/project_*_view.mjs` or `web/project_supervisor_telemetry.mjs` modules, and `docs/project-control/MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md`. Use authoritative 12-file inventory in `src/control-center/mpc010_control_center_preflight.mjs`, not this prose as execution input.
- Verify all 12 candidate SHA-256 digest pins against exact GitHub blob bytes and final reviewed main. Preserve pinned availability/compatibility for six existing H4 auxiliary Python modules, plus Python 3.13 / psutil compatibility and the required environment. Do not assume `observability.py` or owner_lifecycle/control_adapter are portable GitHub assets.
- Test both checkout and H4 viewer-relative plan resolution, including project tree with nonempty canonical MPC entries, and fail-closed missing-plan state. New Owner request credential is NOT configured automatically.

## Gate 2: strictly read-only H4 field preflight
- H4 identity literal, existing local admin identity, canonical directory/root, no symlink/reparse/ambiguous mappings, exact current installed-file SHA hashes and any drift; STOP and AUTOSTART_DISABLED both physically present, unchanged.
- Check no ambiguity around any active worker, outbound once-only action, SQLite transaction, PID/control port, project switch or pending jobs. Fail closed on any unknown; do not retire, retry or cancel items.
- Check D free space and isolated backup destination, host-bound localhost `127.0.0.1:8781` only, exact process identity, no network exposure or credential change.
- Record signed/host-attributed inspection receipt; a synthetic Boolean is NOT real STOP or ownership proof.

## Gate 3: isolated backup and rollback rehearsal BEFORE apply
- Allowlisted isolated D backup of exact installed viewer files with SHA verification; preserve existing config and backup inventory even on failure. Explicit rollback manifest maps each old file to its exact path and digest.
- Dry-run restore into an isolated temporary directory, byte-for-byte parity; no modification of production files, work queues, STOP, SQLite or Supervisor wrappers.
- Abort if backup, restore test or compatibility smoke fails.

## Gate 4: separately authorized Owner-bound viewer APPLY
- Only after root SOT and release script approval, one explicit Owner-bound apply consent, current exact main, fresh field attestation and rollback readiness. Do not infer permission from a chat-only generic approval or source CI.
- Atomically replace only 12 allowlisted Control Center viewer/data files under `D:\MAGASIN_ROBOTS\control-center`; preserve six auxiliary modules and all unrelated files. Do not alter STOP/AUTOSTART_DISABLED, auto-start, task queue or Business Executor.
- Restart only the localhost viewer process at 8781 if needed, never Supervisor/coordinator/specialist workers. If any check fails, restore the old viewer and preserve evidence.

## Gate 5: Owner-facing post-apply acceptance
- Confirm `/healthz` 200, `/api/overview`, `/api/projects` with expected nonempty MPC task tree, `/api/owner/session` fail-closed without credentials, and all browser module routes 200 with correct JS MIME; verify no CSRF/auth bypass or external port binding.
- Confirm Vietnamese `Dự án` navigation, mobile-width keyboard/accessibility cases, status as UNKNOWN/STOP rather than false RUNNING, read-only telemetry and no dispatch button behavior.
- Exact installed 12-file digest readback and fresh STOP/AUTOSTART_DISABLED presence; independent Owner live visual acceptance (local machine; remote phone access is a separate network/security decision). Document rollback outcome and no new production task.
- Do NOT claim release DONE until all field evidence, reviewed root SOT updates and Owner acceptance are recorded.

## Current blockers
No current canonical SOT authority for MPC-010 H4 APPLY. No independent deploy script, reviewed backup/rollback rehearsal, freshly attested field safety, or final Owner live UI acceptance. This draft deliberately performs NONE of those actions. MPC-009 remains separately BLOCKED on SC-013 P1–P3/Owner approvals.
