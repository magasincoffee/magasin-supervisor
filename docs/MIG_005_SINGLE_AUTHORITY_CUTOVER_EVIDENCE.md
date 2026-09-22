# MIG-005 — Single-Authority Production Cutover Evidence

Status: **OLD HANDOFF COMPLETE / NEW-MACHINE ACTIVATION READY / CUTOVER NOT YET COMPLETE**  
Task: `MIG-005 — Single-Authority Production Cutover`  
Exact release base: `a67b6ea19e7e10b4b63b56f9e7b5274a94135ca2`  
Canonical execution: **PR #10 / branch `mig-005/single-authority-cutover`**

## Authority safety

- production_cutover: **false**
- production_authority: **ZERO DURING CONTROLLED HANDOFF**
- production runtime authority instances: **0**
- production ownership authority instances: **0**
- split_brain: **FORBIDDEN**
- old production state/source: **PRESERVED**
- new production authority started: **false**
- RBT-009 Tier B 480m: **NOT RUN**

## Owner authorization

Business OS canonical authorization permits controlled state preservation/transfer for MIG-005, but not overlapping authorities.

Required ordering remains:

`old capture -> old STOP -> verify authority=0 -> final export -> private transfer -> import/hash verify -> new activation -> verify authority=1`

Rollback ordering remains:

`stop new -> verify new inactive -> restore old -> verify authority=1`

## New-machine preflight checkpoint

A repository self-hosted runner accepted the read-only probe after the PowerShell ExecutionPolicy correction.

Sanitized result:
- Node major: **24**
- Supervisor wrapper: **OFF**
- Three-Lane process: **OFF**
- production autostart: **OFF**
- pending reboot: **false**
- canonical state files: **absent**
- lane count: **0**
- registry lane count: **0**
- role: **BLOCKED PENDING PRESERVED STATE**
- RBT-009 Tier B: **NOT RUN**

The observed STOP-blocked state while canonical state was absent is treated only as a fail-closed/bootstrap condition. It is not accepted as proof of historical Owner STOP intent.

## Canonical continuity inventory from runtime/lifecycle code

The bounded transferable state set is derived from executable runtime/lifecycle code, not guessed:

1. `lanes.json`
2. `lane-registry.json` — includes durable dispatch/relay latches and target/application state
3. `lane-status.json`
4. `lane-events.ndjson`
5. pre-existing `STOP` and/or `AUTOSTART_DISABLED` only when they existed **before** the controlled handoff STOP
6. only relay screenshots currently referenced by a durable `relay_inflight.screenshot_path` under `lane-evidence/`

Explicitly excluded from the canonical state payload:
- `runtime/`
- `supervisor.pid`
- `runtime-status.json`
- `supervisor.log`
- `browser_profile/`
- `autostart-install-status.json`
- unreferenced relay evidence

Machine-local runtime/auth surfaces remain activation gates and are not blindly copied as business/lane state.

## Controlled transfer tooling

Files:
- `windows/mig-005-state-transfer.ps1`
- `windows/mig-005-old-handoff.ps1`
- `test/mig-005-state-transfer-contract.test.mjs`
- `test/mig-005-state-transfer-fixture.ps1`

Transfer schema:
- `supervisor-mig005-state-transfer.v1`
- pre-stop capture: `supervisor-mig005-prestop-capture.v1`

Properties:
- explicit source/destination state roots;
- pre-stop sanitized capture;
- supported STOP then hard zero-authority verification before final export;
- staging directory;
- package SHA256;
- per-file SHA256 + size + relative path;
- exact candidate SHA binding;
- 3-lane and 3-registry-lane validation;
- hashed Brain/Work target preservation proof;
- registry/latch continuity fingerprint;
- referenced relay evidence only;
- final relay screenshot path rebased to the logical destination, not a temporary staging path;
- atomic destination finalization only after validation;
- actual pre-existing Owner STOP distinguished from temporary handoff/bootstrap blockers;
- no new-authority start in transfer tooling;
- old-machine handoff wrapper attempts old-authority rollback if a post-stop export failure occurs.

Raw target URLs, message bodies, screenshots, cookies, tokens and browser-profile contents are not written to Git evidence.

## Hosted transfer validation

The first hosted round-trip exposed a real staging-path defect: relay screenshot path was written against the temporary staging root. Import/latch fingerprints passed, but the final path would have become stale after atomic directory move.

The implementation was corrected so physical validation occurs in staging while the registry stores the final logical destination path. This defect was caught **before any production mutation**.

Final hosted run IDs are recorded only after the corrected candidate completes all gates.

## Old-machine quiescent authority reconciliation

Owner read-only truth proves the old host is a legitimate **ALL_DISABLED_QUIESCENT** state:
- config lanes: **3**
- registry lanes: **3**
- enabled lanes: **0**
- wrapper / Three-Lane / Chrome / CDP: **inactive**
- Owner STOP: **false**
- STOP / AUTOSTART_DISABLED: **absent**
- HKCU autostart registration: **present**
- supported start/stop scripts: **present**
- zero runtime authority: **verified**

This state must not be forced through Owner START. `autostart-bootstrap.ps1` exits successfully when enabled-lane count is less than one, so a registered old autostart entry does not create runtime authority while all three lanes remain disabled.

The bounded handoff classifier recognizes exactly four modes: `ACTIVE`, `OWNER_STOPPED`, `ALL_DISABLED_QUIESCENT`, and `INVALID_INACTIVE`. Only the first three are eligible; all other inactive/non-Owner-stopped states fail closed. For `ALL_DISABLED_QUIESCENT`, no STOP is called and no synthetic historical STOP/AUTOSTART_DISABLED is created.

Autostart ownership transfers only after final export succeeds. The exact prior HKCU registration value is stored only in a private local rollback record, never Git or Actions logs. Rollback restores the exact old registration; runtime restart occurs only when the recorded pre-handoff mode was `ACTIVE`. `OWNER_STOPPED` and `ALL_DISABLED_QUIESCENT` remain inactive.

Imported state must preserve `enabled_lane_count=0`; MIG-005 does not enable any lane. The independent autostart bootstrap is required to exit without starting Supervisor in this all-disabled state.

## Old-machine controlled handoff checkpoint

Owner completed the supported old-machine handoff successfully. Sanitized authoritative checkpoint:

- pre-handoff mode: **ALL_DISABLED_QUIESCENT**
- config lanes: **3**
- registry lanes: **3**
- enabled lanes: **0**
- old runtime authority: **0**
- final state export: **PASS**
- package file count: **5**
- referenced relay evidence count: **1**
- package SHA256: **b2a67e3c7ae568454c09386b2ceb4f7cc7cfba650e3a37243dea89a2ebfe5753**
- old state root untouched: **true**
- old autostart ownership released: **true**
- old rollback record ready: **true**
- new authority started: **false**
- RBT-009 Tier B 480m: **NOT RUN**

The raw state package was privately copied by Owner to the new machine. Owner independently verified the SHA256 above. The raw payload is not stored in Git, Actions artifacts/logs, or ChatGPT.

At this checkpoint, ownership authority is intentionally **0** during the controlled handoff. This is safe because the old host was already all-disabled/quiescent and the new host remains non-authoritative until verified import and ownership activation complete.

## Package/runtime provenance compatibility

The first new-machine activation attempt failed closed on the original single-SHA contract with `Transfer manifest candidate SHA mismatch`. The wrapper rollback completed with new autostart ownership absent and new runtime authority inactive. The old host remains `ALL_DISABLED_QUIESCENT`; its preserved rollback record is untouched and was not restored.

Root cause is a safe provenance split, not a state-transfer implementation change:

- package-export candidate: `dc0b5f369f6a9c3ae89d821f1ddf603e1135f51e`
- package SHA256: `b2a67e3c7ae568454c09386b2ceb4f7cc7cfba650e3a37243dea89a2ebfe5753`
- transfer implementation blob at package candidate: `abf72af4ee51a06bf49af669cd4f590bd68a9aa7`
- runtime/install candidate: dynamic final PR #10 head
- required relation: package candidate must be an ancestor of runtime candidate
- required compatibility: `windows/mig-005-state-transfer.ps1` Git blob must be exactly identical at both candidates

The activation wrapper now accepts two explicit SHAs:
- `PackageCandidateSha` — must equal the package manifest candidate and is passed to transfer Import/Verify.
- `CandidateSha` — must equal repository HEAD and remains the runtime/install candidate.

Before any platform-state or ownership mutation, the wrapper verifies package SHA256, manifest candidate, local git existence, ancestry, and exact transfer-blob identity. Any mismatch fails closed. The transfer manifest guard remains unchanged; `windows/mig-005-state-transfer.ps1` is intentionally not modified.

Sanitized success markers:
- `MIG_005_PACKAGE_CANDIDATE_SHA_VERIFIED=True`
- `MIG_005_RUNTIME_CANDIDATE_SHA_VERIFIED=True`
- `MIG_005_PACKAGE_RUNTIME_ANCESTRY_VERIFIED=True`
- `MIG_005_TRANSFER_BLOB_IDENTITY_VERIFIED=True`
- `MIG_005_PACKAGE_RUNTIME_PROVENANCE_COMPATIBLE=True`

## New-machine ownership activation wrapper

Dedicated wrapper:

- `windows/mig-005-new-machine-activate.ps1`

Required sequencing enforced by the wrapper:

1. exact repository HEAD equals requested candidate SHA;
2. package SHA256 matches before any mutation;
3. new Supervisor wrapper/Three-Lane process and production autostart ownership are absent;
4. destination is explicitly `%LOCALAPPDATA%\MAGASIN\Supervisor`, never the legacy BusinessOS root;
5. transactional Import then Verify through `mig-005-state-transfer.ps1`;
6. require 3 config lanes, 3 registry lanes, enabled lane count 0, preserved Owner STOP=false;
7. write private local rollback metadata, then persist `SUPERVISOR_STATE_ROOT` at CurrentUser scope;
8. install exact candidate runtime without Owner START;
9. install new autostart ownership only after import/verify/runtime installation succeed;
10. invoke bootstrap only for bounded all-disabled verification and require the runtime process to remain OFF;
11. preserve GitHub runner and browser profile fingerprints;
12. on failure, remove new ownership/transaction artifacts, restore user environment, and instruct Owner to restore old authority from the preserved old-machine rollback record.

Expected successful ownership state:

`NEW_AUTHORITY_OWNERSHIP_ACTIVE_ALL_DISABLED_RUNTIME_QUIESCENT`

No lane is enabled by MIG-005 and normal `start-supervisor.ps1` is not called by the activation wrapper.

## Production boundary

No raw production state is stored in:
- Git commits;
- Actions artifacts;
- Actions logs;
- repository evidence.

The old rollback state/source remains preserved. Production cutover is not complete until Owner runs the exact-candidate new-machine activation wrapper and its sanitized output proves import, preservation, sole ownership and all-disabled runtime quiescence.

`RBT009_TIER_B_480M=NOT_RUN`
`PRODUCTION_CUTOVER=false`
