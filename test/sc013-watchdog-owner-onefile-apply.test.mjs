import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../.github/scripts/sc013-watchdog-owner-onefile-apply.ps1", import.meta.url), "utf8");

test("Owner-only H4 Admin elevation, STOP and one-file scope are fail-closed", () => {
  assert.match(source, /MachineName -cne 'DESKTOP-H4A16IL'/);
  assert.match(source, /OWNER_ADMIN_TOKEN_REQUIRED/);
  assert.match(source, /SC013_WATCHDOG_ONLY_H4_OWNER_APPROVED_20261014/);
  assert.match(source, /EnvironmentVariable\('SUPERVISOR_STATE_ROOT','User'\)/);
  assert.match(source, /Assert-Latches/);
  assert.match(source, /OWNER_STOP_LATCH_MISSING/);
  assert.match(source, /AUTOSTART_DISABLED/);
  assert.match(source, /STAGE_ACL_UNPROTECTED/);
  assert.match(source, /UNQUALIFIED_STAGE_ACL/);
  assert.match(source, /STAGING_MANIFEST_MISMATCH/);
  assert.match(source, /field_applied -ne \$false/);
  assert.match(source, /f5d3e369448cf17436e157e42065d00239a00e905ae7437fdabbd84f812dea3f/);
  assert.match(source, /336343f013e530e693e15f9bb6a8464a1dfd6fe3b3b2ee7e03dbc617c900aa13/);
  assert.match(source, /bf02fd4d7276dc73e352a7ef19f3410c51abf14f/);
});

test("Only exact Watchdog source can be replaced; backup and rollback always guarded", () => {
  assert.match(source, /runtime\\windows\\local-watchdog\.ps1/);
  assert.match(source, /Copy-Item -LiteralPath \$candidate -Destination \$temp/);
  assert.match(source, /Move-Item -LiteralPath \$temp -Destination \$live -Force/);
  assert.match(source, /Copy-Item -LiteralPath \$backup -Destination \$live -Force/);
  assert.match(source, /ROLLBACK_HOLD_CONCURRENT_WRITER/);
  assert.match(source, /ROLLBACK_INTEGRITY_FAILED/);
  assert.match(source, /WATCHDOG_RUNTIME_RELOAD_NOT_PROVEN=True/);
  assert.doesNotMatch(source, /Start-Process|Restart-(?:Process|Service|Computer)|Stop-(?:Process|Service|Computer)|Start-(?:Service|Job)|Invoke-Expression|Start-ScheduledTask|schtasks|sqlite3|dispatch_gateway|local_jobs\.py/i);
  assert.doesNotMatch(source, /Invoke-WebRequest|Invoke-RestMethod|DownloadFile|WebClient/);
});
