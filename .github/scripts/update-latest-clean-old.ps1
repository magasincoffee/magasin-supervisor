param(
  [Parameter(Mandatory=$true)]
  [string]$TargetComputer,
  [Parameter(Mandatory=$true)]
  [string]$ExpectedMainSha
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

$canonical=Get-SupervisorStateRoot -Compatibility 'platform-default'
if(-not [string]::IsNullOrWhiteSpace([string]$env:SUPERVISOR_STATE_ROOT)){
  $canonical=[System.IO.Path]::GetFullPath([string]$env:SUPERVISOR_STATE_ROOT)
}
$canonical=Set-SupervisorStateRootBinding -Root $canonical

$base=[string]$env:LOCALAPPDATA
if([string]::IsNullOrWhiteSpace($base)){$base=[string]$env:USERPROFILE}
if([string]::IsNullOrWhiteSpace($base)){throw 'Cannot resolve local app data root.'}

$legacy=Join-Path $base 'MAGASIN\BusinessOS\supervisor'
$runtime=Join-Path $canonical 'runtime'
$configFile=Join-Path $canonical 'lanes.json'
$registryFile=Join-Path $canonical 'lane-registry.json'
$desktop=[Environment]::GetFolderPath('Desktop')
$shortcutPath=Join-Path $desktop 'MAGASIN BUSINESS OS CONTROL.lnk'
$installScript=Join-Path $env:GITHUB_WORKSPACE 'windows\install-supervisor.ps1'

Write-Host "EXPECTED_MAIN_SHA=$ExpectedMainSha"
Write-Host "CANONICAL_ROOT=$canonical"
Write-Host "LEGACY_ROOT=$legacy"

foreach($p in @($configFile,$registryFile,$installScript)){
  if(-not (Test-Path $p)){throw "Missing required path: $p"}
}

function Get-TargetFingerprint([string]$Path){
  $cfg=Get-Content $Path -Raw -Encoding UTF8|ConvertFrom-Json
  $canonicalText=@($cfg.lanes|Sort-Object lane_id|ForEach-Object{
    "$([string]$_.lane_id)|$([bool]$_.enabled)|$([string]$_.brain_url)|$([int]$_.brain_url_revision)|$([string]$_.work_url)|$([int]$_.work_url_revision)|$([string]$_.work_mode)"
  }) -join [Environment]::NewLine
  $bytes=[Text.Encoding]::UTF8.GetBytes($canonicalText)
  $sha=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}
  finally{$sha.Dispose()}
}

$cfgBefore=Get-Content $configFile -Raw -Encoding UTF8|ConvertFrom-Json
$enabledBefore=@($cfgBefore.lanes|Where-Object{[bool]$_.enabled}).Count
Write-Host "ENABLED_LANES_BEFORE=$enabledBefore"
if($enabledBefore -ne 0){
  Write-Host 'UPDATE_RESULT=DEFERRED_ENABLED_LANES'
  exit 0
}

$fingerprintBefore=Get-TargetFingerprint $configFile
$regBefore=Get-Content $registryFile -Raw -Encoding UTF8|ConvertFrom-Json

$sourcePanel=Get-Content (Join-Path $env:GITHUB_WORKSPACE 'windows\control-panel.ps1') -Raw -Encoding UTF8
foreach($marker in @('RESET READY','$resetAllButton = New-Object Windows.Forms.Button','Request-RunnerRecovery','Request-LifecycleRecovery','for ($eventIndex = $events.Count - 1; $eventIndex -ge 0; $eventIndex--)')){
  if($sourcePanel -notmatch [regex]::Escape($marker)){
    throw "Latest source panel marker missing: $marker"
  }
}
Write-Host 'LATEST_PANEL_MARKERS=PASS'

Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and
    ($_.CommandLine -like '*control-panel.ps1*' -or $_.CommandLine -like '*run-supervisor.ps1*')
  } |
  ForEach-Object {
    Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
    Write-Host "OLD_POWERSHELL_STOPPED=$($_.ProcessId)"
  }

Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and $_.CommandLine -match '(supervisor-loop-cli|brain-worker-cli|three-lane-cli)\.mjs'
  } |
  ForEach-Object {
    Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
    Write-Host "OLD_NODE_STOPPED=$($_.ProcessId)"
  }

Start-Sleep -Milliseconds 900

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installScript -SourceRoot $env:GITHUB_WORKSPACE
if($LASTEXITCODE -ne 0){throw 'Current runtime install failed.'}
Write-Host 'CANONICAL_RUNTIME_REPLACED=True'

if(Test-Path $legacy){
  if([System.IO.Path]::GetFullPath($legacy).TrimEnd('\') -eq [System.IO.Path]::GetFullPath($canonical).TrimEnd('\')){
    throw 'Legacy path aliases canonical root.'
  }
  Remove-Item $legacy -Recurse -Force -ErrorAction Stop
  Write-Host 'LEGACY_ROOT_DELETED=True'
}else{
  Write-Host 'LEGACY_ROOT_DELETED=ALREADY_ABSENT'
}

@(
  'START_MAGASIN_SUPERVISOR.cmd',
  'STOP_MAGASIN_SUPERVISOR.cmd',
  'START_MAGASIN_SUPERVISOR.lnk',
  'STOP_MAGASIN_SUPERVISOR.lnk',
  'SAYDI CONTROL.lnk'
) | ForEach-Object {
  $p=Join-Path $desktop $_
  if(Test-Path $p){
    Remove-Item $p -Force -ErrorAction SilentlyContinue
    Write-Host "OLD_SHORTCUT_DELETED=$p"
  }
}

$installedPanel=Get-Content (Join-Path $runtime 'windows\control-panel.ps1') -Raw -Encoding UTF8
foreach($marker in @('RESET READY','$resetAllButton = New-Object Windows.Forms.Button','Request-RunnerRecovery','Request-LifecycleRecovery','for ($eventIndex = $events.Count - 1; $eventIndex -ge 0; $eventIndex--)')){
  if($installedPanel -notmatch [regex]::Escape($marker)){
    throw "Installed panel marker missing: $marker"
  }
}
Write-Host 'INSTALLED_PANEL_MARKERS=PASS'

if(-not (Test-Path $shortcutPath)){throw 'Unified control panel shortcut missing.'}
$wsh=New-Object -ComObject WScript.Shell
$sc=$wsh.CreateShortcut($shortcutPath)
$expectedPanel=Join-Path $runtime 'windows\control-panel.ps1'
Write-Host "SHORTCUT_TARGET=$($sc.TargetPath)"
Write-Host "SHORTCUT_ARGS=$($sc.Arguments)"
Write-Host "SHORTCUT_WORKDIR=$($sc.WorkingDirectory)"
if($sc.Arguments -notlike "*$expectedPanel*"){throw 'Unified shortcut does not target canonical panel.'}
if([System.IO.Path]::GetFullPath($sc.WorkingDirectory) -ne [System.IO.Path]::GetFullPath($canonical)){
  throw 'Unified shortcut working directory is not canonical.'
}

$fingerprintAfter=Get-TargetFingerprint $configFile
if($fingerprintBefore -ne $fingerprintAfter){throw 'Project target fingerprint changed during update.'}

$cfgAfter=Get-Content $configFile -Raw -Encoding UTF8|ConvertFrom-Json
$enabledAfter=@($cfgAfter.lanes|Where-Object{[bool]$_.enabled}).Count
if($enabledAfter -ne $enabledBefore){throw 'Lane enabled state changed during update.'}

$regAfter=Get-Content $registryFile -Raw -Encoding UTF8|ConvertFrom-Json
foreach($laneName in @('lane-1','lane-2','lane-3')){
  $before=$regBefore.lanes.$laneName
  $after=$regAfter.lanes.$laneName
  if($before -and $after){
    if([string]$before.task_id -ne [string]$after.task_id){throw "Task changed for $laneName."}
    if([bool]$before.awaiting_work -ne [bool]$after.awaiting_work){throw "Awaiting state changed for $laneName."}
  }
}

$legacyProcesses=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {$_.CommandLine -and $_.CommandLine -like "*$legacy*"})
Write-Host "LEGACY_PROCESS_COUNT=$($legacyProcesses.Count)"
if($legacyProcesses.Count -ne 0){throw 'Process still references deleted legacy root.'}

& explorer.exe $shortcutPath
$panel=$null
for($i=0;$i -lt 30;$i++){
  Start-Sleep -Milliseconds 500
  $panel=Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {$_.CommandLine -and $_.CommandLine -like "*$expectedPanel*"} |
    Select-Object -First 1
  if($panel){break}
}
if(-not $panel){throw 'Canonical current control panel did not launch.'}

Write-Host "CURRENT_PANEL_PID=$($panel.ProcessId)"
Write-Host "ENABLED_LANES_AFTER=$enabledAfter"
Write-Host 'TARGET_FINGERPRINT_UNCHANGED=True'
Write-Host 'PROJECT_STATE_PRESERVED=True'
Write-Host 'OLD_VERSIONS_REMOVED=True'
Write-Host 'LATEST_VERSION_UPDATE=PASS'
