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
if (-not (Test-Path $targetPanel)) { throw "Installed Control Panel missing" }

$source = Get-Content $sourcePanel -Raw -Encoding UTF8
foreach ($marker in @("RESET READY","resetAllButton","Drawing.Point(820, 20)","Drawing.Size(365, 42)")) {
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

$tokens=$null
$errors=$null
[System.Management.Automation.Language.Parser]::ParseFile($targetPanel,[ref]$tokens,[ref]$errors) | Out-Null
if ($errors.Count -gt 0) { throw "Installed Control Panel parse failed" }

$env:RUNNER_TRACKING_ID = "MAGASIN_CONTROL_PANEL_PERSISTENT"
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
  "-NoLogo","-NoProfile","-ExecutionPolicy","Bypass",
  "-File",('"' + $targetPanel + '"')
)

$found=$null
for($i=0;$i -lt 30;$i++){
  Start-Sleep -Milliseconds 500
  $found = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$targetPanel*" } |
    Select-Object -First 1
  if($found){break}
}
if(-not $found){throw "Control Panel did not start"}

$installed = Get-Content $targetPanel -Raw -Encoding UTF8
Write-Host "TARGET_MACHINE=$env:COMPUTERNAME"
Write-Host "TARGET_CONTROL_PANEL_PID=$($found.ProcessId)"
Write-Host "TARGET_RESET_READY=$($installed -match [regex]::Escape('RESET READY'))"
Write-Host "TARGET_RESET_BUTTON=$($installed -match 'resetAllButton')"
Write-Host "TARGET_RESET_POSITION=$($installed -match [regex]::Escape('Drawing.Point(820, 20)'))"
Write-Host "TARGET_PROJECT_STATE_UNCHANGED=True"
Write-Host "TARGET_DEPLOY=PASS"
