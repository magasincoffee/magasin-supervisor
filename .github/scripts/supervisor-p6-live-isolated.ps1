$ErrorActionPreference = "Stop"

function Write-JsonFile([string]$Path, $Value) {
  $dir = Split-Path $Path -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $Value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Read-JsonSafe([string]$Path) {
  try {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch { return $null }
}

function Get-Optional($Object, [string]$Name, $Default = $null) {
  if ($null -eq $Object) { return $Default }
  $p = $Object.PSObject.Properties[$Name]
  if ($null -eq $p) { return $Default }
  return $p.Value
}

$tempBase = Join-Path $env:RUNNER_TEMP "magasin-p6-live-isolated"
$root = Join-Path $tempBase "state"
$runtime = Join-Path $root "runtime"
$runtimeWindows = Join-Path $runtime "windows"
$profile = Join-Path $root "browser_profile"
$stopFile = Join-Path $root "STOP"
$configFile = Join-Path $root "lanes.json"
$registryFile = Join-Path $root "lane-registry.json"
$logFile = Join-Path $root "supervisor.log"
$runScript = Join-Path $runtimeWindows "run-supervisor.ps1"

Remove-Item $tempBase -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $runtimeWindows,$profile | Out-Null
Copy-Item -LiteralPath (Join-Path $env:GITHUB_WORKSPACE "src") -Destination (Join-Path $runtime "src") -Recurse -Force

foreach ($name in @("state-root.ps1","lifecycle-truth.ps1","run-supervisor.ps1")) {
  $source = Join-Path $env:GITHUB_WORKSPACE ("windows\" + $name)
  $target = Join-Path $runtimeWindows $name
  Copy-Item -LiteralPath $source -Destination $target -Force
  $text = [IO.File]::ReadAllText($target, [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText($target, $text, (New-Object Text.UTF8Encoding($true)))
}

$workspaceNodeModules = Join-Path $env:GITHUB_WORKSPACE "node_modules"
if (-not (Test-Path $workspaceNodeModules)) {
  throw "P6_LIVE_NODE_MODULES_MISSING"
}
New-Item -ItemType Junction -Path (Join-Path $runtime "node_modules") -Target $workspaceNodeModules | Out-Null

. (Join-Path $env:GITHUB_WORKSPACE "windows\state-root.ps1")
$productionRoot = Get-SupervisorStateRoot -Compatibility "legacy-preserve"
$productionConfig = Join-Path $productionRoot "lanes.json"
$productionRegistry = Join-Path $productionRoot "lane-registry.json"
$prodConfigHashBefore = if (Test-Path $productionConfig) { (Get-FileHash $productionConfig -Algorithm SHA256).Hash } else { "" }
$prodRegistryHashBefore = if (Test-Path $productionRegistry) { (Get-FileHash $productionRegistry -Algorithm SHA256).Hash } else { "" }

$now = [DateTimeOffset]::UtcNow.ToString("o")
$brain1 = "https://chatgpt.com/c/55555555-5555-4555-8555-555555555555"
$work1 = "https://chatgpt.com/c/66666666-6666-4666-8666-666666666666"
$brain2 = "https://chatgpt.com/c/77777777-7777-4777-8777-777777777777"
$work2 = "https://chatgpt.com/c/88888888-8888-4888-8888-888888888888"
$brain3 = "https://chatgpt.com/c/99999999-9999-4999-8999-999999999999"
$work3 = "https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

$config = [pscustomobject]@{
  schema_version = "three-lane-config.v1"
  mode = "THREE_LANE_V1"
  lanes = @(
    [pscustomobject]@{
      lane_id="lane-1"; project_name="P6 Live Reset"; brain_url=$brain1; brain_url_revision=1
      work_url=$work1; work_url_revision=4; work_url_saved_at=$now; work_mode="OWNER"
      work_state_reset_revision=9; relay_retry_rearm_revision=0; relay_retry_rearm_requested_at=$null; enabled=$true
    },
    [pscustomobject]@{
      lane_id="lane-2"; project_name="P6 Lane 2 Sentinel"; brain_url=$brain2; brain_url_revision=2
      work_url=$work2; work_url_revision=5; work_url_saved_at=$now; work_mode="OWNER"
      work_state_reset_revision=2; relay_retry_rearm_revision=0; relay_retry_rearm_requested_at=$null; enabled=$false
    },
    [pscustomobject]@{
      lane_id="lane-3"; project_name="P6 Lane 3 Sentinel"; brain_url=$brain3; brain_url_revision=3
      work_url=$work3; work_url_revision=6; work_url_saved_at=$now; work_mode="OWNER"
      work_state_reset_revision=3; relay_retry_rearm_revision=0; relay_retry_rearm_requested_at=$null; enabled=$false
    }
  )
}

$registry = [pscustomobject]@{
  schema_version = "three-lane-registry.v1"
  mode = "THREE_LANE_V1"
  lanes = [pscustomobject]@{
    "lane-1" = [pscustomobject]@{
      lane_id="lane-1"
      brain_url=$brain1
      applied_brain_url_revision=1
      work_url=$work1
      work_generation=7
      applied_work_mode="OWNER"
      applied_work_saved_at=$now
      applied_work_state_reset_revision=8
      task_id="P6-OLD-TASK"
      instruction_digest=("a" * 64)
      last_brain_directive_digest=("b" * 64)
      last_work_result_digest=("c" * 64)
      last_result_relay_id=("d" * 32)
      last_result_verdict=[pscustomobject]@{
        task_id="P6-OLD-TASK"; relay_id=("d" * 32); verdict="REJECT"
        reason_code="REJECT_CORRECTION_REQUIRED"; recorded_at=$now
      }
      last_dispatch_id=("e" * 32)
      dispatch_inflight=[pscustomobject]@{
        dispatch_id=("e" * 32); task_id="P6-OLD-TASK"; instruction_digest=("a" * 64)
      }
      relay_inflight=[pscustomobject]@{
        relay_id=("d" * 32); screenshot_path=""; task_id="P6-OLD-TASK"
      }
      brain_request_inflight=[pscustomobject]@{ requested_at=$now }
      brain_request_sent=$true
      brain_directive_adopted=[pscustomobject]@{
        directive_digest=("b" * 64); action="WORK"; task_id="P6-OLD-TASK"
        instruction_digest=("a" * 64); brain_url_revision=1; adopted_at=$now
      }
      awaiting_work=$true
      pending_work_url="https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      pending_work_url_revision=5
      pending_work_saved_at=$now
      pending_work_mode="OWNER"
      applied_work_url_revision=4
    }
    "lane-2" = [pscustomobject]@{
      lane_id="lane-2"; brain_url=$brain2; applied_brain_url_revision=2
      work_url=$work2; work_generation=3; applied_work_mode="OWNER"
      applied_work_state_reset_revision=2; task_id="P6-LANE2-SENTINEL"
      applied_work_url_revision=5
    }
    "lane-3" = [pscustomobject]@{
      lane_id="lane-3"; brain_url=$brain3; applied_brain_url_revision=3
      work_url=$work3; work_generation=4; applied_work_mode="OWNER"
      applied_work_state_reset_revision=3; task_id="P6-LANE3-SENTINEL"
      applied_work_url_revision=6
    }
  }
}

Write-JsonFile $configFile $config
Write-JsonFile $registryFile $registry
$configHashBefore = (Get-FileHash -LiteralPath $configFile -Algorithm SHA256).Hash

$oldRoot = [string]$env:SUPERVISOR_STATE_ROOT
$oldMutex = [string]$env:SUPERVISOR_MUTEX_NAME
$wrapper = $null

try {
  $env:SUPERVISOR_STATE_ROOT = $root
  $env:SUPERVISOR_MUTEX_NAME = "Local\MAGASIN_BUSINESS_OS_SUPERVISOR_P6_LIVE"
  $env:RUNNER_TRACKING_ID = "MAGASIN_P6_LIVE_ISOLATED"

  $wrapper = Start-Process -FilePath "powershell.exe" -PassThru -WindowStyle Hidden -ArgumentList @(
    "-NoLogo","-NoProfile","-ExecutionPolicy","Bypass",
    "-File",('"' + $runScript + '"'),"-DryRun"
  )

  $applied = $false
  $after = $null
  for ($i=0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 500
    $after = Read-JsonSafe $registryFile
    $lane = if ($after -and $after.lanes) { Get-Optional $after.lanes "lane-1" } else { $null }
    if (
      $lane -and
      [int](Get-Optional $lane "applied_work_state_reset_revision" 0) -eq 9 -and
      [int](Get-Optional $lane "work_generation" 0) -eq 8
    ) {
      $applied = $true
      break
    }
  }
  if (-not $applied) { throw "P6_LIVE_RESET_NOT_APPLIED" }

  $lane1 = Get-Optional $after.lanes "lane-1"
  $lane2 = Get-Optional $after.lanes "lane-2"
  $lane3 = Get-Optional $after.lanes "lane-3"

  foreach ($pair in @(
    @("task_id", $null),
    @("instruction_digest", $null),
    @("last_brain_directive_digest", $null),
    @("last_work_result_digest", $null),
    @("last_result_relay_id", $null),
    @("last_result_verdict", $null),
    @("last_dispatch_id", $null),
    @("dispatch_inflight", $null),
    @("relay_inflight", $null),
    @("brain_request_inflight", $null),
    @("brain_directive_adopted", $null)
  )) {
    $actual = Get-Optional $lane1 ([string]$pair[0]) "__MISSING__"
    if ($null -ne $pair[1] -or $null -ne $actual) {
      throw ("P6_LIVE_FIELD_NOT_CLEARED_" + [string]$pair[0])
    }
  }

  if ([bool](Get-Optional $lane1 "brain_request_sent" $true)) { throw "P6_LIVE_BRAIN_REQUEST_SENT_NOT_RESET" }
  if ([bool](Get-Optional $lane1 "awaiting_work" $true)) { throw "P6_LIVE_AWAITING_WORK_NOT_RESET" }
  if ([string](Get-Optional $lane1 "pending_work_url" "x") -ne "") { throw "P6_LIVE_PENDING_WORK_NOT_CLEARED" }
  if ([int](Get-Optional $lane1 "pending_work_url_revision" -1) -ne 0) { throw "P6_LIVE_PENDING_REVISION_NOT_CLEARED" }

  if ([string](Get-Optional $lane1 "brain_url" "") -ne $brain1) { throw "P6_LIVE_BRAIN_TARGET_CHANGED" }
  if ([string](Get-Optional $lane1 "work_url" "") -ne $work1) { throw "P6_LIVE_WORK_TARGET_CHANGED" }
  if ([int](Get-Optional $lane1 "applied_work_url_revision" 0) -ne 4) { throw "P6_LIVE_WORK_TARGET_REVISION_CHANGED" }

  if (
    [string](Get-Optional $lane2 "task_id" "") -ne "P6-LANE2-SENTINEL" -or
    [int](Get-Optional $lane2 "work_generation" 0) -ne 3 -or
    [string](Get-Optional $lane2 "brain_url" "") -ne $brain2 -or
    [string](Get-Optional $lane2 "work_url" "") -ne $work2
  ) { throw "P6_LIVE_LANE2_MUTATED" }

  if (
    [string](Get-Optional $lane3 "task_id" "") -ne "P6-LANE3-SENTINEL" -or
    [int](Get-Optional $lane3 "work_generation" 0) -ne 4 -or
    [string](Get-Optional $lane3 "brain_url" "") -ne $brain3 -or
    [string](Get-Optional $lane3 "work_url" "") -ne $work3
  ) { throw "P6_LIVE_LANE3_MUTATED" }

  if ($configHashBefore -ne (Get-FileHash -LiteralPath $configFile -Algorithm SHA256).Hash) {
    throw "P6_LIVE_RUNTIME_MUTATED_CONFIG"
  }

  Write-Host "LIVE_P6_RESET_REVISION_APPLIED=PASS"
  Write-Host "LIVE_P6_WORK_GENERATION_INCREMENT_ONCE=PASS"
  Write-Host "LIVE_P6_EXECUTION_STATE_CLEARED=PASS"
  Write-Host "LIVE_P6_BRAIN_REQUEST_REARMED=PASS"
  Write-Host "LIVE_P6_TARGETS_UNCHANGED=PASS"
  Write-Host "LIVE_P6_LANE_ISOLATION=PASS"
  Write-Host "LIVE_P6_RUNTIME_CONFIG_READ_ONLY=PASS"

  Start-Sleep -Seconds 6
  $later = Read-JsonSafe $registryFile
  $laterLane1 = Get-Optional $later.lanes "lane-1"
  if (
    [int](Get-Optional $laterLane1 "applied_work_state_reset_revision" 0) -ne 9 -or
    [int](Get-Optional $laterLane1 "work_generation" 0) -ne 8
  ) {
    throw "P6_LIVE_RESET_NOT_EXACT_ONCE"
  }
  Write-Host "LIVE_P6_EXACT_ONCE=PASS"

  $logText = if (Test-Path $logFile) { Get-Content -LiteralPath $logFile -Raw -Encoding UTF8 } else { "" }
  if ($logText -notmatch "LANE_OWNER_MAINTENANCE_WORK_STATE_RESET") {
    throw "P6_LIVE_RESET_AUDIT_EVENT_MISSING"
  }
  Write-Host "LIVE_P6_AUDIT_EVENT=PASS"

  Write-Host "LIVE_P6_ACCEPTANCE=PASS"
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

  $prodConfigHashAfter = if (Test-Path $productionConfig) { (Get-FileHash $productionConfig -Algorithm SHA256).Hash } else { "" }
  $prodRegistryHashAfter = if (Test-Path $productionRegistry) { (Get-FileHash $productionRegistry -Algorithm SHA256).Hash } else { "" }
  if ($prodConfigHashBefore -ne $prodConfigHashAfter) { throw "P6_LIVE_PRODUCTION_CONFIG_MUTATED" }
  if ($prodRegistryHashBefore -ne $prodRegistryHashAfter) { throw "P6_LIVE_PRODUCTION_REGISTRY_MUTATED" }

  Write-Host "LIVE_P6_PRODUCTION_STATE_UNCHANGED=PASS"
  Remove-Item $tempBase -Recurse -Force -ErrorAction SilentlyContinue
}
