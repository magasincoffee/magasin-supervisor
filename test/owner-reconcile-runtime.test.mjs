import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("runtime observes WAIT_USER instead of short-circuiting before ChatGPT", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/supervisor-loop-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /const ownerWait = isOwnerWaitState\(projectState\)/);
  assert.match(source, /OWNER_BOUNDARY_OBSERVED/);
  assert.match(source, /ownerReconcile: ownerReconcileActive/);
  assert.match(source, /OWNER_RECONCILE_SENT/);
  assert.match(source, /OWNER_RECONCILE_SETTLED/);

  const legacyGate =
    /projectState\.requires_user[\s\S]{0,220}projectState\.status === "WAIT_USER"[\s\S]{0,500}continue;/;
  assert.doesNotMatch(source, legacyGate);
});

test("BLOCKED remains a hard stop while WAIT_USER has a reconciliation path", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/supervisor-loop-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /projectState\.blocked \|\| projectState\.status === "BLOCKED"/);
  assert.match(source, /Project is BLOCKED; no automatic Owner reconciliation is allowed/);
});


test("manual Owner recheck marker arms reconciliation and is consumed only on send", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/supervisor-loop-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /OWNER_RESOLVED\.request\.json/);
  assert.match(source, /const manualOwnerRecheck = ownerWait/);
  assert.match(source, /manualOwnerRecheck \|\|/);
  assert.match(source, /OWNER_RECHECK_ARMED/);
  assert.match(source, /OWNER_RECONCILE_SENT/);

  const unlinkIndex = source.indexOf("await fs.unlink(ownerResolvedPath).catch(() => {});", source.indexOf("OWNER_RECONCILE_SENT") - 500);
  const sentIndex = source.indexOf('type: "OWNER_RECONCILE_SENT"');
  assert.ok(unlinkIndex >= 0);
  assert.ok(unlinkIndex < sentIndex);
});

test("Owner reconciliation remains active while its ChatGPT response is running", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/supervisor-loop-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /ownerReconcileRequested \|\| ownerReconcileState\.awaitingResponse/
  );
  assert.match(source, /ownerReconcile: ownerReconcileActive/);
  assert.match(source, /ownerReconcileAwaitingResponse/);
});


test("runtime persists privacy-safe diagnostics for future no-explanation triage", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/supervisor-loop-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /SupervisorDiagnostics/);
  assert.match(source, /diagnostics\.recordStep/);
  assert.match(source, /diagnostics\.recordError/);
  assert.match(source, /ownerRecheck: manualOwnerRecheck/);
  assert.match(source, /DIAGNOSTIC_INCIDENT/);
});


test("settled reconciliation only re-arms from a newer Owner turn", async () => {
  const source = await fs.readFile(
    new URL("../src/runtime/supervisor-loop-cli.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /const currentLastRole = String\(probe\?\.snapshot\?\.lastMessageRole \|\| ""\)/);
  assert.match(source, /currentLastRole === "user"/);
  assert.match(source, /currentTurn > Number\(ownerReconcileState\.settledTurn \|\| 0\)/);
});
