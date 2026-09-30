param(
  [Parameter(Mandatory=$true)][string]$TargetComputer,
  [Parameter(Mandatory=$true)][string]$ExpectedSha,
  [int]$NonTargetHoldSeconds=150,
  [int]$ObserveSeconds=150
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

Write-Host "SC011_FIX_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC011_FIX_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'SC011_FIX_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$sourceCli=Join-Path $env:GITHUB_WORKSPACE 'src\runtime\single-conversation-cli.mjs'
$targetCli=Join-Path $runtime 'src\runtime\single-conversation-cli.mjs'
$statePath=Join-Path $root 'single-conversation-state.json'
$startScript=Join-Path $runtime 'windows\start-supervisor.ps1'
$stopScript=Join-Path $runtime 'windows\stop-supervisor.ps1'

foreach($p in @($sourceCli,$targetCli,$statePath,$startScript,$stopScript)){
  if(-not (Test-Path $p)){throw "Required production path missing: $p"}
}

function Read-State {
  try { Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null }
}
function Snapshot([string]$label){
  $s=Read-State
  $t=Get-LifecycleProcessTruth -Root $root
  $g=if($s){[int]$s.conversation.generation}else{-1}
  $cs=if($s){[string]$s.conversation.status}else{'MISSING'}
  $a=if($s){[string]$s.automation.status}else{'MISSING'}
  $p=if($s){[string]$s.automation.phase}else{'MISSING'}
  $r=if($s -and $s.automation.reason){[string]$s.automation.reason}else{'NONE'}
  $rr=if($s -and $s.conversation.retirement_reason){[string]$s.conversation.retirement_reason}else{'NONE'}
  Write-Host "SC011_FIX_SNAPSHOT label=$label wrapper=$([bool]$t.wrapper_alive) runtime=$([bool]$t.runtime_alive) chrome=$([bool]$t.chrome_alive) cdp=$([bool]$t.cdp_healthy) generation=$g conversation=$cs automation=$a phase=$p reason=$r retirement_reason=$rr"
  [pscustomobject]@{Generation=$g;Conversation=$cs;Automation=$a;Phase=$p;Reason=$r;RetirementReason=$rr;Truth=$t}
}

$before=Snapshot 'BEFORE'
$initialGeneration=$before.Generation

$sourceHash=(Get-FileHash $sourceCli -Algorithm SHA256).Hash
Copy-Item $sourceCli $targetCli -Force
$targetHash=(Get-FileHash $targetCli -Algorithm SHA256).Hash
if($sourceHash -ne $targetHash){throw 'Installed runtime hash mismatch after hotpatch.'}
Write-Host "SC011_FIX_RUNTIME_SHA256=$targetHash"
Write-Host "SC011_FIX_EXPECTED_COMMIT=$ExpectedSha"
Write-Host 'SC011_FIX_HOTPATCH_INSTALLED=True'

$wrapper=Get-LifecycleSupervisorWrapper -Root $root
if($wrapper){
  $child=Get-LifecycleSingleConversationProcess -Root $root
  if($child){
    Stop-Process -Id ([int]$child.ProcessId) -Force -ErrorAction Stop
    Write-Host "SC011_FIX_OLD_CHILD_STOPPED=$($child.ProcessId)"
  }else{
    Write-Host 'SC011_FIX_CHILD_ALREADY_ABSENT=True'
  }
}else{
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startScript -Hidden
  if($LASTEXITCODE -ne 0){throw "Production START failed with exit $LASTEXITCODE"}
  Write-Host 'SC011_FIX_OWNER_START_INVOKED=True'
}

$deadline=[DateTimeOffset]::UtcNow.AddSeconds([Math]::Max(60,$ObserveSeconds))
$maxGeneration=$initialGeneration
$seenRuntime=$false
$destructiveRestart=$false
$stableActive=$false
while([DateTimeOffset]::UtcNow -lt $deadline){
  Start-Sleep -Seconds 2
  $snap=Snapshot 'OBSERVE'
  if($snap.Generation -gt $maxGeneration){$maxGeneration=$snap.Generation}
  if($snap.Truth.runtime_alive){$seenRuntime=$true}
  if(($snap.Phase -eq 'REPLACE_CHAT') -and ($snap.Reason -eq 'RUNTIME_RESTART_IDENTITY_NOT_VERIFIED')){
    $destructiveRestart=$true
    Write-Host 'SC011_FIX_DESTRUCTIVE_RESTART_REGRESSION=True'
    break
  }
  if(($snap.RetirementReason -eq 'RUNTIME_RESTART_IDENTITY_NOT_VERIFIED') -and ($snap.Generation -gt $initialGeneration)){
    $destructiveRestart=$true
    Write-Host 'SC011_FIX_IDENTITY_RETIREMENT_REGRESSION=True'
    break
  }
  if(
    ($snap.Truth.wrapper_alive) -and
    ($snap.Truth.runtime_alive) -and
    ($snap.Truth.chrome_alive) -and
    ($snap.Truth.cdp_healthy) -and
    ($snap.Conversation -eq 'ACTIVE') -and
    ($snap.Automation -eq 'RUNNING') -and
    ($snap.Phase -ne 'REPLACE_CHAT')
  ){
    $stableActive=$true
  }
  if($snap.Generation -gt ($initialGeneration + 1)){
    $destructiveRestart=$true
    Write-Host "SC011_FIX_GENERATION_STORM=True initial=$initialGeneration current=$($snap.Generation)"
    break
  }
}

$after=Snapshot 'AFTER'
Write-Host "SC011_FIX_INITIAL_GENERATION=$initialGeneration"
Write-Host "SC011_FIX_MAX_GENERATION=$maxGeneration"
Write-Host "SC011_FIX_SEEN_RUNTIME=$seenRuntime"
Write-Host "SC011_FIX_STABLE_ACTIVE=$stableActive"

if($destructiveRestart){
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $stopScript
  Write-Host 'SC011_FIX_FAILSAFE_STOP=True'
  exit 2
}
if(-not $seenRuntime){
  throw 'Patched production runtime never became alive.'
}
if(-not $stableActive){
  throw 'Patched runtime did not demonstrate stable ACTIVE non-REPLACE_CHAT operation.'
}
Write-Host 'SC011_FIX_PRODUCTION_STATUS=PASS'
exit 0
