#requires -Version 5.1
<#
SC-013 MIG-CC-01 read-only local inventory.
Emits one JSON object on stdout. Does not edit Windows tasks, services,
registry, robot controls, processes, runtime configuration or project data.
No registry values, process arguments, credentials or financial content output.
Never marks robot START/STOP/cutover qualified.
#>
param(
  [switch] $FixtureOnly,
  [string] $FixtureJson = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function New-Result {
  param([string]$HostName)
  [ordered]@{
    schema = 'MAGASIN_SC013_UNIFIED_CONTROL_INVENTORY_V1'
    host = $HostName
    mode = 'READ_ONLY'
    checked_at_utc = [datetimeoffset]::UtcNow.ToString('o')
    milestone = 'MIG-CC-01'
    milestone_status = 'IN_PROGRESS'
    cutover_qualified = $false
    business_dispatch_enabled = $false
    no_live_mutation = $true
    task_evidence = @()
    startup_file_names = @()
    startup_registry_entry_names = @()
    source_hashes = @()
    owner_stop = 'UNKNOWN'
    owner_autostart_disabled = 'UNKNOWN'
    owner_flags = 'UNVERIFIED'
    coordinator_mode = 'UNVERIFIED'
    control_listener = 'UNVERIFIED'
    active_transactions = 'UNVERIFIED_REQUIRES_PROJECT_SPECIFIC_CHECKPOINT'
    blockers = @('TRANSACTION_CHECKPOINTS_NOT_RECONCILED',
                 'REBOOT_OFF_BEHAVIOR_NOT_QUALIFIED',
                 'NATIVE_CHILD_OWNER_START_STOP_NOT_QUALIFIED',
                 'PROJECT_SOT_CUTOVER_NOT_QUALIFIED')
  }
}
$hostName = [Environment]::MachineName
if($FixtureOnly) {
  if([string]::IsNullOrWhiteSpace($FixtureJson)) {throw 'FIXTURE_PATH_REQUIRED'}
  # Fixture-mode is for hosted QA only. No host inventory or actions.
  $fixture=Get-Content -LiteralPath $FixtureJson -Raw -Encoding UTF8 | ConvertFrom-Json
  if($fixture.schema -ne 'MAGASIN_SC013_UNIFIED_CONTROL_INVENTORY_FIXTURE_V1' -or
     $fixture.machine -ne 'SIMULATED_ONLY') {throw 'INVALID_FIXTURE'}
  $output=New-Result -HostName 'SIMULATED_ONLY'
  $output.blockers+=@('FIXTURE_NOT_PRODUCTION_EVIDENCE')
  $output.task_evidence=@($fixture.tasks | ForEach-Object {
     [ordered]@{
       name=[string]$_.name
       state=[string]$_.state
       trigger_enabled=($_.trigger_enabled -eq $true)
       last_result=$_.last_result
       action_kind='SANITIZED_TEST_ONLY'
     }
  })
  $output | ConvertTo-Json -Depth 8 -Compress
  exit 0
}
if($hostName -ne 'DESKTOP-H4A16IL') {throw 'WRONG_MACHINE_NO_INVENTORY'}
$report=New-Result -HostName $hostName
$taskNames=@(
 'MAGASIN Sapo Nightly',
 'MAGASIN Sapo Reconcile',
 'MAGASIN SC013 Local 30min',
 'SAYDI Full Book V4 Resume',
 'SAYDI NATURAL V4 Watchdog',
 'SAYDI V5 CH02 QC Guardian'
)
foreach($name in $taskNames) {
  $task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if($null -eq $task) {
    $report.blockers+=('MISSING_TASK:'+($name -replace '[^A-Za-z0-9 -]',''))
    continue
  }
  $info=Get-ScheduledTaskInfo -TaskName $name -ErrorAction SilentlyContinue
  # Never serialize full script arguments: these can contain secrets.
  $kind=if($name -like 'MAGASIN Sapo*'){'SAPO_LEGACY_DAILY'}
        elseif($name -like 'SAYDI*'){'SAYDI_LEGACY_RESTART'}
        else{'COORDINATOR_READONLY_TICK'}
  $report.task_evidence+=@([ordered]@{
    name = $name
    state = [string]$task.State
    trigger_enabled = (@($task.Triggers|Where-Object {$_.Enabled -eq $true}).Count -gt 0)
    last_result = if($null -ne $info){$info.LastTaskResult}else{$null}
    last_run_utc = if($null -ne $info -and $info.LastRunTime -gt [datetime]'2000-01-01'){
      $info.LastRunTime.ToUniversalTime().ToString('o')}else{$null}
    next_run_utc = if($null -ne $info -and $info.NextRunTime -gt [datetime]'2000-01-01'){
      $info.NextRunTime.ToUniversalTime().ToString('o')}else{$null}
    action_kind = $kind
  })
}
$folders=@([Environment]::GetFolderPath('Startup'),[Environment]::GetFolderPath('CommonStartup'))
foreach($folder in $folders){
  if([string]::IsNullOrWhiteSpace($folder)){continue}
  $files=@(Get-ChildItem -LiteralPath $folder -File -ErrorAction SilentlyContinue |
    Where-Object {$_.Name -match 'MAGASIN|SAYDI|SAPO|Supervisor|Robot'})
  foreach($f in $files){$report.startup_file_names+=@($f.Name)}
}
foreach($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
                 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run')){
  if(!(Test-Path -LiteralPath $key)){continue}
  $props=Get-ItemProperty -LiteralPath $key
  foreach($prop in $props.PSObject.Properties){
    if($prop.Name -match 'MAGASIN|SAYDI|SAPO|Supervisor|Robot'){
      $report.startup_registry_entry_names+=@($prop.Name)
    }
  }
}
$supervisor=Join-Path $env:LOCALAPPDATA 'MAGASIN\BusinessOS\supervisor'
$report.owner_stop=if(Test-Path -LiteralPath (Join-Path $supervisor 'STOP')){'PRESENT'}else{'ABSENT'}
$report.owner_autostart_disabled=if(Test-Path -LiteralPath (Join-Path $supervisor 'AUTOSTART_DISABLED')){'PRESENT'}else{'ABSENT'}
$flags='D:\MAGASIN_ROBOTS\robots\coordinator\config\owner_enabled.json'
if(Test-Path -LiteralPath $flags){
  try{
    $value=Get-Content -LiteralPath $flags -Raw -Encoding UTF8|ConvertFrom-Json
    if($value.supervisor -eq $false -and $value.saydi -eq $false -and $value.sapo -eq $false){
      $report.owner_flags='ALL_OFF_ADVISORY_ONLY'
    }else{$report.owner_flags='UNVERIFIED_OR_ENABLED'}
  }catch{$report.owner_flags='UNREADABLE'}
}
$owner='D:\MAGASIN_ROBOTS\robots\coordinator\state\owner-lifecycle.json'
if(Test-Path -LiteralPath $owner){
  try{
    $value=Get-Content -LiteralPath $owner -Raw -Encoding UTF8|ConvertFrom-Json
    if($value.business_dispatch_enabled -eq $false -and $value.execution_enabled -eq $false){
      $report.coordinator_mode=[string]$value.desired
    }else{$report.coordinator_mode='UNQUALIFIED'}
  }catch{$report.coordinator_mode='UNREADABLE'}
}
$ports=@(Get-NetTCPConnection -LocalPort 8781 -State Listen -ErrorAction SilentlyContinue)
$report.control_listener=if($ports.Count -eq 1 -and $ports[0].LocalAddress -eq '127.0.0.1'){
 'LOOPBACK_ONLY'}else{'UNVERIFIED'}
$files=@(
 'D:\MAGASIN_ROBOTS\control-center\server.py',
 'D:\MAGASIN_ROBOTS\control-center\web\app.js',
 'D:\MAGASIN_ROBOTS\robots\supervisor\control_adapter.py',
 'C:\SAYDI\control\media_control.py',
 'C:\SAYDI\control\RUN_CH02_V5_QC_SAFE.ps1',
 'C:\SAYDI\narration_director_v1\chapter2_v5_qc_guarded.py',
 (Join-Path $env:LOCALAPPDATA 'MAGASIN\SAPO\control_center.py'),
 (Join-Path $env:LOCALAPPDATA 'MAGASIN\SAPO\diagnostic_runner.py')
)
foreach($file in $files){
  if(Test-Path -LiteralPath $file -PathType Leaf){
    $report.source_hashes+=@([ordered]@{
      path=$file
      sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    })
  }else{
    $report.blockers+=('MISSING_SOURCE:'+([io.path]::GetFileName($file)))
  }
}
$report | ConvertTo-Json -Depth 8 -Compress
