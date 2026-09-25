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

$sourceFiles = @(
  'windows\control-panel.ps1',
  'windows\lifecycle-truth.ps1',
  'windows\run-supervisor.ps1',
  'src\runtime\three-lane-cli.mjs'
)

foreach ($rel in $sourceFiles) {
  $src = Join-Path $env:GITHUB_WORKSPACE $rel
  $dst = Join-Path $runtime $rel
  if (-not (Test-Path $src)) { throw "Missing checked-out source: $src" }
  if (-not (Test-Path (Split-Path -Parent $dst))) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  }
}

$registryFile = Join-Path $root 'lane-registry.json'
$configFile = Join-Path $root 'lanes.json'
$statusFile = Join-Path $root 'lane-status.json'
$stopFile = Join-Path $root 'STOP'
$autostartDisabled = Join-Path $root 'AUTOSTART_DISABLED'
$pidFile = Join-Path $root 'supervisor.pid'
$lifecycleInstalled = Join-Path $runtime 'windows\lifecycle-truth.ps1'

function Get-ThreeLaneProcesses {
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*three-lane-cli.mjs*' })
}

function Get-WrapperProcesses {
  return @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like '*run-supervisor.ps1*' -and
      $_.CommandLine -like "*$root*"
    })
}

function Get-TargetFingerprint {
  if (-not (Test-Path $configFile)) { return '' }
  $config = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $canonical = @($config.lanes | Sort-Object lane_id | ForEach-Object {
    "$([string]$_.lane_id)|$([bool]$_.enabled)|$([string]$_.brain_url)|$([int]$_.brain_url_revision)|$([string]$_.work_url)|$([int]$_.work_url_revision)|$([string]$_.work_mode)"
  }) -join "`n"
  $bytes = [Text.Encoding]::UTF8.GetBytes($canonical)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

$wrapperBefore = @(Get-WrapperProcesses)
$threeBefore = @(Get-ThreeLaneProcesses)
Write-Host "PRE_WRAPPER_COUNT=$($wrapperBefore.Count)"
Write-Host "PRE_THREE_LANE_COUNT=$($threeBefore.Count)"
Write-Host "OWNER_STOP_PRESENT=$(Test-Path $stopFile)"
Write-Host "AUTOSTART_DISABLED_PRESENT=$(Test-Path $autostartDisabled)"

$fingerprintBefore = Get-TargetFingerprint

# The Owner explicitly stopped the robot for maintenance. Do not clear STOP or
# AUTOSTART_DISABLED here. Reclaim stale/orphan runtime writers only.
foreach ($p in $wrapperBefore) {
  Write-Host "STOPPING_WRAPPER_PID=$($p.ProcessId)"
  Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 700

foreach ($p in @(Get-ThreeLaneProcesses)) {
  Write-Host "STOPPING_THREE_LANE_PID=$($p.ProcessId)"
  Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500

if (Test-Path $pidFile) {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($rel in $sourceFiles) {
  $src = Join-Path $env:GITHUB_WORKSPACE $rel
  $dst = Join-Path $runtime $rel
  $content = Get-Content $src -Raw -Encoding UTF8
  [System.IO.File]::WriteAllText($dst, $content, $utf8)
  if ((Get-FileHash -Algorithm SHA256 -Path $src).Hash -ne
      (Get-FileHash -Algorithm SHA256 -Path $dst).Hash) {
    throw "Installed hash mismatch: $rel"
  }
  Write-Host "DEPLOYED=$rel"
}

# Verify the production fix markers from PR #39.
$installedWrapper = Get-Content (Join-Path $runtime 'windows\run-supervisor.ps1') -Raw -Encoding UTF8
$installedLifecycle = Get-Content $lifecycleInstalled -Raw -Encoding UTF8
$installedCli = Get-Content (Join-Path $runtime 'src\runtime\three-lane-cli.mjs') -Raw -Encoding UTF8
$installedPanel = Get-Content (Join-Path $runtime 'windows\control-panel.ps1') -Raw -Encoding UTF8

foreach ($marker in @('Stop-OrphanedThreeLaneProcesses','--wrapper-pid','Stop-CurrentWrapperThreeLaneChildren')) {
  if ($installedWrapper -notmatch [regex]::Escape($marker)) { throw "Wrapper fix marker missing: $marker" }
}
foreach ($marker in @('Get-LifecycleOrphanThreeLaneProcesses','ParentProcessId')) {
  if ($installedLifecycle -notmatch [regex]::Escape($marker)) { throw "Lifecycle fix marker missing: $marker" }
}
foreach ($marker in @('armWrapperParentMonitor','process.exit(77)','--wrapper-pid')) {
  if ($installedCli -notmatch [regex]::Escape($marker)) { throw "Three-Lane fix marker missing: $marker" }
}
foreach ($marker in @('Request-RunnerRecovery','runnerRecoveryBackoffSeconds','$runner = Get-RunnerProcess')) {
  if ($installedPanel -notmatch [regex]::Escape($marker)) { throw "Control Panel runner fix marker missing: $marker" }
}

$wrapperAfter = @(Get-WrapperProcesses)
$threeAfter = @(Get-ThreeLaneProcesses)
Write-Host "POST_WRAPPER_COUNT=$($wrapperAfter.Count)"
Write-Host "POST_THREE_LANE_COUNT=$($threeAfter.Count)"

if ($wrapperAfter.Count -ne 0) { throw 'Wrapper still alive while Owner maintenance stop is active.' }
if ($threeAfter.Count -ne 0) { throw 'Orphan Three-Lane process still alive after cleanup.' }

$fingerprintAfter = Get-TargetFingerprint
if ($fingerprintBefore -ne $fingerprintAfter) {
  throw 'Brain/Work/lane target fingerprint changed during maintenance deploy.'
}

if (Test-Path $registryFile) {
  $registry = Get-Content $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($id in @('lane-1','lane-2','lane-3')) {
    if ($registry.lanes.$id) {
      Write-Host "REGISTRY_$($id)_TASK=$([string]$registry.lanes.$id.task_id)"
      Write-Host "REGISTRY_$($id)_AWAITING=$([bool]$registry.lanes.$id.awaiting_work)"
    }
  }
}

Write-Host 'TARGET_FINGERPRINT_UNCHANGED=True'
Write-Host 'OWNER_STOP_PRESERVED=True'
Write-Host 'LIFECYCLE_MAINTENANCE_DEPLOY=PASS'
