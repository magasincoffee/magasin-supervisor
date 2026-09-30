param([Parameter(Mandatory=$true)][string]$TargetComputer,[int]$NonTargetHoldSeconds=90)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'DIGEST_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'DIGEST_TARGET_MATCH=True'
. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$statePath=Join-Path $root 'single-conversation-state.json'
$s=Get-Content $statePath -Raw -Encoding UTF8|ConvertFrom-Json
Write-Host "DIGEST_OUTBOUND_STATE=$([string]$s.outbound.state)"
Write-Host "DIGEST_MESSAGE_DIGEST=$([string]$s.outbound.message_digest)"
Write-Host "DIGEST_MESSAGE_ID=$([string]$s.outbound.message_id)"
$chrome=Get-LifecycleRobotChrome -Root $root
if(-not $chrome -or $chrome.CommandLine -notmatch '--remote-debugging-port=(\d+)'){throw 'CDP port not found'}
$cdp="http://127.0.0.1:$([int]$Matches[1])"
& node (Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc011-live-draft-digest.mjs') $runtime $cdp
exit /b $LASTEXITCODE
