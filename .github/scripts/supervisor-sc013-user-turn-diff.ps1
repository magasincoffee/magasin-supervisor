param([Parameter(Mandatory=$true)][string]$TargetComputer,[int]$NonTargetHoldSeconds=90)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'TURNDIFF_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'TURNDIFF_TARGET_MATCH=True'
. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$state=Join-Path $root 'single-conversation-state.json'
$chrome=Get-LifecycleRobotChrome -Root $root
if(-not $chrome -or $chrome.CommandLine -notmatch '--remote-debugging-port=(\d+)'){throw 'CDP unavailable'}
$cdp="http://127.0.0.1:$([int]$Matches[1])"
& node (Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc013-user-turn-diff.mjs') $runtime $state $cdp
if($LASTEXITCODE -ne 0){throw "turn diff failed with $LASTEXITCODE"}
