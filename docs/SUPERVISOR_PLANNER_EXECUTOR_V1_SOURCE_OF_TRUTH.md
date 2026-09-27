# MAGASIN Supervisor — Planner / Executor V1 Source of Truth

Status: **CANONICAL PRODUCTION ARCHITECTURE**

This document is the forward architecture authority for MAGASIN Supervisor after Owner approval on 2026-09-27.

It supersedes the unmerged Single-Lane V3 planning lineage represented by PRs #102, #103, #104, #105, #106 and #108. Those branches remain available only as implementation/reference material and must not be merged as-is.

Planner/Executor V1 is the active production orchestration architecture. The released Three-Lane runtime is retained only as a rollback/historical baseline.

## 1. Canonical role model

There are exactly two Robot-controlled ChatGPT conversation roles:

- **Planner** — reviews project state, plans, selects one next task, assigns it, reviews evidence, ACCEPTs or REJECTs, and selects the next task.
- **Executor** — executes exactly one assigned task, verifies the result, reports evidence, and waits for the next assignment.

Canonical loop:

```text
Owner -> Planner -> Executor -> Planner -> Executor -> ...
```

Forward runtime terminology MUST use **Planner** and **Executor**.

The legacy names **Brain** and **Work** are deprecated for forward runtime semantics. They may remain only in rollback snapshots, historical evidence, and bounded migration adapters.

## 2. ChatGPT product boundary

Planner and Executor are two normal ChatGPT conversations.

**Invariant: MAGASIN Supervisor MUST NOT invoke or depend on ChatGPT Work mode for Planner/Executor orchestration.**

The word `Executor` is a Supervisor role and does not mean the ChatGPT Work product.

Normal production topology:

```text
TAB 1 = Planner conversation
TAB 2 = Executor conversation
```

Target steady-state resident ChatGPT page count: **2**.

## 3. Authority model

ChatGPT conversation text is not the durable orchestration database.

**Supervisor local durable state is authoritative** for:

- project identity;
- Planner/Executor exact target identity and revision;
- active task;
- assignment identity;
- result identity;
- exact-once latches;
- last-seen turn identity;
- pending/recovery state;
- Owner STOP / lifecycle state.

Chat content is used for reasoning, execution, and compact machine signaling.

## 4. Machine protocol

The canonical machine envelope is one final single-line JSON frame:

```text
@M { ... }
```

The Robot reads only the newest relevant assistant turn and extracts the final valid `@M ` line. It MUST NOT require full-history DOM scanning on the normal path.

Protocol version field:

```json
{"v":1}
```

Canonical actions:

- `assign`
- `report`
- `accept_assign`
- `reject`
- `blocked`
- `resume`
- `stop`
- `done`

Recommended short field names:

- `v` — protocol version
- `a` — action
- `t` — current task_id
- `i` — assignment_id
- `r` — result_id
- `n` — next_task_id
- `s` — report status
- `p` — project_id (project-aware profile mode)
- `g` — project_generation (project-aware profile mode)
- `pc` — completed task count from Source of Truth
- `pt` — total task count from Source of Truth

Examples:

Planner assignment:

```text
@M {"v":1,"a":"assign","t":"UI2-013","i":"A18"}
```

Executor report:

```text
@M {"v":1,"a":"report","t":"UI2-013","i":"A18","r":"R18","s":"pass"}
```

Planner accepts and assigns the next task in one transaction:

```text
@M {"v":1,"a":"accept_assign","t":"UI2-013","r":"R18","n":"UI2-014","i":"A19"}
```

Unknown additive fields may be ignored. Malformed or correlation-mismatched frames fail closed.

## 4A. Multi-project profiles and project Source of Truth

Planner/Executor V1 supports multiple saved **Project Profiles**, while keeping exactly **one active project** and exactly **two active normal ChatGPT conversations** at runtime.

Each profile owns:

- `project_id` and project display name;
- Owner-configured **Source of Truth URL**;
- exact Planner chat URL;
- exact Executor chat URL;
- monotonically increasing `project_generation`;
- a per-project durable state snapshot.

Switching project is fail-closed: the Robot must be stopped and there must be no in-flight assignment/result. The current active state is snapshotted before another profile becomes active.

When a project is loaded, or its Source of Truth URL changes, Supervisor re-arms `MAGASIN_PROJECT_BOOTSTRAP_V1`. The first Planner instruction for that project generation requires Planner to read the configured Source of Truth before assigning work. After bootstrap, machine frames are correlated to the exact `project_id` and `project_generation`; stale output from another project/generation is rejected.

Project-aware additive `@M` fields are:

- `p` — project_id;
- `g` — project_generation;
- `pc` — completed task count read from project Source of Truth;
- `pt` — total task count read from project Source of Truth.

The Control Panel progress bar is a projection of durable `pc/pt` state reported by Planner from the configured Source of Truth. Chat conversation memory is never the authority for project completion.

Saving or editing a **non-active** Project Profile is configuration-only. It MUST be allowed without switching the active project, and it MUST NOT mutate the active project's task, assignment/result latches, generation, or runtime state. Safe-boundary requirements apply to **project activation/switching** and to mutation of the **currently active** profile's Source/Planner/Executor targets.

Implementation authority: PR #153, merge `e928bc03980f564c007a97b197f1b8af7c727fde`.

## 5. Happy-path performance contract

Normal task cycle should require no separate ACK message.

Target flow:

```text
Planner decision/assignment
  -> Executor result
  -> Planner accept_assign
```

Target: **<= 3 ChatGPT sends per completed happy-path task cycle**.

A Planner `accept_assign` closes the reviewed task and opens the next assignment in the same Planner response.

## 6. Browser/runtime contract

Normal path:

1. observe only the newest unseen assistant turn;
2. parse its final `@M` frame;
3. validate correlation;
4. persist durable intent/state;
5. switch to the target warm conversation;
6. fill the composer;
7. actuate Send;
8. confirm the new user turn;
9. release the mutation boundary;
10. wait for the next new assistant turn.

Reuse the released bounded composer actuation and strict verification work from the current main lineage, including the submit flight recorder and matching-user-turn confirmation.

Normal Planner/Executor runtime MUST NOT require:

- Three-Lane round-robin scheduling;
- six logical Brain/Work target ownership;
- full conversation rescans;
- separate ACK / STARTED / WORKING chatter;
- ChatGPT Work mode.

## 7. Exact-once and stalled-draft recovery

Exact-once identities:

- `assignment_id` replaces forward semantic use of `dispatch_id`;
- `result_id` replaces forward semantic use of `relay_id`.

Durable intent MUST be persisted before replay-sensitive browser mutation.

If the Robot crashes after filling a composer but before successful submission, recovery may submit the existing draft only when its normalized digest exactly matches the persisted Robot-owned pending instruction and correlation state. An unrelated or Owner-authored draft MUST be preserved and must block automatic overwrite.

A send is not successful merely because a click returned. Success requires an observed matching new user turn.

## 8. Legacy migration mapping

Forward names:

```text
brain_url           -> planner_url
brain_url_revision  -> planner_url_revision
work_url            -> executor_url
work_url_revision   -> executor_url_revision
work_generation     -> executor_generation
dispatch_id         -> assignment_id
relay_id            -> result_id
```

Legacy names may remain in a read/migration adapter and rollback-only source. New forward runtime code must not introduce new Brain/Work semantics.

## 9. Elon Musk 5-step execution discipline

All implementation tasks follow this order:

1. **Question every requirement** — identify the authority and prove the requirement is necessary.
2. **Delete** — remove unnecessary steps, messages, state, scans, tabs, and duplicated semantics before optimizing them.
3. **Simplify** — reduce to one canonical state machine, one protocol frame, and the smallest durable state needed.
4. **Accelerate** — use two warm tabs, newest-turn observation, compact frames, combined `accept_assign`, and bounded browser actions.
5. **Automate** — only after the flow is correct and simple, automate continuation, recovery, health checks, and qualification.

Automation must never preserve unnecessary complexity merely because it already exists.

## 10. Implementation roadmap

### PE-001 — P0 / QUALIFIED COMPLETE
**Planner/Executor minimal end-to-end vertical slice**

Implementation PR #120 merged at `4ba8d836dc227b312ede15a9f176be6ed4a6de85`.

Current evidence:
- Supervisor Tests run `36288896091`: full suite **711/711 PASS**;
- Supervisor Integrity run `36288896111`: **PASS**;
- Supervisor Lifecycle Acceptance run `36288896100`: isolated acceptance **PASS**;
- Supervisor Autostart Install run `36288896093`: isolated contract **PASS**;
- PE-001 focused tests prove 3-send happy path, durable-before-send ordering, exact-digest populated-draft recovery, foreign-draft preservation, and restart no-duplicate fail-closed behavior.

**PE-001 live Planner/Executor qualification PASSED on run `36291749758`, target job `108543035889`, at main `0fb8b5112e4e2a77b08966616d2be4a0e065cb01`.**

Live evidence proved:
- target machine `DESKTOP-4K7IM13`;
- exactly **2 normal ChatGPT chats** for Planner + Executor;
- **0 ChatGPT Work mode invocations**;
- Planner `assign` -> Executor `report` -> Planner `accept_assign` -> next Executor assignment;
- exactly **3 cycle sends**, each confirmed by `matching-user-turn-observed`;
- production state, production targets and state-root binding unchanged;
- qualification-owned Chrome cleaned up after PASS.

**Production cutover remains false. PE-001 is qualified, not production-cutover. PE-002 is the next execution task.**

Primary outcome: prove the new architecture end-to-end on top of current main without broad legacy cleanup.

Required proof:

```text
Planner assign
-> durable persist
-> Executor normal-chat send
-> Executor report
-> durable persist
-> Planner review
-> accept_assign
```

PE-001 MUST reuse the current main composer send/verification layer instead of creating another browser-action stack.

### PE-002 — COMPLETE
**Compact protocol and newest-turn parser**

PR #127 merged at `0684e94a21292d2d4b3cb966f2e9338ab45070d1`.

Implemented:
- canonical `src/runtime/machine-frame.mjs` for strict `@M` v1 parsing, serialization, action guards and correlation guards;
- canonical `src/runtime/latest-machine-turn.mjs` for newest-unseen-turn parsing;
- Planner/Executor runtime no longer carries duplicate protocol/correlation parsing logic;
- final-line machine semantics remain authoritative;
- unknown additive fields remain forward-compatible;
- malformed output and task/assignment/result mismatches fail closed;
- normal path still performs no full-history conversation scan.

Regression gates passed: Supervisor Tests `36292309245`, Integrity `36292309225`, Lifecycle `36292309213`, Autostart isolated `36292309228`.

**PE-003 is the next execution task.**

### PE-003 — COMPLETE
**Two warm-tab runtime**

PR #129 merged at `a2f99e5523cf7f2526c6a86f40738a89638b9fac`.

Implemented:
- one exact warm Planner page + one exact warm Executor page;
- continuous fail-closed page-count and target-identity guard;
- only a safe empty landing tab may be closed automatically; unrelated conversations or draft-bearing tabs are preserved and block;
- local durable Planner/Executor state is target authority;
- first start requires explicit project/Planner/Executor values; conflicting later target overrides fail closed;
- assistant parsing is gated while ChatGPT is still busy;
- forward CLI has no Three-Lane scheduler dependency;
- ChatGPT Work mode invocation count remains zero;
- production wrapper is not rewired and production cutover remains false.

Regression gates passed: Supervisor Tests `36292664760`, Integrity `36292664717`, Lifecycle `36292664723`, Autostart isolated `36292664733`.

**PE-004 is the next execution task.**

### PE-004 — COMPLETE
**Exact-once and recovery**

PR #131 merged at `f6122c448432b1ee7d3118510c1791e2ffe45105`.

PE-004 deliberately reused the PE-001 durable latches instead of creating a second recovery system. Added hardening:
- outbound assignment/result intent stores a persisted user-turn baseline before send;
- identical historical text can no longer falsely confirm a new send; reconciliation requires a newer matching user turn;
- bounded durable assignment/result identity history rejects ID reuse;
- pre-PE-004 states seed identity history additively from current/last-completed durable identities;
- exact-digest Robot-owned composer draft recovery remains the bounded retry path;
- foreign/Owner drafts remain protected;
- ambiguous attempted send without exact draft remains no-duplicate fail-closed;
- crash after result send confirmation but before relay confirmation advances state without resending;
- focused crash-matrix coverage validates durability boundaries.

Regression gates passed: Supervisor Tests `36292966975`, Integrity `36292966966`, Lifecycle `36292967002`, Autostart isolated `36292966990`.

**PE-005 is the next execution task.**

### PE-005 — COMPLETE
**Legacy-state migration adapter**

PR #134 merged at `9c4d8559f64c2b716b5db45ec790593db8afcc8d`.

Implemented a read-only explicit-lane migration candidate builder:
- active legacy Brain target maps to Planner target; active Work target maps to Executor target;
- target revisions, project label, active task and bounded assignment/result identity history are preserved;
- requested/pending target authority, Executor generation, project progress/timing and unresolved legacy latches are preserved as migration metadata;
- STOP and AUTOSTART_DISABLED are read and preserved as Owner-stop authority;
- unresolved active task, awaiting result, old assignment/result relay/Planner request latches, pending target revisions, missing targets or Owner STOP all make the candidate `cutover_ready=false`;
- unresolved old protocol latches are never replayed or converted into new `@M` messages;
- reader performs no writes, browser actions, process actions or ChatGPT Work mode invocation.

Regression gates passed: Supervisor Tests `36293299858`, Integrity `36293299799`, Lifecycle `36293299850`, Autostart isolated `36293299812`.

**PE-006 is the next execution task.**

### PE-006 — COMPLETE
**Automated continuation**

PR #137 merged at `41baa45fc3e06a691021ca6abfcd63ae351f0b9b`.

Implemented:
- preserves the existing 3-send happy path and PE-004 exact-once latches;
- `reject` can carry a fresh assignment id plus a non-empty correction body, allowing one Planner response to reject and dispatch exactly one bounded correction without another Planner round trip;
- reject without a bounded correction fails closed as BLOCKED instead of looping;
- `blocked`, `resume`, `stop`, and `done` are persisted automation states;
- DONE/STOPPED are terminal runtime phases;
- pre-step warm-tab drift gets only bounded safe reacquisition; unrelated conversations and draft guards still fail closed;
- failure-only `planner-executor-incidents.ndjson` records privacy-safe metadata only, excluding URLs and message bodies;
- production wrapper remains unchanged and production cutover remains false.

Regression gates passed: Supervisor Tests `36294115756`, Integrity `36294115776`, Lifecycle `36294115768`, Autostart isolated `36294115779`.

**PE-007 is now READY_TO_EXECUTE.**

### PE-007 — PRODUCTION CUTOVER COMPLETE
**Qualification and Owner-authorized cutover**

PE-007 live qualification and Owner-authorized production cutover are complete.

Authoritative production cutover evidence:

- workflow run `36299510864`: **PASS**;
- candidate `514e2aadfa0878e6f2aa7f9249622e87449d494f`;
- target machine `DESKTOP-4K7IM13`;
- authoritative evidence commit `542460e7fc4c34f234f7e7c214b541b54d5b9c65`;
- evidence file `.github/qualification/pe007-cutover-latest.json`;
- production mode `PLANNER_EXECUTOR_V1`;
- exactly **2** normal ChatGPT tabs;
- **0** ChatGPT Work mode invocations;
- rollback snapshot ready before production mutation;
- authority gate accepted only the real target-machine PASS.

The production runtime is now Planner/Executor V1. Three-Lane remains available only through the retained rollback snapshot/historical release evidence.


## 11. Non-goals before PE-001 is proven

Do not:

- rename the entire repository first;
- delete rollback source first;
- rewrite all historical RBT/MIG evidence;
- build another scheduler;
- create another browser-control abstraction;
- optimize unproven future cases;
- merge the superseded #102-#108 planning lineage as-is.

## 12. PE-001 acceptance gates

PE-001 is not complete until all are true:

- two normal ChatGPT conversations only: Planner + Executor;
- zero ChatGPT Work mode invocation;
- local durable state is authoritative;
- Planner emits a valid assignment frame;
- Supervisor persists assignment before send;
- Executor receives exactly one assignment;
- Executor emits a correlated report frame;
- Supervisor persists result before relay;
- Planner receives the report and emits a correlated decision;
- `accept_assign` can assign the next task without a separate ACK cycle;
- composer send requires matching-user-turn evidence;
- a populated but unsent Robot-owned draft does not deadlock indefinitely;
- restart does not duplicate assignment or result;
- normal path does not scan full conversation history.

## 13. Success KPIs

- resident ChatGPT tabs: **2**
- ChatGPT Work mode invocations: **0**
- happy-path ChatGPT sends per task cycle: **<= 3**
- full-history DOM scans on normal path: **0**
- duplicate assignment after recovery: **0**
- duplicate result after recovery: **0**
- unbounded populated-composer stall: **0**

## 14. Source-of-Truth precedence

For forward Supervisor architecture, this document and its machine-readable companion:

`docs/SUPERVISOR_PLANNER_EXECUTOR_V1_SOURCE_OF_TRUTH.json`

override conflicting forward-planning language in older architecture/planning documents.

Historical release evidence remains historical truth for the runtime version it documents.

Current production is Planner/Executor V1. PE-007 production cutover completed successfully under explicit Owner authorization; Three-Lane is rollback/historical only.
