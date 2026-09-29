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
function Get-FreeQualificationCdpPort {
  foreach ($candidate in 9222..9232) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $listener) { return [int]$candidate }
  }
  throw 'No free Supervisor CDP port is available.'
}

function Ensure-QualificationChrome([string]$Root) {
  $profile = Join-Path $Root 'browser_profile'
  $existing = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" })

  foreach ($proc in $existing) {
    if ($proc.CommandLine -match '--remote-debugging-port=(\d+)') {
      $port = [int]$Matches[1]
      try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
        if ($version.webSocketDebuggerUrl) { return $port }
      } catch {}
    }
  }

  foreach ($proc in $existing) {
    Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500

  $chromeCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  $chrome = $chromeCandidates |
    Where-Object { $_ -and (Test-Path $_ -PathType Leaf) } |
    Select-Object -First 1
  if (-not $chrome) { throw 'Installed Google Chrome not found.' }

  $port = Get-FreeQualificationCdpPort
  Start-Process -FilePath $chrome -WindowStyle Minimized -ArgumentList @(
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
    'about:blank'
  )

  for ($i = 0; $i -lt 40; $i++) {
    try {
      $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
      if ($version.webSocketDebuggerUrl) { return $port }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  throw 'Dedicated Supervisor Chrome did not expose a healthy CDP endpoint.'
}

Write-Host "SC010_QUAL_ATTEMPT=$Attempt"
Write-Host "SC010_QUAL_MACHINE=$env:COMPUTERNAME"

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Set-JobOutput 'target_match' 'false'
  Set-JobOutput 'qualified' 'false'
  Write-Host 'SC010_QUAL_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}

Set-JobOutput 'target_match' 'true'
Write-Host 'SC010_QUAL_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$stopPath = Join-Path $root 'STOP'
$autostartDisabledPath = Join-Path $root 'AUTOSTART_DISABLED'
$installedRun = Join-Path $root 'runtime\windows\run-supervisor.ps1'
$holdToken = "SC010_QUALIFICATION_HOLD:$env:GITHUB_RUN_ID:$Attempt"

$ownerStop = Get-LifecycleOwnerStopState -Root $root
if ($ownerStop.blocked) {
  throw 'SC-010 qualification refuses to override Owner STOP/AUTOSTART_DISABLED.'
}

$wrapperBefore = Get-LifecycleSupervisorWrapper -Root $root
$truthBefore = Get-LifecycleProcessTruth -Root $root
Write-Host "SC010_QUAL_STATE_ROOT=$root"
Write-Host "SC010_QUAL_WRAPPER_WAS_ALIVE=$([bool]$wrapperBefore)"
Write-Host "SC010_QUAL_RUNTIME_MODE_BEFORE=$([string]$truthBefore.runtime_mode)"

$holdCreated = $false
$nodeExit = 1

try {
  Set-Content -Path $stopPath -Value $holdToken -Encoding ascii
  $holdCreated = $true
  Write-Host 'SC010_QUAL_TEMPORARY_LIFECYCLE_PAUSE=True'

  if ($wrapperBefore) {
    $wrapperPid = [int]$wrapperBefore.ProcessId
    & taskkill.exe /PID $wrapperPid /T /F | Out-Host
    Start-Sleep -Milliseconds 700
  }

  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-LifecycleSupervisorWrapper -Root $root)) { break }
    Start-Sleep -Milliseconds 250
  }
  if (Get-LifecycleSupervisorWrapper -Root $root) {
    throw 'SC-010 could not pause production wrapper.'
  }

  $installer = Join-Path $env:GITHUB_WORKSPACE 'windows\install-supervisor.ps1'
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer -SourceRoot $env:GITHUB_WORKSPACE
  if ($LASTEXITCODE -ne 0) {
    throw "SC-010 candidate install failed with exit code $LASTEXITCODE"
  }
  Write-Host 'SC010_QUAL_CANDIDATE_INSTALLED=True'

  $cdpPort = Ensure-QualificationChrome -Root $root
  $env:SUPERVISOR_SC010_CDP_URL = "http://127.0.0.1:$cdpPort"
  Write-Host "SC010_QUAL_CDP_PORT=$cdpPort"
  Write-Host 'SC010_QUAL_CDP_HEALTHY=True'

  $script = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc010-live-qualification.mjs'
  & node $script $root $env:GITHUB_SHA
  $nodeExit = $LASTEXITCODE
} finally {
  $safeToResume = $false
  if ($holdCreated -and (Test-Path $stopPath -PathType Leaf)) {
    $currentStop = [string](Get-Content $stopPath -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($currentStop -eq $holdToken -and -not (Test-Path $autostartDisabledPath)) {
      Remove-Item $stopPath -Force -ErrorAction Stop
      $safeToResume = $true
      Write-Host 'SC010_QUAL_TEMPORARY_LIFECYCLE_PAUSE_CLEARED=True'
    } else {
      Write-Host 'SC010_QUAL_OWNER_LIFECYCLE_CHANGED_DURING_TEST=True'
    }
  }

  if ($wrapperBefore -and $safeToResume) {
    $env:RUNNER_TRACKING_ID = 'MAGASIN_SUPERVISOR_PERSISTENT'
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
      '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
      '-File',('"' + $installedRun + '"')
    )

    for ($i = 0; $i -lt 60; $i++) {
      if (Get-LifecycleSupervisorWrapper -Root $root) { break }
      Start-Sleep -Milliseconds 500
    }
    if (-not (Get-LifecycleSupervisorWrapper -Root $root)) {
      throw 'SC-010 production wrapper did not recover after qualification.'
    }
    Write-Host 'SC010_QUAL_PRODUCTION_WRAPPER_RECOVERED=True'
  }
}

if ($nodeExit -ne 0) {
  throw "SC-010 live qualification failed with exit code $nodeExit"
}

Set-JobOutput 'qualified' 'true'
Write-Host 'SC010_QUAL_QUALIFIED=True'
