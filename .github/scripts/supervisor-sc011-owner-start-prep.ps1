param(
  [string]$TargetComputer='DESKTOP-4K7IM13',
  [int]$Attempt=1,
  [int]$NonTargetHoldSeconds=90
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

Write-Host "SC011_PREP_ATTEMPT=$Attempt"
Write-Host "SC011_PREP_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC011_PREP_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'SC011_PREP_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$start=Join-Path $root 'runtime\windows\start-supervisor.ps1'
if(-not (Test-Path $start)){throw 'Installed start-supervisor.ps1 is missing.'}

# Explicit Owner authorization was given in the active ChatGPT session.
# DryRun clears STOP/AUTOSTART_DISABLED but does not add --execute to the
# Single-Conversation runtime, so no project work runs before SC-011 qualification.
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $start -DryRun -Hidden
if($LASTEXITCODE -ne 0){throw "Owner START dry-run failed with exit $LASTEXITCODE."}

for($i=0;$i -lt 40;$i++){
  $wrapper=@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object{$_.CommandLine -and $_.CommandLine -like '*run-supervisor.ps1*' -and $_.CommandLine -like "*$root*"})
  if($wrapper.Count -ge 1){
    Write-Host "SC011_PREP_WRAPPER_COUNT=$($wrapper.Count)"
    Write-Host 'SC011_PREP_OWNER_LATCH_CLEARED=True'
    Write-Host 'SC011_PREP_PROJECT_EXECUTION=False'
    exit 0
  }
  Start-Sleep -Milliseconds 500
}
throw 'Dry-run wrapper did not become visible.'
