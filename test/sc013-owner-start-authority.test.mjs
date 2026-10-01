import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("SC-013 live acceptance preserves Owner START authority with only time-bounded explicit delegation", async () => {
  const script = await fs.readFile(
    new URL("../.github/scripts/supervisor-sc013-live-production.ps1", import.meta.url),
    "utf8"
  );

  assert.match(script, /sc013-owner-delegation\.json/);
  assert.match(script, /SC-013_OVERNIGHT_STABILIZATION/);
  assert.match(script, /\[DateTimeOffset\]::UtcNow -lt \$expires/);
  assert.match(script, /\[string\]\$delegation\.target -eq \$TargetComputer/);
  assert.match(script, /SC013_LIVE_DELEGATED_START_AUTHORIZED=/);
  assert.match(script, /SC013_LIVE_OWNER_START_MODE=OWNER_DELEGATED_OVERNIGHT/);
  assert.match(
    script,
    /& powershell\.exe[^\r\n]*-File \$startScript -Hidden/
  );

  // Without a valid delegation marker the observer still waits for a real
  // Owner START and times out without inventing authority.
  assert.match(script, /SC013_LIVE_WAITING_FOR_OWNER_START=True/);
  assert.match(script, /SC013_LIVE_OWNER_WAIT owner_stop=/);
  assert.match(script, /SC013_LIVE_FIRST_FAILURE_CODE=OWNER_START_TIMEOUT/);
  assert.match(script, /SC013_LIVE_OWNER_STARTED_RUNTIME_OBSERVED=True/);
});
