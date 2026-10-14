# MPC-008 — Supervisor telemetry, SOURCE/QA contract (2026-10-14)

Authority: `SOURCE_OF_TRUTH.md` on `main`. This document is implementation evidence, NOT an independent SOT, H4 installation approval or Owner START authorization.

## Scope
- The existing Control Center project tree displays a **read-only** Supervisor observation panel only for `supervisor` selections.
- Reuse existing same-origin `GET /api/robot/supervisor` and explicitly serve its new browser module at `GET /project_supervisor_telemetry.mjs`. No new POST, Issue creation, business dispatch, SOT update or Owner approval issuer.
- On H4, `server.py` observes file presence of `STOP` and `AUTOSTART_DISABLED`. Only the **live marker observation** controls the displayed latch state; stale `guardian-status.json` values cannot override it. A non-H4 machine, exception or missing evidence becomes UNKNOWN, never permission to start.
- `supervisor_project_links.inspect()` already supplies configured SOT metadata and `PENDING_SOT_REVIEW` proposals. A configured link is NOT verified execution, Owner authorization, or selected live worker project.
- Timestamp heartbeat is transport-only: recent, stale or unknown; it does not prove task execution.
- **Actual business work remains NOT_VERIFIED and dispatch remains NOT_QUALIFIED** regardless of process, `RUNNING`, active_task, heartbeat or green CI. No task can be marked VERIFIED_DONE from telemetry.
- Client fetch is abortable and bounded to 3.5 seconds, canceled on navigation, and is processed before a fresh Owner session validation. A stale fetch cannot unlock Owner requests.
- No credentials, session cookies, private SQLite, raw log content or sensitive worker details are displayed.

## Fail-closed acceptance
Negative fixture `test/mpc008-supervisor-telemetry.test.mjs` covers Owner STOP precedence, disabled autostart, non-H4, absent marker, RUNNING/active_task forgery, stale/future/zone-less heartbeat, malformed pending requests, hostile links, other projects, safe Vietnamese rendering, retained login session boundary and no control endpoints.

Both `Supervisor Tests` and `Supervisor Integrity` run the new fixture; `Supervisor Lifecycle Acceptance` and `Supervisor Autostart Install` must also succeed at the **same PR head**. Independent Codex final-head review, reviewed merge and exact-main readback are mandatory before claiming MPC-008 SOURCE/QA VERIFIED.

## Operational non-acceptance
This work does NOT install or stage code on DESKTOP-H4A16IL; H4 rollout, authentication, mobile usability, actual runtime telemetry, Owner acceptance, SC-013 P1–P3, business executor, and production START/STOP decisions remain separately gated. A future H4 field failure must report UNKNOWN/HOLD rather than synthesize task activity.
