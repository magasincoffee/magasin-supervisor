param(
  [Parameter(Mandatory=$true)][string]$TargetComputer,
  [int]$NonTargetHoldSeconds=120
)
$ErrorActionPreference='Stop'
Write-Host "SC013_DIAG_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC013_DIAG_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'SC013_DIAG_TARGET_MATCH=True'
. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$state=Join-Path $root 'single-conversation-state.json'
if(-not (Test-Path $state)){throw 'single-conversation-state.json missing'}
$chrome=Get-LifecycleRobotChrome -Root $root
if(-not $chrome -or -not $chrome.CommandLine -or $chrome.CommandLine -notmatch '--remote-debugging-port=(\d+)'){
  throw 'Dedicated Chrome/CDP unavailable'
}
$cdp="http://127.0.0.1:$([int]$Matches[1])"
Write-Host "SC013_DIAG_CDP=$cdp"
& node (Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc013-rebind-diagnostic.mjs') $runtime $state $cdp
if($LASTEXITCODE -ne 0){throw "SC013 rebind diagnostic failed with exit $LASTEXITCODE"}


Write-Host '--- SC013 current durable state ---'
try{
  $s=Get-Content $state -Raw -Encoding UTF8|ConvertFrom-Json
  Write-Host "SC013_DIAG_AUTOMATION=$([string]$s.automation.status)"
  Write-Host "SC013_DIAG_PHASE=$([string]$s.automation.phase)"
  Write-Host "SC013_DIAG_REASON=$([string]$s.automation.reason)"
  Write-Host "SC013_DIAG_LAST_ERROR_CODE=$([string]$s.outbound.last_error_code)"
  Write-Host "SC013_DIAG_LAST_ERROR_STAGE=$([string]$s.outbound.last_error_stage)"
}catch{
  Write-Host "SC013_DIAG_STATE_READ_ERROR=$($_.Exception.Message)"
}

try{
  $truth=Get-LifecycleProcessTruth -Root $root
  $ownerStop=Get-LifecycleOwnerStopState -Root $root
  Write-Host "SC013_DIAG_WRAPPER_ALIVE=$([bool]$truth.wrapper_alive)"
  Write-Host "SC013_DIAG_RUNTIME_MODE=$([string]$truth.runtime_mode)"
  Write-Host "SC013_DIAG_CDP_HEALTHY=$([bool]$truth.cdp_healthy)"
  Write-Host "SC013_DIAG_OWNER_STOP_BLOCKED=$([bool]$ownerStop.blocked)"
}catch{
  Write-Host "SC013_DIAG_LIFECYCLE_ERROR=$($_.Exception.Message)"
}

$supervisorLog=Join-Path $root 'supervisor.log'
if(Test-Path $supervisorLog){
  Write-Host '--- SC013 supervisor.log tail ---'
  Get-Content $supervisorLog -Tail 80 -Encoding UTF8 | ForEach-Object { Write-Host ("SC013_LOG " + $_) }
}
