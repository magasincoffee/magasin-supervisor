$ErrorActionPreference = "Stop"

function Write-JsonFile([string]$Path, $Value) {
  $dir = Split-Path $Path -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Read-JsonSafe([string]$Path) {
  try {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $null
  }
}

$tempBase = Join-Path $env:RUNNER_TEMP "magasin-p4-live-isolated"
$root = Join-Path $tempBase "state"
$runtime = Join-Path $root "runtime"
$runtimeWindows = Join-Path $runtime "windows"
$runtimeSource = Join-Path $runtime "src\runtime"
$profile = Join-Path $root "browser_profile"
$bootFile = Join-Path $tempBase "fake-node-boots.txt"
$stopFile = Join-Path $root "STOP"
$wrapperLog = Join-Path $root "wrapper.log"
$lanesFile = Join-Path $root "lanes.json"
$registryFile = Join-Path $root "lane-registry.json"
$statusFile = Join-Path $root "lane-status.json"
$runScript = Join-Path $runtimeWindows "run-supervisor.ps1"
$panelScript = Join-Path $runtimeWindows "control-panel.ps1"

Remove-Item $tempBase -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $runtimeWindows,$runtimeSource,$profile | Out-Null

foreach ($name in @(
  "state-root.ps1",
  "lifecycle-truth.ps1",
  "run-supervisor.ps1",
  "control-panel-observability.ps1",
  "control-panel.ps1"
)) {
  Copy-Item -LiteralPath (Join-Path $env:GITHUB_WORKSPACE ("windows\" + $name)) -Destination (Join-Path $runtimeWindows $name) -Force
}

$fakeNode = @'
import fs from "node:fs";
const marker = String(process.env.P4_FAKE_BOOT_FILE || "");
if (marker) fs.appendFileSync(marker, new Date().toISOString() + "\n", "utf8");
setInterval(() => {}, 1000);
'@
Set-Content -LiteralPath (Join-Path $runtimeSource "three-lane-cli.mjs") -Value $fakeNode -Encoding UTF8

$sentinelBrain = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111"
$sentinelWork = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222"

$config = [pscustomobject]@{
  schema_version = "three-lane-config.v1"
  mode = "THREE_LANE_V1"
  lanes = @(
    [pscustomobject]@{
      lane_id = "lane-1"
      project_name = "P4 Live Acceptance"
      brain_url = $sentinelBrain
      brain_url_revision = 1
      work_url = $sentinelWork
      work_url_revision = 1
      work_url_saved_at = "2026-09-25T00:00:00.000Z"
      work_mode = "OWNER"
      work_state_reset_revision = 0
      relay_retry_rearm_revision = 0
      relay_retry_rearm_requested_at = $null
      enabled = $true
    },
    [pscustomobject]@{ lane_id="lane-2"; project_name="Unused"; brain_url=""; brain_url_revision=0; work_url=""; work_url_revision=0; work_url_saved_at=$null; work_mode="AUTO"; work_state_reset_revision=0; relay_retry_rearm_revision=0; relay_retry_rearm_requested_at=$null; enabled=$false },
    [pscustomobject]@{ lane_id="lane-3"; project_name="Unused"; brain_url=""; brain_url_revision=0; work_url=""; work_url_revision=0; work_url_saved_at=$null; work_mode="AUTO"; work_state_reset_revision=0; relay_retry_rearm_revision=0; relay_retry_rearm_requested_at=$null; enabled=$false }
  )
}
$registry = [pscustomobject]@{
  schema_version = "three-lane-registry.v1"
  lanes = [pscustomobject]@{
    "lane-1" = [pscustomobject]@{
      brain_url = $sentinelBrain
      work_url = $sentinelWork
      task_id = "P4-LIVE-SENTINEL"
      work_generation = 7
    }
  }
}
$status = [pscustomobject]@{
  schema_version = "three-lane-status.v1"
  mode = "THREE_LANE_V1"
  supervisor_runtime_version = "P4-LIVE-FIXTURE"
  updated_at = "2000-01-01T00:00:00.000Z"
  scheduler = [pscustomobject]@{
    resident_chatgpt_pages = 0
    page_budget = 3
    mutation_lease_active = $false
    lease_states = [pscustomobject]@{
      ACTIVE_MUTATION = 0
      ACTIVE_OBSERVATION = 0
      PARKED = 0
      EVICTABLE = 0
      CLOSED = 0
    }
  }
  lanes = @(
    [pscustomobject]@{
      lane_id = "lane-1"
      status = "WORKING"
      message = "STALE SNAPSHOT MUST NOT RENDER AS LIVE"
      brain_url = $sentinelBrain
      work_url = $sentinelWork
    }
  )
}

Write-JsonFile $lanesFile $config
Write-JsonFile $registryFile $registry
Write-JsonFile $statusFile $status

$configHashBefore = (Get-FileHash -LiteralPath $lanesFile -Algorithm SHA256).Hash
$registryHashBefore = (Get-FileHash -LiteralPath $registryFile -Algorithm SHA256).Hash

$oldRoot = [string]$env:SUPERVISOR_STATE_ROOT
$oldMutex = [string]$env:SUPERVISOR_MUTEX_NAME
$oldStale = [string]$env:SUPERVISOR_STATUS_STALE_SECONDS
$oldBoot = [string]$env:P4_FAKE_BOOT_FILE
$wrapper = $null

try {
  $env:SUPERVISOR_STATE_ROOT = $root
  $env:SUPERVISOR_MUTEX_NAME = "Local\MAGASIN_BUSINESS_OS_SUPERVISOR_P4_LIVE"
  $env:SUPERVISOR_STATUS_STALE_SECONDS = "5"
  $env:P4_FAKE_BOOT_FILE = $bootFile
  $env:RUNNER_TRACKING_ID = "MAGASIN_P4_LIVE_ISOLATED"

  $wrapper = Start-Process -FilePath "powershell.exe" -PassThru -WindowStyle Hidden -ArgumentList @(
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy","Bypass",
    "-File",('"' + $runScript + '"'),
    "-DryRun"
  )

  . (Join-Path $runtimeWindows "lifecycle-truth.ps1")

  $componentsReady = $false
  for ($i=0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $truth = Get-LifecycleProcessTruth -Root $root
    if (
      $truth.wrapper_alive -and
      $truth.three_lane_alive -and
      $truth.chrome_alive -and
      $truth.cdp_healthy
    ) {
      $componentsReady = $true
      break
    }
  }
  if (-not $componentsReady) { throw "P4_LIVE_COMPONENTS_NOT_READY" }
  Write-Host "LIVE_P4_WRAPPER_ALIVE=True"
  Write-Host "LIVE_P4_THREE_LANE_ALIVE=True"
  Write-Host "LIVE_P4_CHROME_ALIVE=True"
  Write-Host "LIVE_P4_CDP_HEALTHY=True"

  $probeLines = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $panelScript -ObservabilityProbe
  $probeJson = @($probeLines | Where-Object { [string]$_ -match '^\{' } | Select-Object -Last 1)
  if (-not $probeJson) { throw "P4_LIVE_CONTROL_PANEL_PROBE_MISSING" }
  $probe = ([string]$probeJson) | ConvertFrom-Json

  if (-not [bool]$probe.status_stale) { throw "P4_LIVE_CONTROL_PANEL_DID_NOT_REPORT_STATUS_STALE" }
  if ([string]$probe.runtime_state -ne "STATUS_STALE") { throw "P4_LIVE_CONTROL_PANEL_RUNTIME_STATE_WRONG" }
  if ([string]$probe.page_summary -eq "0 / 3") { throw "P4_LIVE_STALE_SCHEDULER_LEAKED" }
  Write-Host "LIVE_P4_CONTROL_PANEL_STATUS_STALE=PASS"
  Write-Host "LIVE_P4_STALE_SNAPSHOT_SUPPRESSED=PASS"

  $restarted = $false
  for ($i=0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $boots = if (Test-Path $bootFile) { @(Get-Content -LiteralPath $bootFile -ErrorAction SilentlyContinue).Count } else { 0 }
    $logText = if (Test-Path $wrapperLog) { Get-Content -LiteralPath $wrapperLog -Raw -Encoding UTF8 } else { "" }
    if ($boots -ge 2 -and $logText -match "THREE_LANE_STATUS_STALE_RESTART") {
      $restarted = $true
      break
    }
  }
  if (-not $restarted) { throw "P4_LIVE_STALE_NODE_NOT_RELAUNCHED" }
  Write-Host "LIVE_P4_WRAPPER_STALE_RESTART=PASS"
  Write-Host "LIVE_P4_NODE_RELAUNCHED=True"

  $configHashAfter = (Get-FileHash -LiteralPath $lanesFile -Algorithm SHA256).Hash
  $registryHashAfter = (Get-FileHash -LiteralPath $registryFile -Algorithm SHA256).Hash
  if ($configHashBefore -ne $configHashAfter) { throw "P4_LIVE_CONFIG_MUTATED" }
  if ($registryHashBefore -ne $registryHashAfter) { throw "P4_LIVE_REGISTRY_MUTATED" }

  $configAfter = Read-JsonSafe $lanesFile
  $registryAfter = Read-JsonSafe $registryFile
  $laneAfter = @($configAfter.lanes | Where-Object { $_.lane_id -eq "lane-1" }) | Select-Object -First 1
  $registryLaneAfter = $registryAfter.lanes."lane-1"
  if (
    [string]$laneAfter.brain_url -ne $sentinelBrain -or
    [string]$laneAfter.work_url -ne $sentinelWork -or
    [string]$registryLaneAfter.brain_url -ne $sentinelBrain -or
    [string]$registryLaneAfter.work_url -ne $sentinelWork
  ) {
    throw "P4_LIVE_TARGET_URL_MUTATED"
  }

  Write-Host "LIVE_P4_CONFIG_UNCHANGED=True"
  Write-Host "LIVE_P4_REGISTRY_UNCHANGED=True"
  Write-Host "LIVE_P4_BRAIN_WORK_TARGETS_UNCHANGED=True"
  Write-Host "LIVE_P4_ACCEPTANCE=PASS"
}
finally {
  New-Item -ItemType File -Force -Path $stopFile -ErrorAction SilentlyContinue | Out-Null

  if ($wrapper -and -not $wrapper.HasExited) {
    for ($i=0; $i -lt 20 -and -not $wrapper.HasExited; $i++) {
      Start-Sleep -Milliseconds 500
      $wrapper.Refresh()
    }
    if (-not $wrapper.HasExited) {
      Stop-Process -Id $wrapper.Id -Force -ErrorAction SilentlyContinue
    }
  }

  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$runtime*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  $env:SUPERVISOR_STATE_ROOT = $oldRoot
  $env:SUPERVISOR_MUTEX_NAME = $oldMutex
  $env:SUPERVISOR_STATUS_STALE_SECONDS = $oldStale
  $env:P4_FAKE_BOOT_FILE = $oldBoot

  Remove-Item $tempBase -Recurse -Force -ErrorAction SilentlyContinue
}
