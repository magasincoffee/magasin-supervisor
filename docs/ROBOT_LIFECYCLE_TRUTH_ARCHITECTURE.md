# Legacy Lifecycle Truth Compatibility Pointer

Status: **SUPERSEDED / NON-CANONICAL**

This path exists only because current MIG-004/static regression guards still verify the historical lifecycle-document path and a small set of legacy markers.

The old Three-Lane lifecycle architecture content is no longer authority.

Canonical forward Source of Truth:

- `docs/SUPERVISOR_SINGLE_LANE_CHATGPT_FIRST_V3_SOURCE_OF_TRUTH.md`
- `docs/SUPERVISOR_SINGLE_LANE_CHATGPT_FIRST_V3_SOURCE_OF_TRUTH.json`

Compatibility markers retained for existing regression tests only:

- PROCESS TRUTH
- LANE TRUTH
- PERSISTED RECOVERY STATE
- QUESTION
- DELETE
- SIMPLIFY
- ACCELERATE
- AUTOMATE

For V3, the canonical interpretation and all active planning come only from the Single-Lane V3 Source of Truth. Owner STOP/AUTOSTART_DISABLED precedence, exact-once delivery and bounded recovery remain preserved invariants.

Do not use this file to plan or implement Three-Lane behavior.
