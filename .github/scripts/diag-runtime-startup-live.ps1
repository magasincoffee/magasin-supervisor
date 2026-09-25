param([Parameter(Mandatory=$true)][string]$TargetComputer)
$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne $TargetComputer){Write-Host 'TARGET_MATCH=False';exit 0}
Write-Host 'TARGET_MATCH=True'
. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$lifecycle=Join-Path $runtime 'windows\lifecycle-truth.ps1'
$start=Join-Path $runtime 'windows\start-supervisor.ps1'
$configFile=Join-Path $root 'lanes.json'
$statusFile=Join-Path $root 'lane-status.json'
$registryFile=Join-Path $root 'lane-registry.json'
$logFile=Join-Path $root 'supervisor.log'
$pidFile=Join-Path $root 'supervisor.pid'
$stop=Join-Path $root 'STOP'
$disabled=Join-Path $root 'AUTOSTART_DISABLED'
if(Test-Path $lifecycle){. $lifecycle}
$truth=Get-LifecycleProcessTruth -Root $root
Write-Host "WRAPPER_ALIVE=$([bool]$truth.wrapper_alive)"
Write-Host "THREE_LANE_ALIVE=$([bool]$truth.three_lane_alive)"
Write-Host "CHROME_ALIVE=$([bool]$truth.chrome_alive)"
Write-Host "CDP_HEALTHY=$([bool]$truth.cdp_healthy)"
Write-Host "STOP_PRESENT=$(Test-Path $stop)"
Write-Host "AUTOSTART_DISABLED_PRESENT=$(Test-Path $disabled)"
Write-Host "PID_FILE_PRESENT=$(Test-Path $pidFile)"
if(Test-Path $pidFile){Write-Host "PID_FILE_VALUE=$((Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1))"}
if(Test-Path $configFile){
 $cfg=Get-Content $configFile -Raw -Encoding UTF8|ConvertFrom-Json
 Write-Host "ENABLED_LANES=$(@($cfg.lanes|Where-Object{[bool]$_.enabled}).Count)"
 foreach($l in $cfg.lanes){Write-Host "CFG_$($l.lane_id)_ENABLED=$([bool]$l.enabled)"}
}
if(Test-Path $registryFile){
 $reg=Get-Content $registryFile -Raw -Encoding UTF8|ConvertFrom-Json
 foreach($id in @('lane-1','lane-2','lane-3')){
  if($reg.lanes.$id){
   $x=$reg.lanes.$id
   Write-Host "REG_$id_TASK=$([string]$x.task_id)"
   Write-Host "REG_$id_AWAITING=$([bool]$x.awaiting_work)"
   Write-Host "REG_$id_DISPATCH=$($null -ne $x.dispatch_inflight)"
   Write-Host "REG_$id_RELAY=$($null -ne $x.relay_inflight)"
  }
 }
}
if(Test-Path $statusFile){
 $st=Get-Content $statusFile -Raw -Encoding UTF8|ConvertFrom-Json
 Write-Host "STATUS_UPDATED_AT=$([string]$st.updated_at)"
 Write-Host "STATUS_VERSION=$([string]$st.supervisor_runtime_version)"
}
if(Test-Path $start){
 Write-Host 'RECOVERY_PROBE_BEGIN=True'
 & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $start -Hidden -Recovery
 Write-Host "RECOVERY_PROBE_EXIT=$LASTEXITCODE"
 Start-Sleep -Seconds 5
 $truth2=Get-LifecycleProcessTruth -Root $root
 Write-Host "AFTER_PROBE_WRAPPER_ALIVE=$([bool]$truth2.wrapper_alive)"
 Write-Host "AFTER_PROBE_THREE_LANE_ALIVE=$([bool]$truth2.three_lane_alive)"
 Write-Host "AFTER_PROBE_CHROME_ALIVE=$([bool]$truth2.chrome_alive)"
 Write-Host "AFTER_PROBE_CDP_HEALTHY=$([bool]$truth2.cdp_healthy)"
}
if(Test-Path $logFile){
 Write-Host 'LOG_TAIL_BEGIN'
 Get-Content $logFile -Tail 120 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
 Write-Host 'LOG_TAIL_END'
}
