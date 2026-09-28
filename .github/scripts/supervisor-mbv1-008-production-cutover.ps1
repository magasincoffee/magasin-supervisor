param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if ($env:COMPUTERNAME -ne $TargetComputer) {
  throw 'MBV1-008 production cutover refused on non-target machine.'
}
$workspace = [string]$env:GITHUB_WORKSPACE
if ([string]::IsNullOrWhiteSpace($workspace)) {
  throw 'GITHUB_WORKSPACE is required.'
}

. (Join-Path $workspace 'windows\state-root.ps1')
. (Join-Path $workspace 'windows\lifecycle-truth.ps1')
. (Join-Path $workspace 'windows\chatgpt-bridge-runtime.ps1')

$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime = Join-Path $root 'runtime'
$statePath = Join-Path $root 'planner-executor-state.json'
$statusPath = Join-Path $root 'planner-executor-status.json'
$transportPath = Join-Path $root 'planner-executor-transport.json'
$cutoverTruthPath = Join-Path $root 'planner-executor-bridge-cutover.json'
$stopPath = Join-Path $root 'STOP'
$autostartDisabledPath = Join-Path $root 'AUTOSTART_DISABLED'

if (-not (Test-Path $statePath -PathType Leaf)) {
  throw 'Planner/Executor production state is missing.'
}
$state = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$state.mode -ne 'PLANNER_EXECUTOR_V1') {
  throw 'Production runtime is not Planner/Executor V1.'
}

$sotPath = Join-Path $workspace 'docs\SUPERVISOR_PLANNER_EXECUTOR_V1_SOURCE_OF_TRUTH.json'
$sot = Get-Content $sotPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$sot.next_implementation_program.current_task -ne 'MBV1-008') {
  throw 'Source of Truth does not authorize MBV1-008 cutover.'
}
if ([bool]$sot.next_implementation_program.cutover.bridge_cutover) {
  Write-Host 'MBV1_008_CUTOVER_ALREADY_RECORDED=True'
}

$truthBefore = Get-LifecycleProcessTruth -Root $root
$wasRunning = [bool]$truthBefore.wrapper_alive
$ownerStopBefore = [bool]((Test-Path $stopPath) -or (Test-Path $autostartDisabledPath))
Write-Host "MBV1_008_CUTOVER_WAS_RUNNING=$wasRunning"
Write-Host "MBV1_008_CUTOVER_OWNER_STOP_BEFORE=$ownerStopBefore"

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
      $_.CommandLine -match '(planner-executor-cli|planner-executor-bridge-cli|three-lane-cli|brain-worker-cli|supervisor-loop-cli)\.mjs'
    } |
    ForEach-Object {
      Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
    }

  Stop-ChatGptBridgeRuntimeProcesses -Root $root
  Remove-Item (Join-Path $root 'supervisor.pid') -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 750
}

function Start-InstalledRuntime {
  $start = Join-Path $root 'runtime\windows\start-supervisor.ps1'
  if (-not (Test-Path $start -PathType Leaf)) {
    throw "Installed start script is missing: $start"
  }
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $start -Hidden
  if ($LASTEXITCODE -ne 0) {
    throw "Installed Supervisor start failed with exit code $LASTEXITCODE"
  }
}

function New-RollbackSnapshot {
  $dir = Join-Path $root ('rollback\bridge-v1\' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  if (Test-Path $runtime) {
    Copy-Item $runtime (Join-Path $dir 'runtime') -Recurse -Force
  }
  if (Test-Path $transportPath -PathType Leaf) {
    Copy-Item $transportPath (Join-Path $dir 'planner-executor-transport.json') -Force
    Set-Content (Join-Path $dir 'transport-existed.txt') 'true' -Encoding ascii
  } else {
    Set-Content (Join-Path $dir 'transport-existed.txt') 'false' -Encoding ascii
  }
  $manifest = [ordered]@{
    schema = 'mbv1-008-bridge-rollback.v1'
    created_at_utc = [DateTime]::UtcNow.ToString('o')
    source_revision = [string]$env:GITHUB_SHA
    bridge_upstream_commit = $script:ChatGptBridgePinnedCommit
    was_running = $wasRunning
    owner_stop_before = $ownerStopBefore
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $dir 'manifest.json'),
    ($manifest | ConvertTo-Json -Depth 5) + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false))
  )
  return $dir
}

function Restore-Rollback([string]$Dir) {
  Write-Host 'MBV1_008_ROLLBACK_STARTED=True'
  Stop-SupervisorTechnical
  if (Test-Path $runtime) {
    Remove-Item $runtime -Recurse -Force -ErrorAction SilentlyContinue
  }
  $savedRuntime = Join-Path $Dir 'runtime'
  if (Test-Path $savedRuntime) {
    Copy-Item $savedRuntime $runtime -Recurse -Force
  }

  $transportExisted = ((Get-Content (Join-Path $Dir 'transport-existed.txt') -Raw).Trim() -eq 'true')
  if ($transportExisted) {
    Copy-Item (Join-Path $Dir 'planner-executor-transport.json') $transportPath -Force
  } else {
    Remove-Item $transportPath -Force -ErrorAction SilentlyContinue
  }

  if ($wasRunning -and -not $ownerStopBefore) {
    Start-InstalledRuntime
  }
  Write-Host 'MBV1_008_ROLLBACK_RESTORED=True'
}

$rollbackDir = $null
$mutationStarted = $false
try {
  Stop-SupervisorTechnical
  $rollbackDir = New-RollbackSnapshot
  $mutationStarted = $true
  Write-Host "MBV1_008_ROLLBACK_SNAPSHOT=$rollbackDir"

  $install = Join-Path $workspace 'windows\install-supervisor.ps1'
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $install -SourceRoot $workspace
  if ($LASTEXITCODE -ne 0) {
    throw "Supervisor runtime install failed with exit code $LASTEXITCODE"
  }

  [void](Install-ChatGptBridgeRuntime -Root $root)

  $selector = Join-Path $workspace 'windows\set-planner-executor-transport.ps1'
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $selector -Primary CHATGPT_BRIDGE_V1 -Root $root
  if ($LASTEXITCODE -ne 0) {
    throw "Bridge transport selector failed with exit code $LASTEXITCODE"
  }

  $installedBridge = Assert-ChatGptBridgePinnedInstall -Root $root
  $transport = Get-Content $transportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (
    [string]$transport.primary -ne 'CHATGPT_BRIDGE_V1' -or
    [string]$transport.bridge_upstream_commit -ne $script:ChatGptBridgePinnedCommit
  ) {
    throw 'Persistent Bridge transport selector verification failed.'
  }

  $runtimeHealth = 'DEFERRED_NOT_PREVIOUSLY_RUNNING'
  if ($wasRunning -and -not $ownerStopBefore) {
    Start-InstalledRuntime
    $healthy = $false
    for ($i = 0; $i -lt 150; $i++) {
      Start-Sleep -Seconds 1
      . (Join-Path $root 'runtime\windows\lifecycle-truth.ps1')
      $truth = Get-LifecycleProcessTruth -Root $root
      $status = $null
      if (Test-Path $statusPath -PathType Leaf) {
        try { $status = Get-Content $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
      }
      if (
        $truth.healthy -and
        [bool]$truth.planner_executor_alive -and
        $status -and
        [string]$status.transport -eq 'CHATGPT_BRIDGE_V1' -and
        [int]$status.chatgpt_tabs -eq 2 -and
        [int]$status.chatgpt_work_mode_invocations -eq 0 -and
        (Test-ChatGptBridgeHealth)
      ) {
        $healthy = $true
        break
      }
    }
    if (-not $healthy) {
      throw 'Bridge production runtime did not reach healthy two-chat transport truth.'
    }
    $runtimeHealth = 'PASS'
  }

  $cutoverTruth = [ordered]@{
    schema = 'mbv1-008-bridge-production-cutover.v1'
    status = 'PASS'
    production_mode = 'PLANNER_EXECUTOR_V1'
    primary_transport = 'CHATGPT_BRIDGE_V1'
    rollback_transport = 'DIRECT_DOM_V1'
    bridge_upstream_commit = $script:ChatGptBridgePinnedCommit
    source_revision = [string]$env:GITHUB_SHA
    target_computer = $env:COMPUTERNAME
    rollback_snapshot = $rollbackDir
    runtime_health = $runtimeHealth
    was_running_before = $wasRunning
    owner_stop_preserved = $ownerStopBefore
    completed_at_utc = [DateTime]::UtcNow.ToString('o')
  }
  [System.IO.File]::WriteAllText(
    $cutoverTruthPath,
    ($cutoverTruth | ConvertTo-Json -Depth 6) + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false))
  )

  Write-Host 'MBV1_008_PRODUCTION_CUTOVER=PASS'
  Write-Host 'MBV1_008_PRIMARY_TRANSPORT=CHATGPT_BRIDGE_V1'
  Write-Host 'MBV1_008_ROLLBACK_TRANSPORT=DIRECT_DOM_V1'
  Write-Host "MBV1_008_RUNTIME_HEALTH=$runtimeHealth"
  Write-Host 'MBV1_008_OPENAI_API_REQUIRED=False'
  exit 0
} catch {
  Write-Host "MBV1_008_CUTOVER_ERROR=$([string]$_.Exception.Message)"
  if ($mutationStarted -and $rollbackDir) {
    try { Restore-Rollback -Dir $rollbackDir } catch {
      Write-Host "MBV1_008_ROLLBACK_ERROR=$([string]$_.Exception.Message)"
    }
  }
  throw
}
