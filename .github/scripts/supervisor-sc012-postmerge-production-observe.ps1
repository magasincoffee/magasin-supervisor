param(
  [Parameter(Mandatory=$true)][string]$TargetComputer,
  [int]$ObserveSeconds = 180,
  [int]$NonTargetHoldSeconds = 120
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

Write-Host "SC012_POSTMERGE_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC012_POSTMERGE_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'SC012_POSTMERGE_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$statePath=Join-Path $root 'single-conversation-state.json'
$startScript=Join-Path $runtime 'windows\start-supervisor.ps1'
$stopScript=Join-Path $runtime 'windows\stop-supervisor.ps1'
$runMarker=Join-Path $root ("SC012_POSTMERGE_" + $env:GITHUB_RUN_ID + ".done")

if(Test-Path $runMarker){
  Write-Host 'SC012_POSTMERGE_ALREADY_EXECUTED=True'
  exit 0
}
Set-Content -Path $runMarker -Value ([DateTimeOffset]::UtcNow.ToString('o')) -Encoding ascii

function Read-State {
  if(-not (Test-Path $statePath -PathType Leaf)){ return $null }
  try { return Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Get-ChatPageCount {
  try {
    $chrome=Get-LifecycleRobotChrome -Root $root
    if(-not $chrome -or -not $chrome.CommandLine){ return -1 }
    if($chrome.CommandLine -notmatch '--remote-debugging-port=(\d+)'){ return -1 }
    $port=[int]$Matches[1]
    $pages=Invoke-RestMethod -Uri "http://127.0.0.1:$port/json" -TimeoutSec 2
    return @($pages | Where-Object {
      try {
        $u=[Uri]([string]$_.url)
        $u.Host -eq 'chatgpt.com' -or $u.Host.EndsWith('.chatgpt.com')
      } catch { $false }
    }).Count
  } catch { return -1 }
}

function Snapshot([string]$Label){
  $truth=Get-LifecycleProcessTruth -Root $root
  $s=Read-State
  $gen=if($s){[int]$s.conversation.generation}else{0}
  $conv=if($s){[string]$s.conversation.status}else{'NONE'}
  $auto=if($s){[string]$s.automation.status}else{'NONE'}
  $phase=if($s){[string]$s.automation.phase}else{'NONE'}
  $reason=if($s -and $s.automation.reason){[string]$s.automation.reason}else{'NONE'}
  $recovery=if($s -and $s.PSObject.Properties['recovery'] -and $s.recovery -and $s.recovery.reason){[string]$s.recovery.reason}else{'NONE'}
  $pages=Get-ChatPageCount
  Write-Host ("SC012_POSTMERGE_SNAPSHOT label={0} wrapper={1} runtime={2} chrome={3} cdp={4} generation={5} conversation={6} automation={7} phase={8} reason={9} recovery={10} pages={11}" -f $Label,[bool]$truth.wrapper_alive,[bool]$truth.runtime_alive,[bool]$truth.chrome_alive,[bool]$truth.cdp_healthy,$gen,$conv,$auto,$phase,$reason,$recovery,$pages)
  return [pscustomobject]@{Truth=$truth;State=$s;Generation=$gen;Conversation=$conv;Automation=$auto;Phase=$phase;Reason=$reason;Recovery=$recovery;Pages=$pages}
}

if(-not (Test-Path $startScript -PathType Leaf)){ throw 'Installed SC-012 START script is missing.' }
if(-not (Test-Path $stopScript -PathType Leaf)){ throw 'Installed SC-012 STOP script is missing.' }

$before=Snapshot 'BEFORE'
$initialGeneration=$before.Generation

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startScript -Hidden
if($LASTEXITCODE -ne 0){ throw "Production START failed with exit $LASTEXITCODE." }
Write-Host 'SC012_POSTMERGE_OWNER_START=True'

$ready=$false
for($i=0;$i -lt 90;$i++){
  Start-Sleep -Seconds 1
  $snap=Snapshot 'STARTUP'
  if($snap.Truth.wrapper_alive -and $snap.Truth.chrome_alive -and $snap.Truth.cdp_healthy){
    $ready=$true
    break
  }
}
if(-not $ready){ throw 'Production runtime did not establish wrapper + Chrome/CDP within 90 seconds.' }

$maxGeneration=$initialGeneration
$bad=$false
$deadline=[DateTimeOffset]::UtcNow.AddSeconds([Math]::Max(60,$ObserveSeconds))
while([DateTimeOffset]::UtcNow -lt $deadline){
  Start-Sleep -Seconds 5
  $snap=Snapshot 'OBSERVE'
  if($snap.Generation -gt $maxGeneration){$maxGeneration=$snap.Generation}

  if($snap.Generation -gt ($initialGeneration + 1)){
    Write-Host "SC012_POSTMERGE_ROLLOVER_STORM=True initial=$initialGeneration current=$($snap.Generation)"
    $bad=$true
    break
  }
  if(
    $snap.Automation -eq 'BLOCKED' -and
    ($snap.Phase -eq 'BOOTSTRAP_FAILED' -or $snap.Reason -eq 'BOOTSTRAP_FAILED')
  ){
    Write-Host 'SC012_POSTMERGE_BOOTSTRAP_FAILURE=True'
    $bad=$true
    break
  }

  # DONE/BLOCKED task authority may intentionally pause the wrapper. That is
  # not a restart-replacement regression, so stop observing once the wrapper
  # has cleanly exited without generation churn.
  if(-not $snap.Truth.wrapper_alive -and -not $bad){
    Write-Host 'SC012_POSTMERGE_WRAPPER_ENDED_WITHOUT_CHURN=True'
    break
  }
}

$after=Snapshot 'AFTER'
Write-Host "SC012_POSTMERGE_INITIAL_GENERATION=$initialGeneration"
Write-Host "SC012_POSTMERGE_MAX_GENERATION=$maxGeneration"
Write-Host "SC012_POSTMERGE_FINAL_GENERATION=$($after.Generation)"
Write-Host "SC012_POSTMERGE_FINAL_CHAT_PAGES=$($after.Pages)"

if($bad){
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $stopScript
  Write-Host 'SC012_POSTMERGE_FAILSAFE_STOP=True'
  exit 2
}

if($maxGeneration -gt ($initialGeneration + 1)){
  throw 'SC-012 production generation growth exceeded one bounded replacement.'
}

Write-Host 'SC012_POSTMERGE_STATUS=PASS'
exit 0
