param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13',
  [int]$Attempt = 1,
  [int]$NonTargetHoldSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if ([string]::IsNullOrWhiteSpace([string]$env:GITHUB_OUTPUT)) {
  throw 'GITHUB_OUTPUT is unavailable.'
}
function Set-JobOutput([string]$Name, [string]$Value) {
  "$Name=$Value" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
}

Write-Host "MBV1_008_CUTOVER_ATTEMPT=$Attempt"
Write-Host "MBV1_008_CUTOVER_MACHINE=$env:COMPUTERNAME"

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Set-JobOutput 'target_match' 'false'
  Set-JobOutput 'qualified' 'false'
  Set-JobOutput 'cutover' 'false'
  $hold = [math]::Max(0, [math]::Min(300, $NonTargetHoldSeconds))
  Write-Host "MBV1_008_CUTOVER_NON_TARGET_HOLD_SECONDS=$hold"
  if ($hold -gt 0) { Start-Sleep -Seconds $hold }
  exit 0
}

Set-JobOutput 'target_match' 'true'

$qualifier = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-mbv1-008-live-qualification.ps1'
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $qualifier -TargetComputer $TargetComputer
if ($LASTEXITCODE -ne 0) {
  throw "MBV1-008 live requalification failed with exit code $LASTEXITCODE"
}
Set-JobOutput 'qualified' 'true'

$cutover = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-mbv1-008-production-cutover.ps1'
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $cutover -TargetComputer $TargetComputer
if ($LASTEXITCODE -ne 0) {
  throw "MBV1-008 production cutover failed with exit code $LASTEXITCODE"
}
Set-JobOutput 'cutover' 'true'
Write-Host 'MBV1_008_CUTOVER_ATTEMPT_PASS=True'
