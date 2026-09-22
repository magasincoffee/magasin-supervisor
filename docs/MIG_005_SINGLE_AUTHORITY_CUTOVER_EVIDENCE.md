# MIG-005 — Single-Authority Production Cutover Evidence

Status: **CONTROLLED STATE TRANSFER TOOLING / PRE-CUTOVER / NO AUTHORITY SWITCH**  
Task: `MIG-005 — Single-Authority Production Cutover`  
Exact release base: `a67b6ea19e7e10b4b63b56f9e7b5274a94135ca2`  
Canonical execution: **PR #10 / branch `mig-005/single-authority-cutover`**

## Authority safety

- production_cutover: **false**
- production_authority: **UNCHANGED_EXISTING_SUPERVISOR**
- production_mutation_authority_instances: **1**
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

## Production boundary

No old-machine production capture/STOP/export has been executed by this branch.

No raw production state is stored in:
- Git commits;
- Actions artifacts;
- Actions logs;
- repository evidence.

The raw state package must cross machines only through an Owner-mediated local/offline/private transport.

Because old-machine process/state mutation requires execution on the old host, production handoff remains fail-closed until that boundary is performed and its sanitized output is reconciled.

`RBT009_TIER_B_480M=NOT_RUN`
`PRODUCTION_CUTOVER=false`
