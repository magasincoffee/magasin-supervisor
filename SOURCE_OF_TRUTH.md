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

- on 2026-10-04 after OPS-074 advanced into checkpoint `074-C03`, Scaffold CI run `37190492508` for commit `e9659c25535f4ba68e899b26278c6618a06427d7` completed `success`. The Control Center then showed the Robot stopped with CDP disconnected while the durable project state still expected autonomous continuation. Target-valid watchdog run `37192168875` (attempt 2 on `DESKTOP-4K7IM13`) proved `owner_stop=false`, `wrapper_alive=false`, `cdp_healthy=false`, local watchdog fresh, durable `automation=RUNNING / phase=NEXT_WORK / outbound=VERIFIED`, and outbound kind `SOURCE_OF_TRUTH_TASK_DISCOVERY` for message `8903ab33-5938-48f0-9297-25a4c9d76113`. Wrapper stderr identified the current first failure as `TASK_PROTOCOL_INVALID` with `SINGLE_CONVERSATION_TASK_PROTOCOL_REASON=MALFORMED_FIELD` and message `malformed task-control line`. The correlated assistant response is semantically valid and contains exactly `STATUS=READY`, `TASK_ID=NONE`, `NEXT_TASK_ID=OPS-074`, `CHECK_AFTER_SECONDS=0`; therefore this is a rendered-presentation parser defect, not a project/CI/Owner block. The bounded repair is to tolerate presentation-only whitespace around `=` in the fixed four-field task-control schema while continuing to reject prose, extra fields, reordered fields, invalid values, and missing header/footer.
- the rendered-equals parser repair was merged in PR #308 as `6f6dc1287305b47a9c2abf389d456fc4041a1ea6`; all four mandatory hosted gates passed. Explicit deploy run `37192564989` attempt 3 ran on `DESKTOP-4K7IM13`, reported `TARGET_MATCH=True` and `CANONICAL_RUNTIME_REPLACED=True`. The re-armed live production run `37192774300` then resumed the stopped Robot without manual Owner START under the active delegation. Production OPS evidence proves forward progress: commit `838a9417b50b2c2be0a163435a6e2f54eabc8990` recorded `074-C03` DONE after Scaffold CI `37190492508` success and advanced the project SOT to `CURRENT_CHECKPOINT=074-C04`. This proves the current `MALFORMED_FIELD` stop is repaired on the real target and the Robot can continue the same authoritative `OPS-074` task.
- on 2026-10-04 the Owner corrected the recovery evidence for the OPS-074 incident: after the Robot stopped at `BLOCKED / SEND_WORK` with `EXACT_ONCE_FAILED`, `ENQUEUED_STALLED`, and `WRAPPER_NOT_ALIVE`, the Robot did **not** restart itself; the Owner manually pressed START. The ChatGPT response for transaction `1514ef60-a01a-466f-8c7c-085242aeee6f` already contained the exact `MAGASIN_CYCLE_CORRELATION_V1` marker and valid `STATUS=RUNNING / TASK_ID=OPS-074 / CHECK_AFTER_SECONDS=120`. After manual START, existing restart reconciliation safely recovered that same message as `VERIFIED` with `retry_count=0`. This proves restart recovery is safe but the live process is still converting a short post-submit rendered-user-turn evidence gap into a technical BLOCKED boundary too early. The current first-failure repair is therefore narrower than generic auto-restart: after browser submit is positively actuated, the same runtime must remain `RUNNING / WAIT_RESPONSE` under a durable no-resend `POST_SEND_CONFIRMATION_PENDING` marker and wait for the exact correlated assistant response. A restart encountering that marker remains fail-closed and cannot resend; only the existing exact correlated-response or positive non-delivery rules may resolve the transaction.
- on 2026-10-04 the post-CI-recovery live qualification run `37181630729` exposed the next independent first failure before the external-run state machine could be exercised. The production target had one ACTIVE conversation with a prior `TASK_EXECUTION` message `f94074e8-c75d-44e5-bc19-a5645aca10a7` already durably `DELIVERED`; read-only UI evidence showed the exact runtime page healthy and the assistant response complete, while wrapper stderr repeated `RUNTIME_RESTART_WAIT_RESPONSE_UNRESOLVED: pending TASK_EXECUTION response has no exact restart reconstruction`. The runtime had been hotpatched after that task was sent, so rebuilding the historical prompt with the new external-run contract produced a different digest even though the original request was already delivered and its assistant response was present. The observer therefore remained at `STARTING_BROWSER` until `OBSERVATION_TIMEOUT`. The repair is correlation-first and no-resend: for an already `DELIVERED/RESPONSE_RUNNING` `TASK_EXECUTION` or `TASK_STATUS_CHECK`, an assistant turn containing the exact current `MAGASIN_CYCLE_CORRELATION_V1 <message_id>` may settle that already-delivered transaction directly to VERIFIED without reconstructing the historical prompt text. This authority cannot send, retry, or apply to an unmatched id/kind/state.

- production evidence after the CI auto-recovery repair confirms the requested terminal-failure loop is no longer theoretical. Supervisor repair PR #305 merged as `22fa6a53945d4448c452550f65400f3ad1c8b0cb`; all four mandatory hosted gates passed and explicit deploy request `aad1266a08cdd99a3976c142aabe2f4a84e45d65` installed the runtime on `DESKTOP-4K7IM13`. The failed OPS-074 Database Migrations CI run `37167270115` was not polled indefinitely: the Robot produced concrete repair commit `90123538a597d76fcaaccbb4cc55886a9e1ccd3f`, which triggered fresh Database Migrations CI run `37181157340` and that run completed `success`; Scaffold CI `37181157347`, Public Repository Scrub `37181157366`, and OPS Source Export `37181157355` also completed successfully on the same commit. After the subsequent restart-continuity repair PR #306 (`414cfea6f7a373fe321ab7754c78803b0982fab6`) was deployed, the live Robot resumed the same authoritative `OPS-074` task and committed `5e8cdf5a4e615e695cff9c45919ba93d60d71fdb`, recording `074-C01` DONE and advancing the OPS SOT to `CURRENT_CHECKPOINT=074-C02`. This is concrete production proof of `completed+failure -> AUTO_REPAIR -> new commit -> new CI -> success -> verify/update SOT` without changing the parent task ID or waiting again on the failed run.

- on 2026-10-04 a second OPS-074 production incident exposed an external-run state-machine defect independent of browser delivery. Database Migrations CI run `37167270115` for commit `7ca5f478eab3a2d09b8c5400e5217bef3821579e` was definitively `status=completed`, `conclusion=failure`, but the Robot kept returning `STATUS=RUNNING / TASK_ID=OPS-074 / CHECK_AFTER_SECONDS=120` based on the weaker condition “no fresh PASS yet”. The failed job was `migration-smoke`; logs proved three concrete failure classes: `print_job_tracking()` hit `permission denied for view production_print_job_queue`, OPS-042 reported `completed job leaves active mobile work queue` with `have: 1 / want: 0`, and `ops_074_production_drift_repair.test.sql` failed with SQL syntax at `$select`. The OPS SOT subsequently recorded `CURRENT_CHECKPOINT=074-C01` as `REPAIR_REQUIRED`. This establishes the canonical rule that absence of PASS is not evidence of an active run; terminal failure must return the same authoritative task to AUTO_REPAIR rather than another wait interval.
Canonical fix:
1. forward production MUST use only `SINGLE_CONVERSATION_V1`; obsolete Planner/Executor/Brain/Bridge qualification or cutover workflows MUST NOT auto-run from `main` or consume the production target;
2. legacy source may remain only as inert historical/rollback reference where still needed, but active GitHub Actions orchestration for the superseded architecture must be removed from `.github/workflows`;
3. contenteditable composer verification MUST use rendered-equivalent text identity for current ChatGPT ProseMirror while retaining strict durable message digests for exact-once transaction authority;
4. an `ENQUEUED` transaction with no delivered user turn may resume only when exact or rendered-equivalent evidence proves the live draft belongs to the same Robot message;
5. successful safe reconciliation MUST clear transient `BLOCKED` state and return automation to `RUNNING`;
6. final acceptance requires real target evidence on `DESKTOP-4K7IM13` that the blocked outbound is either safely delivered or safely reconstructed, a matching user turn appears, a response completes, and at least two subsequent task-control cycles continue in the same active conversation without duplicate sends or legacy workflow interference.
7. ordinary source, test, documentation, or Windows launcher merges MUST be CI-only and MUST NOT automatically replace the installed production runtime, stop the dedicated Chrome, stop the wrapper, or restart the Control Center;
8. production deployment to `DESKTOP-4K7IM13` MUST require explicit release authority through `workflow_dispatch` or a dedicated `.github/production-deploy-request.json` marker commit; one deploy request creates one target-guarded deploy job, and a non-target runner must fail without mutation rather than report a false deployment success;
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

Active script allowlist under `.github/scripts/`:
- `supervisor-sc013-live-production.ps1`;
- `sc013-wait-response-liveness.mjs`;
- `sc013-runtime-watchdog.ps1`;
- `supervisor-sc013-rebind-diagnostic.ps1`;
- `supervisor-sc013-rebind-diagnostic.mjs`;
- `update-latest-clean-old.ps1`.

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

### SC-013 unattended observation policy

While SC-013 remains IN PROGRESS, production evidence collection is unattended:
- `windows/local-watchdog.ps1` runs as an independent local observer on `DESKTOP-4K7IM13`, polling runtime/state truth every five seconds and sampling the live ChatGPT UI read-only every 30 seconds when CDP is healthy;
- the local observer writes a fresh `local-watchdog-status.json`, bounded `local-watchdog-events.ndjson`, and fault snapshots under `local-watchdog-failures`; persisted evidence contains state/UI health metadata and digests, not ChatGPT conversation URLs or message text;
- the local observer survives Robot BLOCKED/STOPPED states and remains active during explicit Owner STOP; Owner STOP is recorded as authoritative and is not classified as a Robot fault;
- Windows logon registers the local observer separately from Robot recovery, and runtime install/hotpatch restarts the observer from the exact installed version without changing project state or sending ChatGPT messages;
- `.github/workflows/sc013-runtime-watchdog.yml` independently samples the real target every five minutes, verifies that the local heartbeat is fresh, and surfaces local ChatGPT/runtime fault codes into GitHub Actions evidence;
- when a non-Owner fault is detected and CDP remains reachable, the local observer captures the exact active-runtime match, safe UI classification, composer readiness/digest/length, and ChatGPT error controls without navigating, typing, submitting, retrying, or repairing;
- neither watchdog may repair or send by itself; repair still follows the SC-013 first-failure rule, with tests and exact-main deployment before the production rerun;
- watchdog/diagnostic workflows are observation-only and MUST NOT be used as an implicit deployment trigger; code review, CI, and read-only inspection must leave the installed production runtime and live Robot session untouched;
- the interactive SC-013 first-failure observer is armed only by explicit `workflow_dispatch` or `.github/sc013-live-observation-request.json`; it waits read-only for Owner START and runs one attempt only, while long-duration unattended coverage remains the responsibility of the independent local watchdog and the scheduled/condition-watch monitoring layers;
- SC-013 remains IN PROGRESS until the required same-conversation multi-cycle production evidence is sustained without BLOCKED state, duplicate sends, or legacy workflow interference.

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
- the OPS-074 fixture for Database Migrations CI run `37167270115` must classify `completed/failure` as AUTO_REPAIR for `TASK_ID=OPS-074`, checkpoint `074-C01`, never as another `CHECK_AFTER_SECONDS=120` wait;
- production evidence must include the repaired OPS commit/run transition and SOT checkpoint advance; current evidence is repair commit `90123538a597d76fcaaccbb4cc55886a9e1ccd3f`, successful Database Migrations CI run `37181157340`, and checkpoint-close commit `5e8cdf5a4e615e695cff9c45919ba93d60d71fdb` advancing to `074-C02`;
- the production target completes the previously stuck outbound without duplicate delivery;
- the Robot continues for at least two additional bounded cycles in the same conversation with stable generation;
- hosted tests/integrity/lifecycle/autostart gates pass;
- production evidence is recorded before SC-013 is marked COMPLETE.

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
