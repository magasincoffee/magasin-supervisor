param(
  [Parameter(Mandatory=$true)][string]$TargetComputer,
  [Parameter(Mandatory=$true)][string]$ExpectedMessageId,
  [int]$NonTargetHoldSeconds=90
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
Write-Host "SC013_BACKFILL_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC013_BACKFILL_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'SC013_BACKFILL_TARGET_MATCH=True'
. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$statePath=Join-Path $root 'single-conversation-state.json'
if(-not (Test-Path $runtime)){throw 'runtime missing'}
if(-not (Test-Path $statePath)){throw 'state missing'}
& node (Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc013-backfill-preactuation-evidence.mjs') $runtime $statePath $ExpectedMessageId
exit $LASTEXITCODE
