param(
  [Parameter(Mandatory=$true)]
  [string]$TargetComputer
)

$ErrorActionPreference = 'Stop'
if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Host 'TARGET_MATCH=False'
  exit 0
}
Write-Host 'TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$registryFile = Join-Path $root 'lane-registry.json'
$statusFile = Join-Path $root 'lane-status.json'
$configFile = Join-Path $root 'lanes.json'

foreach ($p in @($registryFile,$statusFile,$configFile)) {
  if (-not (Test-Path $p)) { throw "Missing runtime state: $p" }
}

$registry = Get-Content $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json
$status = Get-Content $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
$config = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json

Write-Host "STATUS_UPDATED_AT=$([string]$status.updated_at)"
Write-Host "SCHEDULER_MUTATION_ACTIVE=$([bool]$status.scheduler.mutation_lease_active)"
Write-Host "SCHEDULER_MUTATION_LANE=$([string]$status.scheduler.mutation_lane_id)"
if ($status.scheduler.lease_states) {
  Write-Host "ACTIVE_MUTATION_COUNT=$([int]$status.scheduler.lease_states.ACTIVE_MUTATION)"
  Write-Host "ACTIVE_OBSERVATION_COUNT=$([int]$status.scheduler.lease_states.ACTIVE_OBSERVATION)"
}

foreach ($laneCfg in @($config.lanes)) {
  $laneId = [string]$laneCfg.lane_id
  $laneState = $registry.lanes.$laneId
  $laneStatus = @($status.lanes | Where-Object { [string]$_.lane_id -eq $laneId } | Select-Object -First 1)[0]
  Write-Host "LANE=$laneId ENABLED=$([bool]$laneCfg.enabled) STATUS=$([string]$laneStatus.status) PHASE=$([string]$laneStatus.phase) TASK=$([string]$laneState.task_id) AWAITING=$([bool]$laneState.awaiting_work) DISPATCH_INFLIGHT=$($null -ne $laneState.dispatch_inflight) RELAY_INFLIGHT=$($null -ne $laneState.relay_inflight) WATCHDOG_PHASE=$([string]$laneState.work_watchdog.phase)"
}
