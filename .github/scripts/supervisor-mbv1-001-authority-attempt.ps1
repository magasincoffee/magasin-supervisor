param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13',
  [int]$Attempt = 1,
  [int]$NonTargetHoldSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Write-Host "MBV1_001_AUTH_ATTEMPT=$Attempt"
Write-Host "MBV1_001_AUTH_MACHINE=$env:COMPUTERNAME"

if ([string]::IsNullOrWhiteSpace([string]$env:GITHUB_OUTPUT)) {
  throw 'GITHUB_OUTPUT is unavailable.'
}

function Set-JobOutput([string]$Name, [string]$Value) {
  "$Name=$Value" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
}

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Set-JobOutput -Name 'target_match' -Value 'false'
  Set-JobOutput -Name 'qualified' -Value 'false'
  Write-Host 'MBV1_001_AUTH_TARGET_MATCH=False'
  Write-Host 'MBV1_001_AUTH_NON_TARGET_HOLD=True'
  $hold = [math]::Max(0, [math]::Min(300, $NonTargetHoldSeconds))
  Write-Host "MBV1_001_AUTH_NON_TARGET_HOLD_SECONDS=$hold"
  if ($hold -gt 0) { Start-Sleep -Seconds $hold }
  exit 0
}

Set-JobOutput -Name 'target_match' -Value 'true'
Write-Host 'MBV1_001_AUTH_TARGET_MATCH=True'

$qualifier = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-mbv1-001-live-baseline.ps1'
if (-not (Test-Path $qualifier -PathType Leaf)) {
  throw "Missing MBV1-001 qualification wrapper: $qualifier"
}

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $qualifier -TargetComputer $TargetComputer
if ($LASTEXITCODE -ne 0) {
  throw "MBV1-001 target qualification failed with exit code $LASTEXITCODE"
}

Set-JobOutput -Name 'qualified' -Value 'true'
Write-Host 'MBV1_001_AUTH_QUALIFIED=True'
