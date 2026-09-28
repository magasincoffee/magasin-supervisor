param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13',
  [int]$Attempt = 1,
  [int]$NonTargetHoldSeconds = 90
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Write-Host "SC003_QUAL_ATTEMPT=$Attempt"
Write-Host "SC003_QUAL_MACHINE=$env:COMPUTERNAME"

if ([string]::IsNullOrWhiteSpace([string]$env:GITHUB_OUTPUT)) {
  throw 'GITHUB_OUTPUT is unavailable.'
}

function Set-JobOutput([string]$Name, [string]$Value) {
  "$Name=$Value" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
}

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Set-JobOutput -Name 'target_match' -Value 'false'
  Set-JobOutput -Name 'qualified' -Value 'false'
  Write-Host 'SC003_QUAL_TARGET_MATCH=False'
  $hold = [math]::Max(0, [math]::Min(180, $NonTargetHoldSeconds))
  Write-Host "SC003_QUAL_NON_TARGET_HOLD_SECONDS=$hold"
  if ($hold -gt 0) { Start-Sleep -Seconds $hold }
  exit 0
}

Set-JobOutput -Name 'target_match' -Value 'true'
Write-Host 'SC003_QUAL_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$stopPath = Join-Path $root 'STOP'
$autostartDisabledPath = Join-Path $root 'AUTOSTART_DISABLED'
$installedStart = Join-Path $root 'runtime\windows\start-supervisor.ps1'
$holdToken = "SC003_QUALIFICATION_HOLD:$env:GITHUB_RUN_ID:$Attempt"

$ownerStop = Get-LifecycleOwnerStopState -Root $root
if ($ownerStop.blocked) {
  throw 'SC-003 live qualification refuses to override an existing Owner STOP/AUTOSTART_DISABLED.'
}

$wrapperBefore = Get-LifecycleSupervisorWrapper -Root $root
$runtimeBefore = Get-LifecyclePlannerExecutorProcess -Root $root
$chromeBefore = Get-LifecycleRobotChrome -Root $root
if (-not $chromeBefore -or -not (Test-LifecycleRobotCdp -ChromeProcess $chromeBefore -Root $root)) {
  throw 'SC-003 live qualification requires the existing healthy dedicated Robot Chrome.'
}

Write-Host "SC003_QUAL_STATE_ROOT=$root"
Write-Host "SC003_QUAL_REVISION=$env:GITHUB_SHA"
Write-Host "SC003_QUAL_WRAPPER_WAS_ALIVE=$([bool]$wrapperBefore)"
Write-Host "SC003_QUAL_RUNTIME_WAS_ALIVE=$([bool]$runtimeBefore)"
Write-Host 'SC003_QUAL_PRODUCTION_PROJECT_STATE_MUTATED=False'

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
  Write-Host 'SC003_QUAL_TEMPORARY_LIFECYCLE_PAUSE=True'

  if ($runtimeBefore) {
    Stop-Process -Id ([int]$runtimeBefore.ProcessId) -Force -ErrorAction Stop
    Write-Host "SC003_QUAL_RUNTIME_PAUSED_PID=$($runtimeBefore.ProcessId)"
  }

  for ($i = 0; $i -lt 30; $i++) {
    $wrapperNow = Get-LifecycleSupervisorWrapper -Root $root
    if (-not $wrapperNow) { break }
    Start-Sleep -Milliseconds 300
  }

  $wrapperNow = Get-LifecycleSupervisorWrapper -Root $root
  if ($wrapperNow) {
    Stop-Process -Id ([int]$wrapperNow.ProcessId) -Force -ErrorAction Stop
    Write-Host "SC003_QUAL_WRAPPER_FORCE_PAUSED_PID=$($wrapperNow.ProcessId)"
  }

  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-LifecycleSupervisorWrapper -Root $root)) { break }
    Start-Sleep -Milliseconds 250
  }
  if (Get-LifecycleSupervisorWrapper -Root $root) {
    throw 'Supervisor wrapper could not be paused for isolated SC-003 qualification.'
  }

  $chromeDuring = Get-LifecycleRobotChrome -Root $root
  if (-not $chromeDuring -or -not (Test-LifecycleRobotCdp -ChromeProcess $chromeDuring -Root $root)) {
    throw 'Dedicated Robot Chrome did not survive the temporary runtime pause.'
  }

  $env:SUPERVISOR_SC003_CDP_URL = "http://127.0.0.1:$cdpPort"
  Write-Host "SC003_QUAL_CDP_PORT=$cdpPort"
  Write-Host 'SC003_QUAL_CDP_HEALTHY_AFTER_PAUSE=True'

  $script = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc003-live-qualification.mjs'
  if (-not (Test-Path $script -PathType Leaf)) {
    throw "Missing SC-003 qualification script: $script"
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
      Write-Host 'SC003_QUAL_TEMPORARY_LIFECYCLE_PAUSE_CLEARED=True'
    } else {
      Write-Host 'SC003_QUAL_OWNER_LIFECYCLE_CHANGED_DURING_TEST=True'
    }
  }

  if ($wrapperBefore -and $safeToResume) {
    if (-not (Test-Path $installedStart -PathType Leaf)) {
      throw "Installed recovery start script is missing: $installedStart"
    }
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installedStart -Hidden -Recovery
    if ($LASTEXITCODE -ne 0) {
      throw 'Supervisor recovery start failed after SC-003 qualification.'
    }

    for ($i = 0; $i -lt 40; $i++) {
      if (Get-LifecycleSupervisorWrapper -Root $root) { break }
      Start-Sleep -Milliseconds 500
    }
    if (-not (Get-LifecycleSupervisorWrapper -Root $root)) {
      throw 'Supervisor wrapper did not recover after SC-003 qualification.'
    }
    Write-Host 'SC003_QUAL_PRODUCTION_WRAPPER_RECOVERED=True'
  }
}

if ($nodeExit -ne 0) {
  throw "SC-003 live qualification failed with exit code $nodeExit"
}

Set-JobOutput -Name 'qualified' -Value 'true'
Write-Host 'SC003_QUAL_QUALIFIED=True'
