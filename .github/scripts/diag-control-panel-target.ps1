param([string]$TargetComputer="DESKTOP-4K7IM13")
$ErrorActionPreference="Stop"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host "TARGET_MATCH=False"
  exit 0
}
Write-Host "TARGET_MATCH=True"
. (Join-Path $PSScriptRoot "..\..\windows\state-root.ps1")
$root=Get-SupervisorStateRoot -Compatibility "legacy-preserve"
$runtimePanel=Join-Path $root "runtime\windows\control-panel.ps1"
Write-Host "TARGET_MACHINE=$env:COMPUTERNAME"
Write-Host "STATE_ROOT=$root"
Write-Host "RUNTIME_PANEL=$runtimePanel"
if(Test-Path $runtimePanel){
  $txt=Get-Content $runtimePanel -Raw -Encoding UTF8
  Write-Host "RUNTIME_RESET_READY=$($txt -match [regex]::Escape('RESET READY'))"
  Write-Host "RUNTIME_RESET_BUTTON=$($txt -match 'resetAllButton')"
  Write-Host "RUNTIME_OLD_SUBTITLE=$($txt -match 'BỘ NÃO DO BẠN CHỌN')"
  Write-Host "RUNTIME_SHA256=$((Get-FileHash $runtimePanel -Algorithm SHA256).Hash)"
}

Write-Host "=== PANEL PROCESS CANDIDATES ==="
$allPs=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -in @('powershell.exe','pwsh.exe','cmd.exe') -and
    $_.CommandLine
  } | Sort-Object ProcessId

foreach($p in $allPs){
  $gp=$null
  try{$gp=Get-Process -Id ([int]$p.ProcessId) -ErrorAction Stop}catch{}
  $title=if($gp){[string]$gp.MainWindowTitle}else{''}
  $isPanel=($p.CommandLine -like '*control-panel.ps1*') -or ($title -like '*MAGASIN BUSINESS OS*')
  if($isPanel){
    Write-Host "PANEL_PID=$($p.ProcessId)"
    Write-Host "PANEL_NAME=$($p.Name)"
    Write-Host "PANEL_PARENT=$($p.ParentProcessId)"
    Write-Host "PANEL_SESSION=$($p.SessionId)"
    Write-Host "PANEL_EXE=$($p.ExecutablePath)"
    Write-Host "PANEL_CMD=$($p.CommandLine)"
    Write-Host "PANEL_TITLE=$title"
  }
}

Write-Host "=== DESKTOP SHORTCUTS ==="
$shell=New-Object -ComObject WScript.Shell
$desktops=@(
 [Environment]::GetFolderPath('Desktop'),
 [Environment]::GetFolderPath('CommonDesktopDirectory')
) | Select-Object -Unique
foreach($desktop in $desktops){
  if(-not $desktop -or -not (Test-Path $desktop)){continue}
  Get-ChildItem $desktop -Filter '*.lnk' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'MAGASIN|BUSINESS|SUPERVISOR' } |
    ForEach-Object {
      $sc=$shell.CreateShortcut($_.FullName)
      Write-Host "SHORTCUT_FILE=$($_.FullName)"
      Write-Host "SHORTCUT_TARGET=$($sc.TargetPath)"
      Write-Host "SHORTCUT_ARGS=$($sc.Arguments)"
      Write-Host "SHORTCUT_WORKDIR=$($sc.WorkingDirectory)"
    }
}

Write-Host "=== UI AUTOMATION ==="
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$candidates=@()
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  ForEach-Object {
    try{
      $gp=Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop
      if($gp.MainWindowHandle -ne 0 -and $gp.MainWindowTitle -like '*MAGASIN BUSINESS OS*'){
        $candidates += $gp
      }
    }catch{}
  }
Write-Host "VISIBLE_PANEL_COUNT=$($candidates.Count)"
foreach($gp in $candidates){
  Write-Host "VISIBLE_PANEL_PID=$($gp.Id)"
  Write-Host "VISIBLE_PANEL_TITLE=$($gp.MainWindowTitle)"
  $rootEl=[System.Windows.Automation.AutomationElement]::FromHandle($gp.MainWindowHandle)
  if($rootEl){
    $nodes=$rootEl.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $reset=$false
    $ready=$false
    $old=$false
    for($i=0;$i -lt $nodes.Count;$i++){
      $name=[string]$nodes.Item($i).Current.Name
      if($name -match 'LÀM SẠCH TẤT CẢ DỰ ÁN'){ $reset=$true }
      if($name -match 'RESET READY'){ $ready=$true }
      if($name -match 'BỘ NÃO DO BẠN CHỌN'){ $old=$true }
    }
    Write-Host "VISIBLE_RESET_BUTTON=$reset"
    Write-Host "VISIBLE_RESET_READY=$ready"
    Write-Host "VISIBLE_OLD_SUBTITLE=$old"
  }
}
Write-Host "CONTROL_PANEL_LIVE_TARGET_DIAG=PASS"
