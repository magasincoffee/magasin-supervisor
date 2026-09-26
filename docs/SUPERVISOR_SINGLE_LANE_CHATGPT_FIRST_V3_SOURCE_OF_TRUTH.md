# MAGASIN Supervisor — Single-Lane ChatGPT-First Runtime V3

Status: **OWNER-APPROVED ARCHITECTURE PIVOT / SOURCE OF TRUTH**  
Baseline: `1b5779fb1652e691f25cc5f0f5b586a74b1fc012`  
Branch: `sl3/sl3-p0-a1-source-of-truth-pivot-20260926`

## 1. Decision

The Three-Lane concurrency architecture is superseded as the future target. Production is **not** changed by this planning branch: the currently deployed runtime remains the rollback baseline until V3 passes qualification and the Owner explicitly authorizes cutover.

The new target is **one Single Lane centered on ChatGPT Plus**, with exactly one active project and one active task, two persistent warm ChatGPT conversations (Brain + Work), event-driven browser observation, direct bounded DOM actions, and Playwright/CDP used mainly for navigation/recovery/fallback.

**Paid OpenAI API is outside the production path. Target incremental OpenAI API cost: $0.** A future MCP adapter may be added only as a transport option; the V3 core must not require MCP or paid API access.

## 2. Non-negotiable architecture

Normal path:

```text
Owner
  ↓
ChatGPT Plus — Brain (warm tab)
  ↓ event bridge
MAGASIN Supervisor Single-Lane Core
  ↓ direct bounded action
ChatGPT Plus — Work (warm tab)
  ↓ event bridge
Supervisor exact-once result relay
  ↓
Brain VERIFY → ACCEPT/REJECT → NEXT PLAN
```

Normal-path polling is forbidden as the primary completion detector. The preferred fast path is a Chrome extension/content-script observer (for example MutationObserver + structured event extraction) sending privacy-safe events over a local transport. Playwright/CDP remains available for exact-target navigation, browser/CDP reconnect, bounded recovery and compatibility fallback.

## 3. Preserved invariants

- Owner STOP/AUTOSTART_DISABLED always wins.
- one bounded task at a time.
- PLAN → DISPATCH → VERIFY → ACCEPT/REJECT → NEXT PLAN.
- deterministic exact-once dispatch_id and relay_id authority.
- text-only result relay.
- durable state before effect where required.
- exact target identity and bounded recovery.
- no credential/MFA/CAPTCHA/security bypass.
- private chat bodies, tokens, cookies and full private URLs never enter Git.
- production merge/deploy requires explicit Owner instruction.

### 3.1 Preserved invariant evidence lock — SL3-P0-A2

This lock is derived from the released Three-Lane baseline at `1b5779fb1652e691f25cc5f0f5b586a74b1fc012` plus the Brain-accepted V3 Source-of-Truth head `c801604ab0de442215f1bccf32210aae0cb6279a`. It preserves safety/correctness semantics while V3 replaces the execution architecture; legacy Three-Lane/RBT planning does **not** regain forward authority.

| Invariant | Locked V3 meaning | Released/source evidence |
|---|---|---|
| Owner STOP / AUTOSTART_DISABLED precedence | No startup, recovery, dispatch, relay or browser mutation may bypass Owner STOP/AUTOSTART_DISABLED. Explicit Owner START is the only authority that may clear those latches. | `windows/lifecycle-truth.ps1::Get-LifecycleOwnerStopState()` makes either latch `blocked=true`; `Invoke-LifecycleRecoveryStart()` returns `OWNER_STOP` before recovery. `windows/run-supervisor.ps1` exits before launch and gates its loop on both latches. |
| One-bounded-task Brain contract | Exactly one roadmap task may be active; Work returns evidence then stops; Brain must VERIFY before ACCEPT/REJECT and before NEXT PLAN. | `docs/MAGASIN_LANE_DIRECTIVE_V1_PROTOCOL.md` §§7/12; `src/runtime/three-lane.mjs::parseLaneDirective()` fails closed on malformed/nonnarrow directives and correlates `previous_result`. |
| Deterministic exact-once `dispatch_id` / `relay_id` | Identity is stable across reconciliation/retry and stale/mismatched identities fail closed; transport confirmation is not semantic ACCEPT. | `src/runtime/three-lane-cli.mjs` derives `dispatchId = sha256(lane_id|task_id|directive_digest).slice(0,32)`, persists `dispatch_inflight`, and verifies identity before reuse; relay reconciliation keys on durable `relay_id`/response/text digests and marker confirmation. `src/runtime/three-lane.mjs::parsePreviousResult()` requires correlated `task_id` + `relay_id`. |
| Text-only result relay | The Brain relay payload is text; screenshots/files are not relay authority. | `src/runtime/three-lane-cli.mjs` persists only relay identity/digests then sends `relay.text` through the Brain composer; `src/runtime/relay-reconciliation.mjs::migrateLegacyBlockedRelayLatches()` explicitly removes legacy `screenshot_path` while preserving relay identity/retry state. |
| Durable intent/state before replay-sensitive effect | Where an action could duplicate or become ambiguous after crash/restart, durable identity/intent is written before the browser effect. | Dispatch: `dispatch_inflight` + `PERSISTED_NOT_SENT` are atomically written before send. Relay: `relay_inflight` and send-attempt state are atomically written before `sendComposerInstruction()`. Watchdog Continue: `beginWatchdogContinueIntent()` is atomically written before `executeDecision(ACTIONS.CONTINUE)`. |
| Exact target identity + bounded recovery / no reload storm | Brain/Work actions bind to the exact conversation identity; deterministic missing/access-denied/stable redirect quarantine; recovery has finite budgets and cannot reload indefinitely. | `src/runtime/target-health.mjs::targetHealthIdentity()` requires SHA-256 target digest and `evaluateTargetAvailability()` distinguishes deterministic unavailability. `src/runtime/browser-scheduler.mjs::acquireExactPage()` requires an exact target descriptor. `src/runtime/work-watchdog.mjs` bounds each recovery epoch to one reload + one continue with cooldown. |
| Auth/MFA/CAPTCHA/security fail-closed | Authentication, MFA, CAPTCHA, destructive/admin escalation and ambiguous security decisions stop automation rather than bypassing controls. | `src/runtime/three-lane-cli.mjs::hardStopObservation()` hard-stops on `AUTH_REQUIRED`, `MFA_REQUIRED`, `CAPTCHA`, `DESTRUCTIVE_ACTION`, `ADMIN_ESCALATION`, `AMBIGUOUS_DECISION`; watchdog also exposes `BLOCKED_SECURITY`. |
| Privacy / no secrets, private URLs or chat bodies in Git | Persistent diagnostics/evidence use IDs, digests, reason codes and sanitized metadata; credentials, tokens/cookies, full private conversation URLs and chat bodies are excluded from Git/source evidence. | `src/runtime/three-lane-cli.mjs::safeLog()` allowlists timestamp/type/lane/task/relay/digest/reason/error only; `src/runtime/lane-events.mjs` event schema allowlists correlation fields such as `target_digest` rather than raw targets. Accepted V3 SoT also forbids private chat bodies/tokens/cookies/full private URLs entering Git. |
| Process truth outranks persisted recovery state | Persisted recovery state is never sufficient evidence that runtime/browser processes are healthy. | `src/runtime/three-lane-cli.mjs::writeLaneStatus()` writes `truth_order=[PROCESS_TRUTH, LANE_TRUTH, PERSISTED_RECOVERY_STATE]`, `persisted_state_role=RECOVERY_ONLY`, `process_truth_required=true`; `windows/lifecycle-truth.ps1::Get-LifecycleProcessTruth()` derives wrapper/child/Chrome/CDP health from live processes. |
| Owner-explicit merge/deploy | Development/CI/verification may proceed, but merge, deploy, hotpatch and production cutover require a separate explicit Owner instruction. | Brain-accepted canonical V3 authority at `c801604ab0de442215f1bccf32210aae0cb6279a`, §§1/11 and JSON execution policy; this A2 lock does not grant merge/deploy authority. |

### 3.2 Rollback boundary lock — SL3-P0-A2

1. **Current production authority remains the released Three-Lane baseline** at `1b5779fb1652e691f25cc5f0f5b586a74b1fc012` until a locked V3 candidate completes the required qualification gates and the Owner explicitly authorizes cutover.
2. The Brain-accepted V3 Source-of-Truth input for this lock is exactly `c801604ab0de442215f1bccf32210aae0cb6279a`.
3. Legacy runtime code and entry points — including `windows/run-supervisor.ps1`, `src/runtime/three-lane-cli.mjs` and `src/runtime/three-lane.mjs` — remain **rollback-only**, not forward architecture authority, and must not be deleted before V3 qualification/cutover.
4. A rollback must preserve the existing canonical state root and must **not** reset the active task, dispatch/relay latches, Brain/Work targets or revisions, dedicated browser profile, or exact-once identities. `src/runtime/three-lane-cli.mjs` explicitly reserves destructive state reset for the separate Owner-authorized maintenance path; normal startup/recovery is not permission to clear state.
5. A rollback must not bypass or clear Owner STOP/AUTOSTART_DISABLED. Those latches remain higher authority than recovery/startup.
6. Rollback may restore the released executable path only from a safe boundary; it must not replay an irreversible/replay-sensitive browser effect without reconciling the durable intent/latch first.
7. Historical Three-Lane/RBT evidence remains audit/rollback provenance only. It does not become V3 planning authority and cannot be used to skip SL3 qualification or Owner cutover.
8. No A2 change mutates production runtime, Chrome/profile, local lane/task state, targets, latches, or historical evidence.

### 3.3 Legacy Three-Lane rollback freeze — SL3-P0-A4

SL3-P0-A4 freezes the released Three-Lane implementation as **LEGACY / ROLLBACK-ONLY** until both conditions are satisfied: (1) the Single-Lane V3 candidate completes its required qualification sequence and (2) the Owner explicitly authorizes production cutover. This is an authority and rollback-semantics lock only; it does **not** implement Single-Lane runtime behavior.

- Accepted A3 parent: `067e22af981c5042f17d06adaf6ae5e7ba42ec5c`.
- Released Three-Lane production baseline: `1b5779fb1652e691f25cc5f0f5b586a74b1fc012`.
- Immutable rollback source authority: `magasincoffee/magasin-supervisor@1b5779fb1652e691f25cc5f0f5b586a74b1fc012`.
- Production runtime before cutover: **THREE_LANE_V1**.
- Forward architecture: **SINGLE_LANE_CHATGPT_FIRST_V3**.
- Automatic V3 activation: **false**.
- V3 qualification required: **true**.
- Owner-explicit cutover required: **true**.
- Legacy forward feature development: **false**.
- Runtime behavior changed by A4: **false**.

Legacy rollback entry-point provenance remains explicit and must not be deleted or renamed by A4:

- `windows/run-supervisor.ps1`
- `src/runtime/three-lane-cli.mjs`
- `src/runtime/three-lane.mjs`

Rollback source is **snapshot-atomic**: if rollback source must be materialized, use the exact immutable released snapshot `magasincoffee/magasin-supervisor@1b5779fb1652e691f25cc5f0f5b586a74b1fc012` or a separately qualified replacement. It is forbidden to compose an old legacy entry point with newer shared/runtime files from V3 into an unqualified mixed tree.

Rollback must preserve durable authority and state. It must not clear or bypass `STOP` or `AUTOSTART_DISABLED`; reset the active task, `dispatch_inflight` or `relay_inflight`; replace Brain or Work targets; reset target revisions; delete/reset the dedicated browser profile; destroy the canonical state root; replay an unresolved browser effect before durable-intent/latch reconciliation; or restore Three-Lane/RBT documentation as forward Source of Truth. Durable state remains authoritative before replay-sensitive effects.

Forward-development boundary after A4:

- Three-Lane remains the production baseline until cutover and exists only as rollback provenance/runtime.
- Three-Lane receives no new V3 feature development.
- Single-Lane ChatGPT-First V3 remains the only forward architecture.
- New implementation work follows the SL3-P1+ roadmap.
- V3 must not be implemented by incrementally turning the legacy Three-Lane runtime into Single-Lane via a few flags/conditionals.
- SL3-P1-A1 is the next dependency-correct task, but remains **NOT STARTED** until Brain VERIFY/ACCEPT of A4.

### 3.4 Single-Lane config and durable registry schema — SL3-P1-A1

SL3-P1-A1 defines the **pure schema/state contract** for the forward Single-Lane V3 runtime. It does not read or write files, migrate legacy state, activate V3, wire `run-supervisor`, dispatch Work, relay results, or change browser behavior.

Canonical module: `src/runtime/single-lane-state.mjs`.

State files are intentionally isolated from legacy rollback state:

| Role | V3 file | Legacy rollback file |
|---|---|---|
| Owner/config intent | `single-lane-config.json` | `lanes.json` |
| Durable runtime registry | `single-lane-registry.json` | `lane-registry.json` |

The V3 filenames must never alias the legacy filenames. SL3-P1-A1 performs **no automatic migration** and **no legacy file mutation**; explicit legacy reading/migration belongs to SL3-P1-A2.

**Config ownership — Owner/configuration intent only:**

- exactly one `project_name` and `enabled` flag;
- requested Brain target plus `brain_url_revision`;
- requested Work target plus `work_url_revision`, save timestamp and `work_mode`;
- explicit Work-state reset, relay-retry rearm and resume request revisions/timestamps;
- no `lanes`, `lane_id`, scheduler/fairness/page-budget or cross-lane state.

**Registry ownership — applied durable orchestration/recovery state only:**

- applied Brain/Work target revisions, Work generation and pending Work target intent;
- task identity, instruction/result/verdict identities and exact-once `dispatch_inflight` / `relay_inflight`;
- applied reset/rearm/resume revisions and Brain request recovery state;
- durable task timing, project progress, Work watchdog/rollover and target-health state;
- no lane map, lane id, round-robin position, cross-lane lease or cross-lane mutation lock.

**Process truth is not registry authority.** The registry must never claim that Supervisor, Chrome, CDP or any other process is alive. Runtime/process liveness remains externally observed process truth, consistent with the accepted invariant that process truth outranks persisted recovery state.

The schema is fail-closed: explicit wrong schema/mode, legacy `lanes`/`lane_id`, invalid revisions, invalid modes and wrong primitive/object types are rejected. Valid V3 durable identities/latches are cloned and preserved, never regenerated or silently cleared by normalization.

Accepted A4 parent for this schema is exactly `09deca9adb977cb2ef0f93c6b7ad33425b1fb720`. A4's `legacy_runtime_freeze` remains unchanged and authoritative for rollback semantics. SL3-P1-A2 is the next dependency-correct task, but remains **NOT STARTED** until Brain VERIFY/ACCEPT of P1-A1.

## 4. Removed from the target architecture

- three simultaneously active lanes.
- round-robin cross-lane scheduler.
- multi-lane fairness logic.
- multi-lane page-budget/LRU eviction as a normal-path requirement.
- cross-lane mutation arbitration.
- polling as the primary ChatGPT completion detector.

## 5. Browser recovery contract

A transient page that says the conversation could not be loaded while exposing a safe **Retry/Thử lại** control is **not** deterministic conversation-missing evidence.

Bounded recovery epoch: detect → click Retry once → if still failed reload the exact page once → re-probe → recover or WAIT_OWNER. No loop. Deterministic missing/access-denied/stable redirect remains quarantine authority. Auth/MFA/CAPTCHA/security states fail closed.

## 6. Performance targets

Robot overhead targets exclude ChatGPT model generation time:

| Stage | p50 target | p95 target |
|---|---:|---:|
| Brain complete → detected | 250 ms | 1,000 ms |
| detected → Work send confirmed | 750 ms | 2,000 ms |
| Work complete → detected | 250 ms | 1,000 ms |
| detected → Brain relay confirmed | 900 ms | 2,500 ms |
| Brain verdict → next dispatch | 1,000 ms | 3,000 ms |

These are regression budgets, never authority to weaken exact-once, Owner STOP or security boundaries.

## 7. Source-of-Truth cleanup

Delete now because their active planning/architecture authority is superseded:

- `docs/THREE_LANE_V1_ARCHITECTURE.md`
- `docs/ROBOT_BROWSER_SCHEDULER_OBSERVABILITY_ARCHITECTURE.md`
- `docs/RBT_010_TEXT_ONLY_RELAY_PLAN.md`
- `docs/RBT_010_TEXT_ONLY_RELAY_AUTHORITY.json`

The old `docs/ROBOT_LIFECYCLE_TRUTH_ARCHITECTURE.md` content is removed and replaced by a minimal **non-canonical compatibility tombstone** because the current MIG-004 integrity workflow still requires that path to exist. `docs/MIG_007_FINAL_CLEANUP_PLAN.md` is likewise reduced to a historical compatibility tombstone because the existing MIG-007 regression test reads that path and checks its pre-execution marker. Both tombstones point to this V3 Source of Truth and preserve no competing planning/architecture authority.

Retain historical evidence/closure for audit and rollback provenance; those files are **not** current architecture authority. Retain the directive protocol, project-adapter contract and state-root contract as supporting contracts. Legacy Three-Lane runtime code is kept isolated as rollback-only until V3 qualification/cutover; deleting runtime code now would remove the safe rollback path.

## 8. Delivery roadmap

### SL3-P0 — Architecture Pivot & Source Authority

Establish one canonical V3 source, preserve safety invariants, and freeze legacy Three-Lane as rollback-only.

Expected active engineering: **3–5 h**.

| Task | Outcome | Nominal active time | Depends on |
|---|---|---:|---|
| SL3-P0-A1 | Establish Single-Lane V3 canonical Source of Truth and retire superseded planning sources | 60 min | — |
| SL3-P0-A2 | Lock preserved invariants and rollback boundary from released runtime | 45 min | SL3-P0-A1 |
| SL3-P0-A3 | Add canonical-source guard tests and stale-reference audit | 45 min | SL3-P0-A2 |
| SL3-P0-A4 | Freeze Three-Lane as rollback-only legacy runtime until V3 cutover | 45 min | SL3-P0-A3 |

### SL3-P1 — Single-Lane Deterministic Core

Extract a one-project/one-task durable runtime while preserving exact-once and Brain planning semantics.

Expected active engineering: **9–13 h**.

| Task | Outcome | Nominal active time | Depends on |
|---|---|---:|---|
| SL3-P1-A1 | Define single-lane config and durable registry schema | 60 min | SL3-P0-A4 |
| SL3-P1-A2 | Implement legacy three-lane state reader and safe single-lane migration adapter | 75 min | SL3-P1-A1 |
| SL3-P1-A3 | Extract single-lane deterministic state machine core | 75 min | SL3-P1-A1 |
| SL3-P1-A4 | Implement single active-task ownership and safe-boundary transitions | 60 min | SL3-P1-A3 |
| SL3-P1-A5 | Port exact-once Brain-to-Work dispatch semantics | 60 min | SL3-P1-A4 |
| SL3-P1-A6 | Port text-only exact-once Work-to-Brain relay semantics | 60 min | SL3-P1-A5 |
| SL3-P1-A7 | Port Brain PLAN→VERIFY→ACCEPT/REJECT→NEXT contract | 60 min | SL3-P1-A6 |
| SL3-P1-A8 | Port Work target revision and rollover semantics for one lane | 60 min | SL3-P1-A6 |
| SL3-P1-A9 | Remove cross-lane state coupling from new runtime path | 60 min | SL3-P1-A7, SL3-P1-A8 |
| SL3-P1-A10 | Pass single-lane core regression gate | 90 min | SL3-P1-A2, SL3-P1-A9 |

### SL3-P2 — ChatGPT Browser Event Bridge

Make ChatGPT the center with two warm tabs and event-driven detection/action instead of polling as the normal path.

Expected active engineering: **11–16 h**.

| Task | Outcome | Nominal active time | Depends on |
|---|---|---:|---|
| SL3-P2-A1 | Define ChatGPT browser event protocol and event identities | 60 min | SL3-P1-A10 |
| SL3-P2-A2 | Scaffold dedicated Chrome extension/content-script observer | 75 min | SL3-P2-A1 |
| SL3-P2-A3 | Implement assistant-started and assistant-running observation | 60 min | SL3-P2-A2 |
| SL3-P2-A4 | Implement assistant-completed detection with stable-turn identity | 75 min | SL3-P2-A3 |
| SL3-P2-A5 | Implement composer-ready and send-confirmation observation | 60 min | SL3-P2-A2 |
| SL3-P2-A6 | Implement load-failure, retry-control, auth and security observations | 75 min | SL3-P2-A2 |
| SL3-P2-A7 | Implement localhost event transport with bounded reconnect | 90 min | SL3-P2-A1, SL3-P2-A2 |
| SL3-P2-A8 | Implement direct DOM action executor for send/retry/continue | 75 min | SL3-P2-A5, SL3-P2-A6 |
| SL3-P2-A9 | Keep Brain and Work as persistent warm exact-target tabs | 60 min | SL3-P2-A7, SL3-P2-A8 |
| SL3-P2-A10 | Implement event-driven Brain→Work fast dispatch path | 75 min | SL3-P2-A4, SL3-P2-A9 |
| SL3-P2-A11 | Implement event-driven Work→Brain fast relay path | 75 min | SL3-P2-A10 |
| SL3-P2-A12 | Pass browser-event bridge compatibility regression gate | 90 min | SL3-P2-A11 |

### SL3-P3 — Recovery & Resilience

Recover transient ChatGPT/browser failures with bounded retry/reload/reconnect while preserving exact-once state.

Expected active engineering: **7–11 h**.

| Task | Outcome | Nominal active time | Depends on |
|---|---|---:|---|
| SL3-P3-A1 | Separate transient ChatGPT load failure from deterministic conversation missing | 60 min | SL3-P2-A12 |
| SL3-P3-A2 | Implement bounded Retry-control recovery | 60 min | SL3-P3-A1 |
| SL3-P3-A3 | Implement one-reload recovery after Retry failure | 60 min | SL3-P3-A2 |
| SL3-P3-A4 | Implement bounded CDP/browser reconnect without task loss | 75 min | SL3-P3-A3 |
| SL3-P3-A5 | Preserve quarantine for deterministic missing/access-denied/stable redirect | 60 min | SL3-P3-A1 |
| SL3-P3-A6 | Preserve exact-once latches across page reload/reconnect | 75 min | SL3-P3-A3, SL3-P3-A4 |
| SL3-P3-A7 | Add event-bridge watchdog fallback without normal-path polling | 75 min | SL3-P3-A6 |
| SL3-P3-A8 | Pass fault-injection and no-reload-storm regression gate | 90 min | SL3-P3-A5, SL3-P3-A7 |

### SL3-P4 — Latency & Observability

Measure and reduce Robot overhead while keeping correctness and privacy-safe diagnostics.

Expected active engineering: **5–7 h**.

| Task | Outcome | Nominal active time | Depends on |
|---|---|---:|---|
| SL3-P4-A1 | Define canonical latency timestamps for ChatGPT-first fast path | 45 min | SL3-P3-A8 |
| SL3-P4-A2 | Measure Brain complete→detected→Work send-confirmed latency | 60 min | SL3-P4-A1 |
| SL3-P4-A3 | Measure Work complete→detected→Brain relay-confirmed latency | 60 min | SL3-P4-A1 |
| SL3-P4-A4 | Measure Brain verdict→next dispatch latency | 45 min | SL3-P4-A1 |
| SL3-P4-A5 | Expose safe latency and recovery telemetry in Control Center | 75 min | SL3-P4-A2, SL3-P4-A3, SL3-P4-A4 |
| SL3-P4-A6 | Enforce latency regression budgets without weakening correctness | 75 min | SL3-P4-A5 |

### SL3-P5 — Plus-Only AI Integration Boundary

Keep OpenAI API cost at zero while exposing a transport-neutral local interface that can support future MCP without dependency.

Expected active engineering: **3–5 h**.

| Task | Outcome | Nominal active time | Depends on |
|---|---|---:|---|
| SL3-P5-A1 | Define transport-neutral local Supervisor tool interface | 60 min | SL3-P4-A6 |
| SL3-P5-A2 | Enforce Plus-only/no-paid-OpenAI-API production gate | 45 min | SL3-P5-A1 |
| SL3-P5-A3 | Define future MCP adapter contract without making MCP a dependency | 45 min | SL3-P5-A1 |
| SL3-P5-A4 | Ensure local interface exposes no private chat body/token/URL by default | 60 min | SL3-P5-A1 |
| SL3-P5-A5 | Pass AI-ready interface regression gate | 60 min | SL3-P5-A2, SL3-P5-A3, SL3-P5-A4 |

### SL3-P6 — Legacy Cleanup & Migration

Remove multi-lane machinery from the V3 path, migrate state safely, and retain an isolated rollback entry point until cutover.

Expected active engineering: **6–9 h**.

| Task | Outcome | Nominal active time | Depends on |
|---|---|---:|---|
| SL3-P6-A1 | Remove lane-2/lane-3 config and Control Center surfaces from V3 path | 75 min | SL3-P5-A5 |
| SL3-P6-A2 | Remove round-robin scheduler and multi-lane page-budget logic from V3 path | 75 min | SL3-P6-A1 |
| SL3-P6-A3 | Remove cross-lane mutation arbitration from V3 path | 60 min | SL3-P6-A2 |
| SL3-P6-A4 | Retain isolated legacy Three-Lane rollback entry point until cutover | 45 min | SL3-P6-A3 |
| SL3-P6-A5 | Migrate persisted state safely to single-lane schema | 75 min | SL3-P1-A2, SL3-P6-A4 |
| SL3-P6-A6 | Run full static/unit/integration/lifecycle regression suite | 120 min | SL3-P6-A5 |

### SL3-P7 — Qualification & Owner Cutover

Qualify the locked candidate through smoke, continuous, fault-injection and overnight soak before Owner-authorized deployment.

Expected active engineering: **4–6 h**; mandatory soak wall clock: **13.33 h**.

| Task | Outcome | Nominal active time | Depends on |
|---|---|---:|---|
| SL3-P7-A1 | Run 20-minute smoke qualification on locked V3 candidate | 30 min | SL3-P6-A6 |
| SL3-P7-A2 | Run 1-hour continuous single-lane soak | 30 min | SL3-P7-A1 |
| SL3-P7-A3 | Run 4-hour fault-injection soak with transient load/reconnect scenarios | 60 min | SL3-P7-A2 |
| SL3-P7-A4 | Run 8-hour unattended overnight soak | 60 min | SL3-P7-A3 |
| SL3-P7-A5 | Verify zero duplicate/lost-result/reload-storm/manual-recovery acceptance | 60 min | SL3-P7-A4 |
| SL3-P7-A6 | Prepare Owner-authorized production cutover and rollback manifest | 60 min | SL3-P7-A5 |

## 9. Qualification gates

The locked V3 candidate must pass, in order: **20-minute smoke → 1-hour continuous soak → 4-hour fault-injection soak → 8-hour unattended overnight soak**.

- 0 duplicate dispatch.
- 0 duplicate relay.
- 0 lost completed result.
- 0 unintended Brain replacement.
- 0 unintended Work replacement outside verified rollover.
- 0 reload storm.
- 0 durable-state corruption.
- 0 Owner intervention during final unattended soak.
- all latency stages emitted and privacy-safe.

Old Three-Lane soak evidence remains historical evidence only and cannot qualify V3.

## 10. Realistic time calculation

The roadmap contains **57 bounded tasks**. Their nominal active estimates sum to **61 hours**. Because browser/DOM compatibility work has high rework variance, the planning range is deliberately wider:

- **48–72 hours active engineering**.
- **13 h 20 min mandatory soak wall clock**.
- **6–12 hours CI/debug/review buffer** across the program.
- **64–96 hours realistic elapsed time if operated continuously**.
- **4–7 calendar days** is the realistic planning window with normal pauses/rework.

This estimate excludes Owner-authorized production deployment/cutover time because deployment is a separate explicit gate.

## 11. Brain / Work execution contract

Every implementation task follows **PLAN → DISPATCH → VERIFY → ACCEPT/REJECT → NEXT PLAN**. Only one roadmap task may be active. Work must stop at READY_FOR_VERIFY and must never self-start the next task. Brain must verify the exact result/evidence before emitting ACCEPT. Merge/deploy/hotpatch remains Owner-explicit only.

## 12. Current task boundary

SL3-P0-A1/A2/A3/A4 are accepted predecessors. The exact accepted A4 parent for this change is `09deca9adb977cb2ef0f93c6b7ad33425b1fb720`.

The only active task represented by this change is **SL3-P1-A1 — Define single-lane config and durable registry schema**. P1-A1 is schema/foundation work only: it does not migrate Three-Lane state, read/write legacy state files, activate V3, wire production runtime, dispatch/relay browser work, change browser behavior, restart Chrome, mutate production/local Supervisor state, alter legacy rollback entry points, merge/deploy/hotpatch, or change Robot durable project progress.

**SL3-P1-A1 stop state: READY_FOR_VERIFY.** The next dependency-correct task is **SL3-P1-A2 — Implement legacy three-lane state reader and safe single-lane migration adapter**, but SL3-P1-A2 remains **NOT STARTED** until Brain VERIFY/ACCEPT of P1-A1.
