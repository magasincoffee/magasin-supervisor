import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const wfPath = new URL('../.github/workflows/sc013-coordinator-inert-apply.yml', import.meta.url);
const scriptPath = new URL('../.github/scripts/sc013-coordinator-inert-apply.ps1', import.meta.url);
const stagePath = new URL('../.github/scripts/sc013-coordinator-readonly-stage.ps1', import.meta.url);
const sotPath = new URL('../SOURCE_OF_TRUTH.md', import.meta.url);
const integrityPath = new URL('../.github/workflows/supervisor-integrity.yml', import.meta.url);

test('inert APPLY can only trigger on reviewed exact marker, never normal source push or cron', async () => {
  const s = await fs.readFile(wfPath,'utf8');
  assert.match(s,/\.github\/sc013-coordinator-apply-request\.json/);
  assert.match(s,/branches: \[main\]/);
  assert.doesNotMatch(s,/workflow_dispatch:|schedule:|src\/\*\*|SOURCE_OF_TRUTH\.md'/);
  assert.match(s,/contents: read/);
  assert.doesNotMatch(s,/contents: write|issues: write|actions: write/);
  assert.match(s,/cancel-in-progress: false/);
  assert.match(s,/group: sc013-h4a16il-safe-deploy/);
  assert.match(s,/runs-on: \[self-hosted, Windows, X64\]/);
  assert.match(s,/WRONG_TARGET_MACHINE|TARGET_MUTATION_SKIPPED=True/);
  assert.match(s,/ref: \$\{\{ github\.sha \}\}/);
  assert.match(s,/sc013-coordinator-readonly-stage\.ps1/);
  assert.match(s,/sc013-coordinator-inert-apply\.ps1/);
  const stageIndex=s.indexOf('sc013-coordinator-readonly-stage.ps1');
  const applyIndex=s.indexOf('sc013-coordinator-inert-apply.ps1');
  assert.ok(stageIndex>=0 && applyIndex>stageIndex,'fresh stage precedes apply');
});

test('script enforces Owner marker, exact-main, host, SOT and fresh staged manifest', async () => {
  const s=await fs.readFile(scriptPath,'utf8');
  for(const marker of [
    'WRONG_TARGET_MACHINE','OWNER_REVIEWED_APPLY_MARKER_PUSH_REQUIRED',
    'APPLY_CHECKOUT_SHA_MISMATCH','MAIN_CHANGED_ABORT_APPLY',
    'MAGASIN_SC013_COORDINATOR_APPLY_V1','INSTALL_INERT_READ_ONLY_FILES',
    'OWNER_APPLY_SCOPE_NOT_AUTHORIZED','CANONICAL_SOT_APPLY_AUTHORITY_MISSING',
    'FRESH_STAGE_MANIFEST_MISSING','STAGE_MANIFEST_UNQUALIFIED',
    'STAGE_MANIFEST_NOT_FRESH','APPROVED_SOURCE_NOT_MAIN_ANCESTOR',
    'SOURCE_OR_STAGE_FILE_MISSING','STAGED_SOURCE_HASH_MISMATCH',
    'PYTHON_NOT_FOUND',
  ]){
    assert.ok(s.includes(marker),marker);
  }
  assert.match(s,/merge-base --is-ancestor/);
  assert.match(s,/coordinator-status\.json/);
  assert.match(s,/owner_approved -ne \$true/);
  assert.match(s,/start_robots -ne \$false/);
  assert.match(s,/business_execution_enabled -ne \$false/);
  assert.match(s,/Get-FileHash -LiteralPath/);
  assert.match(s,/-Algorithm SHA256/);
});

test('Owner OFF and STOP checks occur before and during installation', async ()=>{
  const s=await fs.readFile(scriptPath,'utf8');
  for(const marker of [
    'OWNER_STOP_OR_DISABLE_ACTIVE','COORDINATOR_NOT_OFF',
    'SPECIALIST_OWNER_ENABLE_NOT_FALSE','COORDINATOR_PREFLIGHT_PROCESS_ACTIVE',
    'AssertOwnerInactive','owner_enabled','execution_enabled',
  ])assert.ok(s.includes(marker),marker);
  assert.ok((s.match(/AssertOwnerInactive/g)||[]).length>=4);
  assert.match(s,/coordinator\\\.py\|sot-preflight/);
});

test('APPLY is add-only in known Coordinator path and never changes scheduler, browser or Gateway', async ()=>{
  const s=await fs.readFile(scriptPath,'utf8');
  const expected=['sot-adapter.mjs','sot-preflight-cli.mjs','sot-preflight-python-bridge.py'];
  expected.forEach(name=>assert.ok(s.includes(name),name));
  assert.match(s,/D:\\MAGASIN_ROBOTS\\robots\\coordinator/);
  assert.match(s,/EXISTING_LOCAL_FILE_REQUIRES_REVIEW/);
  assert.match(s,/COORDINATOR_PATH_REPARSE_UNQUALIFIED/);
  assert.match(s,/STAGE_PATH_REPARSE_UNQUALIFIED/);
  assert.match(s,/coordinator_py_hash_unchanged=\$true/);
  assert.match(s,/business_execution_qualified=\$false/);
  assert.match(s,/worker_started_or_stopped=\$false/);
  assert.match(s,/windows_scheduler_modified=\$false/);
  assert.match(s,/gateway_modified=\$false/);
  assert.match(s,/chatgpt_outbound=\$false/);
  assert.match(s,/INSTALLED_INERT_FILES_NOT_INTEGRATED/);
  assert.doesNotMatch(s,/^\s*(?:Start-Process|Stop-Process|Start-ScheduledTask|Stop-ScheduledTask|Set-ScheduledTask|Register-ScheduledTask|schtasks(?:\.exe)?|Invoke-RestMethod|Invoke-WebRequest)\b/m);
  assert.doesNotMatch(s,/Copy-Item[^\r\n]*-Destination\s+\$control/);
  assert.match(s,/if\(Test-Path -LiteralPath \$destination\)\{throw 'EXISTING_LOCAL_FILE_REQUIRES_REVIEW'\}/);
});

test('caught failure rolls back only changed files created by this attempt and retains evidence', async ()=>{
  const s=await fs.readFile(scriptPath,'utf8');
  for(const marker of [
    'INSTALL_ROLLBACK_SAFE=','INSTALL_ROLLBACK_SAFE',
    'INSTALL_RECEIPT_ALREADY_EXISTS','LEFTOVER_TEMP_REQUIRES_REVIEW',
    'COORDINATOR_BACKUP_HASH_MISMATCH','COORDINATOR_PY_CHANGED',
    'Remove-Item -LiteralPath $dest -Force',
    'MAGASIN_SC013_COORDINATOR_APPLY_FAILURE_V1',
    'installation-failure.json','business_execution_qualified=$false',
    'Get-FileHash -LiteralPath'
  ])assert.ok(s.includes(marker),marker);
  assert.match(s,/if\(\(Test-Path -LiteralPath \$dest\) -and \(Hash \$dest\) -eq \$expected\[\$name\]\)/);
});

test('sole SOT explicitly permits just the inert files and future integration remains blocked',async ()=>{
  const s=await fs.readFile(sotPath,'utf8');
  assert.match(s,/### SC-013 inert Coordinator bridge local APPLY \(Owner approved 2026-10-09\)/);
  assert.match(s,/NOT.*permission to turn ON/);
  assert.match(s,/three previously-reviewed/);
  assert.match(s,/A future separately reviewed\/approved integration/);
  const integrity=await fs.readFile(integrityPath,'utf8');
  assert.match(integrity,/sc013-coordinator-inert-apply\.yml/);
  assert.match(integrity,/sc013-coordinator-inert-apply\.test\.mjs/);
});
