# SUPERVISOR AUTONOMY SELF-HEAL V1 — EXECUTION PLAN

Status: ACTIVE HOTFIX PLAN  
Repository: magasincoffee/magasin-supervisor  
Canonical base when plan created: 49eadc9a51a28dbbfb6c7f8230cfd8fa8da5f18c  
Working branch: hotfix/supervisor-autonomy-selfheal-v1

## 1. Goal

Make MAGASIN Supervisor operate end-to-end with the Owner interacting only with Brain.

Target operating model:

1. Owner talks to Brain.
2. Brain emits exactly one MAGASIN_LANE_DIRECTIVE_V1 block.
3. Supervisor reads and adopts the directive.
4. Supervisor obtains or creates a Work chat.
5. Supervisor dispatches the bounded task exactly once.
6. Work executes using GitHub Source of Truth and returns evidence.
7. Supervisor relays Work result to Brain.
8. Brain accepts/rejects and emits the next directive.
9. If a Work chat becomes full, inaccessible, stalled, quarantined, or otherwise unusable, Supervisor preserves durable task identity and safely rolls execution to a replacement Work chat.
10. The Owner does not need to manually operate Work chats during normal execution.

## 2. Proven failures

### F1 — ChatGPT DOM drift broke message capture

Legacy selectors based on:
- [data-message-author-role]
- [data-testid^='conversation-turn-']

no longer exist on the current ChatGPT browser DOM.

Live sanitized probe proved:
- main conversation text exists,
- legacy message count = 0,
- captureRecentConversationTurns() returned 0 before the fix.

Current DOM exposes:
- [data-turn-key]
- [data-user-message-bubble]
- [data-content-search-unit-key]
- h4[data-conversation-role]
- [data-chatgpt-selection-message-id]

### F2 — Snapshot/classifier drift

The old snapshot layer also relied on legacy role/turn selectors. This caused:
- assistantMessageCount = 0
- userMessageCount = 0
- maxConversationTurnOrdinal = 0
- lastMessageRole = null

even when a valid completed Brain response was visibly present.

### F3 — Wrapper alive while Three-Lane Node never launches

run-supervisor.ps1 resolved local fallback mode only inside a project-adapter exception path.

When no project adapter was configured:
- Read-ConfiguredProjectAdapterState returned null,
- no exception was thrown,
- runtimeMode remained null,
- wrapper remained alive,
- Three-Lane Node was not launched.

Live evidence:
- WRAPPER_ALIVE=True
- THREE_LANE_ALIVE=False
- CHROME_ALIVE=True
- CDP_HEALTHY=True

### F4 — Persisted stale Brain send state can block adoption of a valid newer directive

Historical Brain handshake/send reconciliation state can survive browser/runtime failures.

Observed log sequence repeatedly:
- LANE_BRAIN_SEND_PENDING_CONFIRMATION
- LANE_BRAIN_SEND_RECONCILE_RELOAD
- LANE_BRAIN_SEND_NOT_CONFIRMED_RETRY

while live probing proved a valid current directive already existed:
- action=WORK
- task_id=SCHED-06

The runtime must prefer evidence-backed adoption of a valid completed directive over replaying an obsolete Robot handshake.

### F5 — Browser/runtime health can look green while scheduler truth is stale

Chrome/CDP may be healthy while Three-Lane status is stale.

Required distinction:
- Chrome process alive
- CDP endpoint healthy
- Three-Lane Node alive
- lane-status freshness
- ChatGPT page count
- Brain parser state

must be independently observable.

## 3. Already implemented and live-proven on hotfix branch

### H1 — Current ChatGPT message capture

src/ui/message-capture.mjs has been updated with:
- legacy selector compatibility;
- modern data-turn-key fallback;
- user capture from data-user-message-bubble;
- assistant capture from current content-search unit / selection-message surface;
- screenshot fallback for current assistant message nodes.

Live proof on real Brain:
- user turns: 4
- total turns: 8
- latest valid directive: true
- directive action: WORK
- directive task_id: SCHED-06
- completed assistant parse: PASS

### H2 — Current ChatGPT snapshot

src/ui/snapshot.mjs recognizes modern user/assistant/turn structure.

Live source snapshot proof:
- assistantMessageCount = 4
- userMessageCount = 4
- maxConversationTurnOrdinal = 8
- lastMessageRole = assistant
- responseRunning = false

### H3 — Runtime mode resolution repair

windows/run-supervisor.ps1 now allows platform-local orchestration truth to select THREE_LANE_V1 even when no project adapter is configured.

Project adapter remains required only for project/business truth in legacy/brain-worker paths.

Live proof after patch:
- RUNTIME_MODE_FROM_LOCAL_PLATFORM_TRUTH
- mode=THREE_LANE_V1
- NODE_LAUNCH
- entry_point=src/runtime/three-lane-cli.mjs
- cdp_port=9223

### H4 — Wrapper observability

wrapper.log records bounded machine-readable lifecycle events:
- RUNTIME_MODE_FROM_PROJECT_ADAPTER
- PROJECT_ADAPTER_UNAVAILABLE
- RUNTIME_MODE_FROM_LOCAL_PLATFORM_TRUTH
- RUNTIME_MODE_UNRESOLVED
- NODE_LAUNCH
- NODE_EXIT
- CDP_RECYCLE_REQUESTED

## 4. Remaining execution work

### P1 — Brain stale-handshake reconciliation

Repair durable Brain request reconciliation so that:

1. Runtime opens the exact configured Brain conversation.
2. Runtime scans recent completed turns using the current message capture.
3. If a valid MAGASIN_LANE_DIRECTIVE_V1 exists after or independently of a stale Robot handshake, runtime adopts the valid directive without sending another duplicate handshake.
4. Stale brain_request_inflight may be cleared/rebased only when evidence proves:
   - exact Brain target is unchanged,
   - valid directive parses successfully,
   - no newer user turn invalidates that directive,
   - exact-once safety is preserved.
5. Emit a dedicated event/log marker such as:
   - LANE_BRAIN_STALE_HANDSHAKE_SUPERSEDED
   - LANE_BRAIN_DIRECTIVE_ADOPTED
6. Never infer a task from prose.
7. Never weaken MAGASIN_LANE_DIRECTIVE_V1 parsing.

Acceptance:
- existing SCHED-06 directive is adopted without Owner resending it;
- no duplicate Robot handshake is sent;
- task identity becomes durable.

### P2 — Work target policy: Owner-provided OR Robot-created

Each lane must support both:

#### OWNER mode
- Owner may pin an explicit Work URL.
- Robot uses exact configured Work until rollover is required.

#### AUTO mode
- Brain URL is required.
- Work URL is optional.
- On valid WORK directive and no usable Work target, Robot creates a blank ChatGPT conversation under mutation lease.
- Robot persists canonical /c/<id> Work URL before task dispatch.
- Robot sends exactly one dispatch envelope.
- Work chat is replaceable infrastructure, not task authority.

Acceptance:
- lane can operate with Brain URL only and AUTO Work.
- new Work chat can receive current task from GitHub/Brain context without Owner interaction.

### P3 — Automatic Work replacement for unusable chats

A Work target may be replaced when there is explicit bounded evidence of:
- FULL_CONFIRMED,
- conversation missing/inaccessible,
- target quarantined,
- watchdog possibly stalled after bounded recovery,
- unrecoverable target identity failure.

Rules:
1. Preserve task_id, directive digest, instruction digest and Source-of-Truth references.
2. Persist rollover intent before creating replacement Work.
3. Increment work_generation exactly once.
4. Persist replacement Work URL before send.
5. Dispatch exact same bounded task identity.
6. Do not silently abandon an unresolved result.
7. Do not replace a healthy active Work merely because it is slow.
8. Owner STOP always wins.

Acceptance:
- old Work can disappear and current task safely continues in new Work.
- no duplicate dispatch.
- no lost task identity.

### P4 — Stale runtime/status self-heal

If:
- wrapper is alive,
- Chrome is alive,
- CDP is healthy,
- but Three-Lane Node is absent OR lane-status age exceeds threshold,

the platform must detect this explicitly.

Required actions:
- wrapper launches/relaunches Node;
- Control Panel reports NODE_DOWN or STATUS_STALE rather than misleading 0/3;
- no project state mutation;
- no Brain/Work URL mutation.

Acceptance:
- stale snapshot cannot masquerade as a live scheduler.

### P5 — Control Panel observability

Expose separate status fields:
- WRAPPER
- THREE-LANE NODE
- CHROME
- CDP
- STATUS AGE
- CHATGPT PAGE COUNT
- BRAIN HEALTH
- BRAIN DIRECTIVE: NONE / IDLE / WORK / INVALID
- ACTIVE TASK
- WORK TARGET MODE: OWNER / AUTO
- WORK TARGET HEALTH
- WORK RESET requested/applied revision
- current work_generation

For invalid Brain output:
- show reason code;
- do not guess prose into a task.

### P6 — Owner maintenance: RESET WORK STATE / BỎ TASK CŨ

Complete UI support for existing canonical reset mechanism:
- UI increments work_state_reset_revision only;
- runtime applyOwnerWorkStateReset() performs the durable reset;
- two-step destructive confirmation;
- lane isolated;
- no direct lane-registry mutation from UI.

Use only for Owner-authorized abandonment of obsolete execution state.

This is not normal Work rollover.

### P7 — Persistent sanitized diagnostics

Keep:
- wrapper.log
- supervisor.log
- lane-events.ndjson

Add bounded correlation fields where needed:
- lane_id
- task_id
- generation
- work_url_revision
- dispatch_id / relay_id
- reason_code
- runtime version
- node exit code
- CDP port

Never log:
- chat body text,
- secrets,
- auth tokens,
- complete private conversation URLs.

### P8 — Dispatch watchdog, heartbeat, bounded recovery, and repair escalation

Operational thresholds:
- heartbeat_interval = 30s
- no_progress_warning = 180s
- stalled_threshold = 300s
- recovery_attempt_limit = 3
- github_reconcile = before every retry
- maintenance_lock = true during Supervisor repair

Required behavior:
1. Distinguish composer/message prepared from message confirmed sent.
2. Emit bounded heartbeat/progress evidence while a task is active.
3. At 180 seconds without confirmed progress, emit WARNING.
4. At 300 seconds without confirmed progress, transition to STALLED.
5. Attempt bounded recovery at most 3 times.
6. Before every retry, reconcile durable lane state and GitHub task/PR/commit/merge truth.
7. Recovery follows VERIFY_STATE -> RECOVER/RESUME; never blind refresh/retry.
8. Exhausted recovery enters MAINTENANCE_LOCK and emits exactly one REPAIR_REQUIRED incident.
9. Product dispatch remains frozen while Supervisor repair is active.
10. Auto-generated repair requests must preserve incident_id, task_id, failure_type, last_good_state, last_action, elapsed_without_progress, and sanitized GitHub state.
11. Repair must pass Brain VERIFY/ACCEPT before the frozen product task resumes.
12. Failed repair acceptance can roll back to the last known-good Supervisor runtime.

Acceptance:
- a dispatch-send failure cannot remain silently RUNNING for hours;
- 5 minutes with no progress becomes STALLED;
- no blind duplicate send/merge/comment/commit after recovery;
- three failed recovery attempts create one bounded repair incident;
- product work is frozen during Supervisor repair;
- accepted repair resumes the original task from reconciled durable state;
- Owner STOP always wins.

## 5. Test plan

### Deterministic tests

Add/update tests for:
- current DOM message capture;
- legacy DOM compatibility;
- current snapshot role/count detection;
- no-adapter THREE_LANE_V1 launcher selection;
- project adapter failure + local mode fallback;
- stale Brain handshake superseded by valid directive;
- valid directive with newer non-Robot user turn is not adopted;
- no prose inference;
- AUTO Work creation;
- Work rollover exact-once identity;
- Owner STOP precedence;
- reset revision isolation;
- stale status observability.

### Live acceptance A — Brain read

On self-hosted Owner machine:
- exact Brain opens;
- parser captures valid directive;
- task_id is correct;
- no Owner resend required.

### Live acceptance B — Brain to Work

Using an authorized test/current task:
- Brain directive is durably adopted;
- Work URL is opened or AUTO-created;
- dispatch marker appears exactly once;
- registry records exact task identity.

### Live acceptance C — Work result to Brain

- Work completes;
- completed assistant response is captured;
- screenshot/text relay is sent once;
- Brain receives result;
- lane returns to waiting for next Brain directive.

### Live acceptance D — Work replacement

In a bounded non-destructive test:
- make current Work target intentionally unavailable or use an authorized replacement scenario;
- persist rollover intent;
- create/persist replacement Work;
- continue exact same task identity;
- no duplicate dispatch/result.

### Live acceptance E — restart recovery

Restart Supervisor while durable state exists:
- wrapper resolves THREE_LANE_V1;
- Node relaunches;
- Chrome/CDP reconnect;
- Brain/Work URLs preserved;
- no duplicate send;
- pending task resumes/reconciles.

## 6. Final Definition of Done

All must be true:

1. Owner can operate a lane by providing only Brain URL when Work mode=AUTO.
2. Brain valid WORK directives are read from current ChatGPT DOM.
3. Brain valid IDLE directives are read correctly.
4. Robot does not infer prose as tasks.
5. Work can be Owner-pinned or Robot-created.
6. Work chat failure does not lose current durable task.
7. Replacement Work can continue the same task after bounded evidence.
8. Dispatch and relay remain exact-once.
9. Runtime survives restart and browser/CDP recycle.
10. Wrapper/Node/Chrome/CDP/status are independently observable.
11. Owner STOP always wins.
12. No project adapter default or Business OS repository default is reintroduced.
13. Source of Truth remains GitHub/project-owned; Work chat is replaceable execution context.
14. Deterministic CI passes.
15. Self-hosted live acceptance passes Brain → Work → Result → Brain.
16. Temporary diagnostic workflows/scripts are either removed or converted into intentional supported diagnostics before merge.
17. Hotfix PR is reviewed and merged to canonical main.
18. Post-merge exact-main validation passes.

## 7. Execution order

P1 Brain reconciliation  
→ P2 AUTO/OWNER Work policy verification/fix  
→ P3 Work replacement  
→ P4 runtime/status self-heal  
→ P5 Control Panel observability  
→ P6 reset UI completion  
→ P7 logging hardening  
→ P8 watchdog / heartbeat / bounded recovery / repair escalation  
→ deterministic CI  
→ live A/B/C/D/E  
→ cleanup temporary diagnostics  
→ PR merge  
→ exact-main live verification

## 8. Stop / fail-closed conditions

Work must stop and report evidence if any of the following occurs:
- Owner STOP or lane disabled;
- unclear task identity;
- ambiguous newer Brain user turn;
- dispatch identity mismatch;
- relay identity mismatch;
- unexpected production/project mutation required;
- destructive data/history cleanup would be required;
- GitHub Source of Truth conflicts with durable runtime state;
- a fix would require weakening exact-once or parser fail-closed guarantees.

## 9. Current hotfix evidence anchors

Known successful live diagnostic runs include:
- 35945744452 — live current-DOM Brain parser proof
- 35945801751 — live fixed snapshot proof

Known failed-but-informative acceptance runs include:
- 35945887415 — proved stale wrapper/Node lifecycle problem
- 35946365347 — proved local THREE_LANE mode selection and Node launch after lifecycle fix; remaining stale Brain-send reconciliation still blocks full acceptance

These run IDs are evidence anchors, not success claims for the final end-to-end system.


## 10. GitHub execution tracking

Canonical tracking issues:
- P1 — #16 SUP-SELFHEAL-P1 — Brain stale-handshake reconciliation
- P2 — #62 SUP-SELFHEAL-P2 — Owner/AUTO Work target policy
- P3 — #63 SUP-SELFHEAL-P3 — Automatic Work replacement
- P4 — #64 SUP-SELFHEAL-P4 — Runtime/status self-heal
- P5 — #65 SUP-SELFHEAL-P5 — Control Panel observability
- P6 — #66 SUP-SELFHEAL-P6 — RESET WORK STATE UI completion
- P7 — #67 SUP-SELFHEAL-P7 — Persistent sanitized diagnostics
- P8 — #68 SUP-SELFHEAL-P8 — Dispatch watchdog, heartbeat, bounded recovery, and repair escalation

Execution remains strictly one bounded phase/task at a time. Each task returns evidence and stops for Brain VERIFY/ACCEPT/REJECT before the next task is dispatched.
