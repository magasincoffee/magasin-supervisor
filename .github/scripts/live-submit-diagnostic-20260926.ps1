param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Write-Host "DIAG_MACHINE=$env:COMPUTERNAME"
if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Host 'TARGET_MATCH=False'
  Write-Host 'TARGET_SKIP_SAFE=True'
  exit 0
}
Write-Host 'TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'platform-default'
if (-not [string]::IsNullOrWhiteSpace([string]$env:SUPERVISOR_STATE_ROOT)) {
  $root = [System.IO.Path]::GetFullPath([string]$env:SUPERVISOR_STATE_ROOT)
}
$root = Set-SupervisorStateRootBinding -Root $root
Write-Host "STATE_ROOT=$root"

$configPath = Join-Path $root 'lanes.json'
$registryPath = Join-Path $root 'lane-registry.json'
$runtime = Join-Path $root 'runtime'
$installedActions = Join-Path $runtime 'src\ui\actions.mjs'
$sourceActions = Join-Path $env:GITHUB_WORKSPACE 'src\ui\actions.mjs'
$installedRecorder = Join-Path $runtime 'src\ui\submit-flight-recorder.mjs'
$sourceRecorder = Join-Path $env:GITHUB_WORKSPACE 'src\ui\submit-flight-recorder.mjs'

foreach ($p in @($configPath,$registryPath,$installedActions,$sourceActions,$installedRecorder,$sourceRecorder)) {
  if (-not (Test-Path $p -PathType Leaf)) { throw "MISSING_REQUIRED=$p" }
}

$cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$lane1 = @($cfg.lanes | Where-Object { [string]$_.lane_id -eq 'lane-1' }) | Select-Object -First 1
if (-not $lane1) { throw 'lane-1 missing' }
Write-Host "LANE1_ENABLED=$([bool]$lane1.enabled)"
Write-Host "LANE1_BRAIN_REVISION=$([int]$lane1.brain_url_revision)"
Write-Host "LANE1_WORK_REVISION=$([int]$lane1.work_url_revision)"

$reg = Get-Content $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json
$regLane = $reg.lanes.'lane-1'
if ($regLane) {
  Write-Host "LANE1_TASK_ID=$([string]$regLane.task_id)"
  Write-Host "LANE1_AWAITING_WORK=$([bool]$regLane.awaiting_work)"
  Write-Host "LANE1_BRAIN_REQUEST_SENT=$([bool]$regLane.brain_request_sent)"
  Write-Host "LANE1_BRAIN_INFLIGHT_PRESENT=$([bool]($null -ne $regLane.brain_request_inflight))"
}

$srcActionsHash = (Get-FileHash $sourceActions -Algorithm SHA256).Hash.ToLowerInvariant()
$installedActionsHash = (Get-FileHash $installedActions -Algorithm SHA256).Hash.ToLowerInvariant()
$srcRecorderHash = (Get-FileHash $sourceRecorder -Algorithm SHA256).Hash.ToLowerInvariant()
$installedRecorderHash = (Get-FileHash $installedRecorder -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "ACTIONS_SOURCE_SHA256=$srcActionsHash"
Write-Host "ACTIONS_INSTALLED_SHA256=$installedActionsHash"
Write-Host "ACTIONS_HASH_MATCH=$($srcActionsHash -eq $installedActionsHash)"
Write-Host "RECORDER_HASH_MATCH=$($srcRecorderHash -eq $installedRecorderHash)"

$wrapper = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*run-supervisor.ps1*' -and $_.CommandLine -like "*$root*" })
$threeLane = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*three-lane-cli.mjs*' })
Write-Host "WRAPPER_COUNT=$($wrapper.Count)"
if ($wrapper.Count -gt 0) { Write-Host "WRAPPER_PID=$([int]$wrapper[0].ProcessId)" }
Write-Host "THREE_LANE_COUNT=$($threeLane.Count)"
if ($threeLane.Count -gt 0) { Write-Host "THREE_LANE_PID=$([int]$threeLane[0].ProcessId)" }

$diagRoot = Join-Path $root 'diagnostics\submit'
if (-not (Test-Path $diagRoot -PathType Container)) {
  Write-Host 'SUBMIT_DIAG_ROOT_PRESENT=False'
} else {
  Write-Host 'SUBMIT_DIAG_ROOT_PRESENT=True'
  $dirs = @(Get-ChildItem $diagRoot -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending)
  Write-Host "SUBMIT_DIAG_RUN_COUNT=$($dirs.Count)"
  if ($dirs.Count -gt 0) {
    $latestDir = $dirs[0]
    Write-Host "SUBMIT_NEWEST_RUN=$($latestDir.Name)"
    Write-Host "SUBMIT_NEWEST_AGE_SECONDS=$([math]::Round(((Get-Date).ToUniversalTime() - $latestDir.LastWriteTimeUtc).TotalSeconds))"
    $files = @(Get-ChildItem $latestDir.FullName -File -ErrorAction SilentlyContinue | Sort-Object Name)
    Write-Host "SUBMIT_NEWEST_FILES=$((@($files | ForEach-Object { $_.Name }) -join ','))"
    $stageFiles = @($files | Where-Object { $_.Name -match '^\d{2}-.*\.json$' } | Sort-Object Name)
    if ($stageFiles.Count -gt 0) {
      $lastStageFile = $stageFiles[$stageFiles.Count - 1]
      $stage = Get-Content $lastStageFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
      Write-Host "SUBMIT_LAST_STAGE_FILE=$($lastStageFile.Name)"
      Write-Host "SUBMIT_LAST_STAGE=$([string]$stage.stage)"
      Write-Host "SUBMIT_LAST_STAGE_AT=$([string]$stage.captured_at)"
      Write-Host "SUBMIT_COMPOSER_TEXT_LENGTH=$([int]$stage.composerTextLength)"
      Write-Host "SUBMIT_USER_TURN_COUNT=$([int]$stage.userTurnCount)"
      if ($stage.composer) {
        Write-Host "SUBMIT_COMPOSER=TAG=$([string]$stage.composer.tag)|ID=$([string]$stage.composer.id)|ROLE=$([string]$stage.composer.role)|TESTID=$([string]$stage.composer.testid)|CONTENTEDITABLE=$([string]$stage.composer.contenteditable)|DISABLED=$([bool]$stage.composer.disabled)|VISIBLE=$([bool]$stage.composer.visible)"
      }
      if ($stage.targetHint) {
        Write-Host "SUBMIT_TARGET_HINT=SELECTOR=$([string]$stage.targetHint.selector)|SCOPE=$([string]$stage.targetHint.scope)|METHOD=$([string]$stage.targetHint.method)"
      }
      $controls = @($stage.controls)
      Write-Host "SUBMIT_CONTROL_COUNT=$($controls.Count)"
      for ($i=0; $i -lt $controls.Count; $i++) {
        $c = $controls[$i]
        $aria = ([string]$c.aria -replace '[\r\n|]+',' ').Substring(0,[Math]::Min(120,([string]$c.aria).Length))
        $title = ([string]$c.title -replace '[\r\n|]+',' ').Substring(0,[Math]::Min(120,([string]$c.title).Length))
        Write-Host "SUBMIT_CONTROL[$i]=TAG=$([string]$c.tag)|TYPE=$([string]$c.type)|TESTID=$([string]$c.testid)|ARIA=$aria|TITLE=$title|DISABLED=$([bool]$c.disabled)|VISIBLE=$([bool]$c.visible)"
      }
    }
    $summaryPath = Join-Path $latestDir.FullName 'summary.json'
    if (Test-Path $summaryPath -PathType Leaf) {
      $summary = Get-Content $summaryPath -Raw -Encoding UTF8 | ConvertFrom-Json
      Write-Host "SUBMIT_SUMMARY_PRESENT=True"
      Write-Host "SUBMIT_SUMMARY_SUCCESS=$([bool]$summary.success)"
      if ($summary.result) {
        Write-Host "SUBMIT_SUMMARY_EXECUTED=$([bool]$summary.result.executed)"
        Write-Host "SUBMIT_SUMMARY_REJECTION=$([string]$summary.result.rejection_class)"
        Write-Host "SUBMIT_SUMMARY_METHOD=$([string]$summary.result.send_method)"
        Write-Host "SUBMIT_SUMMARY_SELECTOR=$([string]$summary.result.send_selector)"
        Write-Host "SUBMIT_SUMMARY_SCOPE=$([string]$summary.result.send_scope)"
        Write-Host "SUBMIT_SUMMARY_PRIMARY=$([string]$summary.result.primary_submit_evidence)"
        Write-Host "SUBMIT_SUMMARY_EVIDENCE=$([string]$summary.result.submit_evidence)"
        Write-Host "SUBMIT_SUMMARY_USER_TURN=$([string]$summary.result.user_turn_evidence)"
      }
      if ($summary.error) {
        Write-Host "SUBMIT_SUMMARY_ERROR_NAME=$([string]$summary.error.name)"
        Write-Host "SUBMIT_SUMMARY_ERROR=$([string]$summary.error.message)"
      }
    } else {
      Write-Host 'SUBMIT_SUMMARY_PRESENT=False'
    }
  }

  $pointer = Join-Path $diagRoot 'latest.json'
  if (Test-Path $pointer -PathType Leaf) {
    $latest = Get-Content $pointer -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host 'SUBMIT_LATEST_POINTER_PRESENT=True'
    Write-Host "SUBMIT_LATEST_SUCCESS=$([bool]$latest.success)"
    if ($latest.result) {
      Write-Host "SUBMIT_LATEST_REJECTION=$([string]$latest.result.rejection_class)"
      Write-Host "SUBMIT_LATEST_METHOD=$([string]$latest.result.send_method)"
      Write-Host "SUBMIT_LATEST_EVIDENCE=$([string]$latest.result.submit_evidence)"
      Write-Host "SUBMIT_LATEST_USER_TURN=$([string]$latest.result.user_turn_evidence)"
    }
    if ($latest.error) {
      Write-Host "SUBMIT_LATEST_ERROR_NAME=$([string]$latest.error.name)"
      Write-Host "SUBMIT_LATEST_ERROR=$([string]$latest.error.message)"
    }
  } else {
    Write-Host 'SUBMIT_LATEST_POINTER_PRESENT=False'
  }
}

$diagScript = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\diag-brain-dom.mjs'
if (Test-Path $diagScript -PathType Leaf) {
  & node $diagScript $root
  if ($LASTEXITCODE -ne 0) { throw "diag-brain-dom failed with exit $LASTEXITCODE" }
}

Write-Host 'LIVE_SUBMIT_DIAGNOSTIC_COMPLETE=True'
