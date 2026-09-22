# MIG-004 — New-repo CI / Lifecycle Parity Evidence

Status: **IN PROGRESS / PR-HEAD VALIDATION PENDING**  
Task: `MIG-004 — New-repo CI / Lifecycle Parity`  
Exact implementation base: `63b955f59d7558a42311b3d47d58acc60a503dca`

## Authority and safety

- production_cutover: **false**
- production_authority: **UNCHANGED_EXISTING_SUPERVISOR**
- embedded Business OS Supervisor remains sole production authority
- final RBT-009 480-minute Tier B soak: **NOT RUN**
- production self-hosted install/lifecycle/control-panel/state-maintenance/runtime-audit jobs: **HARD-DISABLED**
- Brain/Work targets and live state: **NOT MUTATED**
- ZERO_PRODUCTION_MUTATION: **true**

## MIG-004 parity model

MIG-004 activates only hosted/synthetic validation in the independent repository.

1. **Supervisor Tests** runs the complete root-native `npm test` suite plus existing synthetic fixtures.
2. **Supervisor Integrity** remains independent from Business OS state/tree, validates the project-adapter/state-root boundary, runs maintenance/control-panel safety regressions and verifies the frozen MIG-002 provenance remains 137/137 represented.
3. **Lifecycle Acceptance** adds a Windows-hosted isolated A-L parity job. The production/self-hosted lifecycle job remains `if: false`.
4. **Autostart Install** adds a Windows-hosted installer/autostart contract job. The production/self-hosted install job remains `if: false`; no production HKCU registration is created.
5. **State Maintenance** remains manual-only and production-disabled. Its version-preflight/read-only audit/optional-latch/true-blocked/target-preservation/privacy contract is executed from hosted Integrity.
6. **Control Panel** parity is exercised by the full regression suite and hosted Integrity; the production open-panel workflow remains inert.
7. **RBT-009** enables only the existing hosted synthetic Tier A. Normal-release preflight and Tier B 480-minute production soak remain hard-disabled.

## Isolated lifecycle proof

`test/mig-004-isolated-lifecycle-parity.test.mjs` uses a temporary state root via `SUPERVISOR_STATE_ROOT` and exercises the real PowerShell lifecycle/state-root helpers against fixture state.

The test proves:
- explicit state-root resolution does not fall back to the production legacy root;
- Owner STOP is detected fail-closed;
- enabled-lane count is derived from isolated fixture state;
- no healthy production process can be inferred from the isolated root;
- explicit Owner START latch-clear semantics operate only on the temporary root;
- lane target/config fingerprint remains unchanged while lifecycle latches change;
- install/start/stop/repair/autostart scripts retain the shared state-root boundary and target-preservation contracts;
- production-capable workflow jobs remain hard-disabled.

## Exact-SHA gate correlation

Every hosted MIG-004 workflow prints `MIG_004_EXACT_SHA=$GITHUB_SHA`. PR-head and exact-main closure evidence will record the run/job IDs for:
- Supervisor Tests
- Supervisor Integrity
- Supervisor Lifecycle Acceptance / `lifecycle-a-l-isolated`
- Supervisor Autostart Install / `installer-autostart-isolated`
- Supervisor RBT-009 Overnight Soak / `tier-a-isolated-integration`

All listed runs must resolve to the same commit SHA before MIG-004 can close.

## Provenance

`docs/MIG_002_PARITY_PROVENANCE.json` remains frozen. Hosted Integrity requires:
- exactly **137** records;
- every record has `represented_exactly_once=true`;
- intentional MIG-004 workflow/test/doc changes are documented in `docs/MIG_004_GATE_PARITY.json`;
- no Business OS PROJECT_STATE/TASK_QUEUE dependency is reintroduced into platform runtime.

## Deferred

MIG-004 does not:
- cut over production;
- install/start/stop/repair the target Supervisor on the production runner;
- alter production autostart;
- clear Owner STOP;
- move/copy/reset/rename live state;
- run RBT-009 Tier B for 480 minutes;
- start MIG-005.

Final PR-head/exact-main run IDs and canonical closure will be appended only after all hosted gates are green.
