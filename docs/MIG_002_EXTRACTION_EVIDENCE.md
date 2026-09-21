# MIG-002 — Independent Supervisor Repository Extraction Evidence

Status: **TARGET EXTRACTION DONE / EXACT-MAIN HOSTED GATES GREEN / BUSINESS-OS CLOSURE PENDING**
Date: 2026-09-21
Task: `MIG-002 — Extract Supervisor Platform to Independent Repository`

## 1. Authorities

- Source repository: `magasincoffee/magasincoffee.github.io`
- Source reopen main: `10e004254f56078b7e517157f552cfaf5b49c80b`
- Frozen extraction baseline SHA: `4f76b929c5fedc44b451abd823f0f1f7fb3e50fe`
- Frozen extraction tree SHA: `b0947bac1847dd34cae2f14fdc46a3c70ee6de57`
- Canonical file map: `01_DOCS/MAGASIN/08_AUTONOMY/SUPERVISOR_MIGRATION_V1_FILE_MAP.json`
- File-map blob SHA used by extraction: `298612b6ec58651f484f7a3d4ff3cce486f76214`
- Target repository: `magasincoffee/magasin-supervisor`
- Target bootstrap main SHA: `815fc10bbc1814ed46f73b63391b9e67e29aa446`
- Extraction branch: `migration/mig-002-extract-platform`

Moving source main was not used as an extraction baseline and the baseline was not re-frozen.

## 2. Root-native target tree

The independent repository now contains the mapped platform at root-native paths:

- `README.md`
- `package.json`
- `src/**`
- `test/**`
- `windows/**`
- `docs/**`
- `.github/workflows/supervisor-*.yml`
- `.github/scripts/supervisor-*`

Additional MIG-002 bootstrap/mirror files are outside the 137-record parity set:

- `.github/MIGRATION_BOOTSTRAP_GUARD.md`
- `docs/THREE_LANE_V1_ARCHITECTURE.md`
- `docs/MAGASIN_LANE_DIRECTIVE_V1_PROTOCOL.md`
- `docs/MIG_002_PARITY_PROVENANCE.json`
- this evidence file.

Business OS originals remain unchanged in the source repository.

## 3. 137/137 parity and provenance

Machine-readable authority:

`docs/MIG_002_PARITY_PROVENANCE.json`

Parity snapshot:
- snapshot commit: `98551bfa654b132fe818e6e787e9d99b52ab5f97`
- represented records: **137 / 137**
- missing: **0**
- duplicate target mappings: **0**
- source classifications: **90 MOVE / 47 REWRITE**
- MOVE byte-equivalent: **90 / 90**
- REWRITE provenance retained: **47 / 47**
- REWRITE still byte-equivalent: **39 / 47**
- extraction-only rewritten records: **8**

Each mapped record includes source path, frozen source blob SHA, target path and actual target blob SHA.

## 4. Extraction-only rewrites

Only these mapped records differ from their frozen blob:

1. `README.md` — root-native protocol/path references and explicit migration safety banner.
2. `.github/workflows/supervisor-tests.yml` — root-native path filters/working directory; remains GitHub-hosted only.
3. `.github/workflows/supervisor-integrity.yml` — root-native static audit; self-hosted runtime audit hard-disabled.
4. `.github/workflows/supervisor-autostart-install.yml` — install and verify-survival jobs hard-disabled.
5. `.github/workflows/supervisor-lifecycle-acceptance.yml` — self-hosted lifecycle job hard-disabled.
6. `.github/workflows/supervisor-open-control-panel.yml` — self-hosted control-panel opener hard-disabled.
7. `.github/workflows/supervisor-rbt009-soak.yml` — Tier A, preflight and Tier B jobs hard-disabled for MIG-002.
8. `.github/workflows/supervisor-state-maintenance.yml` — self-hosted maintenance job hard-disabled.

No runtime/business semantics were generalized in MIG-002.

## 5. Production workflow fail-closed audit

Static workflow audit confirms:

- every target `runs-on: self-hosted` job is protected by `if: ${{ false }}`;
- Supervisor Tests has zero self-hosted jobs;
- Supervisor Tests has no `08_INTEGRATIONS/supervisor` path dependency;
- Supervisor Tests has no Business OS `00_PROJECT_STATE.json` dependency;
- Supervisor Integrity static audit is GitHub-hosted and root-native;
- Supervisor Integrity self-hosted runtime audit is hard-disabled;
- RBT-009 qualification workflow cannot execute any job during MIG-002.

Known embedded-root, Business OS PROJECT_STATE, local-state-root and old-repository references intentionally retained inside disabled workflows/runtime are MIG-003 coupling work, not MIG-002 extraction work.

## 6. Platform mirrors

Created:
- `docs/THREE_LANE_V1_ARCHITECTURE.md`
- `docs/MAGASIN_LANE_DIRECTIVE_V1_PROTOCOL.md`

They are platform-oriented mirrors with root-native Supervisor references. The original Business OS documents remain unchanged and authoritative for project integration during the compatibility window.

## 7. RBT continuity

Preserved exactly:

- `RBT-001 -> RBT-008 = ACCEPTED`
- `RBT-009 = IMPLEMENTATION CANDIDATE / FINAL 8H SOAK PENDING`

The frozen `docs/THREE_LANE_V1_RELEASE_EVIDENCE.md` record remains byte-equivalent to its mapped source blob. MIG-002 does not certify or release RBT-009.

## 8. Safety result

- `production_cutover=false`
- `production_authority=UNCHANGED_EXISTING_SUPERVISOR`
- production install/start/stop/repair/cutover: **NOT PERFORMED**
- Brain URL / Work URL mutation: **NONE**
- `lanes.json` / `lane-registry.json` / `lane-status.json` mutation: **NONE**
- latch reset: **NONE**
- Owner STOP clear: **NONE**
- target self-hosted production workflow execution: **NONE**
- embedded Supervisor deletion: **NONE**
- second production mutation authority: **NONE**
- private operational data committed: **NONE**

`ZERO_PRODUCTION_MUTATION=true`

## 9. Safe test gate

Static extraction checks already PASS:

- target repository exists and is public;
- 137/137 map parity;
- 90/90 MOVE byte-equivalence;
- 47/47 REWRITE provenance;
- unique target mapping;
- root-native mapped paths present;
- self-hosted workflow guard audit PASS.

Safe GitHub-hosted unit/static checks are enabled for target PR/main. Self-hosted runtime/lifecycle/install/soak checks are intentionally disabled and are not required to be made green by MIG-002.

## 10. Exact MIG-003 coupling scope

MIG-003 must start from this extracted tree and may address only the decoupling surfaces already inventoried:

1. replace hard-coded Business OS `00_PROJECT_STATE.json` runtime dependencies with an explicit project adapter/input contract;
2. isolate/remove Business OS `CURRENT_STATE / PROJECT_STATE / TASK_QUEUE` planning assumptions from platform core;
3. remove old repository identity defaults (`magasincoffee/magasincoffee.github.io`) from platform defaults;
4. abstract compatibility-sensitive local state root `%LOCALAPPDATA%\\MAGASIN\\BusinessOS\\supervisor` without mutating live state or cutover authority;
5. replace embedded-root assumptions still retained in disabled production workflows;
6. make generic platform tests independent of Business OS global task IDs while preserving historical release evidence;
7. prepare root-native CI/lifecycle semantics for MIG-004;
8. keep production workflows inert until the later release/cutover gates explicitly authorize them.

MIG-003 must not perform production cutover; that remains MIG-005.

## 11. Stop boundary

MIG-002 stops after target PR/parity evidence and Business OS source-of-truth closure. It does not self-start MIG-003.


## 12. Target PR and CI closure evidence

### Extraction PR

- Target PR #1: `chore(migration): extract Supervisor platform from frozen baseline`
- PR #1 head: `d6da4e83e238cc632a4a57f7dec0642eb0fff224`
- PR #1 merge: `e67ae8101c391fc0a77b41ae6190bb615356be99`

The first exact-main hosted runs on PR #1 correctly exposed legacy monorepo coupling:

- Supervisor Tests run `35625923395`: **FAIL**, limited to legacy tests resolving `.github/workflows/**` via the old embedded-depth assumption.
- Supervisor Integrity run `35625923480`: **FAIL**, additionally exposing Business OS-only `02_CORE`, night-run and old source-root assumptions.
- These failures were classified as MIG-003/MIG-004 coupling, not runtime semantic regressions.
- No runtime/test implementation was changed to force the legacy monorepo suite green.

Production/self-hosted protection on the first target main was independently proven:

- Autostart run `35625923489`: **SKIPPED**
- Lifecycle run `35625923418`: self-hosted job **SKIPPED**
- Open Control Panel run `35625923441`: **SKIPPED**
- RBT-009 run `35625923459`: Tier A / preflight / Tier B all **SKIPPED**

### Extraction-safe CI correction PR

- Target PR #2: `ci(migration): scope MIG-002 checks to extraction-safe core`
- final PR #2 head: `47be8911b43c2450c8dcda3a2f0755f288ab89bd`
- PR #2 merge: `07160cfab6943d647661f732590a0ce45e2f92a5`

PR-head exact-SHA gates:

- Supervisor Tests run `35626549947`, job `106422214782`: **SUCCESS**
- Supervisor Integrity run `35626550365`, static-audit job `106422217392`: **SUCCESS**
- Supervisor Integrity runtime-audit job `106422270193`: **SKIPPED**

Exact-main gates on `07160cfab6943d647661f732590a0ce45e2f92a5`:

- Supervisor Tests run `35626662536`, job `106422585371`: **SUCCESS**
  - extraction-safe platform tests: **184 / 184 PASS**
  - failures: **0**
  - `RBT009A_STRICTMODE_MATRIX_A_TO_O=PASS`
  - `MIG_002_EXTRACTION_SAFE_TESTS=True`
  - `ZERO_PRODUCTION_MUTATION=True`
- Supervisor Integrity run `35626662417`, static-audit job `106422584584`: **SUCCESS**
  - extraction-safe cross-platform core tests: **71 / 71 PASS**
  - failures: **0**
  - `MIG_002_ROOT_NATIVE_STATIC=True`
  - `MIG_002_SELF_HOSTED_FAIL_CLOSED=True`
  - `ZERO_PRODUCTION_MUTATION=True`
- Supervisor Integrity runtime-audit job `106422631900`: **SKIPPED**
- Lifecycle run `35626662157`: **SKIPPED**
- RBT-009 run `35626662264`: **SKIPPED**

This is the intended MIG-002 gate: safe hosted extraction tests and static parity/safety checks are green; self-hosted production acceptance remains fail-closed for later migration stages.

## 13. Target-side conclusion

Target repository extraction is complete and reviewable.

- target repository: `https://github.com/magasincoffee/magasin-supervisor`
- bootstrap main SHA: `815fc10bbc1814ed46f73b63391b9e67e29aa446`
- extraction implementation main SHA: `07160cfab6943d647661f732590a0ce45e2f92a5`
- parity manifest: `docs/MIG_002_PARITY_PROVENANCE.json`
- parity: **137 / 137**
- missing: **0**
- duplicate mapping: **0**
- MOVE byte-equivalent: **90 / 90**
- REWRITE provenance: **47 / 47**
- extraction-only rewritten mapped files: **8**
- production cutover: **false**
- production authority: **UNCHANGED_EXISTING_SUPERVISOR**
- local production state mutation: **none**
- RBT-009 release effect: **none**

`ZERO_PRODUCTION_MUTATION=true`

MIG-002 target-side work is DONE. Business OS source-of-truth must now record the accepted target evidence and advance only to `MIG-003 READY / NOT STARTED`. MIG-003 is not started by this task.
