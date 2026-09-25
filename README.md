> **Canonical migration state:** `MAGASIN_SUPERVISOR_INDEPENDENT_REPOSITORY_V1` is **COMPLETE**. MIG-005 production cutover is complete; MIG-006 / TASK-RBT-009 is complete and released; MIG-007 final cleanup removed the authorized legacy Business OS Supervisor surface and closed the active source-code rollback window.

Current machine-readable migration Source of Truth:

`docs/MIG_007_FINAL_CLEANUP_CLOSURE.json`

Final migration evidence:

- `docs/MIG_007_FINAL_CLEANUP_EVIDENCE.md`

Current approved runtime-change Source of Truth:

- `docs/RBT_010_TEXT_ONLY_RELAY_AUTHORITY.json` — TASK-RBT-010, **OWNER AUTHORIZED / READY / NOT STARTED**
- `docs/RBT_010_TEXT_ONLY_RELAY_PLAN.md` — bounded execution plan for clearing screenshot/attachment relay and moving to text-only exact-once result relay

The earlier MIG-007 authority manifest/plan/evidence remain historical pre-execution authority records. MIG-005/MIG-006 historical snapshots retain their original values and are not rewritten as current state.

No additional migration task is canonically defined. TASK-RBT-010 is a separate authorized runtime-change task and does not alter the completed migration state until its own implementation is executed and qualified.

# MAGASIN Supervisor

Production local autonomy runtime for MAGASIN Business OS.

## Current architecture

The active production orchestration mode is **Three-Lane V1**. Each lane has isolated persisted state:

- one Owner-selected **Brain** conversation;
- one Owner-selected or Robot-created **Work** conversation;
- one lane registry entry containing task, dispatch, relay and generation state.

The Robot never auto-discovers or auto-replaces an Owner-selected Brain. Brain and Work conversation URLs remain local and are not written to repository logs.

The Windows wrapper still retains the legacy `BRAIN_WORKER_V1` entry point as a compatibility fallback because `run-supervisor.ps1` can select that mode from previously persisted authoritative state. It is not the current Three-Lane production path.

### Current production baseline

Runtime lifecycle in production is v2026-09-20.59.

TASK-RBT-001 adds a **docs-only target architecture** for browser scheduling, long-running Work recovery, Work hot-swap and operational observability. Those target features are not considered released by TASK-RBT-001 itself.

Canonical target design:

`docs/ROBOT_BROWSER_SCHEDULER_OBSERVABILITY_ARCHITECTURE.md`

Canonical Brain → Robot directive serialization for every MAGASIN project Brain:

`docs/MAGASIN_LANE_DIRECTIVE_V1_PROTOCOL.md`

All Brain conversations controlled by Supervisor must emit byte-exact `MAGASIN_LANE_DIRECTIVE_V1` markers with valid JSON according to that protocol. Markdown-escaped markers such as `<<\\<MAGASIN_LANE_DIRECTIVE_V1>>>` are invalid and fail closed.

Implementation roadmap:

- TASK-RBT-002 — Event & Timing Foundation — IMPLEMENTED in v2026-09-19.51
- TASK-RBT-003 — Work URL Hot-Swap + LƯU WORK — IMPLEMENTED in v2026-09-20.52
- TASK-RBT-004 — Browser Scheduler + Tab Budget — IMPLEMENTED in v2026-09-20.53
- TASK-RBT-005 — Long-Running Work + 30m Watchdog — IMPLEMENTED in v2026-09-20.54
- TASK-RBT-005A — Relay Retry Exhaustion Recovery — IMPLEMENTED in v2026-09-20.55
- TASK-RBT-006 — Multi-Signal Work Full Detection + Rollover — IMPLEMENTED in v2026-09-20.56
- TASK-RBT-006A — Stale/Missing Exact-Target Navigation Storm Circuit Breaker — IMPLEMENTED in v2026-09-20.57
- TASK-RBT-006B — Owner START Latch Recovery / Lifecycle Acceptance Closure — IMPLEMENTED in v2026-09-20.58
- TASK-RBT-007 — Control Panel Timeline & Resource UX — IMPLEMENTED in v2026-09-20.59
- TASK-RBT-008 — Brain Planning Contract Runtime Hooks — IMPLEMENTED in v2026-09-20.60
- TASK-RBT-009 — Integration / Overnight Soak / Cleanup — COMPLETE; FINAL 8H TIER B QUALIFIED BY MIG-006

v2026-09-20.60 production truth includes TASK-RBT-002 event/timing foundation, TASK-RBT-003 Work target hot-swap/save, TASK-RBT-004 scheduler/tab budget, TASK-RBT-005 long-running Work watchdog, TASK-RBT-005A Owner-authorized relay retry recovery, TASK-RBT-006 multi-signal Work-full rollover, TASK-RBT-006A durable stale/missing target quarantine, TASK-RBT-006B deterministic explicit Owner START latch authority, TASK-RBT-007 Control Panel timeline/resource observability, and TASK-RBT-008 backward-compatible Brain planning/result-verdict runtime hooks. TASK-RBT-009 integration/overnight qualification is complete: MIG-006 run `35860156388` qualified the locked runtime candidate `218f330ee86eea4f0fb79ef9293bd43cf96a45de` for 28,843 seconds with 240 samples. The qualification was read-only and did not change runtime semantics.

## Lifecycle truth

Runtime lifecycle in v2026-09-20.52 follows one mandatory truth order:

PROCESS TRUTH > LANE TRUTH > PERSISTED RECOVERY STATE

`lanes.json`, `lane-registry.json` and `lane-status.json` are recovery memory. They never prove that the Robot is alive.

The Control Panel derives PROCESS TRUTH from the live Supervisor wrapper, Three-Lane node process, dedicated Robot Chrome process and its healthy CDP endpoint. An enabled lane cannot render stale `WORKING` or `RELAYING_RESULT` while those process requirements are absent; it renders `STARTING` or `RECOVERING` until live health returns.

When the panel opens:

- all lanes disabled: no automatic Robot startup;
- one or more lanes enabled + no Owner STOP: bounded automatic recovery;
- healthy runtime: no redundant restart;
- `STOP` or `AUTOSTART_DISABLED`: fail closed until explicit Owner START.

The per-lane **BẮT ĐẦU LUỒNG** button changes only lane intent from disabled to enabled. It does not clear Owner STOP. Explicit process restart after Owner STOP is a separate Owner action.

Install, autostart and repair preserve Owner STOP. Only `start-supervisor.ps1` without `-Recovery` is the explicit Owner START path allowed to clear STOP/AUTOSTART_DISABLED.

The TASK-RBT scheduler/observability target is subordinate to the same lifecycle hierarchy. Page count, scheduler state and timeline events are diagnostics/orchestration metadata, not replacement process truth.

## Three-Lane delivery contracts

### Brain -> Work

Work delivery uses the machine envelope:

~~~text
MAGASIN_WORK_DISPATCH_V1
task_id=<task>
dispatch_id=<deterministic id>
~~~

`dispatch_id` is deterministic from lane + Brain directive. Reconciliation is marker-authoritative on the exact Work conversation:

- marker present: confirmed;
- stable Work with marker absent: not confirmed and safe to retry;
- busy/unstable Work: pending;
- one reconciliation reload is bounded for Work dispatch recovery.

The Brain directive digest is persisted when dispatch is confirmed so the same directive cannot be redispatched after restart.

A confirmed dispatch and Work completion are separate. Under the TASK-RBT target, a Work task may run for 30–60+ minutes after confirmation without any resend.

### Work -> Brain

Result relay carries a deterministic `relay_id=<id>` marker and the full Work result plus one screenshot.

Relay reconciliation in v2026-09-19.50 is marker-authoritative on the exact persisted Brain:

- relay marker present: confirmed exact-once;
- Brain stable and marker absent: not confirmed, clear the latch and retry safely;
- Brain busy/unstable: pending;
- unrelated Brain activity does not create a terminal blocked latch;
- legacy v43 `reconcile_blocked` relay latches self-heal without Owner intervention.

No relay reconciliation path performs an unbounded reload loop.

## Released browser scheduler / remaining TASK-RBT gaps

Runtime v2026-09-20.53 implements TASK-RBT-004 Browser Scheduler + Tab Budget:

- one dedicated MAGASIN Chrome/CDP process/profile remains authoritative;
- browser tabs are transient execution resources rather than permanent per-lane Brain+Work ownership;
- registry/local state remains task/target/latch truth;
- default ChatGPT page budget = 3 globally across all lanes;
- enabled lanes are scheduled round-robin and disabled lanes consume no turn;
- each lane turn performs one bounded orchestration unit and yields;
- long-running Work is observed briefly and does not hold the scheduler while generating;
- max concurrent destructive UI mutations = 1 globally;
- page lease states are ACTIVE_MUTATION / ACTIVE_OBSERVATION / PARKED / EVICTABLE / CLOSED;
- safe LRU evicts EVICTABLE before PARKED and never evicts ACTIVE_MUTATION or a guarded non-persisted composer artifact;
- exact Brain/Work reopen verifies the persisted execution target and reconciles marker/latch state before a later mutation;
- RBT-003 active Work versus pending-next-target semantics remain registry-authoritative across eviction/reopen;
- scheduler/page-handle/LRU state is transient and rebuilt after CDP/runtime restart.

One lane enabled continues to work normally. Two or three enabled lanes share the same Chrome/CDP fairly without sharing task/latch state.

The browser-scheduler follow-on work is complete through TASK-RBT-009: Work-full rollover is released by TASK-RBT-006, Control Panel timeline/resource UX by TASK-RBT-007, planning protocol/runtime hooks by TASK-RBT-008, and the final integration/overnight qualification by TASK-RBT-009 under MIG-006.

## Released long-running Work watchdog

Runtime v2026-09-20.54 implements TASK-RBT-005:

- <25m: normal WORKING;
- 25–30m: WORKING_LONG observation only;
- >=30m with current `responseRunning`, changed safe progress, or activity <5m old: continue WORKING_LONG;
- >=30m plus >=5m inactivity and no running/progress evidence: enter STALL_CHECK first and yield;
- execution elapsed is measured from trusted `started_at`, never from `assigned_at`;
- legacy missing timing remains null and cannot authorize a recovery reload;
- one exact active-target recovery reload maximum per recovery epoch;
- reload intent is persisted before mutation so crash/restart cannot replay the same reload automatically;
- watchdog reload acquires the global RBT-004 mutation lease and rechecks Owner STOP/lane enable, task ID, active Work target, applied Work revision and generation;
- confirmed `dispatch_id` correlation is retained for post-reload marker reconciliation;
- confirmed dispatch is never resent merely because Work is old/slow;
- fresh progress may re-arm a later epoch only after >=10m reload cooldown;
- no progress after the post-reload inactivity window becomes POSSIBLY_STALLED with Owner warning;
- task ID, awaiting state, dispatch/relay latches, result dedupe and RBT-003 pending Work target are preserved;
- auth/MFA/CAPTCHA/security boundaries remain fail-closed;
- long-running and stalled lanes still yield the global scheduler.

The 30-minute threshold is an inactivity watchdog, **not** a task timeout. Send-confirmation reconciliation reloads and execution-watchdog reloads are separate budgets and state machines.

TASK-RBT-005 does not implement Work-full detection or rollover. Those remain TASK-RBT-006+.

## Released relay retry exhaustion recovery

Runtime v2026-09-20.55 implements TASK-RBT-005A:

- relay retry still exhausts after three bounded attempts per epoch;
- an exhausted relay never auto-rearms;
- the Control Panel exposes **THỬ LẠI RELAY** only for an exhausted relay latch;
- each Owner click persists a monotonic relay rearm revision; runtime applies a revision at most once;
- runtime reopens the exact persisted Brain through the browser scheduler and reconciles the deterministic relay marker before changing retry state;
- marker already present means canonical confirmation/dedupe with zero resend;
- marker absent keeps the same relay ID, task, result digests, screenshot evidence, Brain/Work targets and pending Work state while opening one new three-attempt epoch;
- missing/corrupt evidence fails closed without clearing the relay latch or destructively resetting the task;
- Owner STOP/AUTOSTART_DISABLED remains authoritative: a saved intent can wait, but no send/reload/UI mutation occurs while stopped;
- a later exhausted epoch requires a new Owner revision; there is no retry loop and no Brain/Work URL change requirement.

TASK-RBT-005A does not implement Work-full detection or rollover. Those remain TASK-RBT-006+.

## Released Work URL save/hot-swap

Runtime v2026-09-20.52 exposes:

- MỞ WORK
- LƯU WORK
- TỰ TẠO WORK

Owner Work save:

- validates URL;
- atomically persists URL;
- increments `work_url_revision`;
- records saved timestamp;
- gives visible revision/timestamp feedback;
- applies without Robot stop/start.

Safe apply:

- idle lane: apply immediately;
- active `awaiting_work`, dispatch latch, relay latch, or unreconciled completed result: save as pending-next-target;
- current task remains on the old execution Work target and exact-once latches remain intact;
- pending target survives restart and applies exactly once after a safe boundary;
- same canonical OWNER Work save does not churn revision/generation;
- inaccessible Owner Work fails closed when execution later tries to open it; Robot does not auto-replace it.

`TỰ TẠO WORK` is an explicit Owner request for Robot-managed Work mode. When active it is staged until the same safe boundary; it never abandons the current task and never creates/finds Brain.

## Released Work-full detection and rollover

Runtime v2026-09-20.56 implements TASK-RBT-006. Work-full is confirmed from multiple verified signals, never one regex.

Possible evidence families include:

- explicit structured conversation-full/limit UI;
- composer disabled with canonical capacity reason;
- verified send rejection/capacity evidence;
- current `conversationFull` classification as supporting evidence.

If an active assistant response is incomplete, Robot stays with current Work.

When safe full is confirmed for the next dispatch:

preserve state → create blank Work → get canonical URL → increment generation → persist target → persist exact dispatch latch → send once → confirm marker

Brain target is never auto-created/replaced.

The released detector uses one canonical `work-capacity.mjs` evaluator. Strong structured full/limit UI must be stable across probes, or at least two independent supporting signal families must agree. Legacy `conversationFull` remains supporting evidence only. Response-running, incomplete-turn, network, auth/MFA/CAPTCHA, transient/model-switching/retry, missing/access-denied and generic composer-disabled states fail closed.

Rollover uses durable `work-rollover.v1` stages: FULL_CONFIRMED → INTENT_PERSISTED → BLANK_TARGET_CREATING → TARGET_PERSISTED → DISPATCH_LATCH_PERSISTED → DISPATCH_CONFIRMED. The new Work is blank at creation; canonical URL + exactly-one generation increment are persisted before dispatch latch and before task send. Exact `dispatch_id` marker reconciliation remains authoritative after crash/restart. Owner pending Work target applies before automatic rollover at a safe boundary; relay/watchdog state remains separate.

TASK-RBT-006 does not implement Control Panel timeline/resource UX. That remains TASK-RBT-007+.

## Released stale/missing exact-target quarantine

Runtime v2026-09-20.57 implements TASK-RBT-006A:

- deterministic missing, conversation-specific access-denied, or stable redirect-away exact targets enter durable per-role quarantine;
- target-health stores metadata only: state/reason, SHA-256 target digest, applied revision, Work generation and detection timestamps;
- the lane returns WAIT_OWNER before browser acquisition on subsequent turns, so the same quarantined target performs zero reopen/reload/new-page mutations;
- restart, Chrome/CDP reconnect, scheduler reconstruction, eviction and STOP/START do not clear a same-canonical-target quarantine;
- saving a different canonical Brain/Work target clears only that role's old quarantine; re-saving the same stale URL does not;
- active task, dispatch/relay/result evidence, pending Work target and generation/history are preserved;
- watchdog cannot reload quarantined Work; relay/rearm cannot reopen quarantined Brain;
- dead recovery-cache/page leases are invalidated and safely closed when no non-persisted composer artifact or ACTIVE_MUTATION guard blocks cleanup;
- missing remains a Work-capacity guard and can never become FULL_CONFIRMED;
- the installed acceptance fixture is synthetic and never navigates Owner production conversations.

TASK-RBT-006A does not implement TASK-RBT-007 Control Panel timeline/resource UX.

## Brain Planning Contract

Target Brain workflow:

**PLAN → DISPATCH → VERIFY → ACCEPT/REJECT → NEXT PLAN**

Every task should have:

- one primary outcome;
- satisfied dependency;
- bounded scope;
- explicit DoD;
- explicit evidence;
- no Work self-expansion into the next task.

Planning target remains roughly <=20 minutes active implementation work when a task is decomposable. If a task is expected to exceed 30 minutes and can be split safely, Brain should split it. Inherently long-running operations may remain long and are handled by activity-based watchdog semantics.

## Released operational timeline and Control Panel observability

TASK-RBT-002 introduces a privacy-safe append-only local event file:

`%LOCALAPPDATA%\MAGASIN\BusinessOS\supervisor\lane-events.ndjson`

Minimum event families include:

- Brain assigned/accepted/rejected/next directive;
- Work dispatch confirmed/started/observed/long-running/completed;
- watchdog stall check/reload/recovery;
- result relay confirmed;
- Work target save/pending/apply;
- Work full/rollover;
- recovery/error reason codes.

No message body, full URL, token, cookie or private conversation content is allowed in the timeline.

Target task timing includes:

- assigned_at
- started_at
- last_activity_at
- completed_at
- queue_time
- execution_time
- total elapsed

Runtime v2026-09-20.59 projects canonical task timing, watchdog/rollover/target-health/revision state into the additive `three-lane-status.v1` snapshot. Control Panel renders PROCESS TRUTH first, scheduler page-budget/mutation diagnostics, per-lane execution timing/state and a default 30-event bounded tail of `lane-events.ndjson`. The reader seeks from the end with a bounded byte window, tolerates partial/corrupt lines and concurrent appends, rejects events with fields outside the safe schema, and never renders URL/message/token/cookie/screenshot content. Control Panel reads only a bounded recent tail, not the full event history on every refresh.

## Temporary evidence lifecycle

Relay screenshots live under the local-only `lane-evidence` directory.

A screenshot remains only while referenced by an active `relay_inflight` latch. Bounded retries reuse the same evidence instead of recapturing it. It is deleted on:

- marker-confirmed relay;
- relay dedupe;
- confirmed/deduped completion;
- Brain rebind;
- safe Work reset/rebind after active task preservation rules are satisfied;
- invalid screenshot capture.

Runtime startup and periodic bounded GC remove only orphan PNG evidence that is not referenced by any active relay latch in any lane. Cleanup is capped per pass.

## Attachment send safety

Attachment relay retries begin from a clean composer draft and remove stale attachment chips before re-upload. Composer readiness, fill, file upload and attachment readiness waits are bounded. This prevents an uncertain prior attempt from stacking duplicate draft text or attachments.

## Cross-lane isolation

Every loop iteration resolves state as `registry.lanes[lane.lane_id]`. A lane's task, Work target, dispatch latch, relay latch and evidence reference are never shared with another lane. Disabled lanes remain stopped and do not affect enabled lane state.

The future scheduler shares only browser resources and a global mutation lease. It must not share lane task state.

## Windows production entry points

- `windows/lifecycle-truth.ps1` — shared PROCESS TRUTH / Owner STOP / enabled-lane recovery helpers.
- `windows/run-supervisor.ps1` — persistent wrapper and mode selection.
- `windows/start-supervisor.ps1` / `stop-supervisor.ps1` — bounded start/stop.
- `windows/repair-supervisor.ps1` — verified repair/install path.
- `windows/control-panel.ps1` — Owner control panel.
- `windows/open-supervisor-chat.ps1` — opens the configured target through the dedicated Robot browser boundary.

Local runtime root:

~~~text
%LOCALAPPDATA%\MAGASIN\BusinessOS\supervisor
~~~

Desktop control:

~~~text
MAGASIN BUSINESS OS CONTROL.lnk
~~~

Sensitive runtime/profile state, authenticated browser data, target conversation identifiers, tokens and message bodies remain local and must never be committed.

## Production workflows

- `supervisor-tests.yml` — unit/regression test suite.
- `supervisor-autostart-install.yml` — install/deploy and survival verification on the self-hosted machine.
- `supervisor-integrity.yml` — task-independent static audit plus self-hosted runtime integrity audit.
- `supervisor-open-control-panel.yml` — generic production Robot/control-panel opener.
- `supervisor-state-maintenance.yml` — manual `workflow_dispatch` Owner-authorized audit/reset/Owner START gate; release/source pushes never invoke it, runtime-version preflight runs before mutation, and Brain/Work targets remain preserved.
- `supervisor-lifecycle-acceptance.yml` — self-hosted production acceptance A→L for process/lane lifecycle truth.

Historical TASK-049 diagnostic/live-monitor workflows are not part of production.

TASK-RBT-009 supplied the integration/overnight scheduler qualification and cleanup workflow. MIG-006 completed its final exact-runtime Tier B qualification on workflow run `35860156388`; this qualification did not deploy, reinstall, start, or repair the production runtime.

## Safety stops

Supervisor must not continue through:

- login/credential entry;
- MFA/OTP;
- CAPTCHA;
- destructive production actions;
- admin/security escalation;
- ambiguous business decisions;
- authoritative project state `WAIT_USER` or `BLOCKED`;
- Owner STOP/AUTOSTART_DISABLED.

## Development test

~~~powershell
cd 08_INTEGRATIONS\supervisor
npm test
~~~

Relevant root-native Supervisor changes under `src/**`, `test/**`, `windows/**`, `docs/**`, `package.json`, and guarded workflow/script paths trigger safe hosted Supervisor checks. Runtime/self-hosted mutation acceptance remains disabled during MIG-002. Runtime/self-hosted mutation acceptance remains reserved for implementation releases.

Production/private data, authenticated browser profiles, target conversation identifiers and local logs remain outside Git.
