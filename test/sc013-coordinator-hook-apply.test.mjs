import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const workflow = new URL('../.github/workflows/sc013-coordinator-hook-apply.yml',import.meta.url);
const script = new URL('../.github/scripts/sc013-coordinator-hook-apply.ps1',import.meta.url);
const source = new URL('../src/coordinator/coordinator.py',import.meta.url);
const sot = new URL('../SOURCE_OF_TRUTH.md',import.meta.url);
const integrity = new URL('../.github/workflows/supervisor-integrity.yml',import.meta.url);

test('Coordinator hook APPLY accepts only one exact-main Owner marker, not ordinary source merges',async()=>{
  const s=await fs.readFile(workflow,'utf8');
  for(const marker of [
    'DESKTOP-H4A16IL','TARGET_MUTATION_SKIPPED=True',
    '.github/sc013-coordinator-hook-apply-request.json',
    'branches: [main]','contents: read','cancel-in-progress: false',
    'group: sc013-h4a16il-safe-deploy',
    'sc013-coordinator-hook-apply.ps1'
  ])assert.ok(s.includes(marker),marker);
  assert.doesNotMatch(s,/^\s+workflow_dispatch:|^\s+schedule:/m);
  assert.doesNotMatch(s,/^\s+- 'src\/\*\*'|^\s+- 'SOURCE_OF_TRUTH\.md'/m);
  assert.match(s,/ref: \$\{\{ github\.sha \}\}/);
  assert.match(s,/runs-on: \[self-hosted, Windows, X64\]/);
  assert.doesNotMatch(s,/issues: write|contents: write|actions: write/);
});

test('installer pins exact main, old coordinator bytes, installed inert bridge, Owner OFF and STOP',async()=>{
  const s=await fs.readFile(script,'utf8');
  for(const marker of [
    'MAIN_SHA_CHANGED_REDISPATCH_REQUIRED','CHECKOUT_SHA_MISMATCH',
    'OWNER_APPROVAL_SCOPE_INVALID','MAGASIN_SC013_COORDINATOR_CYCLE_HOOK_APPLY_V1',
    'APPLY_READ_ONLY_HOOK_ONLY','SOURCE_NOT_APPROVED_ANCESTOR',
    'SOT_HOOK_GATE_NOT_FOUND','LIVE_COORDINATOR_SHA_DRIFT',
    'COORDINATOR_NOT_OWNER_OFF','SPECIALIST_NOT_OWNER_OFF',
    'OWNER_STOP_OR_DISABLE_ACTIVE','SCHEDULER_TICK_RUNNING',
    'COORDINATOR_OR_PREFLIGHT_PROCESS_ACTIVE',
    'INSTALLED_READONLY_BRIDGE_DRIFT','LOCAL_DIRECTORY_REPARSE_NOT_QUALIFIED',
    'D_RESOURCE_GATE_LOW','OLD_DEPLOY_TEMP_EXISTS','STAGED_BACKUP_OR_SOURCE_HASH_FAILED',
    'PYTHON_AST_SYNTAX_FAILED','INSTALL_HASH_MISMATCH',
    'MAGASIN_SC013_COORDINATOR_HOOK_APPLY_V1','INSTALLED_READONLY_HOOK_NOT_EXECUTOR',
    'COORDINATOR_HOOK_ROLLBACK_VERIFIED=','NO_CHATGPT_OUTBOUND=True',
    'Get-FileHash -LiteralPath'
  ])assert.ok(s.includes(marker),marker);
  assert.match(s,/Get-ScheduledTask -TaskName 'MAGASIN SC013 Local 30min'/);
  assert.match(s,/-Algorithm SHA256/);
  assert.match(s,/owner_approved -ne \$true/);
  assert.match(s,/source_commit/);
  assert.match(s,/expected_old_sha256/);
  assert.match(s,/ast\.parse/);
  assert.match(s,/Move-Item -LiteralPath \$temp -Destination \$live -Force/);
  assert.match(s,/Hash \$backup/);
  assert.match(s,/Hash \$live/);
  assert.match(s,/AssertGuard/g);
  assert.match(s,/ownsLock=\$true/);
  assert.doesNotMatch(s,/^\s*(?:Start-Process|Stop-Process|Start-ScheduledTask|Stop-ScheduledTask|Set-ScheduledTask|Register-ScheduledTask|schtasks(?:\.exe)?|Invoke-RestMethod|Invoke-WebRequest)\b/im);
});

test('workflow never installs specialist source or changes half-hour cadence',async()=>{
  const s=await fs.readFile(script,'utf8');
  for(const denied of ['Start-ScheduledTask','Set-ScheduledTask','schtasks.exe','run-supervisor.ps1','dispatch_gateway.py']){
    assert.equal(s.includes(denied),false,denied);
  }
  assert.match(s,/supervisor_started|specialist_started=\$false/);
  assert.match(s,/windows_scheduler_modified=\$false/);
  assert.match(s,/chatgpt_outbound=\$false/);
  assert.match(s,/execution_enabled=\$false/);
  assert.match(s,/business_completed=\$false/);
});

test('new Python call-site is read-only, bounded, and does not authorize execution',async()=>{
  const s=await fs.readFile(source,'utf8');
  for(const marker of [
    'safe_preflight_readonly','MAX_PREFLIGHT_STDOUT','timeout=11',
    'sys.executable','sot-preflight-python-bridge.py',
    'OFF_OWNER_MANUAL','"execution_enabled":False',
    'BRIDGE_FAILED_CLOSED','"sot_preflight":preflight',
    'WAIT_OWNER_ENABLE'
  ])assert.ok(s.includes(marker),marker);
  assert.match(s,/item\.get\("execution_qualified"\) is not False/);
  assert.match(s,/item\.get\("dispatched"\) is not False/);
  assert.match(s,/item\.get\("business_completed"\) is not False/);
  assert.doesNotMatch(s,/shell=True|subprocess\.Popen|os\.system|Start-Process|chmod/);
});

test('sole SOT authorizes only inspection-hook APPLY and both allowlists include it',async()=>{
  const s=await fs.readFile(sot,'utf8');
  assert.match(s,/### SC-013 read-only Coordinator cycle integration \(Owner 2026-10-09\)/);
  assert.match(s,/not authorization to start Coordinator/);
  assert.match(s,/Business Executor/);
  const i=await fs.readFile(integrity,'utf8');
  assert.match(i,/sc013-coordinator-hook-apply\.yml/);
  assert.match(i,/test\/sc013-coordinator-hook-apply\.test\.mjs/);
});
