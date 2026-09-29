param(
  [Parameter(Mandatory=$true)][string]$TargetComputer,
  [int]$NonTargetHoldSeconds=90
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

Write-Host "SC011_PROFILE_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC011_PROFILE_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'SC011_PROFILE_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$truth=Get-LifecycleProcessTruth -Root $root
Write-Host "SC011_PROFILE_WRAPPER=$([bool]$truth.wrapper_alive)"
Write-Host "SC011_PROFILE_RUNTIME=$([bool]$truth.runtime_alive)"
Write-Host "SC011_PROFILE_CHROME=$([bool]$truth.chrome_alive)"
Write-Host "SC011_PROFILE_CDP=$([bool]$truth.cdp_healthy)"
if(-not $truth.chrome_alive -or -not $truth.cdp_healthy){ throw 'Production Chrome/CDP is not healthy.' }

$chrome=Get-LifecycleRobotChrome -Root $root
if(-not $chrome.CommandLine -or $chrome.CommandLine -notmatch '--remote-debugging-port=(\d+)'){ throw 'CDP port not found.' }
$port=[int]$Matches[1]
Write-Host "SC011_PROFILE_CDP_PORT=$port"

$statePath=Join-Path $root 'single-conversation-state.json'
if(Test-Path $statePath){
  $s=Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host "SC011_PROFILE_STATE_GENERATION=$([int]$s.conversation.generation)"
  Write-Host "SC011_PROFILE_STATE_AUTOMATION=$([string]$s.automation.status)"
  Write-Host "SC011_PROFILE_STATE_PHASE=$([string]$s.automation.phase)"
  Write-Host "SC011_PROFILE_STATE_OUTBOUND=$([string]$s.outbound.state)"
  Write-Host "SC011_PROFILE_STATE_REASON=$([string]$s.automation.reason)"
}

$script=Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc011-prepared-profile.mjs'
& node $script "http://127.0.0.1:$port"
exit $LASTEXITCODE
