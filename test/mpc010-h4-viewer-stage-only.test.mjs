import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const s=readFileSync(new URL('../.github/scripts/mpc010-h4-viewer-stage-only.ps1',import.meta.url),'utf8');
const sot=readFileSync(new URL('../SOURCE_OF_TRUTH.md',import.meta.url),'utf8');
test('Owner STAGE only is separately described and expressly denies APPLY',()=>{
  assert.match(sot,/### MPC-010 H4 Control Center STAGE ONLY/);
  assert.match(sot,/does NOT authorize installing/i);
  assert.match(sot,/separate reviewed and root-SOT-approved Owner-bound APPLY/i);
  assert.match(s,/ValidateSet\('SelfTest','Stage'\)/);
  assert.doesNotMatch(s,/ValidateSet\([^)]*Apply/);
  assert.match(s,/FIELD_APPLY_AUTHORIZED=False/);
});
test('H4 stage reuses independent fail-closed identity, latch, worker, candidate tests',()=>{
  for(const item of ['RequireSource','VerifyHost','VerifyCandidate',
    'ReadPinnedSource','AssertNoReparse','STAGE_PATH_ALREADY_EXISTS_DO_NOT_OVERWRITE',
    'CANONICAL_MAIN_STAGE_APPROVAL_MISSING','BACKUP_HASH_MISMATCH',
    'RESTORE_REHEARSAL_FAILED','STOP_LATCH_CHANGED_DURING_STAGE',
    'LIVE_VIEWER_CHANGED_DURING_STAGE']){
    assert.ok(s.includes(item),item);
  }
  assert.match(s,/\$stage=Join-Path 'D:\\MAGASIN_ROBOTS\\deploy\\mpc010-viewer'/);
  assert.match(s,/foreach\(\$source in \$expectedFiles.Keys\)/);
  assert.match(s,/foreach\(\$rel in \$oldHashes.Keys\)/);
});
test('stage writes only isolated D stage tree and never restarts or edits viewer',()=>{
  assert.doesNotMatch(s,/Start-Process|Stop-Process|Restart-Service|Set-Service|Invoke-Expression|Invoke-RestMethod/);
  assert.doesNotMatch(s,/Remove-Item|Move-Item|\[IO\.File\]::Replace/);
  assert.doesNotMatch(s,/Copy-Item -LiteralPath \$[a-zA-Z]+ -Destination \$install/);
  assert.match(s,/New-Item -ItemType Directory -Path \$stage -ErrorAction Stop/);
  assert.match(s,/Copy-Item -LiteralPath \$from -Destination \$to -ErrorAction Stop/);
  assert.match(s,/Copy-Item -LiteralPath \$to -Destination \$dry -ErrorAction Stop/);
  assert.match(s,/live_viewer_touched=\$false/);
  assert.match(s,/worker_started=\$false/);
});
test('stage is exact-main and Owner-admin-bound before any writes',()=>{
  assert.ok(s.indexOf('VerifyHost')<s.indexOf("New-Item -ItemType Directory -Path $stage"));
  assert.ok(s.indexOf('VerifyCandidate $work')<s.indexOf("New-Item -ItemType Directory -Path $stage"));
  assert.match(s,/DESKTOP-H4A16IL\\admin/);
  assert.match(s,/CANONICAL_MAIN_STAGE_APPROVAL_MISSING/);
  assert.match(s,/\$stopBefore=HashFile \$stopPath/);
  assert.match(s,/\$disabledBefore=HashFile \$disabledPath/);
});
