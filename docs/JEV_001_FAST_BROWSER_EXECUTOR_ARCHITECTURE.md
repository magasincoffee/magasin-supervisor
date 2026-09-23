# JEV-001 — Optional Fast Browser Executor Architecture

Status: **OWNER APPROVED / PLANNING-ONLY / NOT RELEASED**  
Task: `JEV-001 — OPTIONAL FAST BROWSER EXECUTOR`  
Production runtime currently under MIG-006 qualification: `218f330ee86eea4f0fb79ef9293bd43cf96a45de`

> Hard gate: do not merge, install, or deploy JEV-001 until MIG-006 is canonically closed.

## Decision

Jev Ultrafast is accepted only as an **optional fast-path browser executor** behind MAGASIN Supervisor.

```text
Brain
  ↓
Supervisor policy / safety / router
  ├─ JEV_FAST_EXECUTOR
  └─ EXISTING_CDP_EXECUTOR
  ↓
Independent Supervisor verifier
  ↓
ACCEPT / REJECT / FALLBACK / WAIT_OWNER
```

Core invariant: **JEV DONE != TASK DONE**. Only Supervisor postcondition verification may accept a browser outcome.

Jev does not replace Brain planning, Supervisor lifecycle truth, lane scheduler, exact-once dispatch/relay, Owner STOP, stale-target quarantine, watchdog/rollover, privacy boundaries, or the existing CDP fallback.

## Upstream planning pin

- repository: `browser-use/jev-ultrafast`
- reference commit: `1231850a0bf1a0c0341fe408ef1668dbbfdfac46`
- license at reference: MIT
- Python requirement at reference: `>=3.12`
- package version at reference: `0.1.0`

Production implementation must pin a reviewed commit or release; never float on upstream `main`.

## Preferred integration boundary

```text
MAGASIN Supervisor (Node.js)
        ↓ local bounded IPC
Jev adapter / Python sidecar
        ↓
dedicated MAGASIN Chrome/CDP boundary
```

The sidecar is local-only, timeout-bounded, restartable, and has no authority to mutate Supervisor registry, clear Owner STOP, create Brain targets, bypass exact-target checks, or declare task success.

## Router contract

Jev fast path is eligible only when:

1. exact target passed Supervisor target-health checks;
2. Owner STOP/AUTOSTART_DISABLED is clear;
3. task/lane/revision/generation/latches are internally consistent;
4. global mutation lease is available when mutation is required;
5. page/action class is supported by the pinned Jev build;
6. action is outside protected Owner boundaries;
7. timeout/action budget is explicit;
8. deterministic postcondition verification exists.

Immediate fallback to existing executor or WAIT_OWNER for unsupported/ambiguous cases, including iframe/frame, unsupported shadow DOM, canvas-only UI, file upload, popup/new-tab ownership, arbitrary keyboard widgets, unsafe nested scrolling, ambiguous freshness, sidecar failure, malformed response, or missing verifier.

Fallback is never permission to replay an uncertain destructive action. Supervisor must reconcile state before trying another executor.

## Protected boundaries

Jev must never autonomously cross credentials/password, OTP/MFA/recovery codes, CAPTCHA, KYC/identity, tax, banking/payment, protected legal acceptance, destructive/admin actions, spend above approved budget, or ambiguous security decisions.

## IPC target

Request and response must use bounded versioned JSON. Minimum request fields: request_id, lane_id, target_role, goal, mode, max_actions, timeout_ms, allowed_operations. Minimum response fields: request_id, executor, status, actions_executed, elapsed_ms, fallback_required, verifier_required.

IPC must not carry cookies, authorization headers, tokens, passwords, raw browser-profile paths, screenshots by default, unrestricted JavaScript, or shell commands.

## Independent verifier

Every Jev `DONE` requires Supervisor verification using the same or stronger postcondition as the existing executor. Examples include expected route/class visible, expected form value present, expected status label visible, exact dispatch marker confirmed, or expected filter/table state.

```text
JEV DONE
→ verifier FAIL
→ reconcile current page/state
→ fallback or WAIT_OWNER
```

Failed verification can never be reinterpreted as successful execution.

## Exact-once and mutation safety

For mutation-capable actions: persist/reconcile intent → acquire mutation lease → execute once → verify → record privacy-safe metadata → advance state.

Changing executor must not reset dispatch_id, relay_id, task ID, Work generation, target revision, pending target, stale-target quarantine, or watchdog/recovery epoch.

## Observability

Allowed privacy-safe metadata: executor_selected, router_reason_code, request_id digest, action_count, elapsed_ms, fallback_reason_code, verifier_result, executor_error_class, timeout boolean.

Never emit raw page text, private URLs, credentials, tokens, cookies, or message bodies into Git evidence.

## JEV-001 acceptance

JEV-001 requires all of the following before production:

- functional parity with existing executor on bounded tasks;
- independent verifier parity;
- unsupported-capability fallback matrix;
- protected-boundary fail-closed tests;
- exact-once dispatch/relay regression;
- no mutation replay after timeout/crash;
- sidecar restart preserves lane truth;
- scheduler fairness and page-budget regression;
- comparative benchmark on at least three browser-unit families;
- bounded production canary after Owner review.

Benchmark families: simple navigation/filter, structured form fill/select, and read-only status inspection. Report alternating Jev vs existing-executor runs with median elapsed time, pass/fail, action count, browser-protocol calls when measurable, fallback count, and verifier mismatches. No general speed claim from one upstream benchmark or one MAGASIN task.

## Release sequence

```text
MIG-006 closes
→ JEV-001 implementation branch
→ unit/offline contract tests
→ isolated browser fixtures
→ comparative benchmark
→ fail-closed fallback matrix
→ exact-once/lifecycle regression
→ Owner-reviewed release candidate
→ bounded production canary
```

A runtime version bump is considered only when executable production semantics actually change.

## Five-Step

QUESTION — can Jev shorten browser decision cycles without owning orchestration truth?  
DELETE — no duplicate scheduler/lifecycle/Brain authority/task state.  
SIMPLIFY — one optional executor behind one Supervisor router and one verifier.  
ACCELERATE — structured indexed DOM execution where supported.  
AUTOMATE — deterministic routing, verification and fail-closed fallback.
