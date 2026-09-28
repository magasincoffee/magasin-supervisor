# MAGASIN Supervisor — Planner / Executor V1 Source of Truth

Status: **CANONICAL PRODUCTION ARCHITECTURE**

Next implementation program: **MAGASIN BRIDGE V1 — CANONICAL PLAN / NOT YET CUT OVER**

Current next-phase task: **MBV1-001 — Local Bridge Baseline** (pc=0, pt=8).

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

**Project authority is the Owner-provided Source of Truth URL.**

Planner MUST read the Source of Truth at the beginning of every STARTed live session and derive project scope, task status, dependencies, completed task count (`pc`) and total task count (`pt`) from that source. The Control Center progress bar is only a projection of those Planner-reported `pc/pt` values.

Supervisor may keep the minimum **ephemeral runtime transaction state** needed while a live session is running (current assignment/result correlation, exact-once latches, latest-turn identity and recovery state). That runtime state is not project authority, is never a saved project profile, and is discarded by RESET. A later START reconstructs project context from the three current links rather than restoring a project snapshot.

Chat content is used for reasoning, execution, and compact machine signaling. It is not the project database.

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

## 4A. Link-only live session and Source of Truth

Planner/Executor V1 production Control Center is **link-only**. It accepts exactly three runtime inputs:

- Owner-configured **Source of Truth URL**;
- exact Planner ChatGPT conversation URL;
- exact Executor ChatGPT conversation URL.

There are no saved Project Profiles, no project switch/park flow, and no per-project state snapshots in the forward production UI.

START behavior:

1. validate the three current links;
2. discard any old local project-profile/snapshot artifacts;
3. create a fresh `LIVE` runtime session with generation 1;
4. open/acquire the exact Planner and Executor conversations;
5. send `MAGASIN_PROJECT_BOOTSTRAP_V1` to Planner;
6. Planner reads the Source of Truth from the beginning, determines `pc/pt`, and either assigns exactly one next task or returns `done`;
7. Control Center updates the progress bar from Planner `pc/pt`;
8. normal Planner -> Executor -> Planner continuation proceeds automatically.

A STOP followed by START is also a fresh Source-of-Truth rehydrate. The Robot does not restore a saved project snapshot.

RESET ROBOT semantics are intentionally destructive for local project/session data:

- STOP Robot first;
- delete local Source/Chat link state, progress, task, assignment/result, decision, last-completed pointer, exact-once/recovery state, profile registry/snapshots, incidents/status cache and submit diagnostics;
- leave only an empty `PLANNER_EXECUTOR_V1` mode shell so Control Center can reopen;
- clear the three link inputs in the visible Control Center;
- preserve only non-project infrastructure: Chrome login profile, installed Supervisor runtime and GitHub Runner.

After RESET, the Owner pastes the Source of Truth, Planner link and Executor link and presses START. Nothing from the prior project/session is reused.

Project-aware additive `@M` fields remain available as runtime correlation fields:

- `p` — runtime session project id (`LIVE`);
- `g` — runtime generation (fresh session starts at 1);
- `pc` — completed task count read from Source of Truth;
- `pt` — total task count read from Source of Truth.

The Source of Truth remains the authority for project completion. Local `pc/pt` exists only as the current UI/runtime projection.

Composer send safety for the `@M` machine frame:

- ChatGPT may interpret literal `@M` inside a Robot-authored prompt as an @-mention/file trigger and open a Files/Tệp suggestion popover above the composer;
- **Robot-authored outbound instructions MUST NOT contain literal `@M` examples.** They transport examples as `<AT>M`, explicitly define `<AT>` as U+0040, and instruct Planner/Executor to emit the real U+0040 + `M` prefix in the assistant response;
- inbound assistant machine frames remain canonical `@M {...}` and are parsed/correlated exactly as before; the transport encoding changes only Robot-to-ChatGPT prompt text, not the protocol;
- legacy/raw prompts may still be encountered after recovery. A reset can also advance `project_generation` while an older canonical Robot bootstrap draft is still visible in the Planner composer;
- Supervisor may automatically recover a **canonical historical Robot bootstrap** only when the composer text exactly matches a known canonical Robot template reconstructed from the identity embedded in that draft and the Source of Truth URL is identical to the current live session. Known templates include legacy raw-`@M`, the pre-link-only mention-safe `<AT>M` bootstrap, and the current link-only mention-safe `<AT>M` bootstrap;
- link-only START may reset runtime identity from an older project id/generation (for example `WEB/g3`) to `LIVE/g1`; that identity reset MUST NOT prevent exact canonical cleanup of the older Robot-owned bootstrap draft;
- canonical ownership comparison is **render-equivalent**: CRLF/LF, NBSP, zero-width characters and ProseMirror-only whitespace expansion are normalized before comparing the full canonical template. This prevents ChatGPT editor rendering from making a Robot-owned draft look foreign;
- after canonical ownership is proven, Supervisor dismisses transient mention/file UI and guarded-clears using the **exact digest of the live composer surface**, then clears only its bootstrap send-attempt latch and composes the current-generation mention-safe bootstrap;
- any populated draft that does not exactly match one of those canonical Robot templates remains foreign/Owner-authored and blocks automatic overwrite;
- Supervisor also keeps the bounded mention-popover dismissal path as defense in depth;
- an open mention/file popover is never treated as evidence that the prompt was submitted.

Control Center viewport:

- Planner/Executor Control Center uses a fixed logical canvas inside an AutoScroll viewport;
- vertical scrolling MUST remain available when Windows DPI scaling or a short display makes the logical canvas taller than the visible client area;
- lower controls and footer diagnostics must never become unreachable merely because the window cannot display the full logical height at once.

Dedicated browser continuity:

- Planner/Executor runtime is considered active independently of legacy `lanes.json` enabled-lane count;
- production hotpatch/deploy MUST NOT force-kill the dedicated Supervisor Chrome merely because enabled legacy lanes are zero while `PLANNER_EXECUTOR_V1` is running;
- an active Planner/Executor hotpatch replaces runtime source and restarts only the Supervisor child Node process, preserving the dedicated Chrome/CDP session and project state;
- dedicated Chrome launches with crash-restore UI suppressed so an earlier abnormal shutdown cannot leave a browser-level “Restore pages?” bubble over the automation surface.

Send-path liveness invariants:

- submit-flight diagnostics are observational only and MUST NEVER block composer actuation; DOM snapshots, screenshots, trace start/stop and diagnostic writes are bounded and failure-tolerant;
- mention-popover dismissal occurs before diagnostic capture after typing;
- if ChatGPT changes the Send button metadata, Supervisor may use a bounded geometric fallback restricted to the active composer form: a visible enabled compact action in the lower-right composer band, excluding attachment/file/voice/microphone/model/tool controls;
- a geometric click is still not submission evidence; matching user-turn confirmation remains mandatory;
- Planner/Executor status publishes the observed ChatGPT tab count before bootstrap send begins so Control Center cannot display a healthy process with an unexplained tab count of `—`.

Bootstrap liveness across ChatGPT rerenders/reloads:

- light/dark appearance changes, SPA rerenders, and page reloads are **visual/browser state only** and MUST NOT change project identity, task state, or bootstrap authority;
- if a bootstrap send was attempted, the composer draft later disappears, and the latest visible user-turn identity is still exactly the persisted pre-send baseline user-turn identity, Supervisor has positive evidence that no new user turn was submitted; it may safely re-arm that same bootstrap send instead of entering a permanent ambiguous-send crash loop;
- if the latest user-turn identity changed or cannot be correlated, exact-once remains fail-closed and Supervisor MUST NOT manufacture a resend;
- recoverable bootstrap UI/navigation/send failures keep the Planner/Executor runtime alive in an explicit `*_BOOTSTRAP_RETRY` phase with bounded backoff rather than repeatedly killing/restarting the Node runtime;
- each recoverable bootstrap retry MUST reacquire the exact Planner/Executor target pages from CDP before retrying; a closed/replaced Playwright page handle must never be retried forever;
- target reacquisition must reassert the exact two-normal-chat topology before the bootstrap send is attempted again;
- Control Center must surface the retry/startup-failure phase so Owner can distinguish browser reload from a dead Robot.

Chat target rollover rules:

- changing a Planner/Executor URL increments that role's `target_revision` but does **not** create a new project or increment `project_generation`;
- a new Planner target re-arms Source of Truth bootstrap so the replacement Planner rehydrates project context before continuing;
- if an Executor rollover occurs while the current assignment is still unresolved, the same logical assignment ID is handed to the new Executor with `MAGASIN_CHAT_ROLLOVER_V1`; the replacement Executor must verify current Source of Truth/evidence first and must not repeat already-completed side effects;
- if a Planner rollover occurs while a result is awaiting review, the same result ID is relayed to the replacement Planner with `MAGASIN_CHAT_ROLLOVER_V1`;
- the old role chat is retired only when it exactly matches the persisted superseded target and contains no unsent draft; unrelated ChatGPT conversations remain fail-closed;
- the normal steady-state topology remains exactly two ChatGPT tabs.

Implementation authority: PR #153, merge `e928bc03980f564c007a97b197f1b8af7c727fde`, plus the chat-target rollover hardening that supersedes the earlier active-profile chat safe-boundary restriction.

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

**Transport status:** the direct browser/composer actuation contract below documents the currently deployed pre-Bridge transport. MAGASIN BRIDGE V1 in Section 15 is the canonical forward transport migration plan. Direct-DOM transport remains production authority until MBV1-008 qualification and explicit cutover complete.

Normal path for the currently deployed pre-Bridge transport:

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

## 15. MAGASIN BRIDGE V1 — canonical next-phase transport plan

Status: **CANONICAL PLAN / IN PROGRESS / NOT YET CUT OVER**

Owner decision date: **2026-09-27**

Current task: **MBV1-006 — Project Bootstrap**. Progress: pc=5 / pt=8.

This program replaces only the Planner/Executor transport layer. It preserves the existing Source-of-Truth authority, Planner/Executor roles, @M v1 protocol, task/assignment/result correlation, pc/pt semantics, STOP/RESET behavior, exact-once principles and Control UI concept.

### 15.1 Target authority model

- GitHub Source of Truth = project truth.
- MAGASIN Orchestrator = workflow/state-machine authority.
- @M = machine protocol.
- chatgpt-bridge = transport only.
- ChatGPT Planner/Executor = reasoning/execution surfaces.
- Control UI = Owner inputs, monitoring, START/STOP/RESET and progress projection.

Target topology: Control UI -> MAGASIN Orchestrator -> Bridge Adapter -> local chatgpt-bridge at 127.0.0.1:5000 -> two normal ChatGPT tabs (Planner and Executor).

Canonical upstream candidate: https://github.com/OLmatter/chatgpt-bridge . MBV1-001 MUST record and pin the exact upstream commit before integration; production MUST NOT depend on a floating upstream branch.

### 15.2 Migration rule

This is a staged transport replacement, not a rewrite. Keep Source of Truth URL, Planner Chat URL, Executor Chat URL, @M, pc/pt, exact correlations and current Owner controls. Replace direct composer click/DOM actuation as the primary transport only after qualification. The current production transport does not change merely because this plan exists.

### 15.3 Work breakdown

| ID | Priority | Work | Required outcome | Weight |
|---|---|---|---|---:|
| MBV1-001 | P0 | Local Bridge Baseline | Bridge runs locally on Windows; Planner + Executor independently visible/controllable | 10% |
| MBV1-002 | P0 | Bridge Adapter | One bounded MAGASIN adapter for list/send/snapshot/state | 10% |
| MBV1-003 | P0 | Planner/Executor Binding | Exact chat URLs bind to distinct page_id values | 10% |
| MBV1-004 | P0 | Transport State Machine | Planner -> Executor -> Planner autonomous loop through Bridge | 20% |
| MBV1-005 | P1 | @M Protocol Integration | Existing actions remain deterministic and fail closed | 15% |
| MBV1-006 | P1 | Project Bootstrap | Source-of-Truth bootstrap drives next task and pc/pt | 10% |
| MBV1-007 | P2 | Reliability Layer | timeout/retry/dedup/stale/disconnect recovery | 15% |
| MBV1-008 | P3 | Qualification + Cutover | qualification matrix PASS then explicit production activation | 10% |

Canonical order: MBV1-001 -> 002 -> 003 -> 004 -> 005 -> 006 -> 007 -> 008.

### 15.4 MBV1-001 DoD

MBV1-001 must prove on the target Windows PC: Bridge service online; Planner connected; Executor connected; Planner page_id differs from Executor page_id; harmless Planner send/read PASS; harmless Executor send/read PASS; no cross-role routing; exact upstream commit recorded. If any item fails, MBV1-002 MUST NOT start.

### 15.5 Bridge-backed state machine

Canonical flow remains: IDLE -> BOOTSTRAP_PLANNER -> WAIT_PLANNER -> SEND_EXECUTOR -> WAIT_EXECUTOR -> SEND_PLANNER -> WAIT_PLANNER_DECISION. Planner decisions map to accept_assign -> next Executor assignment, reject -> correction assignment, blocked -> BLOCKED, done -> DONE. MAGASIN validates and executes transitions; the Bridge never decides workflow meaning.

### 15.6 Reliability contract

Every outbound operation is tracked through QUEUED -> SUBMITTING -> SUBMITTED -> GENERATING -> RESPONSE_RECEIVED -> PARSED -> ACKNOWLEDGED. Required protections include no duplicate assignment/result relay, no stale-response acceptance, bounded page reacquisition, bounded retry/backoff, fail-closed ambiguous sends, and Bridge restart without inventing project state.

### 15.7 Qualification and cutover

MBV1-008 must cover at least: happy-path DONE; FAIL -> REJECT -> correction -> PASS; BLOCKED; duplicate @M; stale result_id; wrong assignment_id; Planner reload; Executor reload; Bridge restart; RESET ROBOT; new Source of Truth session; long generation without premature parsing.

Until MBV1-008 PASS and explicit cutover: bridge_cutover=false and production continues on the pre-Bridge direct browser/runtime transport. After explicit cutover: chatgpt-bridge adapter becomes primary transport and direct DOM transport becomes rollback/fallback only.

### 15.8 Next-task authority

program=MAGASIN_BRIDGE_V1; current_task=MBV1-008; pc=7; pt=8; status=IN_PROGRESS. Planner MUST select MBV1-004 next. MBV1-005 and later tasks remain blocked by dependency order.


### 15.9 MBV1-001 implementation evidence

Status: **COMPLETE / LIVE QUALIFIED**

Authoritative evidence:

- merged PR: #173;
- merge commit: `8146ca53e99cba08292eac80be4ad6403a875fa4`;
- qualified candidate head: `dc02330b788409ca9b3799b15f54c703e921cb93`;
- pinned upstream: `OLmatter/chatgpt-bridge@848efb9e85f52f251c82ab099747833c0693c072`;
- authoritative live workflow run: `36330634492`;
- target job: `108651748072` on `DESKTOP-4K7IM13`;
- authority job: `108652177893`: **PASS**;
- static audit: **PASS**;
- unit tests: **PASS**;
- production state mutated: **false**;
- production targets mutated: **false**;
- Bridge process and qualification-owned Chrome cleaned up after PASS.

Verified MBV1-001 DoD:

```text
Bridge service online        = PASS
Planner connected            = PASS
Executor connected           = PASS
Planner page_id != Executor  = PASS
Planner send/read            = PASS
Executor send/read           = PASS
Role isolation               = PASS
Upstream commit pin recorded = PASS
```

The target-machine run also proved that the Bridge transport path requires no OpenAI API and invoked ChatGPT Work mode zero times.

Qualification transport finding:

- the pinned upstream blocking `/send` path did not satisfy the live qualification reliably under the current ChatGPT completion timing;
- the canonical MAGASIN path for MBV1-002 forward is therefore **`/send_async` for command enqueue plus `/snapshot?page_id=...` for correlated read/observation**;
- this does not modify upstream in MBV1-001; it constrains the adapter design in MBV1-002;
- blocking `/send` is not authoritative submission/completion evidence for MAGASIN.

### 15.10 MBV1-002 implementation evidence

Status: **COMPLETE / MERGED**

Authoritative implementation:

- merged PR: #174;
- merge commit: `158091cdffa1b08d15ac398e54c18a28b9acee74`;
- final head: `6cb857656888583af38df9e9b433d577333565e8`;
- adapter: `src/runtime/chatgpt-bridge-adapter.mjs`;
- tests: `test/chatgpt-bridge-adapter.test.mjs`;
- pinned upstream constants remain `OLmatter/chatgpt-bridge@848efb9e85f52f251c82ab099747833c0693c072`.

Implemented adapter contract:

- local HTTP Bridge origin only (`127.0.0.1`, `localhost`, loopback);
- exact non-empty `page_id` targeting;
- normalized `/status`, `/pages`, and `/snapshot?page_id=...` responses;
- canonical enqueue through `POST /send_async`;
- adapter-level `send()` performs baseline snapshot -> async enqueue -> bounded snapshot observation;
- upstream blocking `/send` is not called by the adapter;
- new-response evidence rejects unchanged stale snapshots;
- baseline is correlated to the exact same `page_id`;
- generating/busy baselines fail closed;
- malformed/HTTP/unreachable/timeout responses become bounded typed Bridge errors;
- Bridge-specific normalization remains in the adapter; no `@M`, task, assignment, result, ACCEPT/REJECT, or project-state semantics were moved into transport.

Final regression evidence on head `6cb857656888583af38df9e9b433d577333565e8`:

```text
full node regression suite = 806 / 806 PASS
additional contract suite   = 50 / 50 PASS
platform/core regressions   = 192 / 192 PASS
static audit                = PASS
lifecycle isolated          = PASS
installer isolated          = PASS
production cutover          = false
```

A first regression run exposed one implementation bug (`pageId is not a function`) caused by helper/parameter shadowing. The fix renamed the validator to `requirePageId`; the final head passed all applicable gates without weakening tests.

### 15.11 MBV1-003 implementation evidence

Status: **COMPLETE / MERGED**

Canonical implementation:

- merged PR: #176;
- merge commit: `76a0723e77df285acd46f3b25a5be74307d8f9d6`;
- final head: `e07eb79e71622fd8dee27121fa3fc11dded31deb`;
- binding module: `src/runtime/chatgpt-bridge-binding.mjs`;
- contract tests: `test/chatgpt-bridge-binding.test.mjs`;
- stale duplicate PR #175 was closed unmerged and is explicitly superseded by #176.

Implemented binding contract:

- reuses canonical `targetFromUrl()` and `pageMatchesTarget()` conversation identity;
- exact Owner Planner URL -> one live Planner `page_id`;
- exact Owner Executor URL -> one live Executor `page_id`;
- Planner and Executor canonical conversations must differ;
- Planner and Executor `page_id` values must differ;
- missing role target fails closed;
- duplicate live tabs for the same role target fail closed as ambiguous;
- unrelated live Bridge pages block the default exact two-role topology;
- stale unrelated pages are ignored but never adopted;
- optional diagnostic non-exact mode reports unrelated pages but never assigns them to a role;
- bounded reacquisition may change a role's `page_id` after reload/replacement only while preserving the same canonical conversation identity;
- invalid Owner ChatGPT URLs fail before page enumeration;
- project identity, task state and workflow semantics remain outside the binding layer.

Final regression evidence on head `e07eb79e71622fd8dee27121fa3fc11dded31deb`:

```text
full node regression suite = 818 / 818 PASS
additional contract suite   = 50 / 50 PASS
platform/core regressions   = 192 / 192 PASS
static audit                = PASS
lifecycle isolated          = PASS
installer isolated          = PASS
production cutover          = false
```

### 15.12 MBV1-004 next-task authority

MBV1-003 is complete. Progress is now:

```text
program = MAGASIN_BRIDGE_V1
current_task = MBV1-004
pc = 3
pt = 8
status = READY_TO_EXECUTE
bridge_cutover = false
```

MBV1-004 must implement the Bridge-backed transport state machine that carries the autonomous Planner -> Executor -> Planner loop while keeping protocol interpretation and project/task authority outside the Bridge transport layer. It MUST reuse the MBV1-002 adapter and MBV1-003 binding, remain fail-closed on invalid phase/role transitions, and MUST NOT production-cut over.


### 15.14 MBV1-004 implementation evidence

Status: **COMPLETE / MERGED**

Authoritative implementation:

- merged PR: #177;
- final head: `c77f8744759dcb75c899c313d7907a1925a8c255`;
- merge commit: `e3c693013a616ed99c535c5851ceceb2e0b2bfac`;
- state machine: `src/runtime/planner-executor-bridge-transport.mjs`;
- tests: `test/planner-executor-bridge-transport.test.mjs`;
- Bridge adapter + deterministic binding are reused;
- Planner -> Executor -> Planner -> next Executor routing is explicit;
- invalid phase transitions and send failures fail closed;
- role reacquisition may change transport page_id only when canonical role identity is unchanged;
- transport state machine contains no project/protocol parser authority;
- production transport remains pre-Bridge and `bridge_cutover=false`.

Final gate evidence:

```text
Supervisor Tests                = PASS (run 36331951645)
Supervisor Integrity            = PASS (run 36331951605)
Supervisor Lifecycle Acceptance = PASS (run 36331951696)
Supervisor Autostart Install    = PASS (run 36331951686)
```

MBV1-005 is now the current implementation task.


### 15.15 MBV1-005 implementation evidence

Status: **COMPLETE / MERGED**

Authoritative implementation:

- merged PR: #179;
- final head: `08bdbb1c576987915eb9a6da7f4b62be61c201ee`;
- merge commit: `778e8c1abd6420409661ee9f33f6cb446313c9f0`;
- protocol controller: `src/runtime/planner-executor-bridge-protocol.mjs`;
- canonical parser/action/correlation guards are reused from `machine-frame.mjs`;
- malformed, mismatched, duplicate and impossible-phase frames fail closed before Bridge mutation;
- strict project_id/project_generation correlation is supported;
- reject without bounded correction becomes BLOCKED;
- ambiguous Bridge send/relay outcomes are fail-closed BLOCKED with transport evidence, correcting the resendable failure path identified during PR #178 review;
- production cutover remains false.

Final gate evidence:

```text
Supervisor Tests                = PASS (run 36332260656)
Supervisor Integrity            = PASS (run 36332260686)
Supervisor Lifecycle Acceptance = PASS (run 36332260572)
Supervisor Autostart Install    = PASS (run 36332260646)
```

MBV1-006 is now the current implementation task.


### 15.16 MBV1-006 implementation evidence

Status: **IN_PROGRESS** (pc remains 5 / pt 8).

MBV1-006 must bind the link-only START inputs (Source of Truth URL, Planner Chat URL, Executor Chat URL) to the merged Bridge role binding, send the canonical Planner bootstrap through the Bridge, require Planner-reported `pc/pt`, and begin the validated protocol loop without creating any local project authority. Production cutover remains false.


### 15.14 MBV1-006 completion evidence

Status: **COMPLETE**.

- PR: #181;
- final head: `30e8f5e1092e352f1b5d9696db5f138a43af3bb5`;
- merge commit: `be7bd4a1c218640aac274216efb5e233f4623702`;
- link-only Source of Truth + Planner + Executor inputs validated;
- exact Bridge role binding reused;
- mention-safe `MAGASIN_PROJECT_BOOTSTRAP_V1` sent only to Planner;
- strict `p/g/pc/pt` enforced before downstream dispatch;
- ambiguous bootstrap send fails closed without automatic resend;
- production cutover remains false.

Current progress: `pc=6 / pt=8` (75%). Next task: **MBV1-007 — Reliability Layer**.


### 15.15 MBV1-007 completion evidence

Status: **COMPLETE**.

- PR: #182;
- final head: `37581ac0b2366a88a649139da5ebbe5a661d9d06`;
- merge commit: `e1acb877e031a161b495657604420ab003c679f7`;
- bounded same-canonical-role page reacquisition before send;
- bounded Bridge restart observation/rebinding with no send during recovery;
- ambiguous post-enqueue send remains BLOCKED and is never auto-retried;
- bounded assignment/result/turn identity history can be restored after restart;
- reacquisition exhaustion fails closed;
- Supervisor Tests, Integrity, Lifecycle and Autostart gates PASS;
- production cutover remains false.

Current progress: `pc=7 / pt=8` (87.5%). Next task: **MBV1-008 — Qualification + Cutover**.


#### MBV1-001 authoritative completion evidence

- merged PR: #173;
- merge commit: `8146ca53e99cba08292eac80be4ad6403a875fa4`;
- authoritative live workflow run: `36330634492`;
- target machine: `DESKTOP-4K7IM13`;
- target attempt job: `108651748072`;
- authority job: `108652177893`;
- pinned upstream: `OLmatter/chatgpt-bridge@848efb9e85f52f251c82ab099747833c0693c072`;
- Bridge service online: PASS;
- Planner connected: PASS;
- Executor connected: PASS;
- distinct page_id: PASS;
- Planner send/read: PASS;
- Executor send/read: PASS;
- role isolation: PASS;
- OpenAI API required for Bridge transport: false;
- production state/targets mutated: false;
- MBV1-002 is now the canonical next task.
