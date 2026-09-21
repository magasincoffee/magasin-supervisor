# MIG-002 — Independent Supervisor Repository Extraction Evidence

Status: **CANDIDATE / TARGET PR PENDING**
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
