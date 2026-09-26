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

This Source-of-Truth pivot is **SL3-P0-A1**. It is documentation/repository-authority work only. It does not change the production runtime, restart Chrome, mutate local lane state, or deploy V3. After this change is independently verified, the next task is **SL3-P0-A2**.
