param(
  [Parameter(Mandatory=$true)]
  [string]$TargetComputer,
  [Parameter(Mandatory=$true)]
  [string]$ExpectedSha
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
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'MAGASIN BUSINESS OS CONTROL.lnk'
$panelTarget = Join-Path $runtime 'windows\control-panel.ps1'
$lifecycleTarget = Join-Path $runtime 'windows\lifecycle-truth.ps1'
$completion = Join-Path $root ("panel-authority-repair-" + $ExpectedSha + ".done")

$mutex = New-Object System.Threading.Mutex($false, 'Global\MAGASIN_PANEL_AUTHORITY_REPAIR')
$owns = $false
try {
  try {
    $owns = $mutex.WaitOne([TimeSpan]::FromMinutes(3))
  } catch [System.Threading.AbandonedMutexException] {
    $owns = $true
  }
  if (-not $owns) {
    Write-Host 'REPAIR_RESULT=SKIPPED_MUTEX_BUSY'
    exit 0
  }

  $files = @(
    'windows\control-panel.ps1',
    'windows\lifecycle-truth.ps1',
    'windows\run-supervisor.ps1',
    'windows\start-supervisor.ps1',
    'src\runtime\three-lane-cli.mjs',
    'src\runtime\work-watchdog.mjs',
    'src\runtime\lane-events.mjs',
    'src\runtime\atomic-json-write.mjs'
  )

  foreach ($rel in $files) {
    $src = Join-Path $env:GITHUB_WORKSPACE $rel
    if (-not (Test-Path $src)) { throw "Missing source file: $src" }
    $dst = Join-Path $runtime $rel
    $parent = Split-Path -Parent $dst
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  }

  function Get-PanelProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and
        $_.CommandLine -like '*control-panel.ps1*'
      })
  }

  function Get-Runner {
    $runnerRoot = [string]$env:SUPERVISOR_RUNNER_ROOT
    if ([string]::IsNullOrWhiteSpace($runnerRoot)) {
      $candidate = Join-Path $env:USERPROFILE 'actions-runner'
      if (Test-Path $candidate) { $runnerRoot = $candidate }
    }
    return Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        (-not [string]::IsNullOrWhiteSpace($runnerRoot)) -and
        (
          ($_.ExecutablePath -and $_.ExecutablePath -like "$runnerRoot*") -or
          ($_.CommandLine -and $_.CommandLine -like "*$runnerRoot*")
        )
      } |
      Select-Object -First 1
  }

  function Get-TargetFingerprint {
    $configFile = Join-Path $root 'lanes.json'
    if (-not (Test-Path $configFile)) { return 'NO_CONFIG' }
    $cfg = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $canonical = @($cfg.lanes | Sort-Object lane_id | ForEach-Object {
      "$([string]$_.lane_id)|$([bool]$_.enabled)|$([string]$_.brain_url)|$([int]$_.brain_url_revision)|$([string]$_.work_url)|$([int]$_.work_url_revision)|$([string]$_.work_mode)"
    }) -join "`n"
    $bytes = [Text.Encoding]::UTF8.GetBytes($canonical)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
  }

  $fingerprintBefore = Get-TargetFingerprint

  if (-not (Test-Path $completion)) {
    foreach ($p in (Get-PanelProcesses)) {
      Write-Host "OLD_PANEL_STOPPED=$($p.ProcessId)"
      Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 800

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $utf8Bom = New-Object System.Text.UTF8Encoding($true)
    foreach ($rel in $files) {
      $src = Join-Path $env:GITHUB_WORKSPACE $rel
      $dst = Join-Path $runtime $rel
      $content = Get-Content $src -Raw -Encoding UTF8
      if ($rel -eq 'windows\control-panel.ps1') {
        [System.IO.File]::WriteAllText($dst, $content, $utf8Bom)
      } else {
        [System.IO.File]::WriteAllText($dst, $content, $utf8NoBom)
      }
      Write-Host "DEPLOYED=$rel"
    }

    $panelSource = Get-Content $panelTarget -Raw -Encoding UTF8
    foreach ($marker in @('3 LUỒNG ĐỘC LẬP  •  RESET READY','Request-RunnerRecovery','Request-LifecycleRecovery')) {
      if ($panelSource -notmatch [regex]::Escape($marker)) {
        throw "Installed panel missing marker: $marker"
      }
    }

    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = 'powershell.exe'
    $shortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $panelTarget + '"'
    $shortcut.WorkingDirectory = $root
    $shortcut.Description = 'MAGASIN Business OS Supervisor Robot control panel'
    $shortcut.IconLocation = "$env:SystemRoot\System32\imageres.dll,72"
    $shortcut.Save()
    Write-Host "SHORTCUT_REBUILT=$shortcutPath"

    # Launch through the interactive Windows shell so the new Control Panel is
    # not owned by this GitHub Actions job and cannot be reaped by job cleanup.
    & explorer.exe $shortcutPath
    Write-Host 'PANEL_LAUNCH_VIA_EXPLORER=True'

    $panel = $null
    for ($i=0; $i -lt 30; $i++) {
      Start-Sleep -Milliseconds 500
      $panel = Get-PanelProcesses | Select-Object -First 1
      if ($panel) { break }
    }
    if (-not $panel) { throw 'Current Control Panel did not start through Explorer.' }
    Write-Host "NEW_PANEL_PID=$($panel.ProcessId)"

    Set-Content -Path $completion -Value $ExpectedSha -Encoding ascii
  } else {
    Write-Host 'REPAIR_ALREADY_APPLIED=True'
  }

  if (-not (Test-Path $lifecycleTarget)) { throw 'Installed lifecycle helper missing.' }
  . $lifecycleTarget

  $configFile = Join-Path $root 'lanes.json'
  $config = if (Test-Path $configFile) { Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
  $enabledLaneCount = if ($config) { @($config.lanes | Where-Object { [bool]$_.enabled }).Count } else { 0 }
  Write-Host "ENABLED_LANE_COUNT=$enabledLaneCount"

  # The new panel owns self-heal. Give it time to reconnect Runner and recover
  # the lifecycle if at least one lane is enabled.
  $runnerAlive = $false
  $healthy = $false
  for ($i=0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    $runnerAlive = [bool](Get-Runner)
    $truth = Get-LifecycleProcessTruth -Root $root
    if ($enabledLaneCount -gt 0) {
      if ($runnerAlive -and $truth.healthy) {
        $healthy = $true
        break
      }
    } else {
      if ($runnerAlive) { break }
    }
  }

  $truth = Get-LifecycleProcessTruth -Root $root
  $panelNow = Get-PanelProcesses | Select-Object -First 1
  if (-not $panelNow) { throw 'Control Panel is not alive after repair.' }

  Write-Host 'PANEL_CURRENT_SOURCE=True'
  Write-Host "RUNNER_ALIVE=$runnerAlive"
  Write-Host "WRAPPER_ALIVE=$([bool]$truth.wrapper_alive)"
  Write-Host "THREE_LANE_ALIVE=$([bool]$truth.three_lane_alive)"
  Write-Host "CHROME_ALIVE=$([bool]$truth.chrome_alive)"
  Write-Host "CDP_HEALTHY=$([bool]$truth.cdp_healthy)"

  if (-not $runnerAlive) { throw 'New Control Panel did not recover GitHub Runner.' }
  if ($enabledLaneCount -gt 0 -and -not $truth.healthy) {
    throw 'New Control Panel did not recover Robot lifecycle for enabled lane.'
  }

  $fingerprintAfter = Get-TargetFingerprint
  if ($fingerprintBefore -ne $fingerprintAfter) {
    throw 'Brain/Work/lane target fingerprint changed during panel authority repair.'
  }

  Write-Host 'TARGET_FINGERPRINT_UNCHANGED=True'
  Write-Host 'PANEL_AUTHORITY_REPAIR=PASS'
} finally {
  if ($owns) {
    try { $mutex.ReleaseMutex() } catch {}
  }
  $mutex.Dispose()
}
