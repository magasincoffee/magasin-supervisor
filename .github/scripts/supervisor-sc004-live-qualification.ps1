param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13',
  [int]$Attempt = 1,
  [int]$NonTargetHoldSeconds = 90
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Write-Host "SC004_QUAL_ATTEMPT=$Attempt"
Write-Host "SC004_QUAL_MACHINE=$env:COMPUTERNAME"

if ([string]::IsNullOrWhiteSpace([string]$env:GITHUB_OUTPUT)) {
  throw 'GITHUB_OUTPUT is unavailable.'
}

function Set-JobOutput([string]$Name, [string]$Value) {
  "$Name=$Value" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
}

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Set-JobOutput -Name 'target_match' -Value 'false'
  Set-JobOutput -Name 'qualified' -Value 'false'
  Write-Host 'SC004_QUAL_TARGET_MATCH=False'
  $hold = [math]::Max(0, [math]::Min(180, $NonTargetHoldSeconds))
  Write-Host "SC004_QUAL_NON_TARGET_HOLD_SECONDS=$hold"
  if ($hold -gt 0) { Start-Sleep -Seconds $hold }
  exit 0
}

Set-JobOutput -Name 'target_match' -Value 'true'
Write-Host 'SC004_QUAL_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$stopPath = Join-Path $root 'STOP'
$autostartDisabledPath = Join-Path $root 'AUTOSTART_DISABLED'
$installedRun = Join-Path $root 'runtime\windows\run-supervisor.ps1'
$holdToken = "SC004_QUALIFICATION_HOLD:$env:GITHUB_RUN_ID:$Attempt"

$ownerStop = Get-LifecycleOwnerStopState -Root $root
if ($ownerStop.blocked) {
  throw 'SC-004 live qualification refuses to override an existing Owner STOP/AUTOSTART_DISABLED.'
}

$wrapperBefore = Get-LifecycleSupervisorWrapper -Root $root
$runtimeBefore = Get-LifecyclePlannerExecutorProcess -Root $root
$chromeBefore = Get-LifecycleRobotChrome -Root $root
if (-not $chromeBefore -or -not (Test-LifecycleRobotCdp -ChromeProcess $chromeBefore -Root $root)) {
  throw 'SC-004 live qualification requires the existing healthy dedicated Robot Chrome.'
}

# A previous qualification attempt may have paused the wrapper successfully but
# failed before the legacy Recovery gate could restart it. If there is no Owner
# stop and the durable production mode is still Planner/Executor, restore the
# exact wrapper directly before starting another qualification. This does not
# clear any Owner latch and does not change project state.
if (-not $wrapperBefore) {
  $plannerExecutorState = Read-LifecycleJson (Join-Path $root 'planner-executor-state.json')
  if (
    $plannerExecutorState -and
    [string]$plannerExecutorState.mode -eq 'PLANNER_EXECUTOR_V1'
  ) {
    if (-not (Test-Path $installedRun -PathType Leaf)) {
      throw "Installed Supervisor wrapper is missing: $installedRun"
    }
    $env:RUNNER_TRACKING_ID = 'MAGASIN_SUPERVISOR_PERSISTENT'
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
      '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
      '-File',('"' + $installedRun + '"')
    )
    for ($i = 0; $i -lt 80; $i++) {
      $wrapperBefore = Get-LifecycleSupervisorWrapper -Root $root
      if ($wrapperBefore) { break }
      Start-Sleep -Milliseconds 500
    }
    if (-not $wrapperBefore) {
      throw 'SC-004 could not restore the pre-qualification production wrapper.'
    }
    for ($i = 0; $i -lt 40; $i++) {
      $runtimeBefore = Get-LifecyclePlannerExecutorProcess -Root $root
      if ($runtimeBefore) { break }
      Start-Sleep -Milliseconds 500
    }
    Write-Host 'SC004_QUAL_PREVIOUS_WRAPPER_RESTORED=True'
  }
}

Write-Host "SC004_QUAL_STATE_ROOT=$root"
Write-Host "SC004_QUAL_REVISION=$env:GITHUB_SHA"
Write-Host "SC004_QUAL_WRAPPER_WAS_ALIVE=$([bool]$wrapperBefore)"
Write-Host "SC004_QUAL_RUNTIME_WAS_ALIVE=$([bool]$runtimeBefore)"
Write-Host 'SC004_QUAL_PRODUCTION_PROJECT_STATE_MUTATED=False'

$cdpPort = 0
if ($chromeBefore.CommandLine -match '--remote-debugging-port=(\d+)') {
  $cdpPort = [int]$Matches[1]
}
if ($cdpPort -le 0) {
  throw 'Dedicated Robot Chrome has no readable CDP port.'
}

$holdCreated = $false
$nodeExit = 1
try {
  Set-Content -Path $stopPath -Value $holdToken -Encoding ascii
  $holdCreated = $true
  Write-Host 'SC004_QUAL_TEMPORARY_LIFECYCLE_PAUSE=True'

  if ($runtimeBefore) {
    $runtimePid = [int]$runtimeBefore.ProcessId
    Stop-Process -Id $runtimePid -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 20; $i++) {
      if (-not (Get-Process -Id $runtimePid -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 150
    }
    if (Get-Process -Id $runtimePid -ErrorAction SilentlyContinue) {
      throw 'SC-004 runtime process remained alive after pause request.'
    }
    if ($runtimeBefore.ProcessId) {
      Write-Host "SC004_QUAL_RUNTIME_ALREADY_PAUSED_PID=$runtimePid"
    }
  }

  for ($i = 0; $i -lt 30; $i++) {
    $wrapperNow = Get-LifecycleSupervisorWrapper -Root $root
    if (-not $wrapperNow) { break }
    Start-Sleep -Milliseconds 300
  }

  $wrapperNow = Get-LifecycleSupervisorWrapper -Root $root
  if ($wrapperNow) {
    $wrapperPid = [int]$wrapperNow.ProcessId
    Stop-Process -Id $wrapperPid -Force -ErrorAction SilentlyContinue
    Write-Host "SC004_QUAL_WRAPPER_FORCE_PAUSE_REQUESTED_PID=$wrapperPid"
  }

  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-LifecycleSupervisorWrapper -Root $root)) { break }
    Start-Sleep -Milliseconds 250
  }
  if (Get-LifecycleSupervisorWrapper -Root $root) {
    throw 'Supervisor wrapper could not be paused for isolated SC-004 qualification.'
  }

  $chromeDuring = Get-LifecycleRobotChrome -Root $root
  if (-not $chromeDuring -or -not (Test-LifecycleRobotCdp -ChromeProcess $chromeDuring -Root $root)) {
    throw 'Dedicated Robot Chrome did not survive the temporary runtime pause.'
  }

  $env:SUPERVISOR_SC004_CDP_URL = "http://127.0.0.1:$cdpPort"
  Write-Host "SC004_QUAL_CDP_PORT=$cdpPort"
  Write-Host 'SC004_QUAL_CDP_HEALTHY_AFTER_PAUSE=True'

  $script = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc004-live-qualification.mjs'
  if (-not (Test-Path $script -PathType Leaf)) {
    throw "Missing SC-004 qualification script: $script"
  }

  & node $script $root $env:GITHUB_SHA
  $nodeExit = $LASTEXITCODE
} finally {
  $safeToResume = $false
  if ($holdCreated -and (Test-Path $stopPath -PathType Leaf)) {
    $currentStop = [string](Get-Content $stopPath -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($currentStop -eq $holdToken -and -not (Test-Path $autostartDisabledPath)) {
      Remove-Item $stopPath -Force -ErrorAction Stop
      $safeToResume = $true
      Write-Host 'SC004_QUAL_TEMPORARY_LIFECYCLE_PAUSE_CLEARED=True'
    } else {
      Write-Host 'SC004_QUAL_OWNER_LIFECYCLE_CHANGED_DURING_TEST=True'
    }
  }

  if ($wrapperBefore -and $safeToResume) {
    if (-not (Test-Path $installedRun -PathType Leaf)) {
      throw "Installed Supervisor wrapper is missing: $installedRun"
    }

    # Restore the exact wrapper that qualification temporarily paused. Do not
    # call start-supervisor -Recovery here: that path intentionally applies
    # lane-intent gates and can refuse even though the wrapper was alive before
    # this qualification. Direct wrapper restoration changes no Owner latches.
    $env:RUNNER_TRACKING_ID = 'MAGASIN_SUPERVISOR_PERSISTENT'
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
      '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
      '-File',('"' + $installedRun + '"')
    )

    for ($i = 0; $i -lt 80; $i++) {
      if (Get-LifecycleSupervisorWrapper -Root $root) { break }
      Start-Sleep -Milliseconds 500
    }
    if (-not (Get-LifecycleSupervisorWrapper -Root $root)) {
      throw 'Supervisor wrapper did not recover after SC-004 qualification.'
    }
    Write-Host 'SC004_QUAL_PRODUCTION_WRAPPER_RECOVERED=True'
  }
}

if ($nodeExit -ne 0) {
  throw "SC-004 live qualification failed with exit code $nodeExit"
}

Set-JobOutput -Name 'qualified' -Value 'true'
Write-Host 'SC004_QUAL_QUALIFIED=True'
