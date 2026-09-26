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
$shortcutDisplayName='MAGASIN SUPERVISOR '+[char]0x2014+' CONTROL CENTER.lnk'
$shortcutPath=Join-Path $desktop $shortcutDisplayName
$installScript=Join-Path $env:GITHUB_WORKSPACE 'windows\install-supervisor.ps1'
$lifecycleScript=Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1'

Write-Host "EXPECTED_MAIN_SHA=$ExpectedMainSha"
Write-Host "CANONICAL_ROOT=$canonical"
Write-Host "LEGACY_ROOT=$legacy"

foreach($p in @($configFile,$registryFile,$installScript,$lifecycleScript)){
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
$fingerprintBefore=Get-TargetFingerprint $configFile
$regBefore=Get-Content $registryFile -Raw -Encoding UTF8|ConvertFrom-Json

if($enabledBefore -ne 0){
  . $lifecycleScript
  $ownerStop=Get-LifecycleOwnerStopState -Root $canonical
  if($ownerStop.blocked){
    Write-Host 'UPDATE_RESULT=DEFERRED_OWNER_STOP'
    exit 0
  }

  $sourceSrc=Join-Path $env:GITHUB_WORKSPACE 'src'
  $targetSrc=Join-Path $runtime 'src'
  $sourcePackage=Join-Path $env:GITHUB_WORKSPACE 'package.json'
  $targetPackage=Join-Path $runtime 'package.json'
  $sourcePanel=Join-Path $env:GITHUB_WORKSPACE 'windows\control-panel.ps1'
  $targetPanel=Join-Path $runtime 'windows\control-panel.ps1'
  $sourceWrapper=Join-Path $env:GITHUB_WORKSPACE 'windows\run-supervisor.ps1'
  $targetWrapper=Join-Path $runtime 'windows\run-supervisor.ps1'
  $sourceOpenChat=Join-Path $env:GITHUB_WORKSPACE 'windows\open-supervisor-chat.ps1'
  $targetOpenChat=Join-Path $runtime 'windows\open-supervisor-chat.ps1'
  foreach($p in @($sourceSrc,$targetSrc,$sourcePackage,$targetPackage,$sourcePanel,$targetPanel,$sourceWrapper,$targetWrapper,$sourceOpenChat,$targetOpenChat)){
    if(-not (Test-Path $p)){throw "Active-lane hotpatch missing required path: $p"}
  }

  $sourcePackageHash=(Get-FileHash $sourcePackage -Algorithm SHA256).Hash
  $targetPackageHash=(Get-FileHash $targetPackage -Algorithm SHA256).Hash
  if($sourcePackageHash -ne $targetPackageHash){
    Write-Host 'UPDATE_RESULT=DEFERRED_PACKAGE_CHANGE'
    exit 0
  }

  Write-Host 'ACTIVE_LANE_HOTPATCH_BEGIN=True'
  Copy-Item (Join-Path $sourceSrc '*') $targetSrc -Recurse -Force
  Copy-Item $sourcePanel $targetPanel -Force
  Copy-Item $sourceWrapper $targetWrapper -Force
  Copy-Item $sourceOpenChat $targetOpenChat -Force
  Write-Host 'HOTPATCH_WINDOWS_LAUNCHERS_REFRESHED=True'

  # Windows PowerShell 5.1 decodes UTF-8 scripts without BOM as the active
  # ANSI code page. Re-encode the installed Control Panel exactly like the
  # canonical full installer so Vietnamese UI strings remain parse-safe.
  $panelText=Get-Content $targetPanel -Raw -Encoding UTF8
  $utf8Bom=New-Object System.Text.UTF8Encoding($true)
  [System.IO.File]::WriteAllText($targetPanel,$panelText,$utf8Bom)

  $targetPanelText=Get-Content $targetPanel -Raw -Encoding UTF8
  $sourcePanelText=Get-Content $sourcePanel -Raw -Encoding UTF8
  if($targetPanelText -ne $sourcePanelText){throw 'Hotpatch Control Panel content mismatch after UTF-8 BOM rewrite.'}
  Write-Host 'HOTPATCH_CONTROL_PANEL_UTF8_BOM=True'

  $sourceActions=Join-Path $sourceSrc 'ui\actions.mjs'
  $targetActions=Join-Path $targetSrc 'ui\actions.mjs'
  if(-not (Test-Path $targetActions)){throw 'Hotpatch target actions.mjs missing after overlay.'}
  $sourceActionsHash=(Get-FileHash $sourceActions -Algorithm SHA256).Hash
  $targetActionsHash=(Get-FileHash $targetActions -Algorithm SHA256).Hash
  if($sourceActionsHash -ne $targetActionsHash){throw 'Hotpatch actions.mjs hash mismatch.'}
  Write-Host "HOTPATCH_ACTIONS_SHA256=$targetActionsHash"

  $wrapper=Get-LifecycleSupervisorWrapper -Root $canonical
  if($wrapper){
    $wrapperPid=[int]$wrapper.ProcessId
    $child=Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        [int]$_.ParentProcessId -eq $wrapperPid -and
        $_.CommandLine -and $_.CommandLine -like '*three-lane-cli.mjs*'
      } |
      Select-Object -First 1
    if($child){
      Stop-Process -Id ([int]$child.ProcessId) -Force -ErrorAction Stop
      Write-Host "HOTPATCH_OLD_THREE_LANE_STOPPED=$($child.ProcessId)"
    }else{
      Write-Host 'HOTPATCH_CHILD_ALREADY_ABSENT=True'
    }
  }else{
    $startScript=Join-Path $runtime 'windows\start-supervisor.ps1'
    if(-not (Test-Path $startScript)){throw 'Hotpatch recovery start script missing.'}
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startScript -Hidden -Recovery
    if($LASTEXITCODE -ne 0){throw 'Hotpatch recovery start failed.'}
    Write-Host 'HOTPATCH_RECOVERY_START_REQUESTED=True'
  }

  $healthy=$false
  for($i=0;$i -lt 60;$i++){
    Start-Sleep -Milliseconds 500
    $truth=Get-LifecycleProcessTruth -Root $canonical
    if($truth.healthy){
      $healthy=$true
      Write-Host "HOTPATCH_WRAPPER_ALIVE=$([bool]$truth.wrapper_alive)"
      Write-Host "HOTPATCH_THREE_LANE_ALIVE=$([bool]$truth.three_lane_alive)"
      Write-Host "HOTPATCH_CDP_HEALTHY=$([bool]$truth.cdp_healthy)"
      break
    }
  }
  if(-not $healthy){throw 'Hotpatch runtime did not become healthy within bounded wait.'}

  # Refresh only the Owner Control Panel process so the live UI reflects the
  # same source revision. The Supervisor wrapper/Three-Lane authority remains
  # untouched after its bounded child restart above.
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like '*control-panel.ps1*' -and
      $_.CommandLine -notlike '*run-supervisor.ps1*'
    } |
    ForEach-Object {
      Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
      Write-Host "HOTPATCH_OLD_CONTROL_PANEL_STOPPED=$($_.ProcessId)"
    }

  Start-Sleep -Milliseconds 300
  if(Test-Path $shortcutPath){
    & explorer.exe $shortcutPath
    Write-Host 'HOTPATCH_CONTROL_PANEL_REOPEN_REQUESTED=True'
  }else{
    $env:RUNNER_TRACKING_ID='MAGASIN_CONTROL_PANEL_PERSISTENT'
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
      '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
      '-File',('"' + $targetPanel + '"')
    )
    Write-Host 'HOTPATCH_CONTROL_PANEL_REOPEN_FALLBACK=True'
  }

  $fingerprintAfter=Get-TargetFingerprint $configFile
  if($fingerprintBefore -ne $fingerprintAfter){throw 'Project target fingerprint changed during active-lane hotpatch.'}

  $cfgAfter=Get-Content $configFile -Raw -Encoding UTF8|ConvertFrom-Json
  $enabledAfter=@($cfgAfter.lanes|Where-Object{[bool]$_.enabled}).Count
  if($enabledAfter -ne $enabledBefore){throw 'Lane enabled state changed during active-lane hotpatch.'}

  $regAfter=Get-Content $registryFile -Raw -Encoding UTF8|ConvertFrom-Json
  foreach($laneName in @('lane-1','lane-2','lane-3')){
    $before=$regBefore.lanes.$laneName
    $after=$regAfter.lanes.$laneName
    if($before -and $after){
      if([string]$before.task_id -ne [string]$after.task_id){throw "Task changed for $laneName during hotpatch."}
      if([bool]$before.awaiting_work -ne [bool]$after.awaiting_work){throw "Awaiting state changed for $laneName during hotpatch."}
    }
  }

  Write-Host 'TARGET_FINGERPRINT_UNCHANGED=True'
  Write-Host 'PROJECT_STATE_PRESERVED=True'
  Write-Host 'UPDATE_RESULT=HOTPATCH_ENABLED_LANES'
  exit 0
}

$sourcePanel=Get-Content (Join-Path $env:GITHUB_WORKSPACE 'windows\control-panel.ps1') -Raw -Encoding UTF8
foreach($marker in @('CONTROL PANEL V2','heroPanel','overviewPanel','$resetAllButton = New-Object Windows.Forms.Button','Request-RunnerRecovery','Request-LifecycleRecovery','for ($eventIndex = $events.Count - 1; $eventIndex -ge 0; $eventIndex--)')){
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
foreach($marker in @('CONTROL PANEL V2','heroPanel','overviewPanel','$resetAllButton = New-Object Windows.Forms.Button','Request-RunnerRecovery','Request-LifecycleRecovery','for ($eventIndex = $events.Count - 1; $eventIndex -ge 0; $eventIndex--)')){
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
