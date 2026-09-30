param([Parameter(Mandatory=$true)][string]$TargetComputer,[int]$NonTargetHoldSeconds=90)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
Write-Host "SC013_AMBIG_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC013_AMBIG_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'SC013_AMBIG_TARGET_MATCH=True'
. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$statePath=Join-Path $root 'single-conversation-state.json'
$s=Get-Content $statePath -Raw -Encoding UTF8|ConvertFrom-Json
Write-Host "SC013_AMBIG_GENERATION=$([int]$s.conversation.generation)"
Write-Host "SC013_AMBIG_AUTOMATION=$([string]$s.automation.status)"
Write-Host "SC013_AMBIG_PHASE=$([string]$s.automation.phase)"
Write-Host "SC013_AMBIG_REASON=$([string]$s.automation.reason)"
Write-Host "SC013_AMBIG_OUTBOUND=$([string]$s.outbound.state)"
Write-Host "SC013_AMBIG_RETRY_COUNT=$([int]$s.outbound.retry_count)"
Write-Host "SC013_AMBIG_LAST_ERROR=$([string]$s.outbound.last_error_code)"
Write-Host "SC013_AMBIG_DELIVERED_AT=$([string]$s.outbound.delivered_at)"
$chrome=Get-LifecycleRobotChrome -Root $root
if(-not $chrome -or -not $chrome.CommandLine -or $chrome.CommandLine -notmatch '--remote-debugging-port=(\d+)'){
  Write-Host 'SC013_AMBIG_CDP=False'
  exit 4
}
$cdp="http://127.0.0.1:$([int]$Matches[1])"
Write-Host "SC013_AMBIG_CDP=$cdp"
& node (Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc013-delivery-ambiguity.mjs') $runtime $statePath $cdp
exit /b $LASTEXITCODE
