param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13',
  [string]$LaneId = 'lane-1'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if ($env:COMPUTERNAME -ne $TargetComputer) {
  throw "Production cutover refused on non-target machine."
}

$workspace = $env:GITHUB_WORKSPACE
if ([string]::IsNullOrWhiteSpace($workspace)) {
  throw 'GITHUB_WORKSPACE is required.'
}

$qualificationPath = Join-Path $workspace '.github\qualification\pe007-latest.json'
$sotPath = Join-Path $workspace 'docs\SUPERVISOR_PLANNER_EXECUTOR_V1_SOURCE_OF_TRUTH.json'
if (-not (Test-Path $qualificationPath -PathType Leaf)) {
  throw 'Authoritative PE-007 qualification evidence is missing.'
}
if (-not (Test-Path $sotPath -PathType Leaf)) {
  throw 'Planner/Executor Source of Truth is missing.'
}

$qualification = Get-Content $qualificationPath -Raw -Encoding UTF8 | ConvertFrom-Json
$sot = Get-Content $sotPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$qualification.status -ne 'PASS') {
  throw 'PE-007 live qualification is not PASS.'
}
if ([bool]$qualification.production_cutover) {
  throw 'Qualification evidence unexpectedly claims production cutover already happened.'
}
if (-not [bool]$sot.owner_cutover_authorization.authorized) {
  throw 'Source of Truth does not contain explicit Owner cutover authorization.'
}

. (Join-Path $workspace 'windows\state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime = Join-Path $root 'runtime'
$statePath = Join-Path $root 'planner-executor-state.json'
$statusPath = Join-Path $root 'planner-executor-status.json'
$cutoverTruthPath = Join-Path $root 'planner-executor-cutover.json'
$candidatePath = Join-Path $env:RUNNER_TEMP 'pe007-production-cutover-candidate.json'
$sourceRevision = [string]$env:GITHUB_SHA
$authorizedAt = [string]$sot.owner_cutover_authorization.authorized_at

if ((Test-Path $cutoverTruthPath -PathType Leaf) -and (Test-Path $statePath -PathType Leaf)) {
  try {
    $existingCutover = Get-Content $cutoverTruthPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $existingState = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (
      [string]$existingCutover.status -eq 'PASS' -and
      [bool]$existingCutover.production_cutover -and
      [string]$existingState.mode -eq 'PLANNER_EXECUTOR_V1'
    ) {
      Write-Host 'PE007_PRODUCTION_CUTOVER_ALREADY_PASS=True'
      Write-Host 'PE007_PRODUCTION_MODE=PLANNER_EXECUTOR_V1'
      exit 0
    }
  } catch {}
}

function Write-Candidate {
  if (Test-Path $candidatePath) {
    Remove-Item $candidatePath -Force -ErrorAction SilentlyContinue
  }
  $candidateArgs = @(
    (Join-Path $workspace 'src\runtime\planner-executor-cutover-cli.mjs'),
    '--root', $root,
    '--lane-id', $LaneId,
    '--output', $candidatePath,
    '--authorized-at', $authorizedAt,
    '--source-revision', $sourceRevision
  )
  # External-command stdout must not leak into this PowerShell function's
  # return pipeline; otherwise callers receive an array of log strings plus
  # the candidate object and StrictMode property access fails.
  & node @candidateArgs | Out-Host
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $candidatePath)) {
    throw 'Planner/Executor cutover candidate generation failed.'
  }
  return Get-Content $candidatePath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Stop-SupervisorTechnical {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like '*run-supervisor.ps1*' -and
      $_.CommandLine -like "*$root*"
    } |
    ForEach-Object {
      & taskkill.exe /PID ([int]$_.ProcessId) /T /F | Out-Null
      $global:LASTEXITCODE = 0
    }

  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -match '(supervisor-loop-cli|brain-worker-cli|three-lane-cli|planner-executor-cli)\.mjs'
    } |
    ForEach-Object {
      Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
    }

  Remove-Item (Join-Path $root 'supervisor.pid') -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

function Start-InstalledRuntimeRecovery {
  $start = Join-Path $root 'runtime\windows\start-supervisor.ps1'
  if (-not (Test-Path $start -PathType Leaf)) {
    throw "Installed start script missing: $start"
  }
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $start -Hidden -Recovery
  if ($LASTEXITCODE -ne 0) {
    throw "Installed runtime recovery start failed with exit code $LASTEXITCODE"
  }
}

function New-RollbackSnapshot {
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
  $dir = Join-Path $root ("rollback\planner-executor-v1\" + $stamp)
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $stateDir = Join-Path $dir 'state'
  $runtimeDir = Join-Path $dir 'runtime'
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

  foreach ($name in @(
    'lanes.json',
    'lane-registry.json',
    'lane-status.json',
    'runtime-status.json',
    'orchestration.json',
    'target.json'
  )) {
    $source = Join-Path $root $name
    if (Test-Path $source -PathType Leaf) {
      Copy-Item $source (Join-Path $stateDir $name) -Force
    }
  }

  foreach ($name in @('src','windows')) {
    $source = Join-Path $runtime $name
    if (Test-Path $source) {
      Copy-Item $source (Join-Path $runtimeDir $name) -Recurse -Force
    }
  }
  foreach ($name in @('package.json','package-lock.json')) {
    $source = Join-Path $runtime $name
    if (Test-Path $source -PathType Leaf) {
      Copy-Item $source (Join-Path $runtimeDir $name) -Force
    }
  }

  $manifest = [ordered]@{
    schema = 'planner-executor-cutover-rollback.v1'
    created_at_utc = [DateTime]::UtcNow.ToString('o')
    source_revision = $sourceRevision
    source_lane_id = $LaneId
    production_mode_before = 'THREE_LANE_V1'
    state_files = @()
    runtime_files = @()
  }
  foreach ($file in @(Get-ChildItem $stateDir -File -Recurse -ErrorAction SilentlyContinue)) {
    $manifest.state_files += [ordered]@{
      relative_path = $file.FullName.Substring($stateDir.Length).TrimStart('\')
      sha256 = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  foreach ($file in @(Get-ChildItem $runtimeDir -File -Recurse -ErrorAction SilentlyContinue)) {
    $manifest.runtime_files += [ordered]@{
      relative_path = $file.FullName.Substring($runtimeDir.Length).TrimStart('\')
      sha256 = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  $manifestPath = Join-Path $dir 'manifest.json'
  [System.IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false))
  )
  return $dir
}

function Restore-RollbackSnapshot([string]$Dir) {
  Write-Host 'PE007_CUTOVER_ROLLBACK_STARTED=True'
  Stop-SupervisorTechnical

  Remove-Item $statePath -Force -ErrorAction SilentlyContinue
  Remove-Item $statusPath -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $root 'planner-executor-incidents.ndjson') -Force -ErrorAction SilentlyContinue
  Remove-Item $cutoverTruthPath -Force -ErrorAction SilentlyContinue

  $stateDir = Join-Path $Dir 'state'
  foreach ($file in @(Get-ChildItem $stateDir -File -ErrorAction SilentlyContinue)) {
    Copy-Item $file.FullName (Join-Path $root $file.Name) -Force
  }

  $runtimeSnapshot = Join-Path $Dir 'runtime'
  if (-not (Test-Path $runtimeSnapshot)) {
    throw 'Rollback runtime snapshot is missing.'
  }
  if (Test-Path $runtime) {
    Remove-Item $runtime -Recurse -Force -ErrorAction SilentlyContinue
  }
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  Copy-Item (Join-Path $runtimeSnapshot '*') $runtime -Recurse -Force

  Push-Location $runtime
  try {
    npm install --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Rollback npm install failed.' }
  } finally {
    Pop-Location
  }

  Start-InstalledRuntimeRecovery
  Write-Host 'PE007_CUTOVER_ROLLBACK_RESTORED=True'
}

$firstCandidate = Write-Candidate
if (-not [bool]$firstCandidate.cutover_ready) {
  $blockers = @($firstCandidate.blockers) -join ','
  Write-Host "PE007_CUTOVER_BLOCKED=$blockers"
  exit 42
}

$rollbackDir = $null
$mutationStarted = $false
try {
  Stop-SupervisorTechnical

  $finalCandidate = Write-Candidate
  if (-not [bool]$finalCandidate.cutover_ready) {
    Start-InstalledRuntimeRecovery
    $blockers = @($finalCandidate.blockers) -join ','
    Write-Host "PE007_CUTOVER_FINAL_PREFLIGHT_BLOCKED=$blockers"
    exit 43
  }

  $rollbackDir = New-RollbackSnapshot
  $mutationStarted = $true
  Write-Host 'PE007_CUTOVER_ROLLBACK_SNAPSHOT_CREATED=True'

  $installScript = Join-Path $workspace 'windows\install-supervisor.ps1'
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installScript -SourceRoot $workspace
  if ($LASTEXITCODE -ne 0) {
    throw "Supervisor install failed with exit code $LASTEXITCODE"
  }

  $state = $finalCandidate.state
  $state.production_cutover.cutover_started_at = [DateTime]::UtcNow.ToString('o')
  $state.production_cutover.rollback_snapshot = $rollbackDir

  $tmpState = "$statePath.cutover.tmp"
  [System.IO.File]::WriteAllText(
    $tmpState,
    ($state | ConvertTo-Json -Depth 30) + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false))
  )
  Move-Item $tmpState $statePath -Force

  $cutoverTruth = [ordered]@{
    schema = 'planner-executor-production-cutover.v1'
    mode = 'PLANNER_EXECUTOR_V1'
    source_lane_id = $LaneId
    source_revision = $sourceRevision
    owner_authorized_at = $authorizedAt
    rollback_snapshot = $rollbackDir
    status = 'STARTING'
    production_cutover = $true
    updated_at = [DateTime]::UtcNow.ToString('o')
  }
  [System.IO.File]::WriteAllText(
    $cutoverTruthPath,
    ($cutoverTruth | ConvertTo-Json -Depth 8) + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false))
  )

  Start-InstalledRuntimeRecovery

  $healthy = $false
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    $installedLifecycle = Join-Path $root 'runtime\windows\lifecycle-truth.ps1'
    if (-not (Test-Path $installedLifecycle)) { continue }
    . $installedLifecycle
    $truth = Get-LifecycleProcessTruth -Root $root
    $status = $null
    if (Test-Path $statusPath) {
      try { $status = Get-Content $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
    }
    if (
      $truth.healthy -and
      [string]$truth.runtime_mode -eq 'PLANNER_EXECUTOR_V1' -and
      [bool]$truth.planner_executor_alive -and
      $status -and
      [string]$status.mode -eq 'PLANNER_EXECUTOR_V1' -and
      [bool]$status.production_cutover -and
      [int]$status.chatgpt_tabs -eq 2 -and
      [int]$status.chatgpt_work_mode_invocations -eq 0
    ) {
      $healthy = $true
      break
    }
  }
  if (-not $healthy) {
    throw 'Planner/Executor production runtime did not reach healthy two-chat cutover truth.'
  }

  $durable = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $durable.production_cutover.cutover_completed_at = [DateTime]::UtcNow.ToString('o')
  $tmpState = "$statePath.cutover-complete.tmp"
  [System.IO.File]::WriteAllText(
    $tmpState,
    ($durable | ConvertTo-Json -Depth 30) + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false))
  )
  Move-Item $tmpState $statePath -Force

  $cutoverTruth.status = 'PASS'
  $cutoverTruth.updated_at = [DateTime]::UtcNow.ToString('o')
  [System.IO.File]::WriteAllText(
    $cutoverTruthPath,
    ($cutoverTruth | ConvertTo-Json -Depth 8) + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false))
  )

  Write-Host 'PE007_PRODUCTION_CUTOVER=PASS'
  Write-Host 'PE007_PRODUCTION_MODE=PLANNER_EXECUTOR_V1'
  Write-Host 'PE007_PRODUCTION_CHATGPT_TABS=2'
  Write-Host 'PE007_PRODUCTION_CHATGPT_WORK_MODE_INVOCATIONS=0'
  Write-Host 'PE007_PRODUCTION_ROLLBACK_READY=True'
  exit 0
} catch {
  $errorMessage = [string]$_.Exception.Message
  Write-Host "PE007_CUTOVER_ERROR=$errorMessage"
  if ($mutationStarted -and $rollbackDir) {
    try {
      Restore-RollbackSnapshot -Dir $rollbackDir
    } catch {
      Write-Host "PE007_CUTOVER_ROLLBACK_ERROR=$([string]$_.Exception.Message)"
    }
  } else {
    try { Start-InstalledRuntimeRecovery } catch {}
  }
  throw
}
