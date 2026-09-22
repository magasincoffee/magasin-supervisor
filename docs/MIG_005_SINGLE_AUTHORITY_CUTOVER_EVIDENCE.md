# MIG-005 — Single-Authority Production Cutover Evidence

Status: **PREFLIGHT IN PROGRESS / NO CUTOVER**  
Task: `MIG-005 — Single-Authority Production Cutover`  
Exact release base: `a67b6ea19e7e10b4b63b56f9e7b5274a94135ca2`

## Authority safety

- production_cutover: **false**
- production_authority: **UNCHANGED_EXISTING_SUPERVISOR**
- production_mutation_authority_instances: **1**
- split_brain: **FORBIDDEN**
- Owner STOP: **PRESERVE**
- Brain/Work targets: **PRESERVE**
- lane state/latches: **PRESERVE**
- RBT-009 Tier B 480m: **NOT RUN**

## Phase 1 preflight

This branch adds only a read-only MIG-005 preflight workflow and its static safety contract. It does not install, start, stop, repair, register autostart, clear Owner STOP, or modify live Supervisor state.

The self-hosted probe emits sanitized hashes/counts/booleans only. Raw machine names, Brain/Work URLs, messages, cookies, tokens, screenshots, browser profiles and private state values are not written to Git evidence.

Preflight requires evidence for:
1. an active old authority or preserved rollback identity;
2. a distinct new-machine candidate with no active Supervisor authority;
3. preserved three-lane state/registry visibility on the new candidate;
4. no new-machine production autostart registration before handoff;
5. Node 20+ and no detected pending reboot;
6. exact candidate release gates before any production handoff.

If no distinct `NEW_READY_CANDIDATE` is observed, MIG-005 remains `PREFLIGHT_BLOCKED / WAIT_OWNER` and the old authority is left unchanged.

## Cutover boundary

No controlled handoff is authorized by this preflight commit. Production handoff tooling, if required, must be separately reviewable and must prove the ordering:

`old authority STOP -> verify zero authority -> new authority START -> verify exactly one authority`

Rollback must always stop/verify the new authority before restoring the old authority.

`ZERO_PRODUCTION_MUTATION=true`
