param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Write-Host "REPAIR_MACHINE=$env:COMPUTERNAME"
if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Host 'TARGET_MATCH=False'
  Write-Host 'TARGET_SKIP_SAFE=True'
  exit 0
}
Write-Host 'TARGET_MATCH=True'

. (Join-Path $PSScriptRoot '..\..\windows\state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'platform-default'
if (-not [string]::IsNullOrWhiteSpace([string]$env:SUPERVISOR_STATE_ROOT)) {
  $root = [System.IO.Path]::GetFullPath([string]$env:SUPERVISOR_STATE_ROOT)
}
$root = Set-SupervisorStateRootBinding -Root $root

$configPath = Join-Path $root 'lanes.json'
if (-not (Test-Path $configPath)) {
  throw "lanes.json missing at $configPath"
}

$wrong = 'https://chatgpt.com/c/6ab7ea33-19e8-83ec-a0ec-897baa23ea17'
$correct = 'https://chatgpt.com/c/6ab7e469-5afc-83ec-9eb4-5ec647f267f4'

$config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$lane = @($config.lanes | Where-Object { [string]$_.lane_id -eq 'lane-1' }) | Select-Object -First 1
if (-not $lane) { throw 'lane-1 missing from lanes.json' }

$current = [string]$lane.brain_url
$revision = [int]$lane.brain_url_revision
Write-Host "CURRENT_BRAIN_URL=$current"
Write-Host "CURRENT_BRAIN_REVISION=$revision"

if ($current -eq $correct) {
  Write-Host 'BRAIN_TARGET_ALREADY_CORRECT=True'
  Write-Host 'PROJECT_STATE_PRESERVED=True'
  exit 0
}

if ($current -ne $wrong) {
  Write-Host 'BRAIN_TARGET_REPAIR_SKIPPED_UNEXPECTED_CURRENT=True'
  Write-Host 'PROJECT_STATE_PRESERVED=True'
  exit 0
}

$beforeOtherLanes = @($config.lanes | Where-Object { [string]$_.lane_id -ne 'lane-1' } | ForEach-Object {
  "$([string]$_.lane_id)|$([string]$_.brain_url)|$([int]$_.brain_url_revision)|$([string]$_.work_url)|$([int]$_.work_url_revision)"
}) -join [Environment]::NewLine

$lane.brain_url = $correct
$lane.brain_url_revision = $revision + 1

$temp = "$configPath.tmp"
$json = $config | ConvertTo-Json -Depth 30
[System.IO.File]::WriteAllText(
  $temp,
  $json + [Environment]::NewLine,
  (New-Object System.Text.UTF8Encoding($false))
)
Move-Item -Path $temp -Destination $configPath -Force

$verify = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$verifyLane = @($verify.lanes | Where-Object { [string]$_.lane_id -eq 'lane-1' }) | Select-Object -First 1
if (-not $verifyLane) { throw 'lane-1 missing after repair' }
if ([string]$verifyLane.brain_url -ne $correct) {
  throw 'lane-1 Brain URL verification failed'
}
if ([int]$verifyLane.brain_url_revision -ne ($revision + 1)) {
  throw 'lane-1 Brain revision verification failed'
}

$afterOtherLanes = @($verify.lanes | Where-Object { [string]$_.lane_id -ne 'lane-1' } | ForEach-Object {
  "$([string]$_.lane_id)|$([string]$_.brain_url)|$([int]$_.brain_url_revision)|$([string]$_.work_url)|$([int]$_.work_url_revision)"
}) -join [Environment]::NewLine
if ($beforeOtherLanes -ne $afterOtherLanes) {
  throw 'another lane target changed during lane-1 Brain repair'
}

Write-Host "NEW_BRAIN_URL=$([string]$verifyLane.brain_url)"
Write-Host "NEW_BRAIN_REVISION=$([int]$verifyLane.brain_url_revision)"
Write-Host 'BRAIN_TARGET_REPAIR_APPLIED=True'
Write-Host 'OTHER_LANE_TARGETS_UNCHANGED=True'
Write-Host 'PROJECT_STATE_PRESERVED=True'
