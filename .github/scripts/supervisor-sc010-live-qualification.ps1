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
Set-JobOutput 'target_match' 'false'
Set-JobOutput 'qualified' 'false'

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Host 'SC010_QUAL_TARGET_MATCH=False'
  $hold=[math]::Max(0,[math]::Min(180,$NonTargetHoldSeconds))
  if ($hold -gt 0) { Start-Sleep -Seconds $hold }
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

function Get-DedicatedChrome([string]$Root) {
  $profile=Join-Path $Root 'browser_profile'
  return @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" })
}

function Get-FreePort {
  foreach ($candidate in 9222..9232) {
    $listener=Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $listener) { return [int]$candidate }
  }
  throw 'No free Supervisor CDP port.'
}

function Restart-DedicatedChrome([string]$Root) {
  $profile=Join-Path $Root 'browser_profile'
  $existing=@(Get-DedicatedChrome -Root $Root)
  $chromeExe=[string]($existing | Where-Object { $_.ExecutablePath } | Select-Object -First 1 -ExpandProperty ExecutablePath)
  if ([string]::IsNullOrWhiteSpace($chromeExe)) {
    $chromeExe=[string](@(
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
      "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    ) | Where-Object { $_ -and (Test-Path $_ -PathType Leaf) } | Select-Object -First 1)
  }
  if ([string]::IsNullOrWhiteSpace($chromeExe)) { throw 'Chrome not found.' }

  foreach ($p in $existing) {
    Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  for ($i=0;$i -lt 40;$i++) {
    if (@(Get-DedicatedChrome -Root $Root).Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  }

  $port=Get-FreePort
  Start-Process -FilePath $chromeExe -WindowStyle Minimized -ArgumentList @(
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

  for ($i=0;$i -lt 50;$i++) {
    try {
      $v=Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
      if ($v.webSocketDebuggerUrl) { return [int]$port }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  throw 'Dedicated Chrome CDP did not become healthy.'
}

$ownerStop=Get-LifecycleOwnerStopState -Root $root
if ($ownerStop.blocked) {
  throw 'SC-010 qualification refuses to override Owner STOP/AUTOSTART_DISABLED.'
}

$wrapperBefore=Get-LifecycleSupervisorWrapper -Root $root
$runtimeBefore=Get-LifecycleSingleConversationProcess -Root $root
Write-Host "SC010_QUAL_STATE_ROOT=$root"
Write-Host "SC010_QUAL_REVISION=$env:GITHUB_SHA"
Write-Host "SC010_QUAL_WRAPPER_WAS_ALIVE=$([bool]$wrapperBefore)"
Write-Host "SC010_QUAL_RUNTIME_WAS_ALIVE=$([bool]$runtimeBefore)"
Write-Host 'SC010_QUAL_PRODUCTION_PROJECT_STATE_MUTATED=False'

$holdCreated=$false
$nodeExit=1
$installedCandidate=$false

try {
  Set-Content -Path $stopPath -Value $holdToken -Encoding ascii
  $holdCreated=$true
  Write-Host 'SC010_QUAL_TEMPORARY_LIFECYCLE_PAUSE=True'

  if ($runtimeBefore) {
    Stop-Process -Id ([int]$runtimeBefore.ProcessId) -Force -ErrorAction SilentlyContinue
  }

  for ($i=0;$i -lt 30;$i++) {
    if (-not (Get-LifecycleSupervisorWrapper -Root $root)) { break }
    Start-Sleep -Milliseconds 300
  }
  $wrapperNow=Get-LifecycleSupervisorWrapper -Root $root
  if ($wrapperNow) {
    Stop-Process -Id ([int]$wrapperNow.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  for ($i=0;$i -lt 20;$i++) {
    if (-not (Get-LifecycleSupervisorWrapper -Root $root)) { break }
    Start-Sleep -Milliseconds 250
  }
  if (Get-LifecycleSupervisorWrapper -Root $root) {
    throw 'Supervisor wrapper could not be paused.'
  }

  $cdpPort=Restart-DedicatedChrome -Root $root
  $env:SUPERVISOR_SC010_CDP_URL="http://127.0.0.1:$cdpPort"
  Write-Host "SC010_QUAL_CDP_PORT=$cdpPort"
  Write-Host 'SC010_QUAL_CDP_HEALTHY=True'

  $script=Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc010-live-qualification.mjs'
  & node $script $root $env:GITHUB_SHA
  $nodeExit=$LASTEXITCODE
  if ($nodeExit -ne 0) {
    throw "SC-010 live qualification failed with exit code $nodeExit"
  }

  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $env:GITHUB_WORKSPACE 'windows\install-supervisor.ps1') -SourceRoot $env:GITHUB_WORKSPACE
  if ($LASTEXITCODE -ne 0) { throw 'SC-010 candidate installation failed.' }
  $installedCandidate=$true
  Write-Host 'SC010_QUAL_CANDIDATE_INSTALLED=True'

} finally {
  $safeToResume=$false
  if ($holdCreated -and (Test-Path $stopPath -PathType Leaf)) {
    $current=[string](Get-Content $stopPath -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($current -eq $holdToken -and -not (Test-Path $autostartDisabledPath)) {
      Remove-Item $stopPath -Force -ErrorAction Stop
      $safeToResume=$true
      Write-Host 'SC010_QUAL_TEMPORARY_LIFECYCLE_PAUSE_CLEARED=True'
    } else {
      Write-Host 'SC010_QUAL_OWNER_LIFECYCLE_CHANGED_DURING_TEST=True'
    }
  }

  if ($wrapperBefore -and $safeToResume) {
    if (-not (Test-Path $installedRun -PathType Leaf)) {
      throw "Installed wrapper missing: $installedRun"
    }
    $env:RUNNER_TRACKING_ID='MAGASIN_SUPERVISOR_PERSISTENT'
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
      '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
      '-File',('"' + $installedRun + '"')
    )
    for ($i=0;$i -lt 80;$i++) {
      if (Get-LifecycleSupervisorWrapper -Root $root) { break }
      Start-Sleep -Milliseconds 500
    }
    if (-not (Get-LifecycleSupervisorWrapper -Root $root)) {
      throw 'Production wrapper did not recover after SC-010 qualification.'
    }
    Write-Host 'SC010_QUAL_PRODUCTION_WRAPPER_RECOVERED=True'
  }
}

if ($nodeExit -ne 0) { throw "SC-010 qualification failed: $nodeExit" }
if (-not $installedCandidate) { throw 'SC-010 qualified candidate was not installed.' }

Set-JobOutput 'qualified' 'true'
Write-Host 'SC010_QUAL_QUALIFIED=True'
