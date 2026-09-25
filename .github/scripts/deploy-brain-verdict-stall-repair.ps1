param(
  [Parameter(Mandatory=$true)]
  [string]$TargetComputer
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'TARGET_MATCH=False'
  Write-Host 'TARGET_SKIP_SAFE=True'
  exit 0
}
Write-Host 'TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$configFile=Join-Path $root 'lanes.json'
$registryFile=Join-Path $root 'lane-registry.json'
$statusFile=Join-Path $root 'lane-status.json'
$logFile=Join-Path $root 'supervisor.log'
$stopFile=Join-Path $root 'STOP'
$startScript=Join-Path $runtime 'windows\start-supervisor.ps1'
$lifecycle=Join-Path $runtime 'windows\lifecycle-truth.ps1'
$panelTarget=Join-Path $runtime 'windows\control-panel.ps1'
$shortcutPath=Join-Path ([Environment]::GetFolderPath('Desktop')) 'MAGASIN BUSINESS OS CONTROL.lnk'

foreach($p in @($configFile,$registryFile,$statusFile,$startScript,$lifecycle)){
  if(-not (Test-Path $p)){throw "Missing required path: $p"}
}

function P($o,[string]$n,$d=$null){
  if($null -eq $o){return $d}
  $p=$o.PSObject.Properties[$n]
  if($null -eq $p){return $d}
  return $p.Value
}

function Get-TargetFingerprint{
  $cfg=Get-Content $configFile -Raw -Encoding UTF8|ConvertFrom-Json
  $canonical=@($cfg.lanes|Sort-Object lane_id|ForEach-Object{
    "$([string]$_.lane_id)|$([bool]$_.enabled)|$([string]$_.brain_url)|$([int]$_.brain_url_revision)|$([string]$_.work_url)|$([int]$_.work_url_revision)|$([string]$_.work_mode)"
  }) -join [Environment]::NewLine
  $bytes=[Text.Encoding]::UTF8.GetBytes($canonical)
  $sha=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}
  finally{$sha.Dispose()}
}

if(Test-Path $stopFile){
  Write-Host 'DEPLOY_RESULT=DEFERRED_OWNER_STOP'
  exit 0
}

$cfg=Get-Content $configFile -Raw -Encoding UTF8|ConvertFrom-Json
$reg=Get-Content $registryFile -Raw -Encoding UTF8|ConvertFrom-Json
$st=Get-Content $statusFile -Raw -Encoding UTF8|ConvertFrom-Json
$enabled=@($cfg.lanes|Where-Object{[bool]$_.enabled})
Write-Host "ENABLED_LANES=$($enabled.Count)"

foreach($lc in $enabled){
  $id=[string]$lc.lane_id
  $lane=$reg.lanes.$id
  $task=[string](P $lane 'task_id' '')
  $awaiting=[bool](P $lane 'awaiting_work' $false)
  $dispatch=$null -ne (P $lane 'dispatch_inflight' $null)
  $relay=$null -ne (P $lane 'relay_inflight' $null)
  Write-Host "PRE_${id}_TASK=$task"
  Write-Host "PRE_${id}_AWAITING=$awaiting"
  Write-Host "PRE_${id}_DISPATCH=$dispatch"
  Write-Host "PRE_${id}_RELAY=$relay"
  if($awaiting -or $dispatch -or $relay -or -not [string]::IsNullOrWhiteSpace($task)){
    Write-Host "DEPLOY_RESULT=DEFERRED_ACTIVE_LANE_${id}"
    exit 0
  }
}

$fingerprintBefore=Get-TargetFingerprint
$deployedAt=[DateTimeOffset]::UtcNow

. $lifecycle
$wrapper=Get-LifecycleSupervisorWrapper -Root $root
if($wrapper){
  Stop-Process -Id ([int]$wrapper.ProcessId) -Force -ErrorAction Stop
  Write-Host "OLD_WRAPPER_STOPPED=$($wrapper.ProcessId)"
}
Start-Sleep -Milliseconds 500

$runtimeRoot=Join-Path $root 'runtime'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and
    $_.CommandLine -like '*three-lane-cli.mjs*' -and
    $_.CommandLine -like "*$runtimeRoot*"
  } |
  ForEach-Object {
    Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
    Write-Host "OLD_THREE_LANE_STOPPED=$($_.ProcessId)"
  }

$files=@('src\runtime\three-lane-cli.mjs','windows\control-panel.ps1')
$utf8NoBom=New-Object System.Text.UTF8Encoding($false)
$utf8Bom=New-Object System.Text.UTF8Encoding($true)
foreach($rel in $files){
  $src=Join-Path $env:GITHUB_WORKSPACE $rel
  $dst=Join-Path $runtime $rel
  $content=Get-Content $src -Raw -Encoding UTF8
  if($rel -eq 'windows\control-panel.ps1'){
    [System.IO.File]::WriteAllText($dst,$content,$utf8Bom)
  }else{
    [System.IO.File]::WriteAllText($dst,$content,$utf8NoBom)
  }
  if($rel -eq 'windows\control-panel.ps1'){
    $installedText=Get-Content $dst -Raw -Encoding UTF8
    if($installedText -ne $content){throw "Installed text mismatch: $rel"}
  }elseif((Get-FileHash -Algorithm SHA256 $src).Hash -ne (Get-FileHash -Algorithm SHA256 $dst).Hash){
    throw "Installed hash mismatch: $rel"
  }
  Write-Host "DEPLOYED=$rel"
}

$installedCli=Get-Content (Join-Path $runtime 'src\runtime\three-lane-cli.mjs') -Raw -Encoding UTF8
if($installedCli -notmatch 'LANE_BRAIN_STALE_DIRECTIVE_SKIPPED'){throw 'Brain recovery marker missing after deploy.'}
$installedPanel=Get-Content $panelTarget -Raw -Encoding UTF8
if($installedPanel -notmatch 'for \(\$eventIndex = \$events\.Count - 1; \$eventIndex -ge 0; \$eventIndex--\)'){
  throw 'Newest-first timeline marker missing after deploy.'
}

# Re-arm Brain planning only for enabled, completely idle lanes. Keep the last
# directive digest so the repaired runtime refuses to re-adopt the stale turn.
$reg=Get-Content $registryFile -Raw -Encoding UTF8|ConvertFrom-Json
$rearmed=0
foreach($lc in $enabled){
  $id=[string]$lc.lane_id
  $lane=$reg.lanes.$id
  $lane.brain_request_sent=$false
  $lane.brain_request_inflight=$null
  $rearmed+=1
  Write-Host "BRAIN_REARMED=$id"
}
$temp=$registryFile+'.repair.'+[guid]::NewGuid().ToString('N')+'.tmp'
$json=$reg|ConvertTo-Json -Depth 30
[System.IO.File]::WriteAllText($temp,$json+[Environment]::NewLine,$utf8NoBom)
$written=$false
for($i=0;$i -lt 8;$i++){
  try{
    Move-Item -Path $temp -Destination $registryFile -Force
    $written=$true
    break
  }catch{
    Start-Sleep -Milliseconds (150*($i+1))
  }
}
if(-not $written){throw 'Could not commit Brain rearm registry state.'}
Write-Host "BRAIN_REARM_COUNT=$rearmed"

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startScript -Hidden -Recovery
if($LASTEXITCODE -ne 0){throw 'Supervisor recovery start failed.'}
Write-Host 'RECOVERY_START_REQUESTED=True'

# Reload Control Panel so newest-first ordering is visible immediately.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object {$_.CommandLine -and $_.CommandLine -like '*control-panel.ps1*'} |
  ForEach-Object {
    Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
    Write-Host "OLD_PANEL_STOPPED=$($_.ProcessId)"
  }
Start-Sleep -Milliseconds 600
& explorer.exe $shortcutPath

$fresh=$false
$healthy=$false
$newTask=$false
$brainReissued=$false
for($i=0;$i -lt 120;$i++){
  Start-Sleep -Seconds 1
  $truth=Get-LifecycleProcessTruth -Root $root
  if(Test-Path $statusFile){
    try{
      $candidate=Get-Content $statusFile -Raw -Encoding UTF8|ConvertFrom-Json
      $u=[DateTimeOffset]::MinValue
      if([DateTimeOffset]::TryParse([string]$candidate.updated_at,[ref]$u) -and
         $u.ToUniversalTime() -ge $deployedAt.AddSeconds(-2)){
        $fresh=$true
      }
    }catch{}
  }
  $regNow=Get-Content $registryFile -Raw -Encoding UTF8|ConvertFrom-Json
  $laneNow=$regNow.lanes.'lane-1'
  $newTask=-not [string]::IsNullOrWhiteSpace([string](P $laneNow 'task_id' ''))
  $brainReissued=[bool](P $laneNow 'brain_request_sent' $false) -or ($null -ne (P $laneNow 'brain_request_inflight' $null))
  if($truth.healthy -and $fresh -and ($newTask -or $brainReissued)){
    $healthy=$true
    break
  }
}
if(-not $healthy){throw 'Runtime did not return to healthy fresh Brain-planning state.'}

$errors=0
if(Test-Path $logFile){
  foreach($line in @(Get-Content $logFile -Tail 800 -ErrorAction SilentlyContinue)){
    try{
      $e=$line|ConvertFrom-Json
      $ts=[DateTimeOffset]::MinValue
      if([DateTimeOffset]::TryParse([string](P $e 'timestamp' ''),[ref]$ts) -and
         $ts.ToUniversalTime() -ge $deployedAt.AddSeconds(-2) -and
         [string](P $e 'reason' '') -match 'previous_result task_id does not match durable lane truth'){
        $errors+=1
      }
    }catch{}
  }
}
Write-Host "POST_DEPLOY_PREVIOUS_RESULT_ERROR_COUNT=$errors"
if($errors -ne 0){throw 'Brain previous_result mismatch recurred after repaired runtime started.'}

$fingerprintAfter=Get-TargetFingerprint
if($fingerprintBefore -ne $fingerprintAfter){throw 'Brain/Work target fingerprint changed during repair.'}

$regFinal=Get-Content $registryFile -Raw -Encoding UTF8|ConvertFrom-Json
$laneFinal=$regFinal.lanes.'lane-1'
Write-Host "POST_TASK=$([string](P $laneFinal 'task_id' ''))"
Write-Host "POST_AWAITING=$([bool](P $laneFinal 'awaiting_work' $false))"
Write-Host "POST_BRAIN_REQUEST_SENT=$([bool](P $laneFinal 'brain_request_sent' $false))"
Write-Host "POST_BRAIN_INFLIGHT=$($null -ne (P $laneFinal 'brain_request_inflight' $null))"
Write-Host 'TARGET_FINGERPRINT_UNCHANGED=True'
Write-Host 'TIMELINE_NEWEST_FIRST=True'
Write-Host 'BRAIN_VERDICT_STALL_REPAIR=PASS'

# marker-handshake production activation trigger
