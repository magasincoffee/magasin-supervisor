param(
  [int]$DurationMinutes = 480,
  [int]$SampleSeconds = 120,
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
if ($DurationMinutes -lt 1) { throw "DurationMinutes must be >= 1" }
if ($SampleSeconds -lt 30) { throw "SampleSeconds must be >= 30" }

. (Join-Path $PSScriptRoot "..\..\windows\state-root.ps1")
$root = Get-SupervisorStateRoot -Compatibility "legacy-preserve"
$runtime = Join-Path $root "runtime"
$lifecycle = Join-Path $runtime "windows\lifecycle-truth.ps1"
$configFile = Join-Path $root "lanes.json"
$registryFile = Join-Path $root "lane-registry.json"
$statusFile = Join-Path $root "lane-status.json"
$eventFile = Join-Path $root "lane-events.ndjson"
if (-not (Test-Path $lifecycle)) { throw "Installed lifecycle truth helper is missing" }
. $lifecycle
. (Join-Path $PSScriptRoot "supervisor-rbt009-soak-lib.ps1")

function Get-Sha256Text([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-","").ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Get-TargetFingerprint {
  if (-not (Test-Path $configFile)) { return Get-Sha256Text "NO_CONFIG" }
  $config = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $safe = @()
  foreach ($lane in @($config.lanes)) {
    $safe += [ordered]@{
      lane_id = [string]$lane.lane_id
      enabled = [bool]$lane.enabled
      brain_digest = Get-Sha256Text ([string]$lane.brain_url)
      brain_revision = [int]$lane.brain_url_revision
      work_digest = Get-Sha256Text ([string]$lane.work_url)
      work_revision = [int]$lane.work_url_revision
      work_mode = [string]$lane.work_mode
    }
  }
  return Get-Sha256Text (($safe | ConvertTo-Json -Depth 5 -Compress))
}

function Get-RegistryTargetFingerprint {
  if (-not (Test-Path $registryFile)) { return Get-Sha256Text "NO_REGISTRY" }
  $registry = Get-Content $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $safe = @()
  foreach ($name in @("lane-1","lane-2","lane-3")) {
    $lane = $registry.lanes.$name
    if ($null -eq $lane) { continue }
    $safe += [ordered]@{
      lane_id = $name
      brain_digest = Get-Sha256Text ([string]$lane.brain_url)
      brain_revision = [int]$lane.applied_brain_url_revision
      work_digest = Get-Sha256Text ([string]$lane.work_url)
      work_revision = [int]$lane.applied_work_url_revision
    }
  }
  return Get-Sha256Text (($safe | ConvertTo-Json -Depth 5 -Compress))
}

$ownerStop = Get-LifecycleOwnerStopState -Root $root
if ($ownerStop.blocked) {
  Write-Host "SOAK_OWNER_STOP_AUTHORITATIVE=True"
  Write-Host "SOAK_SKIPPED_OWNER_STOP=True"
  exit 2
}

$start = [DateTimeOffset]::UtcNow
$deadline = $start.AddMinutes($DurationMinutes)
$targetStart = Get-TargetFingerprint
$registryTargetStart = Get-RegistryTargetFingerprint
$maxPages = 0
$maxUnhealthyStreak = 0
$unhealthyStreak = 0
$sampleCount = 0
$chromeRecoveryCount = 0
$previousHealthy = $true
$eventStart = Get-Rbt009SafeEventStats -Path $eventFile
$maxEventTailBytesRead = [int]$eventStart.tail_bytes_read
$eventWindowOffset = [int64]$eventStart.file_length_bytes
$eventWindowSignature = ""
$eventWindowRun = 0
$eventWindowMaxRun = 0

while ([DateTimeOffset]::UtcNow -lt $deadline) {
  $ownerStopNow = Get-LifecycleOwnerStopState -Root $root
  if ($ownerStopNow.blocked) {
    Write-Host "SOAK_OWNER_STOP_AUTHORITATIVE=True"
    throw "Owner STOP became active during soak"
  }

  if ((Get-TargetFingerprint) -ne $targetStart) {
    Write-Host "TARGET_CHANGED_EXTERNALLY=True"
    throw "Owner-configured Brain/Work target identity or revision changed during soak; human reconciliation required"
  }

  $enabled = Get-EnabledLaneCount -Root $root
  $truth = Get-LifecycleProcessTruth -Root $root
  $healthy = if ($enabled -gt 0) {
    [bool]($truth.wrapper_alive -and $truth.three_lane_alive -and $truth.chrome_alive -and $truth.cdp_healthy)
  } else { $true }

  if (-not $healthy) {
    $unhealthyStreak++
    if ($previousHealthy) { $chromeRecoveryCount++ }
  } else {
    $unhealthyStreak = 0
  }
  $previousHealthy = $healthy
  if ($unhealthyStreak -gt $maxUnhealthyStreak) { $maxUnhealthyStreak = $unhealthyStreak }
  if (($unhealthyStreak * $SampleSeconds) -gt 300) {
    throw "Supervisor/Chrome/CDP remained unhealthy beyond bounded recovery window"
  }

  if (Test-Path $statusFile) {
    $status = Get-Content $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $pages = [int]($status.scheduler.resident_chatgpt_pages)
    if ($pages -gt $maxPages) { $maxPages = $pages }
    if ($pages -gt 3) { throw "ChatGPT page budget exceeded 3" }
  } elseif ($enabled -gt 0) {
    throw "Enabled runtime has no lane-status.json"
  }

  $eventWindow = Get-Rbt009IncrementalFloodState -Path $eventFile -StartOffset $eventWindowOffset -PreviousSignature $eventWindowSignature -PreviousRun $eventWindowRun
  if ([int]$eventWindow.bytes_read -gt $maxEventTailBytesRead) { $maxEventTailBytesRead = [int]$eventWindow.bytes_read }
  $eventWindowOffset = [int64]$eventWindow.next_offset
  $eventWindowSignature = [string]$eventWindow.last_signature
  $eventWindowRun = [int]$eventWindow.current_identical_run
  if ([int]$eventWindow.max_identical_run -gt $eventWindowMaxRun) { $eventWindowMaxRun = [int]$eventWindow.max_identical_run }
  if ($eventWindowMaxRun -ge 20) {
    throw "Repeated identical ERROR/RECOVERY event flood detected during soak window"
  }

  $sampleCount++
  Start-Sleep -Seconds $SampleSeconds
}

$end = [DateTimeOffset]::UtcNow
$durationSeconds = [math]::Floor(($end - $start).TotalSeconds)
if ($durationSeconds -lt ($DurationMinutes * 60 - $SampleSeconds)) {
  throw "Continuous soak duration was shorter than requested"
}

if ((Get-TargetFingerprint) -ne $targetStart) {
  Write-Host "TARGET_CHANGED_EXTERNALLY=True"
  throw "Owner-configured production targets changed by end of soak"
}

$registryTargetEnd = Get-RegistryTargetFingerprint
$registryTargetEvolved = ($registryTargetEnd -ne $registryTargetStart)
$eventEnd = Get-Rbt009SafeEventStats -Path $eventFile
if ([int]$eventEnd.tail_bytes_read -gt $maxEventTailBytesRead) { $maxEventTailBytesRead = [int]$eventEnd.tail_bytes_read }
$eventGrowthBytes = [int64]$eventEnd.file_length_bytes - [int64]$eventStart.file_length_bytes
$summary = [ordered]@{
  schema_version = "supervisor-rbt009-soak.v1"
  release_sha = [string]$env:GITHUB_SHA
  runtime_version = "2026-09-20.60"
  start_utc = $start.ToString("o")
  end_utc = $end.ToString("o")
  duration_seconds = $durationSeconds
  sample_count = $sampleCount
  sample_seconds = $SampleSeconds
  max_page_count = $maxPages
  max_unhealthy_streak = $maxUnhealthyStreak
  chrome_cdp_recovery_episodes = $chromeRecoveryCount
  event_file_bytes_start = [int64]$eventStart.file_length_bytes
  event_file_bytes_end = [int64]$eventEnd.file_length_bytes
  event_file_growth_bytes = [int64]$eventGrowthBytes
  event_tail_bytes_read_max = [int]$maxEventTailBytesRead
  event_window_max_identical_error_recovery_run = [int]$eventWindowMaxRun
  target_fingerprint = $targetStart
  registry_target_fingerprint_start = $registryTargetStart
  registry_target_fingerprint_end = $registryTargetEnd
  registry_target_evolved = [bool]$registryTargetEvolved
  owner_stop_observed = $false
  monitor_browser_mutations = 0
}

if (-not $OutputPath) {
  $OutputPath = Join-Path $env:RUNNER_TEMP "rbt009-soak-summary.json"
}
$summary | ConvertTo-Json -Depth 5 | Set-Content -Path $OutputPath -Encoding UTF8

Write-Host "SOAK_CONTINUOUS_DURATION_8H=$([bool]($DurationMinutes -ge 480))"
Write-Host "SOAK_PAGE_BUDGET_MAX_3=True"
Write-Host "SOAK_OWNER_STOP_AUTHORITATIVE=True"
Write-Host "SOAK_CHROME_CDP_HEALTH=True"
Write-Host "SOAK_PRODUCTION_TARGETS_UNCHANGED=True"
Write-Host "SOAK_MONITOR_ZERO_BROWSER_MUTATION=True"
Write-Host "SOAK_TIMELINE_PRIVACY_SAFE=True"
Write-Host "SOAK_SAMPLE_COUNT=$sampleCount"
Write-Host "SOAK_DURATION_SECONDS=$durationSeconds"
Write-Host "SOAK_MAX_PAGE_COUNT=$maxPages"
Write-Host "SOAK_CHROME_CDP_RECOVERY_EPISODES=$chromeRecoveryCount"
