param([Parameter(Mandatory=$true)][string]$TargetComputer)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
if($env:COMPUTERNAME -ne $TargetComputer){Write-Host 'TARGET_MATCH=False';exit 0}
Write-Host 'TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$resolvedRoot=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$base=[string]$env:LOCALAPPDATA
if([string]::IsNullOrWhiteSpace($base)){$base=[string]$env:USERPROFILE}
$businessRoot=Join-Path $base 'MAGASIN\BusinessOS\supervisor'
$platformRoot=Join-Path $base 'MAGASIN\Supervisor'

Write-Host "ENV_SUPERVISOR_STATE_ROOT=$([string]$env:SUPERVISOR_STATE_ROOT)"
Write-Host "RESOLVED_ROOT=$resolvedRoot"
Write-Host "BUSINESS_ROOT=$businessRoot"
Write-Host "PLATFORM_ROOT=$platformRoot"

function Inspect-Root([string]$Label,[string]$Root){
  Write-Host "ROOT_BEGIN=$Label|$Root"
  $cfgPath=Join-Path $Root 'lanes.json'
  $regPath=Join-Path $Root 'lane-registry.json'
  $statusPath=Join-Path $Root 'lane-status.json'
  $pidPath=Join-Path $Root 'supervisor.pid'
  $life=Join-Path $Root 'runtime\windows\lifecycle-truth.ps1'
  Write-Host "$Label.CONFIG_EXISTS=$(Test-Path $cfgPath)"
  Write-Host "$Label.REGISTRY_EXISTS=$(Test-Path $regPath)"
  Write-Host "$Label.STATUS_EXISTS=$(Test-Path $statusPath)"
  Write-Host "$Label.PID_EXISTS=$(Test-Path $pidPath)"
  if(Test-Path $cfgPath){
    try{
      $cfg=Get-Content $cfgPath -Raw -Encoding UTF8|ConvertFrom-Json
      Write-Host "$Label.MODE=$([string]$cfg.mode)"
      foreach($lane in @($cfg.lanes)){
        Write-Host "$Label.$([string]$lane.lane_id).ENABLED=$([bool]$lane.enabled)"
        Write-Host "$Label.$([string]$lane.lane_id).BRAIN=$([string]$lane.brain_url)"
        Write-Host "$Label.$([string]$lane.lane_id).WORK=$([string]$lane.work_url)"
      }
    }catch{Write-Host "$Label.CONFIG_ERROR=$($_.Exception.Message)"}
  }
  if(Test-Path $statusPath){
    try{
      $st=Get-Content $statusPath -Raw -Encoding UTF8|ConvertFrom-Json
      Write-Host "$Label.STATUS_UPDATED_AT=$([string]$st.updated_at)"
      Write-Host "$Label.STATUS_VERSION=$([string]$st.supervisor_runtime_version)"
      foreach($lane in @($st.lanes)){
        Write-Host "$Label.$([string]$lane.lane_id).STATUS=$([string]$lane.status)"
        Write-Host "$Label.$([string]$lane.lane_id).PHASE=$([string]$lane.phase)"
      }
    }catch{Write-Host "$Label.STATUS_ERROR=$($_.Exception.Message)"}
  }
  if(Test-Path $regPath){
    try{
      $reg=Get-Content $regPath -Raw -Encoding UTF8|ConvertFrom-Json
      foreach($prop in @($reg.lanes.PSObject.Properties)){
        $x=$prop.Value
        Write-Host "$Label.$($prop.Name).TASK=$([string]$x.task_id)"
        Write-Host "$Label.$($prop.Name).AWAITING=$([bool]$x.awaiting_work)"
      }
    }catch{Write-Host "$Label.REGISTRY_ERROR=$($_.Exception.Message)"}
  }
  if(Test-Path $life){
    try{
      . $life
      $truth=Get-LifecycleProcessTruth -Root $Root
      Write-Host "$Label.WRAPPER_ALIVE=$([bool]$truth.wrapper_alive)"
      Write-Host "$Label.THREE_LANE_ALIVE=$([bool]$truth.three_lane_alive)"
      Write-Host "$Label.CHROME_ALIVE=$([bool]$truth.chrome_alive)"
      Write-Host "$Label.CDP_HEALTHY=$([bool]$truth.cdp_healthy)"
    }catch{Write-Host "$Label.TRUTH_ERROR=$($_.Exception.Message)"}
  }
  Write-Host "ROOT_END=$Label"
}

Inspect-Root 'RESOLVED' $resolvedRoot
if($businessRoot -ne $resolvedRoot){Inspect-Root 'BUSINESS' $businessRoot}
if($platformRoot -ne $resolvedRoot -and $platformRoot -ne $businessRoot){Inspect-Root 'PLATFORM' $platformRoot}

Write-Host 'PANEL_PROCESSES_BEGIN'
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object {$_.CommandLine -and $_.CommandLine -like '*control-panel.ps1*'} |
  ForEach-Object { Write-Host "PANEL_PID=$($_.ProcessId)|PPID=$($_.ParentProcessId)|CMD=$($_.CommandLine)" }
Write-Host 'PANEL_PROCESSES_END'

$desktop=[Environment]::GetFolderPath('Desktop')
$shortcutPath=Join-Path $desktop 'MAGASIN BUSINESS OS CONTROL.lnk'
if(Test-Path $shortcutPath){
  $wsh=New-Object -ComObject WScript.Shell
  $sc=$wsh.CreateShortcut($shortcutPath)
  Write-Host "SHORTCUT_TARGET=$($sc.TargetPath)"
  Write-Host "SHORTCUT_ARGS=$($sc.Arguments)"
  Write-Host "SHORTCUT_WORKDIR=$($sc.WorkingDirectory)"
}
