param(
  [Parameter(Mandatory=$true)]
  [string]$TargetComputer
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Host 'TARGET_MATCH=False'
  Write-Host 'TARGET_SKIP_SAFE=True'
  exit 0
}
Write-Host 'TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime = Join-Path $root 'runtime'
$configFile = Join-Path $root 'lanes.json'
$registryFile = Join-Path $root 'lane-registry.json'
$pidFile = Join-Path $root 'supervisor.pid'
$stopFile = Join-Path $root 'STOP'
$autostartDisabled = Join-Path $root 'AUTOSTART_DISABLED'
$profile = Join-Path $root 'browser_profile'

if (-not (Test-Path $configFile)) { throw "Missing lane config: $configFile" }
if (-not (Test-Path $registryFile)) { throw "Missing lane registry: $registryFile" }

$configBefore = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$enabledCount = @($configBefore.lanes | Where-Object { [bool]$_.enabled }).Count
Write-Host "ENABLED_LANES_BEFORE=$enabledCount"
if ($enabledCount -ne 0) {
  Write-Host 'DEPLOYMENT_RESULT=DEFERRED_LANES_STILL_ENABLED'
  exit 0
}

$stopBefore = [bool](Test-Path $stopFile)
$autoStopBefore = [bool](Test-Path $autostartDisabled)
Write-Host "OWNER_STOP_BEFORE=$stopBefore"
Write-Host "AUTOSTART_DISABLED_BEFORE=$autoStopBefore"

function Get-TargetFingerprint([string]$Path) {
  $config = Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  $canonical = @($config.lanes | Sort-Object lane_id | ForEach-Object {
    "$([string]$_.lane_id)|$([bool]$_.enabled)|$([string]$_.brain_url)|$([int]$_.brain_url_revision)|$([string]$_.work_url)|$([int]$_.work_url_revision)|$([string]$_.work_mode)"
  }) -join "`n"
  $bytes = [Text.Encoding]::UTF8.GetBytes($canonical)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-ThreeLaneNodes {
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*three-lane-cli.mjs*' })
}

function Get-RootWrappers {
  return @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like '*run-supervisor.ps1*' -and
      $_.CommandLine -like "*$root*"
    })
}

function Stop-DedicatedChrome {
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
    ForEach-Object { Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue }
}

$fingerprintBefore = Get-TargetFingerprint $configFile
$nodesBefore = @(Get-ThreeLaneNodes)
$wrappersBefore = @(Get-RootWrappers)
Write-Host "WRAPPER_COUNT_BEFORE=$($wrappersBefore.Count)"
Write-Host "THREE_LANE_COUNT_BEFORE=$($nodesBefore.Count)"
foreach ($n in $nodesBefore) {
  Write-Host "THREE_LANE_BEFORE_PID=$($n.ProcessId) PARENT=$($n.ParentProcessId)"
}

# Install exact checked-out main. Installer stops existing Wrapper/Node/Control Panel
# but preserves lane config, registry, STOP and AUTOSTART_DISABLED.
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $env:GITHUB_WORKSPACE 'windows\install-supervisor.ps1') -SourceRoot $env:GITHUB_WORKSPACE
if ($LASTEXITCODE -ne 0) { throw 'install-supervisor.ps1 failed.' }

$installedLifecycle = Join-Path $runtime 'windows\lifecycle-truth.ps1'
$installedStart = Join-Path $runtime 'windows\start-supervisor.ps1'
$installedPanel = Join-Path $runtime 'windows\control-panel.ps1'
foreach ($p in @($installedLifecycle,$installedStart,$installedPanel)) {
  if (-not (Test-Path $p)) { throw "Installed runtime missing: $p" }
}
. $installedLifecycle

# Verify deployed files are exact source, allowing only the installer's UTF-8 BOM
# normalization for control-panel.ps1.
foreach ($rel in @(
  'windows\run-supervisor.ps1',
  'windows\lifecycle-truth.ps1',
  'src\runtime\three-lane-cli.mjs'
)) {
  $source = Join-Path $env:GITHUB_WORKSPACE $rel
  $target = Join-Path $runtime $rel
  if ((Get-FileHash -Algorithm SHA256 $source).Hash -ne (Get-FileHash -Algorithm SHA256 $target).Hash) {
    throw "Installed hash mismatch: $rel"
  }
}
$panelInstalledText = Get-Content $installedPanel -Raw -Encoding UTF8
foreach ($marker in @(
  'function Request-RunnerRecovery',
  'GITHUB ĐANG TỰ KẾT NỐI',
  'runnerRecoveryBackoffSeconds'
)) {
  if ($panelInstalledText -notmatch [regex]::Escape($marker)) {
    throw "Installed Control Panel missing Runner self-heal marker: $marker"
  }
}
Write-Host 'INSTALLED_RUNTIME_MARKERS=PASS'

if ([bool](Test-Path $stopFile) -ne $stopBefore) { throw 'STOP latch changed during install.' }
if ([bool](Test-Path $autostartDisabled) -ne $autoStopBefore) { throw 'AUTOSTART_DISABLED latch changed during install.' }

$nodesAfterInstall = @(Get-ThreeLaneNodes)
$wrappersAfterInstall = @(Get-RootWrappers)
Write-Host "WRAPPER_COUNT_AFTER_INSTALL=$($wrappersAfterInstall.Count)"
Write-Host "THREE_LANE_COUNT_AFTER_INSTALL=$($nodesAfterInstall.Count)"
if ($wrappersAfterInstall.Count -ne 0 -or $nodesAfterInstall.Count -ne 0) {
  throw 'Installer did not remove old Wrapper/Three-Lane processes.'
}
Write-Host 'OLD_ORPHAN_WRITERS_REMOVED=PASS'

# Live lifecycle acceptance is safe only because every lane is disabled.
if (-not $stopBefore -and -not $autoStopBefore) {
  Stop-DedicatedChrome
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installedStart -Hidden
  if ($LASTEXITCODE -ne 0) { throw 'First controlled Supervisor start failed.' }

  $truth = $null
  for ($i=0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    $truth = Get-LifecycleProcessTruth -Root $root
    if ($truth.healthy) { break }
  }
  if (-not $truth -or -not $truth.healthy) {
    throw 'Controlled Supervisor did not reach healthy process truth.'
  }

  $wrappers = @(Get-RootWrappers)
  $nodes = @(Get-ThreeLaneNodes)
  if ($wrappers.Count -ne 1) { throw "Expected one Wrapper, found $($wrappers.Count)." }
  if ($nodes.Count -ne 1) { throw "Expected one Three-Lane Node, found $($nodes.Count)." }
  if ([int]$nodes[0].ParentProcessId -ne [int]$wrappers[0].ProcessId) {
    throw 'Three-Lane Node is not the direct child of the authoritative Wrapper.'
  }
  Write-Host "FIRST_WRAPPER_PID=$($wrappers[0].ProcessId)"
  Write-Host "FIRST_NODE_PID=$($nodes[0].ProcessId)"
  Write-Host 'SINGLE_WRITER_CHILD_OWNERSHIP=PASS'

  # Simulate the failure that caused production corruption: kill only the
  # Wrapper, not its Node child. The new Node parent monitor must self-exit.
  $crashedWrapperPid = [int]$wrappers[0].ProcessId
  Stop-Process -Id $crashedWrapperPid -Force -ErrorAction Stop
  Write-Host "SIMULATED_WRAPPER_CRASH_PID=$crashedWrapperPid"

  $orphansGone = $false
  for ($i=0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 1
    if (@(Get-ThreeLaneNodes).Count -eq 0) {
      $orphansGone = $true
      break
    }
  }
  if (-not $orphansGone) {
    throw 'Three-Lane child survived Wrapper crash beyond bounded parent-loss window.'
  }
  Write-Host 'CHILD_EXIT_ON_WRAPPER_LOSS=PASS'

  # Restart and verify exactly one authority can be reconstructed.
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installedStart -Hidden
  if ($LASTEXITCODE -ne 0) { throw 'Second controlled Supervisor start failed.' }

  $truth2 = $null
  for ($i=0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    $truth2 = Get-LifecycleProcessTruth -Root $root
    if ($truth2.healthy) { break }
  }
  if (-not $truth2 -or -not $truth2.healthy) {
    throw 'Supervisor did not recover healthy after simulated Wrapper crash.'
  }

  $wrappers2 = @(Get-RootWrappers)
  $nodes2 = @(Get-ThreeLaneNodes)
  if ($wrappers2.Count -ne 1 -or $nodes2.Count -ne 1) {
    throw "Recovered runtime is not singleton: wrappers=$($wrappers2.Count), nodes=$($nodes2.Count)."
  }
  if ([int]$nodes2[0].ParentProcessId -ne [int]$wrappers2[0].ProcessId) {
    throw 'Recovered Three-Lane Node is not owned by recovered Wrapper.'
  }
  Write-Host 'RECOVERY_SINGLETON=PASS'

  # Leave production stopped exactly as requested, without creating or clearing
  # Owner STOP latches. All lanes remain disabled.
  foreach ($w in @(Get-RootWrappers)) {
    & taskkill.exe /PID ([int]$w.ProcessId) /T /F | Out-Null
  }
  Start-Sleep -Seconds 2
  foreach ($n in @(Get-ThreeLaneNodes)) {
    Stop-Process -Id ([int]$n.ProcessId -Force -ErrorAction SilentlyContinue)
  }
  Stop-DedicatedChrome
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

$fingerprintAfter = Get-TargetFingerprint $configFile
if ($fingerprintBefore -ne $fingerprintAfter) { throw 'Lane target fingerprint changed during repair.' }
$configAfter = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$enabledAfter = @($configAfter.lanes | Where-Object { [bool]$_.enabled }).Count
if ($enabledAfter -ne 0) { throw 'Repair unexpectedly enabled a lane.' }

# Relaunch only the Control Panel. With zero enabled lanes it cannot auto-start
# the Robot; the newly installed panel can still self-heal the GitHub Runner.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*control-panel.ps1*' } |
  ForEach-Object { Stop-Process -Id ([int]$_.ProcessId -Force -ErrorAction SilentlyContinue) }
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
  '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
  '-File',('"' + $installedPanel + '"')
)
Start-Sleep -Seconds 2

$finalWrappers = @(Get-RootWrappers)
$finalNodes = @(Get-ThreeLaneNodes)
Write-Host "FINAL_WRAPPER_COUNT=$($finalWrappers.Count)"
Write-Host "FINAL_THREE_LANE_COUNT=$($finalNodes.Count)"
Write-Host "FINAL_ENABLED_LANES=$enabledAfter"
Write-Host 'TARGET_FINGERPRINT_UNCHANGED=True'
Write-Host 'LIFECYCLE_SINGLE_WRITER_REPAIR=PASS'
Write-Host 'DEPLOYMENT_RESULT=PASS'
