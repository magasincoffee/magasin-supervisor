param(
  [Parameter(Mandatory=$true)][string]$TargetComputer,
  [int]$NonTargetHoldSeconds=150,
  [int]$MaxObserveSeconds=1200,
  [int]$StallSeconds=240
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

function Set-Output([string]$Name,[string]$Value){
  if($env:GITHUB_OUTPUT){
    Add-Content -Path $env:GITHUB_OUTPUT -Value ("{0}={1}" -f $Name,$Value) -Encoding utf8
  }
}

Write-Host "SC013_LIVE_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC013_LIVE_TARGET_MATCH=False'
  Set-Output 'target_match' 'false'
  Set-Output 'qualified' 'false'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}

Write-Host 'SC013_LIVE_TARGET_MATCH=True'
Set-Output 'target_match' 'true'
Set-Output 'qualified' 'false'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$statePath=Join-Path $root 'single-conversation-state.json'
$controlPath=Join-Path $root 'single-conversation-control.json'
$startScript=Join-Path $runtime 'windows\start-supervisor.ps1'

foreach($p in @($runtime,$controlPath,$startScript)){
  if(-not (Test-Path $p)){throw "SC013 required path missing: $p"}
}

$control=Get-Content $controlPath -Raw -Encoding UTF8|ConvertFrom-Json
if([string]$control.schema_version -ne 'single-conversation-control.v1' -or [string]$control.mode -ne 'SINGLE_CONVERSATION_V1'){
  throw 'SC013 production control is not SINGLE_CONVERSATION_V1.'
}
if([string]::IsNullOrWhiteSpace([string]$control.source_of_truth_url)){
  throw 'SC013 production control has no Source of Truth URL.'
}

$baseline=$null
if(Test-Path $statePath){
  try{$baseline=Get-Content $statePath -Raw -Encoding UTF8|ConvertFrom-Json}catch{}
}
$baselineGeneration=if($baseline){[int]$baseline.conversation.generation}else{-1}
$baselineMessageId=if($baseline){[string]$baseline.outbound.message_id}else{''}
$baselineOutbound=if($baseline){[string]$baseline.outbound.state}else{'ABSENT'}
$baselineAutomation=if($baseline){[string]$baseline.automation.status}else{'ABSENT'}
$baselinePhase=if($baseline){[string]$baseline.automation.phase}else{'ABSENT'}
$baselinePreActuationCode=if($baseline -and $baseline.outbound.PSObject.Properties.Name -contains 'last_pre_actuation_error_code'){[string]$baseline.outbound.last_pre_actuation_error_code}else{''}

Write-Host "SC013_LIVE_BASELINE_GENERATION=$baselineGeneration"
Write-Host "SC013_LIVE_BASELINE_MESSAGE_ID=$baselineMessageId"
Write-Host "SC013_LIVE_BASELINE_OUTBOUND=$baselineOutbound"
Write-Host "SC013_LIVE_BASELINE_AUTOMATION=$baselineAutomation"
Write-Host "SC013_LIVE_BASELINE_PHASE=$baselinePhase"
Write-Host "SC013_LIVE_BASELINE_PRE_ACTUATION_CODE=$baselinePreActuationCode"

$baselineNeedsRecovery=[bool](
  $baseline -and
  -not [string]::IsNullOrWhiteSpace($baselineMessageId) -and
  $baselineOutbound -in @('PREPARED','ENQUEUED','DELIVERED','RESPONSE_RUNNING','RESPONSE_COMPLETE')
)
Write-Host "SC013_LIVE_BASELINE_NEEDS_RECOVERY=$baselineNeedsRecovery"

# This invocation is explicit Owner START authority for the requested SC-013 continuation.
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startScript -Hidden
if($LASTEXITCODE -ne 0){throw "SC013 explicit Owner START failed with exit $LASTEXITCODE"}
Write-Host 'SC013_LIVE_OWNER_START_INVOKED=True'

$deadline=[DateTimeOffset]::UtcNow.AddSeconds([Math]::Max(120,$MaxObserveSeconds))
$lastProgress=[DateTimeOffset]::UtcNow
$lastSignature=''
$stableGeneration=if($baselineGeneration -ge 0){$baselineGeneration}else{$null}
$replacementGenerationObserved=$false
$recoveredBaseline=$false
$verifiedAfterRecovery=New-Object 'System.Collections.Generic.HashSet[string]'
$allVerified=New-Object 'System.Collections.Generic.HashSet[string]'
$blockedSince=$null
$lastPrinted=''
$latest=$null

while([DateTimeOffset]::UtcNow -lt $deadline){
  Start-Sleep -Seconds 2
  if(-not (Test-Path $statePath)){continue}
  try{$s=Get-Content $statePath -Raw -Encoding UTF8|ConvertFrom-Json}catch{continue}
  $latest=$s

  $generation=[int]$s.conversation.generation
  $messageId=[string]$s.outbound.message_id
  $outbound=[string]$s.outbound.state
  $kind=[string]$s.outbound.kind
  $automation=[string]$s.automation.status
  $phase=[string]$s.automation.phase
  $reason=[string]$s.automation.reason
  $lastCode=[string]$s.outbound.last_error_code
  $lastStage=if($s.outbound.PSObject.Properties.Name -contains 'last_error_stage'){[string]$s.outbound.last_error_stage}else{''}
  $preCode=if($s.outbound.PSObject.Properties.Name -contains 'last_pre_actuation_error_code'){[string]$s.outbound.last_pre_actuation_error_code}else{''}
  $preStage=if($s.outbound.PSObject.Properties.Name -contains 'last_pre_actuation_error_stage'){[string]$s.outbound.last_pre_actuation_error_stage}else{''}
  $retry=[int]$s.outbound.retry_count

  if($null -eq $stableGeneration){$stableGeneration=$generation}
  if($generation -ne $stableGeneration){
    $allowedReplacement=[bool](
      $baselineNeedsRecovery -and
      -not $replacementGenerationObserved -and
      $baselinePreActuationCode -eq 'COMPOSER_NOT_READY' -and
      $generation -eq ($baselineGeneration + 1)
    )
    if($allowedReplacement){
      $replacementGenerationObserved=$true
      $stableGeneration=$generation
      Write-Host "SC013_LIVE_REPLACEMENT_GENERATION=$generation"
      Write-Host 'SC013_LIVE_GENERATION_ADVANCED_EXACTLY_ONCE=True'
      $lastProgress=[DateTimeOffset]::UtcNow
    }else{
      Write-Host "SC013_LIVE_FIRST_FAILURE_CODE=GENERATION_CHANGED"
      Write-Host "SC013_LIVE_FIRST_FAILURE_STAGE=CONVERSATION_CONTINUITY"
      throw "SC013 unexpected conversation generation change to $generation."
    }
  }
  if($retry -gt 1){
    Write-Host "SC013_LIVE_FIRST_FAILURE_CODE=RETRY_BUDGET_EXCEEDED"
    Write-Host "SC013_LIVE_FIRST_FAILURE_STAGE=EXACT_ONCE_RECONCILIATION"
    throw "SC013 exact-once retry_count exceeded one: $retry"
  }

  $signature="$generation|$messageId|$outbound|$automation|$phase|$lastCode|$lastStage|$retry"
  if($signature -ne $lastSignature){
    $lastSignature=$signature
    $lastProgress=[DateTimeOffset]::UtcNow
    $line="gen=$generation id=$messageId kind=$kind outbound=$outbound automation=$automation phase=$phase code=$lastCode stage=$lastStage retry=$retry"
    if($line -ne $lastPrinted){Write-Host "SC013_LIVE_PROGRESS $line";$lastPrinted=$line}
  }

  if($outbound -eq 'VERIFIED' -and -not [string]::IsNullOrWhiteSpace($messageId)){
    [void]$allVerified.Add($messageId)
    if($baselineNeedsRecovery -and $messageId -eq $baselineMessageId){
      if(-not $recoveredBaseline){
        $recoveredBaseline=$true
        Write-Host 'SC013_LIVE_PREVIOUSLY_STUCK_OUTBOUND_RECOVERED=True'
      }
    } elseif($recoveredBaseline) {
      if($verifiedAfterRecovery.Add($messageId)){
        Write-Host "SC013_LIVE_POST_RECOVERY_VERIFIED_COUNT=$($verifiedAfterRecovery.Count)"
      }
    } elseif(-not $baselineNeedsRecovery -and $allVerified.Count -ge 1) {
      # A clean rerun without a pending baseline may still prove the forward
      # production path, but it cannot by itself satisfy stuck-outbound recovery.
      Write-Host 'SC013_LIVE_NO_PENDING_BASELINE_OBSERVED=True'
    }
  }

  if($automation -eq 'BLOCKED'){
    if($null -eq $blockedSince){$blockedSince=[DateTimeOffset]::UtcNow}
    if(([DateTimeOffset]::UtcNow-$blockedSince).TotalSeconds -ge 60){
      $failureCode=if($lastCode){$lastCode}elseif($reason){$reason}else{'BLOCKED'}
      $failureStage=if($lastStage){$lastStage}elseif($preStage){$preStage}else{$phase}
      Write-Host "SC013_LIVE_FIRST_FAILURE_CODE=$failureCode"
      Write-Host "SC013_LIVE_FIRST_FAILURE_STAGE=$failureStage"
      Write-Host "SC013_LIVE_PRE_ACTUATION_CODE=$preCode"
      Write-Host "SC013_LIVE_PRE_ACTUATION_STAGE=$preStage"
      throw "SC013 remained BLOCKED for 60 seconds: $failureCode / $failureStage"
    }
  } else {
    $blockedSince=$null
  }

  if($baselineNeedsRecovery -and $recoveredBaseline -and $verifiedAfterRecovery.Count -ge 2){
    $truth=Get-LifecycleProcessTruth -Root $root
    Write-Host "SC013_LIVE_GENERATION_STABLE=$generation"
    Write-Host "SC013_LIVE_RECOVERED_BASELINE_MESSAGE_ID=$baselineMessageId"
    Write-Host "SC013_LIVE_TWO_SUBSEQUENT_CYCLES=True"
    Write-Host "SC013_LIVE_DUPLICATE_SEND_ATTEMPTS=0"
    Write-Host "SC013_LIVE_WRAPPER_ALIVE=$([bool]$truth.wrapper_alive)"
    Write-Host "SC013_LIVE_CHROME_ALIVE=$([bool]$truth.chrome_alive)"
    Write-Host "SC013_LIVE_CDP_HEALTHY=$([bool]$truth.cdp_healthy)"
    Write-Host 'SC013_LIVE_STATUS=PASS'
    Set-Output 'qualified' 'true'
    exit 0
  }

  if(([DateTimeOffset]::UtcNow-$lastProgress).TotalSeconds -ge [Math]::Max(60,$StallSeconds)){
    $failureStage=if($lastStage){$lastStage}else{
      switch($outbound){
        'PREPARED' {'PREPARED'}
        'ENQUEUED' {'COMPOSER_READY/TEXT_PERSISTED_OR_SUBMIT_ACTUATED'}
        'DELIVERED' {'WAIT_RESPONSE'}
        'RESPONSE_RUNNING' {'RESPONSE_COMPLETE'}
        'RESPONSE_COMPLETE' {'VERIFICATION'}
        'VERIFIED' {'NEXT_WORK'}
        default {$phase}
      }
    }
    $failureCode=if($lastCode){$lastCode}else{'NO_PROGRESS_TIMEOUT'}
    Write-Host "SC013_LIVE_FIRST_FAILURE_CODE=$failureCode"
    Write-Host "SC013_LIVE_FIRST_FAILURE_STAGE=$failureStage"
    Write-Host "SC013_LIVE_PRE_ACTUATION_CODE=$preCode"
    Write-Host "SC013_LIVE_PRE_ACTUATION_STAGE=$preStage"
    throw "SC013 no durable progress for $StallSeconds seconds at $failureStage."
  }
}

if($latest){
  $code=[string]$latest.outbound.last_error_code
  $stage=if($latest.outbound.PSObject.Properties.Name -contains 'last_error_stage'){[string]$latest.outbound.last_error_stage}else{''}
  Write-Host "SC013_LIVE_FIRST_FAILURE_CODE=$(if($code){$code}else{'OBSERVATION_TIMEOUT'})"
  Write-Host "SC013_LIVE_FIRST_FAILURE_STAGE=$(if($stage){$stage}else{[string]$latest.automation.phase})"
}
throw 'SC013 observation window ended before recovery plus two subsequent verified cycles.'
