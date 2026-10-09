param(
  [ValidateSet('Install','Verify')][string]$Mode='Verify'
)
$ErrorActionPreference='Stop'
$task='MAGASIN SC013 Local 30min'
$python='C:\MAGASIN_MCP\.venv\Scripts\python.exe'
$destination='D:\MAGASIN_ROBOTS\robots\coordinator\sc013-local-30m-tick.py'
$source=Join-Path $PSScriptRoot 'sc013-local-30m-tick.py'
if([Environment]::MachineName -ne 'DESKTOP-H4A16IL'){throw 'WRONG_TARGET_MACHINE'}
if(!(Test-Path $python)){throw 'LOCAL_MCP_PYTHON_MISSING'}
if($Mode -eq 'Install'){
  if(!(Test-Path $source)){throw 'REVIEWED_SCRIPT_MISSING'}
  if([Security.Principal.WindowsIdentity]::GetCurrent().Name -notmatch '\\admin$'){
    throw 'AUTHORIZED_LOCAL_ADMIN_SESSION_REQUIRED'
  }
  New-Item -ItemType Directory -Path (Split-Path $destination) -Force|Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Force
  & $python -m py_compile $destination
  if($LASTEXITCODE -ne 0){throw 'SOURCE_SYNTAX_FAILED'}
  # Interactive Owner profile is intentional: no new privileged SYSTEM
  # service, no credential installation and no specialist autostart.
  $line='"'+$python+'" "'+$destination+'" --local-task'
  & schtasks.exe /Create /TN $task /TR $line /SC MINUTE /MO 30 /ST 13:47 /F
  if($LASTEXITCODE -ne 0){throw 'WINDOWS_TASK_CREATION_FAILED'}
  $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Set-ScheduledTask -TaskName $task -Settings $settings|Out-Null
}
$t=Get-ScheduledTask -TaskName $task -ErrorAction Stop
$info=Get-ScheduledTaskInfo -TaskName $task
if($t.Principal.LogonType -ne 'Interactive' -or $t.Principal.UserId -notmatch 'admin$'){
  throw 'TASK_PRINCIPAL_NOT_OWNER_SESSION'
}
if(!$t.Settings.StartWhenAvailable -or [string]$t.Settings.MultipleInstances -ne 'IgnoreNew' -or
   [string]$t.Settings.ExecutionTimeLimit -ne 'PT5M'){
  throw 'WINDOWS_TASK_SAFETY_SETTINGS_MISSING'
}
$payload=[ordered]@{
  task=$task
  machine=[Environment]::MachineName
  principal=[string]$t.Principal.UserId
  mode=$Mode
  next_run=$info.NextRunTime.ToString('o')
  last_run=$info.LastRunTime.ToString('o')
  last_result=$info.LastTaskResult
  state=[string]$t.State
  owner_logged_in_required=$true
  outbound_chatgpt_send=$false
  safe_technical_tick_only=$true
}
$payload|ConvertTo-Json -Compress
