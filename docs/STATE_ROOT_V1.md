# Supervisor State Root V1

Status: MIG-003 compatibility contract

Schema: `supervisor-state-root.v1`

## Purpose

Filesystem location is platform configuration, not project identity.

Resolution order:

1. explicit `SUPERVISOR_STATE_ROOT`;
2. compatibility mode `legacy-preserve`;
3. `platform-default` only when explicitly selected by code/config.

## MIG-003 rule

MIG-003 uses `legacy-preserve` whenever no explicit state root is configured. This preserves the existing state location byte-for-byte and does not move, rename, copy, reset or initialize live production state.

The platform-default location exists only as a future configurable target. Selecting/migrating production state is a later cutover concern and is not performed by MIG-003.

## Safety

The state-root resolver itself performs path resolution only. It does not create directories or mutate files.

Existing Owner STOP, lane targets, registry/status/events, dispatch/relay latches and browser profile remain untouched.

Implementations:

- JavaScript: `src/state-root.mjs`
- PowerShell: `windows/state-root.ps1`

Tests: `test/state-root.test.mjs`
