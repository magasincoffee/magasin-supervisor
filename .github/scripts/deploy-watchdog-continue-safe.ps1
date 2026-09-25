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

$mutex = New-Object System.Threading.Mutex($false, 'Global\MAGASIN_WATCHDOG_CONTINUE_ACTIVATION')
$owns = $false
try {
  try {
    $owns = $mutex.WaitOne([TimeSpan]::FromMinutes(2))
  } catch [System.Threading.AbandonedMutexException] {
    $owns = $true
  }
  if (-not $owns) {
    Write-Host 'ACTIVATION_RESULT=DEFERRED_MUTEX_BUSY'
    exit 0
  }

  . (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
  $root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
  $runtime = Join-Path $root 'runtime'
  $registryFile = Join-Path $root 'lane-registry.json'
  $statusFile = Join-Path $root 'lane-status.json'
  $configFile = Join-Path $root 'lanes.json'
  $startScript = Join-Path $runtime 'windows\start-supervisor.ps1'
  $lifecycle = Join-Path $runtime 'windows\lifecycle-truth.ps1'
  $pidFile = Join-Path $root 'supervisor.pid'

  $files = @(
    'src\runtime\lane-events.mjs',
    'src\runtime\work-watchdog.mjs',
    'src\runtime\three-lane-cli.mjs'
  )

  foreach ($rel in $files) {
    $source = Join-Path $env:GITHUB_WORKSPACE $rel
    $target = Join-Path $runtime $rel
    if (-not (Test-Path $source)) { throw "Missing source: $source" }
    if (-not (Test-Path $target)) { throw "Missing installed runtime file: $target" }
  }
  foreach ($p in @($registryFile,$statusFile,$configFile,$startScript,$lifecycle)) {
    if (-not (Test-Path $p)) { throw "Missing runtime prerequisite: $p" }
  }

  $mainCli = Get-Content (Join-Path $env:GITHUB_WORKSPACE 'src\runtime\three-lane-cli.mjs') -Raw -Encoding UTF8
  $mainWatchdog = Get-Content (Join-Path $env:GITHUB_WORKSPACE 'src\runtime\work-watchdog.mjs') -Raw -Encoding UTF8
  foreach ($marker in @(
    'WATCHDOG_CONTINUE_INSTRUCTION = "Tiếp tục thực hiện."',
    'async function executeWatchdogContinue',
    'WATCHDOG_CONTINUE_POKE'
  )) {
    if ($mainCli -notmatch [regex]::Escape($marker)) {
      throw "Main runtime missing activation marker: $marker"
    }
  }
  foreach ($marker in @(
    'CONTINUE_ELIGIBLE',
    'beginWatchdogContinueIntent',
    'markWatchdogContinued'
  )) {
    if ($mainWatchdog -notmatch [regex]::Escape($marker)) {
      throw "Main watchdog missing activation marker: $marker"
    }
  }

  function Fingerprint([string]$Path) {
    $cfg = Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    $canonical = @($cfg.lanes | Sort-Object lane_id | ForEach-Object {
      "$([string]$_.lane_id)|$([bool]$_.enabled)|$([string]$_.brain_url)|$([int]$_.brain_url_revision)|$([string]$_.work_url)|$([int]$_.work_url_revision)|$([string]$_.work_mode)"
    }) -join "`n"
    $bytes = [Text.Encoding]::UTF8.GetBytes($canonical)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()
    } finally { $sha.Dispose() }
  }

  . $lifecycle
  $ownerStop = Get-LifecycleOwnerStopState -Root $root
  if ($ownerStop.blocked) {
    Write-Host 'ACTIVATION_RESULT=DEFERRED_OWNER_STOP'
    exit 0
  }

  $fingerprintBefore = Fingerprint $configFile
  $deadline = [DateTimeOffset]::UtcNow.AddMinutes(12)
  $safe = $false
  $reason = 'UNKNOWN'

  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    try {
      $truth = Get-LifecycleProcessTruth -Root $root
      if (-not $truth.wrapper_alive -or -not $truth.three_lane_alive) {
        $reason = 'PROCESS_TRUTH_NOT_HEALTHY'
        Start-Sleep -Seconds 5
        continue
      }

      $registry = Get-Content $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $status = Get-Content $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $config = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json

      $updated = [DateTimeOffset]::MinValue
      $fresh = [DateTimeOffset]::TryParse([string]$status.updated_at, [ref]$updated) -and
        (([DateTimeOffset]::UtcNow - $updated.ToUniversalTime()).TotalSeconds -le 45)
      if (-not $fresh) {
        $reason = 'STATUS_NOT_FRESH'
        Start-Sleep -Seconds 5
        continue
      }

      if ([bool]$status.scheduler.mutation_lease_active -or
          [int]$status.scheduler.lease_states.ACTIVE_MUTATION -gt 0) {
        $reason = 'MUTATION_ACTIVE'
        Start-Sleep -Seconds 5
        continue
      }

      $blocked = $false
      foreach ($laneCfg in @($config.lanes | Where-Object { [bool]$_.enabled })) {
        $id = [string]$laneCfg.lane_id
        $state = $registry.lanes.$id
        $laneStatus = @($status.lanes | Where-Object { [string]$_.lane_id -eq $id } | Select-Object -First 1)[0]

        if ($null -ne $state.dispatch_inflight) {
          $reason = "$id:DISPATCH_INFLIGHT"
          $blocked = $true
          break
        }
        if ($null -ne $state.relay_inflight) {
          $reason = "$id:RELAY_INFLIGHT"
          $blocked = $true
          break
        }
        if ($state.work_rollover -and [string]$state.work_rollover.stage) {
          $reason = "$id:WORK_ROLLOVER"
          $blocked = $true
          break
        }

        $phase = [string]$laneStatus.phase
        if ($phase -in @('STARTING','RECOVERING','STALL_CHECK','RECOVERY_INTENT','POST_RELOAD','CONTINUE_READY','CONTINUE_INTENT','POST_CONTINUE')) {
          $reason = "$id:TRANSITION_PHASE=$phase"
          $blocked = $true
          break
        }
      }
      if ($blocked) {
        Start-Sleep -Seconds 5
        continue
      }

      $safe = $true
      $reason = 'SAFE_BOUNDARY'
      break
    } catch {
      $reason = 'STATE_READ_RETRY'
      Start-Sleep -Seconds 5
    }
  }

  Write-Host "SAFE_BOUNDARY=$safe"
  Write-Host "SAFE_BOUNDARY_REASON=$reason"
  if (-not $safe) {
    Write-Host 'ACTIVATION_RESULT=DEFERRED_NO_SAFE_BOUNDARY'
    exit 0
  }

  $utf8 = New-Object System.Text.UTF8Encoding($false)
  foreach ($rel in $files) {
    $source = Join-Path $env:GITHUB_WORKSPACE $rel
    $target = Join-Path $runtime $rel
    $content = Get-Content $source -Raw -Encoding UTF8
    [System.IO.File]::WriteAllText($target, $content, $utf8)
    if ((Get-FileHash -Algorithm SHA256 $source).Hash -ne (Get-FileHash -Algorithm SHA256 $target).Hash) {
      throw "Installed hash mismatch: $rel"
    }
    Write-Host "DEPLOYED=$rel"
  }

  $deployedAt = [DateTimeOffset]::UtcNow
  $wrapper = Get-LifecycleSupervisorWrapper -Root $root
  if ($wrapper) {
    Stop-Process -Id ([int]$wrapper.ProcessId) -Force -ErrorAction Stop
    Write-Host 'OLD_WRAPPER_STOPPED=True'
  }

  $runtimeRoot = Join-Path $root 'runtime'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like '*three-lane-cli.mjs*' -and
      $_.CommandLine -like "*$runtimeRoot*"
    } |
    ForEach-Object {
      Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
      Write-Host 'OLD_THREE_LANE_NODE_STOPPED=True'
    }

  Start-Sleep -Milliseconds 800
  if (Test-Path $pidFile) {
    $pidText = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    $pidValue = 0
    if (-not $pidText -or
        -not [int]::TryParse([string]$pidText, [ref]$pidValue) -or
        -not (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
      Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
  }

  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startScript -Hidden -Recovery
  if ($LASTEXITCODE -ne 0) { throw 'Recovery start failed.' }

  $healthy = $false
  $freshStatus = $null
  for ($i=0; $i -lt 75; $i++) {
    Start-Sleep -Seconds 1
    $truth = Get-LifecycleProcessTruth -Root $root
    if (Test-Path $statusFile) {
      try {
        $candidate = Get-Content $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $u = [DateTimeOffset]::MinValue
        if ([DateTimeOffset]::TryParse([string]$candidate.updated_at,[ref]$u) -and
            $u.ToUniversalTime() -ge $deployedAt.AddSeconds(-2)) {
          $freshStatus = $candidate
        }
      } catch {}
    }
    if ($truth.healthy -and $freshStatus) {
      $healthy = $true
      break
    }
  }

  if (-not $healthy) { throw 'Runtime did not return to healthy fresh status after activation.' }

  $fingerprintAfter = Fingerprint $configFile
  if ($fingerprintBefore -ne $fingerprintAfter) {
    throw 'Project target fingerprint changed during activation.'
  }

  $installedCli = Get-Content (Join-Path $runtime 'src\runtime\three-lane-cli.mjs') -Raw -Encoding UTF8
  if ($installedCli -notmatch [regex]::Escape('WATCHDOG_CONTINUE_INSTRUCTION = "Tiếp tục thực hiện."')) {
    throw 'Installed runtime is missing continue watchdog marker.'
  }

  Write-Host 'POST_WRAPPER_ALIVE=True'
  Write-Host 'POST_THREE_LANE_ALIVE=True'
  Write-Host 'POST_CHROME_ALIVE=True'
  Write-Host 'POST_CDP_HEALTHY=True'
  Write-Host 'FRESH_STATUS=True'
  Write-Host 'TARGET_FINGERPRINT_UNCHANGED=True'
  Write-Host 'WATCHDOG_CONTINUE_ACTIVATION=PASS'
  Write-Host 'ACTIVATION_RESULT=PASS'
} finally {
  if ($owns) {
    try { $mutex.ReleaseMutex() } catch {}
  }
  $mutex.Dispose()
}
