# MIG-006 — RBT-009 Final Exact-Runtime-SHA Tier B Evidence

Status: **QUALIFIED / COMPLETE — RBT-009 TIER B PASS**

## Canonical qualification result

- workflow run: `35860156388` — **success**
- Tier B job: `107180300345` — **success**
- control-plane SHA: `3fee892fb9677ab5ea5f60d265858d752d9f9bef`
- locked runtime candidate: `218f330ee86eea4f0fb79ef9293bd43cf96a45de`
- verified duration: **28,843 seconds (8h00m43s)**
- sample count: **240**
- `MIG_006_TIER_B_QUALIFIED=True`
- `RBT009_TIER_B_480M=PASS`
- `SOAK_CONTINUOUS_DURATION_8H=True`
- `SOAK_NO_DUPLICATE_DISPATCH=True`
- `SOAK_NO_DUPLICATE_RELAY=True`
- `SOAK_EVENT_ORDER_VALID=True`
- `SOAK_PRODUCTION_TARGETS_UNCHANGED=True`
- `SOAK_REGISTRY_LATCHES_UNCHANGED=True`
- `SOAK_ARTIFACT_PRIVACY_SAFE=True`
- runtime mode: `ALL_DISABLED_QUIESCENT`
- production ownership authority instances: **1**
- production runtime authority active: **false**

MIG-005 cutover is independently supported by PR #10 and canonical merge `cca403faf0704d52ca488d7fecf3c72809a52291`; it is not inferred from Tier B.

The release-request and pre-run manifest values such as `NOT_STARTED`, `PENDING`, and `NOT_RUN` are historical pre-run checkpoints. This closure result is the later verified current state.

No repository-authoritative next task is defined here, so no next task is invented.

## Locked certification target

- Owner release source: `magasincoffee/magasincoffee.github.io@fac10cff7fc1c5f05ce9b80d101ebd53b3331190`
- Target repository start: `cca403faf0704d52ca488d7fecf3c72809a52291`
- Runtime candidate under certification: `218f330ee86eea4f0fb79ef9293bd43cf96a45de`
- Required Tier B duration: **480 continuous minutes from zero**
- Sample interval: **120 seconds**
- Historical interrupted soak credit: **0**
- State root: `%LOCALAPPDATA%\MAGASIN\Supervisor`
- Pinned runner: `DESKTOP-4K7IM13` / Windows / X64

The control-plane PR may have a newer SHA than the runtime under test. The workflow records both. The runtime candidate is locked and may not be silently redefined by workflow/test/documentation commits.

## Production ownership baseline

MIG-005 established:

- lane_count = 3
- registry_lane_count = 3
- enabled_lane_count = 0
- Owner STOP = false
- new autostart ownership = true
- production ownership authority instances = 1
- production runtime authority instances = 0
- old runtime/autostart authority inactive
- old rollback state retained

This is a legitimate `ALL_DISABLED_QUIESCENT` production-ownership state. Tier B does not enable lanes and does not start Supervisor.

## Runtime/control-plane separation

Tier B checks out `218f330e...` into an isolated candidate path and verifies the installed production runtime marker plus source-file identity against that checkout before the timer starts. The installed runtime is not repaired, reinstalled, or mutated by MIG-006.

The candidate monitor script remains byte-identical to the locked runtime candidate. Its legacy unconditional `SOAK_CHROME_CDP_HEALTH=True` marker is redirected to a private temporary log and is **not** canonical evidence. MIG-006 normalizes Chrome/CDP to:

`NOT_APPLICABLE_ALL_DISABLED`

because runtime authority is intentionally OFF.

## Start gate

The 480-minute timer may begin only after:

- Supervisor Tests GREEN
- Supervisor Integrity static GREEN
- Lifecycle isolated GREEN
- Autostart isolated GREEN
- RBT Tier A synthetic GREEN
- MIG-006 contract tests GREEN
- exact control-plane SHA verified
- exact runtime candidate checkout verified
- installed runtime identity verified
- pinned new-machine runner verified
- pending reboot false
- current-source sleep timeout compatible with uninterrupted run
- no scheduled Update Orchestrator reboot in the qualification window
- explicit platform state root verified
- topology 3/3, enabled=0
- Owner STOP=false
- new autostart ownership present
- runtime authority OFF

Production-mutating install/start workflow jobs remain disabled.

## Qualification semantics

During Tier B, every safety sample requires Owner STOP=false, 3/3 topology, enabled=0, target config fingerprint unchanged, registry/latch fingerprint unchanged, autostart ownership unchanged and runtime authority OFF.

Only event-stream bytes after the recorded soak-window baseline offset are evaluated. Zero event growth is a valid all-disabled result; exact-once/order checks then pass vacuously. Raw events are temporary local inputs only and are deleted before artifact upload.

Machine sleep, runner interruption, cancellation, reboot risk, target/latch mutation, Owner STOP, authority mismatch, state-root mismatch, event-stream truncation/rotation that prevents complete validation, candidate monitor error, or duration below 480 minutes makes the attempt **NON_QUALIFYING**. Partial duration credit is always zero.

The only uploaded artifact is a sanitized summary. It contains no raw URLs, messages, cookies, tokens, screenshots, browser-profile paths, raw state, raw events, user email, or account identifiers.

`RBT009_TIER_B_480M=PASS`

## Canonical closure

MIG-006 and RBT-009 are **COMPLETE** using the existing successful Tier B evidence. This closure did not rerun the soak or mutate the production runtime, targets, latches, browser profile, runner configuration, autostart, or local production files.
