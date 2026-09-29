param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13',
  [int]$Attempt = 1,
  [int]$NonTargetHoldSeconds = 90
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Write-Host "SC008_QUAL_ATTEMPT=$Attempt"
Write-Host "SC008_QUAL_MACHINE=$env:COMPUTERNAME"

if ([string]::IsNullOrWhiteSpace([string]$env:GITHUB_OUTPUT)) {
  throw 'GITHUB_OUTPUT is unavailable.'
}

function Set-JobOutput([string]$Name, [string]$Value) {
  "$Name=$Value" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
}

function Get-QualificationDedicatedChromeProcesses([string]$Root) {
  $profile = Join-Path $Root 'browser_profile'
  return @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" })
}

function Get-QualificationFreeCdpPort {
  foreach ($candidate in 9222..9232) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $listener) { return [int]$candidate }
  }
  throw 'No free Supervisor CDP port is available for qualification recovery.'
}

function Restart-QualificationDedicatedChrome([string]$Root) {
  $profile = Join-Path $Root 'browser_profile'
  $existing = @(Get-QualificationDedicatedChromeProcesses -Root $Root)
  $chromeExecutable = [string](
    $existing |
      Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.ExecutablePath) } |
      Select-Object -First 1 -ExpandProperty ExecutablePath
  )

  if ([string]::IsNullOrWhiteSpace($chromeExecutable)) {
    $chromeCandidates = @(
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
      "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    $chromeExecutable = [string](
      $chromeCandidates |
        Where-Object { $_ -and (Test-Path $_ -PathType Leaf) } |
        Select-Object -First 1
    )
  }
  if ([string]::IsNullOrWhiteSpace($chromeExecutable)) {
    throw 'Installed Google Chrome was not found for qualification CDP recovery.'
  }

  foreach ($process in $existing) {
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  for ($i = 0; $i -lt 30; $i++) {
    if (@(Get-QualificationDedicatedChromeProcesses -Root $Root).Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  }
  if (@(Get-QualificationDedicatedChromeProcesses -Root $Root).Count -gt 0) {
    throw 'Dedicated Supervisor Chrome did not stop for qualification CDP recovery.'
  }

  $port = Get-QualificationFreeCdpPort
  Start-Process -FilePath $chromeExecutable -WindowStyle Minimized -ArgumentList @(
    '--remote-debugging-address=127.0.0.1',
    "--remote-debugging-port=$port",
    ('--user-data-dir="' + $profile + '"'),
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--start-minimized',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    # Keep cold Chrome inert until CDP is healthy. The Robot performs the
    # single authoritative ChatGPT navigation after attaching, avoiding two
    # competing cold-start navigations on the same freshly opened profile.
    'about:blank'
  )

  for ($i = 0; $i -lt 40; $i++) {
    $candidate = Get-LifecycleRobotChrome -Root $Root
    if (
      $candidate -and
      $candidate.CommandLine -match ("--remote-debugging-port=" + $port + "(\s|$)") -and
      (Test-LifecycleRobotCdp -ChromeProcess $candidate -Root $Root)
    ) {
      return [int]$port
    }
    Start-Sleep -Milliseconds 500
  }
  throw 'Dedicated Supervisor Chrome did not recover a healthy CDP endpoint.'
}

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Set-JobOutput -Name 'target_match' -Value 'false'
  Set-JobOutput -Name 'qualified' -Value 'false'
  Write-Host 'SC008_QUAL_TARGET_MATCH=False'
  $hold = [math]::Max(0, [math]::Min(180, $NonTargetHoldSeconds))
  Write-Host "SC008_QUAL_NON_TARGET_HOLD_SECONDS=$hold"
  if ($hold -gt 0) { Start-Sleep -Seconds $hold }
  exit 0
}

Set-JobOutput -Name 'target_match' -Value 'true'
Write-Host 'SC008_QUAL_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$stopPath = Join-Path $root 'STOP'
$autostartDisabledPath = Join-Path $root 'AUTOSTART_DISABLED'
$installedRun = Join-Path $root 'runtime\windows\run-supervisor.ps1'
$holdToken = "SC008_QUALIFICATION_HOLD:$env:GITHUB_RUN_ID:$Attempt"

$ownerStop = Get-LifecycleOwnerStopState -Root $root
if ($ownerStop.blocked) {
  throw 'SC-008 live qualification refuses to override an existing Owner STOP/AUTOSTART_DISABLED.'
}

$wrapperBefore = Get-LifecycleSupervisorWrapper -Root $root
$truthBefore = Get-LifecycleProcessTruth -Root $root
$runtimeModeBefore = [string]$truthBefore.runtime_mode
$runtimeBefore = if ($runtimeModeBefore -eq 'SINGLE_CONVERSATION_V1') {
  Get-LifecycleSingleConversationProcess -Root $root
} elseif ($runtimeModeBefore -eq 'PLANNER_EXECUTOR_V1') {
  Get-LifecyclePlannerExecutorProcess -Root $root
} else {
  Get-LifecycleThreeLaneProcess -Root $root
}
$chromeBefore = Get-LifecycleRobotChrome -Root $root

Write-Host "SC008_QUAL_STATE_ROOT=$root"
Write-Host "SC008_QUAL_REVISION=$env:GITHUB_SHA"
Write-Host "SC008_QUAL_WRAPPER_WAS_ALIVE=$([bool]$wrapperBefore)"
Write-Host "SC008_QUAL_RUNTIME_MODE_BEFORE=$runtimeModeBefore"
Write-Host "SC008_QUAL_RUNTIME_WAS_ALIVE=$([bool]$runtimeBefore)"
Write-Host 'SC008_QUAL_PRODUCTION_PROJECT_STATE_MUTATED=False'

$holdCreated = $false
$nodeExit = 1
try {
  Set-Content -Path $stopPath -Value $holdToken -Encoding ascii
  $holdCreated = $true
  Write-Host 'SC008_QUAL_TEMPORARY_LIFECYCLE_PAUSE=True'

  if ($runtimeBefore) {
    $runtimePid = [int]$runtimeBefore.ProcessId
    Stop-Process -Id $runtimePid -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 20; $i++) {
      if (-not (Get-Process -Id $runtimePid -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 150
    }
    if (Get-Process -Id $runtimePid -ErrorAction SilentlyContinue) {
      throw 'SC-008 runtime process remained alive after pause request.'
    }
    if ($runtimeBefore.ProcessId) {
      Write-Host "SC008_QUAL_RUNTIME_ALREADY_PAUSED_PID=$runtimePid"
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
    Write-Host "SC008_QUAL_WRAPPER_FORCE_PAUSE_REQUESTED_PID=$wrapperPid"
  }

  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-LifecycleSupervisorWrapper -Root $root)) { break }
    Start-Sleep -Milliseconds 250
  }
  if (Get-LifecycleSupervisorWrapper -Root $root) {
    throw 'Supervisor wrapper could not be paused for isolated SC-008 qualification.'
  }

  # SC-008 requires a true cold browser start. Restart only the dedicated
  # Supervisor Chrome profile after the wrapper/runtime are paused. The
  # authenticated profile is preserved on disk; no Owner project state changes.
  $cdpPort = Restart-QualificationDedicatedChrome -Root $root
  $env:SUPERVISOR_SC008_CDP_URL = "http://127.0.0.1:$cdpPort"
  Write-Host 'SC008_QUAL_COLD_CHROME_RESTART=True'
  Write-Host "SC008_QUAL_CDP_PORT=$cdpPort"
  Write-Host 'SC008_QUAL_CDP_HEALTHY_AFTER_COLD_START=True'

  $script = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc008-live-qualification.mjs'
  if (-not (Test-Path $script -PathType Leaf)) {
    throw "Missing SC-008 qualification script: $script"
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
      Write-Host 'SC008_QUAL_TEMPORARY_LIFECYCLE_PAUSE_CLEARED=True'
    } else {
      Write-Host 'SC008_QUAL_OWNER_LIFECYCLE_CHANGED_DURING_TEST=True'
    }
  }

  if ($wrapperBefore -and $safeToResume) {
    if (-not (Test-Path $installedRun -PathType Leaf)) {
      throw "Installed Supervisor wrapper is missing: $installedRun"
    }

    # Restore the exact wrapper that qualification temporarily paused.
    # Direct wrapper restoration changes no Owner latches or project state.
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
      throw 'Supervisor wrapper did not recover after SC-008 qualification.'
    }
    Write-Host 'SC008_QUAL_PRODUCTION_WRAPPER_RECOVERED=True'
  }
}

if ($nodeExit -ne 0) {
  throw "SC-008 live qualification failed with exit code $nodeExit"
}

Set-JobOutput -Name 'qualified' -Value 'true'
Write-Host 'SC008_QUAL_QUALIFIED=True'
