param(
  [Parameter(Mandatory=$true)][string]$TargetComputer,
  [int]$NonTargetHoldSeconds=180,
  [int]$ObserveSeconds=900
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

Write-Host "SC013_RESUME_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC013_RESUME_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(240,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'SC013_RESUME_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$statePath=Join-Path $root 'single-conversation-state.json'
$startScript=Join-Path $runtime 'windows\start-supervisor.ps1'
if(-not (Test-Path $statePath)){throw 'single conversation state missing'}
if(-not (Test-Path $startScript)){throw 'start script missing'}

$initial=Get-Content $statePath -Raw -Encoding UTF8|ConvertFrom-Json
$initialGeneration=[int]$initial.conversation.generation
$initialId=[string]$initial.outbound.message_id
Write-Host "SC013_RESUME_INITIAL_GENERATION=$initialGeneration"
Write-Host "SC013_RESUME_INITIAL_OUTBOUND=$([string]$initial.outbound.state)"
Write-Host "SC013_RESUME_INITIAL_AUTOMATION=$([string]$initial.automation.status)"
Write-Host "SC013_RESUME_INITIAL_PHASE=$([string]$initial.automation.phase)"
Write-Host "SC013_RESUME_INITIAL_ID=$initialId"

if([string]$initial.outbound.state -ne 'VERIFIED'){throw 'resume requires VERIFIED outbound'}
if([string]$initial.automation.status -ne 'RUNNING'){throw 'resume requires RUNNING automation'}

$truth=Get-LifecycleProcessTruth -Root $root
if(-not $truth.wrapper_alive){
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startScript -Hidden
  if($LASTEXITCODE -ne 0){throw "START failed with exit $LASTEXITCODE"}
  Write-Host 'SC013_RESUME_START_INVOKED=True'
}else{
  Write-Host 'SC013_RESUME_WRAPPER_ALREADY_RUNNING=True'
}

$seen=@{}
$verified=@{}
$retryViolation=$false
$generationViolation=$false
$lastId=''
$lastState=''
$deadline=[DateTimeOffset]::UtcNow.AddSeconds([Math]::Max(120,$ObserveSeconds))
while([DateTimeOffset]::UtcNow -lt $deadline){
  Start-Sleep -Seconds 3
  if(-not (Test-Path $statePath)){continue}
  $s=Get-Content $statePath -Raw -Encoding UTF8|ConvertFrom-Json
  $gen=[int]$s.conversation.generation
  $id=[string]$s.outbound.message_id
  $os=[string]$s.outbound.state
  $auto=[string]$s.automation.status
  $phase=[string]$s.automation.phase
  $reason=[string]$s.automation.reason
  $retry=[int]$s.outbound.retry_count

  if($gen -ne $initialGeneration){
    $generationViolation=$true
    Write-Host "SC013_RESUME_GENERATION_CHANGED=$initialGeneration->$gen"
    break
  }

  if($id -and $id -ne $initialId){
    if(-not $seen.ContainsKey($id)){
      $seen[$id]=$true
      Write-Host "SC013_RESUME_NEW_MESSAGE_ID=$id"
    }
    if($retry -gt 0){
      $retryViolation=$true
      Write-Host "SC013_RESUME_NEW_MESSAGE_RETRY_VIOLATION id=$id retry=$retry"
      break
    }
    if($os -eq 'VERIFIED' -and -not $verified.ContainsKey($id)){
      $verified[$id]=$true
      Write-Host "SC013_RESUME_VERIFIED_CYCLE id=$id count=$($verified.Count)"
    }
  }

  if($id -ne $lastId -or $os -ne $lastState){
    Write-Host "SC013_RESUME_STATE id=$id outbound=$os automation=$auto phase=$phase reason=$reason retry=$retry generation=$gen"
    $lastId=$id
    $lastState=$os
  }

  if($verified.Count -ge 2){
    Write-Host 'SC013_RESUME_TWO_SUBSEQUENT_VERIFIED=True'
    break
  }

  if($auto -eq 'BLOCKED'){
    Write-Host "SC013_RESUME_BLOCKED_BEFORE_ACCEPTANCE=True reason=$reason"
    break
  }
  if($auto -eq 'DONE' -and $verified.Count -lt 2){
    Write-Host 'SC013_RESUME_DONE_BEFORE_TWO_CYCLES=True'
    break
  }
}

$final=Get-Content $statePath -Raw -Encoding UTF8|ConvertFrom-Json
$truthFinal=Get-LifecycleProcessTruth -Root $root
Write-Host "SC013_RESUME_FINAL_GENERATION=$([int]$final.conversation.generation)"
Write-Host "SC013_RESUME_FINAL_OUTBOUND=$([string]$final.outbound.state)"
Write-Host "SC013_RESUME_FINAL_AUTOMATION=$([string]$final.automation.status)"
Write-Host "SC013_RESUME_FINAL_PHASE=$([string]$final.automation.phase)"
Write-Host "SC013_RESUME_FINAL_REASON=$([string]$final.automation.reason)"
Write-Host "SC013_RESUME_FINAL_RETRY=$([int]$final.outbound.retry_count)"
Write-Host "SC013_RESUME_WRAPPER_ALIVE=$([bool]$truthFinal.wrapper_alive)"
Write-Host "SC013_RESUME_RUNTIME_ALIVE=$([bool]$truthFinal.runtime_alive)"
Write-Host "SC013_RESUME_CHROME_ALIVE=$([bool]$truthFinal.chrome_alive)"
Write-Host "SC013_RESUME_CDP_HEALTHY=$([bool]$truthFinal.cdp_healthy)"
Write-Host "SC013_RESUME_DISTINCT_NEW_IDS=$($seen.Count)"
Write-Host "SC013_RESUME_VERIFIED_CYCLES=$($verified.Count)"
Write-Host "SC013_RESUME_RETRY_VIOLATION=$retryViolation"
Write-Host "SC013_RESUME_GENERATION_VIOLATION=$generationViolation"

if($generationViolation){throw 'conversation generation changed during SC-013 acceptance'}
if($retryViolation){throw 'new-cycle retry observed during SC-013 acceptance'}
if($verified.Count -lt 2){throw "SC-013 acceptance observed only $($verified.Count) verified subsequent cycles"}
Write-Host 'SC013_RESUME_STATUS=PASS'
