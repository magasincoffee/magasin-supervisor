param([Parameter(Mandatory=$true)][string]$TargetComputer,[int]$NonTargetHoldSeconds=90)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
Write-Host "SC011_STOP_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC011_STOP_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'SC011_STOP_TARGET_MATCH=True'
. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$stop=Join-Path $root 'runtime\windows\stop-supervisor.ps1'
if(-not (Test-Path $stop -PathType Leaf)){throw "Installed STOP script missing: $stop"}
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $stop
if($LASTEXITCODE -ne 0){throw "STOP failed: $LASTEXITCODE"}
Write-Host 'SC011_STOP_DONE=True'
