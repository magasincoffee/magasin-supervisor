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
  } catch { return $null }
}

$tempBase = Join-Path $env:RUNNER_TEMP "magasin-p5-live-isolated"
$root = Join-Path $tempBase "state"
$runtime = Join-Path $root "runtime"
$runtimeWindows = Join-Path $runtime "windows"
$runtimeSource = Join-Path $runtime "src\runtime"
$profile = Join-Path $root "browser_profile"
$stopFile = Join-Path $root "STOP"
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
  $source = Join-Path $env:GITHUB_WORKSPACE ("windows\" + $name)
  $target = Join-Path $runtimeWindows $name
  Copy-Item -LiteralPath $source -Destination $target -Force
  $text = [IO.File]::ReadAllText($target, [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText($target, $text, (New-Object Text.UTF8Encoding($true)))
}

$fakeNode = @'
setInterval(() => {}, 1000);
'@
Set-Content -LiteralPath (Join-Path $runtimeSource "three-lane-cli.mjs") -Value $fakeNode -Encoding UTF8

$brainUrl = "https://chatgpt.com/c/33333333-3333-4333-8333-333333333333"
$workUrl = "https://chatgpt.com/c/44444444-4444-4444-8444-444444444444"
$now = [DateTimeOffset]::UtcNow.ToString("o")

$config = [pscustomobject]@{
  schema_version = "three-lane-config.v1"
  mode = "THREE_LANE_V1"
  lanes = @(
    [pscustomobject]@{
      lane_id = "lane-1"
      project_name = "P5 Live Acceptance"
      brain_url = $brainUrl
      brain_url_revision = 1
      work_url = $workUrl
      work_url_revision = 4
      work_url_saved_at = $now
      work_mode = "OWNER"
      work_state_reset_revision = 9
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
  mode = "THREE_LANE_V1"
  lanes = [pscustomobject]@{
    "lane-1" = [pscustomobject]@{
      brain_url = $brainUrl
      work_url = $workUrl
      task_id = "P5-LIVE-TASK"
      work_generation = 7
      applied_work_mode = "OWNER"
      applied_work_url_revision = 4
      applied_work_state_reset_revision = 8
      brain_directive_adopted = $null
      brain_target_health = [pscustomobject]@{ state="HEALTHY"; reason_code="NONE" }
      work_target_health = [pscustomobject]@{ state="QUARANTINED"; reason_code="CONVERSATION_MISSING" }
    }
  }
}

$status = [pscustomobject]@{
  schema_version = "three-lane-status.v1"
  mode = "THREE_LANE_V1"
  supervisor_runtime_version = "P5-LIVE-FIXTURE"
  updated_at = $now
  scheduler = [pscustomobject]@{
    resident_chatgpt_pages = 2
    page_budget = 3
    mutation_lease_active = $false
    lease_states = [pscustomobject]@{
      ACTIVE_MUTATION = 0
      ACTIVE_OBSERVATION = 2
      PARKED = 0
      EVICTABLE = 0
      CLOSED = 0
    }
  }
  lanes = @(
    [pscustomobject]@{
      lane_id = "lane-1"
      status = "WAITING_BRAIN"
      phase = "WAITING_BRAIN"
      task_id = "P5-LIVE-TASK"
      brain_directive_state = "INVALID"
      brain_directive_reason_code = "MISSING_DIRECTIVE_BLOCK"
      brain_target_health = [pscustomobject]@{ state="HEALTHY"; reason_code="NONE" }
      work_target_health = [pscustomobject]@{ state="QUARANTINED"; reason_code="CONVERSATION_MISSING" }
      work_mode = "OWNER"
      work_reset_requested_revision = 9
      work_reset_applied_revision = 8
      work_generation = 7
    }
  )
}

Write-JsonFile $lanesFile $config
Write-JsonFile $registryFile $registry
Write-JsonFile $statusFile $status

$configHashBefore = (Get-FileHash -LiteralPath $lanesFile -Algorithm SHA256).Hash
$registryHashBefore = (Get-FileHash -LiteralPath $registryFile -Algorithm SHA256).Hash
$statusHashBefore = (Get-FileHash -LiteralPath $statusFile -Algorithm SHA256).Hash

$oldRoot = [string]$env:SUPERVISOR_STATE_ROOT
$oldMutex = [string]$env:SUPERVISOR_MUTEX_NAME
$wrapper = $null

try {
  $env:SUPERVISOR_STATE_ROOT = $root
  $env:SUPERVISOR_MUTEX_NAME = "Local\MAGASIN_BUSINESS_OS_SUPERVISOR_P5_LIVE"
  $env:RUNNER_TRACKING_ID = "MAGASIN_P5_LIVE_ISOLATED"

  $wrapper = Start-Process -FilePath "powershell.exe" -PassThru -WindowStyle Hidden -ArgumentList @(
    "-NoLogo","-NoProfile","-ExecutionPolicy","Bypass",
    "-File",('"' + $runScript + '"'),"-DryRun"
  )

  . (Join-Path $runtimeWindows "lifecycle-truth.ps1")

  $ready = $false
  for ($i=0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $truth = Get-LifecycleProcessTruth -Root $root
    if ($truth.wrapper_alive -and $truth.three_lane_alive -and $truth.chrome_alive -and $truth.cdp_healthy -and -not $truth.status_stale) {
      $ready = $true
      break
    }
  }
  if (-not $ready) { throw "P5_LIVE_PROCESS_TRUTH_NOT_READY" }

  Write-Host "LIVE_P5_WRAPPER=PASS"
  Write-Host "LIVE_P5_THREE_LANE_NODE=PASS"
  Write-Host "LIVE_P5_CHROME=PASS"
  Write-Host "LIVE_P5_CDP=PASS"

  $probeLines = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $panelScript -ObservabilityProbe
  $probeJson = @($probeLines | Where-Object { [string]$_ -match '^\{' } | Select-Object -Last 1)
  if (-not $probeJson) { throw "P5_LIVE_OBSERVABILITY_PROBE_MISSING" }
  $probe = ([string]$probeJson) | ConvertFrom-Json

  if ([bool]$probe.status_stale) { throw "P5_LIVE_STATUS_UNEXPECTEDLY_STALE" }
  if ($null -eq $probe.status_age_seconds) { throw "P5_LIVE_STATUS_AGE_MISSING" }
  if ([int]$probe.chatgpt_page_count -ne 2) { throw "P5_LIVE_PAGE_COUNT_WRONG" }

  $lane = @($probe.lanes | Where-Object { $_.lane_id -eq "lane-1" }) | Select-Object -First 1
  if (-not $lane) { throw "P5_LIVE_LANE1_OBSERVABILITY_MISSING" }

  $checks = [ordered]@{
    BRAIN_HEALTH = ([string]$lane.brain_health -eq "HEALTHY")
    BRAIN_DIRECTIVE_INVALID = ([string]$lane.brain_directive -eq "INVALID")
    BRAIN_DIRECTIVE_REASON = ([string]$lane.brain_directive_reason_code -eq "MISSING_DIRECTIVE_BLOCK")
    ACTIVE_TASK = ([string]$lane.active_task -eq "P5-LIVE-TASK")
    WORK_TARGET_MODE = ([string]$lane.work_target_mode -eq "OWNER")
    WORK_TARGET_HEALTH = ([string]$lane.work_target_health -eq "QUARANTINED")
    WORK_RESET_REQUESTED = ([int]$lane.work_reset_requested_revision -eq 9)
    WORK_RESET_APPLIED = ([int]$lane.work_reset_applied_revision -eq 8)
    WORK_GENERATION = ([int]$lane.work_generation -eq 7)
  }
  foreach ($entry in $checks.GetEnumerator()) {
    Write-Host ("LIVE_P5_" + $entry.Key + "=" + $(if ($entry.Value) { "PASS" } else { "FAIL" }))
    if (-not $entry.Value) { throw ("P5_LIVE_" + $entry.Key + "_MISMATCH") }
  }

  $probeText = $probe | ConvertTo-Json -Depth 20 -Compress
  foreach ($forbidden in @(
    $brainUrl,
    $workUrl,
    "target_digest",
    "directive_digest",
    "instruction_digest",
    "message_body",
    "cookie",
    "token",
    "screenshot"
  )) {
    if ($probeText -match [regex]::Escape($forbidden)) {
      throw "P5_LIVE_SANITIZATION_FAILED"
    }
  }
  Write-Host "LIVE_P5_SANITIZED_PROBE=PASS"

  $configHashAfter = (Get-FileHash -LiteralPath $lanesFile -Algorithm SHA256).Hash
  $registryHashAfter = (Get-FileHash -LiteralPath $registryFile -Algorithm SHA256).Hash
  $statusHashAfter = (Get-FileHash -LiteralPath $statusFile -Algorithm SHA256).Hash
  if ($configHashBefore -ne $configHashAfter) { throw "P5_LIVE_CONFIG_MUTATED" }
  if ($registryHashBefore -ne $registryHashAfter) { throw "P5_LIVE_REGISTRY_MUTATED" }
  if ($statusHashBefore -ne $statusHashAfter) { throw "P5_LIVE_STATUS_MUTATED" }

  Write-Host "LIVE_P5_READ_ONLY=PASS"
  Write-Host "LIVE_P5_ACCEPTANCE=PASS"
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
  Remove-Item $tempBase -Recurse -Force -ErrorAction SilentlyContinue
}
