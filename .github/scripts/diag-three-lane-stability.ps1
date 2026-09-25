param(
    [Parameter(Mandatory=$true)]
    [string]$TargetComputer
)

$ErrorActionPreference = 'Stop'

if ($env:COMPUTERNAME -ne $TargetComputer) {
    Write-Host 'TARGET_MATCH=False'
    Write-Host 'TARGET_SKIP_SAFE=True'
    exit 0
}
Write-Host 'TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime = Join-Path $root 'runtime'
$lifecycle = Join-Path $runtime 'windows\lifecycle-truth.ps1'
$configFile = Join-Path $root 'lanes.json'
$statusFile = Join-Path $root 'lane-status.json'
$registryFile = Join-Path $root 'lane-registry.json'
$eventFile = Join-Path $root 'lane-events.ndjson'

foreach ($required in @($lifecycle,$configFile,$statusFile,$registryFile)) {
    if (-not (Test-Path $required)) {
        throw "Required runtime state is missing: $required"
    }
}

. $lifecycle
$truth = Get-LifecycleProcessTruth -Root $root
$config = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$status = Get-Content $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
$registry = Get-Content $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json

$lane1Status = @($status.lanes | Where-Object { [string]$_.lane_id -eq 'lane-1' } | Select-Object -First 1)[0]
$lane1Registry = $registry.lanes.'lane-1'
$lane1Config = @($config.lanes | Where-Object { [string]$_.lane_id -eq 'lane-1' } | Select-Object -First 1)[0]

$updated = [DateTimeOffset]::MinValue
$statusAge = -1
if ([DateTimeOffset]::TryParse([string]$status.updated_at, [ref]$updated)) {
    $statusAge = [Math]::Max(0,[Math]::Floor(([DateTimeOffset]::UtcNow - $updated.ToUniversalTime()).TotalSeconds))
}

Write-Host "WRAPPER_ALIVE=$([bool]$truth.wrapper_alive)"
Write-Host "THREE_LANE_ALIVE=$([bool]$truth.three_lane_alive)"
Write-Host "CHROME_ALIVE=$([bool]$truth.chrome_alive)"
Write-Host "CDP_HEALTHY=$([bool]$truth.cdp_healthy)"
Write-Host "STATUS_AGE_SECONDS=$statusAge"
Write-Host "LANE1_ENABLED=$([bool]$lane1Config.enabled)"
Write-Host "LANE1_STATUS=$([string]$lane1Status.status)"
if ($lane1Status.PSObject.Properties['phase']) {
    Write-Host "LANE1_PHASE=$([string]$lane1Status.phase)"
}
Write-Host "TASK_PRESENT=$(-not [string]::IsNullOrWhiteSpace([string]$lane1Registry.task_id))"
Write-Host "AWAITING_WORK=$([bool]$lane1Registry.awaiting_work)"
Write-Host "BRAIN_REQUEST_SENT=$([bool]$lane1Registry.brain_request_sent)"
Write-Host "BRAIN_REQUEST_INFLIGHT=$($null -ne $lane1Registry.brain_request_inflight)"
Write-Host "DISPATCH_INFLIGHT=$($null -ne $lane1Registry.dispatch_inflight)"
Write-Host "RELAY_INFLIGHT=$($null -ne $lane1Registry.relay_inflight)"
Write-Host "WORK_GENERATION=$([int]$lane1Registry.work_generation)"
if ($lane1Registry.PSObject.Properties['brain_target_health'] -and $lane1Registry.brain_target_health) {
    Write-Host "BRAIN_HEALTH=$([string]$lane1Registry.brain_target_health.state)"
}
if ($lane1Registry.PSObject.Properties['work_target_health'] -and $lane1Registry.work_target_health) {
    Write-Host "WORK_HEALTH=$([string]$lane1Registry.work_target_health.state)"
}
if ($lane1Status.PSObject.Properties['error_name'] -and $lane1Status.error_name) {
    Write-Host "LANE1_ERROR_NAME=$([string]$lane1Status.error_name)"
}

if (Test-Path $eventFile) {
    $tail = @(Get-Content $eventFile -Tail 20 -ErrorAction SilentlyContinue)
    $safeEvents = @()
    foreach ($line in $tail) {
        try {
            $e = $line | ConvertFrom-Json
            $safeEvents += "$([string]$e.event_type)|$([string]$e.phase)|$([string]$e.reason_code)"
        } catch {}
    }
    if ($safeEvents.Count -gt 0) {
        Write-Host ('RECENT_EVENTS=' + ($safeEvents -join ';'))
    }
}

if (-not $truth.wrapper_alive -or -not $truth.three_lane_alive -or -not $truth.chrome_alive -or -not $truth.cdp_healthy) {
    throw 'Runtime process truth is not healthy.'
}
if ($statusAge -lt 0 -or $statusAge -gt 30) {
    throw 'Lane status heartbeat is stale.'
}

Write-Host 'THREE_LANE_STABILITY_CHECK=PASS'
