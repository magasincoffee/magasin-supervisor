param([string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path)

$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'state-root.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$root=Set-SupervisorStateRootBinding -Root $root
$runtime=Join-Path $root 'runtime'
$pidFile=Join-Path $root 'supervisor.pid'
$stopFile=Join-Path $root 'STOP'
$disabledFile=Join-Path $root 'AUTOSTART_DISABLED'
$ownerStopWasPresent=[bool]((Test-Path $stopFile)-or(Test-Path $disabledFile))
$desktop=[Environment]::GetFolderPath('Desktop')
New-Item -ItemType Directory -Force -Path $root | Out-Null

# Stop only the active SINGLE_CONVERSATION_V1 process tree and read-only local watchdog.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object {$_.CommandLine -and $_.CommandLine -like '*control-panel.ps1*'} |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object {$_.CommandLine -and $_.CommandLine -like '*local-watchdog.ps1*' -and $_.CommandLine -notlike '*start-local-watchdog.ps1*' -and $_.CommandLine -like "*$root*"} |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object {$_.CommandLine -and $_.CommandLine -like '*run-supervisor.ps1*' -and $_.CommandLine -like "*$root*"} |
  ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F | Out-Null }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object {$_.CommandLine -and $_.CommandLine -like '*single-conversation-cli.mjs*'} |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
if($ownerStopWasPresent){Write-Host 'OWNER_STOP_PRESERVED_DURING_INSTALL=True'}

Start-Sleep -Milliseconds 400
$overlay=$false
if(Test-Path $runtime){
  try{Remove-Item $runtime -Recurse -Force -ErrorAction Stop}catch{$overlay=$true}
}
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Copy-Item (Join-Path $SourceRoot 'src') (Join-Path $runtime 'src') -Recurse -Force
Copy-Item (Join-Path $SourceRoot 'windows') (Join-Path $runtime 'windows') -Recurse -Force
Copy-Item (Join-Path $SourceRoot 'package.json') (Join-Path $runtime 'package.json') -Force
if($overlay){Write-Host 'RUNTIME_OVERLAY_REPAIR=True'}

Push-Location $runtime
try{
  npm install --omit=dev --ignore-scripts --no-audit --no-fund
  if($LASTEXITCODE -ne 0){throw 'npm install failed'}
}finally{Pop-Location}

# Purge superseded orchestration state. Durable SINGLE_CONVERSATION_V1 state is preserved.
foreach($legacyName in @(
  'lanes.json','lane-registry.json','lane-status.json','lane-events.ndjson',
  'planner-executor-state.json','planner-executor-status.json','planner-executor-transport.json',
  'planner-executor-startup-failure.json','planner-executor-projects.json',
  'orchestration.json','runtime-status.json','target.json'
)){
  $p=Join-Path $root $legacyName
  if(Test-Path $p){Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue;Write-Host "LEGACY_STATE_DELETED=$legacyName"}
}

$panel=Join-Path $runtime 'windows\control-panel.ps1'
if(-not(Test-Path $panel)){throw 'Installed control panel missing.'}
$panelText=Get-Content $panel -Raw -Encoding UTF8
[System.IO.File]::WriteAllText($panel,$panelText,(New-Object System.Text.UTF8Encoding($true)))
$parseErrors=$null
[System.Management.Automation.Language.Parser]::ParseFile($panel,[ref]$null,[ref]$parseErrors)|Out-Null
if($parseErrors.Count -gt 0){throw 'Control panel PowerShell syntax invalid.'}

foreach($oldName in @(
  'START_MAGASIN_SUPERVISOR.cmd','STOP_MAGASIN_SUPERVISOR.cmd',
  'START_MAGASIN_SUPERVISOR.lnk','STOP_MAGASIN_SUPERVISOR.lnk',
  'SAYDI CONTROL.lnk','MAGASIN BUSINESS OS CONTROL.lnk'
)){
  $old=Join-Path $desktop $oldName
  if(Test-Path $old){Remove-Item $old -Force -ErrorAction SilentlyContinue}
}

$shortcutName='MAGASIN SUPERVISOR '+[char]0x2014+' CONTROL CENTER.lnk'
$shortcutPath=Join-Path $desktop $shortcutName
$wsh=New-Object -ComObject WScript.Shell
$sc=$wsh.CreateShortcut($shortcutPath)
$sc.TargetPath='powershell.exe'
$sc.Arguments='-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$panel+'"'
$sc.WorkingDirectory=$root
$sc.Description='MAGASIN Supervisor SINGLE_CONVERSATION_V1'
$sc.IconLocation="$env:SystemRoot\System32\imageres.dll,72"
$sc.Save()

$startWatchdog=Join-Path $runtime 'windows\start-local-watchdog.ps1'
if(-not(Test-Path $startWatchdog)){throw 'Local watchdog launcher missing.'}
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startWatchdog -WaitForHeartbeat
if($LASTEXITCODE -ne 0){throw 'Local watchdog failed to start.'}
Write-Host 'LOCAL_WATCHDOG_INSTALLED_RUNNING=True'
Write-Host 'SINGLE_CONVERSATION_RUNTIME_INSTALLED=True'
Write-Host "Installed runtime: $runtime"
Write-Host "Unified control panel: $shortcutPath"