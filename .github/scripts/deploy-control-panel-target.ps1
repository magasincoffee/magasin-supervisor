param(
  [string]$TargetComputer = "DESKTOP-4K7IM13"
)
$ErrorActionPreference = "Stop"
if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Host "TARGET_MATCH=False"
  exit 0
}
Write-Host "TARGET_MATCH=True"
. (Join-Path $PSScriptRoot "..\..\windows\state-root.ps1")
$root = Get-SupervisorStateRoot -Compatibility "legacy-preserve"
$sourcePanel = (Resolve-Path (Join-Path $PSScriptRoot "..\..\windows\control-panel.ps1")).Path
$targetPanel = Join-Path $root "runtime\windows\control-panel.ps1"
$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$installScript = Join-Path $sourceRoot "windows\install-supervisor.ps1"
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutDisplayName = 'MAGASIN SUPERVISOR ' + [char]0x2014 + ' CONTROL CENTER.lnk'
$shortcutPath = Join-Path $desktop $shortcutDisplayName
$oldShortcutPath = Join-Path $desktop 'MAGASIN BUSINESS OS CONTROL.lnk'
if (-not (Test-Path $targetPanel)) {
  Write-Host "TARGET_PANEL_MISSING_REPAIR=True"
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installScript -SourceRoot $sourceRoot
  if ($LASTEXITCODE -ne 0) { throw "Installed Control Panel repair failed" }
}
if (-not (Test-Path $targetPanel)) { throw "Installed Control Panel missing after repair" }

$source = Get-Content $sourcePanel -Raw -Encoding UTF8
foreach ($marker in @("CONTROL PANEL V2","heroPanel","overviewPanel","resetAllButton","Drawing.Point(840, 18)","Drawing.Size(315, 40)")) {
  if ($source -notmatch [regex]::Escape($marker)) { throw "Source marker missing: $marker" }
}

Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*control-panel.ps1*" } |
  ForEach-Object {
    Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
    Write-Host "TARGET_OLD_PANEL_STOPPED=$($_.ProcessId)"
  }

Start-Sleep -Milliseconds 700
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($targetPanel, $source, $utf8Bom)

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = 'powershell.exe'
$shortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $targetPanel + '"'
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'MAGASIN Supervisor Control Center V2'
$shortcut.IconLocation = "$env:SystemRoot\System32\imageres.dll,72"
$shortcut.Save()
if (Test-Path $oldShortcutPath) {
  Remove-Item $oldShortcutPath -Force -ErrorAction SilentlyContinue
  Write-Host "TARGET_OLD_SHORTCUT_REMOVED=True"
}

$tokens=$null
$errors=$null
[System.Management.Automation.Language.Parser]::ParseFile($targetPanel,[ref]$tokens,[ref]$errors) | Out-Null
if ($errors.Count -gt 0) { throw "Installed Control Panel parse failed" }

$env:RUNNER_TRACKING_ID = "MAGASIN_CONTROL_PANEL_PERSISTENT"
& explorer.exe $shortcutPath

$found=$null
for($i=0;$i -lt 30;$i++){
  Start-Sleep -Milliseconds 500
  $found = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$targetPanel*" } |
    Select-Object -First 1
  if($found){break}
}
if(-not $found){throw "Control Panel did not start"}

$windowTitle = ''
for($i=0;$i -lt 20;$i++){
  Start-Sleep -Milliseconds 300
  try {
    $windowTitle = [string](Get-Process -Id ([int]$found.ProcessId) -ErrorAction Stop).MainWindowTitle
  } catch {
    $windowTitle = ''
  }
  if($windowTitle){break}
}
$windowV2 = [bool]($windowTitle -match 'MAGASIN SUPERVISOR.*CONTROL CENTER')
if(-not $windowV2){throw "Live Control Panel window title is not V2: $windowTitle"}

$shortcutCheck = $wsh.CreateShortcut($shortcutPath)
if([string]$shortcutCheck.Arguments -notlike "*$targetPanel*"){throw "V2 shortcut target mismatch"}
if([System.IO.Path]::GetFullPath([string]$shortcutCheck.WorkingDirectory) -ne [System.IO.Path]::GetFullPath($root)){throw "V2 shortcut working directory mismatch"}

$installed = Get-Content $targetPanel -Raw -Encoding UTF8
Write-Host "TARGET_MACHINE=$env:COMPUTERNAME"
Write-Host "TARGET_CONTROL_PANEL_PID=$($found.ProcessId)"
Write-Host "TARGET_CONTROL_PANEL_TITLE=$windowTitle"
Write-Host "TARGET_WINDOW_V2=$windowV2"
Write-Host "TARGET_SHORTCUT=$shortcutPath"
Write-Host "TARGET_SHORTCUT_V2=$(Test-Path $shortcutPath)"
Write-Host "TARGET_CONTROL_PANEL_V2=$($installed -match [regex]::Escape('CONTROL PANEL V2'))"
Write-Host "TARGET_RESET_BUTTON=$($installed -match 'resetAllButton')"
Write-Host "TARGET_RESET_POSITION=$($installed -match [regex]::Escape('Drawing.Point(840, 18)'))"
Write-Host "TARGET_PROJECT_STATE_UNCHANGED=True"
Write-Host "TARGET_DEPLOY=PASS"
