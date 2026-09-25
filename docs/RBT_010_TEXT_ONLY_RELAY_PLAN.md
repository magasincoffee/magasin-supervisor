# TASK-RBT-010 — Text-Only Result Relay / Screenshot Evidence Removal

Status: **OWNER AUTHORIZED / READY / NOT STARTED**  
Machine-readable authority: `docs/RBT_010_TEXT_ONLY_RELAY_AUTHORITY.json`  
Authority baseline: `magasincoffee/magasin-supervisor@bd05eccb15bee4c302b910e5ccf00baa90071fab`

## Authority effect

This document records the Owner decision to **clear the screenshot/attachment layer completely from the Brain ↔ Work result-relay workflow**.

It authorizes the future implementation scope only. It does **not** change production runtime behavior and does **not** mark TASK-RBT-010 complete.

Until a separate implementation, qualification and deployment task succeeds, the current released screenshot-based relay contract remains production truth.

## Target architecture

The completed Work result must be relayed to the exact Brain as text only:

```text
Work completed assistant turn
        ↓
capture full text
        ↓
response_digest + text_digest
        ↓
persist exact relay_inflight identity
        ↓
bounded text send to exact Brain
        ↓
deterministic relay marker
        ↓
marker-authoritative exact-once confirmation
```

The target architecture must have no result screenshot capture, no result-image upload, no screenshot-path prerequisite, and no screenshot-specific evidence-missing failure branch.

## Required preservation

TASK-RBT-010 must preserve:

- exact `task_id`;
- exact `relay_id`;
- `response_digest`;
- `text_digest`;
- Brain/Work target identity and revisions;
- retry budget and Owner rearm semantics;
- marker-authoritative dedupe;
- restart/recovery semantics;
- pending Work target state;
- lane isolation;
- Owner STOP authority;
- process-first lifecycle truth.

Removing images is not authority to resend a result, reset a task, replace a target, or clear a latch destructively.

## Authorized implementation scope

1. Remove Work-result screenshot capture from `three-lane-cli.mjs`.
2. Route result relay through the bounded text-send path instead of attachment upload.
3. Remove `screenshot_path` from newly-created relay latches.
4. Remove screenshot-file existence as a relay retry/rearm prerequisite.
5. Add backward-compatible normalization for existing `relay_inflight` records containing `screenshot_path`.
6. Remove screenshot-specific orphan-GC / `lane-evidence` logic when no longer referenced by active production code.
7. Remove only screenshot-specific message-capture helpers that become unused.
8. Delete or retain generic attachment helpers based on independent remaining usage; do not expand scope merely because they exist.
9. Replace screenshot/attachment regression assertions with text-only exact-once assertions.
10. Run full CI, integrity, lifecycle and autostart gates.
11. Deploy only after green gates and perform targeted live acceptance with production target fingerprints unchanged.

## Legacy-state migration requirement

A live lane may already contain a persisted relay latch created by the released screenshot workflow.

Migration must be non-destructive:

- retain relay identity and digests;
- retain attempt/rearm state where semantically valid;
- stop requiring the historical PNG to proceed;
- remove obsolete screenshot-only fields at a safe persisted boundary;
- reconcile the exact Brain marker before any resend decision;
- never infer that a missing PNG means the business result is missing when canonical result text/digests are already persisted/reconstructable under the existing exact-result identity.

If a legacy latch cannot be proven safe for text-only continuation, fail closed and expose the condition rather than resetting the task.

## Regression surface

At minimum update/replace screenshot-dependent assertions in:

- `test/three-lane-runtime.test.mjs`;
- `test/relay-clean-sweep-v44.test.mjs`;
- `test/relay-rearm-recovery.test.mjs`;
- `test/relay-retry-v48.test.mjs`.

Also run the full suite because relay state is coupled to restart, scheduler, Owner hot-save, watchdog, rollover and lifecycle invariants.

## Definition of Done

TASK-RBT-010 is complete only when:

- production result relay captures **zero screenshots**;
- production result relay uploads **zero screenshot attachments**;
- new relay latches contain no screenshot-path dependency;
- legacy screenshot latches migrate safely without duplicate relay;
- result text remains complete and unchanged as the Brain report;
- `relay_id + response_digest + text_digest + deterministic marker` remain the exact-once authority;
- bounded retry and Owner rearm remain functional;
- restart reconciliation remains functional;
- no screenshot-specific `EVIDENCE_MISSING` block can strand an otherwise valid text result;
- screenshot-specific local evidence storage/GC is removed from the active relay workflow;
- required CI/integrity/lifecycle/autostart gates are green;
- production deployment preserves Brain/Work target fingerprints;
- live Wrapper / Three-Lane / Chrome / CDP truth is healthy after deployment;
- no project reset, Chrome-profile clear, target mutation, runner mutation or autostart mutation occurs.

## Expected execution window

Estimated implementation + regression + CI + targeted production acceptance: **1.5–2 hours**.

This is an engineering estimate, not a completion claim.

## Next action

**WAIT FOR OWNER CONTINUATION.**

Do not begin TASK-RBT-010 implementation from this authority commit alone until the Owner resumes the execution discussion.
