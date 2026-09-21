# MAGASIN Supervisor Three-Lane V1 — TASK-RBT-009 Release Evidence

Status: **IMPLEMENTATION CANDIDATE / FINAL 8H SOAK PENDING**

This document is the canonical closure location for TASK-RBT-009. It must not be changed to RELEASED until the exact implementation SHA has completed one uninterrupted 8-hour Tier B production soak and the docs-only closure PR is merged.

## Release candidate baseline

- Baseline main before TASK-RBT-009: `29d38fd1622c63caae900b33b8f2a5aad1447ccc`
- Runtime before TASK-RBT-009: `v2026-09-20.60`
- Runtime behavior changed by implementation candidate: **NO**
- Runtime version bump required: **NO**, because TASK-RBT-009 adds test/workflow/release-validation assets only and does not modify installed Supervisor runtime semantics.
- TASK-RBT-001 through TASK-RBT-008: canonical accepted baseline.
- TASK-RBT-009: final roadmap task.

## Two-tier acceptance model

### Tier A — isolated deterministic pressure

The release matrix runs against synthetic state/adapters and reuses canonical RBT-003 through RBT-008 regression assets. It covers:

- one, two and three enabled lanes;
- round-robin fairness and bounded scheduler turns;
- global page budget <= 3;
- mutation singleton;
- active >30m watchdog with no elapsed-time-only reload;
- inactive >30m watchdog with one persisted reload intent per recovery epoch;
- Owner Work hot-save pending-target semantics;
- stale target durable quarantine and repeated reopen suppression;
- Brain ACCEPT/REJECT correlation and bounded correction;
- metadata-only dispatch/relay exact-once validation;
- existing Work-full rollover, relay rearm, Control Panel, Owner START and planning fixtures.

No production Brain or Work URL is used by Tier A.

### Tier B — installed production read-only soak

Workflow: `.github/workflows/supervisor-rbt009-soak.yml`

Monitor: `.github/scripts/supervisor-rbt009-soak.ps1`

The production job is self-hosted, serialized, and runs for 480 continuous minutes at bounded sampling cadence. Before occupying the self-hosted runner it waits until Supervisor Tests, Supervisor Integrity, Supervisor Autostart Install and Supervisor Lifecycle Acceptance for the same candidate SHA are all SUCCESS.

The monitor reads local lifecycle/process/status/event state only. It does not:

- navigate ChatGPT;
- open an extra ChatGPT page;
- send messages;
- reload a page;
- change lane configuration;
- rearm relay;
- trigger Work rollover;
- clear Owner STOP or AUTOSTART_DISABLED.

If Owner STOP is present or appears during the soak, the release soak fails closed.

## Privacy contract

Uploaded soak artifacts contain only allowlisted metadata:

- release SHA/runtime version;
- timestamps and durations;
- page/process health counters;
- opaque SHA-256 fingerprints;
- event counts and recovery counters.

Artifacts must not contain Brain/Work URLs, URL path fragments, message content, screenshots, cookies, tokens, account identifiers or local secret-bearing profile paths. Generated artifacts are scanned before upload.

## Exact-once validator

`.github/scripts/supervisor-release-event-validator.mjs` validates metadata-only event streams for:

- duplicate `WORK_DISPATCH_CONFIRMED` correlations;
- duplicate `RESULT_RELAY_CONFIRMED` correlations;
- dispatch before assignment;
- Work progress/completion before confirmed dispatch;
- relay before Work completion;
- Brain ACCEPT/REJECT before matching relay;
- rollover dispatch confirmation before rollover target persistence.

Legacy paths without semantic verdict remain valid.

## Cleanup decision

No existing RBT-003 through RBT-008 acceptance fixture is deleted. They remain permanent regression assets. No v59/v60 migration compatibility path is removed because installed-state/backward-compatibility evidence still depends on those paths.

No temporary production instrumentation is added to the Supervisor runtime. The RBT-009 monitor and validator live under GitHub release tooling and can remain reusable for future release audits.

## Final closure fields — PENDING

These fields must be filled only from completed GitHub evidence:

- implementation PR: PENDING
- implementation head SHA: PENDING
- implementation merge / soaked runtime SHA: PENDING
- Supervisor Tests run/job: PENDING
- Supervisor Integrity static/runtime run/jobs: PENDING
- Supervisor Autostart Install + verify-survival run/jobs: PENDING
- Supervisor Lifecycle Acceptance A-L run/job: PENDING
- Tier A run/job: PENDING
- Tier B 8h soak run/job: PENDING
- soak start UTC: PENDING
- soak end UTC: PENDING
- continuous duration: PENDING
- exact dispatch confirmations: PENDING
- exact relay confirmations: PENDING
- page-budget maximum: PENDING
- Chrome/CDP recovery episodes: PENDING
- production target fingerprints unchanged: PENDING
- artifact privacy scan: PENDING
- docs-only closure PR/SHA: PENDING

## Required final markers

Project release remains blocked until the completed soak evidence contains all required semantics, including continuous 8h duration, 1/2/3-lane pressure, page budget, mutation singleton, no starvation, active/inactive watchdog cases, no duplicate dispatch/relay, full rollover, hot-swap, stale-target suppression, Brain planning, Lifecycle A-L, Owner STOP authority, Chrome/CDP health, privacy, unchanged production targets and monitor zero browser mutation.

**Do not mark Three-Lane V1 RELEASED while this document says PENDING.**
