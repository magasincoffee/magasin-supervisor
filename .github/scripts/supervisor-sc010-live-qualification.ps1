param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13',
  [int]$Attempt = 1,
  [int]$NonTargetHoldSeconds = 90
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Set-JobOutput([string]$Name, [string]$Value) {
  "$Name=$Value" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
}

Write-Host "SC010_QUAL_ATTEMPT=$Attempt"
Write-Host "SC010_QUAL_MACHINE=$env:COMPUTERNAME"
Set-JobOutput -Name 'target_match' -Value 'false'
Set-JobOutput -Name 'qualified' -Value 'false'

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Host 'SC010_QUAL_TARGET_MATCH=False'
  $hold = [math]::Max(0, [math]::Min(180, $NonTargetHoldSeconds))
  if ($hold -gt 0) { Start-Sleep -Seconds $hold }
  exit 0
}

Set-JobOutput -Name 'target_match' -Value 'true'
Write-Host 'SC010_QUAL_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$stopPath = Join-Path $root 'STOP'
$autostartDisabledPath = Join-Path $root 'AUTOSTART_DISABLED'
$installedRun = Join-Path $root 'runtime\windows\run-supervisor.ps1'
$ownerStop = Get-LifecycleOwnerStopState -Root $root
if ($ownerStop.blocked) {
  throw 'SC-010 qualification refuses to override Owner STOP/AUTOSTART_DISABLED.'
}

$wrapperBefore = Get-LifecycleSupervisorWrapper -Root $root
$runtimeBefore = Get-LifecycleSingleConversationProcess -Root $root
$chromeBefore = Get-LifecycleRobotChrome -Root $root
if (-not $chromeBefore -or -not (Test-LifecycleRobotCdp -ChromeProcess $chromeBefore -Root $root)) {
  throw 'SC-010 requires the existing authenticated dedicated Robot Chrome.'
}
if ($chromeBefore.CommandLine -notmatch '--remote-debugging-port=(\d+)') {
  throw 'SC-010 could not resolve dedicated Chrome CDP port.'
}
$cdpPort = [int]$Matches[1]
$holdToken = "SC010_QUALIFICATION_HOLD:$env:GITHUB_RUN_ID:$Attempt"
$holdCreated = $false
$nodeExit = 1

Write-Host "SC010_QUAL_STATE_ROOT=$root"
Write-Host "SC010_QUAL_REVISION=$env:GITHUB_SHA"
Write-Host "SC010_QUAL_WRAPPER_WAS_ALIVE=$([bool]$wrapperBefore)"
Write-Host "SC010_QUAL_RUNTIME_WAS_ALIVE=$([bool]$runtimeBefore)"
Write-Host 'SC010_QUAL_PRODUCTION_PROJECT_STATE_MUTATED=False'

try {
  Set-Content -Path $stopPath -Value $holdToken -Encoding ascii
  $holdCreated = $true
  Write-Host 'SC010_QUAL_TEMPORARY_LIFECYCLE_PAUSE=True'

  if ($runtimeBefore) {
    Stop-Process -Id ([int]$runtimeBefore.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  if ($wrapperBefore) {
    Start-Sleep -Milliseconds 500
    $wrapperNow = Get-LifecycleSupervisorWrapper -Root $root
    if ($wrapperNow) {
      & taskkill.exe /PID ([int]$wrapperNow.ProcessId) /T /F | Out-Host
    }
  }

  for ($i = 0; $i -lt 30; $i++) {
    if (
      -not (Get-LifecycleSupervisorWrapper -Root $root) -and
      -not (Get-LifecycleSingleConversationProcess -Root $root)
    ) { break }
    Start-Sleep -Milliseconds 250
  }
  if ((Get-LifecycleSupervisorWrapper -Root $root) -or (Get-LifecycleSingleConversationProcess -Root $root)) {
    throw 'SC-010 could not isolate the production wrapper/runtime.'
  }

  $chromeDuring = Get-LifecycleRobotChrome -Root $root
  if (-not $chromeDuring -or -not (Test-LifecycleRobotCdp -ChromeProcess $chromeDuring -Root $root)) {
    throw 'Dedicated Robot Chrome did not survive SC-010 runtime pause.'
  }

  $env:SUPERVISOR_SC010_CDP_URL = "http://127.0.0.1:$cdpPort"
  $script = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc010-live-qualification.mjs'
  & node $script $root $env:GITHUB_SHA
  $nodeExit = $LASTEXITCODE
} finally {
  $safeToResume = $false
  if ($holdCreated -and (Test-Path $stopPath -PathType Leaf)) {
    $current = [string](Get-Content $stopPath -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($current -eq $holdToken -and -not (Test-Path $autostartDisabledPath)) {
      Remove-Item $stopPath -Force -ErrorAction Stop
      $safeToResume = $true
      Write-Host 'SC010_QUAL_TEMPORARY_LIFECYCLE_PAUSE_CLEARED=True'
    }
  }

  if ($wrapperBefore -and $safeToResume) {
    if (-not (Test-Path $installedRun -PathType Leaf)) {
      throw "Installed Supervisor wrapper is missing: $installedRun"
    }
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
      throw 'SC-010 could not restore the pre-qualification wrapper.'
    }
    Write-Host 'SC010_QUAL_PRODUCTION_WRAPPER_RECOVERED=True'
  }
}

if ($nodeExit -ne 0) {
  throw "SC-010 live qualification failed with exit code $nodeExit"
}

Set-JobOutput -Name 'qualified' -Value 'true'
Write-Host 'SC010_QUAL_QUALIFIED=True'
