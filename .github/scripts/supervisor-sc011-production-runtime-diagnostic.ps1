param(
  [Parameter(Mandatory=$true)][string]$TargetComputer,
  [int]$NonTargetHoldSeconds = 150,
  [int]$ObserveSeconds = 120
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

function Set-JobOutput([string]$Name,[string]$Value){
  if($env:GITHUB_OUTPUT){
    "$Name=$Value" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
  }
}

Write-Host "SC011_DIAG_MACHINE=$env:COMPUTERNAME"
Write-Host "SC011_DIAG_TARGET=$TargetComputer"

if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC011_DIAG_TARGET_MATCH=False'
  Set-JobOutput 'target_match' 'false'
  Set-JobOutput 'diagnostic_status' 'NON_TARGET'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}

Write-Host 'SC011_DIAG_TARGET_MATCH=True'
Set-JobOutput 'target_match' 'true'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime = Join-Path $root 'runtime'
$statePath = Join-Path $root 'single-conversation-state.json'
$controlPath = Join-Path $root 'single-conversation-control.json'
$startScript = Join-Path $runtime 'windows\start-supervisor.ps1'
$stopScript = Join-Path $runtime 'windows\stop-supervisor.ps1'
$runMarker = Join-Path $root ("SC011_PROD_DIAG_" + $env:GITHUB_RUN_ID + ".done")

if(Test-Path $runMarker){
  Write-Host 'SC011_DIAG_ALREADY_EXECUTED_ON_TARGET=True'
  Set-JobOutput 'diagnostic_status' 'ALREADY_EXECUTED'
  exit 0
}
Set-Content -Path $runMarker -Value ([DateTimeOffset]::UtcNow.ToString('o')) -Encoding ascii

function Read-State {
  if(-not (Test-Path $statePath -PathType Leaf)){ return $null }
  try { return Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Get-ChatPageCount {
  try {
    $chrome = Get-LifecycleRobotChrome -Root $root
    if(-not $chrome -or -not $chrome.CommandLine){ return -1 }
    if($chrome.CommandLine -notmatch '--remote-debugging-port=(\d+)'){ return -1 }
    $port=[int]$Matches[1]
    $pages = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json" -TimeoutSec 2
    return @($pages | Where-Object {
      try {
        $u=[Uri]([string]$_.url)
        $u.Host -eq 'chatgpt.com' -or $u.Host.EndsWith('.chatgpt.com')
      } catch { $false }
    }).Count
  } catch { return -1 }
}

function Write-Snapshot([string]$Label){
  $truth=Get-LifecycleProcessTruth -Root $root
  $s=Read-State
  $gen=if($s){[int]$s.conversation.generation}else{-1}
  $conv=if($s){[string]$s.conversation.status}else{'MISSING'}
  $phase=if($s){[string]$s.automation.phase}else{'MISSING'}
  $auto=if($s){[string]$s.automation.status}else{'MISSING'}
  $reason=if($s -and $s.automation.reason){[string]$s.automation.reason}else{'NONE'}
  $outbound=if($s){[string]$s.outbound.state}else{'MISSING'}
  $outErr=if($s -and $s.outbound.last_error_code){[string]$s.outbound.last_error_code}else{'NONE'}
  $retire=if($s -and $s.conversation.retirement_reason){[string]$s.conversation.retirement_reason}else{'NONE'}
  $recovery=if($s -and $s.PSObject.Properties['recovery'] -and $s.recovery -and $s.recovery.reason){[string]$s.recovery.reason}else{'NONE'}
  $pages=Get-ChatPageCount
  Write-Host ("SC011_DIAG_SNAPSHOT label={0} wrapper={1} runtime={2} chrome={3} cdp={4} generation={5} conversation={6} automation={7} phase={8} reason={9} outbound={10} outbound_error={11} retirement_reason={12} recovery_reason={13} chat_pages={14}" -f $Label,[bool]$truth.wrapper_alive,[bool]$truth.runtime_alive,[bool]$truth.chrome_alive,[bool]$truth.cdp_healthy,$gen,$conv,$auto,$phase,$reason,$outbound,$outErr,$retire,$recovery,$pages)
  return [pscustomobject]@{
    Truth=$truth; State=$s; Generation=$gen; PageCount=$pages;
    Automation=$auto; Phase=$phase; Reason=$reason; OutboundError=$outErr;
    RetirementReason=$retire; RecoveryReason=$recovery
  }
}

if(-not (Test-Path $controlPath -PathType Leaf)){ throw 'Production single-conversation control is missing.' }
if(-not (Test-Path $startScript -PathType Leaf)){ throw 'Installed START script is missing.' }
if(-not (Test-Path $stopScript -PathType Leaf)){ throw 'Installed STOP script is missing.' }

$before=Write-Snapshot 'BEFORE'
$initialGeneration=$before.Generation
$initialPages=$before.PageCount
$startedByDiagnostic=$false

if(-not $before.Truth.wrapper_alive){
  Write-Host 'SC011_DIAG_STARTING_PRODUCTION_ROBOT=True'
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startScript -Hidden
  if($LASTEXITCODE -ne 0){ throw "Production START failed with exit $LASTEXITCODE." }
  $startedByDiagnostic=$true
} else {
  Write-Host 'SC011_DIAG_REUSING_RUNNING_PRODUCTION_ROBOT=True'
}

$deadline=[DateTimeOffset]::UtcNow.AddSeconds([Math]::Max(30,$ObserveSeconds))
$lastGeneration=$initialGeneration
$maxGeneration=$initialGeneration
$maxPages=$initialPages
$storm=$false
$terminalError=$false

while([DateTimeOffset]::UtcNow -lt $deadline){
  Start-Sleep -Seconds 2
  $snap=Write-Snapshot 'OBSERVE'
  if($snap.Generation -gt $maxGeneration){ $maxGeneration=$snap.Generation }
  if($snap.PageCount -gt $maxPages){ $maxPages=$snap.PageCount }

  if($snap.Generation -ge ($initialGeneration + 2)){
    $storm=$true
    Write-Host "SC011_DIAG_ROLLOVER_STORM=True initial_generation=$initialGeneration current_generation=$($snap.Generation)"
    break
  }
  if($initialPages -ge 0 -and $snap.PageCount -ge ($initialPages + 4)){
    $storm=$true
    Write-Host "SC011_DIAG_TAB_STORM=True initial_pages=$initialPages current_pages=$($snap.PageCount)"
    break
  }
  if($snap.Automation -eq 'BLOCKED'){
    $terminalError=$true
    Write-Host "SC011_DIAG_AUTOMATION_BLOCKED=True reason=$($snap.Reason) outbound_error=$($snap.OutboundError)"
    break
  }
  if(-not $snap.Truth.wrapper_alive -and $snap.Automation -eq 'RUNNING'){
    $terminalError=$true
    Write-Host 'SC011_DIAG_STALE_RUNNING_STATE_WITH_DEAD_WRAPPER=True'
    break
  }
  $lastGeneration=$snap.Generation
}

$after=Write-Snapshot 'AFTER'
Write-Host "SC011_DIAG_STARTED_BY_DIAGNOSTIC=$startedByDiagnostic"
Write-Host "SC011_DIAG_INITIAL_GENERATION=$initialGeneration"
Write-Host "SC011_DIAG_MAX_GENERATION=$maxGeneration"
Write-Host "SC011_DIAG_INITIAL_CHAT_PAGES=$initialPages"
Write-Host "SC011_DIAG_MAX_CHAT_PAGES=$maxPages"

if($storm){
  Write-Host 'SC011_DIAG_FAILSAFE_STOP=True'
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $stopScript
  Write-Snapshot 'AFTER_FAILSAFE_STOP' | Out-Null
  Set-JobOutput 'diagnostic_status' 'ROLLOVER_STORM'
  exit 2
}

if($terminalError){
  Set-JobOutput 'diagnostic_status' 'RUNTIME_ERROR'
  exit 3
}

Write-Host 'SC011_DIAG_STATUS=STABLE_DURING_WINDOW'
Set-JobOutput 'diagnostic_status' 'STABLE_DURING_WINDOW'
exit 0
