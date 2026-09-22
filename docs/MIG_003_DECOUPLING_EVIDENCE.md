# MIG-003 — Business OS Coupling Decoupling Evidence

Status: **TARGET IMPLEMENTATION DONE / EXACT-MAIN HOSTED GATES GREEN / BUSINESS-OS CLOSURE PENDING**  
Task: `MIG-003 — Decouple Business OS-specific paths/state`  
Exact implementation base: `64371bedc7b9c976047224152dba820c12a0674c`

## 1. Scope and authority

MIG-003 starts from the exact independent-repository MIG-002 closure main and changes only project-integration/configuration boundaries, root-path assumptions, compatibility helpers, hosted CI and generic fixtures.

Production remains owned by the existing embedded Supervisor.

- production_cutover: **false**
- production_authority: **UNCHANGED_EXISTING_SUPERVISOR**
- embedded Supervisor rollback source: **PRESERVED**
- RBT-001 → RBT-008: **ACCEPTED**
- RBT-009: **IMPLEMENTATION CANDIDATE / FINAL 8H SOAK PENDING**

## 2. Five-Step outcome

**QUESTION** — Business/project truth is not platform truth. Supervisor needs bounded orchestration inputs, not Business OS documents.

**DELETE** — removed Business OS PROJECT_STATE/TASK_QUEUE/CURRENT_STATE assumptions, old repository defaults, embedded-root workflow paths and monorepo-only test inputs from executable platform defaults.

**SIMPLIFY** — one project adapter contract and one state-root contract.

**ACCELERATE** — root-native helpers and synthetic project-neutral tests.

**AUTOMATE** — hosted CI/static tests only; self-hosted production jobs remain disabled.

Machine-readable closure matrix:

`docs/MIG_003_COUPLING_CLOSURE.json`

## 3. Project adapter contract

Files:
- `src/project-adapter.mjs`
- `docs/PROJECT_ADAPTER_V1.md`
- `test/project-adapter.test.mjs`

Schema:

`supervisor-project-adapter.v1`

Exactly one explicit source is accepted:
- `SUPERVISOR_PROJECT_ADAPTER_PATH` / `--project-adapter`
- `SUPERVISOR_PROJECT_ADAPTER_URL` / `--project-adapter-url`

`--state-url` is retained only as a compatibility alias for an explicit adapter URL. No Business OS URL/default is embedded.

If no adapter source is configured, the relevant platform runtime fails closed.

The adapter exposes only bounded project state/orchestration metadata and optional bounded instruction strings. It does not copy business documents, task queues, secrets, private URLs, messages or browser profiles into the Supervisor repository.

## 4. State-root contract

Files:
- `src/state-root.mjs`
- `windows/state-root.ps1`
- `docs/STATE_ROOT_V1.md`
- `test/state-root.test.mjs`

Schema:

`supervisor-state-root.v1`

Resolution:
1. explicit `SUPERVISOR_STATE_ROOT`;
2. `legacy-preserve` compatibility;
3. `platform-default` only when explicitly selected.

MIG-003 does **not** move, rename, copy, initialize or reset live state. Existing production state remains preservable for MIG-005.

## 5. Direct runtime coupling closure

### Before

Direct Business OS PROJECT_STATE/default dependencies existed in:
- `src/runtime/brain-worker-cli.mjs`
- `src/runtime/supervisor-loop-cli.mjs`
- `src/runtime/dry-run-cli.mjs`
- `src/runtime/one-shot-cli.mjs`
- `src/runtime/retry-only-cli.mjs`
- `src/state.mjs`

Old repository/default identity existed in runtime/status/Windows surfaces.

Project-policy prompts in `src/decision.mjs` and `src/runtime/orchestration.mjs` assumed CURRENT_STATE / PROJECT_STATE / TASK_QUEUE and Business OS-specific planning docs.

### After

- daemon and short-lived runtimes load project state only through the explicit adapter;
- status has no project/repository fallback identity;
- Control Panel repository URL is explicit `SUPERVISOR_PROJECT_REPOSITORY_URL`;
- project-policy text is adapter-owned via bounded `instructions`;
- generic fallback prompts are project-neutral;
- MAGASIN protocol serialization markers remain unchanged.

## 6. Root/path decoupling

Target workflows are root-native:
- `src/**`
- `test/**`
- `windows/**`
- `package.json`
- `.github/**`

No production workflow uses `08_INTEGRATIONS/supervisor/**` as an executable target path.

State-root consumers in Windows/workflow/release scripts use the shared compatibility contract.

`windows/repair-supervisor.ps1` now treats the independent repository root as its source repository root rather than walking to a Business OS monorepo root.

## 7. Monorepo/test decoupling

`test/night-run.test.mjs` no longer loads:
- `02_CORE/**`
- Business OS project registry/cursor files
- Business OS `night-run-hard-stop.yml`

It uses synthetic project-neutral fixtures.

`src/runtime/night-run.mjs` accepts:
- `supervisor-project-registry.v1`
- `supervisor-execution-cursor.v1`

Legacy `business-os-*` schema names remain compatibility aliases only.

Generic decision/orchestration/status tests use synthetic `WORK-*` identifiers instead of Business OS global task IDs.

## 8. Runtime semantic change statement

MIG-003 changes **configuration plumbing semantics**:
- project state source becomes explicit adapter input;
- filesystem state-root becomes configurable with legacy-preserve compatibility.

MIG-003 does **not** intentionally change:
- exact-once dispatch;
- exact-once relay;
- Owner STOP authority;
- lane isolation;
- browser scheduler/page budget;
- watchdog/recovery;
- privacy metadata rules;
- MAGASIN_LANE_DIRECTIVE_V1 serialization.

No production runtime is installed or cut over by this task.

## 9. MIG-002 parity preservation

MIG-002 frozen provenance remains authoritative.

Current MIG-003 implementation snapshot preserves:
- mapped records present: **137 / 137**
- missing mapped records: **0**
- mapped files intentionally rewritten by MIG-003: **34**

The rewritten paths are recorded in `docs/MIG_003_COUPLING_CLOSURE.json`. MIG-002 frozen source blob provenance is not overwritten or re-frozen.

## 10. Self-hosted production workflow safety

During MIG-003:
- Autostart Install: hard-disabled
- Lifecycle Acceptance: hard-disabled
- Open Control Panel: hard-disabled
- State Maintenance: hard-disabled
- RBT-009 Tier A/preflight/Tier B: hard-disabled
- Integrity runtime-audit: hard-disabled

The jobs retain `if: ${{ false }}` guards.

No target self-hosted job has been authorized to mutate production.

## 11. Hosted test evidence before PR

Implementation branch run:

- Supervisor Tests run: `35644801166`
- job: `106482531970`
- result: **SUCCESS**

Observed:
- MIG-003 decoupling contract tests: **50 / 50 PASS**
- platform safety/core regressions: **184 / 184 PASS**
- `RBT009A_STRICTMODE_MATRIX_A_TO_O=PASS`
- `MIG_003_PROJECT_ADAPTER_TESTS=True`
- `MIG_003_STATE_ROOT_COMPATIBILITY_TESTS=True`
- `MIG_003_PLATFORM_CORE_REGRESSION=True`
- `SELF_HOSTED_PRODUCTION_WORKFLOWS_INERT=True`
- `ZERO_PRODUCTION_MUTATION=True`

PR-head and exact-main hosted gates have completed successfully. Business OS canonical closure remains required before MIG-003 is canonical DONE.

## 12. Privacy / production mutation

No commit contains:
- private Brain/Work URLs;
- message bodies;
- screenshots;
- cookies;
- auth tokens;
- browser profile data;
- private operational exports.

No production file/state/latch mutation was executed.

`ZERO_PRODUCTION_MUTATION=true`

## 13. Deferred to MIG-004

MIG-004 must perform **full new-repository CI/lifecycle parity validation**. It is not claimed by MIG-003.

Deferred:
1. full parity across legacy acceptance surfaces;
2. full lifecycle/release workflow validation under MIG-004 authorization;
3. any safe transition from hard-disabled release workflows to validated MIG-004 gates;
4. exact candidate release readiness;
5. production cutover remains MIG-005;
6. final RBT-009 8h qualification remains MIG-006.

## 14. Stop boundary

After target PR/merge/exact-main hosted gates and Business OS canonical closure:
- MIG-003 = DONE
- MIG-004 = READY / NOT STARTED

MIG-003 must STOP and must not self-start MIG-004.


## 15. Target PR / exact-main closure evidence

Canonical implementation PR:
- PR #5: `refactor(platform): decouple Supervisor from Business OS project state`
- exact base: `64371bedc7b9c976047224152dba820c12a0674c`
- final PR head: `f7fe79e22660c8a9fc0c1e3feecfcf90d282298a`
- merge / exact target main: `aec7db9a715ceb41066af6636a4c91d34553eed5`
- changed files: **43**
- superseded alternate PR #4: **CLOSED / NOT MERGED**

PR-head hosted gates:
- Supervisor Tests run `35645284638`, job `106484118473`: **SUCCESS**
- Supervisor Integrity run `35645284699`, static job `106484151783`: **SUCCESS**
- Supervisor Integrity runtime-audit job `106484202256`: **SKIPPED / FAIL-CLOSED**

Exact-main hosted gates on `aec7db9a715ceb41066af6636a4c91d34553eed5`:
- Supervisor Tests run `35645394216`, job `106484492607`: **SUCCESS**
  - MIG-003 decoupling contract tests: **50 / 50 PASS**
  - platform safety/core regressions: **184 / 184 PASS**
  - `RBT009A_STRICTMODE_MATRIX_A_TO_O=PASS`
  - `MIG_003_PROJECT_ADAPTER_TESTS=True`
  - `MIG_003_STATE_ROOT_COMPATIBILITY_TESTS=True`
  - `MIG_003_PLATFORM_CORE_REGRESSION=True`
  - `SELF_HOSTED_PRODUCTION_WORKFLOWS_INERT=True`
  - `ZERO_PRODUCTION_MUTATION=True`
- Supervisor Integrity run `35645394250`, static job `106484492995`: **SUCCESS**
  - decoupling/static tests: **82 / 82 PASS**
  - `MIG_003_PROJECT_ADAPTER_BOUNDARY=True`
  - `MIG_003_STATE_ROOT_COMPATIBILITY=True`
  - `MIG_003_ROOT_NATIVE_STATIC=True`
  - `MIG_003_SELF_HOSTED_FAIL_CLOSED=True`
  - `ZERO_PRODUCTION_MUTATION=True`
- Supervisor Integrity runtime-audit job `106484547597`: **SKIPPED**

Exact-main production/self-hosted workflow protection:
- Lifecycle run `35645394192`, job `106484493476`: **SKIPPED**
- Autostart Install run `35645394217`, jobs `106484493870` and `106484494405`: **SKIPPED**
- Open Control Panel run `35645394277`, job `106484493015`: **SKIPPED**
- RBT-009 run `35645394259`, Tier A/preflight/Tier B jobs `106484513033` / `106484519081` / `106484521238`: **SKIPPED**
- State Maintenance remains manual-only and hard-disabled for production mutation in MIG-003.

Negative coupling search on exact-main returned zero generic-platform matches for:
- `magasincoffee/magasincoffee.github.io`
- `00_PROJECT_STATE.json`
- `TASK_QUEUE`
- `CURRENT_STATE`
- `08_INTEGRATIONS/supervisor`
- `02_CORE/`
- executable fixtures `TASK-029`, `TASK-035`, `TASK-048`, `TASK-049`, `TASK-060`

The legacy Business OS state-root string remains only inside the explicit `legacy-preserve` compatibility resolver/documentation boundary; it is no longer a generic platform identity/default contract.

## 16. Target-side conclusion

MIG-003 target implementation DoD is satisfied:
- explicit project adapter boundary exists and fails closed without configuration;
- platform core no longer embeds Business OS PROJECT_STATE/TASK_QUEUE/CURRENT_STATE or old repository defaults;
- state-root is configurable while legacy production state remains preservable without move/reset;
- root-native CI/workflow paths are in place;
- generic tests are decoupled from Business OS monorepo fixtures;
- MIG-002 mapped paths remain 137/137 represented;
- all target self-hosted production mutation paths remain inert;
- RBT continuity is unchanged.

`production_cutover=false`  
`production_authority=UNCHANGED_EXISTING_SUPERVISOR`  
`ZERO_PRODUCTION_MUTATION=true`

Business OS source-of-truth may now close MIG-003 and advance only to `MIG-004 READY / NOT STARTED`. This target-side closure does not start or certify MIG-004.
