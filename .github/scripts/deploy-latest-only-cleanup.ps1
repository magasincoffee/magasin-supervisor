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
$root=Set-SupervisorStateRootBinding -Root $root
$runtime=Join-Path $root 'runtime'
$desktop=[Environment]::GetFolderPath('Desktop')
$legacyRoot=Join-Path ([string]$env:LOCALAPPDATA) 'MAGASIN\BusinessOS\supervisor'
$legacyRuntime=Join-Path $legacyRoot 'runtime'

Write-Host "CANONICAL_ROOT=$root"
Write-Host "LEGACY_ROOT=$legacyRoot"

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $env:GITHUB_WORKSPACE 'windows\install-supervisor.ps1') -SourceRoot $env:GITHUB_WORKSPACE
if($LASTEXITCODE -ne 0){
  throw 'Canonical Supervisor install failed.'
}
Write-Host 'CANONICAL_INSTALL=PASS'

if(Test-Path $legacyRuntime){
  Remove-Item $legacyRuntime -Recurse -Force -ErrorAction Stop
  Write-Host "LEGACY_RUNTIME_REMOVED=$legacyRuntime"
}else{
  Write-Host 'LEGACY_RUNTIME_REMOVED=ALREADY_ABSENT'
}

$wsh=New-Object -ComObject WScript.Shell
Get-ChildItem -Path $desktop -Filter '*.lnk' -File -ErrorAction SilentlyContinue |
  ForEach-Object {
    try{
      $sc=$wsh.CreateShortcut($_.FullName)
      $combined=([string]$sc.TargetPath)+' '+([string]$sc.Arguments)+' '+([string]$sc.WorkingDirectory)
      if(
        $combined -like "*$legacyRoot*" -or
        $_.Name -in @(
          'START_MAGASIN_SUPERVISOR.lnk',
          'STOP_MAGASIN_SUPERVISOR.lnk',
          'SAYDI CONTROL.lnk'
        )
      ){
        Write-Host "OLD_SHORTCUT_REMOVED=$($_.FullName)"
        Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
      }
    }catch{}
  }

foreach($name in @('START_MAGASIN_SUPERVISOR.cmd','STOP_MAGASIN_SUPERVISOR.cmd')){
  $p=Join-Path $desktop $name
  if(Test-Path $p){
    Remove-Item $p -Force -ErrorAction SilentlyContinue
    Write-Host "OLD_SHORTCUT_REMOVED=$p"
  }
}

$panelTarget=Join-Path $runtime 'windows\control-panel.ps1'
if(-not (Test-Path $panelTarget)){throw 'Canonical Control Panel missing after install.'}
$panel=Get-Content $panelTarget -Raw -Encoding UTF8
foreach($marker in @('CONTROL PANEL V2','heroPanel','overviewPanel','resetAllButton','Request-RunnerRecovery')){
  if($panel -notmatch [regex]::Escape($marker)){
    throw "Latest Control Panel marker missing: $marker"
  }
}
Write-Host 'LATEST_PANEL_MARKERS=PASS'

$shortcutDisplayName='MAGASIN SUPERVISOR '+[char]0x2014+' CONTROL CENTER.lnk'
$shortcutPath=Join-Path $desktop $shortcutDisplayName
if(-not (Test-Path $shortcutPath)){throw 'Canonical desktop shortcut missing.'}
$shortcut=$wsh.CreateShortcut($shortcutPath)
Write-Host "SHORTCUT_TARGET=$($shortcut.TargetPath)"
Write-Host "SHORTCUT_ARGS=$($shortcut.Arguments)"
Write-Host "SHORTCUT_WORKDIR=$($shortcut.WorkingDirectory)"
if(
  [string]$shortcut.Arguments -notlike "*$panelTarget*" -or
  [System.IO.Path]::GetFullPath([string]$shortcut.WorkingDirectory) -ne [System.IO.Path]::GetFullPath($root)
){
  throw 'Desktop shortcut is not bound to the canonical latest Control Panel.'
}

$legacyProcesses=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$legacyRoot*" })
Write-Host "LEGACY_PROCESS_COUNT=$($legacyProcesses.Count)"
if($legacyProcesses.Count -gt 0){
  foreach($p in $legacyProcesses){
    Write-Host "LEGACY_PROCESS=$($p.ProcessId)|$($p.Name)|$($p.CommandLine)"
  }
  throw 'A legacy-root process is still alive after cleanup.'
}

Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object {$_.CommandLine -and $_.CommandLine -like '*control-panel.ps1*'} |
  ForEach-Object {
    Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Milliseconds 600
& explorer.exe $shortcutPath

$panelProcess=$null
for($i=0;$i -lt 30;$i++){
  Start-Sleep -Milliseconds 500
  $panelProcess=Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like '*control-panel.ps1*' -and
      $_.CommandLine -like "*$runtime*"
    } |
    Select-Object -First 1
  if($panelProcess){break}
}
if(-not $panelProcess){throw 'Latest canonical Control Panel did not start.'}
Write-Host "LATEST_PANEL_PID=$($panelProcess.ProcessId)"
Write-Host 'LATEST_ONLY_CLEANUP=PASS'
