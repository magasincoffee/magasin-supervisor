param(
  [Parameter(Mandatory=$true)][ValidateSet('SelfTest','Stage')][string]$Mode,
  [ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedMainSha='',
  [string]$Workspace=''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
# Isolated STAGE only. No Control Center live write and NO robot START.
if($Mode -eq 'SelfTest'){
  Write-Output 'MPC010_H4_VIEWER_STAGE_SYNTHETIC_SELFTEST_PASS=True'
  Write-Output 'FIELD_APPLY_AUTHORIZED=False'
  return
}
if([Environment]::MachineName -cne 'DESKTOP-H4A16IL' -or
   [Security.Principal.WindowsIdentity]::GetCurrent().Name -cne 'DESKTOP-H4A16IL\admin'){
  throw 'H4_OWNER_ADMIN_REQUIRED'
}
if(!$Workspace -or !$ExpectedMainSha){throw 'EXACT_MAIN_AND_WORKSPACE_REQUIRED'}
$work=(Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path
$inspector=Join-Path $work '.github\scripts\mpc010-h4-viewer-owner-release.ps1'
if(!(Test-Path -LiteralPath $inspector -PathType Leaf)){throw 'CANONICAL_INSPECTOR_MISSING'}
. $inspector -Mode SelfTest -ExpectedMainSha $ExpectedMainSha -Workspace $Workspace
$verified=RequireSource
if($verified -cne $work){throw 'INSPECTED_WORKSPACE_IDENTITY_CHANGED'}
$sotRef=$ExpectedMainSha+':SOURCE_OF_TRUTH.md'
$sot=@(& git --no-replace-objects -C $work --no-optional-locks cat-file blob $sotRef)
if($LASTEXITCODE -ne 0 -or !(($sot -join [Environment]::NewLine).Contains('### MPC-010 H4 Control Center STAGE ONLY'))){
  throw 'CANONICAL_MAIN_STAGE_APPROVAL_MISSING'
}
VerifyHost
VerifyCandidate $work
$sha=$ExpectedMainSha.ToLowerInvariant()
$stage=Join-Path 'D:\MAGASIN_ROBOTS\deploy\mpc010-viewer' $sha
AssertNoReparse $stage
if(Test-Path -LiteralPath $stage){throw 'STAGE_PATH_ALREADY_EXISTS_DO_NOT_OVERWRITE'}
$stopDir='C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor'
$stopPath=Join-Path $stopDir 'STOP'
$disabledPath=Join-Path $stopDir 'AUTOSTART_DISABLED'
$stopBefore=HashFile $stopPath
$disabledBefore=HashFile $disabledPath
$candidates=@{}
foreach($source in $expectedFiles.Keys){
  $txt=ReadPinnedSource $work $source
  $shaObj=[Security.Cryptography.SHA256]::Create()
  try{$digest=[BitConverter]::ToString($shaObj.ComputeHash([Text.Encoding]::UTF8.GetBytes($txt))).Replace('-','')}
  finally{$shaObj.Dispose()}
  if($digest -notmatch '^[A-F0-9]{64}$'){throw 'BAD_CANDIDATE_SHA'}
  $candidates[$source]=@{content=$txt;sha=$digest;target=[string]$expectedFiles[$source]}
}
foreach($path in $oldHashes.Keys){
  if((HashFile (Join-Path $install $path)) -cne $oldHashes[$path]){throw 'OLD_VIEWER_CHANGED_BEFORE_STAGE'}
}
# All writes below are confined to a NEW isolated D: stage subtree.
$parent=Split-Path -Parent $stage
if(!(Test-Path -LiteralPath $parent -PathType Container)){
  New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop|Out-Null
}
AssertNoReparse $parent
New-Item -ItemType Directory -Path $stage -ErrorAction Stop|Out-Null
$utf8=New-Object System.Text.UTF8Encoding($false)
$stagedCandidates=@{}
$backups=@{}
foreach($source in $expectedFiles.Keys){
  $candidate=$candidates[$source]
  $dest=Join-Path (Join-Path $stage 'candidate') $candidate.target
  New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force -ErrorAction Stop|Out-Null
  [IO.File]::WriteAllText($dest,[string]$candidate.content,$utf8)
  if((HashFile $dest) -cne $candidate.sha){throw 'STAGED_CANDIDATE_HASH_MISMATCH'}
  $stagedCandidates[$candidate.target]=[string]$candidate.sha
}
foreach($rel in $oldHashes.Keys){
  $from=Join-Path $install $rel
  $to=Join-Path (Join-Path $stage 'backup') $rel
  New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force -ErrorAction Stop|Out-Null
  Copy-Item -LiteralPath $from -Destination $to -ErrorAction Stop
  if((HashFile $to) -cne $oldHashes[$rel]){throw 'OLD_VIEWER_BACKUP_HASH_MISMATCH'}
  $backups[$rel]=[string]$oldHashes[$rel]
  $dry=Join-Path (Join-Path $stage 'restore-test') $rel
  New-Item -ItemType Directory -Path (Split-Path -Parent $dry) -Force -ErrorAction Stop|Out-Null
  Copy-Item -LiteralPath $to -Destination $dry -ErrorAction Stop
  if((HashFile $dry) -cne $oldHashes[$rel]){throw 'RESTORE_REHEARSAL_FAILED'}
}
VerifyHost
VerifyCandidate $work
if((HashFile $stopPath) -cne $stopBefore -or (HashFile $disabledPath) -cne $disabledBefore){
  throw 'STOP_LATCH_CHANGED_DURING_STAGE'
}
foreach($rel in $oldHashes.Keys){
  if((HashFile (Join-Path $install $rel)) -cne $oldHashes[$rel]){throw 'LIVE_VIEWER_CHANGED_DURING_STAGE'}
}
$receipt=[ordered]@{
  schema='MPC010_H4_VIEWER_STAGE_ONLY_V1'
  status='STAGED_AND_ISOLATED_RESTORE_VERIFIED'
  expected_main_sha=$sha
  host=[Environment]::MachineName
  owner=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  staged_at=[DateTimeOffset]::UtcNow.ToString('o')
  candidate_sha256=$stagedCandidates
  old_file_backup_sha256=$backups
  stop_sha256=$stopBefore
  autostart_disabled_sha256=$disabledBefore
  restore_rehearsal_pass=$true
  live_viewer_touched=$false
  worker_started=$false
  field_apply_authorized=$false
}
$receiptPath=Join-Path $stage 'stage-manifest.json'
[IO.File]::WriteAllText($receiptPath,($receipt|ConvertTo-Json -Depth 7),$utf8)
Write-Output 'MPC010_H4_VIEWER_STAGE_ONLY_PASS=True'
Write-Output 'ISOLATED_RESTORE_REHEARSAL_PASS=True'
Write-Output 'LIVE_VIEWER_TOUCHED=False'
Write-Output 'SUPERVISOR_STARTED=False'
Write-Output 'FIELD_APPLY_AUTHORIZED=False'
Write-Output "STAGE_RECEIPT=$receiptPath"
