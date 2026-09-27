# MAGASIN Supervisor — Planner / Executor V1 Source of Truth

Status: **CANONICAL FORWARD ARCHITECTURE**

This document is the forward architecture authority for MAGASIN Supervisor after Owner approval on 2026-09-27.

It supersedes the unmerged Single-Lane V3 planning lineage represented by PRs #102, #103, #104, #105, #106 and #108. Those branches remain available only as implementation/reference material and must not be merged as-is.

This document does **not** by itself cut over the currently released production runtime. The released Three-Lane runtime remains the rollback/production baseline until Planner/Executor V1 passes its own qualification and the Owner authorizes cutover.

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

### PE-001 — P0 / EXECUTE FIRST
**Planner/Executor minimal end-to-end vertical slice**

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

### PE-002 — Compact protocol and newest-turn parser
Implement strict `@M` v1 parsing, latest-turn-only observation, correlation validation, and fail-closed malformed-frame handling.

### PE-003 — Two warm-tab runtime
Replace the forward orchestration path with exactly Planner + Executor warm conversations and no normal Three-Lane scheduler dependency.

### PE-004 — Exact-once and recovery
Implement assignment/result exact-once latches, restart reconciliation, persisted last-seen turn IDs, and exact-digest orphan-draft recovery.

### PE-005 — Legacy-state migration adapter
Map existing Brain/Work state to Planner/Executor state without losing active task, target revisions, assignment/result identity, Owner STOP, or recovery truth.

### PE-006 — Automated continuation
Automate report relay, Planner review, `accept_assign`, bounded reject/correction flow, health recovery, and failure-only diagnostics.

### PE-007 — Qualification and cutover
Run regression + live qualification, prove 2-tab invariant, no ChatGPT Work mode, no duplicate assignment/result, bounded stalled-draft recovery, then perform Owner-authorized production cutover. Retain an exact released legacy snapshot for rollback.

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

Current production is not considered cut over to Planner/Executor V1 until PE-007 qualification and explicit Owner authorization.
