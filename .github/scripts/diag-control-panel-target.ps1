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
      if($gp.MainWindowHandle -ne 0 -and $gp.MainWindowTitle -match 'MAGASIN SUPERVISOR.*CONTROL CENTER'){
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
try {
  $liveCfg=Get-Content (Join-Path $root 'lanes.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $liveLane1=@($liveCfg.lanes | Where-Object { [string]$_.lane_id -eq 'lane-1' } | Select-Object -First 1)[0]
  if($liveLane1){
    Write-Host "LIVE_LANE1_RESUME_REVISION=$([string]$liveLane1.resume_revision)"
    Write-Host "LIVE_LANE1_RESUME_REQUESTED_AT=$([string]$liveLane1.resume_requested_at)"
  }
}catch{
  Write-Host "LIVE_RESUME_CONFIG_READ_ERROR=$($_.Exception.Message)"
}
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
      Write-Host "DISPATCH_APPLIED_RESUME_REVISION=$([string]$lane.applied_resume_revision)"
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


Write-Host "=== RBT-010 LIVE ACCEPTANCE ==="
$installedRuntime=Join-Path $root 'runtime'
$runtimeThreeLane=Join-Path $installedRuntime 'src\runtime\three-lane-cli.mjs'
$runtimeActions=Join-Path $installedRuntime 'src\ui\actions.mjs'
$runtimeCapture=Join-Path $installedRuntime 'src\ui\message-capture.mjs'
$runtimeControlPanel=Join-Path $installedRuntime 'windows\control-panel.ps1'
$required=@($runtimeThreeLane,$runtimeActions,$runtimeCapture,$runtimeControlPanel)
foreach($p in $required){
  if(-not (Test-Path $p)){throw "RBT-010 installed file missing: $p"}
}

$threeLaneText=Get-Content $runtimeThreeLane -Raw -Encoding UTF8
$actionsText=Get-Content $runtimeActions -Raw -Encoding UTF8
$captureText=Get-Content $runtimeCapture -Raw -Encoding UTF8
$panelText=Get-Content $runtimeControlPanel -Raw -Encoding UTF8

$threeLaneForbidden=@(
  'captureCompletedAssistantTurnScreenshot',
  'sendComposerWithAttachment',
  'screenshot_path',
  'LANE_RESULT_SCREENSHOT_CAPTURED',
  'EVIDENCE_MISSING'
)
foreach($needle in $threeLaneForbidden){
  if($threeLaneText -match [regex]::Escape($needle)){
    throw "RBT-010 forbidden Three-Lane token remains: $needle"
  }
}
$actionsForbidden=@('sendComposerWithAttachment','setInputFiles','COMPOSER_ATTACHMENT_SEND')
foreach($needle in $actionsForbidden){
  if($actionsText -match [regex]::Escape($needle)){
    throw "RBT-010 forbidden action token remains: $needle"
  }
}
$captureForbidden=@('captureCompletedAssistantTurnScreenshot','locator.screenshot')
foreach($needle in $captureForbidden){
  if($captureText -match [regex]::Escape($needle)){
    throw "RBT-010 forbidden capture token remains: $needle"
  }
}
$panelForbidden=@('BÁO CÁO ẢNH','screenshot_path','relayScreenshotPath','reportInfoLabel')
foreach($needle in $panelForbidden){
  if($panelText -match [regex]::Escape($needle)){
    throw "RBT-010 forbidden Control Panel token remains: $needle"
  }
}

$registryPath=Join-Path $root 'lane-registry.json'
if(-not (Test-Path $registryPath)){throw 'RBT-010 lane-registry.json missing'}
$registryRaw=Get-Content $registryPath -Raw -Encoding UTF8
if($registryRaw -match '"screenshot_path"'){
  throw 'RBT-010 legacy screenshot_path still present in live registry'
}

$legacyEvidence=Join-Path $root 'lane-evidence'
if(Test-Path $legacyEvidence){
  $evidenceFiles=@(Get-ChildItem $legacyEvidence -File -Recurse -ErrorAction SilentlyContinue)
  if($evidenceFiles.Count -gt 0){
    throw "RBT-010 legacy lane-evidence still contains files: $($evidenceFiles.Count)"
  }
}

$truth=Get-LifecycleProcessTruth -Root $root
if($enabledCount -gt 0 -and -not $ownerStop.blocked -and -not $truth.healthy){
  throw 'RBT-010 live runtime unhealthy after text-only hotpatch'
}

Write-Host "RBT010_TEXT_ONLY_RUNTIME=True"
Write-Host "RBT010_SCREENSHOT_CAPTURE_REMOVED=True"
Write-Host "RBT010_ATTACHMENT_UPLOAD_REMOVED=True"
Write-Host "RBT010_SCREENSHOT_LATCH_FIELD_REMOVED=True"
Write-Host "RBT010_CONTROL_PANEL_SCREENSHOT_UI_REMOVED=True"
Write-Host "RBT010_LEGACY_EVIDENCE_CLEAN=True"
Write-Host "RBT010_PROCESS_HEALTHY=$([bool]$truth.healthy)"
Write-Host "RBT010_LIVE_ACCEPTANCE=PASS"

Write-Host "=== BRAIN RESUME NEXT WORK LIVE ACCEPTANCE ==="
$repoRoot=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$installedThreeLane=Join-Path $root 'runtime\src\runtime\three-lane.mjs'
$installedThreeLaneCli=Join-Path $root 'runtime\src\runtime\three-lane-cli.mjs'
$repoThreeLane=Join-Path $repoRoot 'src\runtime\three-lane.mjs'
$repoThreeLaneCli=Join-Path $repoRoot 'src\runtime\three-lane-cli.mjs'

foreach($p in @($installedThreeLane,$installedThreeLaneCli,$repoThreeLane,$repoThreeLaneCli)){
  if(-not (Test-Path $p)){throw "Brain resume next-work acceptance file missing: $p"}
}

$coreHashMatch=((Get-FileHash $installedThreeLane -Algorithm SHA256).Hash -eq (Get-FileHash $repoThreeLane -Algorithm SHA256).Hash)
$cliHashMatch=((Get-FileHash $installedThreeLaneCli -Algorithm SHA256).Hash -eq (Get-FileHash $repoThreeLaneCli -Algorithm SHA256).Hash)
if(-not $coreHashMatch){throw 'Installed three-lane.mjs does not match exact main'}
if(-not $cliHashMatch){throw 'Installed three-lane-cli.mjs does not match exact main'}

Write-Host "BRAIN_RESUME_NEXT_WORK_CORE_HASH_MATCH=$coreHashMatch"
Write-Host "BRAIN_RESUME_NEXT_WORK_CLI_HASH_MATCH=$cliHashMatch"
Write-Host "BRAIN_RESUME_NEXT_WORK_LIVE_ACCEPTANCE=PASS"


Write-Host "=== CONTROL PANEL LAUNCH SMOKE ==="
$panelScript=Join-Path $root 'runtime\windows\control-panel.ps1'
if(-not (Test-Path $panelScript)){throw "Control Panel script missing: $panelScript"}

$stderrPath=Join-Path $env:TEMP 'magasin-control-panel-smoke.stderr.txt'
$stdoutPath=Join-Path $env:TEMP 'magasin-control-panel-smoke.stdout.txt'
Remove-Item $stderrPath,$stdoutPath -Force -ErrorAction SilentlyContinue

$existing=@(
  Get-Process -Name powershell -ErrorAction SilentlyContinue |
    Where-Object {
      $_.MainWindowHandle -ne 0 -and
      $_.MainWindowTitle -match 'MAGASIN SUPERVISOR.*CONTROL CENTER'
    }
)
Write-Host "CONTROL_PANEL_EXISTING_COUNT=$($existing.Count)"
if($existing.Count -gt 0){
  Write-Host "CONTROL_PANEL_EXISTING_TITLE=$($existing[0].MainWindowTitle)"
  Write-Host "CONTROL_PANEL_LAUNCH_SMOKE=PASS"
}else{
$proc=Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @(
  '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
  '-File',('"' + $panelScript + '"')
) -RedirectStandardError $stderrPath -RedirectStandardOutput $stdoutPath

Write-Host "CONTROL_PANEL_SMOKE_PID=$($proc.Id)"
$smokeWatch=[Diagnostics.Stopwatch]::StartNew()
$title=''
$gp=$null
while($smokeWatch.Elapsed.TotalSeconds -lt 12){
  $proc.Refresh()
  if($proc.HasExited){break}
  $gp=Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
  $title=if($gp){[string]$gp.MainWindowTitle}else{''}
  if($title -match 'MAGASIN SUPERVISOR.*CONTROL CENTER'){break}
  Start-Sleep -Milliseconds 200
}
$smokeWatch.Stop()
Write-Host "CONTROL_PANEL_SMOKE_READY_MS=$([math]::Round($smokeWatch.Elapsed.TotalMilliseconds))"
$proc.Refresh()
if($proc.HasExited){
  Write-Host "CONTROL_PANEL_SMOKE_EXITED=True"
  Write-Host "CONTROL_PANEL_SMOKE_EXIT_CODE=$($proc.ExitCode)"
  if(Test-Path $stderrPath){
    $err=(Get-Content $stderrPath -Raw -ErrorAction SilentlyContinue)
    if($err){Write-Host "CONTROL_PANEL_SMOKE_STDERR=$err"}
  }
  if(Test-Path $stdoutPath){
    $out=(Get-Content $stdoutPath -Raw -ErrorAction SilentlyContinue)
    if($out){Write-Host "CONTROL_PANEL_SMOKE_STDOUT=$out"}
  }
  throw 'Control Panel exited during smoke launch'
}else{
  Write-Host "CONTROL_PANEL_SMOKE_EXITED=False"
  Write-Host "CONTROL_PANEL_SMOKE_TITLE=$title"
  if($title -notmatch 'MAGASIN SUPERVISOR.*CONTROL CENTER'){
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    throw "Control Panel process stayed alive but V2 window title was not visible within 12 seconds: $title"
  }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Write-Host "CONTROL_PANEL_LAUNCH_SMOKE=PASS"
}
}


Write-Host "=== LIVE RESUME BRAIN STATE ==="
$registryPath=Join-Path $root 'lane-registry.json'
$statusPath=Join-Path $root 'lane-status.json'
if(Test-Path $registryPath){
  try{
    $registryJson=Get-Content $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $lane=$registryJson.lanes.'lane-1'
    if($lane){
      Write-Host "RESUME_BRAIN_URL_PRESENT=$(-not [string]::IsNullOrWhiteSpace([string]$lane.brain_url))"
      Write-Host "RESUME_WORK_URL_PRESENT=$(-not [string]::IsNullOrWhiteSpace([string]$lane.work_url))"
      Write-Host "RESUME_TASK_ID=$([string]$lane.task_id)"
      Write-Host "RESUME_AWAITING_WORK=$([bool]$lane.awaiting_work)"
      Write-Host "RESUME_BRAIN_REQUEST_SENT=$([bool]$lane.brain_request_sent)"
      Write-Host "RESUME_LAST_BRAIN_DIGEST=$([string]$lane.last_brain_directive_digest)"
      Write-Host "RESUME_INSTRUCTION_DIGEST=$([string]$lane.instruction_digest)"
      Write-Host "RESUME_APPLIED_BRAIN_REV=$([string]$lane.applied_brain_url_revision)"
      Write-Host "RESUME_APPLIED_RESUME_REV=$([string]$lane.applied_resume_revision)"
      Write-Host "RESUME_RECOVERY_VERSION=$([string]$lane.brain_resume_recovery_version)"
      Write-Host "RESUME_DISPATCH_INFLIGHT=$([bool]($null -ne $lane.dispatch_inflight))"
      Write-Host "RESUME_RELAY_INFLIGHT=$([bool]($null -ne $lane.relay_inflight))"
    }
  }catch{
    Write-Host "RESUME_REGISTRY_READ_ERROR=$($_.Exception.Message)"
  }
}
if(Test-Path $statusPath){
  try{
    $rawStatus=Get-Content $statusPath -Raw -Encoding UTF8
    Write-Host "RESUME_STATUS_RAW=$rawStatus"
  }catch{
    Write-Host "RESUME_STATUS_READ_ERROR=$($_.Exception.Message)"
  }
}
$supervisorLog=Join-Path $root 'supervisor.log'
if(Test-Path $supervisorLog){
  $tail=Get-Content $supervisorLog -Tail 500 -Encoding UTF8
  foreach($line in $tail){
    try{
      $obj=$line | ConvertFrom-Json -ErrorAction Stop
      $type=[string]$obj.type
      if($type -match 'LANE_OWNER_RESUME_BRAIN_RESYNC|LANE_BRAIN_DIRECTIVE|LANE_BRAIN_STALE_DIRECTIVE|LANE_BRAIN_SEND|LANE_WORK_DISPATCH|LANE_WORK_SEND'){
        $laneId=[string]$obj.lane_id
        if(-not $laneId){$laneId=[string]$obj.laneId}
        if(-not $laneId -or $laneId -eq 'lane-1'){
          $task=[string]$obj.task_id
          if(-not $task){$task=[string]$obj.taskId}
          $digest=[string]$obj.digest
          $reason=[string]$obj.reason
          $errorName=[string]$obj.error_name
          if(-not $errorName){$errorName=[string]$obj.errorName}
          Write-Host "RESUME_LOG=TYPE=$type|TASK=$task|DIGEST=$digest|ERROR=$errorName|REASON=$reason"
        }
      }
    }catch{}
  }
}
Write-Host "LIVE_RESUME_BRAIN_STATE=PASS"


Write-Host "=== STALE LANE LOOP DIAG ==="
$statusPath=Join-Path $root 'lane-status.json'
if(Test-Path $statusPath){
  $statusItem=Get-Item $statusPath
  Write-Host "STALE_STATUS_UTC=$($statusItem.LastWriteTimeUtc.ToString('o'))"
  Write-Host "STALE_STATUS_AGE_SECONDS=$([math]::Round(((Get-Date).ToUniversalTime()-$statusItem.LastWriteTimeUtc).TotalSeconds,1))"
}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and (
      $_.CommandLine -like '*run-supervisor.ps1*' -or
      $_.CommandLine -like '*three-lane-cli.mjs*'
    )
  } |
  Sort-Object ProcessId |
  ForEach-Object {
    $gp=Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue
    $start=''
    $cpu=''
    if($gp){
      try{$start=$gp.StartTime.ToUniversalTime().ToString('o')}catch{}
      try{$cpu=[math]::Round([double]$gp.CPU,2)}catch{}
    }
    Write-Host "STALE_PROCESS=$($_.ProcessId)|PPID=$($_.ParentProcessId)|NAME=$($_.Name)|START=$start|CPU=$cpu|CMD=$($_.CommandLine)"
  }

$supervisorLog=Join-Path $root 'supervisor.log'
if(Test-Path $supervisorLog){
  Write-Host "STALE_SUPERVISOR_LOG_TAIL_BEGIN"
  Get-Content $supervisorLog -Tail 120 -Encoding UTF8 | ForEach-Object { Write-Host "STALE_LOG=$_" }
  Write-Host "STALE_SUPERVISOR_LOG_TAIL_END"
}
Write-Host "STALE_LANE_LOOP_DIAG=PASS"

# POST_BOUNDED_RESUME_LIVE_ACCEPTANCE_V1

Write-Host "=== BRAIN PLAN LIVE STATE V2 ==="
$registryPath=Join-Path $root 'lane-registry.json'
$statusPath=Join-Path $root 'lane-status.json'
$supervisorLog=Join-Path $root 'supervisor.log'

if(Test-Path $registryPath){
  try{
    $registryJson=Get-Content $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $lane=$registryJson.lanes.'lane-1'
    if($lane){
      $planKnown=$false
      $planTotal=0
      $planDone=0
      $planUpdated=''
      if($lane.project_progress){
        $planKnown=[bool]$lane.project_progress.plan_known
        $tasks=@($lane.project_progress.tasks)
        $planTotal=$tasks.Count
        $planDone=@($tasks | Where-Object { [string]$_.state -eq 'DONE' }).Count
        $planUpdated=[string]$lane.project_progress.updated_at
      }
      Write-Host "BRAIN_PLAN_TASK_ID=$([string]$lane.task_id)"
      Write-Host "BRAIN_PLAN_AWAITING_WORK=$([bool]$lane.awaiting_work)"
      Write-Host "BRAIN_PLAN_REQUEST_SENT=$([bool]$lane.brain_request_sent)"
      Write-Host "BRAIN_PLAN_LAST_DIRECTIVE_DIGEST=$([string]$lane.last_brain_directive_digest)"
      Write-Host "BRAIN_PLAN_BOOTSTRAP_RETRIES=$([string]$lane.project_plan_bootstrap_retries)"
      Write-Host "BRAIN_PLAN_IDLE_RECHECK_RETRIES=$([string]$lane.brain_idle_recheck_retries)"
      Write-Host "BRAIN_PLAN_KNOWN=$planKnown"
      Write-Host "BRAIN_PLAN_TOTAL=$planTotal"
      Write-Host "BRAIN_PLAN_DONE=$planDone"
      Write-Host "BRAIN_PLAN_UPDATED_AT=$planUpdated"
      if($lane.brain_request_inflight){
        $b=$lane.brain_request_inflight
        Write-Host "BRAIN_PLAN_INFLIGHT=True"
        Write-Host "BRAIN_PLAN_INFLIGHT_DIGEST=$([string]$b.digest)"
        Write-Host "BRAIN_PLAN_INFLIGHT_MARKER=$([string]$b.marker)"
        $reloaded=$false
        $blocked=$false
        if($b.PSObject.Properties['reconcile_reloaded']){$reloaded=[bool]$b.reconcile_reloaded}
        if($b.PSObject.Properties['reconcile_blocked']){$blocked=[bool]$b.reconcile_blocked}
        Write-Host "BRAIN_PLAN_INFLIGHT_RELOADED=$reloaded"
        Write-Host "BRAIN_PLAN_INFLIGHT_BLOCKED=$blocked"
        Write-Host "BRAIN_PLAN_INFLIGHT_PRE_USER_COUNT=$([string]$b.pre_user_count)"
        Write-Host "BRAIN_PLAN_INFLIGHT_PRE_MAX_TURN=$([string]$b.pre_max_turn_ordinal)"
      }else{
        Write-Host "BRAIN_PLAN_INFLIGHT=False"
      }
    }
  }catch{
    Write-Host "BRAIN_PLAN_REGISTRY_READ_ERROR=$($_.Exception.Message)"
  }
}

if(Test-Path $statusPath){
  try{
    $statusJson=Get-Content $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $laneStatus=@($statusJson.lanes | Where-Object { [string]$_.lane_id -eq 'lane-1' } | Select-Object -First 1)[0]
    if($laneStatus){
      Write-Host "BRAIN_PLAN_STATUS=$([string]$laneStatus.status)"
      Write-Host "BRAIN_PLAN_STATUS_MESSAGE=$([string]$laneStatus.message)"
      Write-Host "BRAIN_PLAN_STATUS_KNOWN=$([string]$laneStatus.project_progress_known)"
      Write-Host "BRAIN_PLAN_STATUS_TOTAL=$([string]$laneStatus.project_total_tasks)"
      Write-Host "BRAIN_PLAN_STATUS_DONE=$([string]$laneStatus.project_completed_tasks)"
      Write-Host "BRAIN_PLAN_STATUS_PERCENT=$([string]$laneStatus.project_progress_percent)"
    }
  }catch{
    Write-Host "BRAIN_PLAN_STATUS_READ_ERROR=$($_.Exception.Message)"
  }
}

if(Test-Path $supervisorLog){
  try{
    $tail=Get-Content $supervisorLog -Tail 1000 -Encoding UTF8
    foreach($line in $tail){
      try{
        $obj=$line | ConvertFrom-Json -ErrorAction Stop
        $type=[string]$obj.type
        if($type -match 'LANE_(BRAIN|PROJECT_PLAN|OWNER_RESUME|WORK_SEND|WORK_DISPATCH|RESULT_RELAY)'){
          $laneId=[string]$obj.laneId
          if(-not $laneId){$laneId=[string]$obj.lane_id}
          if(-not $laneId -or $laneId -eq 'lane-1'){
            $reason=[string]$obj.reason
            $error=[string]$obj.error
            if(-not $error){$error=[string]$obj.errorName}
            $digest=[string]$obj.digest
            Write-Host "BRAIN_PLAN_LOG=TYPE=$type|DIGEST=$digest|ERROR=$error|REASON=$reason"
          }
        }
      }catch{}
    }
  }catch{
    Write-Host "BRAIN_PLAN_LOG_READ_ERROR=$($_.Exception.Message)"
  }
}
Write-Host "BRAIN_PLAN_LIVE_STATE_V2=PASS"

Write-Host "=== BRAIN DOM CDP DIAG ==="
try{
  $domDiag=Join-Path $PSScriptRoot 'diag-brain-dom.mjs'
  if(Test-Path $domDiag){
    $domOut=& node $domDiag $root 2>&1
    $domExit=$LASTEXITCODE
    foreach($line in @($domOut)){ Write-Host "BRAIN_DOM_OUT=$line" }
    Write-Host "BRAIN_DOM_EXIT=$domExit"
  }else{
    Write-Host "BRAIN_DOM_SCRIPT_MISSING=True"
  }
}catch{
  Write-Host "BRAIN_DOM_ERROR=$($_.Exception.Message)"
}
Write-Host "BRAIN_DOM_CDP_DIAG=PASS"
# BRAIN_DOM_STRUCTURE_V2
# POST_MODERN_DOM_LIVE_V1
