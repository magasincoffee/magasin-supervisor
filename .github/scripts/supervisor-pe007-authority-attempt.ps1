param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13',
  [int]$Attempt = 1,
  [int]$NonTargetHoldSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Write-Host "PE007_AUTH_ATTEMPT=$Attempt"
Write-Host "PE007_AUTH_MACHINE=$env:COMPUTERNAME"

if ([string]::IsNullOrWhiteSpace([string]$env:GITHUB_OUTPUT)) {
  throw 'GITHUB_OUTPUT is unavailable.'
}

function Set-JobOutput([string]$Name, [string]$Value) {
  "$Name=$Value" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
}

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Set-JobOutput -Name 'target_match' -Value 'false'
  Set-JobOutput -Name 'qualified' -Value 'false'
  Write-Host 'PE007_AUTH_TARGET_MATCH=False'
  Write-Host 'PE007_AUTH_NON_TARGET_HOLD=True'
  $hold = [math]::Max(0, [math]::Min(300, $NonTargetHoldSeconds))
  Write-Host "PE007_AUTH_NON_TARGET_HOLD_SECONDS=$hold"
  if ($hold -gt 0) { Start-Sleep -Seconds $hold }
  exit 0
}

Set-JobOutput -Name 'target_match' -Value 'true'
Write-Host 'PE007_AUTH_TARGET_MATCH=True'

$qualifier = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-pe007-live-qualification.ps1'
if (-not (Test-Path $qualifier -PathType Leaf)) {
  throw "Missing target qualification wrapper: $qualifier"
}

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $qualifier -TargetComputer $TargetComputer -NonTargetHoldSeconds 0
if ($LASTEXITCODE -ne 0) {
  throw "Target qualification failed with exit code $LASTEXITCODE"
}

Set-JobOutput -Name 'qualified' -Value 'true'
Write-Host 'PE007_AUTH_QUALIFIED=True'
