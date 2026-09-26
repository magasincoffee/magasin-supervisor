# Legacy Lifecycle Truth Compatibility Pointer

Status: **SUPERSEDED / NON-CANONICAL**

This path exists only because the current MIG-004 static integrity workflow verifies that the historical lifecycle-document path is present.

The old Three-Lane lifecycle architecture content is no longer authority.

Canonical forward Source of Truth:

- `docs/SUPERVISOR_SINGLE_LANE_CHATGPT_FIRST_V3_SOURCE_OF_TRUTH.md`
- `docs/SUPERVISOR_SINGLE_LANE_CHATGPT_FIRST_V3_SOURCE_OF_TRUTH.json`

Preserved safety invariants are defined there, including process truth before persisted recovery state, exact-once delivery, bounded recovery, and Owner STOP/AUTOSTART_DISABLED precedence.

Do not use this file to plan or implement Three-Lane behavior.
