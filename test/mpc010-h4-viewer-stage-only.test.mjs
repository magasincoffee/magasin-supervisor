import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const s=readFileSync(new URL('../.github/scripts/mpc010-h4-viewer-stage-only.ps1',import.meta.url),'utf8');
const sot=readFileSync(new URL('../SOURCE_OF_TRUTH.md',import.meta.url),'utf8');
test('Codex P2 security HOLD refuses STAGE before creating files or loading native writer',()=>{
  const gate="if($Mode -eq 'Stage'){\n  throw 'MPC010_STAGE_NAMESPACE_SEAL_NOT_QUALIFIED'\n}";
  const position=s.indexOf(gate);
  assert.ok(position>0,'Stage must hard fail closed pending exclusive namespace mechanism');
  assert.ok(position<s.indexOf('$nativeStageWriter=@'),'Gate must precede native code');
  assert.ok(position<s.indexOf('Add-Type -TypeDefinition'),'Gate must precede C# compilation');
  assert.ok(position<s.indexOf('New-Object System.Text.UTF8Encoding($false)'),'Gate must precede stage byte preparation');
  assert.ok(position<s.indexOf('$guard.EnterNew($sha)'),'Gate must precede creation of stage tree');
  assert.match(s,/NtQueryDirectoryFile enumeration cannot guarantee/);
  assert.doesNotMatch(s,/StageNamespaceSealed=\$true/);
});
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
test('Codex P1: destination traversal is native handle-relative and deny-reparse',()=>{
  assert.match(s,/NtCreateFile\(out SafeFileHandle handle/);
  assert.match(s,/RootDirectory=parent.DangerousGetHandle\(\)/);
  assert.match(s,/OBJ_DONT_REPARSE/);
  assert.match(s,/FLAG_OPEN_REPARSE_POINT/);
  assert.match(s,/directory\?DIRECTORY_OPTIONS:FILE_OPTIONS/);
  assert.match(s,/FILE_CREATE/);
  assert.match(s,/shareAccess=0/);
  assert.match(s,/DirectoryFor\(parts\)/);
  assert.match(s,/STAGE_NATIVE_CREATE_FAILED/);
  assert.match(s,/STAGE_REPARSE_OR_UNVERIFIED_HANDLE/);
  assert.doesNotMatch(s,/New-Item -ItemType Directory -Path \$stage/);
  assert.doesNotMatch(s,/Copy-Item -LiteralPath \$from -Destination \$to/);
  assert.doesNotMatch(s,/\[IO\.File\]::WriteAllText\(\$dest/);
  assert.doesNotMatch(s,/Start-Process|Stop-Process|Restart-Service|Set-Service|Invoke-Expression|Invoke-RestMethod/);
  assert.match(s,/live_viewer_touched=\$false/);
  assert.match(s,/worker_started=\$false/);
});
test('Codex P2: receipt requires held-file final readbacks for all three trees',()=>{
  assert.match(s,/foreach\(KeyValuePair<string,FileStream> item in openFiles\)/);
  assert.match(s,/STAGE_FINAL_READBACK_SHA_MISMATCH/);
  assert.match(s,/STAGE_UNREVIEWED_BYTES_DENIED/);
  assert.match(s,/\$guard.Write\(\('candidate\\'/);
  assert.match(s,/\$guard.Write\(\('backup\\'/);
  assert.match(s,/\$guard.Write\(\('restore-test\\'/);
  assert.match(s,/\$guard.Write\('stage-manifest.json'/);
  assert.ok(s.indexOf('$guard.VerifyAll()') < s.indexOf("$guard.Write('stage-manifest.json'"));
  assert.ok(s.lastIndexOf('$guard.VerifyAll()') > s.indexOf("$guard.Write('stage-manifest.json'"));
  assert.match(s,/foreach\(FileStream fs in openFiles.Values\)fs.Dispose\(\)/);
  assert.match(s,/for\(int i=directories.Count-1;i>=0;i--\)directories\[i\].Dispose\(\)/);
});
test('Codex P2: refuse untracked stage files even if tracked files match hashes',()=>{
  assert.match(s,/const uint SHARE_READ = 1, SHARE_READ_WRITE = 3/);
  assert.match(s,/stage=Relative\(current,sha,true,true,SHARE_READ,false\)/);
  assert.match(s,/h=Relative\(h,parts\[i\],true,true,SHARE_READ,false\)/);
  assert.doesNotMatch(s,/stage=Relative\(current,sha,true,true,SHARE_READ_WRITE,false\)/);
  assert.doesNotMatch(s,/h=Relative\(h,parts\[i\],true,true,SHARE_READ_WRITE,false\)/);
  assert.match(s,/NtQueryDirectoryFile\(SafeFileHandle fileHandle/);
  assert.match(s,/FILE_NAMES_INFORMATION = 12/);
  assert.match(s,/static HashSet<string> ActualEntries\(SafeFileHandle dir\)/);
  assert.match(s,/void VerifyExactTree\(\)/);
  assert.match(s,/STAGE_UNTRACKED_ENTRY_OR_MISSING_FILE_/);
  assert.match(s,/observed.SetEquals\(required\)/);
  assert.match(s,/foreach\(string file in openFiles.Keys\)addChild\(file\)/);
  assert.match(s,/VerifyExactTree\(\); \/\/ Includes manifest on the final call/);
  assert.ok(s.lastIndexOf('$guard.VerifyAll()') > s.indexOf("$guard.Write('stage-manifest.json'"));
});
test('stage is exact-main and Owner-admin-bound before any writes',()=>{
  assert.ok(s.indexOf('VerifyHost')<s.indexOf('$guard.EnterNew($sha)'));
  assert.ok(s.indexOf('VerifyCandidate $work')<s.indexOf('$guard.EnterNew($sha)'));
  assert.match(s,/DESKTOP-H4A16IL\\admin/);
  assert.match(s,/CANONICAL_MAIN_STAGE_APPROVAL_MISSING/);
  assert.match(s,/\$stopBefore=HashFile \$stopPath/);
  assert.match(s,/\$disabledBefore=HashFile \$disabledPath/);
});


test('Codex P1: execute only the identical inspector content verified in memory',()=>{
  assert.match(s,/function AssertPinnedInspector/);
  assert.match(s,/UNREVIEWED_MUTABLE_INSPECTOR_DENIED/);
  assert.match(s,/555c555ec4159f78c08aec2de3091bffaa9e3edd/);
  assert.match(s,/return \$text/);
  assert.match(s,/\$verifiedInspector=AssertPinnedInspector \$inspector/);
  assert.match(s,/\. \(\[scriptblock\]::Create\(\$verifiedInspector\)\) -Mode SelfTest -ExpectedMainSha \$ExpectedMainSha -Workspace \$Workspace/);
  assert.doesNotMatch(s,/^\.\s+\$inspector(?:\s|$)/m);
});
test('Codex P2: second candidate read must match immutable reviewed pin before D staging',()=>{
  assert.match(s,/\$pinsRef=\$ExpectedMainSha\+':src\/control-center\/mpc010_control_center_preflight\.mjs'/);
  assert.match(s,/git --no-replace-objects -C \$work --no-optional-locks cat-file blob \$pinsRef/);
  assert.match(s,/\$pin=\[regex\]::Match\(\$reviewedPins/);
  assert.match(s,/if\(\$digest -cne \$pin\.Groups\[1\]\.Value\)\{throw 'CANDIDATE_SOURCE_HASH_NOT_REVIEWED'\}/);
  assert.match(s,/sha=\$pin\.Groups\[1\]\.Value/);
  assert.ok(s.indexOf('CANDIDATE_SOURCE_HASH_NOT_REVIEWED')<s.indexOf('$guard.EnterNew($sha)'));
});
