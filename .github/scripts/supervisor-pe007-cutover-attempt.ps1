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

Write-Host "PE007_CUTOVER_ATTEMPT=$Attempt"
Write-Host "PE007_CUTOVER_MACHINE=$env:COMPUTERNAME"

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Set-JobOutput -Name 'target_match' -Value 'false'
  Set-JobOutput -Name 'cutover' -Value 'false'
  $hold = [math]::Max(0, [math]::Min(300, $NonTargetHoldSeconds))
  Write-Host 'PE007_CUTOVER_TARGET_MATCH=False'
  Write-Host "PE007_CUTOVER_NON_TARGET_HOLD_SECONDS=$hold"
  if ($hold -gt 0) { Start-Sleep -Seconds $hold }
  exit 0
}

Set-JobOutput -Name 'target_match' -Value 'true'
Write-Host 'PE007_CUTOVER_TARGET_MATCH=True'

$script = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-pe007-production-cutover.ps1'
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script -TargetComputer $TargetComputer -LaneId 'lane-1'
if ($LASTEXITCODE -ne 0) {
  Set-JobOutput -Name 'cutover' -Value 'false'
  throw "Production cutover failed with exit code $LASTEXITCODE"
}

Set-JobOutput -Name 'cutover' -Value 'true'
Write-Host 'PE007_CUTOVER_EXECUTED=True'
