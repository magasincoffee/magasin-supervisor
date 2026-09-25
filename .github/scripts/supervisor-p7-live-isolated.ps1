$ErrorActionPreference = "Stop"

function Write-JsonFile([string]$Path, $Value) {
  $dir = Split-Path $Path -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding UTF8
}

$tempBase = Join-Path $env:RUNNER_TEMP "magasin-p7-live-isolated"
$root = Join-Path $tempBase "MAGASIN\BusinessOS\supervisor"
$runtime = Join-Path $root "runtime"
$runtimeWindows = Join-Path $runtime "windows"
$runtimeSource = Join-Path $runtime "src\runtime"
$profile = Join-Path $root "browser_profile"
$wrapperLog = Join-Path $root "wrapper.log"
$stopFile = Join-Path $root "STOP"
$configFile = Join-Path $root "lanes.json"
$diagRoot = Join-Path $tempBase "diagnostics-fixture"
$runScript = Join-Path $runtimeWindows "run-supervisor.ps1"

Remove-Item $tempBase -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $runtimeWindows,$runtimeSource,$profile,$diagRoot | Out-Null

foreach ($name in @("state-root.ps1","lifecycle-truth.ps1","run-supervisor.ps1")) {
  $source = Join-Path $env:GITHUB_WORKSPACE ("windows\" + $name)
  $target = Join-Path $runtimeWindows $name
  Copy-Item -LiteralPath $source -Destination $target -Force
  $text = [IO.File]::ReadAllText($target, [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText($target, $text, (New-Object Text.UTF8Encoding($true)))
}

$fakeRuntime = @'
const SUPERVISOR_RUNTIME_VERSION = "P7-LIVE-WRAPPER";
setTimeout(() => process.exit(75), 900);
'@
Set-Content -LiteralPath (Join-Path $runtimeSource "three-lane-cli.mjs") -Value $fakeRuntime -Encoding UTF8

$config = [pscustomobject]@{
  schema_version = "three-lane-config.v1"
  mode = "THREE_LANE_V1"
  lanes = @(
    [pscustomobject]@{ lane_id="lane-1"; project_name="P7"; brain_url=""; brain_url_revision=0; work_url=""; work_url_revision=0; work_url_saved_at=$null; work_mode="AUTO"; work_state_reset_revision=0; relay_retry_rearm_revision=0; relay_retry_rearm_requested_at=$null; enabled=$false },
    [pscustomobject]@{ lane_id="lane-2"; project_name="P7"; brain_url=""; brain_url_revision=0; work_url=""; work_url_revision=0; work_url_saved_at=$null; work_mode="AUTO"; work_state_reset_revision=0; relay_retry_rearm_revision=0; relay_retry_rearm_requested_at=$null; enabled=$false },
    [pscustomobject]@{ lane_id="lane-3"; project_name="P7"; brain_url=""; brain_url_revision=0; work_url=""; work_url_revision=0; work_url_saved_at=$null; work_mode="AUTO"; work_state_reset_revision=0; relay_retry_rearm_revision=0; relay_retry_rearm_requested_at=$null; enabled=$false }
  )
}
Write-JsonFile $configFile $config

. (Join-Path $env:GITHUB_WORKSPACE "windows\state-root.ps1")
$productionRoot = Get-SupervisorStateRoot -Compatibility "legacy-preserve"
$productionConfig = Join-Path $productionRoot "lanes.json"
$productionRegistry = Join-Path $productionRoot "lane-registry.json"
$prodConfigHashBefore = if (Test-Path $productionConfig) { (Get-FileHash $productionConfig -Algorithm SHA256).Hash } else { "" }
$prodRegistryHashBefore = if (Test-Path $productionRegistry) { (Get-FileHash $productionRegistry -Algorithm SHA256).Hash } else { "" }

$oldRoot = [string]$env:SUPERVISOR_STATE_ROOT
$oldLocal = [string]$env:LOCALAPPDATA
$oldMutex = [string]$env:SUPERVISOR_MUTEX_NAME
$oldFixtureRoot = [string]$env:P7_TEMP_ROOT
$wrapper = $null

try {
  $env:P7_TEMP_ROOT = $diagRoot
  & node (Join-Path $env:GITHUB_WORKSPACE ".github\scripts\supervisor-p7-live-fixture.mjs")
  if ($LASTEXITCODE -ne 0) { throw "P7_LIVE_NODE_FIXTURE_FAILED" }

  $env:LOCALAPPDATA = $tempBase
  $env:SUPERVISOR_STATE_ROOT = $root
  $env:SUPERVISOR_MUTEX_NAME = "Local\MAGASIN_BUSINESS_OS_SUPERVISOR_P7_LIVE"

  $wrapper = Start-Process -FilePath "powershell.exe" -PassThru -WindowStyle Hidden -ArgumentList @(
    "-NoLogo","-NoProfile","-ExecutionPolicy","Bypass",
    "-File",('"' + $runScript + '"'),"-DryRun"
  )

  $nodeExit = $null
  for ($i=0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-Path $wrapperLog)) { continue }

    foreach ($line in @(Get-Content -LiteralPath $wrapperLog -Encoding UTF8 -ErrorAction SilentlyContinue)) {
      if ([string]::IsNullOrWhiteSpace([string]$line)) { continue }
      try {
        $record = [string]$line | ConvertFrom-Json
        if (
          [string]$record.type -eq "NODE_EXIT" -and
          [string]$record.runtime_version -eq "P7-LIVE-WRAPPER" -and
          [int]$record.node_exit_code -eq 75
        ) {
          $nodeExit = $record
        }
      } catch {}
    }
    if ($nodeExit) { break }
  }

  if (-not $nodeExit) {
    Write-Host "LIVE_P7_DIAG_WRAPPER_NODE_EXIT_FOUND=False"
    if (Test-Path $wrapperLog) {
      Write-Host "--- P7_WRAPPER_LOG_TAIL_BEGIN ---"
      Get-Content -LiteralPath $wrapperLog -Tail 120 -Encoding UTF8 | ForEach-Object { Write-Host $_ }
      Write-Host "--- P7_WRAPPER_LOG_TAIL_END ---"
    } else {
      Write-Host "LIVE_P7_DIAG_WRAPPER_LOG_PRESENT=False"
    }
    throw "P7_LIVE_WRAPPER_NODE_EXIT_MISSING"
  }
  Write-Host "LIVE_P7_DIAG_WRAPPER_NODE_EXIT_FOUND=True"
  if ([int]$nodeExit.cdp_port -lt 1) { throw "P7_LIVE_WRAPPER_CDP_PORT_MISSING" }

  $allowedKeys = @(
    "timestamp","type","runtime_version",
    "adapter_state","cdp_port","dry_run","entry_point","error_name","exit_code",
    "mode","pid","stale_after_seconds","status_age_seconds","status_reason",
    "status_stale_restart","node_exit_code"
  )
  $wrapperText = Get-Content -LiteralPath $wrapperLog -Raw -Encoding UTF8
  foreach ($line in @($wrapperText -split "\r?\n")) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $record = $line | ConvertFrom-Json
    foreach ($property in $record.PSObject.Properties.Name) {
      if ($property -notin $allowedKeys) {
        throw ("P7_LIVE_WRAPPER_UNALLOWLISTED_KEY_" + $property)
      }
    }
  }

  foreach ($forbidden in @(
    "https://chatgpt.com/c/",
    "sk-proj-",
    "Bearer ",
    "PRIVATE_CHAT_BODY"
  )) {
    if ($wrapperText -like ("*" + $forbidden + "*")) {
      throw "P7_LIVE_WRAPPER_PRIVATE_DATA_LEAK"
    }
  }

  Write-Host "LIVE_P7_WRAPPER_LOG_SANITIZED=PASS"
  Write-Host "LIVE_P7_WRAPPER_RUNTIME_VERSION=PASS"
  Write-Host "LIVE_P7_WRAPPER_NODE_EXIT_CODE=PASS"
  Write-Host "LIVE_P7_WRAPPER_CDP_PORT=PASS"

  New-Item -ItemType File -Force -Path $stopFile | Out-Null
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
  $env:LOCALAPPDATA = $oldLocal
  $env:SUPERVISOR_MUTEX_NAME = $oldMutex
  $env:P7_TEMP_ROOT = $oldFixtureRoot

  $prodConfigHashAfter = if (Test-Path $productionConfig) { (Get-FileHash $productionConfig -Algorithm SHA256).Hash } else { "" }
  $prodRegistryHashAfter = if (Test-Path $productionRegistry) { (Get-FileHash $productionRegistry -Algorithm SHA256).Hash } else { "" }

  if ($prodConfigHashBefore -ne $prodConfigHashAfter) { throw "P7_LIVE_PRODUCTION_CONFIG_MUTATED" }
  if ($prodRegistryHashBefore -ne $prodRegistryHashAfter) { throw "P7_LIVE_PRODUCTION_REGISTRY_MUTATED" }

  Write-Host "LIVE_P7_PRODUCTION_STATE_UNCHANGED=PASS"
  Remove-Item $tempBase -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "LIVE_P7_ACCEPTANCE=PASS"
