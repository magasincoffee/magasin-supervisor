param(
  [Parameter(Mandatory=$true)][string]$TargetComputer,
  [int]$NonTargetHoldSeconds=120
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

Write-Host "LIVE_STUCK_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'LIVE_STUCK_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'LIVE_STUCK_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$statePath=Join-Path $root 'single-conversation-state.json'
$truth=Get-LifecycleProcessTruth -Root $root

Write-Host "LIVE_STUCK_WRAPPER=$([bool]$truth.wrapper_alive)"
Write-Host "LIVE_STUCK_RUNTIME=$([bool]$truth.runtime_alive)"
Write-Host "LIVE_STUCK_CHROME=$([bool]$truth.chrome_alive)"
Write-Host "LIVE_STUCK_CDP=$([bool]$truth.cdp_healthy)"

if(Test-Path $statePath -PathType Leaf){
  $s=Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host "LIVE_STUCK_GENERATION=$([int]$s.conversation.generation)"
  Write-Host "LIVE_STUCK_CONVERSATION_STATUS=$([string]$s.conversation.status)"
  Write-Host "LIVE_STUCK_AUTOMATION_STATUS=$([string]$s.automation.status)"
  Write-Host "LIVE_STUCK_AUTOMATION_PHASE=$([string]$s.automation.phase)"
  Write-Host "LIVE_STUCK_AUTOMATION_REASON=$([string]$s.automation.reason)"
  Write-Host "LIVE_STUCK_OUTBOUND_STATE=$([string]$s.outbound.state)"
  Write-Host "LIVE_STUCK_OUTBOUND_KIND=$([string]$s.outbound.kind)"
  Write-Host "LIVE_STUCK_OUTBOUND_MESSAGE_ID=$([string]$s.outbound.message_id)"
  Write-Host "LIVE_STUCK_OUTBOUND_RETRY_COUNT=$([int]$s.outbound.retry_count)"
  Write-Host "LIVE_STUCK_OUTBOUND_LAST_ERROR=$([string]$s.outbound.last_error_code)"
  Write-Host "LIVE_STUCK_OUTBOUND_PREPARED_AT=$([string]$s.outbound.prepared_at)"
  Write-Host "LIVE_STUCK_OUTBOUND_ENQUEUED_AT=$([string]$s.outbound.enqueued_at)"
  Write-Host "LIVE_STUCK_OUTBOUND_DELIVERED_AT=$([string]$s.outbound.delivered_at)"
  Write-Host "LIVE_STUCK_OUTBOUND_RESPONSE_RUNNING_AT=$([string]$s.outbound.response_running_at)"
  Write-Host "LIVE_STUCK_OUTBOUND_RESPONSE_COMPLETE_AT=$([string]$s.outbound.response_complete_at)"
  Write-Host "LIVE_STUCK_OUTBOUND_VERIFIED_AT=$([string]$s.outbound.verified_at)"
}

$chrome=Get-LifecycleRobotChrome -Root $root
if(-not $chrome -or -not $chrome.CommandLine){throw 'Dedicated Chrome process not found.'}
if($chrome.CommandLine -notmatch '--remote-debugging-port=(\d+)'){throw 'Dedicated Chrome CDP port not found.'}
$port=[int]$Matches[1]
$cdpUrl="http://127.0.0.1:$port"
Write-Host "LIVE_STUCK_CDP_PORT=$port"

$probePath=Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc011-live-stuck-dom.mjs'
& node $probePath $runtime $cdpUrl
if($LASTEXITCODE -ne 0){throw "Live DOM probe failed with exit $LASTEXITCODE"}
