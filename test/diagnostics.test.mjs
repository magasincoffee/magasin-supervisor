import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SupervisorDiagnostics } from "../src/runtime/diagnostics.mjs";

function context(overrides = {}) {
  return {
    projectState: {
      current_phase: "P1",
      current_task: "PLATFORM-035",
      current_task_title: "MAGASIN email adapter/config",
      status: "WAIT_USER",
      autonomy: "MANUAL",
      blocked: false,
      requires_user: true,
      owner_boundary: { pending: [] },
      activation_boundary: {
        reason: "GMAIL_OAUTH_CREDENTIALS_REQUIRED",
        pending: [
          "GMAIL_OAUTH_CLIENT_ID",
          "GMAIL_OAUTH_CLIENT_SECRET",
          "GMAIL_OAUTH_REFRESH_TOKEN"
        ]
      }
    },
    probe: {
      classification: {
        uiState: "READY_IDLE",
        observation: "RESPONSE_COMPLETE"
      },
      snapshot: {
        responseRunning: false,
        mainBusy: false,
        hasStopControl: false,
        composerReady: true,
        pathKind: "conversation",
        userMessageCount: 7,
        assistantMessageCount: 6,
        lastMessageRole: "assistant",
        lastMessageCharCount: 440,
        lastAssistantCharCount: 440,
        maxConversationTurnOrdinal: 18
      }
    },
    result: {
      effectiveObservation: "RESPONSE_COMPLETE",
      workUiSettled: false,
      decision: {
        action: "CONTINUE",
        reason: "owner boundary is waiting"
      },
      execution: {
        executed: false,
        reason: "awaiting observable assistant progress"
      }
    },
    controller: {
      armed: false,
      assistantCountAtAction: 6,
      turnOrdinalAtAction: 17,
      sawRunningAfterAction: false,
      userPendingSawProgress: false,
      lastActionAt: 123
    },
    ownerReconcileState: {
      attempted: true,
      awaitingResponse: true,
      settledTurn: null
    },
    manualOwnerRecheck: true,
    recovery: { blocked: false },
    ...overrides
  };
}

test("diagnostics writes latest snapshot without conversation text", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-diag-"));
  const diag = new SupervisorDiagnostics({
    root,
    runtimeVersion: "test",
    incidentThreshold: 3,
    now: () => Date.parse("2026-09-18T12:00:00Z")
  });

  await diag.recordStep(context());

  const latestPath = path.join(root, "diagnostics", "latest.json");
  const latest = JSON.parse(await fs.readFile(latestPath, "utf8"));

  assert.equal(latest.runtime_version, "test");
  assert.equal(latest.project.current_task, "PLATFORM-035");
  assert.deepEqual(latest.project.owner_boundary_pending, []);
  assert.equal(
    latest.project.activation_boundary_reason,
    "GMAIL_OAUTH_CREDENTIALS_REQUIRED"
  );
  assert.equal(latest.project.activation_boundary_pending.length, 3);
  assert.equal(latest.ui.observation, "RESPONSE_COMPLETE");
  assert.equal(latest.controller.armed, false);
  assert.equal(latest.controller.turn_ordinal_at_action, 17);
  assert.equal(latest.owner_reconcile.manual_recheck_marker, true);
  assert.equal("text" in latest.ui, false);
  assert.equal("message" in latest.ui, false);
});

test("diagnostics creates an incident after repeated progress-latch stalls", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-diag-"));
  let now = Date.parse("2026-09-18T12:00:00Z");
  const diag = new SupervisorDiagnostics({
    root,
    runtimeVersion: "test",
    incidentThreshold: 3,
    incidentCooldownMs: 60_000,
    now: () => now
  });

  const a = await diag.recordStep(context());
  now += 5000;
  const b = await diag.recordStep(context());
  now += 5000;
  const c = await diag.recordStep(context());

  assert.equal(a.incident, false);
  assert.equal(b.incident, false);
  assert.equal(c.incident, true);
  assert.equal(c.kind, "OWNER_RECONCILE_LATCH_STALL");

  const incidents = await fs.readFile(
    path.join(root, "diagnostics", "incidents.ndjson"),
    "utf8"
  );
  assert.match(incidents, /OWNER_RECONCILE_LATCH_STALL/);
});

test("diagnostics clears the repeated-stall counter after healthy progress", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-diag-"));
  const diag = new SupervisorDiagnostics({
    root,
    runtimeVersion: "test",
    incidentThreshold: 2
  });

  await diag.recordStep(context());

  const healthy = context({
    result: {
      effectiveObservation: "ASSISTANT_RUNNING",
      workUiSettled: false,
      decision: { action: "WAIT", reason: "assistant is still running" },
      execution: { executed: false, reason: "decision requires no UI action" }
    },
    ownerReconcileState: {
      attempted: true,
      awaitingResponse: true,
      settledTurn: null
    }
  });

  await diag.recordStep(healthy);
  const result = await diag.recordStep(context());
  assert.equal(result.incident, false);
});


test("valid settled activation WAIT_USER does not create a false incident", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magasin-diag-"));
  const diag = new SupervisorDiagnostics({
    root,
    runtimeVersion: "test",
    incidentThreshold: 2
  });

  const validWait = context({
    result: {
      effectiveObservation: "RESPONSE_COMPLETE",
      workUiSettled: false,
      decision: {
        action: "STOP_WAIT_USER",
        reason: "project state requires owner intervention"
      },
      execution: {
        executed: false,
        reason: "decision requires no UI action"
      }
    },
    ownerReconcileState: {
      attempted: true,
      awaitingResponse: false,
      settledTurn: 28
    },
    manualOwnerRecheck: false,
    controller: {
      armed: true,
      assistantCountAtAction: null,
      turnOrdinalAtAction: null,
      sawRunningAfterAction: false,
      userPendingSawProgress: false,
      lastActionAt: 123
    }
  });

  const first = await diag.recordStep(validWait);
  const second = await diag.recordStep(validWait);
  assert.equal(first.incident, false);
  assert.equal(second.incident, false);
  await assert.rejects(
    fs.access(path.join(root, "diagnostics", "incidents.ndjson"))
  );
});
