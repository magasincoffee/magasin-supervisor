param([string]$TargetComputer="DESKTOP-4K7IM13")
$ErrorActionPreference="Stop"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host "TARGET_MATCH=False"
  exit 0
}
Write-Host "TARGET_MATCH=True"
. (Join-Path $PSScriptRoot "..\..\windows\state-root.ps1")
$root=Get-SupervisorStateRoot -Compatibility "legacy-preserve"
$runtimePanel=Join-Path $root "runtime\windows\control-panel.ps1"
Write-Host "TARGET_MACHINE=$env:COMPUTERNAME"
Write-Host "STATE_ROOT=$root"
Write-Host "RUNTIME_PANEL=$runtimePanel"
if(Test-Path $runtimePanel){
  $txt=Get-Content $runtimePanel -Raw -Encoding UTF8
  Write-Host "RUNTIME_RESET_READY=$($txt -match [regex]::Escape('RESET READY'))"
  Write-Host "RUNTIME_RESET_BUTTON=$($txt -match 'resetAllButton')"
  Write-Host "RUNTIME_OLD_SUBTITLE=$($txt -match 'BỘ NÃO DO BẠN CHỌN')"
  Write-Host "RUNTIME_SHA256=$((Get-FileHash $runtimePanel -Algorithm SHA256).Hash)"
}

Write-Host "=== PANEL PROCESS CANDIDATES ==="
$allPs=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -in @('powershell.exe','pwsh.exe','cmd.exe') -and
    $_.CommandLine
  } | Sort-Object ProcessId

foreach($p in $allPs){
  $gp=$null
  try{$gp=Get-Process -Id ([int]$p.ProcessId) -ErrorAction Stop}catch{}
  $title=if($gp){[string]$gp.MainWindowTitle}else{''}
  $isPanel=($p.CommandLine -like '*control-panel.ps1*') -or ($title -like '*MAGASIN BUSINESS OS*')
  if($isPanel){
    Write-Host "PANEL_PID=$($p.ProcessId)"
    Write-Host "PANEL_NAME=$($p.Name)"
    Write-Host "PANEL_PARENT=$($p.ParentProcessId)"
    Write-Host "PANEL_SESSION=$($p.SessionId)"
    Write-Host "PANEL_EXE=$($p.ExecutablePath)"
    Write-Host "PANEL_CMD=$($p.CommandLine)"
    Write-Host "PANEL_TITLE=$title"
  }
}

Write-Host "=== DESKTOP SHORTCUTS ==="
$shell=New-Object -ComObject WScript.Shell
$desktops=@(
 [Environment]::GetFolderPath('Desktop'),
 [Environment]::GetFolderPath('CommonDesktopDirectory')
) | Select-Object -Unique
foreach($desktop in $desktops){
  if(-not $desktop -or -not (Test-Path $desktop)){continue}
  Get-ChildItem $desktop -Filter '*.lnk' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'MAGASIN|BUSINESS|SUPERVISOR' } |
    ForEach-Object {
      $sc=$shell.CreateShortcut($_.FullName)
      Write-Host "SHORTCUT_FILE=$($_.FullName)"
      Write-Host "SHORTCUT_TARGET=$($sc.TargetPath)"
      Write-Host "SHORTCUT_ARGS=$($sc.Arguments)"
      Write-Host "SHORTCUT_WORKDIR=$($sc.WorkingDirectory)"
    }
}

Write-Host "=== UI AUTOMATION ==="
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$candidates=@()
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  ForEach-Object {
    try{
      $gp=Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop
      if($gp.MainWindowHandle -ne 0 -and $gp.MainWindowTitle -like '*MAGASIN BUSINESS OS*'){
        $candidates += $gp
      }
    }catch{}
  }
Write-Host "VISIBLE_PANEL_COUNT=$($candidates.Count)"
foreach($gp in $candidates){
  Write-Host "VISIBLE_PANEL_PID=$($gp.Id)"
  Write-Host "VISIBLE_PANEL_TITLE=$($gp.MainWindowTitle)"
  $rootEl=[System.Windows.Automation.AutomationElement]::FromHandle($gp.MainWindowHandle)
  if($rootEl){
    $nodes=$rootEl.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $reset=$false
    $ready=$false
    $old=$false
    for($i=0;$i -lt $nodes.Count;$i++){
      $name=[string]$nodes.Item($i).Current.Name
      if($name -match 'LÀM SẠCH TẤT CẢ DỰ ÁN'){ $reset=$true }
      if($name -match 'RESET READY'){ $ready=$true }
      if($name -match 'BỘ NÃO DO BẠN CHỌN'){ $old=$true }
    }
    Write-Host "VISIBLE_RESET_BUTTON=$reset"
    Write-Host "VISIBLE_RESET_READY=$ready"
    Write-Host "VISIBLE_OLD_SUBTITLE=$old"
  }
}
Write-Host "CONTROL_PANEL_LIVE_TARGET_DIAG=PASS"


Write-Host "=== LIVE RUNTIME TRUTH ==="
. (Join-Path $PSScriptRoot "..\..\windows\lifecycle-truth.ps1")
$ownerStop=Get-LifecycleOwnerStopState -Root $root
$processTruth=Get-LifecycleProcessTruth -Root $root
$enabledCount=Get-EnabledLaneCount -Root $root
Write-Host "LIVE_ENABLED_LANES=$enabledCount"
Write-Host "LIVE_OWNER_STOP=$([bool]$ownerStop.blocked)"
Write-Host "LIVE_STOP_PRESENT=$([bool]$ownerStop.stop_present)"
Write-Host "LIVE_AUTOSTART_DISABLED_PRESENT=$([bool]$ownerStop.autostart_disabled_present)"
Write-Host "LIVE_WRAPPER_ALIVE=$([bool]$processTruth.wrapper_alive)"
Write-Host "LIVE_THREE_LANE_ALIVE=$([bool]$processTruth.three_lane_alive)"
Write-Host "LIVE_CHROME_ALIVE=$([bool]$processTruth.chrome_alive)"
Write-Host "LIVE_CDP_HEALTHY=$([bool]$processTruth.cdp_healthy)"
Write-Host "LIVE_PROCESS_HEALTHY=$([bool]$processTruth.healthy)"

foreach($p in @(
  (Join-Path $root 'supervisor.pid'),
  (Join-Path $root 'STOP'),
  (Join-Path $root 'AUTOSTART_DISABLED'),
  (Join-Path $root 'lanes.json'),
  (Join-Path $root 'lane-status.json')
)){
  Write-Host "LIVE_PATH=$p|EXISTS=$(Test-Path $p)"
  if(Test-Path $p){
    $item=Get-Item $p
    Write-Host "LIVE_PATH_META=$p|LEN=$($item.Length)|UTC=$($item.LastWriteTimeUtc.ToString('o'))"
  }
}

Write-Host "=== SUPERVISOR PROCESSES ==="
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and (
      $_.CommandLine -like '*run-supervisor.ps1*' -or
      $_.CommandLine -like '*three-lane-cli.mjs*' -or
      $_.CommandLine -like '*start-supervisor.ps1*'
    )
  } |
  Sort-Object ProcessId |
  ForEach-Object {
    Write-Host "LIVE_PROCESS=$($_.ProcessId)|PPID=$($_.ParentProcessId)|NAME=$($_.Name)|CMD=$($_.CommandLine)"
  }

$startScript=Join-Path $root 'runtime\windows\start-supervisor.ps1'
Write-Host "LIVE_START_SCRIPT=$startScript|EXISTS=$(Test-Path $startScript)"
if($enabledCount -gt 0 -and -not $ownerStop.blocked -and -not $processTruth.healthy -and (Test-Path $startScript)){
  Write-Host "LIVE_RECOVERY_PROBE_BEGIN=True"
  $output=& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startScript -Recovery 2>&1
  Write-Host "LIVE_RECOVERY_EXIT=$LASTEXITCODE"
  $output | ForEach-Object { Write-Host "LIVE_RECOVERY_OUT=$_" }
  Start-Sleep -Seconds 3
  $after=Get-LifecycleProcessTruth -Root $root
  Write-Host "LIVE_AFTER_WRAPPER_ALIVE=$([bool]$after.wrapper_alive)"
  Write-Host "LIVE_AFTER_THREE_LANE_ALIVE=$([bool]$after.three_lane_alive)"
  Write-Host "LIVE_AFTER_CDP_HEALTHY=$([bool]$after.cdp_healthy)"
  Write-Host "LIVE_AFTER_PROCESS_HEALTHY=$([bool]$after.healthy)"
}
Write-Host "LIVE_RUNTIME_DIAG=PASS"


Write-Host "=== LIVE LANE ERROR DETAIL ==="
$statusPath=Join-Path $root 'lane-status.json'
if(Test-Path $statusPath){
  try{
    $statusJson=Get-Content $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach($prop in @($statusJson.PSObject.Properties)){
      if([string]$prop.Name -like 'lane-*'){
        $laneStatus=$prop.Value
        $state=[string]$laneStatus.status
        $msg=[string]$laneStatus.message
        $errName=''
        if($laneStatus.PSObject.Properties['error_name']){$errName=[string]$laneStatus.error_name}
        Write-Host "LIVE_LANE_STATUS=$($prop.Name)|STATUS=$state|ERROR_NAME=$errName|MESSAGE=$msg"
      }
    }
  }catch{
    Write-Host "LIVE_LANE_STATUS_READ_ERROR=$($_.Exception.Message)"
  }
}else{
  Write-Host "LIVE_LANE_STATUS_MISSING=True"
}

$supervisorLog=Join-Path $root 'supervisor.log'
if(Test-Path $supervisorLog){
  try{
    $tail=Get-Content $supervisorLog -Tail 120 -Encoding UTF8
    $laneErrors=@()
    foreach($line in $tail){
      try{
        $obj=$line | ConvertFrom-Json -ErrorAction Stop
        if([string]$obj.type -eq 'LANE_ERROR'){
          $laneErrors += [pscustomobject]@{
            lane=[string]$obj.laneId
            task=[string]$obj.taskId
            error=[string]$obj.errorName
            reason=[string]$obj.reason
          }
        }
      }catch{}
    }
    foreach($e in @($laneErrors | Select-Object -Last 8)){
      Write-Host "LIVE_LANE_ERROR=LANE=$($e.lane)|TASK=$($e.task)|ERROR=$($e.error)|REASON=$($e.reason)"
    }
    if(@($laneErrors).Count -eq 0){Write-Host "LIVE_LANE_ERROR_NONE_IN_TAIL=True"}
  }catch{
    Write-Host "LIVE_SUPERVISOR_LOG_READ_ERROR=$($_.Exception.Message)"
  }
}else{
  Write-Host "LIVE_SUPERVISOR_LOG_MISSING=True"
}
Write-Host "LIVE_LANE_ERROR_DIAG=PASS"


Write-Host "=== LIVE DISPATCH STALL DETAIL ==="
$registryPath=Join-Path $root 'lane-registry.json'
if(Test-Path $registryPath){
  try{
    $registryJson=Get-Content $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $lane=$registryJson.lanes.'lane-1'
    if($lane){
      Write-Host "DISPATCH_TASK_ID=$([string]$lane.task_id)"
      Write-Host "DISPATCH_AWAITING_WORK=$([bool]$lane.awaiting_work)"
      Write-Host "DISPATCH_LAST_BRAIN_DIGEST=$([string]$lane.last_brain_directive_digest)"
      Write-Host "DISPATCH_LAST_ID=$([string]$lane.last_dispatch_id)"
      Write-Host "DISPATCH_WORK_URL_PRESENT=$(-not [string]::IsNullOrWhiteSpace([string]$lane.work_url))"
      if($lane.dispatch_inflight){
        $d=$lane.dispatch_inflight
        Write-Host "DISPATCH_INFLIGHT=True"
        Write-Host "DISPATCH_INFLIGHT_TASK=$([string]$d.task_id)"
        Write-Host "DISPATCH_INFLIGHT_ID=$([string]$d.dispatch_id)"
        Write-Host "DISPATCH_SEND_STATE=$([string]$d.send_state)"
        Write-Host "DISPATCH_SEND_ATTEMPTED_AT=$([string]$d.send_attempted_at)"
        Write-Host "DISPATCH_LAST_REJECTION=$([string]$d.last_send_rejection)"
        Write-Host "DISPATCH_RECONCILE_RELOADED=$([bool]$d.reconcile_reloaded)"
        Write-Host "DISPATCH_RECONCILE_BLOCKED=$([bool]$d.reconcile_blocked)"
        Write-Host "DISPATCH_PRE_USER_COUNT=$([string]$d.pre_user_count)"
        Write-Host "DISPATCH_PRE_MAX_TURN=$([string]$d.pre_max_turn_ordinal)"
      }else{
        Write-Host "DISPATCH_INFLIGHT=False"
      }
    }
  }catch{
    Write-Host "DISPATCH_REGISTRY_READ_ERROR=$($_.Exception.Message)"
  }
}else{
  Write-Host "DISPATCH_REGISTRY_MISSING=True"
}

$supervisorLog=Join-Path $root 'supervisor.log'
if(Test-Path $supervisorLog){
  $tail=Get-Content $supervisorLog -Tail 400 -Encoding UTF8
  foreach($line in $tail){
    try{
      $obj=$line | ConvertFrom-Json -ErrorAction Stop
      $type=[string]$obj.type
      if($type -match 'LANE_WORK_(SEND|DISPATCH)|LANE_ERROR|BROWSER|MUTATION'){
        $laneId=[string]$obj.lane_id
        if(-not $laneId -or $laneId -eq 'lane-1'){
          $reason=[string]$obj.reason
          $errorName=[string]$obj.error_name
          $taskId=[string]$obj.task_id
          $digest=[string]$obj.digest
          Write-Host "DISPATCH_LOG=TYPE=$type|TASK=$taskId|ERROR=$errorName|REASON=$reason|DIGEST=$digest"
        }
      }
    }catch{}
  }
}
Write-Host "LIVE_DISPATCH_STALL_DIAG=PASS"

# POST_SEND_FIX_LIVE_PROBE_V1

# POST_HOTPATCH_DISPATCH_PROBE_V1
