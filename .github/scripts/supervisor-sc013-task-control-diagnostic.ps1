param(
  [Parameter(Mandatory=$true)][string]$TargetComputer,
  [int]$NonTargetHoldSeconds = 120
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

Write-Host "SC013_DIAG_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC013_DIAG_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'SC013_DIAG_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$profile=Join-Path $root 'browser_profile'
$stopPath=Join-Path $root 'STOP'
$autostartDisabledPath=Join-Path $root 'AUTOSTART_DISABLED'
$temporaryStopToken="SC013_READ_ONLY_HOLD:$env:GITHUB_RUN_ID"
$createdHold=$false
$startedChrome=$false

function Get-FreePort {
  foreach($candidate in 9222..9232){
    $listener=Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
    if(-not $listener){ return [int]$candidate }
  }
  throw 'No free Supervisor CDP port.'
}

function Get-HealthyPort {
  $chrome=Get-LifecycleRobotChrome -Root $root
  if(-not $chrome -or -not $chrome.CommandLine){ return $null }
  if($chrome.CommandLine -notmatch '--remote-debugging-port=(\d+)'){ return $null }
  $port=[int]$Matches[1]
  try {
    $version=Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
    if($version.webSocketDebuggerUrl){ return $port }
  } catch {}
  return $null
}

$initialOwnerStop=Get-LifecycleOwnerStopState -Root $root
try {
  if(-not $initialOwnerStop.blocked){
    Set-Content -Path $stopPath -Value $temporaryStopToken -Encoding ascii
    $createdHold=$true
    Write-Host 'SC013_TEMPORARY_RUNTIME_HOLD=True'
  }

  $wrapper=Get-LifecycleSupervisorWrapper -Root $root
  if($wrapper){
    & taskkill.exe /PID ([int]$wrapper.ProcessId) /T /F | Out-Host
    Start-Sleep -Milliseconds 750
  }

  $port=Get-HealthyPort
  if($null -eq $port){
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500

    $chromeCandidates=@(
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
      "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    $chrome=$chromeCandidates | Where-Object { $_ -and (Test-Path $_ -PathType Leaf) } | Select-Object -First 1
    if(-not $chrome){ throw 'Installed Chrome not found.' }

    $port=Get-FreePort
    Start-Process -FilePath $chrome -WindowStyle Minimized -ArgumentList @(
      '--remote-debugging-address=127.0.0.1',
      "--remote-debugging-port=$port",
      ('--user-data-dir="' + $profile + '"'),
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-crash-restore-bubble',
      '--start-minimized',
      'https://chatgpt.com/'
    )
    $startedChrome=$true

    $healthy=$false
    for($i=0;$i -lt 40;$i++){
      try {
        $version=Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
        if($version.webSocketDebuggerUrl){ $healthy=$true; break }
      } catch {}
      Start-Sleep -Milliseconds 500
    }
    if(-not $healthy){ throw 'SC-013 dedicated Chrome CDP did not become healthy.' }
  }

  $env:SUPERVISOR_SC013_CDP_URL="http://127.0.0.1:$port"
  Write-Host "SC013_CDP_PORT=$port"
  Write-Host 'SC013_CDP_HEALTHY=True'

  & node (Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc013-task-control-diagnostic.mjs') $root
  $nodeExit=$LASTEXITCODE
  Write-Host "SC013_NODE_EXIT=$nodeExit"
  exit $nodeExit
}
finally {
  if($startedChrome){
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }

  if($createdHold -and (Test-Path $stopPath -PathType Leaf)){
    $current=[string](Get-Content $stopPath -ErrorAction SilentlyContinue | Select-Object -First 1)
    if($current -eq $temporaryStopToken -and -not (Test-Path $autostartDisabledPath)){
      Remove-Item $stopPath -Force -ErrorAction SilentlyContinue
      Write-Host 'SC013_TEMPORARY_RUNTIME_HOLD_CLEARED=True'
    } else {
      Write-Host 'SC013_RUNTIME_HOLD_PRESERVED_OWNER_CHANGE=True'
    }
  }
}
