param(
  [Parameter(Mandatory=$true)]
  [ValidatePattern('^[a-fA-F0-9]{40}$')]
  [string]$ExpectedMainSha
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

# SC-013: candidate-and-backup STAGE ONLY. Deliberately no APPLY mode, no
# live runtime/source write, no Chrome/worker mutation and no Owner re-arm.
if([Environment]::MachineName -cne 'DESKTOP-H4A16IL'){
  Write-Host 'TARGET_MUTATION_SKIPPED=True'
  throw 'WRONG_TARGET_MACHINE'
}
if($env:GITHUB_EVENT_NAME -notin @('push','workflow_dispatch')){
  throw 'NOT_EXPLICIT_STAGE_EVENT'
}
$workspace=[string]$env:GITHUB_WORKSPACE
if([string]::IsNullOrWhiteSpace($workspace) -or
   !(Test-Path (Join-Path $workspace '.git') -PathType Container)){
  throw 'GITHUB_WORKSPACE_NOT_VERIFIED'
}
$sha=(& git -C $workspace rev-parse HEAD).Trim().ToLowerInvariant()
if($LASTEXITCODE -ne 0 -or $sha -cne $ExpectedMainSha.ToLowerInvariant()){
  throw 'CHECKOUT_SHA_MISMATCH'
}
$remoteLine=(& git -C $workspace ls-remote origin refs/heads/main)
if($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$remoteLine)){
  throw 'REMOTE_MAIN_NOT_VERIFIED'
}
$remoteSha=([string]$remoteLine -split '\s+')[0].ToLowerInvariant()
if($remoteSha -cne $sha){throw 'MAIN_MOVED_RESTAGE_REQUIRED'}

$markerPath=Join-Path $workspace '.github\sc013-project-hold-stage-request.json'
if(!(Test-Path $markerPath -PathType Leaf)){throw 'REVIEWED_STAGE_MARKER_REQUIRED'}
$marker=Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8|ConvertFrom-Json
if([string]$marker.schema -cne 'MAGASIN_SC013_PROJECT_HOLD_STAGE_V1' -or
   [string]$marker.target -cne 'DESKTOP-H4A16IL' -or
   [string]$marker.mode -cne 'STAGE_ONLY' -or
   [string]$marker.task_id -cne 'SC-013' -or
   [string]$marker.sot -cne 'SOURCE_OF_TRUTH.md' -or
   [string]$marker.owner_intent -cne 'REVIEWED_SOURCE_STAGE_ONLY' -or
   [bool]$marker.apply -or [bool]$marker.start_robot){
  throw 'STAGE_MARKER_CONTRACT_REJECTED'
}

$root='C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor'
$liveWin=Join-Path $root 'runtime\windows'
$statePath=Join-Path $root 'single-conversation-state.json'
$controlPath=Join-Path $root 'single-conversation-control.json'
$stopPath=Join-Path $root 'STOP'
$disablePath=Join-Path $root 'AUTOSTART_DISABLED'
$targetWrapper=Join-Path $liveWin 'run-supervisor.ps1'
$targetHelper=Join-Path $liveWin 'project-fault-containment.ps1'
$sourceWrapper=Join-Path $workspace 'windows\run-supervisor.ps1'
$sourceHelper=Join-Path $workspace 'windows\project-fault-containment.ps1'
$stage=Join-Path 'D:\MAGASIN_ROBOTS\deploy\sc013-project-hold' $sha
$expectedOldWrapper='7b96ccf0fcbcf0caafd0148b4a10b31989a49700703a2efffcf526d68a6ff31e'
function Hash([string]$p) {
  if(!(Test-Path -LiteralPath $p -PathType Leaf)){throw "FILE_MISSING:$p"}
  return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
}
function AssertNotReparse([string]$p){
  $item=Get-Item -LiteralPath $p -Force -ErrorAction Stop
  if(($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){
    throw 'REPARSE_PATH_REJECTED'
  }
}
foreach($p in @($root,$liveWin,$targetWrapper,$sourceWrapper,$sourceHelper)){
  AssertNotReparse $p
}
if(!(Test-Path $statePath -PathType Leaf) -or
   !(Test-Path $controlPath -PathType Leaf)){
  throw 'CANONICAL_SUPERVISOR_STATE_NOT_FOUND'
}
$state=Get-Content -LiteralPath $statePath -Raw -Encoding UTF8|ConvertFrom-Json
$control=Get-Content -LiteralPath $controlPath -Raw -Encoding UTF8|ConvertFrom-Json
if([string]$control.mode -cne 'SINGLE_CONVERSATION_V1' -or
   [string]::IsNullOrWhiteSpace([string]$control.source_of_truth_url)){
  throw 'SOT_CONTROL_INVALID'
}
if(!(Test-Path $stopPath -PathType Leaf) -or
   !(Test-Path $disablePath -PathType Leaf)){
  throw 'OWNER_STOP_GATES_NOT_ASSERTED'
}
if([string]$state.automation.status -cne 'BLOCKED' -or
   [string]$state.automation.reason -cne 'AMBIGUOUS_ENQUEUED_OUTCOME' -or
   [string]$state.outbound.state -cne 'ENQUEUED' -or
   [string]$state.outbound.kind -cne 'TASK_STATUS_CHECK'){
  throw 'INCIDENT_STATE_CHANGED_REQUIRE_REVIEW'
}
if(Test-Path $targetHelper){throw 'NEW_HELPER_ALREADY_INSTALLED'}
if((Hash $targetWrapper) -cne $expectedOldWrapper){
  throw 'LIVE_WRAPPER_SHA_CHANGED'
}
$running=@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop |
  Where-Object {
    $_.CommandLine -and $_.CommandLine -like '*run-supervisor.ps1*' -and
    $_.CommandLine -like '*MAGASIN*'
  })
if($running.Count -ne 0){throw 'WRAPPER_MUST_BE_STOPPED_FOR_STAGE'}
if((Get-PSDrive D).Free -lt 2GB){throw 'STAGE_DISK_SPACE_INSUFFICIENT'}
if(Test-Path $stage){throw 'STAGE_ALREADY_EXISTS_REVIEW_BEFORE_RETRY'}

foreach($p in @($sourceWrapper,$sourceHelper)){
  $tokens=$null
  $parseErrors=$null
  $null=[System.Management.Automation.Language.Parser]::ParseFile($p,[ref]$tokens,[ref]$parseErrors)
  if($null -ne $parseErrors -and @($parseErrors).Count -gt 0){throw 'POWERSHELL_SYNTAX_INVALID'}
}
$helperSource=Get-Content -LiteralPath $sourceHelper -Raw -Encoding UTF8
$wrapperSource=Get-Content -LiteralPath $sourceWrapper -Raw -Encoding UTF8
if(!$wrapperSource.Contains('project-fault-containment.ps1') -or
   !$wrapperSource.Contains('Invoke-SupervisorProjectHold') -or
   !$helperSource.Contains('pending_transaction_replay_allowed = $false') -or
   !$helperSource.Contains('while (-not (Test-Path $StopFile) -and -not (Test-Path $AutostartDisabledFile))')){
  throw 'PROJECT_HOLD_SOURCE_CONTRACT_MISSING'
}

$sourceWrapperHash=Hash $sourceWrapper
$sourceHelperHash=Hash $sourceHelper
$oldControlHash=Hash $controlPath
$oldStateHash=Hash $statePath
$oldStopHash=Hash $stopPath
$oldDisableHash=Hash $disablePath

# The only file writes below are D:\ staging candidates, backup and receipt.
New-Item -ItemType Directory -Path (Join-Path $stage 'candidate') -Force -ErrorAction Stop|Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'backup') -Force -ErrorAction Stop|Out-Null
$stagedWrapper=Join-Path $stage 'candidate\run-supervisor.ps1'
$stagedHelper=Join-Path $stage 'candidate\project-fault-containment.ps1'
$backupWrapper=Join-Path $stage 'backup\run-supervisor.ps1'
Copy-Item -LiteralPath $sourceWrapper -Destination $stagedWrapper -ErrorAction Stop
Copy-Item -LiteralPath $sourceHelper -Destination $stagedHelper -ErrorAction Stop
Copy-Item -LiteralPath $targetWrapper -Destination $backupWrapper -ErrorAction Stop
if((Hash $stagedWrapper) -cne $sourceWrapperHash -or
   (Hash $stagedHelper) -cne $sourceHelperHash -or
   (Hash $backupWrapper) -cne $expectedOldWrapper -or
   (Hash $targetWrapper) -cne $expectedOldWrapper -or
   (Hash $controlPath) -cne $oldControlHash -or
   (Hash $statePath) -cne $oldStateHash -or
   (Hash $stopPath) -cne $oldStopHash -or
   (Hash $disablePath) -cne $oldDisableHash -or
   (Test-Path $targetHelper)){
  throw 'POST_STAGE_PRODUCTION_READBACK_CHANGED'
}
$manifest=[ordered]@{
  schema='MAGASIN_SC013_PROJECT_HOLD_STAGED_V1'
  exact_main_sha=$sha
  target='DESKTOP-H4A16IL'
  status='STAGED_ONLY_NOT_INSTALLED'
  created_at=[DateTimeOffset]::UtcNow.ToString('o')
  old_wrapper_sha256=$expectedOldWrapper
  candidate_wrapper_sha256=$sourceWrapperHash
  candidate_helper_sha256=$sourceHelperHash
  control_file_sha256=$oldControlHash
  transaction_state_sha256=$oldStateHash
  stop_sha256=$oldStopHash
  autostart_disabled_sha256=$oldDisableHash
  original_helper_absent=$true
  observed_outbound_state='ENQUEUED'
  supervisor_started=$false
  outbound_modified=$false
  owner_stop_modified=$false
  next_gate='OWNER_REVIEWED_SEPARATE_APPLY'
}
$manifestPath=Join-Path $stage 'manifest.json'
$manifest|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $manifestPath -Encoding UTF8 -ErrorAction Stop
Write-Host "STAGE_MANIFEST=$manifestPath"
Write-Host "STAGE_EXACT_MAIN=$sha"
Write-Host 'STAGE_VERIFIED=True'
Write-Host 'NO_PRODUCTION_MUTATION=True'
Write-Host 'NO_WORKER_START=True'
Write-Host 'NO_OUTBOUND_SEND=True'
