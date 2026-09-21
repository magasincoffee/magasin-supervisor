# MAGASIN Robot Lifecycle Truth Architecture

Task: TASK-060/ROBOT-LIFECYCLE-TRUTH-ARCHITECTURE-01  
Status: production architecture lock before implementation

Scheduler/observability extension: `TASK-RBT-001/ROBOT-SCHEDULER-OBSERVABILITY-ARCHITECTURE-01`  
Canonical extension: `ROBOT_BROWSER_SCHEDULER_OBSERVABILITY_ARCHITECTURE.md`

The scheduler/observability extension does **not** replace this lifecycle architecture. The truth hierarchy below remains authoritative.

## 1. Truth hierarchy

Mandatory order:

1. PROCESS TRUTH
2. LANE TRUTH
3. PERSISTED RECOVERY STATE

Persisted JSON is recovery memory only. It is never proof that Supervisor, Three-Lane, Robot Chrome, or CDP is alive.

A Control Panel lane may only be rendered as an active business state such as WORKING or RELAYING_RESULT when required process truth is healthy. If runtime health is absent while a lane has enabled/pending work, UI must show STARTING or RECOVERING until health is restored.

The future scheduler may expose page-budget, lease and task-timing summaries, but those summaries are diagnostics. They do not outrank PROCESS TRUTH, LANE TRUTH or durable task/latch state.

## 2. Process truth

Process truth is derived from live OS/runtime evidence:

- Supervisor wrapper process exists and is the dedicated MAGASIN wrapper.
- Three-Lane node runtime exists.
- dedicated Robot Chrome uses the MAGASIN browser profile.
- the dedicated Chrome remote-debugging port responds with a websocket debugger URL.
- runtime version and mode are compatible with installed source.

Process banner and lane business state are separate concepts. The UI may say the runtime is RECOVERING while preserving a pending lane task, but it must never say ROBOT BACKGROUND OFF and WORKING as if both were simultaneously authoritative.

Browser-page count is not process truth by itself. A healthy dedicated Chrome/CDP may legitimately have zero, one, two or three leased ChatGPT pages while durable lane state remains local.

## 3. Lane truth

Lane truth comes from current config + current runtime status:

- enabled/disabled is Owner configuration truth.
- Brain URL and Work URL are Owner/Robot authoritative targets and must not be autodiscovered or silently replaced.
- task_id, awaiting_work, dispatch_inflight, relay_inflight and result history are orchestration truth only after process health is known.
- lane-1 must operate independently when lane-2 and lane-3 are disabled.
- one lane failure must not corrupt another lane.
- a future pending Work target revision is configuration intent for the next safe boundary; it must not silently replace the exact Work target of an active task.
- scheduler fairness/page leases do not merge lane state. Lane targets/latches remain independent even though Chrome/CDP and the page budget are shared.

## 4. Persisted recovery state

Files such as lanes.json, lane-registry.json, lane-status.json and related runtime JSON exist so a restarted runtime can reconcile exact targets and exact-once latches.

They may preserve:

- Brain URL / revisions.
- Work URL / revisions.
- pending Work URL/revision when future hot-swap is implemented.
- Work generation.
- task_id and instruction digest.
- dispatch_inflight.
- relay_inflight.
- awaiting_work.
- task timing/watchdog timestamps when future observability is implemented.
- last confirmed relay/dispatch markers.

They may not prove liveness.

After restart, the runtime must reconcile existing Brain/Work/latches before any resend. Exact marker evidence wins; no duplicate dispatch or relay is permitted.

Future browser tabs/page leases are reconstructed from durable state after restart. They are never required to survive restart and are never the only copy of a task or latch.

## 5. Owner STOP authority

Owner STOP is fail-closed and always wins.

If either STOP or AUTOSTART_DISABLED is present:

- opening Control Panel must not auto-start Supervisor.
- install/autostart/recovery must not bypass Owner STOP.
- enabled lane config is retained for later recovery, but runtime remains stopped.
- UI must distinguish "Owner stopped runtime" from normal recoverable runtime loss.
- future scheduler/watchdog/full-rollover/hot-swap automation must not create pages, reload, send, or mutate ChatGPT.

Only an explicit Owner START operation may clear STOP/AUTOSTART_DISABLED.

The per-lane "BẮT ĐẦU LUỒNG" action only changes disabled → enabled. It must not redefine process truth or silently override Owner STOP.

## 6. Automatic recovery rule

When Control Panel opens:

- if all lanes are disabled: do not auto-start anything.
- if one or more lanes are enabled and Owner STOP/AUTOSTART_DISABLED is absent: verify process truth.
- if Supervisor/Three-Lane/Robot Chrome/CDP are unhealthy: enter STARTING/RECOVERING and invoke bounded recovery.
- if already healthy: do not restart healthy processes.
- after recovery: re-read process truth, then lane truth, then persisted recovery state.

The same lifecycle model must be used by start/run/install/autostart/repair paths.

The future browser scheduler starts only after process truth is healthy. It must not be used as a substitute for wrapper/Chrome/CDP health recovery.

## 7. Chrome/CDP recovery

Dedicated Robot Chrome is process truth only when:

- it uses the MAGASIN dedicated profile,
- its configured CDP listener belongs to that Chrome,
- /json/version responds with a websocket debugger URL.

A dead Chrome/CDP must be recovered without touching Owner's normal Chrome profile.

The scheduler/observability architecture keeps one dedicated Chrome profile as the default. A second profile must not be introduced merely to mask tab pressure without measured evidence and a separately reviewed architecture change.

## 8. Crash/reopen behavior

Reopening Control Panel after a crash must be sufficient to recover an enabled runtime, unless Owner STOP is active.

No Owner click on "BẮT ĐẦU LUỒNG" is required merely to recover a dead runtime for an already-enabled lane.

After process recovery, future scheduler state must be rebuilt from durable lane config/registry rather than assuming old browser tabs still exist.

## 9. Five-Step method

### QUESTION
What truth is authoritative at each layer? Persisted state is not liveness.

### DELETE
Delete UI/runtime assumptions that infer liveness from JSON alone or mix process banner with lane business state.

The scheduler extension additionally deletes permanent per-lane tab ownership, unbounded page growth, reload-by-elapsed-time assumptions, mandatory restart for Work target apply, and opaque long-running WORKING state.

### SIMPLIFY
Use one lifecycle rule: PROCESS TRUTH > LANE TRUTH > PERSISTED RECOVERY STATE.

The scheduler extension stays inside this rule: durable registry/config owns task/target truth; browser pages are transient resources.

### ACCELERATE
Centralize bounded health probes/recovery so Control Panel, start, autostart and repair converge on the same result.

Future scheduler steps must also be bounded/resumable so one lane cannot hold shared browser resources indefinitely.

### AUTOMATE
When >=1 lane is enabled and Owner STOP is absent, Control Panel automatically restores Supervisor + Three-Lane + Robot Chrome/CDP and the runtime reconciles exact targets/latches.

After TASK-RBT implementation, automation may additionally schedule bounded page leases, watchdog recovery, Work rollover and hot-swap, but only after process truth is healthy and exact-once state is reconciled.

## 10. BEFORE inventory

Known production components before TASK-060:

- windows/control-panel.ps1 — owns UI, lane enable/disable, shows process banner and lane states.
- windows/start-supervisor.ps1 — starts wrapper and currently clears STOP/AUTOSTART_DISABLED as part of explicit START.
- windows/run-supervisor.ps1 — owns dedicated Chrome/CDP and launches runtime loop.
- windows/stop-supervisor.ps1 — sets STOP + AUTOSTART_DISABLED and stops dedicated runtime.
- windows/install-supervisor.ps1 — installs current runtime.
- windows/repair-supervisor.ps1 — reinstall/repair path with runtime fingerprint checks.
- src/runtime/three-lane-cli.mjs — Three-Lane orchestration and exact-once dispatch/relay.
- .github/workflows/supervisor-autostart-install.yml — install + survival checks.
- .github/workflows/supervisor-integrity.yml — static + self-hosted integrity audit.
- test/brain-worker-windows.test.mjs, test/windows-repair.test.mjs, test/three-lane-runtime.test.mjs — lifecycle-adjacent regression coverage.

Observed design defect before TASK-060:

- Control Panel can read persisted lane-status.json and render WORKING even when required live processes are absent.
- Process banner and lane business status are not composed under one mandatory truth hierarchy.
- opening Control Panel does not yet have one explicit rule that automatically restores an enabled runtime while respecting STOP/AUTOSTART_DISABLED.
- restart recovery semantics exist in multiple places but are not yet expressed as a single lifecycle contract.

Additional v50 scheduler/observability gaps are documented in `ROBOT_BROWSER_SCHEDULER_OBSERVABILITY_ARCHITECTURE.md`; they are not lifecycle-truth regressions and must be fixed without replacing the lifecycle hierarchy.

## 11. Acceptance A-L

A. all lanes disabled → opening panel does not auto-start runtime.  
B. lane-1 enabled + runtime OFF → opening panel auto-starts runtime when Owner STOP is absent.  
C. persisted WORKING + runtime OFF → UI shows STARTING/RECOVERING before process health, never stale WORKING.  
D. pending task/latches survive restart and exact-once reconciliation prevents duplicate dispatch/relay.  
E. healthy runtime → opening panel does not restart it.  
F. Owner STOP/AUTOSTART_DISABLED always wins.  
G. dead Three-Lane runtime is recovered.  
H. dead dedicated Chrome/CDP is recovered.  
I. lane-1-only runs fully with lane-2/3 disabled.  
J. three lanes remain isolated and do not cross-corrupt state.  
K. process banner and lane status are consistent and cannot contradict each other.  
L. reopen panel after crash automatically recovers enabled runtime without requiring another BẮT ĐẦU LUỒNG click.

The future scheduler/observability release adds its own acceptance matrix, but A-L remain mandatory regressions.

## 12. Implementation constraints

- no Brain autodiscovery.
- no Brain autocreation.
- no automatic change to Owner-selected Brain URL.
- Owner-selected Work revisions may be applied only under the explicit hot-swap contract: idle applies immediately; active work/latches are preserved and the new target is pending-next-target.
- Robot-managed Work rollover may change Work URL only after verified full/capacity evidence and safe rollover semantics.
- retain exact-once dispatch_id / relay_id behavior.
- use bounded recovery only.
- no unconditional minute-30 reload.
- no reload loop.
- browser pages are transient resources; task/latch truth must survive close/reopen/reload.
- retain max one destructive UI mutation until evidence supports a change.
- merge implementation only after full Supervisor tests and CI are green.
- production PASS for runtime changes requires self-hosted install + survival + E2E/soak after merge.

## 13. AFTER inventory

Production implementation after TASK-060:

- `windows/lifecycle-truth.ps1` — shared source of live PROCESS TRUTH, enabled-lane truth, Owner STOP truth and bounded recovery start.
- `windows/control-panel.ps1` — process banner and lane business state are composed separately; stale persisted WORKING is suppressed until process truth is healthy; panel auto-recovers enabled lanes; per-lane START only enables lane intent.
- `windows/start-supervisor.ps1` — explicit Owner START is the only path that clears STOP/AUTOSTART_DISABLED; `-Recovery` is fail-closed.
- `windows/run-supervisor.ps1` — wrapper refuses launch/continuation under STOP/AUTOSTART_DISABLED and retains bounded Three-Lane/Chrome/CDP self-healing.
- `windows/stop-supervisor.ps1` — remains the authoritative Owner STOP writer.
- `windows/install-supervisor.ps1` — technical runtime replacement preserves Owner STOP.
- `windows/install-autostart.ps1` — registers recovery without clearing Owner STOP.
- `windows/autostart-bootstrap.ps1` — auto-start requires >=1 enabled lane and no Owner STOP.
- `windows/repair-supervisor.ps1` — technical repair preserves Owner STOP and only recovers when lifecycle truth allows.
- `src/runtime/three-lane-cli.mjs` — runtime v2026-09-20.52 preserves truth-order and exact-once Brain/Work/latch reconciliation, retains TASK-RBT-002 event/timing foundation, and adds TASK-RBT-003 pending-safe Work target hot-swap.
- `.github/workflows/supervisor-autostart-install.yml` — lifecycle-driven deploy/survival; no longer force-enables lane-1 or converts business PAUSED state into local Owner STOP.
- `.github/workflows/supervisor-integrity.yml` — static and self-hosted process-truth integrity audit.
- `.github/workflows/supervisor-open-control-panel.yml` — opener verifies all-disabled, Owner STOP, recovery and healthy-no-restart behavior.
- `.github/workflows/supervisor-lifecycle-acceptance.yml` — production self-hosted acceptance A→L with target-preservation guard.
- `test/lifecycle-truth-v50.test.mjs` and aligned Windows/runtime tests — regression coverage for lifecycle truth and legacy semantic separation.
- No Brain autodiscovery path was added.
- No production diagnostic workflow from TASK-049 was restored.

Root cause removed:

1. lane-status JSON can no longer outrank live process health in the Control Panel;
2. process recovery no longer depends on pressing per-lane START again;
3. technical install/autostart/repair no longer clears or manufactures Owner STOP state;
4. enabled-lane recovery and all-disabled suppression use one shared lifecycle contract;
5. business execution state and process lifecycle are no longer conflated.

## 14. Scheduler/observability extension boundary

`ROBOT_BROWSER_SCHEDULER_OBSERVABILITY_ARCHITECTURE.md` is the canonical production design for TASK-RBT-002 through TASK-RBT-009.

It must be implemented **inside** this lifecycle architecture, not beside it.

The extension locks:

- finite page budget and round-robin fairness;
- exact page lease/close/reopen semantics;
- long-running task timing and 30-minute inactivity watchdog;
- multi-signal Work-full detection/rollover;
- Work URL hot-swap without restart;
- append-only privacy-safe operational events;
- Control Panel timeline/resource UX;
- Brain PLAN → DISPATCH → VERIFY → ACCEPT/REJECT → NEXT PLAN;
- production 1/2/3-lane soak acceptance.

Until those TASK-RBT implementation tasks are merged and accepted, runtime v2026-09-19.50 behavior remains current production truth.

Final release acceptance is recorded only after PR merge, self-hosted install/survival, lifecycle A→L and production integrity all pass.
