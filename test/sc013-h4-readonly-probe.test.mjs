import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ps = readFileSync(new URL('../.github/scripts/sc013-h4-readonly-probe.ps1', import.meta.url), 'utf8');
const yaml = readFileSync(new URL('../.github/workflows/sc013-h4-readonly-probe.yml', import.meta.url), 'utf8');
const integrity = readFileSync(new URL('../.github/workflows/supervisor-integrity.yml', import.meta.url), 'utf8');
const hostedWindows = readFileSync(new URL('../.github/workflows/supervisor-tests.yml', import.meta.url), 'utf8');
const sot = readFileSync(new URL('../SOURCE_OF_TRUTH.md', import.meta.url), 'utf8');

test('single request-only workflow with explicit Owner and H4 gates, never PR/schedule', () => {
  assert.match(yaml, /sc013-h4-readonly-probe-request\.json/);
  assert.match(yaml, /github.actor == 'magasincoffee'/);
  assert.match(yaml, /github.triggering_actor == 'magasincoffee'/);
  assert.match(yaml, /github.run_attempt == 1/);
  assert.match(yaml, /github\.repository == 'magasincoffee\/magasin-supervisor'/);
  assert.match(yaml, /verify-exact-single-file-owner-request/);
  assert.match(yaml, /runs-on: ubuntu-latest/);
  assert.match(yaml, /needs: verify-exact-single-file-owner-request/);
  assert.match(yaml, /r.data.total_commits !== 1/);
  assert.match(yaml, /actions: read/);
  assert.match(yaml, /listWorkflowRunsForRepo/);
  assert.match(yaml, /head_sha: before/);
  assert.match(yaml, /H4_BASE_EXACT_MAIN_FOUR_CI_NOT_GREEN/);
  for (const gate of ['Supervisor Tests','Supervisor Integrity','Supervisor Lifecycle Acceptance','Supervisor Autostart Install']) {
    assert.ok(yaml.includes(gate), gate);
  }
  assert.match(yaml, /latestByName\.size !== required\.size/);
  assert.match(yaml, /latestByName\.get\(name\)\?\.conclusion !== 'success'/);
  assert.match(yaml, /files.length !== 1/);
  assert.match(yaml, /files\[0\]\.filename !== process.env.EXPECTED_ONLY_PATH/);
  assert.match(yaml, /context.payload.forced === true/);
  assert.ok(yaml.indexOf("needs: verify-exact-single-file-owner-request") < yaml.indexOf("runs-on: [self-hosted, Windows, X64, magasin-h4a16il]"));
  assert.match(yaml, /runs-on: \[self-hosted, Windows, X64, magasin-h4a16il\]/);
  // H4 refuses PowerShell script wrappers by default, so the pre-checkout
  // host guard must use cmd/hostname and reject 4K7 without filesystem reads.
  assert.match(yaml, /name: Deny non-H4 before checkout and all local reads\s+shell: cmd/);
  assert.match(yaml, /for \/f "delims=" %%H in \('hostname'\)/);
  assert.match(yaml, /if not "%SC013_ACTUAL_HOST%"=="DESKTOP-H4A16IL"/);
  assert.match(yaml, /exit \/b 1/);
  assert.match(yaml, /echo SC013_H4_IDENTITY_PASS=True/);
  assert.match(yaml, /name: Inspect H4 SOT-approved safe presence and resource summary only\s+shell: cmd/);
  assert.match(yaml, /powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File/);
  assert.match(yaml, /-ExpectedSha "%EXPECTED_MAIN_SHA%"/);
  assert.doesNotMatch(yaml, /Set-ExecutionPolicy|CurrentUser|LocalMachine/);
  assert.equal((yaml.match(/shell: cmd/g)||[]).length, 2);
  assert.ok(yaml.indexOf('Deny non-H4') < yaml.indexOf('uses: actions/checkout'));
  assert.match(yaml, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(yaml, /persist-credentials: false/);
  assert.match(yaml, /permissions:\s+contents: read/);
  assert.match(yaml, /concurrency:[\s\S]+?sc013-h4a16il-safe-deploy/);
  assert.doesNotMatch(yaml, /^\s*pull_request:|^\s*schedule:|^\s*issues:|^\s*workflow_dispatch:/m);
  assert.match(integrity, /sc013-h4-readonly-probe\.yml/);
  assert.equal((hostedWindows.match(/\.github\/workflows\/sc013-h4-readonly-probe\.yml/g)||[]).length, 2);
  assert.equal((hostedWindows.match(/\.github\/scripts\/sc013-h4-readonly-probe\.ps1/g)||[]).length >= 3, true);
  assert.match(hostedWindows, /H4_DIAG_SELFTEST_RECEIPT_MISSING/);
});

test('read-only diagnostics emits only allowlisted sanitized facts; no worker actuation', () => {
  for (const token of [
    'MAGASIN_SC013_H4_READONLY_PROBE_REQUEST_V1',
    'MAGASIN_H4_READONLY_RECEIPT_V1',
    'Test-ProbeEnvelope',
    'INVALID_OR_CHANGED_MAIN_SHA',
    "GITHUB_RUN_ATTEMPT -cne '1'",
    "GITHUB_TRIGGERING_ACTOR -cne 'magasincoffee'",
    'CHECKOUT_NOT_EXACT_COMMIT',
    'WRONG_TARGET_MACHINE',
    'READ_ONLY_OBSERVED_UNATTESTED',
    'owner_lifecycle_authenticated = $false',
    'worker_ownership_verified = $false',
    'approved_to_start = $false',
    'approved_to_dispatch = $false',
    'owner_stop_changed = $false',
    'task_completed = $false',
  ]) assert.ok(ps.includes(token), token);
  assert.doesNotMatch(ps, /\b(?:Start-Process|Stop-Process|Remove-Item|Set-Content|Add-Content|New-Item|Set-Item|Set-ItemProperty|Invoke-Expression|Invoke-RestMethod|Invoke-WebRequest|Start-Service|Stop-Service|Register-ScheduledTask|Start-ScheduledTask|Restart-Computer|Set-ExecutionPolicy)\b/i);
  assert.doesNotMatch(ps, /Get-ChildItem|Get-Content.{0,100}checkpoint|read_bytes|\.wav|\.mp3/);
  assert.match(ps, /Test-TargetHost \$machine/);
  assert.match(ps, /heavy_process_candidates/);
  assert.match(ps, /mcp_gateway_code/);
  assert.match(ps, /supervisor_stop_latch/);
});

test('current SOT permits only a read-only H4 check under STOP', () => {
  assert.match(sot, /Owner one-shot H4 read-only diagnostics pilot/);
  assert.match(sot, /STOP\/AUTOSTART_DISABLED/);
  assert.match(sot, /P1 NEXT \/ SOURCE AND QA ONLY/);
  assert.match(sot, /SC-013 remains \*\*IN PROGRESS\*\*/);
});
