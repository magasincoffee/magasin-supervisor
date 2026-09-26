$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
Write-Host "CANONICAL_ROOT=$root"

$truth=Get-LifecycleProcessTruth -Root $root
Write-Host "WRAPPER_ALIVE=$([bool]$truth.wrapper_alive)"
Write-Host "THREE_LANE_ALIVE=$([bool]$truth.three_lane_alive)"
Write-Host "CDP_HEALTHY=$([bool]$truth.cdp_healthy)"
Write-Host "RUNTIME_HEALTHY=$([bool]$truth.healthy)"
$ownerStop=Get-LifecycleOwnerStopState -Root $root
Write-Host "OWNER_STOP_BLOCKED=$([bool]$ownerStop.blocked)"
$ownerStopReason=''
if($ownerStop.PSObject.Properties['reason']){$ownerStopReason=[string]$ownerStop.reason}
Write-Host "OWNER_STOP_REASON=$ownerStopReason"

$configPath=Join-Path $root 'lanes.json'
if(Test-Path $configPath){
  $cfg=Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach($c in @($cfg.lanes)){
    Write-Host "CONFIG_LANE=$([string]$c.lane_id)|ENABLED=$([bool]$c.enabled)|WORK_REV=$([string]$c.work_url_revision)|WORK_MODE=$([string]$c.work_mode)"
  }
}

$runtimeCli=Join-Path $root 'runtime\src\runtime\three-lane-cli.mjs'
$runtimeWatchdog=Join-Path $root 'runtime\src\runtime\work-watchdog.mjs'
$runtimeEvents=Join-Path $root 'runtime\src\runtime\lane-events.mjs'
foreach($p in @($runtimeCli,$runtimeWatchdog,$runtimeEvents)){
  if(-not (Test-Path $p)){throw "Missing installed runtime file: $p"}
}
$cliText=Get-Content $runtimeCli -Raw -Encoding UTF8
$watchdogText=Get-Content $runtimeWatchdog -Raw -Encoding UTF8
$eventsText=Get-Content $runtimeEvents -Raw -Encoding UTF8
Write-Host "FIX_PROGRESS_CHANGED=$($cliText -match [regex]::Escape('activityChanged: activity.progress_changed'))"
Write-Host "FIX_ACTION_NOT_READY=$($cliText -match [regex]::Escape('ACTION_NOT_READY'))"
Write-Host "FIX_STALE_RUNNING_GUARD=$($watchdogText -match [regex]::Escape('responseRunningFresh'))"
Write-Host "FIX_PROGRESS_FIELD=$($eventsText -match [regex]::Escape('progress_changed'))"

$registryPath=Join-Path $root 'lane-registry.json'
$statusPath=Join-Path $root 'lane-status.json'
if(-not (Test-Path $registryPath)){throw 'lane-registry.json missing'}
$reg=Get-Content $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach($laneId in @('lane-1','lane-2','lane-3')){
  $lane=$reg.lanes.$laneId
  if(-not $lane){continue}
  $phase=''
  $reloads=''
  $continues=''
  $lastActivity=''
  if($lane.work_watchdog){
    $phase=[string]$lane.work_watchdog.phase
    $reloads=[string]$lane.work_watchdog.reload_count
    $continues=[string]$lane.work_watchdog.continue_count
  }
  if($lane.task_timing){$lastActivity=[string]$lane.task_timing.last_activity_at}
  Write-Host "LANE=$laneId|TASK=$([string]$lane.task_id)|AWAITING=$([bool]$lane.awaiting_work)|PHASE=$phase|LAST_ACTIVITY=$lastActivity|RELOADS=$reloads|CONTINUES=$continues|DISPATCH=$([string]$lane.last_dispatch_id)"
}
if(Test-Path $statusPath){
  $status=Get-Content $statusPath -Raw -Encoding UTF8
  Write-Host "LANE_STATUS_RAW=$status"
}
Write-Host 'POSTFIX_WATCHDOG_DIAG=PASS'


$supervisorLog=Join-Path $root 'supervisor.log'
if(Test-Path $supervisorLog){
  Get-Content $supervisorLog -Tail 300 -Encoding UTF8 | ForEach-Object {
    try{
      $o=$_ | ConvertFrom-Json -ErrorAction Stop
      $type=[string]$o.type
      if($type -match 'TARGET_QUARANTINED|TARGET_QUARANTINE_CLEARED|LANE_ERROR|CDP|CHROME|OWNER|WORK_WATCHDOG|TARGET_REOPEN|WORK_TARGET'){
        $lane=[string]$o.laneId
        if(-not $lane){$lane=[string]$o.lane_id}
        $reason=[string]$o.reason
        $task=[string]$o.taskId
        if(-not $task){$task=[string]$o.task_id}
        Write-Host "RECENT_LOG=TYPE=$type|LANE=$lane|TASK=$task|REASON=$reason"
      }
    }catch{}
  }
}
Write-Host 'POSTFIX_WATCHDOG_DETAIL_DIAG=PASS'


if(Test-Path $supervisorLog){
  Get-Content $supervisorLog -Tail 180 -Encoding UTF8 | ForEach-Object {
    try{
      $o=$_ | ConvertFrom-Json -ErrorAction Stop
      $type=[string]$o.type
      $lane=[string]$o.laneId
      if(-not $lane){$lane=[string]$o.lane_id}
      $reason=[string]$o.reason
      $task=[string]$o.taskId
      if(-not $task){$task=[string]$o.task_id}
      $ts=[string]$o.timestamp
      if(-not $ts){$ts=[string]$o.at}
      Write-Host "RECENT_ANY=TS=$ts|TYPE=$type|LANE=$lane|TASK=$task|REASON=$reason"
    }catch{}
  }
}
Write-Host 'POSTFIX_LOG_TYPE_DIAG=PASS'
