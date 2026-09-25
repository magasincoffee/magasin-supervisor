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
function P($o,[string]$n,$d=$null){if($null -eq $o){return $d};$p=$o.PSObject.Properties[$n];if($null -eq $p){return $d};return $p.Value}
$verdict=P $lane 'last_result_verdict' $null
Write-Host "LANE_ENABLED=$([bool]$laneCfg.enabled)"
Write-Host "TASK_ID=$([string](P $lane 'task_id' ''))"
Write-Host "AWAITING_WORK=$([bool](P $lane 'awaiting_work' $false))"
Write-Host "BRAIN_REQUEST_SENT=$([bool](P $lane 'brain_request_sent' $false))"
$brainInflight=P $lane 'brain_request_inflight' $null
Write-Host "BRAIN_REQUEST_INFLIGHT=$($null -ne $brainInflight)"
Write-Host "BRAIN_INFLIGHT_ATTEMPT=$([int](P $brainInflight 'attempt' 0))"
Write-Host "BRAIN_INFLIGHT_BLOCKED=$([bool](P $brainInflight 'reconcile_blocked' $false))"
Write-Host "BRAIN_INFLIGHT_DIGEST=$([string](P $brainInflight 'digest' ''))"
Write-Host "LAST_RESULT_RELAY_ID=$([string](P $lane 'last_result_relay_id' ''))"
Write-Host "LAST_RESULT_VERDICT_TASK=$([string](P $verdict 'task_id' ''))"
Write-Host "LAST_RESULT_VERDICT_RELAY=$([string](P $verdict 'relay_id' ''))"
Write-Host "LAST_RESULT_VERDICT=$([string](P $verdict 'verdict' ''))"
Write-Host "LAST_BRAIN_DIRECTIVE_DIGEST=$([string](P $lane 'last_brain_directive_digest' ''))"
Write-Host "LAST_DISPATCH_ID=$([string](P $lane 'last_dispatch_id' ''))"
Write-Host "DISPATCH_INFLIGHT=$($null -ne (P $lane 'dispatch_inflight' $null))"
Write-Host "RELAY_INFLIGHT=$($null -ne (P $lane 'relay_inflight' $null))"
Write-Host "WORK_GENERATION=$([int](P $lane 'work_generation' 0))"
Write-Host "STATUS=$([string](P $laneSt 'status' ''))"
Write-Host "PHASE=$([string](P $laneSt 'phase' ''))"
Write-Host "MESSAGE=$([string](P $laneSt 'message' ''))"
Write-Host "STATUS_UPDATED_AT=$([string](P $st 'updated_at' ''))"

$eventFile=Join-Path $root 'lane-events.ndjson'
if(Test-Path $eventFile){
  Write-Host 'EVENTS_BEGIN'
  Get-Content $eventFile -Tail 60 -ErrorAction SilentlyContinue | ForEach-Object {
    try{
      $e=$_|ConvertFrom-Json
      if([string](P $e 'lane_id' '') -eq 'lane-1'){
        Write-Host ("EVENT|"+[string](P $e 'timestamp' '')+"|"+[string](P $e 'event_type' '')+"|"+[string](P $e 'task_id' '')+"|"+[string](P $e 'phase' '')+"|"+[string](P $e 'reason_code' ''))
      }
    }catch{}
  }
  Write-Host 'EVENTS_END'
}

$log=Join-Path $root 'supervisor.log'
if(Test-Path $log){
  Write-Host 'LOG_MATCH_BEGIN'
  Get-Content $log -Tail 500 -ErrorAction SilentlyContinue | ForEach-Object {
    if($_ -match 'previous_result|durable lane truth|LANE_ERROR|BRAIN'){
      Write-Host $_
    }
  }
  Write-Host 'LOG_MATCH_END'
}

# post-repair verification trigger

# brain-inflight verification trigger

# post-marker-handshake response verification
