# MIG-007 — Final Cleanup / Old Embedded Supervisor Deprecation Authority

Status: **AUTHORIZED / READY FOR EXECUTION / NOT EXECUTED**  
Authority task: `MIG-007-AUTHORITY-CLOSURE`  
Execution task: `MIG-007-EXECUTION-FINAL-CLEANUP`  
Authority baseline: `magasincoffee/magasin-supervisor@12a4a922886924e2a9dd482e21f48469174b642c`  
Read-only Business OS scan: `magasincoffee/magasincoffee.github.io@3d7d819969f605df826b91e0e69df7bf62e2d3a0`

## Authority effect

This document authorizes the **scope and execution order only** for MIG-007 final cleanup. It does not execute cleanup and does not mark MIG-007 complete.

MIG-007 may become `COMPLETE` only after the separate execution task removes the authorized legacy surface, reconciles the retained references/current Business OS migration state, passes both repositories' required gates, and publishes closure evidence.

## Satisfied dependency gate

The old plan's dependency gate is satisfied:

- MIG-005 production cutover: **COMPLETE**, `production_cutover=true`, one production ownership authority independently proven.
- MIG-006: **COMPLETE / QUALIFIED**.
- TASK-RBT-009: **COMPLETE / RELEASED**.
- `RBT009_TIER_B_480M=PASS`.
- qualifying workflow run: `35860156388`.
- Tier-B job: `107180300345`.
- verified duration: `28843` seconds.
- sample count: `240`.
- current MIG-006 closure evidence: `docs/MIG_006_RBT009_CANONICAL_CLOSURE.json`.

No Tier-B rerun is required or authorized by MIG-007.

## Revalidated cleanup inventory

The Business OS source repository was re-scanned read-only after MIG-006 closure.

Current legacy executable surface:

- `08_INTEGRATIONS/supervisor/**`: **123 files**
- `.github/workflows/supervisor-*.yml`: **8 files**
- `.github/scripts/supervisor-*`: **6 files**
- total authorized deletion inventory: **137 files**

The live 137-path set exactly matches the frozen MIG-001 machine map:
`01_DOCS/MAGASIN/08_AUTONOMY/SUPERVISOR_MIGRATION_V1_FILE_MAP.json`.

There are **0 missing** and **0 extra** paths relative to that frozen inventory. The exact path list is machine-readable in `docs/MIG_007_AUTHORITY_MANIFEST.json`.

### Supervisor workflows in the 137-file delete set

1. `.github/workflows/supervisor-autostart-install.yml`
2. `.github/workflows/supervisor-cancel-stale-run.yml`
3. `.github/workflows/supervisor-integrity.yml`
4. `.github/workflows/supervisor-lifecycle-acceptance.yml`
5. `.github/workflows/supervisor-open-control-panel.yml`
6. `.github/workflows/supervisor-rbt009-soak.yml`
7. `.github/workflows/supervisor-state-maintenance.yml`
8. `.github/workflows/supervisor-tests.yml`

### Supervisor scripts in the 137-file delete set

1. `.github/scripts/supervisor-integrity-registry.ps1`
2. `.github/scripts/supervisor-rbt009-soak-lib.ps1`
3. `.github/scripts/supervisor-rbt009-soak-strictmode-tests.ps1`
4. `.github/scripts/supervisor-rbt009-soak.ps1`
5. `.github/scripts/supervisor-release-event-validator.mjs`
6. `.github/scripts/supervisor-state-maintenance-regression.ps1`

## Retained Business OS boundary

The MIG-001 frozen map explicitly retains five Business OS-owned files. MIG-007 does **not** delete them:

- `01_DOCS/MAGASIN/00_PROJECT_STATE.json`
- `01_DOCS/MAGASIN/00_TASK_QUEUE.md`
- `01_DOCS/MAGASIN/00_SUPERVISOR_THREE_LANE_ARCHITECTURE.md`
- `01_DOCS/MAGASIN/00_MAGASIN_LANE_DIRECTIVE_V1_PROTOCOL.md`
- `01_DOCS/MAGASIN/08_AUTONOMY/SUPERVISOR_REPOSITORY_MIGRATION_V1.md`

Historical MIG-001 through MIG-006 evidence, the frozen file map, QA logs, Git history, and business-domain state remain reviewable.

## Retained-reference reconciliation required during execution

Read-only inspection found two current reconciliation classes outside the 137-file deletion set.

1. `01_DOCS/MAGASIN/00_SUPERVISOR_THREE_LANE_ARCHITECTURE.md`
   - currently contains two links to `08_INTEGRATIONS/supervisor/docs/ROBOT_BROWSER_SCHEDULER_OBSERVABILITY_ARCHITECTURE.md`;
   - execution must replace those live-path references with the independent-repository canonical document or a clearly historical pointer.

2. `01_DOCS/MAGASIN/00_PROJECT_STATE.json`
   - currently still reports MIG-006 as active/in-progress and MIG-007 blocked;
   - that source state is stale relative to canonical target-repository closure;
   - execution must reconcile the Business OS migration state only after/with the authorized cleanup, without rewriting historical MIG-001 through MIG-006 evidence.

`01_DOCS/MAGASIN/08_AUTONOMY/SUPERVISOR_REPOSITORY_MIGRATION_V1.md` remains migration history/authority and may receive a bounded final-closure appendix during execution. Its historical phase descriptions must not be rewritten as though they were current snapshots.

The eight non-Supervisor Business OS workflows were also scanned. None references the embedded Supervisor executable path. `.github/workflows/night-run-hard-stop.yml` contains business-semantic text about “Supervisor continuation,” not executable coupling, and is outside deletion scope.

## Project-adapter boundary

The independent repository remains project-agnostic through `supervisor-project-adapter.v1`:

- implementation: `src/project-adapter.mjs`;
- tests: `test/project-adapter.test.mjs`;
- documentation: `docs/PROJECT_ADAPTER_V1.md`;
- exactly one explicit PATH or URL source is required;
- missing adapter input fails closed;
- no default Business OS repository or PROJECT_STATE path is allowed.

MIG-003 coupling evidence records direct PROJECT_STATE runtime coupling, old repository identity, and embedded repository-root coupling as closed. MIG-007 must not move Business OS business truth into the Supervisor repository.

## Rollback boundary

MIG-007 execution closes the **active source-code rollback window** in the Business OS default branch by removing the 137-file executable copy.

It does not erase Git history and does not delete machine-local rollback metadata, production state, browser profile, secrets, or other local recovery material. Any local recovery-material deletion requires separate explicit authority.

## Authorized execution order

1. Re-read canonical `docs/MIG_007_AUTHORITY_MANIFEST.json` and verify status is `AUTHORIZED_READY_FOR_EXECUTION`, not complete.
2. Re-scan both repository heads read-only. If the 137 delete-path set or coupling boundary has drifted, fail closed and update authority before expanding scope.
3. Create a dedicated Business OS cleanup branch/PR.
4. Delete **exactly** the 137 authorized legacy executable paths.
5. Reconcile only the retained current-reference/state surfaces identified by the authority manifest; preserve historical migration evidence.
6. Verify no active Business OS path, workflow, script, installer, runtime entry point, or release truth still points to the removed embedded implementation.
7. Run Business OS regression/integrity gates.
8. Run `magasin-supervisor` tests/integrity to prove the independent repository remains authoritative.
9. Merge source cleanup only when required checks pass and repository policy permits it.
10. Publish sanitized MIG-007 execution/closure evidence in `magasin-supervisor`.
11. Only after execution evidence is merged may MIG-007 and `MAGASIN_SUPERVISOR_INDEPENDENT_REPOSITORY_V1` be marked complete.

## Definition of Done for MIG-007 execution

MIG-007 is complete only when all of the following are proven:

- all 137 authorized legacy executable paths are absent from Business OS main;
- no Supervisor-only workflow remains active in Business OS;
- no Supervisor-only GitHub script remains active in Business OS;
- no active embedded Supervisor implementation remains under `08_INTEGRATIONS/supervisor/**`;
- retained current references no longer point to removed executable paths;
- Business OS current migration state no longer claims MIG-006 is active;
- frozen migration/history evidence remains reviewable;
- the explicit `supervisor-project-adapter.v1` boundary remains intact;
- `magasin-supervisor` remains the sole active Supervisor code/release source;
- Business OS regression/integrity checks are green after deletion;
- target-repository tests/integrity are green;
- the active source-code rollback window is explicitly closed while Git history remains intact;
- no lane, Brain/Work URL, dispatch/relay latch, browser profile, secret, runner configuration, autostart, local production state, Owner STOP, or production authority is mutated by the cleanup;
- no second production authority or split-brain condition is introduced;
- canonical closure evidence is merged.

## Hard safety

This authority task and its merge do **not**:

- delete any of the 137 legacy files;
- mutate `magasincoffee/magasincoffee.github.io`;
- enable a lane;
- issue Owner START;
- start/stop/restart Supervisor production runtime;
- mutate Brain/Work URLs, lane state, latches, browser profile, secrets, runner configuration, autostart, local production files, or production authority;
- rerun MIG-006/RBT-009 Tier B;
- rewrite historical MIG-005/MIG-006 snapshots;
- authorize scope expansion beyond the revalidated inventory and explicitly listed retained-reference reconciliation.

## Next canonical task

After this authority document is merged, the exact next task is:

`MIG-007-EXECUTION-FINAL-CLEANUP` — **READY / NOT STARTED**

That task is authorized to execute the bounded cleanup above. It must return separate execution evidence before MIG-007 can become `COMPLETE`.
