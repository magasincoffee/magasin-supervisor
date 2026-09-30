import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("SC-013 live acceptance preserves Owner START authority", async () => {
  const script = await fs.readFile(
    new URL("../.github/scripts/supervisor-sc013-live-production.ps1", import.meta.url),
    "utf8"
  );

  assert.match(script, /SC013_LIVE_FIRST_FAILURE_CODE=OWNER_START_REQUIRED/);
  assert.match(script, /SC013_LIVE_OWNER_STARTED_RUNTIME_OBSERVED=True/);
  assert.doesNotMatch(
    script,
    /& powershell\.exe[^\r\n]*-File \$startScript[^\r\n]*-Hidden/
  );
});
