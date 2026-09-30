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
