param(
  [Parameter(Mandatory=$true)][string]$TargetComputer,
  [int]$NonTargetHoldSeconds=120,
  [int]$ResponseTimeoutSeconds=600
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

Write-Host "RECOVER_STUCK_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'RECOVER_STUCK_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'RECOVER_STUCK_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$statePath=Join-Path $root 'single-conversation-state.json'
$startScript=Join-Path $runtime 'windows\start-supervisor.ps1'
$profile=Join-Path $root 'browser_profile'
$stopFile=Join-Path $root 'STOP'
$autostartDisabled=Join-Path $root 'AUTOSTART_DISABLED'

foreach($p in @($runtime,$statePath,$startScript)){
  if(-not (Test-Path $p)){throw "Required recovery path missing: $p"}
}

$s=Get-Content $statePath -Raw -Encoding UTF8|ConvertFrom-Json
Write-Host "RECOVER_STUCK_BEFORE_GENERATION=$([int]$s.conversation.generation)"
Write-Host "RECOVER_STUCK_BEFORE_AUTOMATION=$([string]$s.automation.status)"
Write-Host "RECOVER_STUCK_BEFORE_PHASE=$([string]$s.automation.phase)"
Write-Host "RECOVER_STUCK_BEFORE_REASON=$([string]$s.automation.reason)"
Write-Host "RECOVER_STUCK_BEFORE_OUTBOUND=$([string]$s.outbound.state)"
Write-Host "RECOVER_STUCK_BEFORE_KIND=$([string]$s.outbound.kind)"
Write-Host "RECOVER_STUCK_BEFORE_ID=$([string]$s.outbound.message_id)"

if([string]$s.outbound.state -notin @('ENQUEUED','DELIVERED','RESPONSE_RUNNING')){
  throw "Recovery refused unexpected outbound state: $([string]$s.outbound.state)"
}
if([string]$s.outbound.kind -ne 'SOURCE_OF_TRUTH_TASK_DISCOVERY'){
  throw "Recovery refused unexpected outbound kind: $([string]$s.outbound.kind)"
}

$wrapper=Get-LifecycleSupervisorWrapper -Root $root
if($wrapper){
  Write-Host "RECOVER_STUCK_PAUSING_WRAPPER_PID=$($wrapper.ProcessId)"
  & taskkill.exe /PID ([int]$wrapper.ProcessId) /T /F | Out-Host
  Start-Sleep -Milliseconds 800
}
if(Get-LifecycleSupervisorWrapper -Root $root){
  throw 'Could not pause production wrapper for single-owner recovery.'
}

$chrome=Get-LifecycleRobotChrome -Root $root
if(-not $chrome -or -not $chrome.CommandLine){
  if((Test-Path $stopFile) -or (Test-Path $autostartDisabled)){
    throw 'Owner STOP/AUTOSTART_DISABLED blocks recovery Chrome launch.'
  }

  $chromeCandidates=@(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  $chromeExe=$chromeCandidates|Where-Object{$_ -and (Test-Path $_ -PathType Leaf)}|Select-Object -First 1
  if(-not $chromeExe){throw 'Installed Google Chrome not found.'}

  $cdpPort=$null
  foreach($candidate in 9222..9232){
    $listener=Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue|Select-Object -First 1
    if(-not $listener){$cdpPort=[int]$candidate;break}
  }
  if(-not $cdpPort){throw 'No free Supervisor CDP port.'}

  Start-Process -FilePath $chromeExe -WindowStyle Minimized -ArgumentList @(
    '--remote-debugging-address=127.0.0.1',
    "--remote-debugging-port=$cdpPort",
    ('--user-data-dir="' + $profile + '"'),
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--start-minimized',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    'https://chatgpt.com/'
  )
  Write-Host "RECOVER_STUCK_CHROME_LAUNCHED_DIRECT=True"

  $ready=$false
  for($i=0;$i -lt 30;$i++){
    Start-Sleep -Seconds 1
    try{
      $version=Invoke-RestMethod -Uri "http://127.0.0.1:$cdpPort/json/version" -TimeoutSec 2
      if($version.webSocketDebuggerUrl){$ready=$true;break}
    }catch{}
  }
  if(-not $ready){throw 'Dedicated Chrome/CDP did not become ready.'}
}
$chrome=Get-LifecycleRobotChrome -Root $root
if(-not $chrome -or -not $chrome.CommandLine -or $chrome.CommandLine -notmatch '--remote-debugging-port=(\d+)'){
  throw 'Dedicated Chrome/CDP unavailable for recovery.'
}
$cdp="http://127.0.0.1:$([int]$Matches[1])"
Write-Host "RECOVER_STUCK_CDP=$cdp"

& node (Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc011-recover-stuck-enqueued.mjs') $runtime $statePath $cdp $ResponseTimeoutSeconds
$nodeExit=$LASTEXITCODE
if($nodeExit -ne 0){throw "Recovery worker failed with exit $nodeExit"}

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startScript -Hidden
if($LASTEXITCODE -ne 0){throw "Post-recovery START failed with exit $LASTEXITCODE"}

$healthy=$false
for($i=0;$i -lt 60;$i++){
  Start-Sleep -Seconds 1
  $truth=Get-LifecycleProcessTruth -Root $root
  if($truth.wrapper_alive -and $truth.chrome_alive -and $truth.cdp_healthy){
    $healthy=$true
    break
  }
}
$s2=Get-Content $statePath -Raw -Encoding UTF8|ConvertFrom-Json
Write-Host "RECOVER_STUCK_AFTER_GENERATION=$([int]$s2.conversation.generation)"
Write-Host "RECOVER_STUCK_AFTER_AUTOMATION=$([string]$s2.automation.status)"
Write-Host "RECOVER_STUCK_AFTER_PHASE=$([string]$s2.automation.phase)"
Write-Host "RECOVER_STUCK_AFTER_REASON=$([string]$s2.automation.reason)"
Write-Host "RECOVER_STUCK_AFTER_OUTBOUND=$([string]$s2.outbound.state)"
Write-Host "RECOVER_STUCK_WRAPPER_HEALTHY=$healthy"
if(-not $healthy){throw 'Production wrapper did not become healthy after recovery.'}
Write-Host 'RECOVER_STUCK_STATUS=PASS'
