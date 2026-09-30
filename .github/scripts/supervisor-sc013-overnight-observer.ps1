param(
  [Parameter(Mandatory=$true)][string]$TargetComputer,
  [Parameter(Mandatory=$true)][string]$EndUtc,
  [int]$AttemptSeconds=1200,
  [int]$PollSeconds=5,
  [int]$NonTargetHoldSeconds=60
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

function Write-Summary([string]$Line){
  if($env:GITHUB_STEP_SUMMARY){
    Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value $Line -Encoding utf8
  }
}

$end=[DateTimeOffset]::Parse($EndUtc).ToUniversalTime()
Write-Host "SC013_OVERNIGHT_MACHINE=$env:COMPUTERNAME"
Write-Host "SC013_OVERNIGHT_END_UTC=$($end.ToString('o'))"

if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC013_OVERNIGHT_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}

Write-Host 'SC013_OVERNIGHT_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$statePath=Join-Path $root 'single-conversation-state.json'
$attempt=0
$totalFailures=0
$totalPasses=0
$lastGeneration=$null
$lastSignature=''

Write-Summary "## SC-013 Overnight Stability Observation"
Write-Summary ""
Write-Summary "- Target: $TargetComputer"
Write-Summary "- End UTC: $($end.ToString('o'))"
Write-Summary "- Attempt window: $AttemptSeconds seconds"
Write-Summary ""

while([DateTimeOffset]::UtcNow -lt $end){
  $attempt += 1
  $attemptStart=[DateTimeOffset]::UtcNow
  $remaining=[Math]::Max(1,[int](($end-$attemptStart).TotalSeconds))
  $window=[Math]::Min([Math]::Max(60,$AttemptSeconds),$remaining)
  $attemptEnd=$attemptStart.AddSeconds($window)
  $attemptFailed=$false
  $failureCodes=New-Object 'System.Collections.Generic.HashSet[string]'
  $blockedSince=$null
  $runtimeDownSince=$null
  $cdpDownSince=$null

  Write-Host "SC013_OVERNIGHT_ATTEMPT_START=$attempt"
  Write-Host "SC013_OVERNIGHT_ATTEMPT_WINDOW_SECONDS=$window"
  Write-Summary "### Attempt $attempt — $($attemptStart.ToString('o'))"

  while([DateTimeOffset]::UtcNow -lt $attemptEnd -and [DateTimeOffset]::UtcNow -lt $end){
    $truth=$null
    $ownerStop=$null
    try{
      $truth=Get-LifecycleProcessTruth -Root $root
      $ownerStop=Get-LifecycleOwnerStopState -Root $root
    }catch{
      $attemptFailed=$true
      [void]$failureCodes.Add('LIFECYCLE_TRUTH_READ_FAILED')
      Start-Sleep -Seconds ([Math]::Max(2,$PollSeconds))
      continue
    }

    if($ownerStop.blocked){
      $attemptFailed=$true
      [void]$failureCodes.Add('OWNER_STOP_LATCHED')
    }

    if(-not $truth.wrapper_alive){
      if($null -eq $runtimeDownSince){$runtimeDownSince=[DateTimeOffset]::UtcNow}
      if(([DateTimeOffset]::UtcNow-$runtimeDownSince).TotalSeconds -ge 30){
        $attemptFailed=$true
        [void]$failureCodes.Add('WRAPPER_NOT_ALIVE')
      }
    }else{
      $runtimeDownSince=$null
    }

    if(-not $truth.cdp_healthy){
      if($null -eq $cdpDownSince){$cdpDownSince=[DateTimeOffset]::UtcNow}
      if(([DateTimeOffset]::UtcNow-$cdpDownSince).TotalSeconds -ge 30){
        $attemptFailed=$true
        [void]$failureCodes.Add('CDP_NOT_HEALTHY')
      }
    }else{
      $cdpDownSince=$null
    }

    if(-not (Test-Path $statePath)){
      $attemptFailed=$true
      [void]$failureCodes.Add('STATE_MISSING')
      Start-Sleep -Seconds ([Math]::Max(2,$PollSeconds))
      continue
    }

    try{
      $s=Get-Content $statePath -Raw -Encoding UTF8|ConvertFrom-Json
    }catch{
      $attemptFailed=$true
      [void]$failureCodes.Add('STATE_UNREADABLE')
      Start-Sleep -Seconds ([Math]::Max(2,$PollSeconds))
      continue
    }

    $generation=[int]$s.conversation.generation
    $messageId=[string]$s.outbound.message_id
    $outbound=[string]$s.outbound.state
    $kind=[string]$s.outbound.kind
    $automation=[string]$s.automation.status
    $phase=[string]$s.automation.phase
    $reason=[string]$s.automation.reason
    $retry=[int]$s.outbound.retry_count
    $lastCode=[string]$s.outbound.last_error_code

    if($null -ne $lastGeneration -and $generation -ne $lastGeneration){
      Write-Host "SC013_OVERNIGHT_GENERATION_CHANGE=$lastGeneration->$generation"
    }
    $lastGeneration=$generation

    if($retry -gt 1){
      $attemptFailed=$true
      [void]$failureCodes.Add('RETRY_BUDGET_EXCEEDED')
    }

    if($automation -eq 'BLOCKED'){
      if($null -eq $blockedSince){$blockedSince=[DateTimeOffset]::UtcNow}
      if(([DateTimeOffset]::UtcNow-$blockedSince).TotalSeconds -ge 60){
        $attemptFailed=$true
        $blockedCode=if($lastCode){$lastCode}elseif($reason){$reason}else{'BLOCKED'}
        [void]$failureCodes.Add("BLOCKED:$blockedCode")
      }
    }else{
      $blockedSince=$null
    }

    $signature="$generation|$messageId|$kind|$outbound|$automation|$phase|$lastCode|$retry"
    if($signature -ne $lastSignature){
      $lastSignature=$signature
      Write-Host "SC013_OVERNIGHT_PROGRESS attempt=$attempt gen=$generation id=$messageId kind=$kind outbound=$outbound automation=$automation phase=$phase code=$lastCode retry=$retry"
    }

    Start-Sleep -Seconds ([Math]::Max(2,$PollSeconds))
  }

  if($attemptFailed){
    $totalFailures += 1
    $codes=($failureCodes | Sort-Object) -join ','
    Write-Host "SC013_OVERNIGHT_ATTEMPT_RESULT=$attempt|FAIL|$codes"
    Write-Summary "- Result: **FAIL** — $codes"
  }else{
    $totalPasses += 1
    Write-Host "SC013_OVERNIGHT_ATTEMPT_RESULT=$attempt|PASS"
    Write-Summary "- Result: **PASS**"
  }

  # Attempts are intentionally sequential and gapless. The next attempt starts
  # immediately regardless of PASS/FAIL so one observation result cannot stop
  # overnight monitoring.
}

Write-Host "SC013_OVERNIGHT_ATTEMPTS=$attempt"
Write-Host "SC013_OVERNIGHT_PASS_COUNT=$totalPasses"
Write-Host "SC013_OVERNIGHT_FAIL_COUNT=$totalFailures"
Write-Host "SC013_OVERNIGHT_END_REACHED=True"

Write-Summary ""
Write-Summary "## Overnight totals"
Write-Summary "- Attempts: **$attempt**"
Write-Summary "- PASS: **$totalPasses**"
Write-Summary "- FAIL: **$totalFailures**"
Write-Summary "- End reached: **True**"

if($totalFailures -gt 0){
  Write-Host 'SC013_OVERNIGHT_STATUS=FAIL'
  exit 1
}

Write-Host 'SC013_OVERNIGHT_STATUS=PASS'
exit 0
