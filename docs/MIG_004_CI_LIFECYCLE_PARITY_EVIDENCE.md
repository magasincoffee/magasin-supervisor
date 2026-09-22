# MIG-004 — New-repo CI / Lifecycle Parity Evidence

Status: **PR-HEAD GREEN / EXACT-MAIN VALIDATION PENDING**  
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

## PR-head hosted gate evidence

Canonical PR: **#8** `ci(migration): qualify MIG-004 new-repo lifecycle parity`

PR implementation head before evidence refresh:
- branch head: `e821d826ad209d3ea052393682c0167f14b548bb`
- GitHub pull-request merge-ref tested consistently by all hosted gates: `320db78c0adbaa0405473e8eac0d642f239fa705`

Hosted gates on that same tested merge-ref:
- Supervisor Tests run `35685652188`, job `106611775235`: **SUCCESS**
  - full root-native suite: **567 / 567 PASS**
  - MIG-003 adapter/state-root contract subset: **50 / 50 PASS**
  - platform safety/core regression subset: **184 / 184 PASS**
  - `MIG_004_FULL_ROOT_NATIVE_REGRESSION=True`
  - `ZERO_PRODUCTION_MUTATION=True`
- Supervisor Integrity run `35685652259`, static job `106611847548`: **SUCCESS**
  - independent-repo static/safety set: **87 / 87 PASS**
  - state-maintenance/control-panel safety set: **29 / 29 PASS**
  - MIG-002 provenance: **137 / 137 represented exactly once**
  - runtime-audit job `106611937594`: **SKIPPED / fail-closed**
- Supervisor Lifecycle Acceptance run `35685652240`, job `106611855368`: **SUCCESS**
  - isolated lifecycle/state-root suite: **52 / 52 PASS**
  - `MIG_004_LIFECYCLE_A_TO_L=PASS`
  - `MIG_004_PRODUCTION_STATE_UNTOUCHED=True`
  - production/self-hosted lifecycle job `106611856330`: **SKIPPED**
- Supervisor Autostart Install run `35685652159`, job `106612355933`: **SUCCESS**
  - isolated installer/autostart contract suite: **25 / 25 PASS**
  - `MIG_004_PRODUCTION_HKCU_UNTOUCHED=True`
  - production install / verify-survival jobs: **SKIPPED**
- Supervisor RBT-009 Overnight Soak run `35685652253`, Tier A job `106612299241`: **SUCCESS**
  - Tier A synthetic contract: **9 / 9 PASS**
  - `MIG_004_RBT009_TIER_A_SYNTHETIC=True`
  - `MIG_004_RBT009_TIER_B_NOT_RUN=True`
  - normal-release preflight and Tier B 480-minute jobs: **SKIPPED**

The pull-request workflows use GitHub's tested merge ref for `GITHUB_SHA`; therefore PR-head correlation is recorded as one common tested merge-ref plus the corresponding branch head. Exact post-merge validation on target `main` remains mandatory before canonical closure.

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
