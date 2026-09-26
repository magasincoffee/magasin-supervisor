import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  RELAY_RECONCILE_OUTCOMES,
  classifyRelayMarkerState,
  migrateLegacyBlockedRelayLatches
} from "../src/runtime/relay-reconciliation.mjs";
import {
  normalizeLaneConfig,
  normalizeLaneRegistry,
  buildWorkDispatchInstruction,
  workDispatchMarker
} from "../src/runtime/three-lane.mjs";

test("v44 marker-present relay is exact-once confirmed even when legacy latch was blocked", () => {
  assert.equal(
    classifyRelayMarkerState({ markerPresent: true, brainStable: false }),
    RELAY_RECONCILE_OUTCOMES.CONFIRMED
  );
});

test("v44 marker-absent stable Brain is safe NOT_CONFIRMED retry", () => {
  assert.equal(
    classifyRelayMarkerState({ markerPresent: false, brainStable: true }),
    RELAY_RECONCILE_OUTCOMES.NOT_CONFIRMED
  );
});

test("v44 busy Brain keeps relay PENDING without forcing a retry", () => {
  assert.equal(
    classifyRelayMarkerState({ markerPresent: false, brainStable: false }),
    RELAY_RECONCILE_OUTCOMES.PENDING
  );
});

test("RBT-010 legacy relay screenshot fields migrate without changing relay identity", () => {
  const registry = normalizeLaneRegistry({
    lanes: {
      "lane-1": {
        relay_inflight: {
          relay_id: "r1",
          response_digest: "a".repeat(64),
          text_digest: "b".repeat(64),
          screenshot_path: "C:/evidence/lane-1-a.png"
        }
      },
      "lane-2": {
        relay_inflight: {
          relay_id: "r2",
          screenshot_path: "C:/evidence/lane-2-b.png"
        }
      },
      "lane-3": { relay_inflight: null }
    }
  });
  const migrated = migrateLegacyBlockedRelayLatches(registry);
  assert.equal(migrated, 2);
  assert.equal(registry.lanes["lane-1"].relay_inflight.relay_id, "r1");
  assert.equal(registry.lanes["lane-1"].relay_inflight.response_digest, "a".repeat(64));
  assert.equal(registry.lanes["lane-1"].relay_inflight.text_digest, "b".repeat(64));
  assert.equal("screenshot_path" in registry.lanes["lane-1"].relay_inflight, false);
  assert.equal("screenshot_path" in registry.lanes["lane-2"].relay_inflight, false);
});

test("lane-1-only config does not enable or mutate other lane identities", () => {
  const config = normalizeLaneConfig({
    lanes: [
      { lane_id: "lane-1", enabled: true },
      { lane_id: "lane-2", enabled: false },
      { lane_id: "lane-3", enabled: false }
    ]
  });
  assert.equal(config.lanes[0].enabled, true);
  assert.equal(config.lanes[1].enabled, false);
  assert.equal(config.lanes[2].enabled, false);

  const registry = normalizeLaneRegistry({
    lanes: {
      "lane-1": { task_id: "TASK-L1", awaiting_work: true },
      "lane-2": { task_id: "TASK-L2", awaiting_work: false },
      "lane-3": { task_id: "TASK-L3", awaiting_work: false }
    }
  });
  registry.lanes["lane-1"].relay_inflight = { relay_id: "r1" };
  assert.equal(registry.lanes["lane-2"].relay_inflight, null);
  assert.equal(registry.lanes["lane-3"].relay_inflight, null);
});

test("v44 runtime migrates pre-existing blocked relay and never terminal-blocks or reloads relay reconciliation", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("async function reconcileRelayInflight");
  const end = source.indexOf("async function relayWorkResult", start);
  const reconcile = source.slice(start, end);

  assert.match(reconcile, /if \(latch\.reconcile_blocked\)/);
  assert.match(reconcile, /latch\.reconcile_blocked = false/);
  assert.match(reconcile, /LANE_RESULT_RELAY_BLOCKED_LATCH_RECOVERED/);
  assert.match(reconcile, /classifyRelayMarkerState/);
  assert.match(reconcile, /LANE_RESULT_RELAY_NOT_CONFIRMED_RETRY/);
  assert.doesNotMatch(reconcile, /return "BLOCKED"/);
  assert.doesNotMatch(reconcile, /page\.reload/);
  assert.doesNotMatch(reconcile, /LANE_RESULT_RELAY_RECONCILE_RELOAD/);
});

test("relay confirmation, Brain change and explicit maintenance reset clear evidence while Work hot-save preserves it", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /async function clearRelayInflight/);
  assert.doesNotMatch(source, /unlinkRelayScreenshot|screenshot_path/);
  assert.match(source, /LANE_RESULT_RELAY_DEDUPED_BY_MARKER[\s\S]*?return "CONFIRMED";/);
  assert.match(source, /await clearRelayInflight\(registryLane\)/);
  assert.match(source, /async function finalizeConfirmedRelay/);
  assert.match(source, /applyOwnerBrainTarget[\s\S]*?await clearRelayInflight\(registryLane\)/);

  const workSaveStart = source.indexOf("async function applyOwnerWorkTarget");
  const workSaveEnd = source.indexOf("async function applyPendingWorkTargetAtSafeBoundary", workSaveStart);
  const workSave = source.slice(workSaveStart, workSaveEnd);
  assert.doesNotMatch(workSave, /clearRelayInflight\(registryLane\)/);

  const resetStart = source.indexOf("async function applyOwnerWorkStateReset");
  const resetEnd = source.indexOf("async function applyOwnerWorkTarget", resetStart);
  const maintenanceReset = source.slice(resetStart, resetEnd);
  assert.match(maintenanceReset, /await clearRelayInflight\(registryLane\)/);
});

test("RBT-010 removes screenshot GC and performs only one legacy lane-evidence cleanup on boot", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /cleanupOrphanRelayEvidence|activeRelayScreenshotPaths/);
  assert.match(source, /fs\.rm\(path\.join\(root, "lane-evidence"\), \{ recursive: true, force: true \}\)/);
});

test("v44 preserves Owner Brain hot-swap contract while cleaning only relay evidence", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /async function applyOwnerBrainTarget/);
  assert.match(source, /brain_url_revision/);
  assert.match(source, /registryLane\.brain_url = configuredUrl/);
  assert.match(source, /await clearRelayInflight\(registryLane\)/);
});

test("legacy Work dispatch marker envelope remains reconstructable under v60 migration", () => {
  const text = buildWorkDispatchInstruction({
    taskId: "TASK-049/WORK-DISPATCH-V43-E2E-04",
    dispatchId: "17bb5c7442e65d9f6350f61330c595dd",
    instruction: "READ ONLY",
    planningContract: false
  });
  assert.equal(
    text,
    [
      "MAGASIN_WORK_DISPATCH_V1",
      "task_id=TASK-049/WORK-DISPATCH-V43-E2E-04",
      "dispatch_id=17bb5c7442e65d9f6350f61330c595dd",
      "",
      "READ ONLY"
    ].join("\n")
  );
  assert.equal(
    workDispatchMarker("17bb5c7442e65d9f6350f61330c595dd"),
    "dispatch_id=17bb5c7442e65d9f6350f61330c595dd"
  );
});


test("v45 startup migration clears only legacy relay blocked metadata across all lanes", () => {
  const registry = normalizeLaneRegistry({
    lanes: {
      "lane-1": {
        relay_inflight: {
          relay_id: "r1",
          screenshot_path: "C:/evidence/lane-1.png",
          reconcile_blocked: true,
          reconcile_reloaded: true,
          reconcile_runtime_version: "2026-09-19.43",
          reconcile_started_at: "2026-09-19T00:00:00Z"
        }
      },
      "lane-2": {
        relay_inflight: {
          relay_id: "r2",
          screenshot_path: "C:/evidence/lane-2.png",
          reconcile_blocked: true
        }
      },
      "lane-3": {
        relay_inflight: null
      }
    }
  });

  const migrated = migrateLegacyBlockedRelayLatches(registry);
  assert.equal(migrated, 2);
  assert.equal(registry.lanes["lane-1"].relay_inflight.reconcile_blocked, false);
  assert.equal(registry.lanes["lane-2"].relay_inflight.reconcile_blocked, false);
  assert.equal(registry.lanes["lane-1"].relay_inflight.relay_id, "r1");
  assert.equal("screenshot_path" in registry.lanes["lane-1"].relay_inflight, false);
  assert.equal("screenshot_path" in registry.lanes["lane-2"].relay_inflight, false);
  assert.equal("reconcile_reloaded" in registry.lanes["lane-1"].relay_inflight, false);
  assert.equal("reconcile_runtime_version" in registry.lanes["lane-1"].relay_inflight, false);
  assert.equal("reconcile_started_at" in registry.lanes["lane-1"].relay_inflight, false);
});

test("current runtime performs blocked relay migration before lane processing", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /startupRelayMigrations = migrateLegacyBlockedRelayLatches\(registry\)/);
  assert.match(source, /RUNTIME_RELAY_BLOCKED_LATCHES_MIGRATED/);
  assert.match(source, /loopRelayMigrations = migrateLegacyBlockedRelayLatches\(registry\)/);
  assert.match(source, /SUPERVISOR_RUNTIME_VERSION = "2026-09-20\.60"/);
});


test("RBT-010 relay retries preserve text identity and contain no screenshot or attachment dependency", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/three-lane-cli.mjs", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("async function relayWorkResult");
  const end = source.indexOf("async function applyOwnerBrainTarget", start);
  const relay = source.slice(start, end);

  assert.match(relay, /beginRelaySendAttempt\(latch\)/);
  assert.match(relay, /scheduleRelayRetry\(latch\)/);
  assert.match(relay, /sendComposerInstruction/);
  assert.match(relay, /response_digest/);
  assert.match(relay, /text_digest/);
  assert.doesNotMatch(relay, /screenshot|attachment|EVIDENCE_MISSING/);
});

test("RBT-010 text relay foregrounds the exact Brain page before composer mutation", async () => {
  const actions = await fs.readFile(
    new URL("../src/ui/actions.mjs", import.meta.url),
    "utf8"
  );
  assert.match(actions, /page\.bringToFront/);
  assert.match(actions, /sendComposerInstruction/);
  assert.doesNotMatch(actions, /sendComposerWithAttachment|setInputFiles|COMPOSER_ATTACHMENT_SEND/);
});

