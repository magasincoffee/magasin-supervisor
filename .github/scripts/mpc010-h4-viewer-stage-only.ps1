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
function AssertPinnedInspector([string]$path) {
  # Never DOT-SOURCE a mutable worktree script without checking the exact
  # reviewed Git blob identity first. Compute canonical LF Git blob SHA-1
  # directly from bytes, without running Git hooks/filters or lazy fetching.
  $raw=[IO.File]::ReadAllBytes($path)
  if($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF){
    throw 'INSPECTOR_BOM_NOT_ALLOWED'
  }
  $utf8=New-Object System.Text.UTF8Encoding($false,$true)
  try{$text=$utf8.GetString($raw)}catch{throw 'INSPECTOR_INVALID_UTF8'}
  $normalized=$text.Replace(([string][char]13+[string][char]10),[string][char]10)
  $bytes=[Text.Encoding]::UTF8.GetBytes($normalized)
  $prefix=[Text.Encoding]::ASCII.GetBytes(('blob '+$bytes.Length)+[string][char]0)
  $input=New-Object byte[] ($prefix.Length+$bytes.Length)
  [Array]::Copy($prefix,0,$input,0,$prefix.Length)
  [Array]::Copy($bytes,0,$input,$prefix.Length,$bytes.Length)
  $sha1=[Security.Cryptography.SHA1]::Create()
  try{$digest=[BitConverter]::ToString($sha1.ComputeHash($input)).Replace('-','').ToLowerInvariant()}
  finally{$sha1.Dispose()}
  if($digest -cne '555c555ec4159f78c08aec2de3091bffaa9e3edd'){
    throw 'UNREVIEWED_MUTABLE_INSPECTOR_DENIED'
  }
  # Execute only verified in-memory source, not a second read of mutable inspector.
  return $text
}
$verifiedInspector=AssertPinnedInspector $inspector
. ([scriptblock]::Create($verifiedInspector)) -Mode SelfTest -ExpectedMainSha $ExpectedMainSha -Workspace $Workspace
$verified=RequireSource
if($verified -cne $work){throw 'INSPECTED_WORKSPACE_IDENTITY_CHANGED'}
$sotRef=$ExpectedMainSha+':SOURCE_OF_TRUTH.md'
$sot=@(& git --no-replace-objects -C $work --no-optional-locks cat-file blob $sotRef)
if($LASTEXITCODE -ne 0 -or !(($sot -join [Environment]::NewLine).Contains('### MPC-010 H4 Control Center STAGE ONLY'))){
  throw 'CANONICAL_MAIN_STAGE_APPROVAL_MISSING'
}
VerifyHost
VerifyCandidate $work
# Recheck each stage candidate against the immutable reviewed pin map.
$pinsRef=$ExpectedMainSha+':src/control-center/mpc010_control_center_preflight.mjs'
$pinsLines=@(& git --no-replace-objects -C $work --no-optional-locks cat-file blob $pinsRef)
if($LASTEXITCODE -ne 0 -or $pinsLines.Count -eq 0){throw 'REVIEWED_STAGE_PIN_OBJECT_MISSING'}
$sourceMap=$pinsLines -join "`n"
$mapStart=$sourceMap.IndexOf('export const REVIEWED_CANDIDATE_SHA256_20261014',[StringComparison]::Ordinal)
if($mapStart -lt 0){throw 'REVIEWED_STAGE_PIN_MAP_MISSING'}
$mapEnd=$sourceMap.IndexOf('});',$mapStart,[StringComparison]::Ordinal)
if($mapEnd -lt 0){throw 'REVIEWED_STAGE_PIN_MAP_INCOMPLETE'}
$reviewedPins=$sourceMap.Substring($mapStart,$mapEnd-$mapStart)
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
  $pattern='"'+[regex]::Escape($source)+'"\s*:\s*"([A-F0-9]{64})"'
  $pin=[regex]::Match($reviewedPins,$pattern,[Text.RegularExpressions.RegexOptions]::CultureInvariant)
  if(!$pin.Success){throw 'CANDIDATE_STAGE_SHA_NOT_PINNED'}
  $txt=ReadPinnedSource $work $source
  $shaObj=[Security.Cryptography.SHA256]::Create()
  try{$digest=[BitConverter]::ToString($shaObj.ComputeHash([Text.Encoding]::UTF8.GetBytes($txt))).Replace('-','')}
  finally{$shaObj.Dispose()}
  if($digest -cne $pin.Groups[1].Value){throw 'CANDIDATE_SOURCE_HASH_NOT_REVIEWED'}
  $candidates[$source]=@{content=$txt;sha=$pin.Groups[1].Value;target=[string]$expectedFiles[$source]}
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
