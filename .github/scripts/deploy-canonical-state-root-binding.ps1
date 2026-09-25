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

$canonical = Get-SupervisorStateRoot -Compatibility 'platform-default'
if(-not [string]::IsNullOrWhiteSpace([string]$env:SUPERVISOR_STATE_ROOT)){
  $canonical = [System.IO.Path]::GetFullPath([string]$env:SUPERVISOR_STATE_ROOT)
}
$canonical = Set-SupervisorStateRootBinding -Root $canonical
$base=[string]$env:LOCALAPPDATA
if([string]::IsNullOrWhiteSpace($base)){$base=[string]$env:USERPROFILE}
$legacy=Join-Path $base 'MAGASIN\BusinessOS\supervisor'

Write-Host "CANONICAL_ROOT=$canonical"
Write-Host "LEGACY_ROOT=$legacy"

$runtime=Join-Path $canonical 'runtime'
$configFile=Join-Path $canonical 'lanes.json'
$registryFile=Join-Path $canonical 'lane-registry.json'
$pidFile=Join-Path $canonical 'supervisor.pid'
$shortcutPath=Join-Path ([Environment]::GetFolderPath('Desktop')) 'MAGASIN BUSINESS OS CONTROL.lnk'

foreach($p in @($runtime,$configFile,$registryFile)){
  if(-not (Test-Path $p)){throw "Missing canonical runtime/state path: $p"}
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

$fingerprintBefore=Get-TargetFingerprint $configFile
$cfgBefore=Get-Content $configFile -Raw -Encoding UTF8|ConvertFrom-Json
$enabledBefore=@($cfgBefore.lanes|Where-Object{[bool]$_.enabled}).Count
Write-Host "ENABLED_LANES_BEFORE=$enabledBefore"

$files=@(
  'windows\state-root.ps1',
  'windows\control-panel.ps1',
  'windows\start-supervisor.ps1',
  'windows\autostart-bootstrap.ps1',
  'windows\install-supervisor.ps1'
)
$utf8NoBom=New-Object System.Text.UTF8Encoding($false)
$utf8Bom=New-Object System.Text.UTF8Encoding($true)
foreach($rel in $files){
  $src=Join-Path $env:GITHUB_WORKSPACE $rel
  $dst=Join-Path $runtime $rel
  $parent=Split-Path -Parent $dst
  if(-not (Test-Path $parent)){New-Item -ItemType Directory -Force -Path $parent|Out-Null}
  $content=Get-Content $src -Raw -Encoding UTF8
  if($rel -eq 'windows\control-panel.ps1'){
    [System.IO.File]::WriteAllText($dst,$content,$utf8Bom)
  }else{
    [System.IO.File]::WriteAllText($dst,$content,$utf8NoBom)
  }
  Write-Host "DEPLOYED=$rel"
}

$legacyNeedle=$legacy
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and
    $_.CommandLine -like "*$legacyNeedle*" -and
    (
      ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*run-supervisor.ps1*') -or
      ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*three-lane-cli.mjs*')
    )
  } |
  ForEach-Object {
    Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
    Write-Host "LEGACY_PROCESS_STOPPED=$($_.ProcessId)"
  }
Start-Sleep -Milliseconds 800

$cfgNow=Get-Content $configFile -Raw -Encoding UTF8|ConvertFrom-Json
$enabledNow=@($cfgNow.lanes|Where-Object{[bool]$_.enabled}).Count
if($enabledNow -eq 0){
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like "*$canonical*" -and
      (
        ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*run-supervisor.ps1*') -or
        ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*three-lane-cli.mjs*')
      )
    } |
    ForEach-Object {
      Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
      Write-Host "CANONICAL_IDLE_PROCESS_STOPPED=$($_.ProcessId)"
    }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host 'ALL_DISABLED_BACKGROUND_ALIGNED=True'
}

Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object {$_.CommandLine -and $_.CommandLine -like '*control-panel.ps1*'} |
  ForEach-Object {
    Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
    Write-Host "OLD_PANEL_STOPPED=$($_.ProcessId)"
  }
Start-Sleep -Milliseconds 700

$panelTarget=Join-Path $runtime 'windows\control-panel.ps1'
$wsh=New-Object -ComObject WScript.Shell
$shortcut=$wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath='powershell.exe'
$shortcut.Arguments='-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$panelTarget+'"'
$shortcut.WorkingDirectory=$canonical
$shortcut.Description='MAGASIN Business OS Supervisor Robot control panel'
$shortcut.IconLocation="$env:SystemRoot\System32\imageres.dll,72"
$shortcut.Save()
& explorer.exe $shortcutPath

$panel=$null
for($i=0;$i -lt 30;$i++){
  Start-Sleep -Milliseconds 500
  $panel=Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {$_.CommandLine -and $_.CommandLine -like "*$panelTarget*"} |
    Select-Object -First 1
  if($panel){break}
}
if(-not $panel){throw 'Canonical Control Panel did not start.'}
Write-Host "PANEL_PID=$($panel.ProcessId)"

$stateRootScript=Join-Path $runtime 'windows\state-root.ps1'
$probeFile=Join-Path $env:RUNNER_TEMP ('state-root-probe-'+[guid]::NewGuid().ToString('N')+'.ps1')
$probeLines=@(
  '$env:SUPERVISOR_STATE_ROOT=$null',
  ". '$stateRootScript'",
  "Get-SupervisorStateRoot -Compatibility 'legacy-preserve'"
)
Set-Content -Path $probeFile -Value $probeLines -Encoding UTF8
try{
  $probe=& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $probeFile
}finally{
  Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
}
$probeRoot=[string]($probe|Select-Object -Last 1)
Write-Host "PERSISTED_BINDING_PROBE=$probeRoot"
if([System.IO.Path]::GetFullPath($probeRoot) -ne [System.IO.Path]::GetFullPath($canonical)){
  throw 'Persisted User binding did not win without process environment.'
}

$legacyRemaining=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and $_.CommandLine -like "*$legacyNeedle*" -and
    (
      ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*run-supervisor.ps1*') -or
      ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*three-lane-cli.mjs*')
    )
  })
Write-Host "LEGACY_RUNTIME_PROCESS_COUNT=$($legacyRemaining.Count)"
if($legacyRemaining.Count -ne 0){throw 'Legacy state-root runtime process still alive.'}

$fingerprintAfter=Get-TargetFingerprint $configFile
if($fingerprintBefore -ne $fingerprintAfter){throw 'Canonical Brain/Work target fingerprint changed.'}

$cfgAfter=Get-Content $configFile -Raw -Encoding UTF8|ConvertFrom-Json
$enabledAfter=@($cfgAfter.lanes|Where-Object{[bool]$_.enabled}).Count
if($enabledBefore -ne $enabledAfter){throw 'Lane enabled state changed during repair.'}

Write-Host "ENABLED_LANES_AFTER=$enabledAfter"
Write-Host 'TARGET_FINGERPRINT_UNCHANGED=True'
Write-Host 'LANE_ENABLED_STATE_UNCHANGED=True'
Write-Host 'CANONICAL_STATE_ROOT_BINDING=PASS'
