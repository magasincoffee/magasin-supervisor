param(
  [Parameter(Mandatory=$true)][string]$TargetComputer,
  [int]$NonTargetHoldSeconds = 120
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

function Set-JobOutput([string]$Name,[string]$Value){
  if($env:GITHUB_OUTPUT){
    "$Name=$Value" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
  }
}

Write-Host "SC011_REPAIR_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC011_REPAIR_TARGET_MATCH=False'
  Set-JobOutput 'target_match' 'false'
  Set-JobOutput 'repair_status' 'NON_TARGET'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'SC011_REPAIR_TARGET_MATCH=True'
Set-JobOutput 'target_match' 'true'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$statePath=Join-Path $root 'single-conversation-state.json'
$installedCli=Join-Path $runtime 'src\runtime\single-conversation-cli.mjs'
$stopScript=Join-Path $runtime 'windows\stop-supervisor.ps1'
$startScript=Join-Path $runtime 'windows\start-supervisor.ps1'
$marker=Join-Path $root ("SC011_REPAIR_FALSE_ENQUEUED_" + $env:GITHUB_RUN_ID + ".done")

if(Test-Path $marker){
  Write-Host 'SC011_REPAIR_ALREADY_EXECUTED=True'
  Set-JobOutput 'repair_status' 'ALREADY_EXECUTED'
  exit 0
}

foreach($p in @($statePath,$installedCli,$stopScript,$startScript)){
  if(-not (Test-Path $p -PathType Leaf)){ throw "Required production file missing: $p" }
}

$cliText=Get-Content $installedCli -Raw -Encoding UTF8
if($cliText -notmatch 'PREPARED is the only correct state before first reconciliation'){
  throw 'Installed production runtime does not contain the exact-once enqueue fix.'
}
Write-Host 'SC011_REPAIR_INSTALLED_FIX_VERIFIED=True'

function Read-State {
  return Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
}
function Get-ChatPageCount {
  try {
    $chrome=Get-LifecycleRobotChrome -Root $root
    if(-not $chrome -or -not $chrome.CommandLine -or $chrome.CommandLine -notmatch '--remote-debugging-port=(\d+)'){ return -1 }
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
  $s=Read-State
  $truth=Get-LifecycleProcessTruth -Root $root
  $gen=[int]$s.conversation.generation
  $auto=[string]$s.automation.status
  $phase=[string]$s.automation.phase
  $reason=if($s.automation.reason){[string]$s.automation.reason}else{'NONE'}
  $out=[string]$s.outbound.state
  $err=if($s.outbound.last_error_code){[string]$s.outbound.last_error_code}else{'NONE'}
  $pages=Get-ChatPageCount
  Write-Host ("SC011_REPAIR_SNAPSHOT label={0} wrapper={1} runtime={2} chrome={3} cdp={4} generation={5} conversation={6} automation={7} phase={8} reason={9} outbound={10} outbound_error={11} chat_pages={12}" -f $Label,[bool]$truth.wrapper_alive,[bool]$truth.runtime_alive,[bool]$truth.chrome_alive,[bool]$truth.cdp_healthy,$gen,[string]$s.conversation.status,$auto,$phase,$reason,$out,$err,$pages)
  return [pscustomobject]@{ State=$s; Truth=$truth; Generation=$gen; Automation=$auto; Phase=$phase; Reason=$reason; Outbound=$out; Error=$err; Pages=$pages }
}

$before=Snapshot 'BEFORE'
$s=$before.State
$valid=[bool](
  [int]$s.conversation.generation -eq 174 -and
  [string]$s.conversation.status -eq 'ACTIVE' -and
  [string]$s.automation.status -eq 'BLOCKED' -and
  [string]$s.automation.reason -eq 'AMBIGUOUS_ENQUEUED_OUTCOME' -and
  [string]$s.outbound.state -eq 'ENQUEUED' -and
  [string]$s.outbound.last_error_code -eq 'AMBIGUOUS_ENQUEUED_OUTCOME' -and
  [int]$s.outbound.retry_count -eq 0 -and
  -not [string]::IsNullOrWhiteSpace([string]$s.conversation.runtime_id)
)
if(-not $valid){
  throw 'Production state no longer matches the proven false-ENQUEUED incident; refusing mutation.'
}
Write-Host 'SC011_REPAIR_GUARD_MATCH=True'

# Quiesce all writers first. STOP is immediately cleared by the explicit START below.
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $stopScript
Start-Sleep -Seconds 2
if((Get-LifecycleProcessTruth -Root $root).wrapper_alive){
  throw 'Supervisor wrapper is still alive after guarded STOP.'
}

$afterStop=Read-State
if(
  [int]$afterStop.conversation.generation -ne 174 -or
  [string]$afterStop.outbound.last_error_code -ne 'AMBIGUOUS_ENQUEUED_OUTCOME'
){
  throw 'State changed while quiescing; refusing repair.'
}

$backup="$statePath.sc011-false-enqueued-$($env:GITHUB_RUN_ID).bak"
Copy-Item $statePath $backup -Force
Write-Host "SC011_REPAIR_BACKUP=$backup"

$now=[DateTimeOffset]::UtcNow.ToString('o')
$afterStop.outbound=[pscustomobject]@{
  state='RESPONSE_COMPLETE'
  message_id=$null
  message_digest=$null
  kind=$null
  cmd_id=$null
  baseline_user_turn_id=$null
  delivered_user_turn_id=$null
  prepared_at=$null
  enqueued_at=$null
  delivered_at=$null
  response_running_at=$null
  response_complete_at=$now
  verified_at=$null
  retry_count=0
  last_error_code=$null
}
$afterStop.automation.status='RUNNING'
$afterStop.automation.phase='BOOTSTRAP_RESPONSE_COMPLETE'
$afterStop.automation.reason=$null
$afterStop.automation.updated_at=$now
$afterStop.updated_at=$now

$tmp="$statePath.repair.tmp"
$json=$afterStop | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($tmp,$json+[Environment]::NewLine,(New-Object System.Text.UTF8Encoding($false)))
Move-Item $tmp $statePath -Force
Set-Content -Path $marker -Value $now -Encoding ascii
Write-Host 'SC011_REPAIR_STATE_RESTORED_TO_POST_BOOTSTRAP=True'

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startScript -Hidden
if($LASTEXITCODE -ne 0){ throw "Production START failed with exit $LASTEXITCODE." }
Write-Host 'SC011_REPAIR_OWNER_START=True'

$deadline=[DateTimeOffset]::UtcNow.AddSeconds(150)
$sendObserved=$false
$responseObserved=$false
while([DateTimeOffset]::UtcNow -lt $deadline){
  Start-Sleep -Seconds 2
  $snap=Snapshot 'OBSERVE'
  if($snap.Generation -ne 174){
    throw "Conversation generation changed unexpectedly: $($snap.Generation)"
  }
  if($snap.Automation -eq 'BLOCKED'){
    throw "Production blocked again: $($snap.Reason)"
  }
  if($snap.Pages -gt 2){
    throw "Unexpected ChatGPT page growth: $($snap.Pages)"
  }
  if($snap.Outbound -in @('DELIVERED','RESPONSE_RUNNING','RESPONSE_COMPLETE','VERIFIED')){
    $sendObserved=$true
  }
  if($snap.Outbound -in @('RESPONSE_RUNNING','RESPONSE_COMPLETE','VERIFIED')){
    $responseObserved=$true
  }
  if($sendObserved -and $snap.Truth.runtime_alive -and $snap.Truth.cdp_healthy){
    Write-Host "SC011_REPAIR_TASK_DELIVERY_CONFIRMED=True outbound=$($snap.Outbound)"
    Write-Host "SC011_REPAIR_RESPONSE_PROGRESS=$responseObserved"
    Set-JobOutput 'repair_status' 'TASK_DELIVERY_CONFIRMED'
    exit 0
  }
}

throw 'Timed out waiting for a confirmed post-repair task delivery.'
