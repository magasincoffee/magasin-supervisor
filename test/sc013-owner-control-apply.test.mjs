import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const workflow=new URL('../.github/workflows/sc013-owner-control-apply.yml',import.meta.url);
const script=new URL('../.github/scripts/sc013-owner-control-apply.ps1',import.meta.url);
const sot=new URL('../SOURCE_OF_TRUTH.md',import.meta.url);
const integrity=new URL('../.github/workflows/supervisor-integrity.yml',import.meta.url);

test('H4 Control Center install is only Owner-approved marker, never ordinary src pushes or cron',async()=>{
  const s=await fs.readFile(workflow,'utf8');
  assert.match(s,/\.github\/sc013-owner-control-apply-request\.json/);
  assert.match(s,/branches: \[main\]/);
  assert.match(s,/contents: read/);
  assert.match(s,/group: sc013-h4a16il-safe-deploy/);
  assert.match(s,/cancel-in-progress: false/);
  assert.match(s,/runs-on: \[self-hosted, Windows, X64\]/);
  assert.match(s,/TARGET_MUTATION_SKIPPED=True/);
  assert.match(s,/ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(s,/^\s+(?:schedule:|workflow_dispatch:)/m);
  assert.doesNotMatch(s,/src\/\*\*|contents: write|issues: write/);
});
test('installer pins exact main and expected original hashes; stages and backs up 3 known modules',async()=>{
  const s=await fs.readFile(script,'utf8');
  for(const marker of [
    'WRONG_TARGET_MACHINE','OWNER_REVIEWED_MARKER_PUSH_REQUIRED',
    'EXACT_CHECKOUT_MISMATCH','MAIN_MOVED_ABORT',
    'MAGASIN_SC013_OWNER_CONTROL_APPLY_V1','INSTALL_OWNER_READONLY_UI',
    'APPLY_SCOPE_NOT_APPROVED','APPROVED_SOURCE_NOT_MAIN_ANCESTOR',
    'SOT_DEPLOY_AUTHORITY_MISSING','CONTROL_CENTER_HASH_DRIFT',
    'BACKUP_HASH_MISMATCH','CANDIDATE_HASH_MISMATCH',
    'DUPLICATE_STAGE_REQUIRES_REVIEW',
    'OWNER_MODULE_ALREADY_INSTALLED','OWNER_CONTROL_ALREADY_INITIALIZED',
    'OWNER_STOPPED','COORDINATOR_NOT_OWNER_OFF',
    'SUPERVISOR_OWNER_STOP_ACTIVE','SPECIALIST_OWNER_FLAG_NOT_OFF',
    'COORDINATOR_SOURCE_CHANGED','LOW_RAM_HEADROOM',
    'LOCAL_TICK_ACTIVE','CONTROL_PORT_IDENTITY_AMBIGUOUS',
    'CONTROL_SERVER_PROCESS_UNVERIFIED',
    'OWNER_CONTROL_READBACK_FAILED','NEW_CONTROL_HEALTH_FAILED',
    'POST_RESTART_HASH_DRIFT','INSTALL_RECEIPT=',
    'MAGASIN_SC013_OWNER_CONTROL_APPLY_RESULT_V1',
    'MAGASIN_SC013_OWNER_CONTROL_APPLY_FAILURE_V1',
    'BUSINESS_EXECUTION_QUALIFIED=False',
  ])assert.ok(s.includes(marker),marker);
  assert.match(s,/7d9539a051d63b78dfea87a6cb1b95c7a718c8259196e8dc0bbf1b0534e8c1eb/);
  assert.match(s,/2ffe63256f8b37d734aacda63c1d740254f699f01cc1610a752475e2c7a2ab07/);
  assert.match(s,/fe4cfc261a06fdb42a6a1053697344d6990ef47f747cc073eb056ae9f62f93dd/);
  assert.match(s,/src\/coordinator\/owner_lifecycle\.py/);
  assert.match(s,/src\/control-center\/server\.py/);
  assert.match(s,/src\/control-center\/web\/app\.js/);
  assert.match(s,/ast\.parse/);
  assert.match(s,/--check/);
  assert.match(s,/Get-FileHash -LiteralPath/);
  assert.match(s,/INSTALL_OWNER_READONLY_UI/);
});
test('Control Center restart does not create a specialist, daemon, browser or new scheduler',async()=>{
  const s=await fs.readFile(script,'utf8');
  assert.match(s,/Stop-Process -Id \$oldPid/);
  assert.match(s,/START_CONTROL\.ps1/);
  assert.match(s,/ -StartOnly/);
  assert.match(s,/LocalPort 8781/);
  assert.match(s,/LocalAddress -ne '127\.0\.0\.1'/);
  assert.match(s,/supervisor_started_or_stopped=\$false/);
  assert.match(s,/windows_scheduler_modified=\$false/);
  assert.match(s,/chatgpt_outbound=\$false/);
  assert.match(s,/business_dispatch_enabled=\$false/);
  assert.doesNotMatch(s,/(?:start-supervisor|stop-supervisor|run-supervisor|SAYDI|SAPO)\.(?:ps1|cmd|py)/i);
  assert.doesNotMatch(s,/Start-ScheduledTask|Set-ScheduledTask|Register-ScheduledTask|chrome\.exe/);
});
test('rollback fails closed without removing unknown process or non-approved files',async()=>{
  const s=await fs.readFile(script,'utf8');
  assert.match(s,/Control Center view/i);
  assert.match(s,/if\(\$runningProc -and \$runningProc\.CommandLine/);
  assert.match(s,/else\{\$rollbackSafe=\$false\}/);
  assert.match(s,/backup\\server\.py/);
  assert.match(s,/backup\\app\.js/);
  assert.match(s,/OWNER_CONTROL_APPLY_ROLLBACK_SAFE/);
  assert.match(s,/APPLY_FAILED_REVIEW_REQUIRED/);
  assert.match(s,/ownsLock/);
});
test('canonical SOT records separate Owner gate and source/script allowlists',async()=>{
  const s=await fs.readFile(sot,'utf8');
  assert.match(s,/### SC-013 Owner Control Center gated local APPLY \(2026-10-09\)/);
  assert.match(s,/Business Executor/);
  assert.match(s,/Owner STOP/);
  const i=await fs.readFile(integrity,'utf8');
  assert.match(i,/sc013-owner-control-apply\.yml/);
  assert.match(i,/sc013-owner-control-apply\.test\.mjs/);
});
