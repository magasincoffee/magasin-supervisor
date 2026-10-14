import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("SC-013 sparse-state watchdog telemetry is read-only and StrictMode-safe", async () => {
  const ps = await fs.readFile(new URL("../windows/local-watchdog.ps1", import.meta.url), "utf8");
  assert.match(ps, /function Get-OptionalWatchdogStateField/);
  assert.match(ps, /\.PSObject\.Properties\[\$Section\]/);
  assert.match(ps, /\.PSObject\.Properties\[\$Field\]/);
  for (const field of ["last_error_code", "last_error_stage", "prepared_at", "enqueued_at"]) {
    assert.match(ps, new RegExp("Get-OptionalWatchdogStateField[^\\r\\n]*-Section 'outbound' -Field '" + field + "'"));
    assert.doesNotMatch(ps, new RegExp("\\$[sS]tate\\.outbound\\." + field + "\\b"));
  }
  assert.doesNotMatch(ps, /\$[sS]tate\.automation\.updated_at\b/);
  for (const status of ["STARTING_BROWSER", "PREPARED", "ENQUEUED"]) {
    for (const cause of ["MISSING", "INVALID"]) {
      assert.match(ps, new RegExp(status + "_TIMESTAMP_" + cause));
    }
  }
  assert.match(ps, /ownerStop\.blocked/);
  assert.doesNotMatch(ps, /sendComposerInstruction|reconcileExactOnceOutbound|start-supervisor\.ps1/);
});
