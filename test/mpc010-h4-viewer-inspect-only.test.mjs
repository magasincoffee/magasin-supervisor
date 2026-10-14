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


test('Inspector only proves pinned candidate scope, not whole Git worktree cleanliness',()=>{
  assert.doesNotMatch(script,/WORKTREE_OR_INDEX_NOT_CLEAN|WORKTREE_CHANGED_DURING_INSPECT/);
  assert.doesNotMatch(script,/git --no-replace-objects -C \$work[^\n]*\bstatus\b/);
  assert.match(script,/A full clean checkout is NOT attested/);
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
  assert.doesNotMatch(script,/\b(?:git\s+[^\n]*\bstatus\s+--porcelain)/);
  assert.match(script,/No all-worktree-clean assertion, no Stage\/Apply\/Rollback authority/);
  assert.match(script,/brain-worker-cli/);
  assert.match(script,/supervisor-loop-cli/);
  assert.match(script,/Get-ChildItem -LiteralPath \$parent -Force -ErrorAction Stop/);
});


test('candidate pins are read from the immutable expected Git object, never mutable worktree',()=>{
  assert.match(script,/\$pinsRef=\$ExpectedMainSha\+':src\/control-center\/mpc010_control_center_preflight\.mjs'/);
  assert.match(script,/git --no-replace-objects -C \$work --no-optional-locks cat-file blob \$pinsRef/);
  assert.match(script,/REVIEWED_PIN_GIT_OBJECT_MISSING/);
  assert.doesNotMatch(script,/\$source=\[IO\.File\]::ReadAllText\(\$pinsPath/);
  assert.match(script,/function ReadPinnedSource/);
  assert.match(script,/CANDIDATE_CONTENT_HASH_DRIFT/);
});

test('assume-unchanged demonstrates clean status is not commit content proof',async()=>{
  const {spawnSync}=await import('node:child_process');
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'mpc010-index-bypass-'));
  const run=(...args)=>{
    const v=spawnSync('git',['-C',dir,...args],{encoding:'utf8'});
    assert.equal(v.status,0,(v.stderr||v.stdout||'').slice(0,700));
    return v.stdout.trim();
  };
  try{
    run('init','-q');
    run('config','user.name','Hosted Synthetic Fixture');
    run('config','user.email','fixture@example.invalid');
    writeFileSync(join(dir,'pins.txt'),'PIN=REVIEWED\n');
    run('add','pins.txt');
    run('commit','-qm','fixture');
    const revision=run('rev-parse','HEAD');
    run('update-index','--assume-unchanged','pins.txt');
    writeFileSync(join(dir,'pins.txt'),'PIN=FORGED\n');
    assert.equal(run('--no-optional-locks','status','--porcelain=v1'),'');
    assert.equal(run('--no-optional-locks','cat-file','blob',revision+':pins.txt'),'PIN=REVIEWED');
  }finally{rmSync(dir,{recursive:true,force:true})}
});


test('SOT release gate comes from expected immutable commit, not hidden local file',()=>{
  assert.match(script,/\$sotRef=\$ExpectedMainSha\+':SOURCE_OF_TRUTH\.md'/);
  assert.match(script,/git --no-replace-objects -C \$work --no-optional-locks cat-file blob \$sotRef/);
  assert.match(script,/REVIEWED_ROOT_SOT_GATE_MISSING/);
  assert.doesNotMatch(script,/\[IO\.File\]::ReadAllText\(\$sot\)/);
});

test('Windows path inspection case-folds component names and checks all new leaf paths',()=>{
  assert.match(script,/Where-Object \{\$_.Name -ieq \$name\}/);
  assert.doesNotMatch(script,/Where-Object \{\$_.Name -ceq \$name\}/);
  assert.match(script,/\$destination=Join-Path \$install \$file\s+# A missing leaf[\s\S]*?AssertNoReparse \$destination\s+if\(Test-Path -LiteralPath \$destination\)/);
  assert.ok(script.includes("'docs\\project-control\\MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md'"));
  assert.match(script,/REPARSE_COMPONENT_DENIED/);
});


test('disable Git replacement refs for all source, SOT and commit verifications',()=>{
  assert.equal(script.split('git --no-replace-objects -C $work').length-1,5);
  assert.doesNotMatch(script,/& git -C \$work/);
  assert.match(script,/git --no-replace-objects -C \$work --no-optional-locks cat-file blob \$pinsRef/);
  assert.match(script,/git --no-replace-objects -C \$work --no-optional-locks cat-file blob \$sotRef/);
});

test('synthetic local Git replace cannot spoof pinned commit bytes when disabled',async()=>{
  const {spawnSync}=await import('node:child_process');
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'mpc010-replacement-proof-'));
  const run=(...args)=>{
    const v=spawnSync('git',['-C',dir,...args],{encoding:'utf8'});
    assert.equal(v.status,0,(v.stderr||v.stdout||'').slice(0,650));
    return v.stdout.trim();
  };
  try{
    run('init','-q');
    run('config','user.name','Hosted Synthetic Fixture');
    run('config','user.email','fixture@example.invalid');
    writeFileSync(join(dir,'sot.txt'),'REVIEWED_GATE=DENIED\n');
    run('add','sot.txt');run('commit','-qm','safe');
    const safe=run('rev-parse','HEAD');
    writeFileSync(join(dir,'sot.txt'),'REVIEWED_GATE=FORGED_APPROVAL\n');
    run('add','sot.txt');run('commit','-qm','evil');
    const malicious=run('rev-parse','HEAD');
    run('replace',safe,malicious);
    assert.equal(run('cat-file','blob',safe+':sot.txt'),'REVIEWED_GATE=FORGED_APPROVAL');
    assert.equal(run('--no-replace-objects','cat-file','blob',safe+':sot.txt'),'REVIEWED_GATE=DENIED');
  }finally{rmSync(dir,{recursive:true,force:true})}
});


test('candidate decoding refuses BOM and non-UTF8 bytes instead of silently deleting prefixes',()=>{
  assert.match(script,/\$raw=\[IO\.File\]::ReadAllBytes\(\$path\)/);
  assert.match(script,/CANDIDATE_BOM_DENIED/);
  assert.match(script,/CANDIDATE_INVALID_UTF8/);
  assert.match(script,/CANDIDATE_ENCODING_DENIED/);
  assert.match(script,/New-Object System\.Text\.UTF8Encoding\(\$false,\$true\)/);
  assert.doesNotMatch(script,/\$txt=\[IO\.File\]::ReadAllText\(\$path/);
});

test('Inspector never invokes Git status or clean/process conversion hooks',()=>{
  assert.doesNotMatch(script,/& git[^\n]*\sstatus\s+--porcelain/);
  assert.doesNotMatch(script,/& git[^\n]*\sdiff\s/);
  assert.match(script,/configured clean\/process filters can execute/);
  assert.match(script,/ReadPinnedSource/);
  assert.match(script,/CANDIDATE_CONTENT_HASH_DRIFT/);
});
