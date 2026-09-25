# MAGASIN Robot Browser Scheduler & Observability Architecture

QUESTION → DELETE → SIMPLIFY → ACCELERATE → AUTOMATE

Task: TASK-RBT-001/ROBOT-SCHEDULER-OBSERVABILITY-ARCHITECTURE-01  
Baseline: MAGASIN Supervisor Three-Lane V1, runtime v2026-09-19.50  
Status: OWNER + BRAIN architecture contract / DOCS-PLAN ONLY  
Implementation: NOT YET RELEASED by this task

This document is an extension of the existing Three-Lane V1 and Robot Lifecycle Truth architecture. It does **not** create a competing lifecycle. The mandatory lifecycle truth remains:

PROCESS TRUTH > LANE TRUTH > PERSISTED RECOVERY STATE

Canonical companions:

- `01_DOCS/MAGASIN/00_SUPERVISOR_THREE_LANE_ARCHITECTURE.md`
- `08_INTEGRATIONS/supervisor/docs/ROBOT_LIFECYCLE_TRUTH_ARCHITECTURE.md`
- `08_INTEGRATIONS/supervisor/README.md`

TASK-RBT-001 changes documentation and implementation planning only. It must not change production runtime, deploy, modify authenticated browser state, or alter Owner-selected Brain/Work targets.

## 1. Five-Step architecture decision

### QUESTION

The current v50 runtime has correct lifecycle truth and exact-once dispatch/relay guards, but it still treats browser pages as if they can remain open indefinitely and exposes too little timing/progress information to distinguish a legitimate long-running Work task from a stalled one.

The design question is therefore not "how do we open more Chrome windows?" It is:

> How do we make registry/local orchestration state authoritative, make browser pages bounded transient execution resources, preserve exact-once semantics across page close/reopen/reload, and give the Owner enough timing evidence to tell long-running work from a stall?

### DELETE

Delete these current-behavior assumptions from future runtime implementation:

1. Permanent Brain/Work tab ownership by every enabled lane.
2. An effectively unbounded number of ChatGPT pages.
3. The assumption that elapsed time alone proves a task is stalled.
4. Any unconditional "reload at minute 30" behavior.
5. Any reload loop that can repeatedly reload the same Work task without fresh progress.
6. Coupling send-confirmation timeout to task-completion duration.
7. Requiring Robot stop/start merely to apply a newly saved Work URL.
8. Current Work-revision semantics that clear active task/latch state solely because `work_url_revision` increased.
9. A single opaque `WORKING` state that hides task age and last activity.
10. A one-regex or one-heuristic definition of conversation-full.
11. Sequential browser ownership that can let one lane starve the other enabled lanes.
12. Reading the entire event history on every Control Panel refresh.
13. Creating a second Chrome profile only to mask page pressure, unless later evidence proves a separate profile is necessary.

### SIMPLIFY

Use one orchestration model:

- registry/local files are durable orchestration truth;
- browser pages are leased, transient resources;
- one global scheduler serves lane-1/lane-2/lane-3 fairly;
- max concurrent destructive UI mutations is 1;
- default ChatGPT page budget is 3;
- Work target changes are revisioned and safely applied;
- task activity is timestamped through append-only metadata events;
- the 30-minute rule is an inactivity watchdog, not a task timeout;
- Brain controls task decomposition and acceptance;
- Owner STOP remains authoritative over all automation.

### ACCELERATE

Make every lane step bounded and resumable. A lane must release the scheduler after one bounded observe/reconcile/mutate unit rather than owning a browser path until the business task completes. Closing or parking a page must not lose task state because the durable target, generation, task ID, dispatch latch, relay latch, timing state and revisions remain local.

### AUTOMATE

After the foundations are proven:

- schedule lanes round-robin;
- enforce the tab budget automatically;
- park/close/reopen exact targets automatically;
- classify long-running vs possibly stalled from activity evidence;
- perform one bounded recovery reload when eligible;
- detect Work-full from multiple verified signals;
- roll Work forward automatically only when safe;
- hot-apply Owner Work revisions without restarting Robot;
- write privacy-safe operational events;
- render recent activity and task duration in Control Panel;
- keep exact-once dispatch/relay and Owner STOP semantics unchanged.

## 2. BEFORE → TARGET architecture

| Area | v2026-09-19.50 BEFORE | TARGET |
| --- | --- | --- |
| Browser ownership | Brain/Work pages are opened/reused and can remain resident | Pages are transient leases under one finite scheduler |
| Tab count | No explicit global page budget | Default global ChatGPT page budget = 3 |
| Lane scheduling | Main loop processes lanes sequentially; page lifetime is not budgeted | Round-robin scheduler; every enabled lane gets bounded turns |
| UI mutation concurrency | Not expressed as one global invariant | Max concurrent UI mutations = 1 unless later evidence proves safe |
| Long Work | `WORKING` while response not complete | `WORKING` / `WORKING_LONG` / `STALL_CHECK` / `POSSIBLY_STALLED` from timing + activity |
| Send vs completion | Send reconciliation exists, but completion age is not a separate contract | Dispatch confirmation is short/bounded; task completion may legitimately take 30–60+ minutes |
| 30-minute behavior | No canonical inactivity watchdog | Observe at 25m; stall eligible at >=30m only with >=5m inactivity and no running/progress evidence |
| Reload | Existing dispatch reconciliation may hard-reload once for uncertain send | Task watchdog may reload exact Work at most once per recovery epoch, then reconcile before acting |
| Work URL change | Revision can currently reset active task/latches | Idle applies immediately; active becomes pending-next-target and preserves old task/latches |
| Work-full | Automatic rollover relies on current `conversationFull` signal | Multi-signal capacity detector; no single regex authority |
| Work rollover | Create/send behavior is coupled | Preserve state → create blank Work → increment generation → persist canonical URL → dispatch exact-once |
| Observability | `supervisor.log` and status text are sparse | Append-only `lane-events.ndjson` plus timing summary and Control Panel timeline |
| Brain planning | One directive format exists; planning quality is mostly conversational | PLAN → DISPATCH → VERIFY → ACCEPT/REJECT → NEXT PLAN contract |
| Control Panel | No LƯU WORK while enabled; no task timing/timeline/tab summary | MỞ WORK · LƯU WORK · TỰ TẠO WORK, revision feedback, task elapsed/activity/phase, browser budget, timeline |
| Lifecycle truth | v50 hierarchy | Unchanged: PROCESS TRUTH > LANE TRUTH > PERSISTED RECOVERY STATE |
| Brain identity | Owner-selected only | Unchanged; Robot never auto-finds or auto-creates Brain |

## 3. Non-negotiable invariants

1. No Brain autodiscovery.
2. No Brain autocreation.
3. No silent Brain target replacement.
4. Registry/local state is the source of orchestration truth; a browser tab is never the only copy of a task/latch/target.
5. Closing, parking or reloading a page must not clear `task_id`, `dispatch_inflight`, `relay_inflight`, `awaiting_work`, result dedupe markers, or timing state.
6. Dispatch becomes "delivered" only after exact `dispatch_id` marker confirmation.
7. Once dispatch is confirmed, Robot must never resend merely because the Work answer takes a long time.
8. Result relay remains marker-authoritative and exact-once.
9. Owner STOP/AUTOSTART_DISABLED remains fail-closed and outranks scheduling/recovery.
10. A Work rollover may create a Work conversation; it may never create/find a Brain.
11. Only one destructive UI mutation may be in flight across all lanes.
12. Observation may be interleaved across lanes, but it must not overlap a destructive action that could invalidate page state.
13. No message body, full URL, auth token, cookie, screenshot, credential or private conversation text is written to the operational timeline.
14. No runtime feature in this document is considered released until its TASK-RBT implementation task is merged and its required tests/soak pass.

## 4. Browser scheduler and finite tab budget

### 4.1 Global budget

Production target:

- one dedicated MAGASIN Chrome process/profile, as today;
- default maximum: **3 active ChatGPT pages** across all lanes;
- no second Chrome profile as a first-line performance fix;
- non-ChatGPT browser pages are not part of the scheduler budget but should not be created by normal Three-Lane execution.

The budget is global, not "3 pages per lane."

The default of 3 allows:

- one page to hold the current mutation lease;
- up to two additional pages for bounded observation/relay preparation;
- enough flexibility to avoid constant reopen churn while still preventing 4–6 permanent Brain/Work tabs.

If soak evidence shows that budget 2 is equally reliable, it may later be reduced. Increasing above 3 requires measured evidence, not convenience.

### 4.2 Scheduler fairness

One scheduler serves all enabled lanes.

Recommended model:

- maintain a round-robin cursor over `lane-1 → lane-2 → lane-3`;
- disabled lanes consume no turn;
- each scheduled lane performs at most one bounded orchestration unit before yielding;
- examples of one unit: probe exact Work, reconcile one latch, perform one dispatch attempt, capture a completed result, perform one relay attempt, apply one safe target revision;
- a Work response continuing for 60 minutes does not hold the scheduler for 60 minutes; it is observed briefly, then the scheduler advances;
- a lane with a pending retry/backoff yields immediately until its retry eligibility time.

Fairness invariant:

> With N enabled lanes, no healthy lane may be skipped for more than one complete round merely because another lane has a long-running Work response.

### 4.3 Mutation lease

A **mutation lease** authorizes an action that changes ChatGPT state, including:

- send instruction;
- click send/retry/continue if explicitly allowed by a task;
- attach result screenshot;
- create new Work;
- hard reload for watchdog recovery;
- any navigation that replaces the currently leased exact target during a send/reconcile operation.

Global limit:

`max_concurrent_ui_mutations = 1`

The scheduler must not begin a second mutation until the first mutation reaches a durable boundary: confirmed marker, safe NOT_CONFIRMED state, persisted pending latch, or bounded error state.

### 4.4 Observation lease

An observation lease is read-only:

- probe safe snapshot;
- read role/count/ordinal metadata;
- check `responseRunning`;
- detect progress/activity signals;
- inspect exact marker presence;
- capture a completed assistant turn when no mutation is occurring.

Observation probes may use parked pages, but page count remains within budget.

### 4.5 Page lease states

Recommended in-memory page lease states:

- `ACTIVE_MUTATION`
- `ACTIVE_OBSERVATION`
- `PARKED`
- `EVICTABLE`
- `CLOSED`

A page lease contains only transient browser references plus safe keys such as lane, role and target revision. It is not durable task state.

A page may be evicted only when:

- it has no mutation in progress;
- an uncertain send is already represented by a durable latch;
- required canonical target URL is persisted locally;
- any required evidence file is persisted and referenced by a latch;
- closing the page cannot destroy the only copy of unsent text.

### 4.6 Park / close / reopen semantics

**PARK** means the page may remain open temporarily but has no ownership guarantee. It can be evicted when the budget is needed.

**CLOSE** means `page.close()` after the durable-state conditions above are satisfied.

**REOPEN** means:

1. read exact target from current registry/config revision;
2. open the canonical conversation URL;
3. verify `pageMatchesTarget`;
4. probe safety/access;
5. reconcile dispatch/relay marker and current lane state;
6. only then decide whether any mutation is allowed.

A reopened page never implies a resend.

### 4.7 Eviction policy

When the budget is full, evict in this order:

1. oldest `EVICTABLE` page;
2. oldest `PARKED` observation page;
3. never evict `ACTIVE_MUTATION`;
4. never evict a page containing the only non-persisted artifact needed to prove a pending send.

LRU is acceptable for browser resources because durable task truth remains in the registry.

## 5. Cross-lane fairness and isolation

Lane task state remains independent:

- `registry.lanes[lane-1]`
- `registry.lanes[lane-2]`
- `registry.lanes[lane-3]`

Shared resources are only:

- dedicated Chrome/CDP process;
- finite page budget;
- scheduler cursor;
- global mutation lease.

One lane may not read or mutate another lane's Brain/Work target, latches, task IDs or timing state.

Required behavior:

- 1 enabled lane: it uses the scheduler normally without needing lane-2/3.
- 2 enabled lanes: round-robin between those two.
- 3 enabled lanes: round-robin across all three.
- one lane in `WORKING_LONG` must not block another lane from dispatching or relaying.
- one lane in retry/backoff must not stall the scheduler.
- one lane error is recorded and contained to that lane unless PROCESS TRUTH itself is unhealthy.

## 6. Dispatch confirmation is not task completion

Two different time domains must remain separate.

### 6.1 Send-confirmation domain

The existing exact-once send design remains bounded and short:

- create/persist `dispatch_inflight`;
- send one `MAGASIN_WORK_DISPATCH_V1` envelope;
- confirm exact `dispatch_id` marker;
- if uncertain, reconcile the exact target;
- one bounded reconciliation reload may be used for uncertain send state under the existing exact-once contract;
- after confirmation, clear `dispatch_inflight` and set `awaiting_work=true`.

### 6.2 Execution domain

After dispatch confirmation:

- the task may take seconds, 20 minutes, 30 minutes, 60 minutes or longer;
- Robot observes but does not resend;
- task completion ends only when a completed assistant result is captured or a bounded safety/error condition is established;
- task age alone does not invalidate dispatch confirmation.

This separation is mandatory. "No result yet" is not "send failed."

## 7. Task timing model

Each task must expose at least:

- `assigned_at` — valid Brain WORK directive accepted for the lane.
- `started_at` — exact Work dispatch marker confirmed.
- `last_activity_at` — most recent safe progress/activity observation.
- `completed_at` — final Work assistant result captured as complete.
- `relay_confirmed_at` — optional but recommended; exact Brain relay marker confirmed.
- `queue_time_ms = started_at - assigned_at`.
- `execution_time_ms = completed_at - started_at`.
- `total_elapsed_ms` — while active, now - assigned_at; after completion, completed_at - assigned_at.

Timestamps are stored in UTC ISO 8601. The Control Panel renders them in Vietnam local time.

When a legacy task has incomplete timing fields, runtime must migrate forward without inventing fake historical timestamps. Unknown fields remain null until a trustworthy event occurs.

## 8. Privacy-safe activity definition

`last_activity_at` updates only from metadata-safe evidence, for example:

- assistant/user turn ordinal or count changes;
- `responseRunning` transition;
- a safe progress-control state change;
- a completed-turn state transition;
- a verified retry/continue state transition;
- navigation/reconnect that successfully restores the same exact conversation plus a changed safe progress marker.

Do not hash/store message body merely to prove "activity" in the timeline. Existing exact-once digests may remain in the registry where already required, but the operational timeline should use IDs/digests only when necessary for dedupe, not conversation text.

Repeated identical probes do not move `last_activity_at`.

## 9. Long-running states

**Implementation status:** TASK-RBT-005 releases this contract in runtime v2026-09-20.54. The implementation uses one canonical `work-watchdog.mjs`, fake-clock tests, additive restart-safe watchdog state, RBT-004 global mutation lease/page budget, and preserves RBT-003 current-vs-pending Work semantics. TASK-RBT-006 Work-full detection/rollover remains separate.


Canonical execution interpretation:

### < 25 minutes

Normal `WORKING`.

### 25–30 minutes

`WORKING_LONG` observation band.

Robot records `WORK_LONG_RUNNING` once per task/threshold crossing and continues bounded observation. No reload is authorized solely by entering this band.

### >= 30 minutes

Evaluate inactivity, not elapsed time alone.

If any of the following is true:

- `responseRunning=true`;
- safe progress metadata changed inside the inactivity window;
- `last_activity_at` is less than 5 minutes old;

then remain `WORKING_LONG` and continue observing.

Only when all stall eligibility conditions hold may the watchdog enter `STALL_CHECK`.

## 10. 30-minute inactivity watchdog

Default constants for the first production implementation:

- long-running observation threshold: 25 minutes;
- stall eligibility threshold: 30 minutes elapsed since `started_at`;
- inactivity window: 5 minutes;
- automatic reload budget: 1 reload per recovery epoch;
- minimum reload cooldown: 10 minutes;
- no second automatic reload for the same no-progress epoch; fresh activity is required to re-arm a future epoch.

### 10.1 STALL_CHECK eligibility

Enter `STALL_CHECK` only when:

1. `awaiting_work=true`;
2. dispatch is confirmed;
3. task elapsed >= 30 minutes;
4. no safe activity for >= 5 minutes;
5. no current `responseRunning` or equivalent safe progress signal;
6. no auth/MFA/CAPTCHA/security boundary;
7. watchdog has not already reloaded in the current recovery epoch;
8. reload cooldown allows it.

Record `WATCHDOG_STALL_CHECK` before mutation.

### 10.2 One bounded recovery reload

When eligible:

1. acquire global mutation lease;
2. verify exact lane + Work target + task ID + generation;
3. append `PAGE_RECOVERY_RELOAD`;
4. hard reload the exact Work conversation once;
5. release the mutation lease only after navigation reaches a durable state;
6. re-probe exact target;
7. reconcile dispatch/result/latches before any further action;
8. never clear or resend a confirmed dispatch due to reload.

### 10.3 After reload

If progress/response running appears, return to `WORKING_LONG`, update `last_activity_at`, and a later recovery epoch may be re-armed only after genuine progress plus cooldown.

If no progress appears through the post-reload inactivity window:

- set `POSSIBLY_STALLED`;
- append `RECOVERY` or `ERROR` with an allowlisted reason code;
- show Owner warning;
- preserve `task_id`, `awaiting_work`, exact target and latches;
- do not resend dispatch;
- do not create a new Work automatically;
- do not continue an automatic reload loop.

Owner may inspect, STOP, hot-save a future Work target, or explicitly intervene.

## 11. Automatic Work-full detection

**Implementation status:** TASK-RBT-006 releases this contract in runtime v2026-09-20.56 using canonical `work-capacity.mjs` + restart-safe `work-rollover.mjs`. TASK-RBT-006A in runtime v2026-09-20.57 adds durable exact-target quarantine so `conversationMissing`, conversation-specific access denial, or stable redirect-away cannot turn scheduler reopen into a navigation storm. The current `conversationFull` signal remains compatibility/supporting evidence and is not a sole authority.

Future detector must combine independent signal families. Recommended normalized evidence:

- `explicit_full_limit_ui` — structured/semantic UI indication that this conversation reached a limit;
- `composer_disabled` plus a canonical capacity/full reason;
- `send_rejection_capacity` — a verified send rejection classified as a conversation-capacity limit;
- existing `conversationFull` classification as supporting evidence;
- stable conversation identity and stable UI probe.

Do not authorize rollover from one free-form regex match.

### 11.1 FULL_CONFIRMED rule

A Work conversation becomes `FULL_CONFIRMED` when either:

- one strong structured full/limit UI signal is observed consistently across stable probes; or
- at least two independent supporting signal families agree.

The implementation test suite must include false-positive cases such as:

- temporary composer disabled while response is running;
- network error;
- auth state;
- generic disabled send button;
- transient loading;
- a text string containing the word "limit" in conversation content.

### 11.2 Active response guard

Even if capacity/full evidence exists:

- if the current task has an incomplete active assistant response, do not abandon current Work;
- continue observing the current task;
- rollover is allowed only after the active result is completed/relayed or when dispatching a next task and the old Work is confirmed full.

## 12. Work rollover exact-target sequence

When Work-full is confirmed and there is no active incomplete response:

1. preserve old lane task/latch/history state;
2. persist a rollover intent tied to lane, old generation and next directive;
3. create a new blank Work conversation in the dedicated Robot Chrome;
4. wait for its final canonical persistable URL;
5. increment `work_generation`;
6. persist the new canonical Work URL and generation atomically;
7. create/persist the exact-once `dispatch_inflight` latch for the intended task;
8. send the `MAGASIN_WORK_DISPATCH_V1` envelope once;
9. confirm `dispatch_id`;
10. continue normal execution.

The sequence deliberately persists the new exact target **before** task send. A crash between target creation and send is recoverable without searching for a Brain and without guessing which page owns the task.

The old Work URL may be retained only as local recovery/history metadata if needed; it must never be emitted to timeline logs.

## 13. Owner Work hot-swap and LƯU WORK

Target Control Panel actions per lane:

- `MỞ WORK`
- `LƯU WORK`
- `TỰ TẠO WORK`

### 13.1 Save operation

Owner enters a valid Work conversation URL and presses `LƯU WORK`.

The panel must:

1. validate the URL as a specific ChatGPT conversation;
2. atomically persist it to `lanes.json`;
3. increment `work_url_revision`;
4. persist `work_url_saved_at`;
5. show confirmation such as:
   - `ĐÃ LƯU WORK · revision 7 · 20/09/2026 09:15:21`;
6. not require Robot stop/start.

The active runtime re-reads config and sees the new revision on the next poll/scheduler turn.

### 13.2 Immediate apply policy

Apply the new target immediately only when all are false:

- `awaiting_work`;
- `dispatch_inflight`;
- `relay_inflight`.

When idle, runtime updates the execution Work target, advances `applied_work_url_revision`, and increments generation only when the actual execution target changes/reset semantics require a new generation.

### 13.3 Pending-next-target policy

If any task/latch is active, do **not** clear it.

Instead persist:

- `pending_work_url`;
- `pending_work_url_revision`;
- `pending_work_saved_at`;
- safe pending status for Control Panel.

Old Work remains authoritative for the current task.

Resolution rules:

- dispatch already confirmed → current task completes on old Work; apply pending target only after result relay is confirmed/deduped.
- dispatch uncertain → reconcile old dispatch first.
  - if CONFIRMED, current task continues on old Work;
  - if safely NOT_CONFIRMED, apply pending target before the next send.
- relay in flight → relay completes against the current captured result; apply pending target afterward.
- no silent task abandon is allowed.

This replaces v50's current "new Work revision resets task/latches" behavior.

### 13.4 TỰ TẠO WORK

`TỰ TẠO WORK` is an explicit Owner request to return to Robot-managed Work mode.

It is **not** authorization to auto-create/find a Brain.

Semantics:

- idle lane: clear configured Work target, increment revision, enter Robot-managed mode immediately;
- active lane: save a pending AUTO target for the next safe boundary; current task remains on the old Work;
- Owner STOP remains authoritative.

## 14. Append-only operational timeline

New local file:

`%LOCALAPPDATA%\MAGASIN\BusinessOS\supervisor\lane-events.ndjson`

Purpose: operational observability only.

Each line is one immutable JSON event. The event writer must serialize writes so events from multiple lanes cannot interleave corruptly.

### 14.1 Minimum event schema

Recommended fields:

- `schema_version`
- `event_id`
- `timestamp`
- `event_type`
- `lane_id`
- `task_id` when applicable
- `work_generation`
- `phase`
- `dispatch_id` when applicable
- `relay_id` when applicable
- `work_url_revision` or pending revision number when applicable
- `elapsed_ms` when applicable
- `queue_time_ms` when known
- `execution_time_ms` when known
- `reason_code` from an allowlist when applicable

Forbidden:

- message body;
- Brain/Work URL;
- URL query/path fragments;
- screenshot bytes/path unless a safe opaque local evidence ID is necessary;
- token/cookie/session data;
- credentials;
- arbitrary raw error text that may contain private data.

### 14.2 Required event types

At minimum:

- `BRAIN_TASK_ASSIGNED`
- `WORK_DISPATCH_CONFIRMED`
- `WORK_STARTED`
- `WORK_OBSERVED`
- `WORK_LONG_RUNNING`
- `WATCHDOG_STALL_CHECK`
- `PAGE_RECOVERY_RELOAD`
- `WORK_COMPLETED`
- `RESULT_RELAY_CONFIRMED`
- `BRAIN_RESULT_ACCEPTED`
- `BRAIN_RESULT_REJECTED`
- `BRAIN_NEXT_DIRECTIVE`
- `WORK_TARGET_SAVED`
- `WORK_TARGET_PENDING`
- `WORK_TARGET_APPLIED`
- `WORK_FULL_CONFIRMED`
- `WORK_ROLLOVER_CREATED`
- `RECOVERY`
- `ERROR`

`WORK_OBSERVED` must be rate-limited/coalesced so a 4-second poll does not create one event every 4 seconds without new information. Record meaningful activity/state transitions, not heartbeat spam.

### 14.3 Example timeline rendering

Examples only:

- `08:15:21 — NÃO lane-1 — Đã giao TASK-X`
- `08:15:34 — WORK lane-1 — Đã nhận TASK-X`
- `08:41:02 — WORK lane-1 — Đang chạy lâu · hoạt động cuối 08:40:55`
- `10:07:33 — WORK lane-1 — Đã xong TASK-X · 01:51:59`
- `10:07:49 — NÃO lane-1 — Đã nhận kết quả TASK-X`

### 14.4 UI read strategy

Control Panel refreshes every ~2 seconds today. It must not read the complete history every refresh.

Use one of:

- PowerShell `Get-Content -Tail 50`; or
- a small runtime-maintained recent-event cache in `lane-status.json`.

Preferred first implementation: tail 50 lines from `lane-events.ndjson` and parse only those lines, with a file-size guard. Event history may later rotate by size, but rotation must preserve append-only semantics inside each segment.

## 15. Control Panel target UX

Lifecycle/process banner remains derived from:

PROCESS TRUTH > LANE TRUTH > PERSISTED RECOVERY STATE

Add a browser resource summary:

- `CHATGPT PAGES: 2 / 3`
- mutation lease owner, if any;
- scheduler health/fairness state.

Per lane show:

- current `task_id`;
- phase;
- elapsed time;
- last activity time / "x phút trước";
- Work generation;
- Work target saved revision;
- pending Work revision when applicable;
- friendly state:
  - `WORKING`
  - `WORKING_LONG`
  - `STALL_CHECK`
  - `POSSIBLY_STALLED`
  - existing lifecycle/business states.

Add `NHẬT KÝ HOẠT ĐỘNG` showing the most recent 20–50 safe events.

The timeline is informational. It must not become a new source of orchestration truth.

## 16. Brain Planning Contract

Every Brain lane must follow:

**PLAN → DISPATCH → VERIFY → ACCEPT/REJECT → NEXT PLAN**

### 16.1 PLAN

Before issuing a Work directive, Brain verifies:

- predecessor dependencies are satisfied;
- current repository/system truth is known;
- one primary outcome is selected;
- scope is bounded;
- explicit DoD exists;
- explicit evidence required from Work is stated;
- rollback/safety boundary is stated when relevant.

### 16.2 DISPATCH

Brain sends exactly one `MAGASIN_LANE_DIRECTIVE_V1` WORK task.

One task = one primary outcome.

Work must not self-extend into the next planned task.

### 16.3 VERIFY

When result returns, Brain checks the explicit DoD and evidence. A Work claim of "done" is not sufficient by itself when evidence is required.

### 16.4 ACCEPT / REJECT

Brain explicitly determines whether the previous task is accepted.

A future backward-compatible directive extension may carry optional previous-result verdict metadata so runtime can emit `BRAIN_RESULT_ACCEPTED` or `BRAIN_RESULT_REJECTED` without parsing prose. The core `MAGASIN_LANE_DIRECTIVE_V1` action/task/instruction format remains the lane dispatch contract unless a separately reviewed protocol change is approved.

If rejected, Brain issues a bounded corrective task; Work does not silently continue.

### 16.5 NEXT PLAN

Only after verify + accept/reject does Brain select the next dependency-correct task.

### 16.6 Task granularity

Existing Business OS planning guidance of roughly **<= 20 minutes active implementation work per implementation task** remains the target.

Reconcile that with the 30-minute watchdog as follows:

- <=20m is a planning target for verifiability, rollback and dependency correctness.
- 30m is a runtime inactivity threshold, not a planning budget.
- if Brain expects a task to exceed 30m and the operation can be decomposed safely, Brain must split it.
- if an operation is inherently long-running (for example a required soak, external CI wait, or one indivisible long execution), Brain may dispatch it as long-running with explicit expected evidence and no automatic resend.
- do not optimize for fewer tasks; optimize for verifiability and dependency correctness.

## 17. Proposed local state extensions

Exact field names may be refined during implementation, but semantics are locked.

Per registry lane, likely additions:

- `assigned_at`
- `started_at`
- `last_activity_at`
- `completed_at`
- `relay_confirmed_at`
- `execution_phase`
- `watchdog_epoch`
- `watchdog_reloaded_at`
- `watchdog_rearmed_at`
- `pending_work_url`
- `pending_work_url_revision`
- `pending_work_saved_at`
- `work_url_saved_at`
- `full_detection_state`
- `full_evidence_codes`

Global/ephemeral scheduler status may expose:

- `page_budget`
- `active_chatgpt_pages`
- `mutation_lane_id`
- `scheduler_cursor`
- `last_scheduler_turn_at`

The scheduler cursor/page handles are not business truth and need not be durable across restart. Exact lane task/target/latch state must be durable.

## 18. Recovery and restart semantics

On Robot restart:

1. establish PROCESS TRUTH;
2. load lane config + registry;
3. do not restore browser tabs as truth;
4. rebuild scheduler/page leases from zero;
5. reconcile pending target revisions;
6. reconcile uncertain dispatch/relay latches on exact targets;
7. preserve confirmed active tasks;
8. restore timing/watchdog state from persisted timestamps;
9. resume round-robin scheduling.

A restart must not reset task age to zero if trustworthy `started_at` exists.

A restart must not trigger a watchdog reload immediately without re-observing exact target/progress state.

## 19. Production acceptance / soak plan

Implementation release is not accepted until the following scenarios pass on the production machine after merge/install.

### A. One lane

- only lane-1 enabled;
- scheduler operates without lane-2/3;
- page count stays <= budget;
- exact dispatch/relay remains green;
- Control Panel process truth remains consistent.

### B. Two lanes

- lane-1 and lane-2 active;
- round-robin turns are visible in safe events;
- a long-running lane does not starve the other;
- max concurrent UI mutation remains 1;
- page count stays <= budget.

### C. Three lanes

- all three active;
- no target/latch cross-contamination;
- no lane starvation across complete scheduler rounds;
- Chrome/CDP remains healthy;
- page count stays <= budget.

### D. Work >30m with activity

- simulate or run a task beyond 30 minutes;
- safe activity continues inside the inactivity window;
- status is `WORKING_LONG`;
- no watchdog reload;
- no resend.

### E. Work >30m with no activity

- elapsed >=30m;
- inactivity >=5m;
- no running/progress signal;
- `WATCHDOG_STALL_CHECK` recorded;
- exactly one recovery reload in the epoch;
- exact-target reconciliation occurs after reload;
- no duplicate dispatch/relay.

### F. No reload loop

- after one recovery reload and no progress, state becomes `POSSIBLY_STALLED`;
- no second reload without fresh activity/re-arm;
- Owner warning shown;
- task/latch preserved.

### G. Work-full auto-rollover

- verified multi-signal full state;
- no active incomplete response;
- old state preserved;
- new Work created;
- `work_generation` increments;
- canonical URL persisted before dispatch;
- new dispatch marker appears once;
- Brain target unchanged.

### H. Owner Work hot-swap without restart

Idle case:

- Owner saves new Work;
- revision increments;
- confirmation shows revision/timestamp;
- runtime applies next poll;
- no Robot restart.

Active case:

- Owner saves new Work while `awaiting_work=true`;
- old task continues on old Work;
- pending revision visible;
- result relay completes;
- pending target applies only at safe boundary;
- no task/result/latch loss.

### I. AUTO mode reset

- `TỰ TẠO WORK` explicitly returns target to robot-managed mode;
- active task is not abandoned;
- Brain is not created/replaced.

### J. Timeline correctness/privacy

- required events exist in order;
- timestamps are monotonic enough for durations;
- queue/execution/elapsed values are correct within test tolerance;
- no message body/URL/token/private content appears;
- UI reads only a recent tail, not full history.

### K. Exact-once regression

Across scheduler close/reopen, watchdog reload, Work rollover and hot-swap:

- each `dispatch_id` is sent once;
- each `relay_id` is relayed once;
- no completed result is silently dropped.

### L. Owner STOP

- STOP remains authoritative during scheduler/watchdog/recovery;
- no automatic page creation/reload/send while STOP is active;
- enabled lane state remains recoverable after explicit Owner START.

## 20. Dependency-correct implementation roadmap

TASK-RBT-001 is this docs/plan lock. Runtime implementation begins only after it is merged.

### TASK-RBT-002 — Event & Timing Foundation

Implementation status: **RELEASED in runtime v2026-09-19.51**. This release adds the privacy-safe append-only event sink, additive per-task timing state, and exact-boundary transition integration. TASK-RBT-003 builds on this substrate; TASK-RBT-004+ behavior remains unreleased.

Purpose: create the durable privacy-safe event/timing substrate before scheduler/watchdog/UI logic depends on it.

Expected scope/files:

- new `src/runtime/lane-events.mjs` or equivalent;
- `src/runtime/three-lane.mjs`;
- `src/runtime/three-lane-cli.mjs`;
- focused tests such as `test/lane-events-timing.test.mjs`.

Dependencies: TASK-RBT-001.

DoD:

- append-only NDJSON writer;
- allowlisted safe schema;
- assigned/started/activity/completed/relay timestamps;
- queue/execution/elapsed helpers;
- meaningful event coalescing;
- legacy state normalizes without fake timestamps.

Tests:

- concurrent/serialized append;
- no forbidden keys/content;
- timing math;
- restart normalization;
- event ordering.

Rollback/risk:

- feature can be disabled without changing existing exact-once latches;
- risk is log volume/privacy leakage; mitigate via allowlist + rate limiting.

### TASK-RBT-003 — Work URL Hot-Swap + LƯU WORK

Implementation status: **RELEASED in runtime v2026-09-20.52**.

Purpose: replace destructive revision reset semantics with immediate-idle / pending-active apply.

Expected scope/files:

- `windows/control-panel.ps1`;
- `src/runtime/three-lane.mjs`;
- `src/runtime/three-lane-cli.mjs`;
- hot-swap regression tests.

Dependencies: TASK-RBT-002.

DoD:

- MỞ WORK | LƯU WORK | TỰ TẠO WORK;
- atomic save + revision + timestamp feedback;
- enabled runtime detects revision next poll;
- idle applies immediately;
- active task/latches remain on old target;
- pending target applies at safe boundary;
- no restart needed.

Tests:

- idle save;
- awaiting_work save;
- uncertain dispatch save;
- relay_inflight save;
- AUTO reset;
- restart with pending target.

Rollback/risk:

- preserve v50 fields for compatibility;
- highest risk is losing a current task; tests must assert task/latch identity before/after save.

### TASK-RBT-004 — Browser Scheduler + Tab Budget

Status: **IMPLEMENTED in runtime v2026-09-20.53**. Production acceptance remains the release gate for the merge that introduces v53.

Purpose: make browser pages transient and fair across lanes.

Expected scope/files:

- new `src/runtime/browser-scheduler.mjs` or equivalent;
- `src/ui/playwright-adapter.mjs`;
- `src/runtime/three-lane-cli.mjs`;
- scheduler/page-lease tests.

Dependencies: TASK-RBT-002.

DoD:

- default page budget 3;
- round-robin enabled lanes;
- one bounded unit per turn;
- max UI mutation 1;
- park/close/reopen exact-target semantics;
- no permanent Brain+Work ownership;
- no second Chrome profile.

Tests:

- 1/2/3 lane fairness;
- LRU eviction;
- never evict active mutation;
- exact target reopen;
- page count hard bound;
- dispatch/relay latch persistence across page closure.

Rollback/risk:

- scheduler can be reverted to v50 loop without schema loss;
- risk is browser churn or closing a page before durable boundary.

### TASK-RBT-005 — Long-Running Work + 30m Watchdog

Purpose: distinguish legitimate long execution from inactivity and add bounded recovery.

Expected scope/files:

- new `src/runtime/work-watchdog.mjs` or equivalent;
- `src/runtime/three-lane-cli.mjs`;
- safe snapshot/progress helpers if needed;
- timing/watchdog tests.

Dependencies: TASK-RBT-002 and TASK-RBT-004.

DoD:

- `WORKING_LONG`, `STALL_CHECK`, `POSSIBLY_STALLED`;
- <25m normal;
- 25–30m long observation;
- >=30m + >=5m inactivity + no running/progress => stall eligible;
- one exact-target reload per epoch;
- post-reload reconciliation;
- no resend;
- cooldown/re-arm semantics;
- no reload loop.

Tests:

- >30m with progress no reload;
- >30m no activity one reload;
- restart during watchdog;
- marker/latch preserved;
- fresh progress re-arms safely;
- STOP blocks reload.

Rollback/risk:

- watchdog can be disabled independently;
- risk is false stall classification from UI changes; fail toward waiting, not resending.

### TASK-RBT-006 — Multi-Signal Work Full Detection + Rollover

Purpose: reliably replace full Work conversations without abandoning active responses.

Expected scope/files:

- snapshot/classifier normalization;
- new capacity detector module if useful;
- `src/runtime/three-lane-cli.mjs`;
- `src/runtime/three-lane.mjs`;
- full/rollover tests.

Dependencies: TASK-RBT-003, TASK-RBT-004, TASK-RBT-005.

DoD:

- multi-signal `FULL_CONFIRMED`;
- no single regex authority;
- active incomplete response guard;
- preserve → create blank → increment generation → persist URL → exact-once dispatch;
- no Brain creation/replacement;
- crash-safe rollover stages.

Tests:

- explicit full;
- composer disabled but not full;
- send rejection full;
- running-response false positive;
- crash after new URL persist before dispatch;
- exact-one dispatch on new generation.

Rollback/risk:

- fail closed to existing Work/Owner warning when full evidence is ambiguous;
- risk is ChatGPT UI capacity wording/DOM changes.

### TASK-RBT-007 — Control Panel Timeline & Resource UX

**Implementation status:** RELEASED in runtime v2026-09-20.59. The implementation adds an additive privacy-safe status projection, bounded local NDJSON tail reader, native WinForms resource/lane/timeline surfaces and read-only installed acceptance probe. PROCESS TRUTH remains first and no orchestration semantics change.

Purpose: make execution understandable without reading private conversation content.

Expected scope/files:

- `windows/control-panel.ps1`;
- status schema emission in runtime;
- targeted UI/static tests.

Dependencies: TASK-RBT-002 through TASK-RBT-006.

DoD:

- browser pages/budget summary;
- per-lane task, phase, elapsed, last activity;
- long/stalled states;
- Work save revision feedback;
- recent 20–50 event timeline;
- no full-history read each refresh;
- process truth hierarchy remains first.

Tests:

- status composition ordering;
- event tail parsing;
- missing/corrupt final NDJSON line tolerance;
- no private fields rendered/logged;
- UI remains responsive with large event history.

Rollback/risk:

- UI can hide new panels without affecting runtime state;
- risk is WinForms refresh cost.

### TASK-RBT-008 — Brain Planning Contract Runtime Hooks

**Implementation status:** RELEASED in runtime v2026-09-20.60. The implementation keeps MAGASIN_LANE_DIRECTIVE_V1 backward-compatible, adds optional correlated previous-result ACCEPT/REJECT metadata, durable idempotent verdict state/events, a runtime-added Work stop guard, v59 handshake/active-dispatch migration compatibility, and preserves exact-once dispatch/relay.

Purpose: make PLAN → DISPATCH → VERIFY → ACCEPT/REJECT → NEXT PLAN observable/enforceable where safely possible.

Expected scope/files:

- `src/runtime/three-lane.mjs` Brain prompts/directive parsing;
- `src/runtime/three-lane-cli.mjs` events;
- architecture/README refinement if protocol metadata is added;
- contract tests.

Dependencies: TASK-RBT-002; scheduled after TASK-RBT-007 to avoid mixing protocol work with scheduler foundations.

DoD:

- Brain prompt states one-outcome/dependency/DoD/evidence contract;
- Work is explicitly told not to self-start next task;
- previous result acceptance/rejection can be safely recorded;
- <=20m planning target documented in prompt where appropriate;
- >30m expected work is split when feasible;
- existing v1 directives remain backward compatible unless separately approved.

Tests:

- old directive compatibility;
- optional verdict metadata;
- rejected result yields bounded correction, not hidden next-task expansion;
- no duplicate dispatch from planning metadata.

Rollback/risk:

- keep protocol extension optional/backward compatible;
- risk is over-constraining Brain text; machine parser must remain narrow.

### TASK-RBT-009 — Integration / Overnight Soak / Cleanup

**Implementation status:** TASK-RBT-009 final qualification is RELEASED / COMPLETE. MIG-006 workflow run `35860156388`, Tier B job `107180300345`, qualified locked runtime candidate `218f330ee86eea4f0fb79ef9293bd43cf96a45de` for 28,843 continuous seconds (240 samples) with `RBT009_TIER_B_480M=PASS`. Runtime semantics remain v2026-09-20.60.

Purpose: prove the combined system under real 1/2/3-lane pressure before declaring release.

Expected scope/files:

- integration tests;
- self-hosted acceptance/soak workflow(s);
- cleanup of temporary instrumentation;
- final README/release evidence.

Dependencies: TASK-RBT-002 through TASK-RBT-008.

DoD:

- execute acceptance A–L from this document;
- 1/2/3 lane soak;
- >30m active and inactive cases;
- exact one reload per epoch;
- no duplicate dispatch/relay;
- full rollover;
- active hot-swap preservation;
- tab budget and no starvation;
- Chrome/CDP healthy;
- privacy-safe timeline;
- Owner STOP authoritative;
- remove temporary diagnostics not needed in production.

Tests/evidence:

- CI green;
- self-hosted soak evidence with event IDs/timestamps only;
- post-merge installed runtime fingerprint;
- no private content in uploaded artifacts/logs.

Rollback/risk:

- rollback to prior release must preserve local config/registry targets;
- soak must never auto-clear Owner STOP or rewrite Brain targets.

## 21. Static/doc checks for TASK-RBT-001

Because this task is docs-only:

- existing Supervisor unit/static CI must remain green;
- no source/runtime/Windows/workflow production behavior is changed by this task;
- cross-references must resolve to the three canonical documents listed at the top;
- no task-specific production hard-code is introduced;
- roadmap task IDs use `TASK-RBT-xxx`, not the global Business OS `TASK-060/061...` namespace.

## 22. Open questions and residual risks

No blocking architecture question remains for TASK-RBT-002 kickoff. The initial production defaults are locked as:

- page budget = 3;
- mutation concurrency = 1;
- long-running observation starts at 25m;
- stall eligibility starts at 30m;
- inactivity window = 5m;
- minimum reload cooldown = 10m;
- active Work URL saves use pending-next-target.

Residual implementation risks:

1. ChatGPT UI changes may alter safe activity/full signals. Mitigation: multi-signal classifiers and fail-closed behavior.
2. Page churn may be too high at budget 3 on some flows. Mitigation: PARK/LRU before CLOSE and measure during soak.
3. Old registry files lack new timestamps. Mitigation: null-safe migration; never fabricate historical timing.
4. A Work hot-swap while old Work becomes inaccessible cannot recover the old result from the new URL. Mitigation: keep pending target, surface Owner intervention, never pretend the task migrated.
5. Timeline growth may eventually require size rotation. Mitigation: UI tails only recent lines; design rotation as append-only segments without making history a truth source.
6. Scheduler fairness can still be harmed by a single overly long *mutation operation*. Mitigation: every mutation path must have a bounded timeout and persist a resumable latch before yielding.
7. A false-positive full detector can create unnecessary Work chats. Mitigation: multi-signal confirmation and no rollover during active incomplete response.
8. Inherently long tasks may exceed 30 minutes. Mitigation: activity-based watchdog and Brain planning contract; elapsed time alone never causes resend.

## 23. Architecture acceptance for TASK-RBT-001

This docs/plan task is complete only when:

- this document exists under `08_INTEGRATIONS/supervisor/docs/`;
- lifecycle architecture cross-references it without changing truth hierarchy;
- Three-Lane architecture reflects scheduler, hot-swap, full-detection and planning contracts;
- Supervisor README distinguishes current v50 behavior from target TASK-RBT roadmap;
- PR contains docs only;
- relevant PR CI is green;
- PR is merged to `main`.

