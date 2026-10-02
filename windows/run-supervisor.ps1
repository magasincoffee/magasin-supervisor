param([switch]$DryRun)

$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'state-root.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$env:SUPERVISOR_STATE_ROOT=$root
$runtime=Join-Path $root 'runtime'
$profile=Join-Path $root 'browser_profile'
$stop=Join-Path $root 'STOP'
$disabled=Join-Path $root 'AUTOSTART_DISABLED'
$pidFile=Join-Path $root 'supervisor.pid'
$controlFile=Join-Path $root 'single-conversation-control.json'
$stateFile=Join-Path $root 'single-conversation-state.json'

$mutexName='Local\MAGASIN_SUPERVISOR_SINGLE_CONVERSATION_V1'
$mutex=New-Object System.Threading.Mutex($false,$mutexName)
$owns=$false
try{
  try{$owns=$mutex.WaitOne(0,$false)}catch [System.Threading.AbandonedMutexException]{$owns=$true}
  if(-not $owns){ Write-Host 'SINGLE_CONVERSATION_WRAPPER_ALREADY_OWNED=True'; exit 0 }
}catch{$mutex.Dispose();throw}

function Get-SingleNodes {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {$_.CommandLine -and $_.CommandLine -like '*single-conversation-cli.mjs*'})
}
function Stop-OrphanSingleNodes {
  foreach($n in (Get-SingleNodes)){
    $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($n.ParentProcessId)" -ErrorAction SilentlyContinue | Select-Object -First 1
    $owned=[bool]($p -and $p.Name -eq 'powershell.exe' -and $p.CommandLine -and $p.CommandLine -like '*run-supervisor.ps1*' -and $p.CommandLine -like "*$root*")
    if(-not $owned){
      Stop-Process -Id ([int]$n.ProcessId) -Force -ErrorAction SilentlyContinue
      Write-Host "ORPHAN_SINGLE_CONVERSATION_STOPPED=$($n.ProcessId)"
    }
  }
}
function Stop-CurrentChild {
  Get-SingleNodes | Where-Object {[int]$_.ParentProcessId -eq [int]$PID} | ForEach-Object {
    Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
  }
}
function Get-DedicatedChrome {
  @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object {$_.CommandLine -and $_.CommandLine -like "*$profile*"})
}
function Stop-DedicatedChrome { Get-DedicatedChrome | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
function Get-ExistingCdpPort {
  foreach($p in (Get-DedicatedChrome)){ if($p.CommandLine -match '--remote-debugging-port=(\d+)'){ return [int]$Matches[1] } }
  return $null
}
function Get-FreeCdpPort {
  foreach($port in 9222..9232){ if(-not (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1)){ return $port } }
  throw 'No free Supervisor CDP port in range 9222-9232.'
}
function Test-Cdp([int]$Port){
  try{ $v=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2; return [bool]$v.webSocketDebuggerUrl }catch{return $false}
}
function Read-Control {
  if(-not (Test-Path $controlFile -PathType Leaf)){ return $null }
  try{$c=Get-Content $controlFile -Raw -Encoding UTF8|ConvertFrom-Json}catch{return $null}
  if([string]$c.schema_version -ne 'single-conversation-control.v1'){return $null}
  if([string]$c.mode -ne 'SINGLE_CONVERSATION_V1'){return $null}
  if([string]::IsNullOrWhiteSpace([string]$c.source_of_truth_url)){return $null}
  return $c
}

Stop-OrphanSingleNodes
if((Test-Path $stop) -or (Test-Path $disabled)){ Write-Host 'Supervisor launch blocked by Owner STOP/AUTOSTART_DISABLED.'; exit 0 }
Set-Content -Path $pidFile -Value $PID -Encoding ascii

try{
  $chrome=@(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object {$_ -and (Test-Path $_)} | Select-Object -First 1
  if(-not $chrome){throw 'Installed Google Chrome not found.'}

  while(-not (Test-Path $stop) -and -not (Test-Path $disabled)){
    $control=Read-Control
    if(-not $control){ Write-Host 'SINGLE_CONVERSATION_CONTROL_MISSING=True'; Start-Sleep -Seconds 5; continue }

    $port=Get-ExistingCdpPort
    if(-not $port){$port=Get-FreeCdpPort}
    if(-not (Test-Cdp $port)){
      Stop-DedicatedChrome
      Start-Sleep -Milliseconds 500
      $port=Get-FreeCdpPort
      Start-Process -FilePath $chrome -WindowStyle Minimized -ArgumentList @(
        '--remote-debugging-address=127.0.0.1',"--remote-debugging-port=$port",('--user-data-dir="'+$profile+'"'),
        '--no-first-run','--no-default-browser-check','--hide-crash-restore-bubble','--start-minimized',
        '--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion','https://chatgpt.com/'
      )
      $ready=$false
      for($i=0;$i -lt 30;$i++){ if(Test-Cdp $port){$ready=$true;break}; Start-Sleep -Seconds 1 }
      if(-not $ready){ Start-Sleep -Seconds 5; continue }
    }

    $cdp="http://127.0.0.1:$port"
    $source=[string]$control.source_of_truth_url
    $args=@('src/runtime/single-conversation-cli.mjs','--cdp-url',$cdp,'--poll-ms','2000','--state',$stateFile,'--source-of-truth',$source)
    if(-not $DryRun){$args+='--execute'}
    Write-Host 'Supervisor entry point: src/runtime/single-conversation-cli.mjs'
    Push-Location $runtime
    try{ & node @args; $exitCode=$LASTEXITCODE } finally { Pop-Location }

    if(-not (Test-Path $stop) -and -not (Test-Path $disabled) -and (Test-Path $stateFile -PathType Leaf)){
      try{
        $state=Get-Content $stateFile -Raw -Encoding UTF8|ConvertFrom-Json
        if([string]$state.automation.status -eq 'BLOCKED'){
          Write-Host 'SINGLE_CONVERSATION_BLOCKED_PAUSE=True'
          break
        }
      }catch{ Write-Host 'SINGLE_CONVERSATION_STATE_INSPECTION_FAILED=True'; break }
    }

    if($exitCode -eq 75){ Write-Host 'SINGLE_CONVERSATION_CDP_RESTART_REQUESTED=True'; Stop-DedicatedChrome; Start-Sleep -Milliseconds 750; continue }
    if($exitCode -eq 76){ Write-Host 'SINGLE_CONVERSATION_PAUSED=True'; Stop-DedicatedChrome; break }
    Start-Sleep -Seconds 3
  }
}finally{
  Stop-CurrentChild
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  if($owns){try{$mutex.ReleaseMutex()}catch{}}
  $mutex.Dispose()
}