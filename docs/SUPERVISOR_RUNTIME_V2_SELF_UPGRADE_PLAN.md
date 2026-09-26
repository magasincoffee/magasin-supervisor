# Supervisor Runtime V2 — Self-Upgrade Execution Plan

Status: **PLANNED / NOT DEPLOYED**  
Owner authority: **deployment requires an explicit Owner request**  
Execution mode: **Robot may modify Supervisor on an isolated branch and run CI/verification, but may not deploy itself**

## Objective

Upgrade MAGASIN Supervisor so the Robot remains continuously operational, self-recovers from bounded faults, never confuses stale Brain/Work state with current task state, and minimizes any maintenance interruption to active production lanes.

The Robot is allowed to use Brain + Work to repair and improve Supervisor itself. Self-repair work must remain isolated from the production runtime until the Owner explicitly authorizes deployment.

## Non-negotiable safety rules

1. **No automatic production deploy.**
   - Robot may create branches, commits, tests, PRs, diagnostics, and verification evidence.
   - Robot must stop at `READY_FOR_OWNER_DEPLOY`.
   - Only an explicit Owner instruction may authorize merge/deploy/hotpatch into the running production runtime.

2. **Protect active lanes.**
   - Do not interrupt `dispatch_inflight`, `relay_inflight`, an unconsumed Work result, or an unsafe mutation boundary.
   - Changes that can be developed/tested without touching production must be done while lanes continue running.

3. **Minimal downtime.**
   - Prefer source hotpatch / Three-Lane child replacement over wrapper or Chrome restart.
   - Restart Chrome only when required by browser-launch configuration or unrecoverable CDP/browser state.
   - Target interruption:
     - src hotpatch / Three-Lane child: 5–15 seconds
     - wrapper restart: 15–30 seconds
     - dedicated Chrome restart: under 60 seconds
   - If a safe boundary is unavailable, wait rather than force a restart.

4. **Exact-once remains authoritative.**
   - Preserve Brain → Work → RESULT → VERIFY → ACCEPT/REJECT → NEXT PLAN.
   - Never resend a task, result, merge, comment, or mutation blindly after uncertainty.
   - Correlate every action to durable task/dispatch/relay identity.

5. **Owner STOP always wins.**

## Brain operating contract

When the Robot sends work into the Brain conversation:

1. Read the current project Source of Truth and durable Supervisor state.
2. Select exactly one bounded task at a time.
3. Prefer tasks that can be completed in approximately 10–20 minutes of active implementation when safely decomposable.
4. Give Work one outcome, dependency context, scope, Definition of Done, evidence requirement, and stop boundary.
5. After Work returns evidence, VERIFY before issuing ACCEPT or REJECT.
6. Do not start the next task before verification is complete.
7. If a Supervisor self-upgrade task reaches implementation completion, record it as ready but **do not deploy** unless Owner explicitly authorizes deployment.
8. If a required change would affect an active lane, mark that step `DEFER_UNTIL_OWNER_DEPLOY` and continue with non-disruptive work where possible.

## Target architecture

Refactor the current large runtime toward:

**Observer → Correlator → Pure Reducer → Durable Transition → Effect Executor → Confirmation → Next State**

Every major action should have a causal chain:

`brain_request_id → directive_id → dispatch_id → result_id → relay_id → verdict_id`

A browser tab is never business truth. Durable registry/state remains authoritative.

## Roadmap

### P0-A — Runtime V2 state-machine extraction

Goal: reduce the blast radius of `src/runtime/three-lane-cli.mjs` without intentionally changing production behavior.

Scope:
- split observation, reconciliation, transition/reducer, effect execution, and confirmation responsibilities;
- preserve current schemas and exact-once latches;
- add parity tests before behavior changes;
- keep old entrypoint as compatibility shell during migration.

Estimated active work: **6–9 hours**.

Production impact during development: **none**.

### P0-B — End-to-end causality / trace correlation

Goal: make every Brain/Work transition attributable to exactly one current task.

Scope:
- durable correlation chain across Brain request, Work dispatch, result capture, Brain relay, and verdict;
- prevent stale responses from satisfying a newer task;
- expose privacy-safe trace identifiers in diagnostics/events;
- restart-safe correlation.

Estimated active work: **3–4 hours**.

Production impact during development: **none**.

### P0-C — Dispatch self-heal and bounded repair escalation

Canonical backlog alignment: issue #68.

Required behavior:
- heartbeat/progress evidence during active work;
- warning after 180 seconds without confirmed progress;
- STALLED after 300 seconds when eligibility conditions hold;
- maximum 3 bounded recovery attempts;
- durable/GitHub reconciliation before every retry;
- no blind resend;
- maintenance lock + one bounded repair incident after recovery exhaustion;
- repair must be Brain-verified before the frozen product task resumes.

Estimated active work: **4–6 hours**.

Production impact during development: **none**.

### P0-D — ChatGPT DOM compatibility layer

Goal: prevent UI markup changes from silently making Robot blind.

Scope:
- selector profiles/capabilities instead of one hard-coded DOM assumption;
- ordered modern + legacy message-turn adapter;
- fixture tests for known DOM variants;
- explicit `DOM_UNSUPPORTED` fail-closed state;
- bounded recovery without reload storms.

Estimated active work: **3–4 hours**.

Production impact during development: **none**.

### P0-E — Repository Source-of-Truth cleanup

Goal: prevent Brain from reading obsolete roadmap/PR state and selecting the wrong work.

Scope:
- identify and close/supersede obsolete PRs/issues;
- add one machine-readable Supervisor roadmap;
- states: `PLANNED | ACTIVE | DONE | BLOCKED | SUPERSEDED | READY_FOR_OWNER_DEPLOY`;
- keep current main SHA/runtime capability references;
- reconcile draft self-heal plan with implementation already present on main.

Estimated active work: **1–2 hours**.

Production impact: **none**.

### P1-A — Pipeline latency telemetry

Measure:
- Brain response complete → detected
- detected → Work send intent
- Work send intent → confirmed
- Work response complete → captured
- captured → Brain relay
- Brain relay → confirmed
- Brain verdict complete → next directive

Expose current step, age and retry state in Control Center.

Estimated active work: **3–5 hours**.

Production impact during development: **none**.

### P1-B — Priority / event-assisted scheduler

Priority order:
1. result ready / relay confirmation
2. dispatch confirmation / send recovery
3. Brain directive adoption
4. new planning request
5. idle observation

Polling remains a fallback/watchdog, not the only wake-up mechanism.

Estimated active work: **4–6 hours**.

Production impact during development: **none**.

### P1-C — Transaction revision / recovery journal

Scope:
- monotonic `state_revision`;
- transition journal for durable boundaries;
- crash/restart resumes from last committed transition;
- remove ambiguity among multiple booleans where possible.

Estimated active work: **3–5 hours**.

Production impact during development: **none**.

### P1-D — Control Center “WHY NOT MOVING?”

Per lane show:
- CURRENT STEP
- WAITING FOR
- STATE AGE
- RETRY x/y
- LAST CONFIRMED ACTION
- last safe error/reason code
- project progress
- runtime/process/CDP truth

Estimated active work: **3–5 hours**.

Production impact during development: **none**.

### P1-E — Event/log lifecycle hardening

Scope:
- bounded append-only event segments;
- rotation by size;
- preserve privacy-safe schema;
- no chat bodies, tokens or full private conversation URLs;
- diagnostic reconstruction by correlation IDs.

Estimated active work: **2–3 hours**.

Production impact during development: **none**.

### P1-F — Runtime identity cleanup

Scope:
- expose exact Git SHA/build manifest instead of relying on stale static runtime version labels;
- reconcile canonical state root and remove production ambiguity with legacy BusinessOS fallback after migration-safety review.

Estimated active work: **2–3 hours**.

Production impact during development: **none**.

### P2 — Optional fast browser executor

Use only after P0/P1 reliability work is verified.

Scope:
- benchmark optional fast executor against current Chromium/CDP path;
- current CDP route remains fallback;
- no browser-engine migration solely for perceived speed.

Estimated active work: **6–10 hours**.

Production impact during development: **none**.

## Total estimate

Core reliability scope P0 + P1: approximately **27–41 hours active work**.

Expected wall-clock with CI, Brain VERIFY/ACCEPT, retries and bounded task sequencing: approximately **2–3 days of continuous Robot operation**.

P2 fast executor is separate.

## Deployment gate

The self-upgrade project is complete only when all selected tasks are verified and the branch is in:

`READY_FOR_OWNER_DEPLOY`

At that point the Robot must stop and wait for an explicit Owner instruction.

A deployment plan must state:
- exact main/head SHA;
- current active lane safety state;
- whether Three-Lane, wrapper, or Chrome must restart;
- expected interruption;
- rollback SHA/path;
- post-deploy live acceptance checks.

No deployment is authorized by this document itself.
