# MAGASIN Supervisor — SOURCE OF TRUTH

Status: **CANONICAL / SOLE PROJECT AUTHORITY**  
Approved by Owner: **2026-09-28**  
Architecture generation: **SINGLE_CONVERSATION_V1**

## 0. Authority rule

This file is the **only canonical Source of Truth for the MAGASIN Supervisor project**.

Canonical path:

`/SOURCE_OF_TRUTH.md`

Rules:

1. Runtime behavior, implementation planning, task status, architecture decisions, acceptance criteria, and recovery policy MUST be derived from this file.
2. No other Markdown, JSON, README section, issue, pull request, chat transcript, local state file, browser state, or conversation history may override this file.
3. Files whose names contain `SOURCE_OF_TRUTH` anywhere else in the repository are historical/superseded unless this file explicitly promotes them.
4. README is navigation only. It is not project authority.
5. Git history and old architecture documents are evidence/reference only.
6. ChatGPT conversations are disposable execution surfaces. They are never durable project authority.
7. Local runtime state may store only the minimum transaction/recovery state needed to execute safely. It must not become a competing project database.

If any source conflicts with this file, **this file wins**.

---

## 1. Architecture decision

The former persistent Planner/Executor two-conversation architecture is superseded.

The canonical architecture is:

**Single Conversation + Disposable Chat + Persistent Source of Truth**

The Owner provides only the Source of Truth URL.

The Robot MUST NOT require the Owner to provide:
- Planner conversation URL;
- Executor conversation URL;
- Brain conversation URL;
- Work conversation URL;
- any historical ChatGPT conversation URL.

At any moment, the Robot operates on **at most one active ChatGPT conversation**.

A project may use multiple ChatGPT conversations over its lifetime, but only sequentially. A conversation is a temporary working surface and may be abandoned whenever it becomes inaccessible, stale, corrupted, too long, or otherwise unsafe to continue.

---

## 2. Canonical operating model

Normal flow:

```text
OWNER
  -> provides Source of Truth URL
ROBOT
  -> opens dedicated MAGASIN Chrome
  -> opens ChatGPT
  -> creates a fresh New Chat
  -> sends bootstrap instruction containing the Source of Truth
CHATGPT
  -> reads Source of Truth from the beginning
  -> determines current project state
  -> performs or plans the next bounded action
ROBOT
  -> waits until the response is complete
  -> clicks Continue generating if ChatGPT explicitly offers it
  -> waits again until complete
  -> verifies current Source of Truth
  -> sends the next instruction in the same conversation
  -> repeats
```

The current ChatGPT conversation is useful context only.

Before choosing the next project action after a meaningful state transition, the Robot MUST re-synchronize against the Source of Truth. Conversation memory must never override repository/project truth.

---

## 3. Conversation lifecycle

### 3.1 Start

On START:

1. verify the Owner has supplied one valid Source of Truth URL;
2. launch or attach to the dedicated MAGASIN Chrome profile;
3. verify ChatGPT authentication;
4. create or acquire one blank/new ChatGPT conversation;
5. persist only a runtime conversation handle/identity needed for the current live process;
6. send the canonical bootstrap message;
7. confirm that the bootstrap appears as a new user turn;
8. wait for a complete assistant response;
9. enter the normal execution loop.

No historical conversation URL is required for START.

### 3.2 Bootstrap intent

The first message in every newly created conversation MUST instruct ChatGPT to:

- read the Source of Truth from the beginning;
- treat it as the only project authority;
- ignore stale project state from prior conversations;
- determine current task/progress directly from the Source of Truth;
- continue only from current authoritative state;
- perform one bounded next unit of work or explain the current blocking condition.

The Robot SHOULD attach a unique runtime message/correlation id to bootstrap and subsequent Robot instructions so delivery can be reconciled exactly.

### 3.3 One active conversation

Steady state:

- target ChatGPT conversation count controlled by the Robot: **1**;
- max concurrent destructive UI mutations: **1**;
- no Planner/Executor relay;
- no cross-chat task handoff;
- no dependence on ChatGPT Work mode.

The Robot waits for the active conversation to finish before issuing another instruction.

### 3.4 Continue generating

If ChatGPT explicitly presents a valid Continue generating / Continue response control after a partial assistant answer:

1. ensure no send/composer mutation is in progress;
2. click Continue once;
3. wait for generation;
4. repeat only while the explicit continuation control remains valid;
5. do not send a new user prompt until the response is complete.

A Continue click is not equivalent to a new Robot instruction and does not advance project state by itself.

---

## 4. Disposable conversation recovery

A conversation is disposable.

If the active conversation:
- cannot load reliably;
- redirects to missing/access-denied state;
- loses its composer;
- repeatedly produces network/transient errors;
- becomes too long or unusable;
- cannot be safely reconciled after a Robot restart;

the Robot MUST prefer **conversation replacement** over indefinite recovery of the old URL.

Recovery flow:

```text
ACTIVE_CONVERSATION
  -> UNUSABLE
  -> preserve only safe transaction evidence
  -> close/retire current Robot conversation if safe
  -> create NEW CHAT
  -> bootstrap from SOURCE_OF_TRUTH
  -> rehydrate project state
  -> continue
```

The new conversation MUST NOT assume that the previous conversation completed unverified side effects. It must inspect Source of Truth and available evidence first.

Conversation rollover must not change the project identity.

---

## 5. Source of Truth discipline

The Source of Truth is durable project memory.

It must contain enough information for a fresh conversation with no prior chat history to determine:

- project goal;
- architecture;
- constraints;
- completed work;
- current work;
- next approved task;
- blocking dependencies;
- definition of done;
- acceptance evidence.

The Robot MUST re-read/reconcile Source of Truth:
- at every fresh conversation bootstrap;
- after completion of a bounded implementation task;
- before selecting a materially different next task;
- after restart/recovery when transaction outcome is uncertain.

The Robot MUST NOT use a conversation transcript as the sole proof that a task is complete.

---

## 6. Runtime transaction safety

The simplified architecture still requires exact-once safety for Robot-authored browser mutations.

Canonical send states:

```text
PREPARED
-> ENQUEUED
-> DELIVERED
-> RESPONSE_RUNNING
-> RESPONSE_COMPLETE
-> VERIFIED
```

For every Robot instruction:

- persist intent/correlation before replay-sensitive UI mutation;
- after Bridge/backend enqueue, persist the returned command/receipt id immediately;
- confirm the exact/new user turn before treating delivery as successful;
- if the user turn exists but no assistant response exists, wait rather than resend;
- resend only when positive evidence proves the prior instruction was not delivered;
- bounded retry only;
- ambiguous delivery must not create duplicate side effects.

A unique message id SHOULD be embedded in Robot-authored instructions so the active conversation can be reconciled after rerender/restart.

---

## 7. Canonical state machine

```text
STOPPED
  |
  v
STARTING
  |
  v
NEW_CHAT
  |
  v
SYNC_SOURCE_OF_TRUTH
  |
  v
SEND_WORK
  |
  v
WAIT_RESPONSE
  |----------------------.
  | Continue available   |
  v                      |
CONTINUE_RESPONSE --------'
  |
  v
VERIFY_SOURCE_OF_TRUTH
  |
  +--> PROJECT_DONE -> DONE
  |
  +--> BLOCKED -> WAIT_OWNER
  |
  '--> NEXT_WORK -> SEND_WORK

Any unrecoverable conversation fault:
  -> REPLACE_CHAT
  -> NEW_CHAT
  -> SYNC_SOURCE_OF_TRUTH
```

For task work delegated to a durable external CI/deployment/job, the canonical task sub-state is:

```text
EXECUTE
  -> COMMIT
  -> CI_TRIGGERED
  -> WAIT_EXTERNAL
  -> CHECK
       |
       +--> queued/pending/requested/waiting/in_progress
       |      -> WAIT_EXTERNAL
       |
       +--> completed + success
       |      -> VERIFY_EXTERNAL_SUCCESS
       |      -> VERIFY/UPDATE SOT
       |
       +--> completed + failure
       |      -> READ_FAILURE
       |      -> AUTO_REPAIR
       |      -> COMMIT_NEW_FIX
       |      -> CI_TRIGGERED_NEW_RUN
       |      -> WAIT_EXTERNAL
       |
       +--> completed + cancelled/timed_out/action_required
       |      -> CLASSIFY
       |      -> AUTO_REPAIR/RETRY when safe
       |      -> WAIT_OWNER only for genuine Owner action
       |
       '--> no run exists
              -> TRIGGER_EXTERNAL_RUN
              -> diagnose path filter/workflow/commit trigger
              -> create concrete progress or WAIT_OWNER if genuinely impossible
```

A terminal external run is never equivalent to RUNNING. In particular, `completed + failure` MUST NOT return to a timed wait on the same run. The Robot must either create concrete repair progress or move to a bounded Owner gate after exhausting the retry policy.

The minimum durable external-work continuity record is execution/recovery metadata, not competing project authority, and includes: `task_id`, optional `checkpoint_id`, `repo`, `commit_sha`, `workflow_run_id`, `workflow_name`, `workflow_status`, `workflow_conclusion`, `failure_signature`, `failure_count`, `repair_attempt`, `last_action`, `next_action`, `last_progress_at`, Owner-required flag, and a bounded terminal-run history. Internal checkpoint IDs are evidence only and MUST NOT replace the authoritative SOT task ID in `MAGASIN_TASK_CONTROL_V1`.

---

## 8. What is deleted from the forward architecture

The following are not forward requirements and MUST be removed or isolated as legacy/rollback code:

- persistent Planner URL;
- persistent Executor URL;
- exact two-chat topology;
- Planner/Executor role binding;
- Planner -> Executor -> Planner transport;
- two-chat Bridge page binding;
- target rollover between Planner and Executor;
- Owner requirement to paste chat URLs;
- project identity derived from chat target;
- recovery strategy centered on reopening an old conversation URL.

Historical code may remain temporarily while migration is in progress, but it must not be selected by the final production path.

---

## 9. What remains reusable

The implementation SHOULD reuse proven components where they still match this architecture:

- dedicated MAGASIN Chrome/profile boundary;
- CDP discovery/health validation;
- authenticated browser profile;
- safe ChatGPT UI probes;
- composer actuation;
- matching-new-user-turn send confirmation;
- Bridge/backend transport where useful;
- response-running detection;
- Continue-generating detection/control;
- bounded diagnostics;
- Owner STOP / AUTOSTART_DISABLED lifecycle authority;
- privacy-safe incident/status logging.

Reuse components, not obsolete orchestration semantics.

---

## 10. Implementation program

### SC-001 — Authority cleanup and contract lock
State: **COMPLETE**

Deliverables:
- establish `/SOURCE_OF_TRUTH.md` as the sole authority;
- demote old Planner/Executor Source of Truth files to historical tombstones;
- make README point to one authority only;
- add regression/static checks preventing multiple files from declaring themselves canonical Source of Truth.

DoD:
- repository has exactly one forward document declaring project authority;
- no current README text contradicts this architecture.

Completion evidence:
- sole authority path: `/SOURCE_OF_TRUTH.md`;
- former Planner/Executor Source of Truth files are historical tombstones;
- legacy Brain/Work directive protocol is explicitly historical/non-authoritative;
- `test/source-of-truth-authority.test.mjs` enforces the authority contract repository-wide;
- hosted Supervisor Tests and Supervisor Integrity are required for root `SOURCE_OF_TRUTH.md` and `README.md` changes;
- PR #187 authority/static/full regression gates passed on the SC-001 candidate before completion was recorded.

### SC-002 — Single-conversation runtime state
State: **COMPLETE**

Replace Planner/Executor durable runtime shape with one active conversation session.

Minimum runtime state:
- project/session id;
- Source of Truth URL;
- active conversation runtime identity if available;
- conversation generation/rollover counter;
- pending outbound message correlation;
- send receipt/cmd id;
- delivery/response verification state;
- latest verified Source of Truth sync timestamp/revision where measurable;
- automation status/reason.

No saved conversation URL is required for future START.

DoD:
- runtime can start with Source of Truth only.

Completion evidence:
- canonical state schema: `single-conversation-state.v1`;
- canonical mode: `SINGLE_CONVERSATION_V1`;
- state initialization accepts Source of Truth and does not accept or require Planner/Executor/chat URLs;
- durable state explicitly rejects `planner`, `executor`, conversation `url`, and conversation `target` fields;
- conversation state is generation-based and stores only disposable runtime/page identity;
- outbound transaction slots cover correlation, `cmd_id`, delivery and response verification metadata without making chat content project authority;
- Source of Truth verification metadata is explicit and contains no local project task/progress authority;
- `src/runtime/single-conversation-state-cli.mjs` proves state startup from Source of Truth only;
- `test/single-conversation-state.test.mjs` is included in hosted integrity and the full regression suite;
- PR #188 candidate passed Supervisor Tests, Supervisor Integrity, Lifecycle Acceptance isolated and Autostart Install isolated before completion was recorded;
- production browser/New Chat actuation and Control Center cutover remain intentionally unselected until SC-003/SC-007.

### SC-003 — Robot-created New Chat bootstrap
State: **COMPLETE**

Implement:
- open ChatGPT landing surface;
- create a fresh conversation using UI behavior equivalent to a normal user New Chat;
- send canonical Source of Truth bootstrap;
- verify delivery and response.

DoD:
- from cold start with no chat URL, Robot creates one usable chat and receives a response.

Completion evidence:
- canonical implementation: `src/runtime/single-conversation-bootstrap.mjs`;
- qualification harness creates a true fresh ChatGPT New Chat without any Owner-provided conversation URL;
- bootstrap includes the sole Source of Truth URL and unique correlation id;
- durable state records PREPARED before UI mutation, confirms the exact new user turn, and reaches RESPONSE_COMPLETE only after a new assistant response;
- qualification response completion is correlation-aware so transient false-idle UI state cannot truncate the first assistant response;
- live qualification cleanup is bounded and exits explicitly so a durable PASS cannot be converted into a runner timeout by an attached CDP transport;
- SC-003 Live New Chat Qualification run #51 passed its target-machine attempt on `DESKTOP-4K7IM13` and the aggregate `qualification-authority` gate passed;
- target evidence recorded `SC003_LIVE_FRESH_CHAT_CREATED=True`, `SC003_LIVE_MATCHING_USER_TURN_REQUIRED=True`, `SC003_LIVE_RESPONSE_COMPLETE=True`, `SC003_LIVE_ARCHITECTURE_GENERATION_CONFIRMED=True`, and `SC003_QUAL_QUALIFIED=True`;
- production project state and production conversation targets were not mutated by qualification;
- hosted Supervisor Tests, Supervisor Integrity, Lifecycle Acceptance, and Autostart Install passed on the SC-003 candidate before completion was recorded.

### SC-004 — One-chat execution loop
State: **COMPLETE**

Implement:
- wait for complete assistant response;
- handle explicit Continue generating;
- send next bounded instruction in the same chat;
- prevent concurrent sends;
- re-sync Source of Truth before material next-task selection.

DoD:
- multiple task cycles complete using one conversation and one active mutation at a time.

Completion evidence:
- canonical implementation: `src/runtime/single-conversation-loop.mjs`;
- each next-work message re-reads the sole Source of Truth and carries a unique cycle correlation id;
- response completion is correlation-aware so transient false-idle assistant rendering cannot advance the loop early;
- explicit Continue generating is actuated only through the safe Continue control with a bounded click budget;
- durable cycle state advances through PREPARED / DELIVERED / RESPONSE_RUNNING / RESPONSE_COMPLETE and verifies Source of Truth before material next-task selection;
- shared composer transport includes bounded native-keyboard fallback and mixed legacy/modern user-turn reconciliation required by the current ChatGPT DOM;
- SC-004 Live One Chat Qualification run #9 passed its target-machine attempt on `DESKTOP-4K7IM13` and the aggregate `qualification-authority` gate passed;
- live evidence recorded `SC004_LIVE_TWO_CYCLES_COMPLETE=True`, `SC004_LIVE_SINGLE_CONVERSATION_GENERATION=True`, `SC004_LIVE_RUNTIME_IDENTITY_PRESERVED=True`, `SC004_LIVE_SOURCE_OF_TRUTH_VERIFIED=True`, and `SC004_QUAL_QUALIFIED=True`;
- qualification detected a stale HTTP-only CDP health false-positive, used the existing one-shot dedicated-Chrome recovery semantics before any UI mutation, reattached successfully, and then completed both cycles;
- production project state was not mutated and qualification requested no external-system mutation;
- hosted Supervisor Tests, Supervisor Integrity, Lifecycle Acceptance, and Autostart Install passed on the SC-004 candidate before completion was recorded.

### SC-005 — Disposable-chat rollover
State: **COMPLETE**

Implement deterministic replacement for:
- conversation missing/access denied;
- unrecoverable stale page;
- conversation-specific network failure;
- conversation too long/full;
- ambiguous page identity after restart.

DoD:
- Robot abandons an unusable chat, creates New Chat, rehydrates from Source of Truth, and resumes without Owner-provided chat links.

Completion evidence:
- canonical implementation: `src/runtime/single-conversation-rollover.mjs`;
- rollover retires the unusable active page and creates a fresh ChatGPT conversation without requiring any historical conversation URL;
- conversation generation advances monotonically and the replacement receives a new opaque runtime identity;
- replacement bootstrap rehydrates exclusively from the sole Source of Truth before work resumes;
- deterministic fault classification covers missing/access-denied, stale/unrecoverable page, conversation-specific network failure, conversation-full, and ambiguous page identity recovery boundaries;
- SC-005 Live Disposable Chat Rollover Qualification run #1 passed its target-machine attempt on `DESKTOP-4K7IM13` and the aggregate `qualification-authority` gate passed;
- live evidence recorded `SC005_LIVE_CLOSED_PAGE_REPLACED=True`, `SC005_LIVE_GENERATION_ADVANCED_1_TO_2=True`, `SC005_LIVE_NEW_RUNTIME_IDENTITY=True`, `SC005_LIVE_REHYDRATED_FROM_SOURCE_OF_TRUTH=True`, and `SC005_LIVE_POST_ROLLOVER_CYCLE_COMPLETE=True`;
- qualification confirmed no conversation URL was persisted and no production project state or external system was mutated;
- hosted Supervisor Tests, Supervisor Integrity, Lifecycle Acceptance, and Autostart Install passed on the SC-005 candidate before completion was recorded.

### SC-006 — Exact-once message receipt/reconciliation
State: **COMPLETE**

Implement durable message state:
- PREPARED;
- ENQUEUED + persisted `cmd_id`;
- DELIVERED;
- RESPONSE_COMPLETE;
- VERIFIED.

Embed a unique Robot correlation id in outbound instructions.

DoD:
- crash at any point cannot cause an unbounded duplicate resend;
- positive non-delivery evidence permits a bounded safe resend.

Completion evidence:
- canonical implementation: `src/runtime/single-conversation-transaction.mjs`;
- outbound intent and message digest are persisted at PREPARED before replay-sensitive UI mutation;
- ENQUEUED persists a stable `cmd_id` before browser actuation and carries a bounded retry counter;
- reconciliation searches exact correlated user-turn evidence across both legacy and current ChatGPT DOM surfaces rather than relying only on a stale latest-turn probe;
- a matching delivered user turn reconciles to DELIVERED without another send, while ambiguous post-send evidence fails closed across restart;
- positive non-delivery evidence permits at most one bounded safe retry in the qualified path;
- RESPONSE_COMPLETE must transition explicitly to VERIFIED, which also records Source of Truth verification;
- SC-006 Live Exact Once Qualification run #4 passed its target-machine attempt on `DESKTOP-4K7IM13` and the aggregate `qualification-authority` gate passed;
- live evidence recorded `SC006_LIVE_PREPARED_ENQUEUED_DURABLE=True`, `SC006_LIVE_POSITIVE_NON_DELIVERY_SAFE_RETRY=True`, `SC006_LIVE_SAFE_RETRY_COUNT=1`, `SC006_LIVE_DELIVERED_NO_RESEND=True`, `SC006_LIVE_DUPLICATE_SEND_ATTEMPTS=0`, and `SC006_LIVE_VERIFIED_TERMINAL_STATE=True`;
- qualification confirmed no conversation URL was persisted and no production project state or external system was mutated;
- hosted Supervisor Tests, Supervisor Integrity, Lifecycle Acceptance, and Autostart Install are required to pass on the final SC-006 candidate before merge.

### SC-007 — Control Center simplification
State: **COMPLETE**

UI changes:
- keep Source of Truth input;
- remove Planner URL input;
- remove Executor URL input;
- remove chat-target rollover controls tied to old model;
- display current conversation generation/status as diagnostics only;
- START means “create/resume Robot session from Source of Truth,” not “open supplied conversations.”

DoD:
- Owner can operate Robot with Source of Truth + START/STOP only.

Completion evidence:
- forward Control Center implementation: `windows/control-panel.ps1`;
- forward runtime entry point: `src/runtime/single-conversation-cli.mjs`;
- the default Control Center exposes Source of Truth, START ROBOT, STOP ROBOT, and single-conversation diagnostics only;
- Planner/Executor URL controls and chat-target rollover actions are absent from the forward Control Center and remain reachable only through an explicit legacy rollback flag;
- START persists `single-conversation-control.v1` with `mode=SINGLE_CONVERSATION_V1` and `source_of_truth_url` only, with no persisted ChatGPT conversation URL;
- lifecycle truth and `run-supervisor.ps1` select `SINGLE_CONVERSATION_V1` from the forward control record while preserving Planner/Executor and older runtimes as rollback/legacy paths;
- SC-007 Control Center Qualification run #2 passed on `DESKTOP-4K7IM13` and the aggregate `qualification-authority` gate passed;
- target evidence recorded `SC007_QUAL_FORWARD_UI_CONTRACT=True`, `SC007_QUAL_SOURCE_ONLY_CONTROL=True`, `SC007_QUAL_LIFECYCLE_MODE=True`, `SC007_QUAL_RUNTIME_READY_FROM_SOT=True`, `SC007_QUAL_CHAT_URL_REQUIRED=False`, and `SC007_QUAL_QUALIFIED=True`;
- qualification used an isolated temporary state root and recorded `SC007_QUAL_PRODUCTION_STATE_MUTATED=False`;
- hosted Supervisor Tests, Supervisor Integrity, Lifecycle Acceptance, and Autostart Install passed on the SC-007 candidate before completion was recorded.

### SC-008 — Cold-start and failure qualification
State: **COMPLETE**

Required acceptance matrix:
1. cold start, authenticated profile;
2. one fresh New Chat created automatically;
3. bootstrap delivered and answered;
4. Continue generating path works;
5. multiple sequential work cycles;
6. current chat intentionally broken -> automatic new chat rollover;
7. Robot restart during PREPARED/ENQUEUED/DELIVERED/WAIT_RESPONSE;
8. no duplicate unsafe mutation;
9. no Planner/Executor URLs required;
10. exactly one active Robot ChatGPT conversation in steady state.

Completion evidence:
- canonical live qualification harness: `.github/scripts/supervisor-sc008-live-qualification.mjs` and `.github/scripts/supervisor-sc008-live-qualification.ps1`;
- SC-008 Cold Start Failure Qualification run #11 passed on the real self-hosted Windows target `DESKTOP-4K7IM13`;
- the aggregate `qualification-authority` job passed and target evidence recorded `SC008_QUAL_QUALIFIED=True`;
- all ten acceptance-matrix checks recorded PASS: cold authenticated start, automatic fresh New Chat, bootstrap delivery/answer, Continue path, sequential cycles, automatic broken-chat rollover, restart reconciliation across PREPARED/ENQUEUED/DELIVERED/WAIT_RESPONSE, no duplicate unsafe mutation, no Owner-supplied Planner/Executor URL, and exactly one active Robot ChatGPT conversation in steady state;
- target evidence recorded `SC008_LIVE_STATUS=PASS`, `SC008_LIVE_PRODUCTION_PROJECT_STATE_MUTATED=False`, and `SC008_LIVE_EXTERNAL_SYSTEM_MUTATION_REQUESTED=False`;
- live qualification cleanup is bounded and exits explicitly so a completed PASS cannot be lost to an attached-CDP cleanup hang;
- Supervisor Tests, Supervisor Integrity, Supervisor Lifecycle Acceptance, and Supervisor Autostart Install passed on the final SC-008 runtime candidate before completion was recorded.

The required production-cutover matrix has passed on the real self-hosted Windows runtime.

### SC-009 — Production START wiring regression
State: **COMPLETE**

Incident evidence:
- on 2026-09-29, an actual Owner START on `DESKTOP-4K7IM13` opened the dedicated ChatGPT Chrome but did not type or send the bootstrap;
- read-only live diagnostic confirmed `single-conversation-control.v1` with `mode=SINGLE_CONVERSATION_V1`, one active Supervisor wrapper, dedicated Chrome online, but `single-conversation-state.json` absent and zero `single-conversation-cli.mjs` processes;
- the same diagnostic confirmed legacy `target.json` was absent, which is correct for the Source-of-Truth-only architecture;
- root cause: `windows/run-supervisor.ps1` incorrectly applied a legacy target-file gate to `SINGLE_CONVERSATION_V1`, causing the wrapper to loop after opening Chrome and before launching the single-conversation runtime.

Completion evidence:
- `windows/run-supervisor.ps1` now exempts `SINGLE_CONVERSATION_V1` from the legacy `target.json` gate while preserving the gate for legacy target-bound modes;
- `test/control-panel-single-conversation.test.mjs` locks the targetless forward START contract and confirms production launch includes `--execute`;
- hosted Supervisor Tests #1010, Supervisor Integrity #1024, Supervisor Lifecycle Acceptance #835, and Supervisor Autostart Install #865 passed on the fix candidate;
- the fixed candidate was installed on the real production target `DESKTOP-4K7IM13` without changing the existing single-conversation control record;
- SC-009 Production START Qualification run #1 passed its target-machine attempt and the aggregate `qualification-authority` job passed;
- target evidence recorded `SC009_LIVE_OWNER_START_INVOKED=True`, `SC009_LIVE_SINGLE_NODE_OBSERVED=True`, `SC009_LIVE_STATE_CREATED=True`, `SC009_LIVE_GENERATION=1`, `SC009_LIVE_BOOTSTRAP_VISIBLE=True`, `SC009_LIVE_ASSISTANT_RESPONSE_VISIBLE=True`, and `SC009_LIVE_PRODUCTION_START=PASS`;
- the live state ended with an ACTIVE conversation and RUNNING automation, proving the real Control Center/START -> wrapper -> single-conversation runtime -> ChatGPT bootstrap path now operates end to end.

The production START wiring regression is closed.

### SC-010 — NEXT_WORK stall recovery
State: **COMPLETE**

Incident evidence:
- on 2026-09-29, an actual Owner production run on `DESKTOP-4K7IM13` completed bootstrap plus one bounded work cycle, then stopped issuing new work while Control Center still reported `AUTOMATION: RUNNING • phase=NEXT_WORK`;
- read-only live diagnostic at 2026-09-29T04:47:17Z confirmed exactly one Supervisor wrapper, exactly one `single-conversation-cli.mjs` process, healthy dedicated Chrome/CDP on port 9222, and exactly one active ChatGPT conversation;
- durable state had been unchanged since 2026-09-29T04:38:39Z with `conversation.status=ACTIVE`, `outbound.state=VERIFIED`, `automation.status=RUNNING`, and `automation.phase=NEXT_WORK`;
- the completed outbound transaction had no error code and had reached PREPARED -> ENQUEUED -> DELIVERED -> RESPONSE_RUNNING -> RESPONSE_COMPLETE -> VERIFIED.

Completion evidence:
- inter-cycle delay now uses a native runtime timer rather than a long-lived Playwright page RPC;
- NEXT_WORK recovery probe and baseline user/assistant capture are bounded by native deadlines; a hung UI/CDP step maps to deterministic wrapper recovery instead of remaining indefinitely in `RUNNING/NEXT_WORK`;
- runtime cleanup is bounded and the forward wrapper preserves exit-code-75 dedicated-Chrome recovery without replaying an already VERIFIED transaction;
- disposable recovery handles the page-close/probe race as a stale-page rollover;
- New Chat/bootstrap handling tolerates delayed composer hydration and preserves exact delivery evidence;
- newly created ChatGPT pages become the adapter's sticky active page so multi-cycle qualification cannot retain a stale warm-up tab as runtime identity;
- qualification-only continuity ignores descriptive DONE/BLOCKED text and runs to its fixed `maxCycles`, while normal production execution retains terminal-answer semantics;
- regression tests cover bounded NEXT_WORK recovery, native inter-cycle delay, deterministic recovery exit, page-close race, delayed composer hydration, and sticky active-page tracking;
- SC-010 NEXT_WORK Stall Qualification run #25 passed on the real target `DESKTOP-4K7IM13`;
- target evidence recorded `SC010_LIVE_FIVE_SEQUENTIAL_CYCLES=PASS`, `SC010_LIVE_FINAL_OUTBOUND_VERIFIED=True`, `SC010_LIVE_FINAL_PHASE_NEXT_WORK=True`, `SC010_LIVE_SOT_VERIFIED=True`, `SC010_LIVE_ACTIVE_CONVERSATION_COUNT=1`, `SC010_LIVE_GENERATION=1`, `SC010_LIVE_DUPLICATE_SEND_ATTEMPTS=0`, and `SC010_LIVE_STATUS=PASS`;
- target qualification recorded no production project-state mutation and no external-system mutation request, then restored the production Supervisor wrapper;
- aggregate `qualification-authority` passed with `DESKTOP-4K7IM13` as the qualified target;
- final runtime candidate `eac8091674f521835ab53b285e6e45d219c97264` passed Supervisor Tests #1059, Supervisor Integrity #1073, Supervisor Lifecycle Acceptance #884, and Supervisor Autostart Install #914 before completion was recorded.

The production NEXT_WORK stall is closed.

### SC-011 — Task-ID execution continuity and long-running work
State: **COMPLETE**

Owner-visible incident evidence:
- after SC-010, the Robot can still open a fresh ChatGPT conversation after a normal runtime process restart even when the current conversation is healthy;
- normal work instructions ask ChatGPT to re-read Source of Truth and choose the next action in free text, so the Robot has no explicit task identifier to transport between turns;
- production response timeout is 180 seconds, which is not sufficient for E2E or verification work that can take 30-60 minutes;
- terminal detection based on free-text keywords can stop the runtime even when words such as BLOCKED appear only descriptively.

Canonical forward contract:
1. ChatGPT selects exactly one authoritative task ID from Source of Truth; the Robot never invents or chooses the task.
2. The Robot copies that exact task ID into an execution instruction in the same active conversation.
3. Every production response ends with one machine-readable `MAGASIN_TASK_CONTROL_V1` block.
4. Long-running work may return `STATUS=RUNNING` with the same `TASK_ID` and a bounded `CHECK_AFTER_SECONDS`; the Robot waits with a native timer and checks the same task in the same conversation.
5. `STATUS=DONE` and `STATUS=BLOCKED` are terminal machine states; descriptive prose is not terminal authority.
6. A runtime restart reuses the current conversation only when its opaque runtime identity can be uniquely verified and the prior outbound transaction is at a safe boundary; otherwise disposable-chat replacement remains the recovery path.
7. Terminal completion/Owner wait pauses the wrapper instead of immediately starting another runtime session.

DoD:
- a normal process restart with one healthy verified conversation does not create a new Chat;
- the Robot executes the task ID returned by ChatGPT rather than issuing an unbounded generic NEXT_WORK instruction;
- a synthetic RUNNING -> CHECK -> COMPLETE path remains in one conversation without duplicate execution;
- direct assistant turns may be observed for up to 90 minutes, while durable external jobs are preferred for work expected to exceed about five minutes;
- terminal status causes wrapper pause and cannot be triggered by unrelated prose;
- unit/integrity/lifecycle/autostart gates pass;
- a live target qualification on `DESKTOP-4K7IM13` proves one conversation generation survives at least one real CLI restart.

Completion evidence:
- production task transport uses the machine-readable `MAGASIN_TASK_CONTROL_V1` contract with `READY`, `RUNNING`, `COMPLETE`, `BLOCKED`, and `DONE` states;
- task execution copies the exact SOT task ID into `MAGASIN_EXECUTE_TASK_V1`; long-running work keeps the same task ID and is revisited with `MAGASIN_CHECK_TASK_V1` after `CHECK_AFTER_SECONDS`;
- free-text mentions of words such as BLOCKED/DONE no longer have terminal authority; only the parsed task-control block can stop or advance production;
- direct assistant response observation supports up to 90 minutes, while work expected to exceed about five minutes is instructed to launch a durable external job/run and return `STATUS=RUNNING` for bounded polling;
- a safe CLI restart first attempts unique opaque-runtime rebind to the existing verified ChatGPT conversation and only rolls over when that identity cannot be safely reconciled;
- terminal DONE/BLOCKED/protocol-invalid states map to intentional autonomy pause rather than wrapper relaunch;
- focused SC-011 protocol/runtime tests passed 14/14 on both target and non-target runners;
- SC-011 Task-ID Continuity Qualification run #13 passed on the real target `DESKTOP-4K7IM13`: `SC011_LIVE_CLI_RESTART_REUSED_CONVERSATION=True`, `SC011_LIVE_GENERATION_STABLE=1`, `SC011_LIVE_RUNTIME_ID_STABLE=True`, `SC011_LIVE_TOTAL_SEQUENTIAL_CYCLES=3`, `SC011_LIVE_MATCHED_RUNTIME_PAGE_COUNT=1`, `SC011_LIVE_DUPLICATE_SEND_ATTEMPTS=0`, and `SC011_LIVE_STATUS=PASS`;
- the same live qualification preserved Owner STOP, did not mutate production project state or request an external-system mutation, bounded CDP cleanup, closed the qualification chat, and exited explicitly instead of timing out after a durable PASS.

### SC-012 — Production restart replacement regression
State: **COMPLETE**

Owner-visible incident evidence:
- on 2026-09-29, a real production run on `DESKTOP-4K7IM13` showed `conversation.generation=173` after repeated open/send/close/reopen behavior;
- bounded production diagnostic on the same target started from `generation=173`, healthy dedicated Chrome/CDP, and an ACTIVE conversation at a safe `RESPONSE_COMPLETE` boundary;
- restart rebind could not verify the prior opaque runtime identity and correctly selected disposable replacement with reason `RUNTIME_RESTART_IDENTITY_NOT_VERIFIED`;
- the replacement path then closed the currently attached ChatGPT page before acquiring a replacement page; when that page was the last tab in dedicated Chrome, Chrome/CDP terminated and bootstrap failed;
- durable state ended `conversation=RETIRED`, `automation=BLOCKED`, `phase=BOOTSTRAP_FAILED`, `outbound.last_error_code=BOOTSTRAP_FAILED`;
- the production wrapper treated generic runtime failure as retryable even after durable `automation.status=BLOCKED`, allowing repeated restart/replacement attempts and chat-generation churn.


- on 2026-10-05 the Owner observed the Robot correctly detect `CHATGPT_CONVERSATION_FULL` while the active task was already in a `STATUS=RUNNING / CHECK_AFTER_SECONDS` recheck interval, but the runtime then remained visibly idle for several minutes before creating/recovering the next chat. Code inspection proved that the recheck path used one uninterrupted `waitForNextCycleDelay(CHECK_AFTER_SECONDS)`, so no chat-health probe ran during that sleep. The Owner also clarified that long Supabase/GitHub/database work must be allowed to run for production-length durations and must not be interrupted merely because total task wall-clock time is large. The canonical stabilization repair is therefore a two-clock model: external-work/task deadlines remain authoritative and may run for 30-90+ minutes, while disposable-chat health is observed independently during those waits. `CHECK_AFTER_SECONDS` must be preserved exactly as the earliest recheck deadline; read-only health probes may preempt only the disposable chat when it becomes full/missing/unusable, bootstrap a fresh generation from the same SOT, then resume the remaining wait without sending the task CHECK early or replaying prior execution. Work-stall recovery is based on meaningful no-progress age, not total task age; the default no-progress threshold is 15 minutes, while chat replacement is a separate bounded recovery path. Control Center must expose request/response/recovery timestamps so Owner can distinguish intentional waiting from a genuine stall.
- on 2026-10-05 explicit deploy run `37312851062` exposed a production-routing defect unrelated to application code: attempts 1-3 were all scheduled by GitHub onto `runner_id=23 / DESKTOP-H4A16IL` because the deploy job declared only `runs-on: self-hosted`. The existing computer-name guard correctly emitted `TARGET_MATCH=False / TARGET_MUTATION_SKIPPED=True` and prevented any mutation, while prior successful deploys had run on `runner_id=21 / DESKTOP-4K7IM13`. PR #320 then tested a custom-label routing repair, but deploy run `37314650652` failed safely in its hosted preflight with `403 Resource not accessible by integration`: repository `GITHUB_TOKEN` had `Actions: write` yet could not list/manage self-hosted runners, so runner-label administration is not available to this control plane. The canonical repair is therefore bounded self-routing without runner-admin authority: keep exactly one self-hosted mutation job per workflow run; if `%COMPUTERNAME%` is not `DESKTOP-4K7IM13`, perform no checkout/runtime mutation, wait with bounded backoff, dispatch one successor `workflow_dispatch` carrying the same authorized `deploy_sha` plus an incremented routing attempt, and fail the current run. Concurrency keeps these attempts sequential. Only the exact target may proceed to checkout/deploy. Routing is capped at 12 attempts; exhaustion is terminal evidence requiring Owner/runner availability intervention rather than an infinite loop.
- on 2026-10-05 after the independent-clock repair was deployed, the Owner provided a Control Center screenshot showing an observability regression: the newly added activity milestones were appended as a second line inside the 26-pixel `THỜI GIAN` label, causing the milestone text to overlap the red `LỖI / CẢNH BÁO` row. The same screenshot showed `STARTING_BROWSER` plus watchdog `CHATGPT_CONVERSATION_FULL` rendered as a red fault even though wrapper/CDP were alive and Owner action correctly remained unnecessary. Canonical Owner UI must therefore allocate independent fixed rows for timer/countdown and activity milestones, use concise local clock values in the milestone row, and classify a lone `CHATGPT_CONVERSATION_FULL` during an active bounded chat-recovery phase as a recovery event rather than an Owner-required error. Any simultaneous non-recovery watchdog fault remains a real warning/error and must not be hidden.
- on 2026-10-05 the Owner identified that large tasks such as XSTORE-019B were spending most elapsed time in repeated broad CI/regression cycles rather than implementation: small edits could produce separate commits, each commit retriggered broad GitHub Actions, failures were repaired one-by-one, stale tests could generate extra cycles, completed jobs could still be followed by long waits, and newer commits did not have an explicit runtime authority marker over older active runs. The Owner explicitly required optimization without changing the established DISCOVER/BOOTSTRAP -> EXECUTE -> RUNNING/CHECK -> COMPLETE/BLOCKED/DONE control flow or machine protocol. Canonical repair is additive execution policy and metadata only: targeted QA/change-impact analysis inside EXECUTE before durable release gates, batch failure collection/root-cause repair/batch commit preference, authoritative-SHA and obsolete-run recognition, bounded adaptive active-run polling, persistent internal checkpoint/gate/fingerprint/loop metadata, stale-test handling against current SOT contract, and final required regression/exact-main gates unchanged.

- on 2026-10-05 the task-execution-efficiency implementation was delivered through PR #322 without changing controller protocol semantics. The implementation used one initial batch commit for runtime/state/UI/tests/SOT and one repair commit after full regression exposed a single stale fixture. PR gates were GREEN on head `ec6b502bcc39898b8bcbf9b2219cf42c0ea3be4e`: Supervisor Tests `37321361429`, Supervisor Integrity `37321361447`, Supervisor Lifecycle Acceptance `37321361521`, and Supervisor Autostart Install `37321361284` all completed `success`. PR #322 was squash-merged to `main` as `f73a57a9da153ca80e50389ae10680d41244bf68`; Git tree verification proved the merged main tree `3ee08e7ad18a01cf8058a5514d18cf23144e178e` is exactly identical to the GREEN PR-head tree. The implemented runtime preserves DISCOVER/BOOTSTRAP, EXECUTE, CHECK, COMPLETE/BLOCKED/DONE, the existing MAGASIN machine blocks, TASK_ID/NEXT_TASK_ID authority, required release/full regression, exact-once recovery, and single-conversation orchestration while adding targeted-QA policy, batch-repair policy, authoritative-SHA/obsolete-run handling, bounded adaptive polling, checkpoint/gate/fingerprint/loop metadata, stale-test contract handling, safe old-state defaults, and Owner observability.
Canonical fix:
1. disposable replacement MUST acquire/commit the new ChatGPT page before closing the retired page;
2. the retired page MUST be closed after replacement acquisition and before the new bootstrap mutation, preserving one active Robot conversation in steady state;
3. a durable single-conversation `automation.status=BLOCKED` after runtime exit is a fail-closed wrapper boundary and MUST stop automatic relaunch;
4. restart identity mismatch may still select disposable replacement, as required by SC-011, but one failed replacement MUST NOT create an unbounded rollover loop;
5. regression tests MUST lock replacement-before-close ordering and blocked-state wrapper pause;
6. final acceptance requires a real target run on `DESKTOP-4K7IM13` proving restart/replacement no longer kills Chrome/CDP and does not advance conversation generation repeatedly.

DoD:
- replacement cannot close the final dedicated-Chrome page before a replacement page exists;
- a bootstrap/replacement failure reaches a bounded BLOCKED state without automatic wrapper churn;
- focused tests and hosted integrity/lifecycle gates pass;
- real production qualification on `DESKTOP-4K7IM13` shows bounded generation growth and no repeated tab/chat creation.

Completion evidence:
- `src/runtime/single-conversation-rollover.mjs` now acquires/commits the replacement page before closing the retired page, so the last dedicated-Chrome tab is never closed before another page exists;
- `windows/run-supervisor.ps1` treats durable `automation.status=BLOCKED` as a fail-closed wrapper boundary and stops retry relaunch instead of creating chat churn;
- focused SC-012 regressions passed 22/22 on the real target before live qualification;
- hosted Supervisor Tests #1095, Supervisor Integrity #1109, Supervisor Lifecycle Acceptance #920, and Supervisor Autostart Install #950 passed on the final candidate;
- SC-012 Production Restart Replacement Qualification run #1 passed on `DESKTOP-4K7IM13` and aggregate `qualification-authority` passed;
- target evidence recorded `SC012_LIVE_RESTART_FIXTURE_ONE_HOME_PAGE=True`, `SC012_LIVE_FORCED_IDENTITY_MISS=True`, `SC012_LIVE_REPLACEMENT_BEFORE_CLOSE=PASS`, `SC012_LIVE_CDP_SURVIVED_REPLACEMENT=True`, `SC012_LIVE_GENERATION_ADVANCED_EXACTLY_ONCE=2`, `SC012_LIVE_ACTIVE_CHATGPT_PAGE_COUNT=1`, `SC012_LIVE_FINAL_OUTBOUND_VERIFIED=True`, and `SC012_LIVE_STATUS=PASS`;
- qualification mutated no production project state, requested no external-system mutation, installed the exact qualified candidate on the target, and preserved Owner STOP.

---

### SC-013 — Legacy orchestration retirement and stuck composer recovery
State: **IN PROGRESS**

Owner-visible incident evidence:
- on 2026-09-30, a real production run on `DESKTOP-4K7IM13` sent one message, then visibly populated the ChatGPT composer but did not submit it for more than 30 minutes;
- live state inspection showed `conversation=ACTIVE`, `automation=BLOCKED`, `phase=SEND_WORK`, `outbound=ENQUEUED`, `delivered_at=null`, while the live ChatGPT page had an enabled composer containing 878 characters and an enabled `Gửi` button;
- the submit diagnostic recorded `COMPOSER_NOT_READY` even though the live composer was editable and Send was enabled;
- strict outbound digest and the contenteditable draft digest differed because ChatGPT ProseMirror can encode visible multiline paragraph boundaries structurally, so `textContent` can collapse rendered line boundaries and produce a false non-persistence result;
- the same production merge automatically triggered obsolete Planner/Executor-era workflows on `main`, including PE-001, PE-007, and the legacy Brain submit diagnostic; these jobs consumed the real self-hosted target and interfered with forward production deployment/diagnostics.
- on 2026-10-01, repeated SC-013 source fixes exposed a second production-interference path: ordinary `src/**` / `windows/**` merges auto-triggered `Supervisor Control Panel Deploy DESKTOP-4K7IM13`; live run #36885671987 on `DESKTOP-4K7IM13` stopped the dedicated Chrome process group and an existing PowerShell control/runtime process before replacing the canonical runtime, after which the same deploy job immediately reported `Dedicated Chrome/CDP unavailable`; this proves code inspection/fix merges were able to interrupt an otherwise long-running Robot session.
- after the explicit-deploy boundary and canonical START wrapper fix were installed, live evidence on 2026-10-01 showed Owner START successfully produced `WRAPPER_OBSERVED`, launched `single-conversation-cli.mjs`, and restored healthy CDP, but the runtime then exited with `RUNTIME_RESTART_BOOTSTRAP_NON_DELIVERY_UNVERIFIED`; local watchdog evidence showed CDP becoming healthy before the wrapper exited, while later read-only probes observed a blank ChatGPT home surface with an empty ready composer, demonstrating that the one-shot positive non-delivery check could race normal ChatGPT UI hydration and falsely block a safe bounded bootstrap recovery.
- after the bounded settle-window fix was deployed, a pre-armed live attempt on `DESKTOP-4K7IM13` observed Owner START in real time and captured the next first failure as `SEND_NOT_ACTUATED / BOOTSTRAP_FAILED`; wrapper stderr then identified `CDP_RECOVERY_REQUIRED` at runtime stage `BOOTSTRAP_NON_DELIVERY_DRAFT`, while the independent local watchdog continued to report `cdp_healthy=true` after the wrapper had exited and the dedicated Chrome process group remained alive, proving that the 5-second bounded draft-read timeout was a false CDP-death classification rather than an actual browser/CDP outage.
- after the draft-timeout fix (#276) was deployed, the next pre-armed attempt again captured `SEND_NOT_ACTUATED / BOOTSTRAP_FAILED`, but wrapper stderr now advanced to `RUNTIME_RESTART_BOOTSTRAP_NON_DELIVERY_UNVERIFIED`; watchdog evidence during the settle window showed one home page, `conversation_path=false`, `composer_ready=true`, empty draft, no response, no login/CAPTCHA/network/transient error, and healthy CDP for the full recovery window, proving that the remaining rejection came from the heuristic user/assistant message-count gate rather than a real conversation turn or browser fault.
- after the exact-turn non-delivery proof fix (#277) was deployed, the next pre-armed live attempt still ended at `RUNTIME_RESTART_BOOTSTRAP_NON_DELIVERY_UNVERIFIED` without sending the bootstrap; post-failure read-only diagnostics against the exact installed runtime proved every non-delivery gate was then positive and `waitForPositiveBlankBootstrapNonDelivery()` itself returned success in about 9 seconds, while the failed startup run exhausted its original ~30-second recovery window. This isolates the remaining first failure to a startup settle/readiness race rather than to exact-once policy, CDP health, composer state, or persisted-turn evidence.
- after the 90-second startup settle change (#278) was deployed, the next real attempt remained blocked while the wrapper/runtime and CDP were still alive; new per-sample telemetry showed repeated `DRAFT_NOT_EMPTY_OR_UNREADABLE` with `draft_error=DRAFT_READ_TIMEOUT`. This proved the remaining first failure was the redundant second Playwright composer-locator traversal, not actual non-empty draft evidence. The local watchdog had also been converting a timed-out draft read into `draft_has_text=false`, so its previous empty-draft field was not positive evidence. The canonical repair is therefore to derive `composerTextReadable/composerHasText/composerTextCharCount` inside the same safe DOM snapshot that proves composer readiness, use that single snapshot for bootstrap empty-draft authority, and make watchdog draft state nullable when unreadable instead of silently treating timeout as empty.
- after the single-snapshot draft fix and delegated START support (#279) were deployed, the pre-armed observer successfully advanced the stale bootstrap from generation 1 `BLOCKED/BOOTSTRAP_FAILED` into `RUNNING/REPLACE_CHAT`, and the replacement generation reached generation 2 with `retry_count=1`. The runtime then persisted `PREPARED / SEND_NOT_ACTUATED`, but read-only production evidence showed a real conversation with one user turn and one assistant turn. The user turn contained the exact bootstrap protocol marker, the current unique message ID, and the current SOT URL, while the generic full-text matcher rejected it because ChatGPT rendered a one-character presentation mutation. Therefore the bootstrap was actually delivered and answered; the first failure is now delivery verification/reconciliation, not composer actuation. The canonical repair is bootstrap-specific correlation identity and restart reconciliation without any resend.
- after correlated-delivery reconciliation (#280) was deployed, the delegated live attempt still remained `PREPARED / SEND_NOT_ACTUATED`. Subsequent read-only diagnostics proved the previously delivered bootstrap conversation was no longer an open tab after restart, but its opaque runtime identity `chat:0a2e510ffd86a7df06fa7ff81a7cd572` still appeared in exactly one current Recent/Sidebar URL. An incident-window Chrome-history scan independently found exactly one hydrated conversation with `correlated-modern-bootstrap-user-turn`, one matching user turn, the current message ID and SOT, and the same opaque runtime identity. Therefore #280 failed because it searched only currently open ChatGPT tabs; the canonical repair is to extend correlated bootstrap recovery to boundedly hydrate Recent/Sidebar candidates, require exactly one exact correlation, close non-matches, and persist `DELIVERED` without any resend.
- after Recent/Sidebar recovery (#281) was deployed, the delegated live attempt advanced the internal first failure to `RUNTIME_RESTART_IDENTITY_NOT_VERIFIED` while CDP remained healthy and watchdog still observed `RESPONSE_COMPLETE`. The runtime spent about 114 seconds before failing. A later warm diagnostic proved the known correlated runtime identity was present in exactly one current Recent URL and its bootstrap correlation was visible on the first check in about 41 ms. This isolates the remaining failure to cold-start Recent-list discovery: #281 enumerated Recent only once before scanning candidates, so the correct conversation could appear in the sidebar after that first enumeration. Canonical recovery must therefore re-enumerate Recent boundedly and process only newly appeared runtime identities; a hydrated candidate with real user turns but no bootstrap correlation is an immediate non-match and must not consume the full hydration budget.
- on 2026-10-02 after a later technical runtime stop, explicit Owner START restored wrapper/CDP but opened only `https://chatgpt.com/`; durable state remained `RUNNING / NEXT_WORK / VERIFIED` for the prior `TASK_EXECUTION`, expected runtime identity `chat:9da349dd0817b1484d73161874c98f58` was absent from open pages, Recent/Sidebar enumeration returned zero URLs, and wrapper stderr repeated `RUNTIME_RESTART_IDENTITY_NOT_VERIFIED`. PRs #284 and #285 hardened Recent/Sidebar hydration but live evidence still returned zero Recent URLs. PR #286 therefore added a fail-closed, read-only Chrome History fallback: candidate ChatGPT conversation URLs are discovered only in the local dedicated browser history, hashed in memory with the existing opaque runtime-identity function, and a conversation is reopened only when exactly one URL matches the persisted runtime identity; the history tab is then closed and no conversation content is persisted or logged. After all mandatory gates passed and exact-main deploy completed on `DESKTOP-4K7IM13`, live watchdog evidence advanced from the stale `NEXT_WORK / VERIFIED` state into a fresh `TASK_EXECUTION`; the new message `f0f50a07-090f-47c3-90d7-6836a21013e0` progressed from `PREPARED` to `DELIVERED / WAIT_RESPONSE` with `wrapper_alive=true`, `cdp_healthy=true`, local watchdog `HEALTHY`, and `owner_stop=false`. This proves the restart-rebind failure was repaired without resending the previously verified task; SC-013 remains IN PROGRESS until the response completes and the required subsequent same-conversation cycles pass.
- later on 2026-10-02, the Robot again stopped immediately after a `SOURCE_OF_TRUTH_TASK_DISCOVERY` transaction `5f02196a-d9b6-40fd-a30f-3719fd45409a` reached `VERIFIED / NEXT_WORK`. Live watchdog evidence on `DESKTOP-4K7IM13` showed `owner_stop=false`, `wrapper_alive=false`, `cdp_healthy=false`, while durable state remained `automation=RUNNING`, `conversation=ACTIVE`, `outbound=VERIFIED`, and contained no runtime error. The exact assistant response was a valid plain-text control block with `STATUS=READY`, `TASK_ID=NONE`, `NEXT_TASK_ID=SCHED-UI-006`, and `CHECK_AFTER_SECONDS=0`, so no Owner pause or project completion was authorized. In the wrapper, simultaneous wrapper+Chrome shutdown with Owner STOP false is consistent with the exit-76 autonomy-pause path; because the response was neither `DONE` nor `BLOCKED`, the remaining exit-76 cause is `TASK_PROTOCOL_INVALID`. The first failing boundary is therefore task-control parsing after a visually valid VERIFIED response. PR #289 adds a narrow rendered-whitespace fallback so ChatGPT Markdown/`innerText` may collapse visible line breaks to ordinary whitespace while the parser still requires the exact header/footer and a body consisting only of machine `KEY=VALUE` tokens; focused positive and negative regression tests plus all four mandatory hosted gates passed. Exact-main deploy commit `47c3ab9abba7eb55ba3bd895743b92ce8222d915` was installed on `DESKTOP-4K7IM13` with `TARGET_MATCH=True`. This repair is DEPLOYED but NOT YET LIVE-QUALIFIED; the next step is one Owner START and a full rerun from the beginning. If the same boundary fails, capture the new first-failure evidence before any further change.
- after the subsequent Windows reboot on 2026-10-03 local time, post-logon evidence showed the GitHub runner and independent local watchdog did autostart, but the Robot wrapper exited immediately instead of resuming the prior chat. On `DESKTOP-4K7IM13`, watchdog evidence showed `owner_stop=false`, `wrapper_alive=false`, `cdp_healthy=false`, local watchdog heartbeat fresh, durable state `BLOCKED / SEND_WORK / ENQUEUED`, kind `SOURCE_OF_TRUTH_TASK_DISCOVERY`, message `3f968d68-bab1-46c5-9d25-d77de7524ad2`, `last_error_code=SEND_NOT_ACTUATED`, and wrapper stderr `RUNTIME_RESTART_IDENTITY_NOT_VERIFIED`; wrapper stdout then recorded `SINGLE_CONVERSATION_BLOCKED_PAUSE=True`. Root cause was narrower than general autostart: `safeRebindOutboundState()` did not permit `ENQUEUED + SOURCE_OF_TRUTH_TASK_DISCOVERY + SEND_NOT_ACTUATED`, so exact runtime-identity recovery returned before Recent/Sidebar/Chrome-History lookup and before the existing exact-once reconciler could decide delivered versus positive non-delivery. PR #290 adds only this exact recovery gate (`ACTIVE`, `ENQUEUED`, `SOURCE_OF_TRUTH_TASK_DISCOVERY`, `SEND_NOT_ACTUATED`, `retry_count<1`), reconstructs the exact discovery message from durable message id/SOT/digest, and delegates all resend authority to the existing exact-once reconciler. Matching user-turn evidence remains `NO_SEND`; only positive non-delivery may consume the one safe retry; ambiguous evidence remains fail-closed. All mandatory hosted gates passed and explicit deploy commit `3df8fb63a3f405ea339bb9a9f68e6e90dce400bb` installed the fix on `DESKTOP-4K7IM13` with `TARGET_MATCH=True`. Live observer run `37040890729` is pre-armed on runner `DESKTOP-4K7IM13`; the repair is DEPLOYED but awaiting one manual Owner START for live qualification.
- on 2026-10-03 under renewed Owner delegation, live attempt `37089307402` auto-STARTed the canonical Robot on `DESKTOP-4K7IM13` but failed at `SEND_WORK` for `TASK_EXECUTION` message `4129456d-b3d8-4420-96b9-43988924c002`: durable state remained `ENQUEUED`, first failure became `AMBIGUOUS_ENQUEUED_OUTCOME`, and the wrapper paused as technical `BLOCKED`. The Owner-visible assistant response for that exact message already contained a complete `MAGASIN_TASK_CONTROL_V1` block with `STATUS=RUNNING`, `TASK_ID=SCHED-UI-012`, `CHECK_AFTER_SECONDS=180`, and the exact `MAGASIN_CYCLE_CORRELATION_V1 4129456d-b3d8-4420-96b9-43988924c002`, proving ChatGPT had accepted the request and produced a correlated response even though restart reconciliation could not positively match the user-turn text. PR #295 therefore adds a narrow restart-only positive-delivery rule for `TASK_EXECUTION` / `TASK_STATUS_CHECK`: if the latest assistant turn contains the exact cycle-correlation marker for the current message id, persist the outbound as delivered with no resend and settle the existing response; if absent, the existing exact-once reconciler remains unchanged and fail-closed. All four hosted gates passed, explicit deploy `d34225269f8014eb509fbf18e4918562f857de5f` installed the fix on `DESKTOP-4K7IM13` with `TARGET_MATCH=True`, and live observer `37091986109` is currently in progress on runner `DESKTOP-4K7IM13` under the active Owner delegation for post-fix qualification.
- the post-#295 live qualification run `37091986109` subsequently passed the previously stuck outbound, kept generation 16 stable, recorded zero duplicate send attempts, completed two subsequent verified cycles, and still had wrapper/Chrome/CDP healthy at the observer exit. A later technical stop was then captured by watchdog run `37099039815` on `DESKTOP-4K7IM13`: `owner_stop=false`, `wrapper_alive=false`, `cdp_healthy=false`, local watchdog heartbeat fresh, durable state still `RUNNING / NEXT_WORK / VERIFIED`, outbound `SOURCE_OF_TRUTH_TASK_DISCOVERY` message `bd500763-de32-45a1-ad68-12886b95731b`, and wrapper stderr `TASK_PROTOCOL_INVALID` followed by `PAUSED autonomy; closing dedicated Chrome`. This re-opened Phase A at task-control parsing after a verified discovery response. The parser already tolerated collapsed line breaks but did not normalize presentation-only zero-width characters or NBSP that ChatGPT UI can introduce. PR #296 therefore adds only pre-parse normalization for known zero-width formatting characters and NBSP while retaining the existing canonical/rendered-whitespace block rules, status semantics, and free-prose rejection. All four hosted gates passed; explicit deploy `363c080e3ea172d57e15c8e3d3050ecfccdd0c1a` installed the fix on `DESKTOP-4K7IM13` with `TARGET_MATCH=True`. Live observer `37099444506` is currently running on runner `DESKTOP-4K7IM13` under active Owner delegation and has entered the real production first-failure step for the post-fix rerun.
- post-#296 live run `37099444506` proved zero-width/NBSP normalization was still insufficient. A fresh discovery message `7cc8e497-c6d7-4e67-a38c-ecc5fd44d267` progressed through `PREPARED -> ENQUEUED -> DELIVERED -> RESPONSE_RUNNING -> VERIFIED / NEXT_WORK`, but no next durable transaction appeared before the 240-second observer threshold. Follow-up watchdog run `37102894273` on `DESKTOP-4K7IM13` then proved the wrapper and CDP were actually down with `owner_stop=false`, durable state still `RUNNING / NEXT_WORK / VERIFIED`, and wrapper stderr still `TASK_PROTOCOL_INVALID`; therefore the apparent `NEXT_WORK / NO_PROGRESS_TIMEOUT` was downstream evidence of a parser-triggered PAUSED exit, not a legitimate native timer. PR #297 adds one further strict parser fallback for a ChatGPT DOM representation that collapses machine-field boundaries with no whitespace at all. That fallback accepts only the exact header/footer, exact field order (`STATUS`, `TASK_ID`, `NEXT_TASK_ID`, `CHECK_AFTER_SECONDS`), existing task-id syntax, and no extra prose; canonical newline and rendered-whitespace parsers remain preferred. All four hosted gates passed; deploy request commit `a08393499d7e2e50f752046e487cfd72257d406e` successfully installed requested main `1b967f4aa3b965a571950e46d84811ed1a7a678e` on `DESKTOP-4K7IM13` with `TARGET_MATCH=True`. Live observer `37103200546` is currently `in_progress` on runner `DESKTOP-4K7IM13` under active Owner delegation for the real post-fix rerun.
- the post-#297 live run `37103200546` again reached a fresh `SOURCE_OF_TRUTH_TASK_DISCOVERY` transaction `1fe007da-e157-4beb-984c-75dccc3635b7` through `PREPARED -> ENQUEUED -> DELIVERED -> RESPONSE_RUNNING -> VERIFIED / NEXT_WORK`, then failed the observer at `NO_PROGRESS_TIMEOUT / NEXT_WORK`. A fresh watchdog sample `37108039099` on `DESKTOP-4K7IM13` proved this was still a downstream parser exit: `owner_stop=false`, wrapper/CDP down, durable state still `RUNNING / NEXT_WORK / VERIFIED`, and wrapper stderr `TASK_PROTOCOL_INVALID` followed by PAUSED autonomy. Because successive presentation-tolerance guesses had not identified the exact parser branch, PR #298 adds diagnostic-only structured subreason telemetry derived exclusively from static internal parser error messages (`MISSING_BLOCK`, `MALFORMED_FIELD`, status/field-contract reasons, etc.) without logging assistant/chat content. All four hosted gates passed; explicit deploy `911fd74a0128c41c515fdcdda808b64836048cb5` installed requested main `9384014671f84ad6db240ad690abe6989a2dddbf` on `DESKTOP-4K7IM13` with `TARGET_MATCH=True`. Live observer `37108342770` later completed with `NO_PROGRESS_TIMEOUT / NEXT_WORK`. Target-valid watchdog run `37112503567` on `DESKTOP-4K7IM13` then read the installed wrapper stderr and captured the exact structured subreason: `SINGLE_CONVERSATION_RUNTIME_ERROR=TASK_PROTOCOL_INVALID` with `SINGLE_CONVERSATION_TASK_PROTOCOL_REASON=BLOCKED_HAS_NEXT_TASK`; durable state was still `RUNNING / NEXT_WORK / VERIFIED`, outbound kind `SOURCE_OF_TRUTH_TASK_DISCOVERY`, Owner STOP was false, and wrapper/CDP were down. The active project SOT was legitimately at `SCHED-UI-016 = BLOCKED / OWNER REVIEW REQUIRED / NEXT AUTHORITATIVE GATE`, so the first failing boundary was no longer unknown presentation parsing: the discovery answer represented the blocked gate in `NEXT_TASK_ID`, while the Supervisor protocol required BLOCKED to carry no `NEXT_TASK_ID`. PR #299 applies the conservative repair: BLOCKED remains non-executable, a legacy blocked gate advertised in `NEXT_TASK_ID` is promoted to `TASK_ID` when needed and `NEXT_TASK_ID` is cleared, and generated discovery instructions explicitly require `BLOCKED => TASK_ID=<blocked gate or NONE>, NEXT_TASK_ID=NONE` and reserve BLOCKED for the case where no executable task can proceed without Owner input. Focused regression coverage was added. PR #299 passed all four mandatory gates, merged as `a6ec370203dbef4505f7fba5b4be585e924d97b0`, and explicit deploy run `37112909724` installed deploy-request main `075d354524a228a37feb31e43dde58e69d85a591` on `DESKTOP-4K7IM13` with `TARGET_MATCH=True`, `CANONICAL_RUNTIME_REPLACED=True`, and the local watchdog running. Pre-live review then exposed the next lifecycle defect without another speculative production attempt: a correctly parsed `BLOCKED` control caused `runSingleConversationRuntime()` to return `WAIT_OWNER` but did not persist that terminal authority, leaving durable state as `RUNNING / NEXT_WORK / VERIFIED`; the watchdog would therefore misclassify the expected wrapper stop as a technical wrapper/CDP failure. PR #300 repairs that boundary by durably persisting a verified Owner gate as `automation=BLOCKED`, `phase=WAIT_OWNER`, `reason=OWNER_INPUT_REQUIRED:<gate>`, persisting project completion separately as `DONE`, and teaching the target observer/watchdog to accept only the strict combination `BLOCKED + WAIT_OWNER + OWNER_INPUT_REQUIRED* + outbound VERIFIED` as a legitimate terminal Owner gate. This does not authorize later work and does not weaken exact-once semantics.

- on 2026-10-04 the Owner directly observed the active Robot chat reach ChatGPT's conversation-length/full boundary after the Robot had already sent a task request and ChatGPT had begun executing it. The assistant response could not complete, and the Robot transitioned to a stopped state instead of rolling over automatically. The code boundary explains the stop: `waitForSingleConversationResponse()` throws `CONVERSATION_FULL` from the live UI snapshot; the cycle failure path persists a technical failure, while restart rollover previously allowed `CONVERSATION_FULL` automatically only for already settled `RESPONSE_COMPLETE/VERIFIED` outbound work. Replaying the interrupted `TASK_EXECUTION` is unsafe because side effects may already have occurred, but stopping for Owner input is also unnecessary because the authoritative task and durable project evidence remain recoverable. Canonical recovery for an in-flight task full-chat boundary is therefore: retire only the disposable full conversation, create a fresh chat and bootstrap from SOT, preserve the interrupted task identity in recovery evidence, never resend the old execution message, then issue `MAGASIN_CHECK_TASK_V1` for the same authoritative task so the new conversation reconciles completed/partial/external work from durable evidence and continues from the correct task/checkpoint.
- on 2026-10-04 immediately after the in-flight full-chat repair was deployed, the Owner correctly reported that production still had not escaped the full-chat incident. Read-only target evidence from watchdog run `37195878341` on `DESKTOP-4K7IM13` showed the wrapper and CDP alive, but durable state was still `RUNNING / STARTING_BROWSER` with an old `ENQUEUED SOURCE_OF_TRUTH_TASK_DISCOVERY` message `0eb22aa3-f81e-46d0-9a06-fd698f4bf83f` more than 2,300 seconds old. The persisted runtime identity was absent from open pages; ChatGPT had only a blank home page open; Recent contained exactly one URL matching the old opaque identity, but reusable rebind returned false; wrapper stderr repeatedly reported `RUNTIME_RESTART_IDENTITY_NOT_VERIFIED`. This is a separate recovery gap from in-flight `TASK_EXECUTION`: task discovery is read-only and has no project side effects, so fail-closed identity loss is unnecessary. The same watchdog also proved the Control Center was misleading because stale `external_work.decision=WAIT_EXTERNAL` from OPS-074 overrode the current `STARTING_BROWSER` phase, showing an old CI as if it were the live blocker. Canonical repair: if a read-only discovery/next-work transaction is ENQUEUED/DELIVERED/RESPONSE_RUNNING and its conversation cannot be rebound after the bounded identity search, retire that disposable chat and bootstrap a fresh generation from the same SOT without Owner input; if `CONVERSATION_FULL` occurs while discovery is waiting for its response, perform the same replacement immediately. Owner UI may display external CI state only when the current automation phase is actually the matching external phase.
- on 2026-10-04 the next real-target SC-013 iteration exposed a distinct SEND_WORK failure while OPS-074 was executing checkpoint `074-C04`. Live run `37192774300` on `DESKTOP-4K7IM13` advanced the same `OPS-074` task through multiple verified cycles, created the C04 branch/PR, and tracked Scaffold CI run `37193639863`. A later discovery transaction `0eb22aa3-f81e-46d0-9a06-fd698f4bf83f` reached `ENQUEUED`, then the runtime persisted `BLOCKED / SEND_WORK / SEND_NOT_ACTUATED` because the composer had transitioned but the matching rendered user turn was not observed within the sender's short verification window. Target-valid watchdog run `37193956205` attempt 4 proved `owner_stop=false`, `wrapper_alive=false`, `cdp_healthy=true`, exact durable outbound `ENQUEUED / SOURCE_OF_TRUTH_TASK_DISCOVERY`, and wrapper stderr `composer transitioned but a matching new user turn was not observed`. The same read-only probe then observed the exact runtime page healthy with `response_running=true`, empty composer, and no auth/network error, proving submit actuation had actually occurred and ChatGPT was processing the request. The existing transaction layer already supported `POST_SEND_CONFIRMATION_PENDING`, but the shared UI sender incorrectly converted this positive submit-transition + delayed-user-turn condition into `executed=false / SEND_NOT_ACTUATED` before the transaction layer could enter correlated-response recovery. The canonical repair is an explicit opt-in sender result for confirmed submit transition with pending user-turn evidence; only the exact-once transaction path may opt in and convert it to durable `POST_SEND_CONFIRMATION_PENDING / WAIT_RESPONSE`. Default direct sender callers remain strict and still reject composer-clear-only evidence.
- on 2026-10-04 after OPS-074 advanced into checkpoint `074-C03`, Scaffold CI run `37190492508` for commit `e9659c25535f4ba68e899b26278c6618a06427d7` completed `success`. The Control Center then showed the Robot stopped with CDP disconnected while the durable project state still expected autonomous continuation. Target-valid watchdog run `37192168875` (attempt 2 on `DESKTOP-4K7IM13`) proved `owner_stop=false`, `wrapper_alive=false`, `cdp_healthy=false`, local watchdog fresh, durable `automation=RUNNING / phase=NEXT_WORK / outbound=VERIFIED`, and outbound kind `SOURCE_OF_TRUTH_TASK_DISCOVERY` for message `8903ab33-5938-48f0-9297-25a4c9d76113`. Wrapper stderr identified the current first failure as `TASK_PROTOCOL_INVALID` with `SINGLE_CONVERSATION_TASK_PROTOCOL_REASON=MALFORMED_FIELD` and message `malformed task-control line`. The correlated assistant response is semantically valid and contains exactly `STATUS=READY`, `TASK_ID=NONE`, `NEXT_TASK_ID=OPS-074`, `CHECK_AFTER_SECONDS=0`; therefore this is a rendered-presentation parser defect, not a project/CI/Owner block. The bounded repair is to tolerate presentation-only whitespace around `=` in the fixed four-field task-control schema while continuing to reject prose, extra fields, reordered fields, invalid values, and missing header/footer.
- the rendered-equals parser repair was merged in PR #308 as `6f6dc1287305b47a9c2abf389d456fc4041a1ea6`; all four mandatory hosted gates passed. Explicit deploy run `37192564989` attempt 3 ran on `DESKTOP-4K7IM13`, reported `TARGET_MATCH=True` and `CANONICAL_RUNTIME_REPLACED=True`. The re-armed live production run `37192774300` then resumed the stopped Robot without manual Owner START under the active delegation. Production OPS evidence proves forward progress: commit `838a9417b50b2c2be0a163435a6e2f54eabc8990` recorded `074-C03` DONE after Scaffold CI `37190492508` success and advanced the project SOT to `CURRENT_CHECKPOINT=074-C04`. This proves the current `MALFORMED_FIELD` stop is repaired on the real target and the Robot can continue the same authoritative `OPS-074` task.
- on 2026-10-04 the Owner corrected the recovery evidence for the OPS-074 incident: after the Robot stopped at `BLOCKED / SEND_WORK` with `EXACT_ONCE_FAILED`, `ENQUEUED_STALLED`, and `WRAPPER_NOT_ALIVE`, the Robot did **not** restart itself; the Owner manually pressed START. The ChatGPT response for transaction `1514ef60-a01a-466f-8c7c-085242aeee6f` already contained the exact `MAGASIN_CYCLE_CORRELATION_V1` marker and valid `STATUS=RUNNING / TASK_ID=OPS-074 / CHECK_AFTER_SECONDS=120`. After manual START, existing restart reconciliation safely recovered that same message as `VERIFIED` with `retry_count=0`. This proves restart recovery is safe but the live process is still converting a short post-submit rendered-user-turn evidence gap into a technical BLOCKED boundary too early. The current first-failure repair is therefore narrower than generic auto-restart: after browser submit is positively actuated, the same runtime must remain `RUNNING / WAIT_RESPONSE` under a durable no-resend `POST_SEND_CONFIRMATION_PENDING` marker and wait for the exact correlated assistant response. A restart encountering that marker remains fail-closed and cannot resend; only the existing exact correlated-response or positive non-delivery rules may resolve the transaction.
- on 2026-10-04 the post-CI-recovery live qualification run `37181630729` exposed the next independent first failure before the external-run state machine could be exercised. The production target had one ACTIVE conversation with a prior `TASK_EXECUTION` message `f94074e8-c75d-44e5-bc19-a5645aca10a7` already durably `DELIVERED`; read-only UI evidence showed the exact runtime page healthy and the assistant response complete, while wrapper stderr repeated `RUNTIME_RESTART_WAIT_RESPONSE_UNRESOLVED: pending TASK_EXECUTION response has no exact restart reconstruction`. The runtime had been hotpatched after that task was sent, so rebuilding the historical prompt with the new external-run contract produced a different digest even though the original request was already delivered and its assistant response was present. The observer therefore remained at `STARTING_BROWSER` until `OBSERVATION_TIMEOUT`. The repair is correlation-first and no-resend: for an already `DELIVERED/RESPONSE_RUNNING` `TASK_EXECUTION` or `TASK_STATUS_CHECK`, an assistant turn containing the exact current `MAGASIN_CYCLE_CORRELATION_V1 <message_id>` may settle that already-delivered transaction directly to VERIFIED without reconstructing the historical prompt text. This authority cannot send, retry, or apply to an unmatched id/kind/state.

- production evidence after the CI auto-recovery repair confirms the requested terminal-failure loop is no longer theoretical. Supervisor repair PR #305 merged as `22fa6a53945d4448c452550f65400f3ad1c8b0cb`; all four mandatory hosted gates passed and explicit deploy request `aad1266a08cdd99a3976c142aabe2f4a84e45d65` installed the runtime on `DESKTOP-4K7IM13`. The failed OPS-074 Database Migrations CI run `37167270115` was not polled indefinitely: the Robot produced concrete repair commit `90123538a597d76fcaaccbb4cc55886a9e1ccd3f`, which triggered fresh Database Migrations CI run `37181157340` and that run completed `success`; Scaffold CI `37181157347`, Public Repository Scrub `37181157366`, and OPS Source Export `37181157355` also completed successfully on the same commit. After the subsequent restart-continuity repair PR #306 (`414cfea6f7a373fe321ab7754c78803b0982fab6`) was deployed, the live Robot resumed the same authoritative `OPS-074` task and committed `5e8cdf5a4e615e695cff9c45919ba93d60d71fdb`, recording `074-C01` DONE and advancing the OPS SOT to `CURRENT_CHECKPOINT=074-C02`. This is concrete production proof of `completed+failure -> AUTO_REPAIR -> new commit -> new CI -> success -> verify/update SOT` without changing the parent task ID or waiting again on the failed run.

- on 2026-10-04 a second OPS-074 production incident exposed an external-run state-machine defect independent of browser delivery. Database Migrations CI run `37167270115` for commit `7ca5f478eab3a2d09b8c5400e5217bef3821579e` was definitively `status=completed`, `conclusion=failure`, but the Robot kept returning `STATUS=RUNNING / TASK_ID=OPS-074 / CHECK_AFTER_SECONDS=120` based on the weaker condition “no fresh PASS yet”. The failed job was `migration-smoke`; logs proved three concrete failure classes: `print_job_tracking()` hit `permission denied for view production_print_job_queue`, OPS-042 reported `completed job leaves active mobile work queue` with `have: 1 / want: 0`, and `ops_074_production_drift_repair.test.sql` failed with SQL syntax at `$select`. The OPS SOT subsequently recorded `CURRENT_CHECKPOINT=074-C01` as `REPAIR_REQUIRED`. This establishes the canonical rule that absence of PASS is not evidence of an active run; terminal failure must return the same authoritative task to AUTO_REPAIR rather than another wait interval.
- on 2026-10-05 the Owner again observed a real production Robot remain visibly `RUNNING` for roughly two hours at Control Center phase `R2 / STARTING_BROWSER — Đang kết nối Chrome / phục hồi cuộc chat`. The same screen reported `CHROME/CDP: KẾT NỐI`, `WATCHDOG: BÌNH THƯỜNG`, conversation generation `2` as active, Source of Truth verified, and no recorded error, while no prior chat was restored and no forward task progress occurred. This is positive evidence of a liveness-without-progress defect: startup restart recovery can block inside an unbounded read-only ChatGPT probe/enumeration even though the wrapper process and CDP socket remain alive, so the watchdog incorrectly classifies the runtime as healthy. The canonical repair is to bound every startup rebind read-only probe (reusable-page snapshot, Recent enumeration, browser-history enumeration, and old-page restart probe); a timeout is evidence that the old disposable conversation is not reusable, not evidence of project failure. If the durable outbound transaction is already `RESPONSE_COMPLETE` or `VERIFIED`, it is replay-safe to retire that chat and bootstrap a fresh generation from the same SOT. In-flight task work remains exact-once/fail-closed and must not be replayed by this rule.
- after PR #314 merged and its bounded `STARTING_BROWSER` recovery was explicitly deployed to `DESKTOP-4K7IM13`, deploy run `37290365859` attempt 4 completed `success` on the exact target with wrapper alive, CDP healthy, and local watchdog restarted. The first post-deploy sample still observed `RUNNING / STARTING_BROWSER` for about 80 seconds; after the new 180-second liveness threshold, target watchdog attempt 2 on run `37291308944` correctly changed from false HEALTHY to `FAULT` with `LOCAL:STARTING_BROWSER_STALLED:310`. The same read-only diagnostic proved the persisted runtime identity matched the one open ChatGPT conversation exactly, Recent contained exactly one matching URL, `resumeExistingConversationPage` returned `recovered_from=OPEN_PAGE`, and the direct ChatGPT probe was `READY_IDLE / RESPONSE_COMPLETE` with an empty readable composer. Therefore restart rebind itself was no longer the first failing boundary. Wrapper evidence then exposed the next first failure: `SINGLE_CONVERSATION_RUNTIME_ERROR=EPERM` while renaming a private `single-conversation-state.json.tmp.<pid>.<uuid>` snapshot over `single-conversation-state.json` on Windows. Because durable state could not advance after the already-complete assistant response, the runtime remained visibly stuck at `STARTING_BROWSER`; a later response timeout is downstream. The bounded canonical repair is to retry only transient Windows atomic-rename sharing failures (`EPERM`, `EACCES`, `EBUSY`) with short bounded backoff while retaining the same private temp file and never deleting the durable destination as a workaround.
- on 2026-10-05 after the Windows atomic-rename retry repair was explicitly deployed, deploy run `37291991490` attempt 9 again completed `success` on `DESKTOP-4K7IM13`. A fresh target watchdog sample at `2026-10-05T10:13:12Z` proved wrapper alive, CDP healthy, local watchdog healthy, automation still `RUNNING / STARTING_BROWSER`, and the same `TASK_STATUS_CHECK` transaction `cf3f6af3-967a-4788-8374-1b836437a334` still `DELIVERED` with `retry_count=0`. Earlier read-only UI evidence for that exact conversation proved `READY_IDLE / RESPONSE_COMPLETE`, exact runtime identity match, empty readable composer, and one assistant turn, but `ASSISTANT_MARKER=false`. Therefore the current first failure is now narrower: restart recovery waits for the requested `MAGASIN_CYCLE_CORRELATION_V1` marker for the full response timeout even when the exact already-delivered task user turn is still present and the assistant reply is stably complete with a valid machine task-control block. The canonical repair must remain no-resend and proof-gated: on the exact rebound conversation, only a stable idle assistant turn observed twice, an exact matching historical user turn for the reconstructed durable message, an empty readable composer, no running/busy/error/Continue state, and a strict task-control block that refers to the same authoritative task (or valid project DONE) may settle that in-flight task to VERIFIED when only the correlation trailer is missing. Any ambiguity remains on the existing marker/fail-closed path.
Canonical fix:
1. forward production MUST use only `SINGLE_CONVERSATION_V1`; obsolete Planner/Executor/Brain/Bridge qualification or cutover workflows MUST NOT auto-run from `main` or consume the production target;
2. legacy source may remain only as inert historical/rollback reference where still needed, but active GitHub Actions orchestration for the superseded architecture must be removed from `.github/workflows`;
3. contenteditable composer verification MUST use rendered-equivalent text identity for current ChatGPT ProseMirror while retaining strict durable message digests for exact-once transaction authority;
4. an `ENQUEUED` transaction with no delivered user turn may resume only when exact or rendered-equivalent evidence proves the live draft belongs to the same Robot message;
5. successful safe reconciliation MUST clear transient `BLOCKED` state and return automation to `RUNNING`;
6. final acceptance requires real target evidence on `DESKTOP-4K7IM13` that the blocked outbound is either safely delivered or safely reconstructed, a matching user turn appears, a response completes, and at least two subsequent task-control cycles continue in the same active conversation without duplicate sends or legacy workflow interference.
7. ordinary source, test, documentation, or Windows launcher merges MUST be CI-only and MUST NOT automatically replace the installed production runtime, stop the dedicated Chrome, stop the wrapper, or restart the Control Center;
8. production deployment to `DESKTOP-4K7IM13` MUST require explicit release authority through `workflow_dispatch` or a dedicated `.github/production-deploy-request.json` marker commit. Each workflow run creates exactly one self-hosted mutation-capable job and the in-job `%COMPUTERNAME%` guard is authoritative. If GitHub schedules that job on any non-target runner, the job MUST emit `TARGET_MUTATION_SKIPPED=True`, perform no production checkout/update, and may dispatch exactly one successor run carrying the same authorized `deploy_sha` plus an incremented routing attempt. Successor runs are serialized by the deploy concurrency group; routing uses bounded 15-60 second backoff and a maximum of 12 attempts. Only `DESKTOP-4K7IM13` may pass the guard and deploy. Exhaustion MUST fail terminally instead of looping. Runner-label administration is not an assumed capability because repository `GITHUB_TOKEN` cannot access the self-hosted-runner management API in the current installation;
9. deployment and read-only diagnosis are separate lifecycle operations: because installation may intentionally close dedicated Chrome, the deploy workflow MUST NOT immediately run a CDP-dependent SC-013 diagnostic and misclassify the expected post-install browser absence as a deployment failure.
10. prepared-bootstrap non-delivery recovery MUST use a bounded read-only settle window instead of a single immediate UI sample; recovery authority is granted only after at least two consecutive observations of the same blank-home page with no structured conversation turn, no exact matching bootstrap user turn, and one safe DOM snapshot that proves the composer is present, text-readable, and empty; any ambiguous, unstable, login-required, CAPTCHA, network/transient-error, conversation-path, generating, non-empty, unreadable, or timed-out surface remains fail-closed and MUST NOT authorize a resend.
11. bootstrap empty-draft proof MUST NOT perform a second Playwright composer-locator traversal after the safe page snapshot. The same DOM snapshot that proves composer readiness MUST also expose only privacy-safe draft evidence (`composerTextReadable`, `composerHasText`, `composerTextCharCount`). Watchdog/probe code MUST NOT convert an unreadable or timed-out draft into `draft_has_text=false`; unreadable draft evidence is null/unknown and cannot authorize recovery.
12. live first-failure observation MUST be pre-armed before START and MUST run exactly one production attempt per observation request. Manual Owner START remains the default. During a valid time-bounded Owner delegation, the pre-armed observer may invoke the canonical START script on the exact delegated target, then continue the same first-failure observation. A failed attempt ends that observation run so the proven first failing stage can be repaired before a new attempt is armed.
13. prepared-bootstrap non-delivery proof MUST NOT use heuristic `userMessageCount/assistantMessageCount == 0` as resend authority because current ChatGPT home UI can expose message-like text surfaces that are not persisted conversation turns; safe recovery instead requires a stale durable `PREPARED` bootstrap (minimum 60 seconds), blank home path, no structured `conversation-turn-*` elements, no exact matching bootstrap user turn, a ready empty composer, no response/error/auth ambiguity, and the existing consecutive-positive settle requirement.
14. the startup non-delivery settle budget is 90 seconds on the production path; extending this time budget does NOT relax resend authority. The same two consecutive positive observations and all exact-turn/structured-turn/draft/auth/error checks remain mandatory. Runtime telemetry MUST record the negative sample reason and a settle-timeout marker so a later failure identifies the exact gate instead of collapsing to an opaque `UNVERIFIED` result.
15. bootstrap delivery verification MUST distinguish full-text presentation identity from protocol correlation identity. If a persisted user turn uniquely contains `MAGASIN_SINGLE_CONVERSATION_BOOTSTRAP_V1`, the current `id=<message_id>`, the current SOT URL, that single correlated user turn is positive delivery evidence even if ChatGPT has introduced a presentation-only text mutation. When durable state is still `PREPARED / SEND_NOT_ACTUATED`, restart reconciliation MUST first search read-only for exactly one such correlated bootstrap conversation; if found, it MUST persist `DELIVERED`, bind the conversation runtime identity, clear transient `BLOCKED`, and observe the existing assistant response without actuating the composer. Zero matches remains fail-closed; multiple matches are ambiguous and MUST NOT authorize reconciliation or resend.
16. correlated-bootstrap restart reconciliation MUST search currently open ChatGPT tabs first and, when no unique match is found, boundedly search ChatGPT Recent/Sidebar conversation URLs. Recent candidates may require UI hydration before their user turn is observable; recovery may reopen them read-only, wait within a bounded hydration window, require the same exact bootstrap correlation identity and healthy conversation surface, close non-matches, and keep only the single unique match. This recovery path MUST NOT type, submit, or create a new bootstrap.
17. cold-start Recent/Sidebar discovery is itself a bounded hydration condition: reconciliation MUST re-enumerate Recent for multiple bounded passes, scan only newly observed runtime identities, and preserve unique-match fail-closed semantics across all passes. If a candidate already exposes one or more readable user turns but none matches the current bootstrap correlation identity, that candidate is a proven hydrated non-match and MUST be rejected immediately rather than consuming the remaining hydration wait.
18. when an already-settled active conversation has a persisted opaque runtime identity but neither open tabs nor bounded Recent/Sidebar hydration exposes its URL after restart, recovery MAY use the dedicated local Chrome History as a read-only final identity source. The runtime MUST discover only ChatGPT conversation URLs, compute their opaque identities in memory, require exactly one match to the persisted runtime identity, reopen only that exact match, and close the temporary history surface. Zero or multiple matches remain fail-closed. Browser-history recovery MUST NOT read or persist conversation text and MUST NOT type, submit, create a new conversation, or authorize a resend of settled work.
19. task-control parsing MUST distinguish protocol semantics from ChatGPT Markdown presentation. The canonical newline-delimited `MAGASIN_TASK_CONTROL_V1` block remains preferred, but if the captured assistant `innerText` has collapsed those visible line boundaries into whitespace, a rendered-whitespace fallback MAY parse the block only when the exact header/footer are present and the enclosed content consists exclusively of machine `KEY=VALUE` tokens. Free prose inside the block remains invalid; a valid rendered `READY` block MUST NOT be converted into exit-76 `TASK_PROTOCOL_INVALID` or an Owner pause.
20. restart identity recovery MUST be allowed to bind the exact prior conversation for an `ENQUEUED SOURCE_OF_TRUTH_TASK_DISCOVERY` that failed with `SEND_NOT_ACTUATED` and has not consumed its single retry budget. Rebinding itself is read-only and grants no resend authority. After rebind, only the existing exact-once reconciler may classify the transaction: matching user-turn evidence means delivered/no resend; positive non-delivery may authorize the one safe retry; ambiguous evidence remains fail-closed. This narrow recovery state MUST NOT be generalized to unrelated ENQUEUED failures without new live evidence.
21. for restart reconciliation of an `ENQUEUED TASK_EXECUTION` or `TASK_STATUS_CHECK`, an assistant turn containing the exact `MAGASIN_CYCLE_CORRELATION_V1 <current message_id>` is positive delivery evidence that the request reached ChatGPT, even when user-turn presentation/text capture cannot be matched. This evidence MUST suppress resend, persist the transaction as delivered, and continue settling the existing correlated response. Absence of the exact marker grants no new send authority; the normal exact-once reconciler remains fail-closed.
22. task-control parsing MUST normalize only presentation-only invisible characters known to be introduced by rendered ChatGPT text before applying the existing strict block parser: zero-width formatting characters (`U+200B`-`U+200F`, `U+2060`, `U+FEFF`) are removed and NBSP (`U+00A0`) is normalized to an ordinary space. This normalization MUST NOT relax allowed statuses, task-id validation, `CHECK_AFTER_SECONDS`, header/footer boundaries, or free-prose rejection.
23. if rendered ChatGPT DOM collapses all task-control field boundaries without preserving whitespace, parsing MAY use a final compact-schema fallback only when the exact `MAGASIN_TASK_CONTROL_V1` header/footer and the exact ordered fields `STATUS`, `TASK_ID`, `NEXT_TASK_ID`, and `CHECK_AFTER_SECONDS` can be recovered with the existing value constraints and with no unrecognized content inside the block. This fallback MUST NOT infer missing fields, reorder fields, accept free prose, or relax any semantic validation.
24. after a fresh protocol send reports positive browser submit actuation, failure to immediately re-read the rendered matching user turn MUST NOT by itself set `automation.status=BLOCKED` or require another Owner START. The runtime MUST durably keep the same `ENQUEUED` transaction as `RUNNING / WAIT_RESPONSE` with `POST_SEND_CONFIRMATION_PENDING`, perform observation only, and wait for the exact correlated assistant response through the normal bounded response path. This pending marker is explicitly **no-resend authority**: if the process restarts before correlation is proven, reconciliation MUST treat it as an ambiguous prior send and MUST NOT actuate the composer again unless the existing positive non-delivery proof independently authorizes the single safe retry. Watchdogs MUST treat this bounded correlated-response wait as active work rather than `ENQUEUED_STALLED`.
25. external CI/deployment/job state MUST be classified from its actual `status` and `conclusion`, never from “PASS not seen”. Only `queued/pending/requested/waiting/in_progress` may authorize `STATUS=RUNNING` plus a timer. `completed+success` must enter verify/advance; `completed+failure` must enter AUTO_REPAIR for the same authoritative SOT task; `completed+cancelled/timed_out/action_required` must be classified for safe retry/repair and may block only when genuine Owner input is required; `not_found` must trigger workflow/path-filter diagnosis rather than a wait.
26. every external-run observation used for RUNNING/repair authority MUST be represented in a machine-readable `MAGASIN_EXTERNAL_RUN_V1` block and persisted into the additive `external_work` runtime record. If a task already has durable external-run tracking and a later assistant response again says RUNNING without fresh external-run evidence, the Supervisor MUST NOT restart a timer; it must return the same authoritative task to execution to refresh/repair/trigger concrete evidence.
27. terminal external failure recovery is bounded. The same completed `workflow_run_id` may be re-read for evidence but MUST NOT be polled as RUNNING. A repeated identical `failure_signature` permits at most three repair attempts. A repair turn counts as progress only when it produces a code/file change reflected by a new action/evidence token, a new commit SHA, a new workflow run, or other durable evidence; repeated execution with the same terminal run/commit/action consumes the repair budget. After the limit, persist a bounded history of attempted run IDs/commit SHAs and enter `WAIT_OWNER` with an exact Owner-facing reason.
28. external-work recovery MUST survive Robot/process/conversation restart without changing the authoritative task. `task_id` remains the SOT task ID (for the current regression, `OPS-074`); checkpoint IDs such as `074-C01` are internal evidence only. Restart must restore the current run/commit/failure signature/repair attempt and continue the same WAIT/REPAIR/VERIFY decision without rediscovering a different task.
29. restart recovery of an already `DELIVERED` or `RESPONSE_RUNNING` `TASK_EXECUTION` / `TASK_STATUS_CHECK` MUST survive runtime prompt-contract upgrades. If the rebound exact conversation exposes an assistant turn containing the exact persisted `MAGASIN_CYCLE_CORRELATION_V1 <message_id>`, that correlation is positive response evidence for the already-delivered transaction and MAY advance it directly to `VERIFIED / NEXT_WORK` without rebuilding the historical outbound prompt. This correlation-first path is strictly observation-only: it MUST NOT actuate the composer, retry, change message id, accept a different task kind/state, or bypass correlation matching. If the exact marker is absent, the existing reconstruction/fail-closed recovery remains authoritative.
30. task-control parsing MUST treat whitespace immediately around the equals delimiter as presentation-only for the fixed canonical fields. Both newline-preserved and rendered-whitespace forms MAY accept `STATUS = READY`, `TASK_ID = NONE`, `NEXT_TASK_ID = OPS-074`, and `CHECK_AFTER_SECONDS = 0` only when the exact header/footer and existing value constraints are preserved. This tolerance MUST NOT accept prose, extra fields, reordered fields, multi-token values, or weaken status/task/count semantics.
31. the shared composer sender MUST distinguish "submit was not actuated" from "submit transition was positively observed but the matching rendered user turn is still hydrating". By default, missing matching user-turn evidence remains strict `SEND_NOT_ACTUATED`. Only when an exact-once caller explicitly opts into pending post-send confirmation may a confirmed composer transition return positive submit actuation with `user_turn_pending=true`; the transaction layer must then keep the same message `ENQUEUED`, persist `POST_SEND_CONFIRMATION_PENDING`, enter `RUNNING / WAIT_RESPONSE`, and settle only from the exact matching user turn or exact cycle-correlation assistant response. This opt-in cannot mark `DELIVERED`, cannot authorize a second send, and cannot be used by bootstrap/direct callers that lack the correlated exact-once recovery contract.
32. `CONVERSATION_FULL` during an already in-flight authoritative task MUST NOT become an Owner-required stop and MUST NOT replay the prior `TASK_EXECUTION`. When durable outbound kind is `TASK_EXECUTION` or `TASK_STATUS_CHECK`, task_id is present, and outbound state is `ENQUEUED`, `DELIVERED`, or `RESPONSE_RUNNING`, the runtime must preserve the interrupted transaction as recovery evidence, retire the full disposable conversation, create a fresh generation, bootstrap exclusively from the same SOT, and issue a new `MAGASIN_CHECK_TASK_V1` for the same authoritative task. That CHECK is the only allowed continuation because it reconciles partial/completed side effects and external runs without duplicating execution. Restart recovery must apply the same rule from durable `last_error_code=CONVERSATION_FULL` even when the old full page is no longer open. Settled `RESPONSE_COMPLETE/VERIFIED` full-chat rollover remains the ordinary SOT rehydration path. Control Center must display this transition as automatic chat replacement/recovery and must not instruct Owner to press START while the wrapper is actively recovering.
33. read-only SOT discovery is disposable with the chat and MUST NOT become a permanent restart identity block. If `SOURCE_OF_TRUTH_TASK_DISCOVERY` or qualification-only `SOURCE_OF_TRUTH_NEXT_WORK` is in `ENQUEUED`, `DELIVERED`, or `RESPONSE_RUNNING` and the prior conversation cannot be rebound after the bounded open-page/Recent/History identity search, the runtime may retire that chat, create a fresh generation, bootstrap from the same SOT, and continue from the bootstrap task-control result. Because these messages perform no project mutation, this replacement does not require proving non-delivery and must not require Owner START. A live `CONVERSATION_FULL` thrown while waiting for a discovery response must use the same replacement path immediately. The Control Center MUST treat `external_work` as subordinate historical evidence: WAIT/REPAIR/VERIFY CI details may override the main Owner-visible phase only when `automation.phase` currently equals the corresponding external phase; stale external state must never hide browser/chat recovery faults. The SC-013 live first-failure observer must accept exactly one generation advance for this proven read-only-discovery recovery class, just as it already accepts the bounded pre-actuation bootstrap replacement; otherwise the qualification harness would falsely report `GENERATION_CHANGED` when production performs the canonical repair.

34. `STARTING_BROWSER` / restart rebind is a bounded recovery phase, not a valid long-running steady state. Read-only page health probes, Recent/Sidebar enumeration, browser-history enumeration, and the final old-page restart probe MUST each have explicit time budgets so a hung Playwright/CDP DOM call cannot leave the wrapper alive indefinitely. When these bounded probes cannot produce one reusable conversation and the durable outbound transaction is already settled (`RESPONSE_COMPLETE` or `VERIFIED` with durable message identity), the Robot MUST retire only that disposable chat, create a fresh generation, bootstrap from the same SOT, and continue without Owner input or replaying settled work. For `PREPARED`, `ENQUEUED`, `DELIVERED`, or `RESPONSE_RUNNING` task mutations, existing exact-once reconciliation remains authoritative; this settled-chat rule MUST NOT authorize a resend. The watchdog/Control Center MUST not report a multi-minute unchanged `STARTING_BROWSER` phase as healthy solely because wrapper and CDP processes are alive.

35. restart recovery for an already `DELIVERED` / `RESPONSE_RUNNING` `TASK_EXECUTION` or `TASK_STATUS_CHECK` MAY settle a completed assistant reply that omitted only the requested cycle-correlation trailer, but only under stronger exact-conversation evidence and without any send authority. The runtime must reconstruct the durable historical task message, positively match that exact user turn on the rebound conversation, observe a safe idle surface with no response-running/assistant-busy/Continue/auth/network/transient/conversation error, require a ready text-readable empty composer, observe the same non-empty assistant turn stably across two bounded samples, and strictly parse a complete `MAGASIN_TASK_CONTROL_V1` block whose task semantics refer to the same authoritative task (or valid project `DONE`). This fallback MUST NOT accept a changed assistant turn, unrelated task ID, incomplete/malformed block, active response, non-empty/unreadable composer, or any ambiguous surface; it MUST NOT type, submit, retry, increment retry count, or create a new message. Exact assistant marker correlation remains the preferred stronger path.

36. production timing uses independent clocks and MUST NOT treat long task duration as a stall by itself. `TASK_ELAPSED` is informational and may reach the full production response budget (currently 90 minutes) or longer when an external durable job has its own state. `NO_PROGRESS_AGE` is the watchdog recovery authority for active work and defaults to 15 minutes of no meaningful monotonic progress; any observed assistant/tool/output progress resets that age. `CHECK_AFTER_SECONDS` is an external-work earliest-recheck deadline and MUST NOT be shortened merely because the chat is replaced. While waiting for that deadline, the runtime MUST perform bounded read-only chat-health probes at a short cadence; `CONVERSATION_FULL`, missing conversation, or another disposable-chat failure may interrupt only the chat surface, create/rehydrate a fresh generation from the same SOT, and then resume the remaining wait. This observed wait MUST NOT send a task CHECK before the original deadline and MUST NOT replay a prior `TASK_EXECUTION`. Control Center must show the latest request-sent time, response-complete time, chat-recovery start/full-detection time, fresh-chat-ready time when available, and the active countdown/recovery age so intentional waiting is visibly distinct from no-progress.

37. Owner-facing Control Center observability MUST use non-overlapping fixed layout regions: timer/countdown and activity milestones are separate controls, and a multi-line milestone summary must never be appended into a single-line timer label. Milestone display should use concise Vietnam-local clock values for latest request delivery, response completion, chat-full/recovery start, and fresh-chat readiness when those timestamps exist. When the only watchdog fault is `CHATGPT_CONVERSATION_FULL`, wrapper is alive, and the runtime is in a bounded chat-recovery phase (`STARTING_BROWSER`, `REPLACE_CHAT`, `NEW_CHAT`, or `BOOTSTRAP_RECOVERY_REQUIRED`), the Owner UI must render `ĐANG PHỤC HỒI CHAT` / recovery-event semantics and explicitly state that Owner action is not required. This presentation rule must not suppress any additional watchdog fault or genuine Owner-required condition.

38. task execution efficiency is an internal runtime policy and MUST NOT change DISCOVER/BOOTSTRAP, EXECUTE, CHECK, COMPLETE/BLOCKED/DONE semantics, the `MAGASIN_*_V1` machine-readable protocol, authoritative SOT task IDs, or required release/exact-main gates. During EXECUTE, the implementation agent MUST inspect changed paths/dependencies, run targeted/impacted QA first, repair targeted failures within the same execution session when safe, collect all currently available failures from a terminal run before editing, group related failures by root cause, and prefer one coherent batch commit at a repair boundary instead of commit/CI per file. Required/full regression is delayed until targeted QA is green or a coherent RC candidate exists, but it remains mandatory before COMPLETE whenever SOT/project policy requires it. Impact uncertainty MUST widen QA rather than reduce it. A stale test may be updated only when current SOT/code contract proves its asserted historical behavior is obsolete; correct product behavior must not be reverted merely to satisfy stale tests. Runtime external-work metadata may additionally persist internal checkpoint, authoritative SHA, current gate/start time, adaptive poll attempt, last result, failure fingerprint/occurrence, batch-failure evidence, repair attempt, loop detection, and bounded obsolete-run history; these fields are execution/recovery metadata only and never replace SOT authority. A newer EXECUTE-reported commit supersedes the older task SHA; CHECK evidence from a different older SHA is OBSOLETE and MUST return the same authoritative task to execution rather than wait. Active external polling is bounded/adaptive (20s -> 30s -> 60s -> 120s cap, while preserving any shorter safe CHECK_AFTER_SECONDS). Same-root failures across repair candidates increment a fingerprint occurrence counter; by the third occurrence the runtime marks a repair loop and requires a changed repair strategy, while the existing bounded repair-limit/Owner-gate semantics remain authoritative. Runtime-state additions MUST default safely when absent, and exact-once recovery MUST reconstruct both the current optimized task prompt and the prior legacy prompt by matching the already-persisted message digest so an upgrade cannot create resend authority.

- on 2026-10-05 the Owner provided a live `XSTORE-019B` RUNNING response for GitHub Actions run `37337050485` at commit `ffe5524f415c303951ff23717a833b7597ea524b` with `CHECK_AFTER_SECONDS=20` and observed that the task still consumed excessive time because the Robot repeatedly sent CHECK prompts while the same external run remained `in_progress`. This is distinct from CI execution speed: each unchanged active-run CHECK consumes another ChatGPT turn, expands conversation length, repeats SOT/run inspection, and can dominate task elapsed time. Canonical optimization is local smart CHECK suppression: after the earliest CHECK deadline, inspect only the already-tracked authoritative GitHub run read-only; if it remains active on the same SHA, do not create a new ChatGPT turn yet, continue bounded local observation and chat-health monitoring, and wake CHECK immediately on terminal/obsolete/uncertain evidence or after the bounded heartbeat window. This optimization does not change DISCOVER/EXECUTE/CHECK protocol semantics and cannot authorize project mutation or completion.
- on 2026-10-05 after the throughput-optimization deploy, the Owner observed the Robot remain for minutes in `STARTING_BROWSER` while the Control Center showed wrapper/CDP healthy and a task execution still active. A target-valid read-only watchdog rerun on `DESKTOP-4K7IM13` captured the exact contradiction: `wrapper_alive=true`, `cdp_healthy=true`, exact persisted conversation runtime identity rebound successfully from the open page, ChatGPT direct UI probe `READY_IDLE / RESPONSE_COMPLETE / composer_ready=true / response_running=false / assistant_busy=false / conversation_full=false`, but durable outbound state remained `RESPONSE_RUNNING / TASK_EXECUTION` for message `6221a2ff-fe94-47a8-9189-5620d825309c`; the exact pending user-turn/cycle correlation was not present and watchdog classified `LOCAL:STARTING_BROWSER_STALLED:193`. This is a phantom/orphaned in-flight transaction after restart/rebind, not a live ChatGPT response and not a dead browser. Canonical recovery MUST preserve exact-once safety by never replaying the old `TASK_EXECUTION`: after the exact conversation is rebound, if the outbound task is at least 60 seconds old, two bounded read-only probes show the same stable idle surface with a ready/readable empty composer and no auth/network/transient/full/busy condition, no exact pending user-turn correlation exists, and the current assistant turn remains stable without the current cycle marker, the runtime must classify the old transaction as `RUNTIME_RESTART_ORPHANED_IN_FLIGHT_TASK`, retire only the disposable chat, bootstrap a fresh generation from the same SOT, and issue `MAGASIN_CHECK_TASK_V1` for the same authoritative task. Any evidence of an active response, exact user correlation, current cycle marker, changing assistant turn, non-empty/unreadable composer, or insufficient age keeps the existing observation/fail-closed path and grants no resend authority.
39. an already `DELIVERED` / `RESPONSE_RUNNING` `TASK_EXECUTION` or `TASK_STATUS_CHECK` that becomes orphaned across restart/rebind MUST NOT leave the Robot indefinitely in `STARTING_BROWSER`. Recovery is allowed only from positive bounded evidence on the exact rebound conversation: the transaction is at least 60 seconds old; the exact pending user-turn correlation is absent; two read-only probes separated by a bounded stability delay both show `responseRunning=false`, `assistantBusy=false`, no Continue/auth/captcha/network/transient/missing/access-denied condition, and a ready text-readable empty composer; and the latest assistant turn is unchanged across both probes and does not contain the current `MAGASIN_CYCLE_CORRELATION_V1 <message_id>`. When all conditions hold, the runtime must classify the prior transaction as orphaned, preserve its task/message identity in recovery evidence, retire only the disposable conversation, bootstrap from the same SOT, and continue exclusively with `MAGASIN_CHECK_TASK_V1` for the same authoritative task. It MUST NOT replay the old EXECUTE, reconcile/send the old composer message, increment a resend retry, or select a different task before that CHECK. If any proof condition is absent, normal exact-once observation/fail-closed behavior remains authoritative.

40. repeated `MAGASIN_CHECK_TASK_V1` traffic for one unchanged authoritative GitHub Actions run is an avoidable chat/control-plane cost and MUST be suppressed locally without changing protocol semantics. `CHECK_AFTER_SECONDS` remains the earliest protocol recheck deadline. At that deadline, when durable `external_work` identifies one authoritative active GitHub Actions run by exact `repo + workflow_run_id + authoritative_sha`, the Supervisor MAY inspect that run read-only through GitHub's run API before sending another ChatGPT turn. If the exact run is still `queued/pending/requested/waiting/in_progress` on the authoritative SHA, the Supervisor must continue local observation with bounded cadence (20s, then 30s capped), keep chat-health recovery active, and suppress redundant ChatGPT CHECK turns for at most five minutes before a protocol heartbeat. As soon as the run becomes terminal, obsolete, or the local observer cannot prove the same active authoritative run, the Supervisor must wake immediately and send the normal `MAGASIN_CHECK_TASK_V1`; all existing CHECK semantics, terminal-failure AUTO_REPAIR rules, SOT validation, and machine-readable response blocks remain unchanged. Local observation is execution metadata only, performs no project mutation, must fail open to the existing CHECK path on HTTP/rate-limit/auth/network uncertainty, and must never be used for Supabase/other external systems unless an equally authoritative read-only observer exists. Repeated CHECK prompts should be concise but must preserve the exact existing `MAGASIN_TASK_CONTROL_V1`, `MAGASIN_EXTERNAL_RUN_V1`, correlation, TASK_ID, and completion/blocking semantics.

- on 2026-10-05 after smart CHECK suppression was deployed, scheduled watchdog run `37372096249` captured a distinct send-path failure: production was `BLOCKED / SEND_WORK / EXACT_ONCE_FAILED` with outbound `TASK_STATUS_CHECK / ENQUEUED` message `0509ac89-413b-4f71-a19c-70475daa5394`, retry_count 0, exact conversation rebind success, ChatGPT direct probe `READY_IDLE / composer_ready=true / response_running=false`, and wrapper no longer alive. Wrapper logs showed the send failure was a 2-second Playwright click timeout on the current composer Send button. This is not project-side-effect ambiguity and must not strand autonomy indefinitely. Canonical repair is two-layered: if a direct Send click throws while the exact CHECK prompt is still positively present in the live composer, treat that as positive non-submission evidence, skip repeating the same semantic button, and use the existing bounded Enter fallback in the same send attempt. If the runtime still terminates with `TASK_STATUS_CHECK + ENQUEUED + EXACT_ONCE_FAILED + retry_count=0`, the wrapper may perform exactly one runtime restart so the existing exact-once reconciler can prove non-delivery on the rebound chat and retry the same read-only CHECK once. This exception never applies to TASK_EXECUTION and retry_count >= 1 remains fail-closed.

41. same-SHA CI evidence aggregation is an internal throughput optimization and MUST NOT change MAGASIN task protocol semantics. When the locally tracked authoritative GitHub Actions run becomes terminal, the Supervisor SHOULD read the repository workflow-run set for that exact authoritative `head_sha` before waking ChatGPT. If sibling runs for the same SHA are still `queued/pending/requested/waiting/in_progress`, local observation may continue within the existing bounded smart-CHECK budget so the next CHECK/AUTO_REPAIR turn sees the aggregate terminal failure set instead of reacting to the first completed workflow. Once the same-SHA run set is terminal, obsolete, unavailable, or the bounded heartbeat expires, the normal CHECK path wakes immediately. This observer is read-only, cannot authorize completion, cannot hide required release gates, and fails open to the existing protocol on GitHub API uncertainty. The execution agent must then inspect all currently available failures/checks for that authoritative SHA, group them by root cause, run targeted/impacted QA, and prefer one coherent batch repair candidate before relaunching required regression.

42. a read-only `TASK_STATUS_CHECK` send failure MUST distinguish UI actuation failure from project-side-effect ambiguity. When the exact CHECK instruction remains visibly unchanged in the composer after a direct Send-control exception, that intact prompt is positive evidence that the submit transition did not occur; the runtime may continue to its bounded Enter fallback without setting permanent `BLOCKED`. If a `TASK_STATUS_CHECK` nevertheless exits with durable `ENQUEUED + EXACT_ONCE_FAILED`, non-empty message identity/digest, and `retry_count=0`, the wrapper may relaunch the single-conversation runtime exactly once so restart reconciliation can prove non-delivery and consume the existing one-retry exact-once budget. No new message ID may be created for this recovery, and `TASK_EXECUTION`, ambiguous post-send delivery, or any state with `retry_count>=1` MUST retain the existing BLOCKED/fail-closed behavior. This recovery changes neither CHECK semantics nor task protocol; it only prevents a transient ChatGPT Send-button failure from turning one read-only CHECK into an indefinite Owner intervention.

43. transient Windows state-file rename contention MUST NOT cause avoidable Supervisor restart loops. Atomic JSON replacement of durable Supervisor state may retry only the known transient Windows sharing codes `EPERM`, `EACCES`, and `EBUSY` with bounded exponential backoff. The default retry window must be long enough to tolerate multi-second antivirus/read-only observer locks observed in production, while remaining bounded, Windows-only, and preserving the existing durable destination until one atomic rename succeeds. The implementation MUST NOT delete the destination as a workaround, MUST NOT retry unrelated errors, and MUST still fail closed if the bounded retry budget is exhausted.

44. read-only local ChatGPT UI health probes MUST NOT compete materially with the production Supervisor runtime for the same CDP transport. The disposable probe must bound both CDP attach/open and page-probe operations to a few seconds, exit with structured error evidence on timeout, and run at a lower cadence than process/watchdog health checks. Process/runner/watchdog health remains fast; expensive UI probing is diagnostic only and must never monopolize CDP long enough to delay task-response reconciliation.

### SC-013 live first-failure progression rule

For SC-013 production debugging, the Robot MUST use a real production-length workload and advance strictly one blocking stage at a time:

1. run the real production path on `DESKTOP-4K7IM13`, not a shortened synthetic prompt as acceptance evidence;
2. identify the first blocking stage reached by the live run;
3. fix only that first blocking stage; do not bundle speculative fixes for later unproven stages into the same recovery iteration;
4. rerun the real production path from the beginning after that single-stage fix;
5. if the run advances and then blocks at a later stage, treat that later stage as the next independent repair iteration;
6. continue until the full Owner-visible flow and SC-013 DoD pass without special-case test shortcuts;
7. unit tests may protect a proven fix, but they cannot replace the subsequent real production rerun.
8. for each rerun, arm exactly one live first-failure attempt before asking the Owner to press START; do not queue a second hidden attempt that can consume the self-hosted runner after the first attempt has already captured the failure.

The live transaction stages used for this progression are, in order where applicable: PREPARED -> ENQUEUED -> COMPOSER_READY/TEXT_PERSISTED -> SUBMIT_ACTUATED -> DELIVERED -> RESPONSE_COMPLETE -> VERIFIED -> NEXT_WORK. A failure report must identify the earliest proven failing stage before implementation is changed.

### SC-013 FIRST-FAILURE ITERATIVE STABILIZATION LOOP

This is the canonical operating method for SC-013 while its state is **IN PROGRESS**. Every new ChatGPT conversation, Robot session, diagnostic operator, or implementation agent that reads this Source of Truth MUST follow this loop instead of attempting broad speculative repairs.

Canonical loop:

`PRE-ARM OBSERVER -> OWNER START OR ACTIVE OWNER-DELEGATED START -> CAPTURE FIRST FAILURE -> FIX ONE STAGE -> TEST -> EXPLICIT DEPLOY -> RE-ARM -> START -> REPEAT -> SOAK`

Mandatory execution rules:

1. **PRE-ARM OBSERVER** — before asking the Owner to start the Robot, arm exactly one read-only live first-failure observation attempt on `DESKTOP-4K7IM13`; verify that the attempt is already `in_progress` on the real target.
2. **OWNER START / OWNER-DELEGATED START** — manual Owner START is the default authority. The observer may invoke the canonical START script only when an explicit, target-bound, time-bounded Owner delegation marker is active in `.github/sc013-owner-delegation.json`. When the marker is absent, invalid, expired, or targets another machine, the observer MUST wait for manual Owner START.
3. **CAPTURE FIRST FAILURE** — observe the real production path from the moment of START and identify the earliest proven failing transaction stage and concrete error/evidence.
4. **FIX ONE STAGE ONLY** — if stage 5 fails, fix stage 5 only; if the rerun later reaches stage 7 and fails there, stage 7 becomes the next repair iteration. Do not bundle hypothetical later-stage fixes.
5. **TEST BEFORE PRODUCTION** — protect the proven fix with focused regression coverage and require all mandatory hosted gates to pass.
6. **EXPLICIT DEPLOY** — production replacement is allowed only through the explicit SC-013 deployment boundary; ordinary code/SOT/test merges remain CI-only and MUST NOT interrupt a live Robot.
7. **RE-ARM BEFORE EVERY RERUN** — after deployment, arm a new single live first-failure attempt before START. During an active Owner-delegated stabilization window, the pre-armed observer may issue that START itself; otherwise ask the Owner to START manually.
8. **REPEAT UNTIL FULL FLOW PASSES** — continue the loop until the Robot crosses the complete production path through `NEXT_WORK` without `BLOCKED`, duplicate sends, false recovery, or legacy interference.
9. **THEN SOAK** — once functional progression is clean, enter soak/endurance testing instead of continuing to make speculative functional changes. Run the Robot for increasing sustained windows and capture only real faults.
10. **24/7 STABILIZATION TARGET** — the final operating target is continuous unattended operation with the independent local watchdog and condition-watch monitoring active. A rare fault discovered during soak re-enters this same loop at its first proven failing stage.
11. **NO CHAT-HISTORY AUTHORITY** — future chats MUST derive this process from this Source of Truth. Old chat summaries, remembered workarounds, stale screenshots, or historical recovery patches are not authority when they conflict with current SOT/runtime evidence.
12. **REMOVE OBSOLETE REPAIRS WHEN PROVEN** — if a newer proven fix makes an older recovery path, diagnostic workflow, temporary observer, or compatibility latch unnecessary or conflicting, remove it with regression protection rather than keeping stacked recovery logic indefinitely.

### SC-013 SINGLE ACTIVE LANE / CLEAN REPOSITORY RULE

The production control plane is intentionally minimal. There is exactly one Robot production lane and no parallel qualification/test/diagnostic lane is allowed to compete for the self-hosted runner.

Active workflow allowlist under `.github/workflows/`:
- `supervisor-sc013-live-production.yml` — the only Robot production/first-failure lane;
- `sc013-runtime-watchdog.yml` — the only GitHub read-only runtime observer, one job, no matrix;
- `supervisor-control-panel-desktop-4k7im13.yml` — the only explicit production deploy lane;
- `supervisor-tests.yml` — hosted CI only;
- `supervisor-integrity.yml` — hosted CI/integrity only;
- `supervisor-lifecycle-acceptance.yml` — hosted lifecycle-contract CI only;
- `supervisor-autostart-install.yml` — hosted installer-contract CI only.
- `sc013-coordinator-readonly-stage.yml` — H4A16IL source-only staging, manual or owner-reviewed marker; never production APPLY.
- `sc013-coordinator-inert-apply.yml` — H4A16IL only, explicit Owner-reviewed marker, isolated STAGE then add-only inert Coordinator APPLY.
- `sc013-coordinator-hook-apply.yml` — single Owner-approved source replacement for the inspection-only Coordinator loop; no worker/scheduler start.

Active script allowlist under `.github/scripts/`:
- `supervisor-sc013-live-production.ps1`;
- `sc013-wait-response-liveness.mjs`;
- `sc013-runtime-watchdog.ps1`;
- `supervisor-sc013-rebind-diagnostic.ps1`;
- `supervisor-sc013-rebind-diagnostic.mjs`;
- `update-latest-clean-old.ps1`.
- `sc013-coordinator-readonly-stage.ps1` — isolated source-only candidate staging; never installed Coordinator or live robot modification.
- `sc013-coordinator-inert-apply.ps1` — guarded add-only Coordinator files, rollback on failure; no runtime worker activation.
- `sc013-coordinator-hook-apply.ps1` — exact-main old-hash-locked Coordinator.py inspection hook replacement with rollback; no outbound.

All former PE/MBV/MIG/RBT/SC003-SC012 qualification, soak, path-diagnostic, state-maintenance, alternate-deploy, temporary-cleanup, stale-run, and control-panel diagnostic workflows/scripts were removed from the active GitHub control plane on 2026-10-02. Historical runtime source may remain inert where still needed for migration/rollback context, but it has no active GitHub Actions authority.

Mandatory rules:
1. no new self-hosted workflow may be added merely to diagnose a failure; use the single live lane, the single watchdog, or local read-only evidence;
2. no matrix/multi-slot production or watchdog job is allowed;
3. unit/regression tests run only on hosted runners and cannot START/STOP/deploy/mutate production;
4. a production failure is diagnosed from the single live lane's earliest failure plus local watchdog evidence;
5. temporary diagnostic code must not be left in the active control plane after the evidence is captured;
6. if a future change requires a new active workflow or script outside these allowlists, the SOT must be explicitly revised first.

Operational phases:

- **Phase A — Iterative recovery:** repeat first-failure repair iterations until the complete live flow passes.
- **Phase B — Stability qualification:** require same-conversation multi-cycle evidence with no duplicate delivery, no unexpected `BLOCKED`, and stable runtime/CDP identity.
- **Phase C — Soak/endurance:** extend continuous runs progressively; watchdogs remain read-only and faults are repaired only through a new first-failure iteration.
- **Phase D — 24/7 steady state:** Robot runs unattended continuously; monitoring remains active, and any newly proven fault reopens the loop at the earliest failing stage.

A future chat that is asked to "continue SC-013", "make the Robot run", "continue the attempt", "watch the Robot", or equivalent MUST first determine which phase above is current from this SOT and live evidence, then execute the next step of this loop. It MUST NOT restart from generic diagnosis or invent a parallel repair plan.

Current Owner-delegated overnight stabilization authority:
- scope: `SC-013_OVERNIGHT_STABILIZATION`;
- target: `DESKTOP-4K7IM13`;
- authority: on 2026-10-04 the Owner explicitly instructed ChatGPT to inspect and repair the current Robot failure directly; this renews authority to run the canonical START command on the exact target, re-arm attempts, and keep the Robot progressing until a genuine Owner-required block is reached;
- marker: `.github/sc013-owner-delegation.json`;
- automatic expiry: `2026-10-04T18:00:00+07:00`;
- stop condition while valid: only a genuine Owner-required boundary (`BLOCKED_OWNER` semantics such as credentials/MFA/CAPTCHA/security/permission, explicit business approval/decision, or Owner STOP) ends unattended progression; `STATUS=RUNNING`, bounded `CHECK_AFTER_SECONDS`, technical faults, runtime/CDP/UI failures, reconciliation faults, and monitoring faults are not Owner blocks;
- allowed actions while valid: pre-arm one observer, START the canonical Robot, capture first failure, implement exactly one first-stage fix, run mandatory gates, perform explicit production deploy, re-arm, START again, and continue into soak when the full flow passes;
- forbidden even while delegated: ambiguous resend, bypassing exact-once evidence, speculative later-stage fixes, disabling fail-closed safeguards merely to force progress, or START on any machine other than the exact delegated target;
- after expiry, genuine Owner block, or Owner revocation, remote START authority ends automatically and the process returns to manual Owner START.


### SC-013 current 24/7 autonomous operations delegation (2026-10-06)

The Owner delegates continuous unattended operational recovery on exactly DESKTOP-H4A16IL until explicitly revoked or Owner STOP is asserted. This supersedes the expired 2026-10-04 overnight delegation for current production operation on this target only and does not authorize mutation of any other machine.

Operational objective:
- keep the Robot available 24/7 and minimize safe time-to-result across ChatGPT, GitHub Actions, and task-scoped Supabase work;
- prefer targeted QA/change-impact checks, batch repair, authoritative-SHA tracking, and bounded adaptive polling before broad release gates;
- do not wait on terminal external runs; completed failure transitions to same-task diagnosis/repair, and completed success transitions to verification/advance;
- when Supabase is part of the authoritative task, prefer bounded metadata reads plus batched SQL/RPC/data operations over repeated dashboard/UI probing; the guardian itself never performs database writes.

A separate process-layer guardian is authorized under these strict boundaries:
1. it may restart the independent local watchdog if that observer is absent or its heartbeat is stale;
2. it may start the GitHub self-hosted runner service if the configured Supervisor runner service is stopped;
3. it may relaunch run-supervisor.ps1 only when Owner STOP is absent, a valid SINGLE_CONVERSATION_V1 control record exists, the wrapper is absent, and durable automation is RUNNING or no state exists yet;
4. it MUST NOT clear STOP or AUTOSTART_DISABLED, send/click/type in ChatGPT, mutate single-conversation-state.json, resend an outbound transaction, alter SOT task authority, deploy code, or perform Supabase writes;
5. it MUST NOT auto-relaunch a durable BLOCKED or DONE automation state;
6. wrapper recovery is durably rate-limited across guardian restarts to at most five starts per hour with at least 90 seconds between starts; the recovery-attempt timestamps are persisted before process creation, and exhausted budget is evidence for deep diagnosis, not authority for an unbounded restart loop;
7. run-supervisor.ps1 remains the final process-level STOP-latch check, so a race with a new Owner STOP fails closed.

The independent read-only watchdog remains the first evidence source. The guardian is a second process/service recovery layer, not a replacement for exact-once runtime recovery. A separate ChatGPT condition-watch may inspect the target hourly, follow this SOT, diagnose the earliest failing boundary, and perform only SOT-authorized safe repairs. Owner notification is reserved for genuine Owner-required boundaries such as login/MFA/CAPTCHA, credentials/permissions, explicit business approval/decision, Owner STOP, or exhausted bounded repair.
### SC-013 GitHub/Supabase local dispatch delegation (Owner directive 2026-10-08)

The Owner directs that routine ChatGPT-to-local robot work assignment must NOT depend on paid/per-call Remote Desktop Commander. The preferred asynchronous path is:

```text
OWNER / ChatGPT
  -> GitHub issue or Owner-selected Supabase dispatch inbox
  -> DESKTOP-H4A16IL outbound-polling Local Task Gateway
  -> authenticated/validated request envelope + idempotent local SQLite inbox
  -> Local Supervisor / robot tổng
  -> task-specific WebApp, SAYDI, SAPO or monitoring executor
  -> durable local outcome/checkpoint
  -> authenticated GitHub/Supabase status writeback (only after independently qualified)
```

The existing SINGLE_CONVERSATION_V1 execution protocol and sole SOT authority are unchanged. An Issue or Supabase row is a **request**, never project authority: it cannot independently select/advance a task, authorize a deployment, bypass an Owner gate, or replace a project's canonical Source of Truth.

Safety gates:
1. Local gateway uses outbound polling and no unauthenticated public listener; owner/producer identity, schema version, target, task id and SOT path are validated; no arbitrary shell payloads.
2. Deduplicate across retries/reboots using source issue/job identifier and durable SQLite state. Do not replay ambiguous irreversible mutations.
3. Only **read-only health_check** routes may execute before per-robot adapters pass SOT-specific review and safety tests. `execute_task`, `render_qc`, and `sync_revenue` remain `WAIT_SOT_AUTHORITY` with no side effects until authorised.
4. Robot tổng respects Owner STOP and AUTOSTART_DISABLED, existing transaction exact-once rules, resource budgets, correct-machine scoping, production release gates, and bounded retry.
5. Remote Desktop Commander is **break-glass/exceptional-use only** for approved local setup, root-cause diagnostics, or hands-on repair; never the default heartbeat/queue/status transport.
6. Supabase integration requires the Owner to choose the project and provision a dedicated RLS-constrained dispatch inbox/identity. Do not repurpose an existing business task table or expose service-role secrets in local scripts.
7. Production cannot be considered delegated to a downstream robot merely because a message was queued: evidence of actual executor acknowledgement and completion must be persisted before reporting DONE.

Implementation evidence as of 2026-10-08: `C:\MAGASIN_MCP\dispatch_gateway.py` and `local_jobs.py` on `DESKTOP-H4A16IL` validated a real GitHub Issue #336 `health_check` (local job DONE, Supervisor BLOCKED/FAULT observed without bypassing recovery gates), tested four read-only robot health routes, and supplied local watchdog restart continuity. The local implementation has **no autonomous production task execution** or automatic GitHub/Supabase writeback yet. Supabase dispatch remains disabled pending project and credential selection. These boundaries MUST remain explicit in Control Center and Owner reports.

### SC-013 autonomous result-repair loop (Owner directive 2026-10-08)

The Owner requires **automatic task completion, not notification-only failure handling**. For every SOT-authorized dispatched business task, Robot tổng owns a closed feedback loop from executor acknowledgement to verified acceptance. A failed QA/QC/CI result is evidence for the **same task's** repair iteration, NOT authority to mark DONE, select another task, or immediately require Owner intervention.

Required workflow:

```text
RECEIVED -> SOT_VERIFIED -> ASSIGNED -> EXECUTING -> VERIFYING
    -> passed: EVIDENCE_RECONCILED -> COMPLETE -> RESULT_PUBLISHED
    -> failed: FAILURE_CLASSIFIED -> AUTO_REPAIR (same task)
          -> changed repair plan / code / targeted segment -> EXECUTING -> VERIFYING
          -> repeat only while budgets and proof-safe retries permit
          -> technical escalation via authorized local diagnostics, specialist robot, or
             separately approved AI execution budget, then verification
    -> genuine Owner gate: WAIT_OWNER (credential/MFA/CAPTCHA, authorization,
       irreversible business decision, production release approval where required,
       additional spend/approval, Owner STOP)
```

Acceptance and non-interruption rules:
1. A downstream robot's message "done" is NOT acceptance; validate artifacts, task-specific DoD, required tests/QA/QC/CI, exact commit/run evidence, and SOT state before terminal COMPLETE. Partial PASS remains IN_PROGRESS.
2. Robot tổng automatically routes actionable failures to the responsible specialist with failure signature, latest evidence, remediation scope and checkpoint. Re-run only the affected checks first, then the required final gates. Preserve one canonical TASK_ID and exact-once transaction semantics.
3. Prevent infinite repetitions: persist a deduplicated failure signature, retry count, distinct remediation attempted, time/cost/CPU/RAM budget, and last concrete progress. A repeated identical failure without material progress must trigger an alternative diagnosis or technical escalation, not an identical retry loop. Preserve the existing SC-013 three-attempt and other SOT-specific retry constraints; never bypass them.
4. Distinguish **BLOCKED_TECHNICAL** from **WAIT_OWNER**. An exhausted technical repair budget is NOT automatically Owner input authority; retain a precise incident/evidence package and delegate to an available approved technical/AI path when possible. If no such path exists, surface the blockage honestly without fabricating progress.
5. Owner is contacted for genuine required decisions and final reviews explicitly required by the authoritative project SOT. Ordinary recoverable CI failure, interrupted local process, render-pronunciation defects, or repeated status polling are NOT grounds for interrupting Owner.
6. Keep production, database, finance/sales, and external writes behind their applicable approval and rollback gates. No automatic destructive migration, irreversible SAPO reconciliation, production release, credential change, or unbudgeted paid API usage.
7. GitHub/Supabase completion reports must include source issue/job ID, canonical TASK_ID, status, attempt/revision, acceptance evidence, machine-readable failure signature when applicable, artifact/PR/run references and whether Owner action is actually required. Writeback must be idempotent and never assert DONE solely from worker exit code.
8. This rule defines the **target architecture**. The current `C:\MAGASIN_MCP` implementation dispatches read-only health checks only; automatic result writeback and SOT-gated business AUTO_REPAIR are NOT yet implemented. Neither an idle ChatGPT conversation nor an inactive ChatGPT plugin can be treated as an always-on consumer: the autonomous feedback loop must run in Local Supervisor, with ChatGPT invoked only through an expressly configured and available mechanism.

### SC-013 H4 Gateway read-only health candidate staged and hash-verified — NOT APPLIED (2026-10-10)

**Actual source and CI:** Source-only [PR #383](https://github.com/magasincoffee/magasin-supervisor/pull/383) introduced the pure, exact-old-SHA local Gateway patch and isolated SQLite tests. Final head `5dfe85e1f3c52d0a1b12f5ef756a3a7f8fc8e4ae` passed all four mandatory hosted workflows: Supervisor Integrity `38022518963`, Supervisor Tests `38022518958`, Lifecycle Acceptance `38022519064`, Autostart Install `38022518948`, all SUCCESS. Squash merge `56ae4cef12524effbd72e5ff71ba8d3dec0b8c77`; exact-main comparison `identical`. This proves the *synthetic* read-only health-only fix under STOP, not a successful on-machine job.

**Actual H4A16IL stage:** With two real Gateway processes still running and Owner STOP intact, an isolated candidate was generated using source fetched from the immutable merged Git commit, **without modifying the live gateway**. Stage `D:\MAGASIN_ROBOTS\deploy\sc013-local-gateway-health\56ae4cef12524effbd72e5ff71ba8d3dec0b8c77\` contains a byte-for-byte `backup\dispatch_gateway.py`, immutable `source\local_gateway_health_patch.py`, transformed `candidate\dispatch_gateway.py`, and `stage-manifest.json`. Source patch Git blob SHA `bb18b3d7bb210aeb4dd58dd61d0671da446ecef7` matched the exact reviewed repository blob. Installed original `C:\MAGASIN_MCP\dispatch_gateway.py` and backup SHA-256 both equaled **`64d2758fdfbfaa468937f4b91bbe1909103db9a427587bd93854bc1d79f00ba1`**. Exact two-anchor source transform and candidate `ast.parse` on the H4 Python runtime passed; staged candidate SHA-256 **`0e53acf4d49457e994bda7a215707693d8b6bd51544d8cab8e8f0198f3d3d9da`**. A separate check after staging showed live original still hash-identical, Gateway processes not restarted, physical Supervisor `STOP`/`AUTOSTART_DISABLED` not touched. This is `STAGE_READY_FOR_REVIEW_NO_APPLY`; **NOT** `APPLIED`, `DONE` or any business-dispatch qualification.

**Required next APPLY/rollback evidence:** Only after explicit reviewed Owner acceptance of **the separate, read-only health-while-STOP policy** may an operator perform an H4-only, one-shot replacement of the **single exact** `C:\MAGASIN_MCP\dispatch_gateway.py` file: verify current live hash still the original above, verify candidate hash above, validate actual service process ownership and no unknown active pending writes, snapshot existing local SQLite inbox and gateway services, install candidate atomically with original ACLs and backup intact, restart **only the two verified Gateway processes** and maintain independent local watchdog connectivity. Run negative tests: Owner STOP still present; `execute_task/render_qc/sync_revenue` remain `WAIT_SOT_AUTHORITY` and no local jobs; `health_check` Issue #381 from previous `WAIT_OWNER_STOP` should queue one deduplicated read-only `supervisor_snapshot` job and reach local `DONE` with receipt; fake/untrusted issue, forged READY business row, wrong target and replay stay denied. If any check fails, restore original exact SHA-256 and original service behavior, preserve SQLite checkpoint/idempotency and report `ROLLBACK` honestly. **Do not automatically clear STOP, alter Supervisor SINGLE_CONVERSATION_V1 config, launch a specialist, switch projects or claim business task completion.** This is an additional local policy cutover, not bundled with PR #383 merge. SC-013 remains **IN PROGRESS**.

### SC-013 Local Gateway read-only health under STOP — separate from task execution (Owner 2026-10-10)

**Owner directive and on-host root cause:** The Owner explicitly requested that every local-machine task be delegated through local MCP and verified as actually executing. A read-only [GitHub Dispatch Issue #381](https://github.com/magasincoffee/magasin-supervisor/issues/381) was submitted using the existing validated five-field `MAGASIN_DISPATCH_V1` request (`action=health_check`, `target=supervisor`, `task_id=SC-013`, canonical SOT URL). H4A16IL local Gateway **received** and persisted `github:magasincoffee/magasin-supervisor:issue:381` into SQLite `C:\MAGASIN_MCP\state\jobs.sqlite3`, but classified it `WAIT_OWNER_STOP`, `local_job_id=NULL`. Two `dispatch_gateway.py` Python processes were observed alive. Both physical Supervisor `STOP` and `AUTOSTART_DISABLED` remain present and MUST NOT be cleared by this work. The transport is operational but the local job has **not executed**.

**Actual installed sources inspected read-only:** `C:\MAGASIN_MCP\dispatch_gateway.py` SHA-256 **`64d2758fdfbfaa468937f4b91bbe1909103db9a427587bd93854bc1d79f00ba1`**. In its `ingest` function the health_check branch sets `WAIT_OWNER_STOP` while `is_owner_stop()` is true, then an enclosing `if not is_owner_stop()` prevents dispatching even its allowlisted snapshots. `C:\MAGASIN_MCP\local_jobs.py` SHA-256 `e8311b84a290532350a83548469d19950dde6e31ae7b6323ead7f8bc6bac754f` limits jobs to `system_snapshot,supervisor_snapshot,mcp_probe,webapp_snapshot,saydi_snapshot,sapo_snapshot` and the `perform` mapping was independently inspected: no shell payload, robot process launch, finance writes or media rendering. Therefore the blocker is a **read-only Gateway policy**, not an absent connection. The installed Gateway source is currently local and must NOT be overwritten by a general GitHub repo change.

**Proposed read-only observer distinction, pending separate Owner APPLY approval:** A monitoring `health_check` is not `execute_task`, `render_qc` or `sync_revenue`. Keep all business routes `WAIT_SOT_AUTHORITY`, regardless of STOP state, per §9 and SC-013 Business Executor gates. However permit **only validated, allowlisted read-only health_check snapshots** to run while Owner STOP is asserted, consistent with the independently permitted read-only monitoring of this SOT. This is **not** approval to launch Supervisor or to remove STOP. Resuming an existing local `WAIT_OWNER_STOP` row is permitted only when `action='health_check'` and `local_job_id IS NULL`; no escalation of previously staged business rows or unknown/replayed jobs is allowed. A source message or local TCP connection is never equivalent to a completed local job. This proposed Gateway runtime change is not automatically authorized by the Owner's general request to test local MCP; require the explicit STOP-policy cutover approval and rollback gate described below.

**Source-only patch and exact guard:** `src/coordinator/local_gateway_health_patch.py` is a pure UTF-8 source-transform function requiring the **exact original gateway SHA-256** above and two **unique canonical code anchors**. It changes the `health_check` intake classification to `READY` regardless of Supervisor STOP, and tightens the local dispatcher query to `status='READY' AND action='health_check'` before resolving only the four allowlisted snapshot kinds; it explicitly reclassifies historic `WAIT_OWNER_STOP` rows only for no-job health_check. It keeps the original default `condition = "WAIT_SOT_AUTHORITY"` for all non-health actions; an unexpected forged `READY` business record cannot trigger a local job. It does not write/install files, modify sqlite, touch STOP, open a browser, run a worker, or transmit sensitive data. Unit tests use a **synthetic** SQLite Gateway with fake submitted health jobs to verify STOP health delivery and DONE, idempotent dedupe, old wait recovery, all three business actions blocked with STOP present or absent, forged READY business records ignored, wrong target ignored, fail-closed drift and no state mutation from merely generating patched source.

**NEXT LOCAL APPLY GATE REQUIRES SEPARATE REVIEW:** No live Gateway modifications or reboot have been approved by a test/PR merge. Before local APPLY: all four hosted Supervisor workflows GREEN, main exact SHA, build a candidate from the H4 **original SHA-256** under a separate backup/stage folder, run a fresh exact-source transform and compile, verify original Gateway processes/queue owner and pending transaction state, produce a rollback plan for both independent existing Gateway processes, and explicitly constrain any restart to only the Gateway (no Supervisor/SAYDI/SAPO). After APPLY only if separately authorized: verify health_check Issue #381 transitions `WAIT_OWNER_STOP → QUEUED → DONE` with an actual local job ID and a read-only receipt while Supervisor STOP remains present; verify business actions remain `WAIT_SOT_AUTHORITY` and no local job ID; verify gateway service survives restart, backup exact original and no data loss. On any mismatch rollback the original hash. The local patch must not be applied by queued `execute_task`, arbitrary shell, a GitHub Issue comment, or an unreviewed background worker. SC-013 remains **IN PROGRESS** and autonomous project execution **NOT_QUALIFIED** even after a read-only health job succeeds.

### SC-013 Owner-requested project activation and Local MCP delegation qualification (2026-10-10)

**Owner directive and scope:** After approval and verified live installation of the link-entry panel in PR #380, the Owner instructed: **make linking a project lead eventually to unattended Supervisor execution by SOT, and delegate all local-machine work to the local MCP rather than spending Remote Desktop Commander calls**. This is Owner direction to build/test the remaining project-activation path and validate the local transport, NOT consent to clear physical Supervisor `STOP`/`AUTOSTART_DISABLED`, resend a previously ambiguous ChatGPT outbound, choose an unapproved task, change the active SOT configuration without a safe transaction checkpoint, perform financial/audio work, or bypass the sole project SOT. `SC-013 IN PROGRESS`, Business Executor still `NOT_QUALIFIED`. Existing `SINGLE_CONVERSATION_V1` runtime already has an SOT-based ChatGPT execution loop **after a separately qualified START**, but the Control Center currently only permits pending SOT proposals, not an authenticated switch of the selected project or Owner START for it.

**Required UX state sequence, explicit gates:** `PENDING_SOT_REVIEW → SOT_FETCHED_IMMUTABLE_MAIN → PROJECT_CHANGE_GATES_RECONCILED → OWNER_CONFIRMED_SELECTED_WHILE_STOPPED → OWNER_START → SYNC_SOT → READY_TASK_EXECUTE → QA/REPAIR → EVIDENCE_CONFIRMED`. The first two transitions are inspection only. The third requires a verified terminal status for any prior outbound, a durable exact-once/no-duplicate receipt, no active worker/ChatGPT conversation race, machine-/project-bound Owner generation, and an explicit verified revision of the selected repo SOT. The fourth may only update **one** `SINGLE_CONVERSATION_V1` binding with original hash CAS, independent rollback and audit while physical STOP stays latched; it must never accidentally launch a worker or run a task. A subsequent legitimate Owner START is distinct; it can never be inferred from selecting/dropping a link. Post-START execution must re-read the current canonical project SOT from the beginning, determine its sole next READY task with bounded changes, and stop for any unresolved Owner approval, account login or ambiguous delivery. Project work must not cross project/SOT task boundaries.

**First source-only preflight increment:** `src/control-center/supervisor_project_activation.py` validates a **saved PENDING** Owner link, reuses the strict canonical GitHub `magasincoffee/<repo>/blob/main/<...SOURCE_OF_TRUTH.md>` parser, performs **two** bounded, no-redirect GETs to the constructed GitHub Contents REST endpoint `api.github.com`, checks file/path/type/UTF-8/base64/Git blob SHA and exact repeatability, and returns a content hash/revision without publishing the full project SOT through local UI. It reads local Supervisor transaction state and treats `ENQUEUED` / `EXACT_ONCE_FAILED` / in-flight/unknown outcomes as a hard **no-replay** blocker. Without a separately attested Owner START, worker identity, SOT task READY and verified switching implementation, every response remains `BLOCKED_NOT_QUALIFIED`, `project_switch_allowed=false`, `task_ready_verified=false`, `business_dispatch_authorized=false`, `worker_started=false` and `any_state_mutation=false` even if the document's Git blob matches. `/api/supervisor/project/check` is a strictly Owner-CSRF+Origin-protected **read-only** route; the same Supervisor page displays **“Kiểm tra trước kích hoạt”** for pending SOTs and grounds the blockers next to the linked repository. No `/activate` or `/switch` API and no local runtime/worker changes are introduced in this increment.

**Local MCP / Gateway work order and observed boundary:** The ChatGPT connection in this turn has **no directly callable MAGASIN local MCP namespace**. Under the Owner-approved 2026-10-08 outbound-polling transport rule, a new Owner-authored [Issue #381](https://github.com/magasincoffee/magasin-supervisor/issues/381) was created with exactly five `MAGASIN_DISPATCH_V1` keys (`schema,task_id,target,action,sot_url`), `action=health_check`, `target=supervisor`, `task_id=SC-013` and this project SOT URL. This is a supported **read-only local MCP job request**, not an `execute_task` or authorization to mutate. An exceptional one-time Remote Desktop Commander read-only bootstrap on H4 confirmed two `dispatch_gateway.py` processes and physical Supervisor STOP/AUTOSTART_DISABLED latched, but the earliest SQLite read-only query for `github:magasincoffee/magasin-supervisor:issue:381` returned **no matching receipt yet**. The Issue creation alone is NOT evidence that the local gateway polled it or completed a job. Verify actual Gateway inbox/job DONE and durable timestamp before claiming local MCP active; if missing, diagnose the existing local poller without using Remote Desktop Commander as the ordinary task transport. Only local `health_check` is permitted until the independent executor/Owner/SOT gates qualify `execute_task`.

**Mandatory hosted test/merge gates:** Python fixtures on both Windows/Linux must cover valid immutable double SOT GET, bogus Git blob SHA, changed revision between reads, redirects/SSRF/oversize/invalid response, wrong machine/Owner STOP/missing request and registry, saved active SOT preserved, ambiguous outbound no replay, invalid/terminal state not granting worker authority and no filesystem changes. Node UI/API tests must prove distinct `/check` action is CSRF guarded and never introduces a new project activation/Supervisor START route. Merge only when all four required Supervisor workflows GREEN, verify exact-main and log evidence to SC-013 Issue #339. **Local APPLY of the new check panel, true project-selection mutation and automation startup remain separately reviewed gates** with immutable file hashes, rollback, actual host observer and Owner authorization. No automatic switching or business run may be claimed from this source-only PR.

### SC-013 Owner-approved Supervisor project SOT link Control Center UI — live installed and independently accepted (2026-10-10)

**Result/permission boundary:** The Owner explicitly approved deploying the Supervisor **project Source of Truth link management UI** to `DESKTOP-H4A16IL` under the already-reviewed source-only PR #378 plus the narrowly scoped Windows hostname bugfix PR #379. The UI-only deploy **PASSED** on its second, re-pinned attempt. Only the three exact files `D:\MAGASIN_ROBOTS\control-center\server.py`, `web\app.js`, and new `supervisor_project_links.py` were installed; only the Control Center `pythonw.exe` process was restarted. No Supervisor/SAYDI/SAPO worker START/STOP, no project switch, no Owner STOP removal, no Windows Scheduled Task edit, no financial or media writes, and no Business Executor enablement. `SC-013 IN PROGRESS`; `MIG-CC-01 IN_PROGRESS`; `MIG-CC-02..05 NOT DONE` and project-selection/production dispatch still `NOT_QUALIFIED`.

**Reviewed bugfix and immutable source:** PR [#379](https://github.com/magasincoffee/magasin-supervisor/pull/379) corrected a Windows-only Control Center `COMPUTERNAME` environment variable absence by using `socket.gethostname()` with unchanged exact `DESKTOP-H4A16IL` allowlist. Verified H4: Python `os.environ.get("COMPUTERNAME")=None`, `socket.gethostname()=DESKTOP-H4A16IL`, Windows `[Environment]::MachineName=DESKTOP-H4A16IL`. Hosted head `bf37607bb262094bfb802799899a5480910cfe60` passed required Supervisor Integrity `38015719842`, Supervisor Tests `38015719872`, Lifecycle Acceptance `38015719921` and Autostart Install `38015719933` workflows, all SUCCESS. Squash merge `fb266318f19e6175132f40dcfc301cf6c4370db5` verified **exact-main identical** before H4 staging.

**Fresh stage and rollback manifest:** `D:\MAGASIN_ROBOTS\deploy\sc013-project-links\fb266318f19e6175132f40dcfc301cf6c4370db5\`, with `backup\`, `candidate\`, `stage-manifest.json`, `candidate_verify_v2.py`, `owner_apply_project_links_v2.ps1`, `apply-receipt.json`. Original live and rollback backup SHA-256: `server.py=7604f96d31fc27ebfb969fc566e18341dde4203a1c2551077cb5419399d21954`; `web/app.js=f2916c4ec5b255d90034726c83f1f731711d396eadedf2ec17b4dd3274f930b4`. Exact newly merged Git blobs staged and verified: `server.py=f0b7d8a6f03929457a60f4e635d1972eb8cbc047`; `web/app.js=4f9bcda235ebd18055069c87a3424f55d14f5f40`; `supervisor_project_links.py=358fcedb4a9e21704c01d590132e1cfc42d92684`. Local Python AST and JavaScript `node --check` PASS, independent original backup hash PASS, staged read-only full `detail("supervisor")` with actual local host and Worker STOP returned `OWNER_STOP_SAFE_TO_SAVE_LINK_REQUEST_ONLY` and the correct Workforce SOT; production files were unchanged during this stage.

**Actual approved local APPLY/rollback gating:** Strict PowerShell 5.1 parser check PASS. Exact Control Center listener `pythonw.exe` PID `9544` was exclusively bound to `127.0.0.1:8781` and was the **only** process stopped; the installer replaced only its three pinned candidate files and relaunched through `START_CONTROL.ps1 -StartOnly` (without opening Chrome or a specialist). New PID `9344`. Installer receipt `APPLIED_UI_ONLY_PASS` and negative post-apply HTTP checks: invalid web Origin `403`, invalid CSRF `403`, external untrusted GitHub SOT URL `400`, re-saving the **already-active** Workforce SOT URL `200` as a no-op (no pending request registry write), and disabled SAYDI control route `405`. The UI includes `supervisorProjectPanel`, the `/api/robot/supervisor` and `/api/overview` responses show current SOT and derived project repository, while `business_dispatch_enabled=false` and `execution_authorized=false`.

**Independent after-process acceptance:** A second, separate PowerShell process confirmed `/healthz=HTTP 200`, live Control Center PID `9344` with expected `pythonw.exe` command line and loopback binding, all three installed SHA256 equal immutable reviewed staged candidates, and **no active Supervisor binding changes**: `%LOCALAPPDATA%\MAGASIN\BusinessOS\supervisor\single-conversation-control.json` remained at SHA-256 `d9d035adbb86f070a0a88be05b79286557374108faf8b21d62a34c67e82a5b17`; both `STOP` and `AUTOSTART_DISABLED` still present. The pending-link registry `D:\MAGASIN_ROBOTS\robots\supervisor\config\project_sot_requests.json` still does not exist, meaning no new project was requested or selected. `MAGASIN Sapo Nightly`, `MAGASIN Sapo Reconcile`, `SAYDI NATURAL V4 Watchdog`, `SAYDI V5 CH02 QC Guardian` kept original enabled triggers. The independently read **literal** local `project_id` value is `LIVE`, not `WORKFORCE-CROSS-STORE` as an older SOT observation erroneously described; the actual unchanged `source_of_truth_url` points to `magasincoffee/magasincoffee.github.io` Workforce Cross-Store SOT. Never infer an accepted Workforce execution task from the generic internal project ID.

**Owner UI:** Reload `http://127.0.0.1:8781/robot/supervisor`; section **"Dự án Supervisor quản lý"** now displays the current active Workforce SOT link and its code repository, plus a field to submit another `magasincoffee` GitHub `main` SOT link as `PENDING_SOT_REVIEW` only. Other links do not become active until a future **separately qualified** SOT-reading, Owner-reconciled project-selection gate with single-conversation and ambiguous outbound safety. No need for the Owner to re-enter the existing Workforce SOT. The source/receipt evidence is recorded on SC-013 Issue #339.

### SC-013 Supervisor SOT link H4 first APPLY auto-rollback / Windows host identity fix (2026-10-10)

**Owner authorization:** Owner explicitly approved the source-reviewed `/robot/supervisor` link/SOT UI-only installation on `DESKTOP-H4A16IL` using staged PR #378. Scope is limited to `D:\MAGASIN_ROBOTS\control-center\server.py`, `web\app.js` and one new `supervisor_project_links.py` helper; local Control Center restart and negative Origin/CSRF/URL plus current SOT readback are allowed. **NOT** authorized: Supervisor child START, clearing STOP/AUTOSTART_DISABLED, changing `single-conversation-control.json`, switching project, changing Windows Schedulers, finance/audio/data modification, real Business Executor or disabling legacy robots.

**First APPLY failed closed and rollback passed:** Stage pinned immutable Git merge `908ce7d52ad76fec460b1a750cd4fdee2a87f7ed`, original SHA256 `server.py=7604f96d31fc27ebfb969fc566e18341dde4203a1c2551077cb5419399d21954`, `web/app.js=f2916c4ec5b255d90034726c83f1f731711d396eadedf2ec17b4dd3274f930b4`, active project control JSON SHA256 `d9d035adbb86f070a0a88be05b79286557374108faf8b21d62a34c67e82a5b17`, staged all three Git blob hashes, existing Supervisor STOP/AUTOSTART_DISABLED, and pre-apply HTTP 200 with verified Control Center listener PID `1768`. After replacing only UI files and restarting Control Center, the new SOT project link detail returned **no qualified active project object**; strict smoke failed before any link writes or child actions (`sot_url property absent`). The owner-approved installer automatically rolled back from the staged, hash-pinned original backup and restarted the **original** UI. Rollback receipt `D:\MAGASIN_ROBOTS\deploy\sc013-project-links\908ce7d52ad76fec460b1a750cd4fdee2a87f7ed\apply-receipt.json` recorded `ROLLED_BACK_VERIFIED`, restored Control Center listener PID `9544`, original file hashes re-verified, original Workforce SOT SHA unchanged, both Owner STOP latches present, pending SOT link registry absent and `/healthz` HTTP 200. Do not represent the new link panel as live yet.

**Root cause and bounded fix:** The source-only Python `supervisor_project_links.inspect()` relied on `os.environ['COMPUTERNAME']` to fail-closed on a wrong machine. On H4 the Control Center Python environment **does not export COMPUTERNAME** (verified `repr(os.environ.get('COMPUTERNAME'))=None`), although Windows `[Environment]::MachineName` and Python `socket.gethostname()` both return `DESKTOP-H4A16IL`. Therefore legitimate H4 read-only inspections were rejected with `WRONG_MACHINE` and `active=None`. Fix only the host identification fallback to OS `socket.gethostname()`, retaining exact H4 allowlist and explicit test override for fixtures. Add hosted tests with COMPUTERNAME absent and simulated foreign socket hostname requiring `WRONG_MACHINE`, then all four mandatory hosted workflows GREEN, reviewed PR, exact-main and newly pinned staging/negative QA before retrying under the same Owner-approved **UI-only** scope. Do not weaken hostname checks, silently bypass source integrity or infer SOT project execution from UI configuration.

### SC-013 Supervisor project SOT linking inside the unified Control Center (Owner 2026-10-10)

**Owner observed defect and requested target:** The unified `/robot/supervisor` page currently has START/STOP, worker status and a static link to the **Supervisor robot's own repository**, but lacks the essential project **Source of Truth URL** field. The canonical architecture above already requires the Owner to supply only a valid project SOT URL (not an old ChatGPT conversation URL). The Owner correctly notes that the Supervisor cannot choose which project to work on from this panel without that binding. Project **code repository** and **Supervisor robot repository** are distinct concepts: the project repo is derived from the SOT's trusted GitHub URL; the SOT is the only authority for which task is READY.

**Grounded H4 runtime (read-only):** `%LOCALAPPDATA%\MAGASIN\BusinessOS\supervisor\single-conversation-control.json` already has `schema_version=single-conversation-control.v1`, `mode=SINGLE_CONVERSATION_V1`, `project_id=WORKFORCE-CROSS-STORE`, with `source_of_truth_url=https://github.com/magasincoffee/magasincoffee.github.io/blob/main/01_DOCS/MAGASIN/05_SYSTEM/WORKFORCE_CROSS_STORE_SCHEDULING_TEMP_SOURCE_OF_TRUTH.md`. Its file SHA-256 at inspection was `d9d035adbb86f070a0a88be05b79286557374108faf8b21d62a34c67e82a5b17`. No corresponding source-binding field was shown in the Control Center UI and the `D:\MAGASIN_ROBOTS\robots\supervisor\config` folder had no registered project link inventory. The real runtime `src/project-adapter.mjs` supports an explicit project adapter `PATH` or `URL` (with `supervisor-project-adapter.v1` schema), but **that optional runtime adapter is not equivalent to a GitHub SOT URL**. The runtime `windows/run-supervisor.ps1` selects `SINGLE_CONVERSATION_V1` from `single-conversation-control.json`. Supervisor physical `STOP` and `AUTOSTART_DISABLED` both remain present, and an earlier outbound remains ambiguous; do not claim project execution from the presence of a configured SOT.

**Scoped source-only feature (no activation):** `src/control-center/supervisor_project_links.py` performs a bounded **read-only** inspection of the actual runtime's project SOT, derives code repository navigation without guessing, and accepts *Owner-confirmed pending link proposals* via an exact `https://github.com/magasincoffee/<repo>/blob/main/<...SOURCE_OF_TRUTH.md>` path. It rejects credentials in URL, query/fragment/percent-encoding, alternate branches, invalid repos/path traversal/non-SOT documents, wrong target host, unreadable active controller, missing physical `STOP`/`AUTOSTART_DISABLED`, malformed registries and symlink-based edits. Only `D:\MAGASIN_ROBOTS\robots\supervisor\config\project_sot_requests.json` may be written atomically after same-origin/CSRF, exact `SAVE_SUPERVISOR_SOT_LINK_ONLY` confirmation, a bounded JSON payload and a fresh safe STOP check. The request list is idempotent and bounded (max 10). **It NEVER modifies the live `single-conversation-control.json`, never changes the selected project or a worker, never fetches/executes user-supplied URLs and never grants START/Business Executor.** Even syntactically valid new SOT links are `PENDING_SOT_REVIEW` and `execution_authorized=false`; a link name or a robot's existing GitHub repo is not authority to start the project.

**One-window Owner UX:** The existing Supervisor detail pane now has **“Dự án Supervisor quản lý”**: current project SOT, derived code repository, a box to paste a new SOT URL, an explicit **“Lưu liên kết để xác minh”** action, a list of pending requests and visible warnings that a saved request does not change the active project. No extra windows or old conversation URLs. All displayed URLs are HTML-escaped and restricted by `safeHref`; the input is disabled when STOP/binding evidence does not qualify. The new POST `/api/supervisor/project/link` reuses the current localhost same-origin, CSRF, JSON-body and command-allowlist boundary; no new generic worker command is introduced. Existing `/api/supervisor/control` remains unchanged and must reject START if any current guard is unsafe.

**Required gates / next executable step:** Build the source as reviewed PR with tests on hosted Windows + Linux (safe active binding read, valid Workforce/OPS SOT links, URL attack patterns, Owner STOP, replay/duplicates, atomic write, active config hash unchanged, CSRF protection and no new robot controls). Merge only when the existing four gates are GREEN and verify exact-main. A **separate Owner-reviewed hash-pinned local stage/apply and rollback** is needed before this link panel is live on H4. A future **separate** Owner project-selection gate must fetch/verify the exact new GitHub SOT from start, prove identity/revision/task READY, keep at most one active project conversation, reject active-worker/ambiguous-outbound switching and change the single-conversation control with exact file version/rollback. That project-activation action is **not approved by a mere SOT-link save**. SC-013 remains IN PROGRESS, MIG-CC-02 NOT DONE and production dispatch NOT_QUALIFIED.

### SC-013 Owner-approved H4 Control Center UI-only APPLY — live accepted (2026-10-10)

**Owner decision:** Owner explicitly approved the preceding *UI-only* on-host APPLY/rollback gate after candidate stage evidence. Authorized changes were restricted to replacing the existing `D:\MAGASIN_ROBOTS\control-center\server.py` and `web\app.js`, adding `specialist_readiness.py` and `cutover_preflight.py`, recycling **only the verified Control Center listener**, then running strict negative Origin/CSRF/unsupported robot-control and post-restart QA. This is NOT authority to enable Business Executor, start/stop Supervisor/SAYDI/SAPO, change Windows Scheduled Tasks, remove legacy User Interfaces, adjust Supervisor STOP or mutate customer/financial/audio records. The Owner's previous approval was not for wholesale robot consolidation.

**GitHub-reviewed source and staging:** Source PR [#375](https://github.com/magasincoffee/magasin-supervisor/pull/375), merged `7147f1a95659a0a8e56a8a299ba936eb810e05af`, passed all four required checks and exact-main. Independent D: stage/backup evidence was captured in merged [#376](https://github.com/magasincoffee/magasin-supervisor/pull/376), exact-main `109340ada2a256e7b0b260d22e9890724dab773d`. Live apply used only the hash-pinned stage `D:\MAGASIN_ROBOTS\deploy\sc013-unified-control-preflight\7147f1a95659a0a8e56a8a299ba936eb810e05af\`. Windows PowerShell 5.1 script's initial Unicode-string parser issue was detected **before the service was stopped**; corrected to an ASCII UI marker and confirmed Parser PASS. Control Center Python dependencies passed when imported from the correct application directory.

**Exact original and installed files:** Before APPLY, Control Center was exclusively listening at `127.0.0.1:8781` as `pythonw.exe` PID `14408`, with WMI command line bound to the expected `D:\MAGASIN_ROBOTS\control-center\server.py`; original server and JS SHA256 matched verified backups (`503fd59ce03f906221f08afa29e2f1e13b0925c00aa67bd28bd0846d37b5ac3b` and `7093a9b52516302392d5731289e62acf6dd55757fac2403bdf49338fccbc8e22`). Verified candidate Git blobs at immutable reviewed commit: `server.py=1a25ad462d8443d48c4529f8d7848c40d1388489`, `web/app.js=7e7c418c263daf43e5201f973724e3e4419b25b8`, `specialist_readiness.py=b6e1fd31595e6ba02970696ecf8766321fa90469`, `cutover_preflight.py=9a1921ded394ddbeb7076f7ef9582e4036862652`. Only exact listener PID `14408` was recycled, **no Supervisor/SAYDI/SAPO worker process was touched**. New view listener PID `14796` was verified separately as `pythonw.exe` on `127.0.0.1:8781`.

**On-host tested QA:** Install script `owner_ui_only_apply.ps1` reported `UI_APPLY_RESULT=APPLIED_UI_ONLY_PASS`, `SPECIALIST_LIFECYCLE=UNCHANGED_OWNER_STOP_PRESERVED`, and wrote `owner-ui-apply-receipt.json` into the isolated deployment directory. `/healthz` returned HTTP 200; `/api/overview` exposed `migration_preflight.status=BLOCKED_NOT_QUALIFIED`, `cutover_allowed=false`, `business_dispatch_enabled=false` and all three specialist `ready=false`; `/app.js` served the new unified migration warning panel. Negative-only tests: unrelated web Origin POST to Supervisor -> **403**, wrong CSRF -> **403**, attempted unqualified SAYDI control path with valid same-origin token -> **405**. None invoked a legitimate START or STOP action. An **independent subsequent process** re-checked HTTP 200, bound listener PID `14796`, all four installed-source SHA256 equal to Git-verified staged candidates, unavailable production robot authority, and no SAPO export URL/raw path, email, bearer token or financial identifiers in the read-only pre-cutover API. This independent verifier initially had a standalone command-line Python quoting error when comparing hashes; the verifier (not production) was corrected to compare native PowerShell SHA256 hashes, then **PASS**. No production error/rollback was triggered; a verified original backup remains available for a future controlled rollback.

**Safety invariants after APPLY:** Both physical Supervisor `STOP` and `AUTOSTART_DISABLED` latches were independently confirmed present after installation. Coordinator remains `BLOCKED_SAFETY`, `business_dispatch_enabled=false`. `MAGASIN Sapo Nightly`, `MAGASIN Sapo Reconcile`, `SAYDI NATURAL V4 Watchdog`, `SAYDI V5 CH02 QC Guardian` remain at their original scheduled enabled-trigger state and were not edited. SAPO still has an unresolved pending export and recent login/auth diagnostic class; SAYDI Chapter 2 still awaits Owner listening review rather than being FINAL; Supervisor outbound remains potentially ambiguous. Do not interpret their UI appearance as permission to change live transactions or clear Owner STOP.

**Milestone interpretation:** This is **one successfully completed UI-only deployment gate** inside existing SC-013. `MIG-CC-01` remains **IN_PROGRESS** until independent worker/finance checkpoint and recoverable migration inventories qualify. `MIG-CC-02` remains **NOT DONE** overall: the warning panel is live but genuine SAYDI/SAPO Owner START/STOP, full queues/QA and removal of required old Owner windows have NOT been completed. `MIG-CC-03..05` NOT DONE and `SC-013` IN PROGRESS. The immediate next source-approved action is to design and test native per-robot Owner START/STOP adapters with reboot-OFF, STOP latch and checkpoint-safe financial/audio semantics in isolated non-production fixtures. No production worker control can be enabled until separately SOT/Owner reviewed.

### SC-013 MIG-CC-01 candidate staged on H4 — source + backup accepted, NOT APPLIED (2026-10-10)

**Status / authority boundary:** Candidate for the unified, read-only migration warning panel has been copied to an isolated D: staging directory and checked on `DESKTOP-H4A16IL`; this is **not a production Control Center deployment**, not a robot lifecycle cutover and not a generic approval to replace live files. `MIG-CC-01 IN_PROGRESS`, `MIG-CC-02 NOT_DONE`, `MIG-CC-03..05 NOT_DONE`, `SC-013 IN PROGRESS`, `business_dispatch_enabled=false`. The Owner's separate, hash-pinned cutover/APPLY gate and negative acceptance suite are still required. The existing project SOTs for SAYDI/SAPO remain authoritative for their workloads.

**Source review and exact-main:** [PR #375](https://github.com/magasincoffee/magasin-supervisor/pull/375) supplied `src/control-center/cutover_preflight.py` (new safe read-only classifier), `src/control-center/server.py`, `src/control-center/web/app.js` and `src/control-center/specialist_readiness.py`; final reviewed head `eb4214c83d79e6190951e5f66803973a7b1f2450` passed all four hosted gates (Supervisor Integrity `37990446762`, Supervisor Tests `37990446792`, Lifecycle Acceptance `37990446633`, Autostart Install `37990446731`). Squash merge `7147f1a95659a0a8e56a8a299ba936eb810e05af` was verified **exact-main identical** and all four source files were fetched from that immutable Git commit (not an unpinned branch).

**Isolated H4 stage and recoverable original views:** Directory `D:\MAGASIN_ROBOTS\deploy\sc013-unified-control-preflight\7147f1a95659a0a8e56a8a299ba936eb810e05af\` contains `backup\server.py`, `backup\web\app.js` (and the preexisting Control Center launcher backup when present), `candidate\server.py`, `candidate\web\app.js`, `candidate\specialist_readiness.py`, `candidate\cutover_preflight.py`, `stage-manifest.json`, `stage-acceptance.json`, `stage_verify.py` and `stage_smoke.py`. This staging/backup created new files **only within the isolated deploy directory**, never changed `D:\MAGASIN_ROBOTS\control-center` in place. The original live and backed-up `server.py` SHA-256 remained `503fd59ce03f906221f08afa29e2f1e13b0925c00aa67bd28bd0846d37b5ac3b`; `web/app.js` SHA-256 remained `7093a9b52516302392d5731289e62acf6dd55757fac2403bdf49338fccbc8e22`. Stage candidates independently matched **all four Git blob SHAs** from reviewed merge: `server.py=1a25ad462d8443d48c4529f8d7848c40d1388489`; `web/app.js=7e7c418c263daf43e5201f973724e3e4419b25b8`; `specialist_readiness.py=b6e1fd31595e6ba02970696ecf8766321fa90469`; `cutover_preflight.py=9a1921ded394ddbeb7076f7ef9582e4036862652`. Python AST and Node syntax checks passed.

**Isolated read-only live-data smoke:** Using only the staged `cutover_preflight.py` (without importing/running `server.py`), a non-mutating Python call on H4 inspected *local* SAYDI status, SAPO checkpoint/log-class metadata and Supervisor outbound/STOP. It returned `STAGED_LIVE_READONLY_TEST=PASS`, `READONLY_PRIVACY_GATE=PASS` and `BLOCKED_NOT_QUALIFIED` for Supervisor (`SUPERVISOR_OUTBOUND_UNKNOWN_OUTCOME_NO_RESEND`, `SUPERVISOR_STOP_LATCH_PRESENT_OR_UNKNOWN`), SAYDI (`SAYDI_CHAPTER_REVIEW_NOT_FINAL`, `LEGACY_AUTOSTART_UNRECONCILED`, `SAYDI_FREE_RAM_UNVERIFIED` because the standalone smoke interpreter lacked `psutil`) and SAPO (`SAPO_PENDING_EXPORT_NOT_RECONCILED`, `SAPO_RECENT_DIAGNOSTIC_REQUIRES_REVIEW`, financial checkpoint missing). Never treat a missing RAM adapter as enough RAM to START; the true Control Center runtime uses its installed `psutil` for future live read-only data after approved deployment. No SAPO export URL, raw path, token, email, invoice/customer identifier or log line was emitted.

**Independent live unchanged acceptance:** After stage, `/healthz` returned HTTP `200` at loopback `127.0.0.1:8781`, serving the **original UI** from PID `14408`. The Coordinator API reported `BLOCKED_SAFETY`, `business_dispatch_enabled=false`, and both Supervisor `STOP` and `AUTOSTART_DISABLED` remained present. The four existing active SAYDI/SAPO Scheduled Tasks remained `Ready`, their triggers still enabled and were not edited. The acceptance manifest reports `STAGE_READY_FOR_OWNER_REVIEW_NOT_APPLIED`, `production_cutover_qualified=false`. Source PR merge, stage smoke or a ready control listener MUST NOT be interpreted as robot START/STOP qualification.

**Exact next gate:** Prepare and review an explicit one-shot **Control Center UI-only** local APPLY/rollback plan referencing the original installed hashes above and the exact staged candidate Git blobs. That separate Owner gate may replace only `server.py`, `web/app.js` and add the two read-only helper modules, after snapshot/backups, target host validation, syntax/negative Origin+CSRF test, safe UI listener recycle and independent post-run health. It MUST NOT clear Supervisor STOP, enable a child, mutate any Windows task, access finance rows, write a transaction or authorize Business Executor. The actual native SAYDI/SAPO START/STOP cutover remains a later, separately tested and Owner-approved per-project step.

### SC-013 MIG-CC-01 cross-worker live checkpoint blockers and single-UI preview (2026-10-10)

**Scope and actual status:** Owner requested continued transition to one Control Center. This checkpoint is **read-only inspection and code-only UI preparation**, not authorization to touch specialist START/STOP, schedules, reboot flags, finance files, audio artifacts, or production UI. Keep `MIG-CC-01 IN_PROGRESS`; `MIG-CC-02 NOT_DONE` until the resulting shared UI is independently deployed and verified on H4. No production Cutover/APPLY marker is issued under this checkpoint. Project SOT boundaries continue to apply.

**Live H4 evidence, 2026-10-10 around 03:50 +07:00:** Read-only SAPO `%LOCALAPPDATA%\MAGASIN\SAPO\data\state.json` has `pending` with `target_date/export_requested_at/export_url/raw_path` and `last_success` with file/audit metadata; these are **pending/previous-success evidence**, not proof the outstanding export was reconciled. Do not copy or expose URLs, raw paths, ledger/customer IDs or auth data to GitHub or the UI. SAPO diagnostics for 2026-10-08 and 2026-10-09 contain `LOGIN_OR_AUTH`, `TIMEOUT` and `ERROR` class signals; previously observed `MAGASIN Sapo Nightly` and `MAGASIN Sapo Reconcile` LastTaskResult `1` cannot qualify financial checkpoint state. No verified active SAPO worker process was identified, but a missing process **cannot** prove an export has no pending irreversible side effects.

SAYDI Media Control still reports Chapter 2 `REVIEW_READY`, `QC_NEEDS_FREE_RAM` and `worker=false` in the last read-only snapshot; **REVIEW_READY is not FINAL**, and its previously pinned 2.3 GiB QC RAM gate remains. A `C:\SAYDI\MAINTENANCE.lock` file exists (observed file modification 2026-10-07); its exact owner/semantics and current active work must be verified before treating the lock as stale. Two SAYDI-related Python processes were observed but not independently authenticated as render/QC workers, so do not infer a safe STOP or restart from that. Supervisor `single-conversation-state.json` reports outbound `state=ENQUEUED`, `last_error_code=AMBIGUOUS_ENQUEUED_OUTCOME`, `retry_count=0`, while guardian `watchdog_mode=OWNER_STOP`, `owner_stop=true`, wrapper not alive and both Supervisor STOP latches remain present. **No automatic re-send, restart or STOP-latch clearance**, because the prior outbound could have been delivered with unknown acknowledgement.

**Unified Owner diagnostic code, source-only:** `src/control-center/cutover_preflight.py` classifies a bounded, sanitized risk inventory from SAPO JSON state (only pending-presence boolean), at most six bounded SAPO diagnostic logs (login/auth/timeout/error classes only), Supervisor outbound unknown-outcome plus STOP latches, SAYDI Chapter 2 review/resource stage and media worker/RAM, and legacy autostart uncertainty. It never returns SAPO raw files/URLs/credential values/log lines; it never writes state or invokes workers. `src/control-center/server.py` adds a strictly read-only `migration_preflight` field to the existing localhost `/api/overview` payload, while `src/control-center/web/app.js` shows a Vietnamese pre-cutover review panel within the **same** Owner Control Center overview and Robot Tổng detail. Every outcome keeps `qualified=false`, `cutover_allowed=false`, `owner_start_authorized=false`, `business_dispatch_enabled=false`; failures are BLOCKED. This is a source preview and is NOT deployed to H4 automatically.

**Required gates:** Hosted Windows/Linux Python/Node regression suites reject missing/corrupt financial state, stale/hostile logs, unknown outbound, Owner STOP, SAYDI not-FINAL, media-worker-active, insufficient RAM, disclosure of sensitive paths/tokens and accidental release of an actuator. All four mandatory Supervisor workflows GREEN, review/merge PR, exact-main, and record evidence in Issue #339. This completes only the **source-quality** portion of MIG-CC-01/02; the remaining Owner-approved local STAGE/APPLY, per-project worker checkpoints, safe recoverable backups and live after-restart acceptance must be handled by separate SOT-authorized gates. Never declare the buttons operational merely because the dashboard shows a warning.

### SC-013 MIG-CC-01 live partial inventory evidence (2026-10-09, H4A16IL)

**Work classification:** MIG-CC-01 = **IN_PROGRESS / READ_ONLY_PARTIAL**. Owner has authorized execution of safe migration inventory and source implementation but NOT live startup modifications, STOP-latch clearance, worker starts, or production Control Center installation. The sole GUI goal remains one unified MAGASIN Control Center on `127.0.0.1:8781`, with specialist backends and SOTs preserved.

**Live H4 evidence from explicit read-only PowerShell:** The existing Control Center listener is `127.0.0.1:8781`, `pythonw.exe`; canonical local Coordinator owner state generation `1`, desired `MONITOR_READ_ONLY`, `execution_enabled=false`, `business_dispatch_enabled=false`, and all supervisor/saydi/sapo *advisory* owner flags `false`. However live UI reports `BLOCKED_SAFETY` because both `%LOCALAPPDATA%\MAGASIN\BusinessOS\supervisor\STOP` and `AUTOSTART_DISABLED` exist (last changed 2026-10-09 21:10 local), and Supervisor Guardian reports `OWNER_STOP`, `owner_stop=true`, worker `wrapper_alive=false`. This overrides any stale "running" claim and **MUST NOT be automatically cleared by migration**.

**Windows Scheduled Tasks and unwanted-restart audit:** Six named tasks were observed: `MAGASIN SC013 Local 30min` enabled read-only inspection, `SAYDI Full Book V4 Resume` task disabled, `SAYDI NATURAL V4 Watchdog` enabled, `SAYDI V5 CH02 QC Guardian` enabled, `MAGASIN Sapo Nightly` enabled daily, and `MAGASIN Sapo Reconcile` enabled daily. SAYDI's active legacy triggers call `C:\SAYDI\RESUME_OWNER_APPROVED_NATURAL_V5.ps1` and `C:\SAYDI\control\RUN_CH02_V5_QC_SAFE.ps1`; SAPO's daily jobs execute `%LOCALAPPDATA%\MAGASIN\SAPO\diagnostic_runner.py --date today/yesterday` via Python 3.12. Both SAPO tasks' latest observed LastTaskResult was `1` (not success) and require project-specific log/checkpoint reconciliation. Their task `Ready` state is not proof that any business transaction is safe or completed. Do not delete/disable their triggers until the per-robot Owner STOP gate and backup/rollback are independently qualified.

**Additional non-scheduler startup mechanisms:** Windows Startup folder contains `SAYDI_FULL_BOOK_RESUME.cmd` as well as `MAGASIN_Local_Agent_Guard.vbs` and `MAGASIN_Local_MCP_Guard.vbs`; Supervisor guardian and Meta startup shortcut `.disabled` files are also present. Windows Run registry entry **names only** were observed: `MAGASINBusinessOSAutostart`, `MAGASINSupervisorLocalWatchdog`, `MAGASINSupervisorGuardian`, and `SAYDI_Media_Control`. Registry values, tokens, secrets, credentials, Chrome profiles and business data were deliberately NOT read into the public SOT. These routes must be included when verifying "OFF after reboot"; disabling only Scheduled Tasks would not be enough.

**Pinned read-only hashes as review anchors** (SHA-256, H4 files; revalidate directly before any APPLY):
- `D:\MAGASIN_ROBOTS\control-center\server.py`: `503fd59ce03f906221f08afa29e2f1e13b0925c00aa67bd28bd0846d37b5ac3b`;
- `D:\MAGASIN_ROBOTS\control-center\web\app.js`: `7093a9b52516302392d5731289e62acf6dd55757fac2403bdf49338fccbc8e22`;
- `D:\MAGASIN_ROBOTS\robots\supervisor\control_adapter.py`: `90f92c32c266c6a3571347169c802c8300ffbbd6f0ec0bdd70143e2f2c68b1e5`;
- `C:\SAYDI\control\media_control.py`: `c30efce331d4eaad9f72dcc4b51915e50c2b951f2047d0fff778ec8b4df6a4c2`;
- `C:\SAYDI\control\RUN_CH02_V5_QC_SAFE.ps1`: `9ffbbb1fc83aa08e8bffd9ba58c046fd34f0ed32e85c948fd9253b583ba4d91`;
- `C:\SAYDI\narration_director_v1\chapter2_v5_qc_guarded.py`: `59e1a3341569e43dfab399e24e4c46655c43eb2cc093ed5e8b473bf94ab11c2b`;
- `%LOCALAPPDATA%\MAGASIN\SAPO\control_center.py`: `3facee8796206740482fd98672d037aa730eaa9da0acede8abf43846f286f089`;
- `%LOCALAPPDATA%\MAGASIN\SAPO\diagnostic_runner.py`: `fc04ac70f3a6c20f4523027cfc390270741b44ddc664cc976c25b521a57fa96e`.

**Repeatable, no-write inventory source:** `windows/sc013-unified-control-inventory.ps1` emits a sanitized `MAGASIN_SC013_UNIFIED_CONTROL_INVENTORY_V1` stdout JSON report with task triggers/results, startup filenames and Run-entry **names only**, owner STOP, advisory OFF, loopback listener and source hashes. It cannot switch tasks, stop/start a robot, reveal Run registry values or inspect transaction payloads. It always reports `MIG-CC-01=IN_PROGRESS`, `cutover_qualified=false`, `business_dispatch_enabled=false` and `active_transactions=UNVERIFIED_REQUIRES_PROJECT_SPECIFIC_CHECKPOINT`. Its synthetic fixture mode accepts only `machine=SIMULATED_ONLY`; hosted checks confirm no process or scheduler mutation. This script is source-only until reviewed; running it manually on the authorized H4 host for read-only observation is permitted, never for deployment or control.

**Still needed to close MIG-CC-01:** Independently inspect current SAYDI book/chapter render/QC mutex + checkpoint state, SAPO read-only ledger/reconciliation and latest failure logs (no financial writes), outstanding Supervisor outbound transaction state, original SOT and real startup credential scopes without exposing secrets; then prepare verified restorable backup/stage metadata and obtain separate Owner-approved apply/rollback gate. Work cannot advance to legacy schedule disable, deletion or reboot OFF acceptance merely from finding file hashes. SOT remains `SC-013 IN PROGRESS`.

### OWNER 2026-10-09 — Control Center is the sole operational interface (supersedes separate robot control UIs)

**Owner decision / architectural lock:** The Owner has chosen to **retire the separately operated robot control windows** and move the **entire Owner-facing robot operations experience** into one MAGASIN Robot Control Center at `http://127.0.0.1:8781` on `DESKTOP-H4A16IL`. This supersedes any earlier plan that required the Owner to open Supervisor Control, SAYDI Media Control or SAPO's standalone Tk panel for routine status, START/STOP, configuration, work queues, progress, QA or operational review. It **does not authorize deleting robot execution engines**, source repositories, project SOTs, private credentials, Chrome profiles, audio, finance records, reconciliation checkpoints or project data. Control Center is one **control plane / UI / Owner authentication and audit surface**. Supervisor, SAYDI and SAPO remain three **separately fault-contained execution backends** (independent data plane), not one monolithic process; Router/Coordinator is not permitted to start a specialist without that robot's own Owner enablement and canonical SOT.

**Target architecture and presentation:**
```text
OWNER — one MAGASIN ROBOT CONTROL CENTER, localhost-only / 8781
  ├── Robot Tổng: SOT/queue, qualified routing, exact-once QA, evidence (disabled until gates)
  ├── Supervisor: Owner START/STOP, real Chrome/worker/CI status, pending task and QA
  ├── SAYDI: Owner START/STOP, chapter render/QC/R2 progress, RAM, audio playback/review
  ├── SAPO: Owner START/STOP, per-day job queue, reconciliation state and exception review
  └── Infra: MCP/GitHub transport, host CPU/RAM/Disk, schedules, logs and incidents
            ↓ narrow, versioned, authenticated per-robot lifecycle adapters
       Existing separate local workers, stores, projects and project SOTs
```
Only one **desktop application window/shortcut** is required for routine operations. Legacy SAYDI `127.0.0.1:8776` read-only Media Control and existing SAPO `control_center.py` may remain **internal compatibility/read-only data providers during migration**, but must not require a second Owner UI at final acceptance. No iframe, direct unauthenticated local POST, global one-size-fits-all `taskkill`, arbitrary shell command, or fake START button may be used to pretend a robot's lifecycle is qualified.

**Owner lifecycle policy from this decision:** Each backend is **Owner OFF by default on Windows reboot**; only the small Control Center and lightweight **read-only** heartbeat may autostart. Individual Owner START grants its own project worker/watchdog/QC/retry scope **until Owner STOP**; internal SAYDI QC remains automatic *while SAYDI is Owner ON*. Owner STOP persists through reboot, prevents scheduled tasks, guardian/watchdog, GitHub Issue, MCP, Robot Tổng and automatic resume from starting the robot, and safely drains/checkpoints any in-flight audio or finance operation. Crash recovery while ON is bounded and per-robot; STOP must remain accessible even when START is blocked. Cross-robot dispatch is always SOT- and independently Owner-gated. A positive `RUNNING` indicator needs independent live worker/heartbeat evidence, not a process name, stale JSON or merely a Windows task marked `Ready`.

**Cross-project SOT reconciliation (must be performed, not assumed):** The newer Owner policy supersedes the 2026-10-03 *default-on Windows boot recovery* paragraph in SAYDI's authoritative `magasincoffee/magasin-media-robot/00_PROJECT/SOURCE_OF_TRUTH.md`, **for the target cutover state only**. Record this Owner decision in that project's own SOT through a separate reviewed PR before changing its Windows tasks. Do not reinterpret the old SAYDI default-on runtime as already migrated: it is still an actual legacy system until installation/reboot tests prove OFF-by-default. The SAPO diagnostic/sync runtime is separate from the OPS-WebApp's business-data SOT; its current `MAGASIN Sapo Nightly`/`MAGASIN Sapo Reconcile` Scheduled Tasks cannot silently be deleted or reclassified as harmless if they still write revenue. Reconcile SAPO project authority and finance write policy before any control cutover.

**Implementation order, gates and evidence (SC-013 scope, no parallel project task queue):**
1. **MIG-CC-01: Inventory/freeze existing systems, no mutation.** Capture SHA-256 and owner/process ID of live Control Center and native Supervisor/SAYDI/SAPO scripts; audit current Windows Scheduled Tasks, watchdogs, logon startup and active outbound/audio/revenue transactions; capture source-level project SOTs. Record which legacy startup action can restart a supposedly OFF robot, unknown credential scopes, and the safe checkpoints. Existing queue, saved media, Chrome profiles, finance data and credentials must remain untouched.
2. **MIG-CC-02: One coherent Control Center UI.** Show Robot Tổng and three specialist tabs/pages within the same window. Replace links to distinct external control UIs with integrated, read-only status/progress and evidence views (including SAYDI Chapter 2 RAM/QC progress and SAPO day/reconcile queue); show per-robot `START`, `STOP`, `STOP_PENDING_SAFE_CHECKPOINT`, `WAIT_RESOURCE`, `FAULT`, `OWNER_OFF` with exact blockers. Do not make disabled controls appear functional or show non-authenticated status as RUNNING.
3. **MIG-CC-03: Per-robot Owner authority and native adapters.** Prove separate durable Owner generation and authenticated action on localhost, fresh boot-bound worker identity/heartbeat, STOP latch, duplicate/replay protection, resource gates, idempotent commands, exact process-scope and independent concurrency limits. Supervisor's existing guarded controller is a starting point but its current `BLOCKED/FAULT` must not be bypassed. SAYDI's `C:\SAYDI\control\media_control.py` is read-only today and Chapter 2 is `PAUSED_RESOURCE` until sufficient RAM (currently requires at least 2.3 GiB). SAPO requires bounded financial checkpoint/worker consent; first validate read-only status before any sync. The Control Center is not a heavy rendering process.
4. **MIG-CC-04: One-by-one, Owner-approved safe cutover.** After a separately reviewed per-robot project SOT and QA/CI/exact-main pass, snapshot + backup the relevant legacy schedules/config and install the native adapter with hash guards, rollback and an explicit Owner cutover marker. Prove existing active tasks are at safe checkpoints and no unknown irreversible transactions exist, disable only those **legacy autostart mechanisms** that would violate the new Owner OFF policy, preserving their definitions for rollback. Never blindly delete processes, Scheduled Tasks, standalone UI files or source; deprecate the separate UI launcher only after matching functions work in Control Center.
5. **MIG-CC-05: Acceptance and retirement.** For each robot separately, verify Owner START, progress/QA, idempotent STOP, STOP during interrupted job, reboot OFF, no unwanted re-start, safely bounded retry ON, CPU/RAM/host survival with at least one other robot OFF, correct UI heartbeat, no finance/audio duplicate and rollback/old data preserved. Then deprecate standalone Owner UI links and shortcuts **only** (archive first, never erase business state). Complete unified acceptance requires *all* three robot panels and a 24–48h observation period; publish status in Vietnamese and evidence in the SOT/Issue #339. Work is not DONE merely because a PR merged or a UI button is clickable.

**Immediate execution boundary (2026-10-09):** This new Owner decision authorizes documentation, source code, read-only inspection and isolated fixture testing without additional Owner approval. It does **not** authorize turning currently running robots OFF, changing Windows Scheduled Tasks, uninstalling old UI components, copying into the live Control Center, destroying data, enabling production Business Executor or overriding individual project SOT gates. The existing Control Center / 30-minute SOT monitor remains available as-is pending separately approved local STAGE/APPLY. If Remote Desktop Commander is offline, record the lack of live evidence and continue source-only work without guessing. Only mark an individual robot's cutover complete after independently verified on-machine and after-reboot evidence.

### Owner-controlled independent Robot Hub (new Owner directive 2026-10-09)

The Owner requires **ONE unified Control Center** that lists and manages independent specialist robots, **NOT one fused multi-purpose robot**. This directive supersedes any interpretation of previous robot-tong / cross-robot automatic dispatch requirements that would launch, share runtime or redirect work between robots without Owner selection.

Canonical architecture:

```text
OWNER
  -> MAGASIN ROBOT CONTROL CENTER (one small always-available dashboard)
     -> Supervisor / WebApp (independent project, SOT, profile, logs, working dir)
     -> SAYDI Media / Audiobook (independent project, render/QC/artifacts)
     -> SAPO revenue sync (independent service, credentials, sync/checkpoints)
     -> other future robots as separately installed opt-in adapters
```

Control is the single surface for **observability and lifecycle actions only**; it is NOT a mandatory common executor or SOT. GitHub/Supabase may hold per-robot jobs, but **only the robot explicitly enabled by Owner** may process its queue; a stopped robot must never be started by incoming issues, timers, webhook, another robot, remote MCP request or a generic watchdog.

Owner lifecycle contract (per robot):
- Owner explicitly chooses START or STOP individually, with confirmation when stopping active irreversible/reconciliation tasks. Commands are idempotent, scoped to that robot's exact processes/services and safe launchers, and logged with who/when/why.
- Startup default is **OFF for all specialist robots**; after Windows reboot they must not auto-run until Owner manually starts them again. A small localhost-only Control Center and lightweight health monitor may autostart; the monitor may observe OFF robots but must not restart them.
- When Owner turns a particular robot ON, its own existing watchdog, SOT-authorized retry, QA/QC loop and 24/7 operation are permitted **for that enabled robot only**. Turning it OFF suppresses restart and new work; running irreversible work must either finish a bounded safe checkpoint or require explicit force-stop confirmation. No cross-robot dependency or automatic activation.
- Robot-specific GitHub/Supabase ingress is isolated by robot ID and SOT, and may leave tasks queued as `WAIT_OWNER_ENABLE` while OFF. Cross-robot calls are opt-in, auditable and never automatically enabled as a side effect.
- Each robot has its own configuration, source repo, credentials, logs, queue, resource budget, code lifecycle and versioning. A robot failure must not stop or restart another robot.
- UI is in Vietnamese and displays actual process truth: `Đang chạy`, `Đã dừng`, `Đang lỗi`, `Chờ Owner`; startup toggle and stop control, progress, current phase, CPU/RAM use and recent evidence. Never show `RUNNING` solely from stale persisted status if its actual worker is dead.
- Control UI launches as one lightweight local application window (prefer `--app=http://127.0.0.1:<port>/` or equivalent); no unsolicited console windows, duplicate IDEs, or dedicated Chrome windows for inactive robots.
- Minimize idle consumption on the approximately 8 GB target; permit explicit concurrency limits so the Owner can decide if more than one heavy robot may run. The Control Center must not run media QC or Chrome/browser automation itself.
- Preserve production/reconciliation safety and all independent SOT acceptance/review gates. Supabase production projects MAGASIN-NOIBO and OPS-WebApp must remain untouched; future robot coordination may use a **new, separate Owner-created Supabase project only**.

Migration and rollout:
1. Inventory each robot's existing startup entries, windows, scheduled tasks, process ownership and safe stop/start scripts; snapshot configurations and in-flight states.
2. Build and test the new Control Center plus per-robot adapters in isolation. Never make an unqualified Start/Stop button affect live production.
3. Qualify Owner-start, Owner-stop, crash recovery while ON, no-restart while OFF, no-window-popup, exact process scoping, no data loss, reboot OFF-by-default, independent resource limits.
4. Only after verifying the new controls, transition old per-robot auto-start entries into manual mode during an Owner-approved cutover. Do not disable, kill or relocate currently active services merely by merging this document.
5. Keep Remote Desktop Commander for explicitly approved break-glass repair, not the routine robot management path.

Implementation checkpoint 2026-10-09 on `DESKTOP-H4A16IL`: Phase 1 of the unified **read-only** Control Center has been created at `D:\\MAGASIN_ROBOTS\\control-center` using lightweight Python localhost `127.0.0.1:8781`, with a shell/Chrome `--app` launcher and an Owner desktop shortcut. Its overview lists Supervisor, SAYDI Media and SAPO as **independent robots**, plus MCP/GitHub Gateway as separate infrastructure. Selecting any robot opens a dedicated detail view within the same UI. Health and detail HTTP endpoints, Python compilation, and JS syntax checks passed. Four organized directories under `D:\\MAGASIN_ROBOTS\\robots` contain isolated manifests, documentation/config/report slots and Windows Junctions to existing runtime roots; no production files, Chrome profiles or data have been moved. The original runtime paths remain canonical until individually requalified.

**Not yet qualified**: functional per-robot Start/Stop buttons remain disabled; old startup entries/schedules remain enabled and can auto-start services, so OFF-by-default acceptance is NOT met. Chrome App window visibility was not verified via remote execution; the desktop shortcut exists and the local web server responds. SAPO business-state verification, browser-profile migration, final operational UI acceptance, independent lifecycle gates and safe cutover remain pending. C: had under 1 GB free during inventory, so new files were placed on D:. Existing Gateway/SQLite read-only functions do not confer authority to start specialist robots.

### Local Coordinator/UI hierarchy checkpoint (2026-10-09)

The Owner clarified that **Robot Tổng (Coordinator/Orchestrator)** is a distinct layer between GitHub/Supabase intake and the independently developed specialist robots. MCP/GitHub Gateway is **transport only**, not the Coordinator. The unified Control Center must show the flow OWNER -> GitHub / new Supabase -> Gateway -> ROBOT TỔNG (SOT validation, analysis, assignment, QA/rework loop) -> enabled Supervisor / SAYDI / SAPO -> return evidence. Each specialist remains autonomous in source, SOT, runtime, and storage and is only allowed to execute when Owner enabled that specialist.

Phase-one UI/plan evidence on DESKTOP-H4A16IL: `D:\MAGASIN_ROBOTS\robots\coordinator\coordinator.py` performs read-only deterministic route analysis over validated Gateway SQLite entries and stores separate plan evidence under its own D: folder; it analyzed six historical health-check records. `D:\MAGASIN_ROBOTS\control-center\` has a top-level Coordinator card, a distinct Coordinator detail page and a separate section for three specialists plus MCP/Gateway infrastructure. Local HTTP tests passed: 1 Coordinator (status OFF), 3 specialists and 1 infrastructure service, six plan entries. The Coordinator is **NOT yet a daemon**, is OFF until Owner explicitly enables it, and **does not yet validate the live SOT, perform AI analysis, dispatch executable business tasks, implement QA/rework, or write results to GitHub/Supabase**. Existing read-only gateway health checks are not evidence that specialist tasks completed. There is no authority to start a specialist or alter production. Future activation requires per-robot Owner-enable guards, live-SOT task authority, qualified executors, durable exact-once evidence, and tested result return, with the Supabase dispatch project created separately by Owner.

### SC-013 Robot Tổng qualified business-execution completion program (Owner-approved plan 2026-10-09)

**Authority and status:** This is the Owner-approved implementation/acceptance program **inside existing SC-013**, not a new competing Source of Truth, task ID, independent scheduler, or authorization to turn on any specialist. As of this checkpoint, **PLAN APPROVED / BUSINESS EXECUTION NOT YET QUALIFIED**. The existing `NOT_QUALIFIED_NO_SOT_ADAPTER` state remains truthful until individually proven otherwise. The canonical Supervisor project task remains `SC-013 = IN PROGRESS`; downstream project work must retain its own canonical SOT and task IDs.

**Owner's target:** Robot Tổng on **DESKTOP-H4A16IL** can automatically intake a validated task request, verify the exact executable task against the relevant project's live canonical SOT, assign it only to an explicitly Owner-enabled, separately qualified specialist, supervise result/QA and bounded same-task repair, then publish independently verifiable evidence. Owner approval is required at genuine SOT/production/finance/credential gates; a technical heartbeat or health-check is never WebApp completion.

**Five sequenced implementation/verification batches (do not advance a failed gate):**

1. **SOT Adapter / qualification (estimated 3–5 engineering hours).** Inventory existing Gateway SQLite intake, Coordinator plans, Supervisor task-control contract and each specialist's independent SOT. Add an allowlisted, read-only live-SOT resolver that verifies repository/path/revision, exact SOT task ID, task readiness, dependencies, per-target Owner-enable flag, STOP/AUTOSTART_DISABLED and scope. Reject ambiguous/stale/unavailable SOT, mismatched Issue task IDs, injection-like request bodies or unqualified robot targets. No free-text inference of authority. Unit tests must demonstrate fail-closed cases and an authorized `READY` fixture.
2. **Business Executor / durable dispatch (estimated 5–8 engineering hours).** Introduce an opt-in per-robot adapter interface for validated `execute_task` (and later `render_qc` / `sync_revenue` only under their own SOT gates). Use exact-once durable claim/lease/idempotency by issue/job + SOT task ID + approved revision, bounded attempts, crash-safe recovery, machine scoping and explicit worker acknowledgement. The Coordinator **must not START/STOP a disabled specialist**; persist `WAIT_OWNER_ENABLE` instead. Never synthesize a ChatGPT outbound send or replay an `ENQUEUED` transaction to prove dispatch. Start with a disposable, non-production fixture before any real eligible work.
3. **QA / classified AUTO_REPAIR (estimated 4–6 engineering hours).** Compare outputs against that project's DoD and test/CI/QC evidence, preserve the same task ID on failure, diagnose root cause, run impacted tests before required final gates, enforce distinct remediation, the existing three-attempt limit and CPU/RAM/time/cost budgets. Persist failure signatures and uncertainty. Genuine Owner decisions become `WAIT_OWNER`; technical failures without an approved repair path remain blocked with evidence, never fabricated as success.
4. **GitHub evidence + unified Control Center (estimated 3–5 engineering hours).** Idempotently post bounded, sanitized Issue/PR/run evidence and authoritative task status only after independent verification; render `RECEIVED`, `SOT_VERIFIED`, `WAIT_OWNER_ENABLE`, `ASSIGNED`, `EXECUTING`, `VERIFYING`, `AUTO_REPAIR`, `WAIT_OWNER`, `COMPLETE` and `NOT_QUALIFIED` in Vietnamese. Display real worker identity, phase, timestamps, last progress, retry count, resource usage, source SOT revision, evidence link and actual heartbeat freshness. A stale/dead worker must not appear running.
5. **End-to-end qualification and production gate (estimated 4–8 engineering hours).** Verify at least one approved non-production real Gateway -> SOT -> Coordinator -> enabled test executor -> QA -> evidence-return round trip, including exact-main verification after reviewed PR gates. Separately exercise duplicate request/reboot recovery, failed QA -> bounded repair, Owner STOP and specialist OFF/no-start, plus invalid/stale SOT rejection. Preserve isolated specialist processes and do not auto-activate SAPO/Media/Supervisor or mutate production finance/data. Production enablement requires the specific project's SOT and explicit applicable Owner approval.

**Planning estimate (not a deadline or evidence of execution):** Five principal engineering batches totaling **19–32 engineering hours**, provisionally **3–5 working days** depending on repository/CI/runtime readiness, followed by **24–48 hours of unattended operational observation**. With the already-configured 30-minute Windows heartbeat there are nominally **48 checks per 24 hours** or **96 per 48 hours**; each check is *observation/classification*, **not** a business task execution or completion. Do not promise continuous ChatGPT work or mistake elapsed observation time for active implementation.

**Acceptance/evidence requirements:**
- A GitHub PR with relevant affected tests, Supervisor Tests/Integrity and any lifecycle/qualification gates mandated by changed paths; reviewed before merge, exact-main verified afterward.
- One task with an *independently validated* canonical SOT ID travels through accepted intake, eligible specialist acknowledgement, actual work, task-specific QA, and idempotent GitHub result evidence, with no duplicate irreversible effects.
- Negative gates show that Owner STOP, disabled specialist, stale/missing SOT, bad actor/request, ambiguous receipt, resource ceiling and production-review requirement **prevent execution**.
- Restart simulation proves durable no-duplicate ownership and recoverable checkpoints; same failure signature cannot cause an unbounded retry loop.
- At least 24–48 hours' local monitoring evidence after functional acceptance, explicitly distinguishing on-time/missed Windows ticks, process liveness and verified business outcomes.
- Mark this program **COMPLETE** only after those evidence links, exact commit/run IDs and Owner-required approvals are recorded in this sole SOT. Until then, show `IN PROGRESS` / `NOT_QUALIFIED_NO_SOT_ADAPTER` honestly.

**Implementation safety:** This program does **not** supersede the independent Owner-controlled Robot Hub directive, SC-013 source-staging/apply boundaries, no-outbound-send rule for local 30-minute ticks, or the ongoing first-failure exact-once recovery. It creates no cross-robot auto-start and no new Supabase production project. Separate PR/qualification gates apply before business execution, source deployment or specialist activation.

### SC-013 Phase 1 — Read-only SOT Adapter source milestone (2026-10-09)

**Verified evidence (source only, NOT local deployment):** PR [#352](https://github.com/magasincoffee/magasin-supervisor/pull/352) was merged by squash at exact-main commit `75ae42aac811b2379eefd6abff7e1fa718f92558`. The merged code is `src/coordinator/sot-adapter.mjs` with `test/sc013-sot-adapter.test.mjs` and tests wired to required workflows. PR-head commit `056ae0a578bf6c1a89ba56b09b9913ae46b8b7d9` passed Supervisor Integrity #1531 (run 37905072294), Supervisor Tests #1411 (run 37905072384), Lifecycle Acceptance #1177 (run 37905072291), and Autostart Install #1214 (run 37905072379). Post-merge `main` was compared against the squash SHA and was identical.

**Scope and outstanding integration:** The module is a deliberately non-executing JavaScript verifier for the allowlisted Supervisor `SC-013` SOT request, with fail-closed source-revision, state, owner/STOP and machine checks. Actual SC-013 is **IN PROGRESS, not READY**; the fixture's `READY` PASS does **not** authorize production work. `D:\MAGASIN_ROBOTS\robots\coordinator\coordinator.py` remains a separately installed Python classification-only module; no Node->Python integration or approved local install of this adapter has been verified. In particular, the local `owner_enabled.json` placeholder does not prove an Owner lifecycle START. Retain `execution_enabled=false` and `NOT_QUALIFIED_NO_SOT_ADAPTER` / truthful equivalent until the local integration and fresh SOT/Owner gates are independently qualified.

**Next acceptance checkpoint within Phase 1:** Review and test an explicit read-only bridge compatible with the currently deployed Python Coordinator, using actual trusted Windows lifecycle evidence rather than flags supplied by GitHub issues; preserve one canonical task ID, machine/revision binding and no outbound. Stage any H4A16IL runtime changes only through a separately qualified SOT-compliant review/staging boundary; the existing SC-013 H4 apply rule authorizes only the specifically reviewed single-conversation runtime patch and must not be stretched silently to install this adapter. Business dispatch and Phase 2 remain out of scope until this checkpoint passes.

### SC-013 Windows 30-minute local execution fallback (Owner 2026-10-09)

Live evidence established **GitHub Actions cron did not create a scheduled run at 13:47 local time on 2026-10-09**, so the existing `17,47 * * * *` workflow must be treated as a **best-effort backup/reporting path, not a guaranteed local clock**. On `DESKTOP-H4A16IL`, the Owner now authorizes one Windows Task Scheduler item `MAGASIN SC013 Local 30min` under the interactive `admin` account, repeating every 30 minutes aligned to 13:47 / 14:17 local (+07:00). This is **not a privileged SYSTEM task** or an automatic specialist START. Versioned installer/verifier: `.github/scripts/install-sc013-local-windows-task.ps1`; versioned technical tick: `.github/scripts/sc013-local-30m-tick.py` with `--local-task`, installed at `D:\MAGASIN_ROBOTS\robots\coordinator\sc013-local-30m-tick.py`. A local-task run must not require any GitHub Actions token or claim a GitHub Actions heartbeat; it may write only its own durable local evidence `D:\MAGASIN_ROBOTS\control-center\state\sc013-local-30m.json` and the separate sanitized ChatGPT-monitor cache, not GitHub Issue #347 directly.

The task is configured with `StartWhenAvailable=True` (catch up when applicable), `MultipleInstances=IgnoreNew`, maximum runtime 5 minutes and a low-risk local worker command. If Owner is logged out or machine powered down, **interactive-account execution is not guaranteed**; no claim of Windows-service-grade 24/7 service until a separate elevated Owner-approved service credential/setup and reboot acceptance. Read-only dashboard may recognize `local_windows_scheduler` and `local_github_runner` as **distinct verified executors**, with heartbeat freshness (stale if older than 75 minutes). It must never call the local tick a ChatGPT run or confuse technical classification with a business `DONE`.

First actual Windows Task Scheduler proof (Owner-authorized): registration succeeded under `admin`, `Run` invoked without direct script execution, LastTaskResult=`0`, created a fresh durable heartbeat at **2026-10-09T06:57:42Z** with `gateway=PASS`, `coordinator_classify=PASS`, `CHECKED_AND_CLASSIFIED`, and `business_execution=NOT_QUALIFIED_NO_SOT_ADAPTER`; next scheduled local slot verified at 14:17:17 +07:00. A prior attempted SYSTEM registration was blocked with `Access is denied` and was not forced or elevated. The real 14:17 scheduled (not manually started) acceptance is still pending. When Windows has a fresh verified heartbeat within 45 minutes, the existing twice-hourly GitHub Actions workflow must skip duplicate Gateway/Coordinator work and only run its receipt reporting; otherwise GitHub may perform a fail-closed backup tick when Actions cron actually arrives. No Supervisor browser command or production mutation may be inferred from this health-check.

### SC-013 local thirty-minute monitoring and qualified work (Owner 2026-10-09)

The Owner authorizes **SC-013 monitoring and already-qualified safe work every 30 minutes** on `DESKTOP-H4A16IL`, without requiring a new ChatGPT message each cycle. The existing allowlisted workflow `.github/workflows/magasin-local-dispatch-receipts.yml` has `17,47 * * * *` UTC schedule and now invokes `.github/scripts/sc013-local-30m-tick.py` on scheduled/manual runs only. Do not create a second independently scheduled coordinator or auto-start a specialist. GitHub Actions cron is best-effort, so missed/delayed runs must be shown as **STALE**, never fabricated as on time.

The local tick may (1) invoke the existing strictly validated GitHub/Supabase-dispatch Gateway **once**, where non-read-only tasks remain `WAIT_SOT_AUTHORITY`, (2) run the existing read-only Coordinator classification once without changing Owner-enable flags or running any specialist, (3) inspect persisted Supervisor, Guardian, outbound, Gateway and queue state, and (4) write an atomic local status under `D:\MAGASIN_ROBOTS\control-center\state\sc013-local-30m.json` plus one sanitized evidence heartbeat to GitHub Issue **#347**. The existing receipt reporter can still post state transitions on individual validated dispatch Issues. The tick may not mutate the exact-once ledger, send or replay a ChatGPT transaction, launch or stop Chrome, remove Owner STOP, start disabled specialists, apply production patches or mark a health-check as business DONE.

**Separate sources of truth for monitoring:** ChatGPT's own scheduled monitor remains at its supported hourly cadence and is tracked by actual run heartbeat in GitHub Issue **#346**. Local tick may read that issue and cache a sanitized status under `sc013-chatgpt-monitor.json`; it must NEVER represent its own 30-minute run as a ChatGPT run. If Issue #346 lacks a valid timestamped heartbeat, its UI state is `UNVERIFIED`, not running. A stale local heartbeat means no fresh evidence, regardless of process presence.

This is an intermediate safe automation layer. Autonomous `execute_task`, code repair, deployment, multi-cycle QA and Supervisor restart still require separate SOT-qualified adapters, explicit Owner enable, exact task authorization, time/resource budgets and acceptance evidence. Blocked work must be shown as **NOT_QUALIFIED_NO_SOT_ADAPTER**, not `DONE`. Future business execution may be added only in a separately reviewed PR and successful exact-main gates. Source changes and workflow updates must pass Supervisor Integrity and Tests; deployment on H4A16IL is constrained independently by the stage/apply SOT boundary.

### SC-013 local GitHub receipt relay (Owner implementation 2026-10-09)

The Owner authorizes a limited **GitHub -> Local MCP -> GitHub receipt** channel on **DESKTOP-H4A16IL**, not general executable instructions or automatic specialist launches. The GitHub workflow `.github/workflows/magasin-local-dispatch-receipts.yml` is added to the explicit active-workflow allowlist. It runs on a Windows self-hosted runner but MUST verify the target host before accessing local data. The trusted input must be a GitHub Issue authored by `magasincoffee` with the exact allowlisted `MAGASIN_DISPATCH_V1` schema and canonical per-target SOT URL. An issue title/body is only an untrusted request, never SOT authority.

The reporter `.github/scripts/magasin-dispatch-reporter.py` may read `C:\MAGASIN_MCP\state\jobs.sqlite3`, request a safe Github gateway poll, inspect durable read-only health-check results, and post a bounded, idempotent result comment on the same Issue using the ephemeral GitHub Actions `GITHUB_TOKEN` with **issues:write** only. On new issues and on periodic scheduled checks, post only when the stable source state/result changes. An action marked `WAIT_SOT_AUTHORITY` MUST remain blocked: a notification is NOT authorization for execution. `HEALTH_CHECK_COMPLETE` is not business `DONE`. Do not expose credentials, conversation message text or URLs, or unbounded local logs in reports. This workflow must not touch any live Supabase project, automatically launch specialist robots, clear STOP, reset ENQUEUED, replay browser sends, or mark project acceptance without required SOT gates.

The reporter does **not** make localhost MCP directly reachable from this ChatGPT conversation; it is an asynchronous authorized GitHub control-plane bridge. Acceptance requires: valid issue -> durable SQLite intake -> read-only worker evidence -> comment on the same issue, duplicate status -> no duplicate comment, hostile issue -> rejected, non-target runner -> fail closed, stalled business task -> `WAIT_SOT_AUTHORITY` with no side effects, post-merge exact-main evidence. This relay is independent of unresolved Supervisor browser/CDP exact-once repair.

### SC-013 Coordinator isolated read-only staging (Owner 2026-10-09)

**Authorization is limited to staging source candidates, NOT applying them to an installed runtime.** After PRs #352, #354, and #355 qualified the JavaScript SOT Adapter, bounded JSON preflight CLI and Python Gateway bridge at source level, the Owner delegates a **separate source-only candidate STAGE** on DESKTOP-H4A16IL. This is a narrow exception to the H4 Supervisor single-conversation runtime patch authority below; that legacy Stage/Apply workflow remains unchanged. This new Coordinator STAGE creates no runnable scheduled service, changes no production script or local Coordinator installation, and does not authorize Business Executor.

Canonical additional active workflow: `.github/workflows/sc013-coordinator-readonly-stage.yml`; canonical stage script: `.github/scripts/sc013-coordinator-readonly-stage.ps1`. The workflow is **manual `workflow_dispatch` or explicitly reviewed `.github/sc013-coordinator-stage-request.json` push to `main` only**, never ordinary `src/**`, SOT or PR merges. It shares the H4 safe-deploy concurrency lock, is single-job, and must reject a non-H4A16IL runner before checkout/local access. No GitHub token writes, automation actions, or production deploy rights.

STAGE qualification checks: exact checked-out SHA equals fresh authoritative `main`, narrowly allowlisted three source files (`sot-adapter.mjs`, `sot-preflight-cli.mjs`, `sot-preflight-python-bridge.py`), existing local Coordinator identity, sufficient D: space, strict source/candidate SHA-256 equality, Node syntax, Python syntax-only AST parsing, and one immutable manifest under `D:\MAGASIN_ROBOTS\deploy\sc013-coordinator-readonly\<exact-main-sha>\manifest.json`. All candidate files remain in that **isolated D: deploy directory**; they are **NOT installed** into `D:\MAGASIN_ROBOTS\robots\coordinator` or Gateway, Supervisor or scheduler paths. Duplicate staging at the same SHA must fail for inspection rather than overwrite a previous manifest. Stage may record a STOP latch read-only but may NEVER clear it, start/stop a worker, issue ChatGPT outbound, change business inbox/ledger, or report work completed.

Acceptance for **this staging-only checkpoint** requires Supervisor Tests/Integrity/Lifecycle/Autostart CI GREEN on reviewed source, merge and exact-main PASS, then one explicit marker/manual stage on H4A16IL with independently inspected manifest SHA, source hashes, timestamp, and local path isolation. Any missing/failed evidence remains STAGING_NOT_QUALIFIED. A separate **future** SOT-revised PR and positive Owner approval are mandatory before any `CoordinatorApply`, Python Coordinator integration, background scheduling, Business Executor, or specialist activation. STOP/OFF remain authoritative. Never reinterpret STAGED as INSTALLED, `SOT_PREFLIGHT_READY_NOT_AUTHORIZED` as permission, or a technical health check as WebApp DONE.

### SC-013 Coordinator isolated STAGE evidence — qualified 2026-10-09 (source only)

**Checkpoint:** ISOLATED_STAGE_PASS / LOCAL_INSTALL_NOT_AUTHORIZED / BUSINESS_EXECUTION_NOT_QUALIFIED. Source/staging authority was added by PR [#356](https://github.com/magasincoffee/magasin-supervisor/pull/356), exact-main merge `5d01b9e496ab4ba4c2356b879644dcc92c956fcb`. All four mandatory hosted gates passed on PR head `4f89df07559fdf120e09ec95cbc392b16791b6ab`: Integrity run `37908800467`, Supervisor Tests `37908800635`, Lifecycle `37908800716`, Autostart `37908800700`. Single reviewed stage marker PR [#357](https://github.com/magasincoffee/magasin-supervisor/pull/357) merged to exact-main `5e01d05a7846ca78abcb895fecd7409e992502bc` and triggered isolated STAGE, not a Supervisor deployment.

Independent H4A16IL inspection found `D:\MAGASIN_ROBOTS\deploy\sc013-coordinator-readonly\5e01d05a7846ca78abcb895fecd7409e992502bc\manifest.json`, `schema=MAGASIN_SC013_COORDINATOR_STAGE_RESULT_V1`, `mode=STAGED_READ_ONLY_NOT_INSTALLED`, `checked_at=2026-10-09T09:06:08.5234250Z`, correct machine and exact marker commit. SHA-256 of all three staged files was independently recalculated directly on D: and matched the manifest: `sot-adapter.mjs=4fd963a6fa5d2f965d6bc8e5230a94dbab368d015e3c9868bb97a191550881fe`; `sot-preflight-cli.mjs=081a5469d9ebe25309e99add701af44881565b37744f6df351ff9a98b1f305e7`; `sot-preflight-python-bridge.py=16474c9157a1900c9180b07f06bed88adf86eef1bcf39edf209c450e7b5757e6`. The live Coordinator bridge file was absent, live Coordinator remained `OFF_OWNER_MANUAL` with `execution_enabled=false`, and the manifest explicitly reported no Coordinator replacement, no Supervisor lifecycle action, no ChatGPT outbound, and no qualified business execution. Evidence also posted to [SC-013 Issue #339](https://github.com/magasincoffee/magasin-supervisor/issues/339).

**Next authorized boundary:** Plan and review a separate H4A16IL Coordinator APPLY/install gate with explicit fresh Owner approval, real Owner-enable/STOP constraints, rollback, no implicit Windows Task scheduling or worker START, and exact-main matching. Because any later merge advances `main`, the historical marker-stage manifest must **not** be blindly reused as APPLY authority: stage a fresh reviewed current-main candidate, or prove an explicitly approved immutable equality rule, before installation. Do not mark Phase 1 live integration or SC-013 DONE based on this staging evidence.

### SC-013 inert Coordinator bridge local APPLY (Owner approved 2026-10-09)

**Owner decision:** Following independent H4A16IL isolated staging verification, Owner explicitly approved the next **Coordinator-only APPLY/install**. This authority permits installing exactly three previously-reviewed, inert, read-only source modules beside the existing Python Coordinator on **DESKTOP-H4A16IL**. It is **NOT** permission to turn ON the Coordinator, Supervisor, SAYDI, SAPO, ChatGPT outbound, a new Windows Task, or any Business Executor; not a WebApp release gate.

**Canonical extra workflow:** `.github/workflows/sc013-coordinator-inert-apply.yml`. **Canonical guarded installer:** `.github/scripts/sc013-coordinator-inert-apply.ps1`. Both are activated only by a separately reviewed, explicit `.github/sc013-coordinator-apply-request.json` commit merged into `main` (no `schedule`, no ordinary source push, no `workflow_dispatch` default to APPLY). Active workflow/script allowlists include these two items. The APPLY workflow uses the same H4 safe-deploy concurrency group as the existing Supervisor and Coordinator STAGE lanes. It must check the H4 machine identity before checkout/local access, use an exact checkout/current `main` SHA, first create an **independent fresh, isolated STAGE under that same exact marker SHA** using the existing reviewed `sc013-coordinator-readonly-stage.ps1`, and only after successful staged SHA-256/manifest validation run the APPLY installer in a distinct step. Historical staged manifests from older `main` commits cannot be reused as execution authority.

**Scope/guards for first install:** The marker must confirm the Owner's approved `INSTALL_INERT_READ_ONLY_FILES` scope, `source_commit` provenance in current `main` ancestry, no specialist activation and `business_execution_enabled=false`. Re-read fresh SOT, STOP and AUTOSTART_DISABLED latches, and Coordinator state at each installation boundary; fail closed unless `mode=OFF_OWNER_MANUAL`, `execution_enabled=false`, and all three specialist `owner_enabled` values are strictly false. Reject any running Coordinator/preflight worker, wrong target, stale/missing manifest, altered SHA, incomplete/duplicate source, unexpected existing destination, resource insufficiency, source directory reparse/symlink or ambiguity. Any Owner STOP arising before or during installation must abort and roll back safely; **do not clear STOP or start/restart a worker**.

**Allowed write set only:** Add `sot-adapter.mjs`, `sot-preflight-cli.mjs`, `sot-preflight-python-bridge.py` under `D:\MAGASIN_ROBOTS\robots\coordinator` if and only if each destination is absent and candidate/source/hash matched. Stage/backup/installation manifests belong under isolated `D:\MAGASIN_ROBOTS\deploy\sc013-coordinator-readonly\<exact-main-sha>`. Preserve a hash-verified backup of the *unchanged* `coordinator.py`; never overwrite or patch it in this APPLY. On a caught failure, remove only unchanged files created by that attempt, retain D: rollback backup and record failure. An interrupted partial install requiring file recovery remains **BLOCKED_TECHNICAL** for reviewed repair, never silently re-run or mark success. No existing production file replacement, Scheduler modification, SQLite mutation, or browser/ChatGPT interaction.

**Acceptance:** Reviewed implementation PR and mandatory Supervisor Tests, Integrity, Lifecycle Acceptance and Autostart Install all GREEN; exact-main verified; a separate approved marker triggers precisely one stage→apply run; host installation receipt must report `INSTALLED_INERT_FILES_NOT_INTEGRATED`, three matching local SHA-256 hashes, `coordinator_py_hash_unchanged=true`, `business_execution_qualified=false`, `chatgpt_outbound=false`; independent local read-back must verify the same. Installation does **not** modify `coordinator.py` to call the bridge and does **not** schedule any new work. A future separately reviewed/approved integration and qualification step is necessary before using the adapter in the Coordinator run loop, and a separate Phase 2 approval is necessary before business task dispatch.

### SC-013 Coordinator inert APPLY checkpoint — live H4A16IL acceptance 2026-10-09

**Phase 1 status:** INERT_LOCAL_FILES_INSTALLED / READ_ONLY_PREFLIGHT_PASS / BUSINESS_EXECUTION_NOT_QUALIFIED. Owner-approved guarded local APPLY source was merged in [PR #359](https://github.com/magasincoffee/magasin-supervisor/pull/359) at exact-main SHA `346d052aea020180ba37e21644c3fd61096538ea`; Supervisor Tests, Integrity, Lifecycle Acceptance and Autostart Install all passed at that PR head. The explicitly approved single-apply marker [PR #360](https://github.com/magasincoffee/magasin-supervisor/pull/360) merged at exact-main SHA `69031404a843a85056f53fe50819c9ac8839dc2d`.

**Independent machine evidence:** the workflow on `DESKTOP-H4A16IL` created the fresh same-SHA candidate stage and `D:\MAGASIN_ROBOTS\deploy\sc013-coordinator-readonly\69031404a843a85056f53fe50819c9ac8839dc2d\installation.json`, `schema=MAGASIN_SC013_COORDINATOR_APPLY_RESULT_V1`, `result=INSTALLED_INERT_FILES_NOT_INTEGRATED`, `installed_at=2026-10-09T09:23:17.1859508+00:00`. The independently recalculated *installed* SHA-256 hashes on D: matched the fresh stage and receipt: `sot-adapter.mjs=4fd963a6fa5d2f965d6bc8e5230a94dbab368d015e3c9868bb97a191550881fe`, `sot-preflight-cli.mjs=081a5469d9ebe25309e99add701af44881565b37744f6df351ff9a98b1f305e7`, `sot-preflight-python-bridge.py=16474c9157a1900c9180b07f06bed88adf86eef1bcf39edf209c450e7b5757e6`. The live `coordinator.py` remained byte-identical to its D: backup, SHA-256 `cf3619e6928bbb1c650baef68b00e06e9790b011fabc3777b6fd021d15ce1bd7`.

**Read-only functional smoke:** running the installed Python bridge directly on H4 yielded `mode=READ_ONLY`, `probes=1` for real Gateway receipt `github:magasincoffee/magasin-supervisor:issue:339`. The pinned live SOT at revision `69031404a843a85056f53fe50819c9ac8839dc2d` returned `SOT_PREFLIGHT_BLOCKED`, `reason=TASK_NOT_READY`, `task_state=IN PROGRESS` for canonical `SC-013`, with `execution_qualified=false`, `dispatched=false`, `business_completed=false`. This is the **expected PASS for fail-closed authorization**, not a business task rejection incident. Separate machine read-back confirmed `coordinator.py` unchanged, Coordinator `OFF_OWNER_MANUAL`, `execution_enabled=false`, all three specialist owner flags false, no STOP/AUTOSTART_DISABLED latch, and installation receipt `worker_started_or_stopped=false`, `windows_scheduler_modified=false`, `chatgpt_outbound=false`. Durable evidence is posted on [Issue #339](https://github.com/magasincoffee/magasin-supervisor/issues/339).

**Remaining Phase 1 / next separate authority:** source modules are now **installed but inert**, not imported or scheduled by `coordinator.py` or the half-hour technical tick. An independently reviewed narrow Python Coordinator call-site integration, trusted Gateway receipt/author verification, true Owner lifecycle guard acquisition (not local placeholder flags), bounded read-only tests and the applicable SOT Owner gate remain necessary before automatic classification can use the live preflight. Do not silently enable Coordinator or specialists. This checkpoint does not qualify the Business Executor, auto-repair, GitHub business writeback, or MAGASIN WebApp DONE. No reinstallation of identical immutable source is needed merely because later documentation-only `main` commits advance; any new executable source revision must be separately reviewed and staged.

### SC-013 read-only Coordinator cycle integration (Owner 2026-10-09)

**Owner approval:** Continue Phase 1 after independent inert-bridge installation. Integrate an **inspection-only** SOT call into the existing `coordinator.py once` cycle of the already authorized 30-minute H4A16IL technical heartbeat. This is not authorization to start Coordinator, Supervisor, SAYDI or SAPO, change Worker/Owner lifecycle or send outbound ChatGPT messages, and is not approval of Phase 2 Business Executor. Live Coordinator stays `OFF_OWNER_MANUAL`, `execution_enabled=false`, specialist Owner-enable flags all false, and existing SQLite plans/health-check decisions remain the same.

**Proposed code boundaries:** Canonical reviewed source is `src/coordinator/coordinator.py`, a mirror of the existing H4 `D:\MAGASIN_ROBOTS\robots\coordinator\coordinator.py` with a single bounded `safe_preflight_readonly()` diagnostic hook before writing the ordinary Coordinator report. The hook may invoke only the **already installed, hash-verified** adjacent `sot-preflight-python-bridge.py` using `sys.executable` and an argv list, without shell, timeout at most 11 seconds, bounded JSON output and refusal of any response asserting `dispatched=true`, `execution_qualified=true` or `business_completed=true`. It must never promote `SOT_PREFLIGHT_READY_NOT_AUTHORIZED` into a task executable status. Read-only SOT inspection appears only as `coordinator-status.json.sot_preflight`, with `status`, `probes`, sanitized `task_state`/revision/reason and explicit non-execution flags; cannot change Coordinator plan stage `WAIT_OWNER_ENABLE` to `READY` when a specialist is OFF.

**Additional reviewed deployment boundary:** `.github/workflows/sc013-coordinator-hook-apply.yml` (single Owner marker-only H4 workflow, no schedule or generic branch trigger) and `.github/scripts/sc013-coordinator-hook-apply.ps1` (guarded exact-main, source-hash-pinned installer) are added to active workflow/script allowlists. This one-shot apply is allowed **only** after a separate reviewed merge of `.github/sc013-coordinator-hook-apply-request.json` with Owner-approved scope `APPLY_READ_ONLY_HOOK_ONLY`, a SHA-256 of the current installed `coordinator.py` matching the previously accepted and independently read `cf3619e6928bbb1c650baef68b00e06e9790b011fabc3777b6fd021d15ce1bd7`, and a `source_commit` that is an ancestor of exact live `main`. The workflow serializes with the other H4 safe-deploy lanes and rejects wrong machine before checkout.

**Safety and rollback:** Before each local update, independently verify live `main`, existing Coordinator `OFF_OWNER_MANUAL`, all Owner-enable flags false, STOP/AUTOSTART_DISABLED latches absent, old source hash unchanged, installed SOT Adapter/CLI/bridge hashes equal the accepted inert APPLY receipt, scheduled `MAGASIN SC013 Local 30min` not running, no relevant Python/Node Coordinator/preflight process active, D: space and no symlink/reparse directory drift. Stage only the new `coordinator.py` candidate and an independently hash-verified backup of its old bytes at `D:\MAGASIN_ROBOTS\deploy\sc013-coordinator-hook\<exact-main-sha>\`; parse via Python AST before touching live. Move a verified temporary replacement atomically on D:, verify installed hash and repeat STOP/OFF gates, then write a bounded D: install receipt. On an identified failure, roll back only the known source bytes from the independently verified backup; an interrupted/ambiguous replacement is **BLOCKED_TECHNICAL**, never auto-replayed. Do not modify Scheduler configuration, Gateway DB, live Supervisor runtime, specialist files or owner state.

**Test/acceptance requirements:** Supervisor Integrity, Supervisor Tests, Lifecycle Acceptance and Autostart Install hosted CI GREEN on the exact PR commit; exact-main verification after merge; separate one-shot Owner marker for APPLY; independent host read-back of old/new file hashes, installed receipt, STOP/OFF, Scheduler unchanged; a **read-only** `coordinator.py once` smoke test shows at least one live Gateway receipt SOT classification with `SC-013 IN PROGRESS -> TASK_NOT_READY`, `execution_enabled=false`, `dispatched=false` and unchanged `WAIT_OWNER_ENABLE` plan gating. If network/GitHub fails, report `BRIDGE_FAILED_CLOSED` without stalling the existing cycle or allowing work. The live read-only classification MUST NOT mark SC-013 DONE or infer an active worker.

**Further gates:** Only after the above evidence has been recorded in this sole SOT can Phase 1 be considered integrated at the inspection-only level. Trusted live Owner-enable lifecycle qualification, Business Executor, bounded QA, return evidence and 24–48-hour soak each remain separate gated work; do not activate them automatically.

### SC-013 Coordinator live read-only SOT cycle integration — accepted 2026-10-09

**Checkpoint:** PHASE1_READ_ONLY_CYCLE_INTEGRATED / BUSINESS_EXECUTION_NOT_QUALIFIED. [PR #362](https://github.com/magasincoffee/magasin-supervisor/pull/362) added a bounded `safe_preflight_readonly()` call to `src/coordinator/coordinator.py` without changing the existing `WAIT_OWNER_ENABLE` or `execution_enabled=false` logic. Four mandatory hosted checks GREEN at head `6f0054502915ef965f75341fd0f2108534b537a9`: Supervisor Integrity `37912823113`, Supervisor Tests `37912823063`, Lifecycle Acceptance `37912823040`, Autostart Install `37912823020`. Source rollout gate merged exact-main `7dc6c578a9d2678e1048db4e7d9be11d74a85f7a`.

Owner-approved [PR #363](https://github.com/magasincoffee/magasin-supervisor/pull/363) triggered one-time H4A16IL APPLY at exact-main `85db0e3c580020573e9ede0300e1606a4b4605f2`. Local receipt `D:\MAGASIN_ROBOTS\deploy\sc013-coordinator-hook\85db0e3c580020573e9ede0300e1606a4b4605f2\installation.json` reports `INSTALLED_READONLY_HOOK_NOT_EXECUTOR` at `2026-10-09T09:43:41.9957770+00:00` (local 16:43:41), no worker START/STOP, no new Scheduled Task, no business execution and no ChatGPT outbound. Independent installed and staged `coordinator.py` SHA-256 are both `fe4cfc261a06fdb42a6a1053697344d6990ef47f747cc073eb056ae9f62f93dd`; pre-change D: rollback backup is `cf3619e6928bbb1c650baef68b00e06e9790b011fabc3777b6fd021d15ce1bd7`.

**Live functional smoke:** A direct `coordinator.py once` call on DESKTOP-H4A16IL completed exit `0` in approximately 3.38 seconds and updated its existing Coordinator report, without creating new tasks. It retained `mode=OFF_OWNER_MANUAL`, `execution_enabled=false`, 9 classified Gateway rows, `8 HEALTH_CHECK_DONE` and `1 WAIT_OWNER_ENABLE`, all three specialists Owner OFF. New `sot_preflight` field reported `READ_ONLY_CLASSIFIED`, `probes=1`, GitHub Gateway receipt Issue `#339`, `SC-013`, canonical live SOT `IN PROGRESS`, `TASK_NOT_READY` and pin `85db0e3c580020573e9ede0300e1606a4b4605f2`, always `execution_qualified=false`, `dispatched=false`, `business_completed=false`. Thus the expected fail-closed path is verified with a real GitHub/Gateway receipt, not only with mock tests.

**Existing 30-minute scheduler:** Read-only Windows inspection after installation confirmed the same task name `MAGASIN SC013 Local 30min` at state `Ready`, same `C:\MAGASIN_MCP\.venv\Scripts\python.exe` invocation of `D:\MAGASIN_ROBOTS\robots\coordinator\sc013-local-30m-tick.py --local-task`, last task result `0`, last scheduled run 2026-10-09 16:17:17 and next 16:47:47 local time. That existing technical tick invokes `coordinator.py once` and will therefore use the newly integrated read-only preflight without a new Scheduler workflow. The direct smoke is not proof that a later autonomous tick ran after the hook deployment; capture a fresh scheduled heartbeat separately for endurance/steady-state qualification.

**Independent first post-install automatic tick:** A fresh `MAGASIN_LOCAL_30M_TICK_V1` heartbeat written on H4A16IL with `executor=local_windows_scheduler` showed `checked_at=2026-10-09T09:47:02+00:00` and `completed_at=2026-10-09T09:47:06+00:00`, both Gateway and Coordinator classifier exit code `0`, `errors=[]`. The independently read Coordinator report's timestamp was `2026-10-09T09:47:05.986260+00:00` and its `sot_preflight` inspected one real Issue `#339` receipt: canonical `SC-013 IN PROGRESS`, `TASK_NOT_READY`, pinned revision `85db0e3c580020573e9ede0300e1606a4b4605f2`, and all of `execution_qualified=false`, `dispatched=false`, `business_completed=false`. Owner flags and `execution_enabled` remained false with `8 HEALTH_CHECK_DONE` + `1 WAIT_OWNER_ENABLE`. Task Scheduler read-back reported `Ready`, `LastTaskResult=0`, `LastRunTime=16:47:47` local and `NextRunTime=17:17:17` local; Scheduler metadata's last-run seconds differed from heartbeat's recorded check time, so rely on the independently matching heartbeat/report records for this cycle's event chronology rather than claiming exact scheduled trigger seconds from metadata. This proves the **scheduled read-only SOT integration** executed without business side effects. The technical heartbeat's legacy string `NOT_QUALIFIED_NO_SOT_ADAPTER` has not yet been revised; it does **not** override the new direct SOT preflight evidence. A later bounded, reviewed change should relabel it `NOT_QUALIFIED_NO_BUSINESS_EXECUTOR` or an equally truthful non-executing state, without changing worker authority.

**Not complete:** SOT inspection is now wired into the classifier only. `WAIT_OWNER_ENABLE` is not permission to execute; no trusted live Owner-enable lifecycle source, Business Executor, specialist dispatch/acknowledgement, QA, repair, automatic GitHub business result writeback or multi-day soak has been qualified. Keep SC-013 `IN PROGRESS`; do not classify WebApp as delivered. Evidence is also posted to [Issue #339](https://github.com/magasincoffee/magasin-supervisor/issues/339). The next safely executable milestone is to qualify trusted per-robot Owner lifecycle evidence **without enabling any robot**, and to test receipt authenticity/duplicate handling before proposing real dispatch.

### SC-013 Owner Coordinator READ_ONLY lifecycle (approved 2026-10-09)

**Owner direction:** Owner requested to **START Robot Tổng** after the Phase 1 read-only SOT integration was accepted, then explicitly approved implementation of the missing local Owner START/STOP controls and later gated Business Executor. On H4A16IL, a real Coordinator business-execution START is **not currently qualified**. This decision approves a **separately labeled, local Owner START/STOP for SOT monitoring only** as the next increment, without implicitly lifting Phase 2 qualification gates or marking SC-013 COMPLETE. Do not enable specialists or send ChatGPT outbound as part of this control feature.

**Canonical source:** `src/coordinator/owner_lifecycle.py` is a lightweight, no-subprocess local Owner control adapter for the existing Windows 30-minute inspection tick. The canonical separate local Control Center mirrors are `src/control-center/server.py` and `src/control-center/web/app.js`. START requires the existing loopback-only local Control Center with strict same-origin, exact CSRF and confirmation `START_COORDINATOR_READ_ONLY`; STOP requires `STOP_COORDINATOR`. Preserve the existing Supervisor control route and its independent confirmation strings unchanged. Both actions use a separate, durable atomic `D:\MAGASIN_ROBOTS\robots\coordinator\state\owner-lifecycle.json` generation and exclusive lock. STOP persists across reboot. An unexplained lock/pending write cannot be silently cleared or treated as START.

**Owner lifecycle safety gates:** Require exact `DESKTOP-H4A16IL` machine identity, fresh independently signed-by-executor-format Windows local tick evidence with Gateway+Coordinator PASS and maximum age 75 minutes, local coordinator `OFF_OWNER_MANUAL` with `execution_enabled=false`, all three specialist owner flags exactly false, no Supervisor `STOP`/`AUTOSTART_DISABLED` latch, no unexpected lifecycle state, and at least 0.75 GiB available RAM. Lock acquisition and local file writes must fail closed. STOP remains available on the authorized machine even when START is blocked by stale monitoring, low memory, an invalid SOT, or a specialist gate. A positive START must first show `ARMED_READ_ONLY`, not `RUNNING`; display `MONITORING_READ_ONLY` only after a new independently verified technical tick finishes after that START and is still fresh. Stale/missed ticks must not appear running. All states must retain `execution_enabled=false`, `business_dispatch_enabled=false`, `specialists_started=false`.

**What this does NOT do:** Owner START of the Coordinator inspection layer does not create or launch a long-running worker, start/stop Supervisor, SAYDI or SAPO, change their individual lifecycle authority, clear any STOP latch, alter Windows Scheduler registration, mutate finance/workforce/OPS, interpret `SOT_PREFLIGHT_READY_NOT_AUTHORIZED` as executable, or enable the Business Executor. The existing technical 30-minute heartbeat is independent and can continue reporting health during Owner STOP without violating that STOP. Operator UI must reflect this honestly, show actual SOT classification, and distinguish `ARMED_READ_ONLY`, `MONITORING_READ_ONLY`, `OWNER_STOPPED`, and `BLOCKED_SAFETY`; no imaginary worker liveness.

**Release boundary and acceptance:** Source implementation PR requires hosted Supervisor Integrity, Supervisor Tests, Lifecycle Acceptance and Autostart Install all GREEN, then exact-main verification. A **separately reviewed marker-only** H4A16IL local staging/apply gate must be added to this SOT before any production Control Center or Coordinator file mutation. That gate must hash-verify original live `server.py`/`app.js` and existing bridge, stage/backup exact known bytes, check control port/related PID identity, STOP and resource safety, update only the three allowlisted files, preserve the existing Supervisor control, and roll back on failure. If necessary, restart **only the local Control Center view**, not Supervisor or any specialist; verify on a real loopback request that CSRF and STOP work, no unintended worker process started, and after an approved START one new 30-minute tick transitions ARM to MONITORING. Do not expose the Control Center to external interfaces. Any failure must remain BLOCKED_TECHNICAL with evidence and no retry loop. **Business Executor = NOT_QUALIFIED** until a separate approved source/QA/Owner/SOT gate demonstrates an exact-once test-worker cycle, then later production approval. The existing local read-only monitoring tick must remain serviceable if Owner START/STOP UI installation is blocked.

### SC-013 Owner Control Center gated local APPLY (2026-10-09)

**Separate Owner-reviewed installation authority:** Following PR #365's 4 hosted CI GREEN and exact-main, the Owner has authorized a guarded **local Control Center START/STOP UI installation for Coordinator SOT monitoring only**. The canonical one-shot workflow is `.github/workflows/sc013-owner-control-apply.yml`; the only installer is `.github/scripts/sc013-owner-control-apply.ps1`. They belong to the SC-013 active workflow and script allowlists. The workflow is triggered ONLY by an explicitly reviewed `.github/sc013-owner-control-apply-request.json` file merged onto `main` (no generic source push, schedule, or auto-unattended restart) and shares the H4A16IL safe-deploy concurrency group. Require exact target host, exact git checkout/live `main` SHA, matching SOT heading, marker `INSTALL_OWNER_READONLY_UI`, Owner-approved `source_commit` in `main` ancestry, `business_execution_enabled=false`, `start_robots=false`, and no ambiguous preexisting source or deployment receipt.

**Allowed local write set only:** Three candidates already green on source: install `src/coordinator/owner_lifecycle.py` as `D:\MAGASIN_ROBOTS\robots\coordinator\owner_lifecycle.py` (add-only, existing destination must be absent), replace only `D:\MAGASIN_ROBOTS\control-center\server.py` and `D:\MAGASIN_ROBOTS\control-center\web\app.js` after exact expected old hashes. Do not alter `coordinator.py`, Gateway, worker control flags, source-of-truth tasks, Windows Scheduler registration, any specialist script, browser state or outbound transactions. Verify original `server.py` SHA-256 `7d9539a051d63b78dfea87a6cb1b95c7a718c8259196e8dc0bbf1b0534e8c1eb`, `app.js` SHA-256 `2ffe63256f8b37d734aacda63c1d740254f699f01cc1610a752475e2c7a2ab07`, and unchanged Coordinator `coordinator.py` SHA-256 `fe4cfc261a06fdb42a6a1053697344d6990ef47f747cc073eb056ae9f62f93dd`. Revalidate installed SOT bridge and all three specialist flags OFF, Coordinator `execution_enabled=false`, STOP/AUTOSTART_DISABLED absent, technical 30-minute task not RUNNING, at least 0.75 GiB available RAM, D: space, no reparse directories and exclusive deployment lock.

**Stage/backup/rollback:** Before touching installed files, copy all source candidates to an isolated `D:\MAGASIN_ROBOTS\deploy\sc013-owner-control\<exact-main-sha>\candidate` and verify SHA-256 and Python AST/Node syntax; copy old server and JS to a verified `backup` subdirectory. Port 8781 must be uniquely bound to `127.0.0.1` by one confirmed `D:\MAGASIN_ROBOTS\control-center\server.py` process. Only that **Control Center view process** may be stopped during the swap and restarted through its existing `START_CONTROL.ps1 -StartOnly`, with no Chrome startup; no Supervisor or robot process START/STOP is permitted. Inspect healthz and new coordinator control API in place; it must initially report `OWNER_STOPPED`, `business_dispatch_enabled=false`, and still allow STOP. Unexpected file/process/port or failed readback must trigger a conservative backup rollback, controlled rebind of the old Control Center if possible, and a durable BLOCKED_TECHNICAL failure record. Do not attempt identical unattended retries.

**Post-install acceptance:** Hosted CI gates pass, SOT/marker exact-main, installer receipt `INSTALLED_OWNER_MONITOR_CONTROL_OFF`, independent local SHA-256 of three installed files matches reviewed sources, original `coordinator.py` unchanged, port remains loopback, only one verified Control Center PID, existing Supervisor controls unaffected. Negative-control request with invalid CSRF/Origin must fail and not change Owner state. Then under explicit Owner START delegated in this conversation, exercise only `START_COORDINATOR_READ_ONLY` via the same local loopback/CSRF contract and confirm persisted generation/ARMED; trigger **one** existing technical tick if appropriate to show genuine fresh `MONITORING_READ_ONLY` plus SOT still `IN PROGRESS / TASK_NOT_READY`, specialists still OFF and `business_dispatch_enabled=false`. STOP must be independently testable on the Control Center route without touching specialists; if a destructive live STOP/START acceptance would change desired state unexpectedly, use isolated source/test fixtures first. **Never call this production-control gate a Business Executor START or declare SC-013 DONE.**

### SC-013 Owner START/STOP read-only monitoring — live accepted 2026-10-09

**Result / limits:** `OWNER_READONLY_MONITOR_START_ACCEPTED` on `DESKTOP-H4A16IL`; `BUSINESS_EXECUTOR_NOT_QUALIFIED`; SC-013 is still `IN PROGRESS`. This closes the **Owner-controlled read-only monitoring lifecycle** milestone, not the overall Robot Tổng, Supervisor, WebApp or specialist task-execution milestone.

**Source and deployment gates:** [PR #365](https://github.com/magasincoffee/magasin-supervisor/pull/365) delivered the Coordinator Owner lifecycle adapter, local Control Center API/UI and tests (4 mandatory CI GREEN), squash merge `dbbdc88121bb46325ed14409e0857ed08f61ca25`. [PR #366](https://github.com/magasincoffee/magasin-supervisor/pull/366) delivered the separate exact-main, original-hash-pinned H4 Control Center APPLY gate, rollback and local-only Control Center restart (4 mandatory CI GREEN), squash merge `0fb6c6a3d843d39c4ebdde2e74b2873676e47846`. One explicit Owner marker [PR #367](https://github.com/magasincoffee/magasin-supervisor/pull/367) merged at exact-main `6e0548291b87b5b42f00ac01304d9e65932397d6` and triggered the accepted local installation.

**Independent H4 installed evidence:** `D:\MAGASIN_ROBOTS\deploy\sc013-owner-control\6e0548291b87b5b42f00ac01304d9e65932397d6\install-result.json` reports `INSTALLED_OWNER_MONITOR_CONTROL_OFF` at `2026-10-09T10:30:21.7455345Z` (local 17:30:21). Three installed SHA-256 hashes read back from H4 matched receipt: `owner_lifecycle.py=545e83dc723c545c521dd56edd7f53559f6a3ccbb1fc25f5c0386a161534b952`, `server.py=503fd59ce03f906221f08afa29e2f1e13b0925c00aa67bd28bd0846d37b5ac3b`, `app.js=7093a9b52516302392d5731289e62acf6dd55757fac2403bdf49338fccbc8e22`. The previously qualified `coordinator.py` was not modified. The GitHub runner-launched Control Center passed initial health then its child process exited after the job ended; a separate independent local START used the **existing** `START_CONTROL.ps1 -StartOnly` with no Chrome launch. After that, `http://127.0.0.1:8781/healthz` returned HTTP 200 and the Coordinator read-only control API returned truthful `OWNER_STOPPED` with `start_allowed=true`, `stop_allowed=true`, `business_dispatch_enabled=false`. This restart detail is important evidence: future runner-based Control Center deployment must preserve or re-check independent UI process survival after the runner job exits; do not assume first in-job health PASS implies persistence.

**Real Owner START and post-START tick:** The explicit local-control-center same-origin-CSRF action `START_COORDINATOR_READ_ONLY` was accepted: durable `owner-lifecycle.json` generation `1`, `desired=MONITOR_READ_ONLY`, `requested_at=2026-10-09T10:33:11.352236Z`, `execution_enabled=false`, `business_dispatch_enabled=false`. The UI first reported `ARMED_READ_ONLY`, not false RUNNING. Exactly one existing `MAGASIN SC013 Local 30min` technical tick was then requested; its independently read heartbeat recorded `checked_at=2026-10-09T10:33:28Z`, `completed_at=10:33:31Z`, Gateway PASS, Coordinator PASS and `errors=[]`. The Coordinator report at `10:33:31Z` inspected one real SC-013 Gateway receipt and returned `SOT IN PROGRESS/TASK_NOT_READY` pinned to canonical revision `6e0548291b87b5b42f00ac01304d9e65932397d6`, `execution_enabled=false`, `dispatched=false`, `business_completed=false`, eight `HEALTH_CHECK_DONE`, one `WAIT_OWNER_ENABLE`, all three specialist Owner flags false. The next live Control Center readback was `status=running`, `control.mode=MONITORING_READ_ONLY`, `desired=MONITOR_READ_ONLY`, and `business_dispatch_enabled=false`. This supports **real active read-only monitoring only**, not a persistent Business Executor process.

**Security negative evidence:** An independent POST to the Coordinator STOP endpoint using an intentionally invalid CSRF was rejected with HTTP `403` and a fresh readback proved the valid Owner START was unchanged; no unapproved STOP was issued, no Supervisor/SAYDI/SAPO lifecycle changed and no ChatGPT outbound sent. The separate STOP implementation and wrong-machine/memory/duplicate/forged-input cases were covered by the CI test suites. Durable evidence comment is available on [SC-013 Issue #339](https://github.com/magasincoffee/magasin-supervisor/issues/339).

**Next qualified execution boundary:** After this Owner monitoring milestone, the next task is a **disposable, non-production Business Executor fixture**, first verifying actual Author/Issue receipt, genuine per-specialist Owner lifecycle authority (not `owner_enabled.json` alone), exact-once claim/ack/recovery and CPU/RAM budgets. No actual specialist execution or GitHub task-result writeback until separate SOT/Owner review, dedicated affected QA + required hosted CI, post-merge exact-main, independently observed disabled-specialist/STOP rejection, and bounded E2E. The current 30-minute technical tick and Owner monitoring START must never be misrepresented as task completion.

### SC-013 Phase 2 — disposable Business Executor exact-once fixture gate (2026-10-09)

**Owner delegation and status:** Owner requested the assistant continue toward autonomous Robot Tổng with no further routine Owner clicks, while preserving all specialist OFF permissions and the already qualified Owner `MONITOR_READ_ONLY` control. This is an **in-source non-production fixture checkpoint** inside existing SC-013, **not** authorization for a live Business Executor, remote work, GitHub business writeback or specialist START. Preserve `SC-013=IN PROGRESS` and `business_dispatch_enabled=false` on H4A16IL.

**Reviewable fixture source:** `src/coordinator/disposable_business_executor.py` and `test/test_sc013_disposable_business_executor.py` model SQLite-backed durable `CLAIMED -> ACKED -> COMPLETE_FIXTURE_ONLY` with explicit temporary-directory opt-in, synthetic `fixture:sc013:...` identities, synthetic-only `SC-013` task state `READY_FIXTURE_ONLY`, synthetic Owner/worker guard schema, strict CPU (1–5s) and memory (1–128 MB) budgets, bounded lease, claim token and worker receipt, QA digest verification, duplicate suppression and blocked-unknown-outcome restart handling. A simulated expired/ambiguous claim MUST become `BLOCKED_UNKNOWN_OUTCOME`, never be replayed. Wrong revision for an existing source ID MUST be blocked. Synthetic Owner STOP, OFF, fake production machine/GitHub Issue, invalid SOT state, bad worker acknowledgement, skipped QA, forged/duplicate input and excessive budget MUST prevent further simulated execution. No provider credentials, subprocess/robot starts, browser, ChatGPT outbound, production DB path, production worker interface or external GitHub/Supabase writes.

**Hard separation:** The fixture explicitly denies real `github:...:issue:...` Gateway source IDs, `execute_task`, non-fixture targets and real-machine lifecycle claims; all returned results declare `execution_qualified=false`, `production_dispatch=false`, `external_effects=false`. It creates SQLite only beneath an explicit OS temporary-directory child and is not imported into local Coordinator, 30-minute tick, Control Center, Supervisor or GitHub Actions self-hosted H4 runner. Hosted CI unit tests exercise the fixture only in isolated temporary storage and MUST NOT be interpreted as real Owner or Worker authorization. A successful fixture cannot automatically promote `SOT_PREFLIGHT_READY_NOT_AUTHORIZED` to live dispatch.

**Checkpoint acceptance:** Review the new fixture source and tests; require Supervisor Integrity/Tests and all other mandatory PR checks GREEN, squash merge only after review, verify exact-main and record run IDs in SC-013 Issue #339. **Do not trigger a local APPLY, run a new scheduler, turn on a specialist or change Owner monitoring mode at this checkpoint.** After this, separately qualify actual GitHub Issue/Gateway author provenance and authenticated per-specialist Owner lifecycle before designing a disabled-by-default production adapter; that adapter requires its own approved SOT gate, durable exact-once/non-idempotent recovery and real E2E acceptance.

### SC-013 Phase 2A — real GitHub Issue/Gateway provenance read-only qualification (2026-10-09)

**Owner delegation:** Proceed automatically through *reviewed, source-only* Business Executor gates without requesting redundant Owner clicks, retaining the existing explicit production STOP/OFF and separate authorization for irreversible dispatch. This checkpoint implements **read-only verification of external request provenance and independent Coordinator Owner monitoring evidence**, but does not change the actual installed Coordinator, Gateway, Control Center or specialist lifecycle. Business Executor remains `NOT_QUALIFIED` and `SC-013=IN PROGRESS`.

**Grounded actual Gateway and GitHub schema:** On H4A16IL, `C:\MAGASIN_MCP\dispatch_gateway.py` reads GitHub Issue requests under `https://api.github.com/repos/magasincoffee/magasin-supervisor/issues` and accepts only exact `MAGASIN_DISPATCH_V1` fields: `schema,task_id,target,action,sot_url`. It persists `source_id,source,task_id,target,action,sot_url,status,local_job_id` in `C:\MAGASIN_MCP\state\jobs.sqlite3`. The actual open Owner-authored [Issue #339](https://github.com/magasincoffee/magasin-supervisor/issues/339) has `task_id=SC-013`, `target=supervisor`, `action=execute_task`, canonical Supervisor SOT URL, and must remain `WAIT_SOT_AUTHORITY` in the local Gateway because SOT `SC-013` is `IN PROGRESS`. Issue content, its author string, and the Gateway row are requests, *not* independent SOT READY, Worker START, authorized action, or business result evidence.

**New source-only verifier:** `src/coordinator/dispatch_provenance.py` compares (a) two fresh HTTPS GitHub REST Issue GETs with an explicitly supplied scoped token, hardcoded exact Issue endpoint, no cross-origin redirect, 64KiB size limit, exact expected GitHub account `magasincoffee` numeric ID `191064507`, GitHub Issue/repository/author metadata and identical revision/issue body across reads; (b) matching SQLite `mode=ro` receipt identity/target/action/SOT/status with no local job; and (c) independent read-only Coordinator Owner lifecycle source `owner-lifecycle.json` on DESKTOP-H4A16IL, Owner STOP latches, specialist OFF advisory flags, source generation, no Business Executor. GitHub HTTPS GET proves only the *platform-observed issue identity and request body*; it is **not** an Owner-cryptographically signed business dispatch or a guaranteed durable content snapshot against concurrent modification. The module denies malformed/duplicate JSON keys, PRs disguised as Issues, Issue authors with mismatching immutable user IDs, suspicious repo URLs, wrong body/target/action, real job IDs, changed Issue between reads, mismatching Gateway row, Owner STOP/OFF and unverifiable/invalid lifecycle states.

**Never upgrade request verification to dispatch:** Even when a real GitHub Issue and Gateway row match, the only positive diagnostic is `REQUEST_PROVENANCE_MATCHED_ONLY`; every return value includes `specialist_owner_authority_verified=false`, `sot_execution_authority_verified=false`, `business_dispatch_authorized=false`, `execution_qualified=false`, `dispatched=false`, `business_completed=false`. Local Coordinator `MONITOR_READ_ONLY` is not proof of Supervisor START, and `owner_enabled.json` is not a substitute for a separately authenticated live specialist lifecycle witness. `src/coordinator/dispatch_provenance.py` is intentionally **not imported** by the installed Coordinator/30m tick and is not a GitHub Actions self-hosted job. No startup, local APPLY, new scheduler, GitHub business result writes, credentials logging or financial data mutation is authorized by this checkpoint.

**Mandatory tests and gates:** `test/test_sc013_dispatch_provenance.py` exercises exact real-schema SQLite query and no mutation, good platform-observed Issue/Gateway identity, wrong numeric author ID/login/repo/Issue/Pull Request, duplicate/oversized/hostile envelope, mismatched SQLite status, changed Issue between GitHub reads, REST token/redirect/response bounds, wrong machine, Owner STOP, missing/invalid Owner lifecycle and specialist OFF, and *never dispatch* on apparent provenance success. Run on hosted Linux and Windows (Supervisor Integrity and Supervisor Tests), plus the required Lifecycle and Autostart checks, merge after all mandatory CI GREEN, then exact-main verification. Record actual run IDs/commit under Issue #339. No production installation of this verifier until a separately authored and Owner-reviewed **read-only** H4 STAGE/APPLY with hashes and failure recovery has been authorized in this sole SOT.

**Next nonproduction milestone:** Resolve the independent specialist Owner lifecycle attestation contract in the Supervisor adapter (including durable authenticated START generation, STOP/reboot behavior, process heartbeat and resource limits) without changing any existing supervisor STOP state; then create a **disabled-by-default** Business Executor adapter with exact-once replay-unsafe evidence and test-worker acknowledgement. Real specialist dispatch is separately gated, requires independent canonical SOT READY and explicit authorization for production actions.

### SC-013 Phase 2B — Specialist Owner lifecycle and worker identity contract (2026-10-09)

**Owner-approved direction:** Continue safe source-only development of independently authenticated per-specialist Owner START/STOP and worker-liveness checks. **This is not approval to turn on Supervisor, SAYDI or SAPO, alter any STOP latch, or activate real Business Executor.** The current Coordinator owner control is `MONITOR_READ_ONLY` only, separate from specialist lifecycle. SC-013 remains `IN PROGRESS` and `business_dispatch_enabled=false`.

**Actual H4 specialist inventory (read-only, 2026-10-09 ~20:54 +07:00):** `D:\MAGASIN_ROBOTS\robots\supervisor\robot.json` names `supervisor`, `manual_controls_verified=false`, legacy startup. Supervisor guardian `C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor\guardian-status.json` reports `automation_status=BLOCKED`, `watchdog_mode=FAULT`, `wrapper_alive=false`, five wrapper restarts in the last hour and valid monitor/control metadata. No positive specialist START was established; presence of a watchdog does not prove worker execution. `D:\MAGASIN_ROBOTS\robots\saydi-media\robot.json` and `D:\MAGASIN_ROBOTS\robots\sapo\robot.json` both report `manual_controls_verified=false` and legacy startup; their `runtime` directories are junctions to older C: paths, **not** standalone authenticated START witnesses. Advisor `D:\MAGASIN_ROBOTS\robots\coordinator\config\owner_enabled.json` had all supervisor/saydi/sapo false. Do not infer availability of business execution from an individual process PID, healthy Guardian, legacy task, config flag or only a Coordinator heartbeat.

**Source-only next gate:** `src/coordinator/specialist_lifecycle_attestation.py` adds `observe_local()`, a conservative host-bound **read-only** classifier for the three robot manifests, Owner STOP/AUTOSTART_DISABLED, advisory OFF flags, Supervisor guardian fault/wrapper/heartbeat freshness and missing independently verifiable specialist START proof. Even if a future guardian appears healthy, output remains `BLOCKED_NOT_QUALIFIED` / `owner_start_verified=false`, `worker_identity_verified=false`, `business_dispatch_authorized=false`, `execution_qualified=false`, `dispatched=false`. SAYDI and SAPO are explicitly unqualified while their respective project-specific control authority/heartbeat/Owner START contracts are absent. This does not import code into installed H4 Coordinator, Scheduler, Control Center or live specialist runtimes.

**Fixture-only signed contract:** The same module provides a separately named `verify_fixture_attestation()` to model future **separate Owner signing root** and worker witness. A valid disposable synthetic HMAC statement is bound to robot, `SIMULATED_ONLY` machine, worker PID, boot ID, instance ID, Owner generation, one-use nonce, short issue/expiry window, and fresh independent worker heartbeat, with explicit STOP/worker-OFF rejection and an externally supplied replay nonce collection. The fixture accepts only a clearly identified fixture key and `fixture_only=true`; **no production signing key or independent Owner witness has been installed or proved**. Even an entirely valid test signature reports `FIXTURE_SIGNATURE_AND_WITNESS_MATCHED_ONLY` and retains all production-execution authorizations false. Do not allow a test HMAC, static placeholder Owner-enable file or a GitHub Issue to authorize real dispatch.

**Required tests and acceptance:** `test/test_sc013_specialist_lifecycle_attestation.py` must pass on hosted Linux and Windows and cover Supervisor blocked/watchdog fault, wrapper false, legacy SAYDI/SAPO, wrong manifest, invalid/stale heartbeat, STOP latches, forged advisory enable flags, missing/wrong machine and positive HEALTHY-but-still-not-owner-qualified cases; signed fixture must cover corrupted signature, weak/real credential, wrong trusted Owner generation, replayed nonce, reboot/boot-ID mismatch, PID, worker instance, STOP, stale heartbeat, expired/future/long-lived proof, forged production machine and request field injection. Require all four hosted CI checks GREEN, reviewed PR, post-merge exact-main, Issue #339 evidence. No H4 source APPLY, new scheduler, robot START, LIVE_SIGNING_KEY creation, GitHub business writeback or production deployment under this checkpoint.

**Next gate before any real assignment:** Each robot project SOT must define a canonical local Owner START/STOP action and authenticated durable Owner generation including STOP and reboot revocation, a bound worker-session identity and independently fresh heartbeat. Only then propose a disabled-by-default adapter that composes **actual** GitHub/Gateway identity, independently resolved canonical SOT `READY`, per-robot attestation, resource limits and exact-once claim. Perform negative/rollback test-worker E2E separately before activating a production robot. Supervisor must first resolve its actual `BLOCKED`/guardian `FAULT` without bypassing STOP or sending duplicated outbound commands; SAYDI and SAPO remain independently OFF until their own controls qualify.

### SC-013 Phase 2C — Owner-visible specialist START/STOP blockers (2026-10-09)

**Owner observation:** In the unified Control Center `http://127.0.0.1:8781/robot/saydi` around 21:11 on H4A16IL, SAYDI Media rendered disabled START/STOP controls and the generic message "Điều khiển Start / Stop đang khóa cho đến khi kiểm thử riêng từng robot." Owner reported that specialist robot buttons could not be used. **Root cause is not an input/browser defect:** canonical `src/control-center/server.py` exposes only `/api/supervisor/control` and `/api/coordinator/control`; `saydi` and `sapo` return `controls_ready=false`, while the front end deliberately disables controls on those robot IDs. The Owner requests functional per-specialist lifecycle management, not fake enablement of unsafe controls.

**Latest independent H4 inventory / blockers:** `C:\SAYDI\control\media_control.py` is explicitly a localhost `127.0.0.1:8776` read-only monitor; it has no validated Owner START/STOP action. A real `/api/status` response at 21:13 reports Chapter 2 `stage=PAUSED_RESOURCE`, `reason=QC_NEEDS_FREE_RAM`, `min_start_ram_gb=2.3` and about 1.46 GiB available RAM in the broader machine monitor, with no active media worker. Chapter 2 progress and review artifacts are not authorization to start another render or destroy an in-progress checkpoint. `C:\SAYDI\control\RUN_CH02_V5_QC_SAFE.ps1` is a resource-gated existing QC runner (not yet a verified manual START/STOP lifecycle contract). The SAPO runtime `%LOCALAPPDATA%\MAGASIN\SAPO\control_center.py` is an independent local Tkinter control tool, while `MAGASIN Sapo Nightly` and `MAGASIN Sapo Reconcile` remain existing Windows scheduled jobs. START or STOP must not trigger new financial writes or interrupt unknown in-flight reconciliation. Supervisor already has `src/control-center/server.py` bound `/api/supervisor/control`, but its current Guardian `BLOCKED/FAULT` and restart-budget/resource/transaction preflight can independently reject START while STOP is limited to canonical verified scripts.

**Source-only diagnostic increment:** `src/control-center/specialist_readiness.py` emits a read-only `control` contract for SAYDI and SAPO, sourced from their manifests, independent advisory flags, fresh SAYDI Media Control status, chapter resource threshold and host RAM, and the explicitly missing native Owner control gates. The UI `src/control-center/web/app.js` now explains *why* each button is disabled, with human-readable RAM/QC/legacy-scheduler/lifecycle reasons, rather than a generic non-actionable warning. No new mutating HTTP path and no START/STOP for these two robots exists in this increment. The status contract MUST retain `start_allowed=false`, `stop_allowed=false`, `control_ready=false`, `owner_authority_verified=false` and `business_dispatch_authorized=false` until native per-robot contracts are separately accepted. Even a spoofed Media Control flag, advisory Owner flag, available RAM or healthy process can never by itself unlock a button.

**Acceptance and implementation path to actual buttons:** The Owner's intent is full real START/STOP per specialist, using a **distinct** native adapter for Supervisor, SAYDI and SAPO. This requires per-specialist SOT authority, exact reversible START/STOP checkpoint and authentication for Owner, a durable Owner STOP that suppresses the existing legacy scheduler/watchdog from restarting a disabled robot, OFF-after-reboot verification, safe worker idempotency and no duplicate media/financial execution, process ownership, resource gates, and a separate OWNER-reviewed deployment/cutover. SAYDI is first practical target after RAM and media-checkpoint qualification; SAPO financial sync remains guarded until reconciliation is checkpoint-safe. No auto-enable from Robot Tổng. Required CI: hosted Supervisor Integrity, Supervisor Tests, Lifecycle Acceptance and Autostart Install GREEN, post-merge exact-main; a separate reviewed H4 STAGE/APPLY with original installed file hashes, rollback, independent listener verification and negative START/STOP tests is mandatory for deploying this diagnostic change. Do not copy directly to live Control Center on source merge.

### SC-013 H4A16IL isolated staging and source patch authority (Owner 2026-10-09)

The Owner's newer workstation decision assigns the current SC-013 local Supervisor recovery exclusively to **DESKTOP-H4A16IL**, not to DESKTOP-4K7IM13. Older 4K7IM13 production-deploy rules and historical evidence remain intact for history; their workflow MUST NOT be used to update, recover, or start the H4A16IL Supervisor. All H4A16IL **Supervisor runtime maintenance** must use the separate allowlisted `.github/workflows/sc013-h4a16il-safe-deploy.yml` and `.github/scripts/sc013-h4a16il-safe-stage-deploy.ps1` boundary. The exclusively **isolated, non-installing Coordinator STAGE** has its own separately reviewed boundary above; it cannot be used to replace runtime source or expand the existing Supervisor APPLY scope.

**STAGE** is a non-production-mutation operation, permitted by a dedicated `.github/sc013-h4a16il-stage-request.json` commit or explicit `workflow_dispatch`. Require exact runner identity `DESKTOP-H4A16IL`, checkout SHA identical to the current `main` ref, verified canonical Supervisor state/control paths, complete module set and no unexplained local source differences. Compare every installed `src/**/*.mjs` module with exact-main source. Raw byte differences caused **only** by CRLF/LF or terminal CR/LF presentation may be classified as format-only after strict text equality with those characters normalized; never normalize Unicode, internal spaces, code tokens, or other content. The full format-only path list and raw SHA-256 hashes must be saved and revalidated before APPLY. Stage only the reviewed `src/runtime/single-conversation-cli.mjs` patch if it is the **sole substantive difference**; any other substantive mismatch blocks deployment. Preserve the original source as a hash-verified D: backup and emit a durable stage manifest; no process termination, browser navigation, state mutation, profile deletion, start, outbound send, or production source replacement is allowed in STAGE.

**APPLY** is never triggered by source merges or the staging marker. It requires separate Owner-authorized `workflow_dispatch` for one exact `main` commit, plus a matching successful staged manifest, unchanged backup/source hashes, exact target machine, healthy C/RAM safety gates, wrapper stopped, no Owner STOP or AUTOSTART_DISABLED latch, and a reconciled non-ambiguous outbound state. Any `PREPARED`, `ENQUEUED`, `DELIVERED`, `RESPONSE_RUNNING`, or `UNKNOWN` outbound state MUST prevent APPLY until its exact-once outcome is independently reconciled. The patch may update only the one reviewed source module and must verify its new hash, preserve D: rollback and attempt rollback on failure. APPLY MUST NOT automatically start/stop Supervisor or Chrome. Any failure is a truthful terminal fail-closed outcome, not permission to reset state or retry the previous ChatGPT message.

The GitHub Actions runner could select a non-target Windows machine; such attempts must fail before checkout with `TARGET_MUTATION_SKIPPED=True`, without routing loops. `main` moving after a stage or before apply invalidates the old authorization. Stage success means only staged source, **not** Supervisor restored or production acceptance. Production validation still requires exact identity, distinct proof-gated reconciliation of any pending `ENQUEUED` request, resource headroom, explicit bounded START/re-arm, 2+ same-chat cycles, no duplicate sends, and all SOT QA gates.

### SC-013 unattended observation policy

While SC-013 remains IN PROGRESS, production evidence collection is unattended:
- `windows/local-watchdog.ps1` runs as an independent local observer on `DESKTOP-H4A16IL`, polling runtime/state truth every five seconds and sampling the live ChatGPT UI read-only every 30 seconds when CDP is healthy;
- the local observer writes a fresh `local-watchdog-status.json`, bounded `local-watchdog-events.ndjson`, and fault snapshots under `local-watchdog-failures`; persisted evidence contains state/UI health metadata and digests, not ChatGPT conversation URLs or message text;
- the local observer survives Robot BLOCKED/STOPPED states and remains active during explicit Owner STOP; Owner STOP is recorded as authoritative and is not classified as a Robot fault;
- Windows logon registers the local observer separately from Robot recovery, and runtime install/hotpatch restarts the observer from the exact installed version without changing project state or sending ChatGPT messages;
- `.github/workflows/sc013-runtime-watchdog.yml` is a manual/request-marker read-only diagnostic for `DESKTOP-H4A16IL`; its five-minute schedule is intentionally removed so GitHub watchdog work cannot compete with production tasks on the self-hosted runner; continuous coverage comes from the five-second local watchdog, the process-layer guardian, and the hourly ChatGPT condition-watch;
- when a non-Owner fault is detected and CDP remains reachable, the local observer captures the exact active-runtime match, safe UI classification, composer readiness/digest/length, and ChatGPT error controls without navigating, typing, submitting, retrying, or repairing;
- the local and GitHub watchdogs remain read-only and never send/repair by themselves; the separate Supervisor guardian may perform only the bounded process/service repairs authorized by the current 24/7 delegation above, while any code/data/transaction repair still follows the SC-013 first-failure rule with tests and exact-main deployment before production rerun;
- watchdog/diagnostic workflows are observation-only and MUST NOT be used as an implicit deployment trigger; code review, CI, and read-only inspection must leave the installed production runtime and live Robot session untouched;
- the interactive SC-013 first-failure observer is armed only by explicit `workflow_dispatch` or `.github/sc013-live-observation-request.json`; it waits read-only for Owner START and runs one attempt only, while long-duration unattended coverage remains the responsibility of the independent local watchdog and the scheduled/condition-watch monitoring layers;
- SC-013 remains IN PROGRESS until the required same-conversation multi-cycle production evidence is sustained without BLOCKED state, duplicate sends, or legacy workflow interference.
- on 2026-10-07, DESKTOP-H4A16IL reproduced a continuity failure after a real `TASK_EXECUTION`: ChatGPT rendered the exact outbound user turn and completed the correlated assistant response, but the direct Send-control Playwright click timed out. The transaction remained `ENQUEUED` and was persisted as `EXACT_ONCE_FAILED / BLOCKED`; the wrapper then stopped by design and Guardian correctly refused to relaunch a durable BLOCKED state. This is a technical delivery-reconciliation fault, not an Owner-review boundary. Canonical recovery is proof-gated and exact-once: when the UI submit call throws, the same runtime must boundedly inspect the current conversation for the exact matching new user turn; if that exact turn is positively present, mark the existing transaction `DELIVERED`, clear the technical block, and continue observing the existing response without resend. If exact delivery evidence is absent, retain the existing fail-closed behavior.
- follow-up production evidence on 2026-10-07 showed a second failure class: `TASK_EXECUTION` could remain `ENQUEUED / EXACT_ONCE_FAILED / BLOCKED` with the wrapper already stopped, even though the current ChatGPT conversation was healthy and the exact blocked message had not been delivered. Guardian previously refused every `BLOCKED` state and the wrapper allowed its single bounded blocked-state restart exception only for `TASK_STATUS_CHECK`, so the exact-once reconciler never got a chance to prove non-delivery and consume its one safe retry. Canonical process recovery now permits exactly one wrapper restart for `TASK_STATUS_CHECK` or `TASK_EXECUTION` only when the transaction is `ENQUEUED`, `retry_count < 1`, `last_error_code=EXACT_ONCE_FAILED`, and durable message id/digest exist. Guardian and wrapper still never clear Owner stop latches, never mutate the transaction, and never actuate ChatGPT themselves; all resend authority remains inside the exact-once reconciler. A second failed retry or any other BLOCKED reason remains fail-closed.
- later on 2026-10-07, after XSTORE-019J correctly reached an explicit `BLOCKED / WAIT_OWNER / OWNER_INPUT_REQUIRED:*` gate, the independent local watchdog kept classifying the intentionally stopped wrapper as `WRAPPER_NOT_ALIVE`, continued running disposable ChatGPT UI probes, and wrote repeated fault snapshots every minute. The same soak window also showed transient `CDP_PROBE_OPEN_TIMEOUT` results cascading into `CHATGPT_RUNTIME_IDENTITY_MISMATCH` even though process-level CDP remained healthy. This is observability overhead, not a runtime failure. Canonical watchdog behavior is therefore: explicit Owner-review state is a quiet `OWNER_REVIEW` parked mode; expensive UI probes and wrapper-down faulting pause until the Owner gate is cleared; a probe that returns `probe_error` may emit only the probe fault and must not also authoritatively classify login/conversation identity/page semantics; identical fault snapshots use a longer bounded cooldown. The watchdog remains read-only and Chrome/CDP remain available for Owner review.
- the same 2026-10-07 production diagnostics showed repeated task-send incidents where ChatGPT had already accepted the prompt (composer cleared and the Stop control appeared), but Playwright's direct `Gửi` click still raised a timeout. The default submit recorder also started full Playwright tracing for every send and retained ~tens-of-megabytes traces on these false failures. Canonical throughput behavior is now: after a direct-click exception, first test for the bounded local composer submission transition; if that transition is positively proven, continue through the existing pending-user-turn/exact-once path instead of escalating the click exception. This does not by itself prove delivery or authorize resend. Default `MAGASIN_SUBMIT_DEBUG=failures` keeps bounded DOM/screenshot/summary evidence but does not start full tracing; full tracing remains available only under explicit debug mode.

DoD:
- the active GitHub control plane matches the exact SC-013 workflow/script allowlists above; PE/MBV/MIG/RBT/SC003-SC012 qualification/soak/diagnostic lanes are absent from active workflows/scripts and cannot consume the production runner;
- PE-001, PE-007, legacy Brain submit/repair, and superseded Bridge qualification/cutover workflows cannot auto-run on `main`;
- ordinary `src/**`, `windows/**`, test, or documentation merges cannot auto-deploy to `DESKTOP-4K7IM13`; production replacement requires explicit deploy authority and exactly one target-guarded deploy attempt;
- deployment success is not coupled to an immediate CDP diagnostic after the installer has intentionally closed Chrome;
- bootstrap restart recovery tolerates normal ChatGPT hydration delay only through a bounded read-only settle window and still requires two consecutive positive non-delivery observations before the single allowed retry;
- a bounded composer-draft read timeout cannot by itself terminate the runtime as `CDP_RECOVERY_REQUIRED` when the preceding safe page probe succeeded; it remains an inconclusive sample and no send authority is granted;
- heuristic modern message counters cannot by themselves block a stale blank-home bootstrap recovery; exact-turn absence plus zero structured conversation turns and the other canonical non-delivery conditions are required before the single retry is authorized;
- startup hydration/readiness may consume up to the canonical 90-second bounded settle window, but timeout expansion never weakens the positive non-delivery proof and every negative sample remains diagnostic-only/no-send;
- a correlated bootstrap user turn with the bootstrap protocol marker, current message ID, and current SOT is reconciled as already delivered before any retry decision; presentation-only full-text mutation cannot cause a duplicate bootstrap send, and ambiguous correlation remains fail-closed;
- if the correlated bootstrap conversation is absent from open tabs after restart but appears uniquely in Recent/Sidebar, bounded hydration/reopen recovery must bind that existing conversation and continue observing it without resend; zero or multiple correlated Recent matches remain fail-closed;
- cold-start Recent discovery re-enumerates the sidebar boundedly so a conversation that appears after the first sidebar sample can still be recovered; already-hydrated nonmatching candidates are rejected immediately and never authorize resend;
- if a settled conversation is absent from both open tabs and hydrated Recent/Sidebar, the exact persisted runtime identity can be recovered from the dedicated local Chrome History only through a unique opaque-identity match; zero/multiple history matches remain fail-closed and the recovery path cannot resend settled work;
- each live first-failure observation request creates exactly one pre-armed production attempt and does not leave a second attempt occupying the self-hosted runner after failure capture;
- current composer text is not falsely rejected solely because ProseMirror rewrites equivalent whitespace/paragraph structure;
- exact-once protection still rejects a genuinely different draft;
- a fresh submitted task whose rendered user turn is temporarily unreadable remains `RUNNING / WAIT_RESPONSE`, settles through the exact cycle-correlation response without Owner START, and cannot be resent after restart while `POST_SEND_CONFIRMATION_PENDING` remains unresolved;
- external-run regression coverage proves: in-progress -> RUNNING; completed success -> VERIFY/advance; completed failure -> same-task AUTO_REPAIR/READY with no wait; repeat observation of the same failed run never becomes RUNNING; a repair commit/new run becomes the tracked run; no-run becomes trigger diagnosis; repeated identical failure blocks only after the default three repair attempts; restart preserves task/run/attempt; and the Control Center renders each state in Vietnamese;
- a delivered task response remains recoverable across runtime prompt-contract upgrades through exact assistant cycle correlation without reconstructing or resending the historical prompt;
- a restart with an exact historical task user turn and a stably complete valid task-control assistant reply does not remain indefinitely in `STARTING_BROWSER` solely because the assistant omitted the cycle-correlation trailer; proof-gated recovery advances the existing transaction without resend or retry-count change;
- the OPS-074 fixture for Database Migrations CI run `37167270115` must classify `completed/failure` as AUTO_REPAIR for `TASK_ID=OPS-074`, checkpoint `074-C01`, never as another `CHECK_AFTER_SECONDS=120` wait;
- production evidence must include the repaired OPS commit/run transition and SOT checkpoint advance; current evidence is repair commit `90123538a597d76fcaaccbb4cc55886a9e1ccd3f`, successful Database Migrations CI run `37181157340`, and checkpoint-close commit `5e8cdf5a4e615e695cff9c45919ba93d60d71fdb` advancing to `074-C02`;
- the production target completes the previously stuck outbound without duplicate delivery;
- the Robot continues for at least two additional bounded cycles in the same conversation with stable generation;
- hosted tests/integrity/lifecycle/autostart gates pass;
- production evidence is recorded before SC-013 is marked COMPLETE.


### SC-013 project-fault containment and independent Supervisor monitoring — Owner directive 2026-10-10

**Owner-approved behavior:** A blocked or completed business project must not terminate the independent Supervisor observation layer. Record the project pause, preserve its work, and keep observing independently authorized health checks. An unknown ChatGPT outbound transaction is a transport/transaction fault, not an XSTORE-019J business failure. Never infer successful or failed delivery merely because the active task is XSTORE-019J. Do not replay the pending message, bypass Owner STOP, auto-switch a project, authorize another business execution or claim a running worker when only monitoring.

**Source-only implementation:** The new Windows module windows/project-fault-containment.ps1 is invoked by windows/run-supervisor.ps1 only after an independently Owner-started wrapper encounters a terminal single-conversation project state. Rather than exiting globally, it maintains an explicit MONITORING_ONLY heartbeat in project-hold-status.json (separate from exact-once durable state), indicating project task ID, pause scope, pending outbound and existence/freshness of the already-independent Coordinator technical heartbeat. It never sends a ChatGPT command. Verified BLOCKED/OWNER_INPUT_REQUIRED and outbound VERIFIED is classified PROJECT_WAIT_OWNER; verified DONE is PROJECT_COMPLETE. A PREPARED, ENQUEUED, DELIVERED, RESPONSE_RUNNING, UNKNOWN or SENDING transaction becomes TRANSACTION_OUTCOME_UNRESOLVED even if the task ID belongs to a project; unexpected blocked states are SUPERVISOR_TECHNICAL_HOLD. Project and transport faults remain distinct. Independent Supervisor/Coordinator read-only observers may continue according to their preexisting authority; other projects do not gain an executor.

**Owner and data safety:** Poll STOP and AUTOSTART_DISABLED and terminate the observer on Owner STOP. Never change or remove those latches. The paused project's SOT stays active until a separate Owner-qualified project-selection contract. Do not mutate the exact-once ledger, single-conversation-state.json, project-control selection, Chrome or other workers. Do not restart a BLOCKED transaction. If project state changes unexpectedly during hold, remain STATE_CHANGED_REARM_REQUIRED; a separate authenticated Owner re-arm must precede any Node execution. A fresh heartbeat file shows monitor liveness only, never task completion or qualified business execution. Existing independent 30-minute health-check remains read-only and cannot be promoted to dispatch authority.

**H4A16IL release boundary:** This wrapper+helper change is a new code path not included in the previously approved H4 safe-deploy single-runtime-file allowlist. All four hosted Supervisor CI workflows must pass at the exact PR SHA, followed by reviewed merge, post-merge exact-main, and a separately qualified explicit H4-only staging/apply gate with immutable installed source checks, backup/rollback, verified owner STOP and pending transaction constraints, no new scheduled jobs, and production acceptance. The current incident remains BLOCKED/AMBIGUOUS_ENQUEUED_OUTCOME and ENQUEUED/TASK_STATUS_CHECK with physical STOP/AUTOSTART_DISABLED present; this patch cannot retroactively reconcile it and does not authorize clearing either latch, starting another worker, sending ChatGPT or changing project. No direct production copy. SC-013 stays IN PROGRESS until independent operational E2E evidence.

---

## 11. Current implementation status

As of 2026-09-30:

- SC-001 through SC-012 are complete;
- SC-013 is IN PROGRESS following a real production stuck-send incident and discovery of legacy Planner/Executor workflows still auto-running on main;
- the canonical forward runtime is **SINGLE_CONVERSATION_V1**;
- the Owner supplies the Source of Truth URL only; no historical ChatGPT conversation URL is required;
- the forward Control Center and runtime use one disposable Robot-created ChatGPT conversation at a time;
- the actual production START wiring has been requalified on `DESKTOP-4K7IM13`;
- automatic replacement, exact-once reconciliation, Continue handling, cold-start recovery, bounded NEXT_WORK recovery, task-ID execution, safe same-chat restart rebind, and continuous multi-cycle execution have passed their required live qualifications;
- the real target completed the SC-011 restart-continuity qualification in one stable conversation generation with zero duplicate send attempts and Source of Truth verification preserved;
- long-running 30-60 minute E2E/verification tasks are supported through durable RUNNING/CHECK polling only while the tracked external run is genuinely active; terminal failure is repair authority, not polling authority;
- additive durable `external_work` metadata preserves task/checkpoint/repo/commit/run/workflow/failure/repair-attempt continuity across Robot restart without becoming project authority;
- persistent Planner/Executor orchestration remains superseded and is legacy/rollback-only, not a forward production dependency.

The forward architecture remains **SINGLE_CONVERSATION_V1**, but unattended production acceptance is temporarily **OPEN** until SC-013 closes the stuck-send and legacy-workflow interference regressions with new real-target evidence.

---

## 12. Acceptance rule

The architecture is complete only when the following Owner-visible flow succeeds from a true cold start:

```text
Owner supplies Source of Truth
-> START
-> Robot opens dedicated Chrome
-> Robot opens ChatGPT
-> Robot creates New Chat
-> Robot asks ChatGPT to read Source of Truth
-> ChatGPT responds
-> Robot continues work in the same conversation
-> Robot handles Continue generating when needed
-> Robot verifies Source of Truth
-> Robot proceeds to next work
-> broken conversation can be replaced automatically
-> project can continue without any Owner-provided conversation URL
```

That end-to-end behavior, not an isolated unit test or manual debug session, is the final acceptance authority.