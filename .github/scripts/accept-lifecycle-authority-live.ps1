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
$startScript = Join-Path $runtime 'windows\start-supervisor.ps1'
$lifecycle = Join-Path $runtime 'windows\lifecycle-truth.ps1'
$configFile = Join-Path $root 'lanes.json'
$registryFile = Join-Path $root 'lane-registry.json'
$statusFile = Join-Path $root 'lane-status.json'

foreach ($p in @($startScript,$lifecycle,$configFile,$registryFile)) {
  if (-not (Test-Path $p)) { throw "Missing required path: $p" }
}

. $lifecycle

function Fingerprint {
  $cfg = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $canonical = @($cfg.lanes | Sort-Object lane_id | ForEach-Object {
    "$([string]$_.lane_id)|$([bool]$_.enabled)|$([string]$_.brain_url)|$([int]$_.brain_url_revision)|$([string]$_.work_url)|$([int]$_.work_url_revision)|$([string]$_.work_mode)"
  }) -join "`n"
  $bytes = [Text.Encoding]::UTF8.GetBytes($canonical)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

$beforeRegistry = Get-Content $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json
$beforeTask = [string]$beforeRegistry.lanes.'lane-1'.task_id
$beforeAwaiting = [bool]$beforeRegistry.lanes.'lane-1'.awaiting_work
$fingerprintBefore = Fingerprint

$truthBefore = Get-LifecycleProcessTruth -Root $root
Write-Host "PRE_WRAPPER_ALIVE=$([bool]$truthBefore.wrapper_alive)"
Write-Host "PRE_THREE_LANE_ALIVE=$([bool]$truthBefore.three_lane_alive)"
Write-Host "PRE_CHROME_ALIVE=$([bool]$truthBefore.chrome_alive)"
Write-Host "PRE_CDP_HEALTHY=$([bool]$truthBefore.cdp_healthy)"
Write-Host "PRE_TASK=$beforeTask"
Write-Host "PRE_AWAITING=$beforeAwaiting"

# The Owner stopped the robot specifically for this maintenance and then
# authorized the repair. Resume through the canonical explicit Owner START path.
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startScript -Hidden
if ($LASTEXITCODE -ne 0) { throw 'Canonical Owner START returned non-zero.' }
Write-Host 'OWNER_START_REQUESTED=True'

$healthy = $false
$fresh = $null
for ($i=0; $i -lt 90; $i++) {
  Start-Sleep -Seconds 1
  $truth = Get-LifecycleProcessTruth -Root $root
  if (Test-Path $statusFile) {
    try {
      $candidate = Get-Content $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $u = [DateTimeOffset]::MinValue
      if ([DateTimeOffset]::TryParse([string]$candidate.updated_at,[ref]$u) -and
          (([DateTimeOffset]::UtcNow - $u.ToUniversalTime()).TotalSeconds -le 20)) {
        $fresh = $candidate
      }
    } catch {}
  }
  if ($truth.healthy -and $fresh) {
    $healthy = $true
    break
  }
}

if (-not $healthy) {
  $truth = Get-LifecycleProcessTruth -Root $root
  Write-Host "POST_WRAPPER_ALIVE=$([bool]$truth.wrapper_alive)"
  Write-Host "POST_THREE_LANE_ALIVE=$([bool]$truth.three_lane_alive)"
  Write-Host "POST_CHROME_ALIVE=$([bool]$truth.chrome_alive)"
  Write-Host "POST_CDP_HEALTHY=$([bool]$truth.cdp_healthy)"
  throw 'Robot did not reach healthy fresh process truth after maintenance.'
}

$wrapper = Get-LifecycleSupervisorWrapper -Root $root
$three = Get-LifecycleThreeLaneProcess -Root $root
$orphans = @(Get-LifecycleOrphanThreeLaneProcesses -Root $root)
if (-not $wrapper -or -not $three) { throw 'Authoritative wrapper/child relation missing after start.' }
if ([int]$three.ParentProcessId -ne [int]$wrapper.ProcessId) {
  throw 'Three-Lane is not the direct child of the authoritative wrapper.'
}
if ($orphans.Count -ne 0) {
  throw "Orphan Three-Lane processes remain after start: $($orphans.Count)"
}

$afterRegistry = Get-Content $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json
$afterTask = [string]$afterRegistry.lanes.'lane-1'.task_id
$afterAwaiting = [bool]$afterRegistry.lanes.'lane-1'.awaiting_work
if ($beforeTask -ne $afterTask) { throw 'Task identity changed across maintenance start.' }
if ($beforeAwaiting -ne $afterAwaiting) { throw 'Awaiting-work state changed unexpectedly across maintenance start.' }

$fingerprintAfter = Fingerprint
if ($fingerprintBefore -ne $fingerprintAfter) {
  throw 'Brain/Work/lane target fingerprint changed across maintenance start.'
}

$lane1 = @($fresh.lanes | Where-Object { [string]$_.lane_id -eq 'lane-1' } | Select-Object -First 1)[0]
Write-Host 'POST_WRAPPER_ALIVE=True'
Write-Host 'POST_THREE_LANE_ALIVE=True'
Write-Host 'POST_CHROME_ALIVE=True'
Write-Host 'POST_CDP_HEALTHY=True'
Write-Host "WRAPPER_PID=$([int]$wrapper.ProcessId)"
Write-Host "THREE_LANE_PID=$([int]$three.ProcessId)"
Write-Host "THREE_LANE_PARENT_PID=$([int]$three.ParentProcessId)"
Write-Host 'ORPHAN_THREE_LANE_COUNT=0'
Write-Host 'FRESH_STATUS=True'
Write-Host "LANE1_STATUS=$([string]$lane1.status)"
Write-Host "LANE1_PHASE=$([string]$lane1.phase)"
Write-Host "POST_TASK=$afterTask"
Write-Host "POST_AWAITING=$afterAwaiting"
Write-Host 'TARGET_FINGERPRINT_UNCHANGED=True'
Write-Host 'LIFECYCLE_AUTHORITY_ACCEPTANCE=PASS'
