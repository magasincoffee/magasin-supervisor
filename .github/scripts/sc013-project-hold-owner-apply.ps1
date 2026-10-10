param(
  [Parameter(Mandatory=$true)][ValidateSet('Stage','Apply')][string]$Mode,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$ExpectedMainSha,
  [Parameter(Mandatory=$true)][string]$Workspace,
  [string]$OwnerApproval=''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
# SC-013 Owner-attended, local-admin-only source install; not a robot START.
# Never clear Owner STOP, never touch pending ChatGPT transactions or switch SOT.
if([Environment]::MachineName -cne 'DESKTOP-H4A16IL'){throw 'WRONG_MACHINE'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
if($identity -cne 'DESKTOP-H4A16IL\admin'){throw 'OWNER_ADMIN_IDENTITY_REQUIRED'}
if($Mode -eq 'Apply' -and $OwnerApproval -cne 'SC013_SOURCE_ONLY_APPLY_APPROVED'){
  throw 'EXPLICIT_OWNER_APPLY_APPROVAL_REQUIRED'
}
if($Mode -eq 'Stage' -and $OwnerApproval){throw 'STAGE_HAS_NO_APPROVAL_ARGUMENT'}
$repository='https://github.com/magasincoffee/magasin-supervisor.git'
$work=(Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path
if(!(Test-Path (Join-Path $work '.git'))){throw 'VERIFIED_REPO_CHECKOUT_REQUIRED'}
$origin=(& git -C $work remote get-url origin)
if($LASTEXITCODE -ne 0 -or [string]$origin -cne $repository){throw 'REPO_ORIGIN_NOT_CANONICAL'}
$sha=(& git -C $work rev-parse HEAD).Trim().ToLowerInvariant()
if($LASTEXITCODE -ne 0 -or $sha -cne $ExpectedMainSha.ToLowerInvariant()){
  throw 'CHECKOUT_SHA_MISMATCH'
}
$remote=(& git -C $work ls-remote origin refs/heads/main)
if($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$remote)){
  throw 'REMOTE_MAIN_NOT_VERIFIED'
}
if(([string]$remote -split '\s+')[0].ToLowerInvariant() -cne $sha){
  throw 'MAIN_SHA_MOVED_RESTART_STAGE'
}
$sourceWrapper=Join-Path $work 'windows\run-supervisor.ps1'
$sourceHelper=Join-Path $work 'windows\project-fault-containment.ps1'
$sotPath=Join-Path $work 'SOURCE_OF_TRUTH.md'
$scriptSource=Join-Path $work '.github\scripts\sc013-project-hold-owner-apply.ps1'
$root='C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor'
$liveDir=Join-Path $root 'runtime\windows'
$liveWrapper=Join-Path $liveDir 'run-supervisor.ps1'
$liveHelper=Join-Path $liveDir 'project-fault-containment.ps1'
$statePath=Join-Path $root 'single-conversation-state.json'
$controlPath=Join-Path $root 'single-conversation-control.json'
$stopPath=Join-Path $root 'STOP'
$disabledPath=Join-Path $root 'AUTOSTART_DISABLED'
$stage=Join-Path 'D:\MAGASIN_ROBOTS\deploy\sc013-project-hold-owner-apply' $sha
$manifestPath=Join-Path $stage 'manifest.json'
$installPath=Join-Path $stage 'installation.json'
$stagedWrapper=Join-Path $stage 'candidate\run-supervisor.ps1'
$stagedHelper=Join-Path $stage 'candidate\project-fault-containment.ps1'
$backupWrapper=Join-Path $stage 'backup\run-supervisor.ps1'
$oldWrapperSha='7b96ccf0fcbcf0caafd0148b4a10b31989a49700703a2efffcf526d68a6ff31e'
function Hash([string]$p){
  if(!(Test-Path -LiteralPath $p -PathType Leaf)){throw "FILE_MISSING:$p"}
  return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
}
function NotReparse([string]$p){
  $i=Get-Item -LiteralPath $p -Force -ErrorAction Stop
  if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
    throw "REPARSE_PATH_REJECTED:$p"
  }
}
function CheckSourceSafety {
  foreach($p in @($work,$sourceWrapper,$sourceHelper,$scriptSource,$sotPath,
                  $root,$liveDir,$liveWrapper,$statePath,$controlPath,$stopPath,$disabledPath)){
    NotReparse $p
  }
  $sot=Get-Content -LiteralPath $sotPath -Raw -Encoding UTF8
  if(!$sot.Contains('SC-013 H4 Owner-admin source APPLY for staged project fault containment')){
    throw 'CURRENT_MAIN_SOT_APPLY_GATE_MISSING'
  }
  $newWrapper=Get-Content -LiteralPath $sourceWrapper -Raw -Encoding UTF8
  $newHelper=Get-Content -LiteralPath $sourceHelper -Raw -Encoding UTF8
  if(!$newWrapper.Contains('project-fault-containment.ps1') -or
     !$newWrapper.Contains('Invoke-SupervisorProjectHold') -or
     !$newHelper.Contains('pending_transaction_replay_allowed = $false') -or
     !$newHelper.Contains('while (-not (Test-Path $StopFile) -and -not (Test-Path $AutostartDisabledFile))')){
    throw 'REVIEWED_SOURCE_CONTRACT_MISSING'
  }
  foreach($p in @($sourceWrapper,$sourceHelper,$scriptSource)){
    $tok=$null;$errs=$null
    $null=[Management.Automation.Language.Parser]::ParseFile($p,[ref]$tok,[ref]$errs)
    if($null -ne $errs -and @($errs).Count -gt 0){throw 'POWERSHELL_SOURCE_SYNTAX_ERROR'}
  }
}
function CheckProductionSafety {
  if(!(Test-Path $stopPath -PathType Leaf) -or
     !(Test-Path $disabledPath -PathType Leaf)){throw 'OWNER_STOP_NOT_ASSERTED'}
  $control=Get-Content -LiteralPath $controlPath -Raw -Encoding UTF8|ConvertFrom-Json
  $state=Get-Content -LiteralPath $statePath -Raw -Encoding UTF8|ConvertFrom-Json
  if($control.mode -cne 'SINGLE_CONVERSATION_V1' -or
     [string]::IsNullOrWhiteSpace([string]$control.source_of_truth_url)){
    throw 'CANONICAL_CONTROL_INVALID'
  }
  if([string]$state.automation.status -cne 'BLOCKED' -or
     [string]$state.automation.reason -cne 'AMBIGUOUS_ENQUEUED_OUTCOME' -or
     [string]$state.outbound.state -cne 'ENQUEUED' -or
     [string]$state.outbound.kind -cne 'TASK_STATUS_CHECK' -or
     [string]$state.outbound.message_id -cne 'f3b69f53-d2b0-4a91-8ab7-5403807254df'){
    throw 'AMBIGUOUS_OUTBOUND_STATE_CHANGED'
  }
  $wrapper=@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop|
    Where-Object {$_.ProcessId -ne $PID -and $_.CommandLine -and
      $_.CommandLine -like '*run-supervisor.ps1*' -and $_.CommandLine -like '*MAGASIN*'})
  $nodes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop|
    Where-Object {$_.CommandLine -and $_.CommandLine -match 'single-conversation-cli\.mjs'})
  if($wrapper.Count -gt 0 -or $nodes.Count -gt 0){throw 'LIVE_SUPERVISOR_PROCESS_NOT_STOPPED'}
  if((Get-PSDrive D).Free -lt 2GB -or (Get-PSDrive C).Free -lt 0.8GB){
    throw 'INSUFFICIENT_SAFE_DISK_SPACE'
  }
}
CheckSourceSafety
CheckProductionSafety
if($Mode -eq 'Stage'){
  if((Hash $liveWrapper) -cne $oldWrapperSha){throw 'OLD_WRAPPER_SHA_CHANGED'}
  if(Test-Path $liveHelper){throw 'HELPER_ALREADY_PRESENT'}
  if(Test-Path $stage){throw 'STAGE_EXISTS_DO_NOT_OVERWRITE'}
  New-Item -ItemType Directory -Path (Join-Path $stage 'candidate') -ErrorAction Stop -Force|Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stage 'backup') -ErrorAction Stop -Force|Out-Null
  Copy-Item -LiteralPath $sourceWrapper -Destination $stagedWrapper -ErrorAction Stop
  Copy-Item -LiteralPath $sourceHelper -Destination $stagedHelper -ErrorAction Stop
  Copy-Item -LiteralPath $liveWrapper -Destination $backupWrapper -ErrorAction Stop
  $srcWrapperHash=Hash $sourceWrapper
  $srcHelperHash=Hash $sourceHelper
  if((Hash $stagedWrapper) -cne $srcWrapperHash -or
     (Hash $stagedHelper) -cne $srcHelperHash -or
     (Hash $backupWrapper) -cne $oldWrapperSha){throw 'STAGE_HASH_VERIFICATION_FAILED'}
  $manifest=[ordered]@{
    schema='SC013_OWNER_ADMIN_SOURCE_STAGE_V1'
    status='STAGED_ONLY'
    exact_main_sha=$sha
    host=[Environment]::MachineName
    staged_at=[DateTimeOffset]::UtcNow.ToString('o')
    owner_identity=$identity
    old_wrapper_sha256=$oldWrapperSha
    candidate_wrapper_sha256=$srcWrapperHash
    candidate_helper_sha256=$srcHelperHash
    control_sha256=Hash $controlPath
    state_sha256=Hash $statePath
    stop_sha256=Hash $stopPath
    disabled_sha256=Hash $disabledPath
    source_script_sha256=Hash $scriptSource
    original_helper_absent=$true
    no_start=$true
    no_outbound_replay=$true
    no_production_mutation=$true
  }
  $manifest|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $manifestPath -Encoding UTF8 -ErrorAction Stop
  if((Hash $liveWrapper) -cne $oldWrapperSha -or (Test-Path $liveHelper)){
    throw 'STAGE_ALTERED_PRODUCTION'
  }
  Write-Host 'SC013_OWNER_ADMIN_STAGE_VERIFIED=True'
  Write-Host "SC013_STAGE_MANIFEST=$manifestPath"
  Write-Host 'NO_PRODUCTION_MUTATION=True'
  exit 0
}
if(!(Test-Path $manifestPath -PathType Leaf) -or
   (Test-Path $installPath)){throw 'FRESH_STAGED_MANIFEST_REQUIRED'}
NotReparse $stage
NotReparse $stagedWrapper
NotReparse $stagedHelper
NotReparse $backupWrapper
$record=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json
if($record.schema -cne 'SC013_OWNER_ADMIN_SOURCE_STAGE_V1' -or
   $record.status -cne 'STAGED_ONLY' -or $record.exact_main_sha -cne $sha -or
   $record.owner_identity -cne $identity -or
   !$record.no_start -or !$record.no_outbound_replay -or
   !$record.original_helper_absent){throw 'STAGE_MANIFEST_NOT_QUALIFIED'}
if((Hash $stagedWrapper) -cne [string]$record.candidate_wrapper_sha256 -or
   (Hash $sourceWrapper) -cne [string]$record.candidate_wrapper_sha256 -or
   (Hash $stagedHelper) -cne [string]$record.candidate_helper_sha256 -or
   (Hash $sourceHelper) -cne [string]$record.candidate_helper_sha256 -or
   (Hash $backupWrapper) -cne $oldWrapperSha -or
   (Hash $liveWrapper) -cne $oldWrapperSha -or
   (Hash $controlPath) -cne [string]$record.control_sha256 -or
   (Hash $statePath) -cne [string]$record.state_sha256 -or
   (Hash $stopPath) -cne [string]$record.stop_sha256 -or
   (Hash $disabledPath) -cne [string]$record.disabled_sha256 -or
   (Hash $scriptSource) -cne [string]$record.source_script_sha256 -or
   (Test-Path $liveHelper)){throw 'STAGE_OR_PRODUCTION_CHANGED'}
CheckProductionSafety
$journal=[ordered]@{
  schema='SC013_OWNER_ADMIN_SOURCE_INSTALL_V1'
  status='APPLY_STARTED'
  exact_main_sha=$sha
  owner_identity=$identity
  started_at=[DateTimeOffset]::UtcNow.ToString('o')
  expected_wrapper_sha256=[string]$record.candidate_wrapper_sha256
  expected_helper_sha256=[string]$record.candidate_helper_sha256
  old_wrapper_sha256=$oldWrapperSha
  stop_preserved=$true
  outbound_unchanged=$true
  worker_started=$false
}
$journal|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $installPath -Encoding UTF8 -ErrorAction Stop
# File.Replace is atomic for the preexisting wrapper on the same NTFS volume.
$tmpHelper=Join-Path $liveDir ("project-fault-containment.ps1.sc013-$sha.tmp")
$tmpWrapper=Join-Path $liveDir ("run-supervisor.ps1.sc013-$sha.tmp")
$localBackup=Join-Path $liveDir ("run-supervisor.ps1.sc013-$sha.bak")
if((Test-Path $tmpHelper) -or (Test-Path $tmpWrapper) -or (Test-Path $localBackup)){
  throw 'PENDING_SOURCE_TEMPORARY_FILE_EXISTS'
}
$replaced=$false
try {
  Copy-Item -LiteralPath $stagedHelper -Destination $tmpHelper -ErrorAction Stop
  if((Hash $tmpHelper) -cne $record.candidate_helper_sha256){throw 'TEMP_HELPER_HASH_MISMATCH'}
  CheckProductionSafety
  Move-Item -LiteralPath $tmpHelper -Destination $liveHelper -ErrorAction Stop
  if((Hash $liveHelper) -cne $record.candidate_helper_sha256){throw 'INSTALLED_HELPER_HASH_MISMATCH'}
  Copy-Item -LiteralPath $stagedWrapper -Destination $tmpWrapper -ErrorAction Stop
  if((Hash $tmpWrapper) -cne $record.candidate_wrapper_sha256){throw 'TEMP_WRAPPER_HASH_MISMATCH'}
  CheckProductionSafety
  [IO.File]::Replace($tmpWrapper,$liveWrapper,$localBackup,$true)
  $replaced=$true
  if((Hash $liveWrapper) -cne $record.candidate_wrapper_sha256 -or
     (Hash $localBackup) -cne $oldWrapperSha){throw 'INSTALLED_WRAPPER_HASH_MISMATCH'}
  CheckProductionSafety
  if((Hash $statePath) -cne $record.state_sha256 -or
     (Hash $controlPath) -cne $record.control_sha256 -or
     (Hash $stopPath) -cne $record.stop_sha256 -or
     (Hash $disabledPath) -cne $record.disabled_sha256){
    throw 'POST_INSTALL_STATE_OR_OWNER_STOP_CHANGED'
  }
  $journal.status='SOURCE_INSTALLED_STOP_PRESERVED'
  $journal.installed_at=[DateTimeOffset]::UtcNow.ToString('o')
  $journal.installed_wrapper_sha256=Hash $liveWrapper
  $journal.installed_helper_sha256=Hash $liveHelper
  $journal.stop_preserved=$true
  $journal.outbound_unchanged=$true
  $journal.worker_started=$false
  $journal|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $installPath -Encoding UTF8 -ErrorAction Stop
  if((Hash $localBackup) -eq $oldWrapperSha){
    Remove-Item -LiteralPath $localBackup -Force -ErrorAction Stop
  }
  Write-Host 'SC013_SOURCE_INSTALLED_STOP_PRESERVED=True'
  Write-Host "SC013_APPLY_RECEIPT=$installPath"
  Write-Host 'SUPERVISOR_NOT_STARTED=True'
  Write-Host 'ENQUEUED_NOT_REPLAYED=True'
}catch{
  $cause=$_.Exception.Message
  $rollback='NOT_NEEDED'
  try {
    if($replaced -and (Hash $backupWrapper) -eq $oldWrapperSha){
      $rollbackTmp=Join-Path $liveDir ("run-supervisor.ps1.sc013-$sha.rollback.tmp")
      Copy-Item -LiteralPath $backupWrapper -Destination $rollbackTmp -ErrorAction Stop
      [IO.File]::Replace($rollbackTmp,$liveWrapper,$null,$true)
      if((Hash $liveWrapper) -ne $oldWrapperSha){throw 'ROLLBACK_WRAPPER_HASH_FAILED'}
      $rollback='WRAPPER_RESTORED'
    }
    if(Test-Path $liveHelper){
      if((Hash $liveHelper) -eq $record.candidate_helper_sha256){
        Remove-Item -LiteralPath $liveHelper -Force -ErrorAction Stop
      }else{throw 'UNKNOWN_HELPER_REFUSE_DELETE'}
    }
  }catch{$rollback="FAILED_MANUAL_REVIEW:$($_.Exception.Message)"}
  $journal.status='APPLY_FAILED'
  $journal.failure=$cause
  $journal.rollback=$rollback
  $journal|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $installPath -Encoding UTF8
  throw "SC013_APPLY_FAILED:$cause;ROLLBACK=$rollback"
}finally{
  foreach($p in @($tmpHelper,$tmpWrapper)){
    if(Test-Path $p){Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue}
  }
}
