param([Parameter(Mandatory=$true)][string]$TargetComputer)
$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne $TargetComputer){Write-Host 'TARGET_MATCH=False';exit 0}
Write-Host 'TARGET_MATCH=True'
. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
Write-Host "STATE_ROOT=$root"
$cfg=Get-Content (Join-Path $root 'lanes.json') -Raw -Encoding UTF8|ConvertFrom-Json
$reg=Get-Content (Join-Path $root 'lane-registry.json') -Raw -Encoding UTF8|ConvertFrom-Json
$st=Get-Content (Join-Path $root 'lane-status.json') -Raw -Encoding UTF8|ConvertFrom-Json
$laneCfg=@($cfg.lanes|Where-Object{[string]$_.lane_id -eq 'lane-1'}|Select-Object -First 1)[0]
$lane=$reg.lanes.'lane-1'
$laneSt=@($st.lanes|Where-Object{[string]$_.lane_id -eq 'lane-1'}|Select-Object -First 1)[0]
Write-Host "LANE_ENABLED=$([bool]$laneCfg.enabled)"
Write-Host "TASK_ID=$([string]$lane.task_id)"
Write-Host "AWAITING_WORK=$([bool]$lane.awaiting_work)"
Write-Host "BRAIN_REQUEST_SENT=$([bool]$lane.brain_request_sent)"
Write-Host "LAST_RESULT_RELAY_ID=$([string]$lane.last_result_relay_id)"
Write-Host "LAST_RESULT_VERDICT_TASK=$([string]$lane.last_result_verdict.task_id)"
Write-Host "LAST_RESULT_VERDICT_RELAY=$([string]$lane.last_result_verdict.relay_id)"
Write-Host "LAST_RESULT_VERDICT=$([string]$lane.last_result_verdict.verdict)"
Write-Host "LAST_BRAIN_DIRECTIVE_DIGEST=$([string]$lane.last_brain_directive_digest)"
Write-Host "LAST_DISPATCH_ID=$([string]$lane.last_dispatch_id)"
Write-Host "DISPATCH_INFLIGHT=$($null -ne $lane.dispatch_inflight)"
Write-Host "RELAY_INFLIGHT=$($null -ne $lane.relay_inflight)"
Write-Host "WORK_GENERATION=$([int]$lane.work_generation)"
Write-Host "STATUS=$([string]$laneSt.status)"
Write-Host "PHASE=$([string]$laneSt.phase)"
Write-Host "MESSAGE=$([string]$laneSt.message)"
Write-Host "STATUS_UPDATED_AT=$([string]$st.updated_at)"

$eventFile=Join-Path $root 'lane-events.ndjson'
if(Test-Path $eventFile){
  Write-Host 'EVENTS_BEGIN'
  Get-Content $eventFile -Tail 40 -ErrorAction SilentlyContinue | ForEach-Object {
    try{
      $e=$_|ConvertFrom-Json
      if([string]$e.lane_id -eq 'lane-1'){
        Write-Host ("EVENT|"+[string]$e.timestamp+"|"+[string]$e.event_type+"|"+[string]$e.task_id+"|"+[string]$e.phase+"|"+[string]$e.reason_code)
      }
    }catch{}
  }
  Write-Host 'EVENTS_END'
}

$log=Join-Path $root 'supervisor.log'
if(Test-Path $log){
  Write-Host 'LOG_MATCH_BEGIN'
  Get-Content $log -Tail 400 -ErrorAction SilentlyContinue | ForEach-Object {
    if($_ -match 'previous_result|durable lane truth|LANE_ERROR|BRAIN'){
      Write-Host $_
    }
  }
  Write-Host 'LOG_MATCH_END'
}
