param([string]$TargetComputer='DESKTOP-4K7IM13')
$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne $TargetComputer){ Write-Host 'TARGET_MATCH=False'; exit 0 }
Write-Host 'TARGET_MATCH=True'
. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$lifecycle=Join-Path $runtime 'windows\lifecycle-truth.ps1'
if(Test-Path $lifecycle){ . $lifecycle }
Write-Host "ROOT=$root"
foreach($p in @('STOP','AUTOSTART_DISABLED','supervisor.pid','lanes.json','lane-status.json','lane-registry.json','supervisor.log')){
  $full=Join-Path $root $p
  Write-Host "FILE_$($p.Replace('.','_'))=$([bool](Test-Path $full))"
}
if(Get-Command Get-LifecycleProcessTruth -ErrorAction SilentlyContinue){
  $t=Get-LifecycleProcessTruth -Root $root
  Write-Host "WRAPPER_ALIVE=$([bool]$t.wrapper_alive)"
  Write-Host "THREE_LANE_ALIVE=$([bool]$t.three_lane_alive)"
  Write-Host "CHROME_ALIVE=$([bool]$t.chrome_alive)"
  Write-Host "CDP_HEALTHY=$([bool]$t.cdp_healthy)"
}
Write-Host '--- WRAPPERS ---'
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*run-supervisor.ps1*' } |
  ForEach-Object { Write-Host ("WRAPPER_PID={0} CMD={1}" -f $_.ProcessId,$_.CommandLine) }
Write-Host '--- THREE LANE NODES ---'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*three-lane-cli.mjs*' } |
  ForEach-Object { Write-Host ("NODE_PID={0} PPID={1} CMD={2}" -f $_.ProcessId,$_.ParentProcessId,$_.CommandLine) }
Write-Host '--- CHROME ROBOT ---'
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$(Join-Path $root 'browser_profile')*" } |
  Select-Object -First 3 |
  ForEach-Object { Write-Host ("CHROME_PID={0} PPID={1} CMD={2}" -f $_.ProcessId,$_.ParentProcessId,$_.CommandLine) }
if(Test-Path (Join-Path $root 'supervisor.pid')){
  $sp=(Get-Content (Join-Path $root 'supervisor.pid') -ErrorAction SilentlyContinue | Select-Object -First 1)
  Write-Host "SUPERVISOR_PID_FILE=$sp"
  if($sp){ $p=Get-CimInstance Win32_Process -Filter "ProcessId=$sp" -ErrorAction SilentlyContinue; if($p){Write-Host "SUPERVISOR_PID_PROCESS=$($p.Name) CMD=$($p.CommandLine)"}}
}
if(Test-Path (Join-Path $root 'lane-status.json')){
  try{
    $st=Get-Content (Join-Path $root 'lane-status.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host "STATUS_UPDATED_AT=$($st.updated_at)"
    Write-Host "STATUS_RUNTIME_VERSION=$($st.supervisor_runtime_version)"
    foreach($ln in @($st.lanes)){Write-Host "STATUS_LANE=$($ln.lane_id) STATUS=$($ln.status) PHASE=$($ln.phase) MSG=$($ln.message)"}
  }catch{Write-Host "STATUS_PARSE_ERROR=$($_.Exception.Message)"}
}
if(Test-Path (Join-Path $root 'lane-registry.json')){
  try{
    $rg=Get-Content (Join-Path $root 'lane-registry.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach($id in @('lane-1','lane-2','lane-3')){
      $ln=$rg.lanes.$id
      if($ln){ Write-Host "REGISTRY_LANE=$id TASK=$($ln.task_id) AWAITING=$([bool]$ln.awaiting_work) DISPATCH=$($null -ne $ln.dispatch_inflight) RELAY=$($null -ne $ln.relay_inflight) WATCHDOG=$($ln.work_watchdog.phase)"}
    }
  }catch{Write-Host "REGISTRY_PARSE_ERROR=$($_.Exception.Message)"}
}
Write-Host '--- SUPERVISOR LOG TAIL ---'
$log=Join-Path $root 'supervisor.log'
if(Test-Path $log){ Get-Content $log -Tail 180 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("LOG="+$_) } }
Write-Host '--- WINDOWS PROCESS EXIT CONTEXT ---'
Get-WinEvent -FilterHashtable @{LogName='Windows PowerShell'; StartTime=(Get-Date).AddHours(-8)} -ErrorAction SilentlyContinue |
  Where-Object { $_.Message -like '*run-supervisor.ps1*' -or $_.Message -like '*three-lane-cli.mjs*' } |
  Select-Object -First 20 |
  ForEach-Object { Write-Host ("PSEVENT={0}|{1}|{2}" -f $_.TimeCreated,$_.Id,($_.Message -replace "[\r\n]+",' ')) }
