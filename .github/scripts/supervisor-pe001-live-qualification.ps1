param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Write-Host "PE001_QUAL_MACHINE=$env:COMPUTERNAME"
if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Host 'PE001_QUAL_TARGET_MATCH=False'
  Write-Host 'PE001_QUAL_SKIP_SAFE=True'
  exit 0
}
Write-Host 'PE001_QUAL_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'platform-default'
if (-not [string]::IsNullOrWhiteSpace([string]$env:SUPERVISOR_STATE_ROOT)) {
  $root = [System.IO.Path]::GetFullPath([string]$env:SUPERVISOR_STATE_ROOT)
}
$root = Set-SupervisorStateRootBinding -Root $root

Write-Host "PE001_QUAL_STATE_ROOT=$root"
Write-Host "PE001_QUAL_REVISION=$env:GITHUB_SHA"

$cdp = $false
try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3
  $cdp = ($response.StatusCode -eq 200)
} catch {}
Write-Host "PE001_QUAL_CDP_HEALTHY=$cdp"
if (-not $cdp) {
  throw 'Dedicated Supervisor Chrome CDP endpoint is not healthy.'
}

$script = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-pe001-live-qualification.mjs'
if (-not (Test-Path $script -PathType Leaf)) {
  throw "Missing qualification script: $script"
}

& node $script $root $env:GITHUB_SHA
if ($LASTEXITCODE -ne 0) {
  throw "PE-001 live qualification failed with exit code $LASTEXITCODE"
}
