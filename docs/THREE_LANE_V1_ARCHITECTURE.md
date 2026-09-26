# Platform Mirror — Three-Lane Architecture V1

> MIG-002 platform-oriented mirror. Source authority retained in `magasincoffee/magasincoffee.github.io:01_DOCS/MAGASIN/00_SUPERVISOR_THREE_LANE_ARCHITECTURE.md` through the migration compatibility window.
> Deep Business OS decoupling is explicitly deferred to MIG-003. This mirror changes references needed only for the independent repository layout.

# MAGASIN Supervisor — Three-Lane Architecture V1

Date: 2026-09-19  
Status: OWNER APPROVED / ACTIVE PRODUCTION BASELINE + TASK-RBT TARGET EXTENSION  
Original task: TASK-049  
Lifecycle baseline: runtime v2026-09-19.50  
Scheduler/observability extension: TASK-RBT-001
Event/timing implementation: TASK-RBT-002 — runtime v2026-09-19.51
Work hot-swap implementation: TASK-RBT-003 — runtime v2026-09-20.52
Browser scheduler implementation: TASK-RBT-004 — runtime v2026-09-20.53
Long-running Work watchdog implementation: TASK-RBT-005 — runtime v2026-09-20.54

Canonical scheduler/observability design:

`docs/ROBOT_BROWSER_SCHEDULER_OBSERVABILITY_ARCHITECTURE.md`

The extension does not replace Three-Lane V1. It changes how Three-Lane uses browser resources, Work revisions, long-running recovery and observability while retaining lane identity, exact-once delivery and Owner control.

## Why this replaces BRAIN_WORKER_V1

The previous runtime attempted to rediscover which ChatGPT conversation was the Brain. Multiple valid historical Brain conversations made that ambiguous and repeatedly stopped automation.

The Owner has replaced that topology with three explicit, isolated work lanes. The Robot must never infer a Brain conversation again.

## Topology

Each lane represents one project:

Owner-selected Brain URL  
→ Brain PLAN / one directive  
→ Owner-selected or Robot-managed Work conversation  
→ exact-once dispatch confirmation  
→ Work execution / bounded observation  
→ completed Work assistant response  
→ screenshot + full text relay  
→ same lane Brain VERIFY + ACCEPT/REJECT  
→ next dependency-correct plan/directive

There are exactly three lanes:

- lane-1
- lane-2
- lane-3

Each lane is independent and has its own project name, Brain URL, Work target/revision, task/latches, timing state, status, message, START and STOP controls.

All enabled lanes share one dedicated MAGASIN Chrome/CDP process and, after TASK-RBT implementation, one finite browser scheduler/page budget. Shared browser resources never merge lane state.

## Owner-facing contract

For each lane the Control Panel target UX shows:

1. Project name.
2. Brain URL — editable by Owner. This is the only source of Brain identity.
3. Work URL — Owner-selected or Robot-managed.
4. Lane status / phase.
5. Lane message / error.
6. Current task elapsed + last activity when a task exists.
7. START LANE.
8. STOP LANE.
9. MỞ BỘ NÃO.
10. LƯU BỘ NÃO.
11. MỞ WORK.
12. LƯU WORK.
13. TỰ TẠO WORK.

Current production contract: LƯU WORK hot-swap is released by TASK-RBT-003, finite global browser scheduling by TASK-RBT-004, inactivity-based long-running recovery by TASK-RBT-005, relay exhaustion recovery by TASK-RBT-005A, multi-signal Work-full rollover by TASK-RBT-006, durable stale/missing exact-target quarantine by TASK-RBT-006A, deterministic explicit Owner START latch recovery by TASK-RBT-006B, process-first Control Panel timeline/resource observability by TASK-RBT-007 (runtime v2026-09-20.59), and backward-compatible Brain planning/result-verdict runtime hooks by TASK-RBT-008 (runtime v2026-09-20.60), with final integration/overnight qualification completed by TASK-RBT-009 under MIG-006 (`RBT009_TIER_B_480M=PASS`).

## Non-negotiable invariants

1. **No Brain auto-discovery.** Brain target comes only from the lane Brain URL entered by Owner.
2. **No Brain auto-create.** Robot must never create a replacement Brain.
3. **Lane isolation.** A lane may never read, send to, or update another lane's Brain or Work target/latches.
4. **Independent start/stop.** Stopping one lane does not stop the other lanes.
5. **At most one authoritative Work target per active task.** A future pending Work target may exist, but it cannot steal the current task.
6. **Browser pages are transient execution resources.** Registry/local state, not tabs, preserves target/task/latch truth.
7. **Finite browser budget.** Target default is three active ChatGPT pages globally, not per lane.
8. **One destructive UI mutation globally.** Max concurrent mutation = 1 until evidence proves a safer higher value.
9. **Dispatch is exact-once.** A task becomes delivered only when its exact `dispatch_id` marker is confirmed.
10. **Long execution does not authorize resend.** Once dispatch is confirmed, Work may run for 30–60+ minutes without another send.
11. **Automatic Work rollover requires verified multi-signal full/capacity evidence.** A single regex or generic disabled composer is insufficient.
12. **No rollover during an active incomplete response.**
13. **Brain rollover is not automatic.** Full/missing/unavailable Brain waits for Owner replacement.
14. **Result relay is exact-once.** Each completed Work result is relayed once to the Brain of the same lane.
15. **Relay evidence includes both:** screenshot of final Work assistant turn + full captured text.
16. Screenshot files are transient local artifacts and are deleted after confirmed/deduped relay lifecycle; never commit them to Git.
17. Message bodies, screenshots, cookies, profiles, private URLs and tokens are never persisted in Git.
18. Operational timeline is privacy-safe metadata only and is never a new orchestration truth source.
19. Auth/MFA/CAPTCHA, destructive actions, admin escalation and ambiguous security decisions remain fail-closed.
20. Owner STOP/AUTOSTART_DISABLED outranks scheduler, watchdog, rollover and recovery.

## Brain directive contract

Canonical serialization authority for every MAGASIN Brain project:

`01_DOCS/MAGASIN/00_MAGASIN_LANE_DIRECTIVE_V1_PROTOCOL.md`

A Brain must follow that file before emitting a Robot-controlled directive. In particular, markers are byte-exact, JSON must parse without repair, raw URLs are preferred to Markdown links, and escaped markers such as `<<\\<MAGASIN_LANE_DIRECTIVE_V1>>>` are invalid.

The Brain of a lane returns one machine-readable block:

<<<MAGASIN_LANE_DIRECTIVE_V1>>>
{"action":"WORK","task_id":"TASK-ID","instruction":"Self-contained work instruction"}
<<<END_MAGASIN_LANE_DIRECTIVE_V1>>>

No work available:

<<<MAGASIN_LANE_DIRECTIVE_V1>>>
{"action":"IDLE"}
<<<END_MAGASIN_LANE_DIRECTIVE_V1>>>

The directive belongs only to the lane whose Brain URL produced it.

TASK-RBT-008 adds backward-compatible optional previous-result ACCEPT/REJECT metadata while preserving the action/task/instruction core and byte-exact MAGASIN_LANE_DIRECTIVE_V1 markers. Legacy WORK/IDLE directives remain valid unchanged.

## Brain Planning Contract

Every Brain lane must follow:

**PLAN → DISPATCH → VERIFY → ACCEPT/REJECT → NEXT PLAN**

For every Work task Brain must establish:

- dependency satisfied;
- one primary outcome;
- bounded scope;
- explicit DoD;
- explicit evidence;
- rollback/safety boundary when relevant;
- Work does not self-start the next task.

Task granularity target remains roughly <=20 minutes of active implementation work when decomposable. The runtime 30-minute watchdog is not permission to make 30-minute tasks by default. If expected work exceeds 30 minutes and can be split safely, Brain should split it. Inherently long-running operations may remain long when their expected evidence is explicit.

Do not optimize task count. Optimize verifiability and dependency correctness.

## Work access and Owner reset

- A manually entered Work URL must be accessible to the account/session inside the dedicated Robot Chrome profile.
- If ChatGPT reports that the conversation is not accessible, the lane waits for Owner instead of silently replacing the explicit target.
- `TỰ TẠO WORK` explicitly returns the lane to Robot-managed Work mode.
- `TỰ TẠO WORK` never authorizes Brain creation/discovery.
- Access-denied errors must be shown in plain Vietnamese; generic exact-restore errors are insufficient.

### Target Work save/hot-swap semantics

When Owner presses `LƯU WORK`:

- panel validates and atomically saves URL + increments `work_url_revision`;
- UI confirms revision + timestamp;
- runtime detects it on the next poll/scheduler turn;
- no Robot restart is required.

If lane is idle, new Work target applies immediately.

If `awaiting_work`, `dispatch_inflight`, or `relay_inflight` is active, the new target is **pending-next-target**:

- old Work remains authoritative for the current task;
- current task/result/latches are preserved;
- uncertain dispatch is reconciled before target change;
- result relay completes before target change;
- pending target applies only at the next safe boundary.

This explicitly replaces the current v50 revision-reset behavior that can clear stale task/latch state when a Work revision is applied.

## Browser scheduler / tab budget

Canonical details are in `ROBOT_BROWSER_SCHEDULER_OBSERVABILITY_ARCHITECTURE.md`.

Implemented by TASK-RBT-004 in runtime v2026-09-20.53:

- one dedicated Chrome profile;
- default global ChatGPT page budget = 3;
- no second profile solely to hide resource pressure;
- round-robin fairness across enabled lanes;
- one bounded orchestration unit per lane turn;
- max concurrent destructive UI mutation = 1;
- observation probes may interleave only when they do not overlap destructive state changes;
- one long-running lane cannot own the browser indefinitely.

Page lease states may include ACTIVE_MUTATION, ACTIVE_OBSERVATION, PARKED, EVICTABLE and CLOSED.

Closing/parking/reopening a page does not clear durable task/latch state.

Exact reopen:

1. load target from current config/registry revision;
2. open canonical conversation;
3. verify exact target;
4. probe safety/access;
5. reconcile marker/latch/state;
6. only then mutate if authorized.

## Long-running Work contract

Send confirmation and task execution are separate.

After exact `dispatch_id` confirmation:

- `awaiting_work=true`;
- no resend due to elapsed time;
- Work may run longer than 30 minutes.

Target execution states:

- <25m: WORKING;
- 25–30m: WORKING_LONG observation;
- >=30m: still WORKING_LONG if there is responseRunning/progress/recent activity;
- >=30m plus >=5m inactivity and no running/progress: STALL_CHECK;
- one bounded exact-target reload per no-progress recovery epoch;
- reconcile markers/state after reload before action;
- if still no progress: POSSIBLY_STALLED + Owner warning;
- no automatic reload loop;
- no task reset or duplicate dispatch/relay.

## Automatic Work-full detection and rollover

Runtime v2026-09-20.56 replaces the legacy single `conversationFull` rollover authority with the released multi-signal detector and durable rollover state machine.

Full confirmation must combine verified signals such as:

- explicit structured full/limit UI evidence;
- composer disabled with canonical capacity reason;
- verified send rejection/capacity evidence;
- existing conversationFull classification as supporting evidence.

No one free-form regex is authoritative.

If current task has an active incomplete response, Robot keeps that Work until completion/relay even when the composer cannot accept another message.

When full is confirmed and no active incomplete response exists:

preserve state  
→ create new blank Work  
→ obtain canonical URL  
→ increment `work_generation`  
→ persist URL/generation  
→ persist exact dispatch latch  
→ send rollover envelope once  
→ confirm dispatch marker

Robot may auto-create Work under this contract. It may never auto-create/find Brain.

## Exact-target health and navigation-storm circuit breaker

Each lane persists independent Brain and Work target-health metadata. A positively verified missing/access-denied/stable redirect-away exact target becomes QUARANTINED. The same target digest short-circuits to WAIT_OWNER before any page acquisition, reopen, goto or watchdog reload on later scheduler turns. Quarantine survives runtime/Chrome restart and STOP/START.

A different canonical Owner target clears only the corresponding role quarantine. Re-saving the same stale canonical URL does not clear it. Active task/latches/result evidence and pending Work stay intact; quarantine is not permission to reset state, resend, abandon an exact-once transaction, or auto-create a Brain.

## Work lifecycle

Target lifecycle:

1. Lane is enabled.
2. Robot verifies PROCESS TRUTH.
3. Scheduler leases the exact Owner-supplied Brain URL.
4. Robot reconciles latest valid Brain directive.
5. Brain directive is recorded as assigned.
6. Robot resolves current Work target or verified rollover requirement.
7. Robot persists a `dispatch_inflight` latch.
8. Robot sends instruction once.
9. Exact `dispatch_id` marker confirms start.
10. Browser page may be parked/closed; durable registry remains authoritative.
11. Robot observes Work on fair scheduler turns.
12. Long-running watchdog uses activity, not elapsed time alone.
13. When completed, Robot captures full result + screenshot.
14. Robot sends result to exact Brain with deterministic `relay_id`.
15. Relay marker confirms exact-once delivery.
16. Brain verifies and ACCEPTS/REJECTS before the next dependency-correct task.
17. Same Work is reused unless Owner target change safely applies or full is verified.
18. Full rollover creates only a new Work, never a Brain.

## Local state

Local-only root:

`%LOCALAPPDATA%\MAGASIN\BusinessOS\supervisor`

Current files include:

- `lanes.json` — Owner configuration, Brain/Work URL revisions, lane enabled state.
- `lane-registry.json` — durable task, dispatch, relay, Work generation, recovery state, and per-lane `project_progress` Source of Truth.
- `lane-status.json` — privacy-safe current status for Control Panel.
- `lane-evidence\` — transient screenshots; deleted after relay lifecycle.
- `supervisor.log` — metadata/errors only, no full message bodies.

Target addition:

- `lane-events.ndjson` — append-only privacy-safe operational event timeline.

Likely target state additions include:

- assigned_at / started_at / last_activity_at / completed_at / relay_confirmed_at;
- pending_work_url + pending revision/timestamp;
- watchdog epoch/reload timestamps;
- full-detection evidence codes;
- current execution phase.

Local URLs may remain in config/registry because those files are local orchestration state. Timeline/log events must not emit private URLs.

## Operational timeline

Minimum target events include:

- BRAIN_TASK_ASSIGNED
- WORK_DISPATCH_CONFIRMED
- WORK_STARTED
- WORK_OBSERVED
- WORK_LONG_RUNNING
- WATCHDOG_STALL_CHECK
- PAGE_RECOVERY_RELOAD
- WORK_COMPLETED
- RESULT_RELAY_CONFIRMED
- BRAIN_RESULT_ACCEPTED / BRAIN_RESULT_REJECTED
- BRAIN_NEXT_DIRECTIVE
- RECOVERY / ERROR
- Work target/full/rollover events where relevant

Task metrics:

- assigned_at
- started_at
- last_activity_at
- completed_at
- queue_time
- execution_time
- total elapsed

The Control Panel reads only a bounded recent tail (20–50 events), not the whole history each refresh.

## Autonomous soft-blocker recovery

For an incomplete project, `DEPENDENCY_BLOCKED` and `NO_SAFE_WORK` do not permanently park the lane. Brain first receives up to three fast whole-plan rechecks so it can choose another dependency-ready task. If the blocker remains, Supervisor persists a soft-blocker schedule and automatically rechecks the exact Brain conversation at 1, 2, 4, 8, then at most 10 minute intervals. A WORK directive clears this schedule immediately. `OWNER_REQUIRED` remains the only intentional human-wait state.

## Project Source of Truth and progress

Each lane keeps one durable `project_progress` record inside `lane-registry.json`. The first/resume Brain handshake supplies the full `project_plan` task list and any historical `completed_task_ids`. Browser tabs and GitHub pages are not the progress authority.

Progress transitions are deterministic:

- plan snapshot creates/reconciles the denominator;
- confirmed Work dispatch marks the matching planned task `ACTIVE`;
- correlated Brain `ACCEPT` marks the task `DONE`;
- Brain `REJECT` leaves the task incomplete;
- roadmap changes are applied only from a new full Brain `project_plan` snapshot.

`lane-status.json` exposes only privacy-safe summary fields: whether the plan is known, total tasks, completed tasks, percent, active task ID, and progress update time. Control Center renders those fields as a per-lane progress bar such as `10/17 TASK · 59%`.

## Status model

Existing states:

- STOPPED
- NEED_BRAIN_URL
- STARTING
- WAITING_BRAIN
- WORKING
- RELAYING_RESULT
- READY
- RECOVERING
- WAIT_OWNER
- ERROR

Target extensions:

- WORKING_LONG
- STALL_CHECK
- POSSIBLY_STALLED

The Control Panel must never show an active business state without healthy PROCESS TRUTH.

A long elapsed task is not automatically stalled. POSSIBLY_STALLED requires inactivity evidence and bounded watchdog recovery.

## Five-Step application

QUESTION — remove the need for Robot to infer Brain identity and remove browser-resource assumptions that do not scale across three lanes.  
DELETE — Brain autodiscovery, permanent tab ownership, unbounded waiting/reload assumptions, restart-required Work apply, opaque WORKING state.  
SIMPLIFY — exactly three fixed lanes; durable registry truth; one finite browser scheduler; one mutation at a time.  
ACCELERATE — reuse exact Work safely, yield after bounded lane units, keep task/latches across page close/reopen.  
AUTOMATE — auto-create Work when authorized, verified full rollover, bounded inactivity recovery, hot-save Work revisions, exact-once relay, privacy-safe timeline.

## Acceptance

Three-Lane production acceptance continues to require:

- all lane cards persist independently;
- three distinct Owner Brain URLs are supported;
- each lane starts/stops independently;
- no Brain autodiscovery/creation;
- exact-once Work dispatch + result relay;
- one lane failure does not corrupt another;
- auth/MFA/CAPTCHA/security boundaries fail closed;
- lifecycle PROCESS TRUTH > LANE TRUTH > PERSISTED RECOVERY STATE remains authoritative;
- self-hosted install/survival remain green.

TASK-RBT release additionally requires:

- 1-lane, 2-lane, 3-lane scheduler soak;
- global ChatGPT page count within budget;
- no starvation;
- max UI mutation = 1;
- >30m active Work causes no reload/resend;
- >30m inactive Work causes one bounded reload then no loop;
- full Work auto-rollover from multi-signal evidence;
- Owner Work hot-swap without restart;
- active old Work task preserved across hot-swap;
- timeline timestamps/durations correct and privacy-safe;
- Chrome/CDP healthy;
- Owner STOP authoritative.

See `docs/ROBOT_BROWSER_SCHEDULER_OBSERVABILITY_ARCHITECTURE.md` for the TASK-RBT-002 → TASK-RBT-009 dependency-correct roadmap and production soak matrix.
