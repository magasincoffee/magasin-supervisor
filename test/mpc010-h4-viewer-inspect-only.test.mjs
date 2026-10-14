import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('../.github/scripts/mpc010-h4-viewer-owner-release.ps1', import.meta.url),'utf8');
const sot=readFileSync(new URL('../SOURCE_OF_TRUTH.md',import.meta.url),'utf8');
test('H4 viewer source checker defaults to field HOLD',()=>{
  assert.match(script,/ValidateSet\('SelfTest','Inspect','Stage','Apply','Rollback'\)/);
  assert.match(script,/if\(\$Mode -in @\('Stage','Apply','Rollback'\)\) \{\s*throw 'MPC010_FIELD_RELEASE_NOT_YET_IMPLEMENTED_OR_AUTHORIZED'\s*\}/);
  assert.ok(script.indexOf("if($Mode -in @('Stage','Apply','Rollback'))")<
            script.indexOf('VerifyCandidate $work'));
  assert.match(script,/Write-Output 'FIELD_APPLY_AUTHORIZED=False'/);
  assert.doesNotMatch(script,/Start-Process|Stop-Process|Set-Content|Copy-Item|Remove-Item|New-Item|Move-Item|Invoke-RestMethod/);
});
test('field inspection pins H4 identity STOP localhost and 12 reviewed SHA',()=>{
  for(const frag of ['DESKTOP-H4A16IL','DESKTOP-H4A16IL\\admin',
    'D:\\MAGASIN_ROBOTS\\control-center','AUTOSTART_DISABLED',
    "export const REVIEWED_CANDIDATE_SHA256_20261014",
    "function VerifyCandidate","CANDIDATE_CONTENT_HASH_DRIFT",
    "UNEXPECTED_LOCAL_VIEWER_LISTENER","BUSINESS_WORKER_PRESENT"]){
    assert.ok(script.includes(frag),frag);
  }
  assert.match(script,/\$expectedFiles=\[ordered\]@\{/);
  assert.match(script,/function AssertNoReparse/);
});
test('no SOT section grants H4 installation from this source-only PR',()=>{
  assert.match(sot,/MPC-010 H4 VIEWER FIELD RELEASE APPROVAL GATE \(PROPOSED, INSPECT ONLY/);
  assert.match(sot,/not live release authorization/i);
  assert.match(sot,/Stage, Apply and Rollback deliberately throw/i);
});


test('Codex P2 boundaries reject dirty tree, symlink STOP and all orphaned worker names',()=>{
  assert.match(script,/WORKTREE_OR_INDEX_NOT_CLEAN/);
  assert.match(script,/WORKTREE_CHANGED_DURING_INSPECT/);
  assert.match(script,/git -C \$work --no-optional-locks status --porcelain=v1 --untracked-files=all/);
  assert.match(script,/Join-Path \$stopRoot 'STOP'\),\(Join-Path \$stopRoot 'AUTOSTART_DISABLED'\)/);
  for(const name of ['three-lane-cli','planner-executor-cli','planner-executor-bridge-cli','single-conversation-cli'])
    assert.ok(script.includes(name),name);
});
test('unreadable port provider and unrelated process must fail closed',()=>{
  assert.match(script,/Get-NetTCPConnection -ErrorAction Stop/);
  assert.doesNotMatch(script,/Get-NetTCPConnection[^\n]*SilentlyContinue/);
  assert.match(script,/\$proc\.ExecutablePath -cne \$pythonExe/);
  assert.match(script,/\$proc\.CommandLine -notmatch \$linePattern/);
  assert.match(script,/Invoke-CimMethod -InputObject \$proc -MethodName GetOwner -ErrorAction Stop/);
  assert.match(script,/VIEWER_PROCESS_OWNER_UNVERIFIED/);
});

test('inspect must traverse existing ancestors of nonexistent target and be CI-triggered',()=>{
  assert.match(script,/while\(\$current\) \{/);
  assert.match(script,/Get-ChildItem -LiteralPath \$parent -Force -ErrorAction Stop/);
  assert.doesNotMatch(script,/if\(Test-Path -LiteralPath \$current\) \{/);
  const testsWorkflow=readFileSync(new URL('../.github/workflows/supervisor-tests.yml',import.meta.url),'utf8');
  assert.equal(testsWorkflow.split("- '.github/scripts/mpc010-h4-viewer-owner-release.ps1'").length-1,2);
});

test('final no-write inspector covers old worker modes and avoids git index refresh',()=>{
  assert.equal(script.split('git -C $work --no-optional-locks status').length-1,2);
  assert.doesNotMatch(script,/git -C \$work status --porcelain/);
  assert.match(script,/brain-worker-cli/);
  assert.match(script,/supervisor-loop-cli/);
  assert.match(script,/Get-ChildItem -LiteralPath \$parent -Force -ErrorAction Stop/);
});
