param(
  [Parameter(Mandatory=$true)][string]$TargetComputer,
  [int]$NonTargetHoldSeconds=5,
  [int]$MaxPreparedSeconds=180,
  [int]$MaxEnqueuedSeconds=180
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

Write-Host "SC013_WATCHDOG_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC013_WATCHDOG_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(30,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'SC013_WATCHDOG_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$statePath=Join-Path $root 'single-conversation-state.json'
$failures=New-Object 'System.Collections.Generic.HashSet[string]'

try{
  $truth=Get-LifecycleProcessTruth -Root $root
  $ownerStop=Get-LifecycleOwnerStopState -Root $root
}catch{
  Write-Host "SC013_WATCHDOG_LIFECYCLE_READ_ERROR=$($_.Exception.Message)"
  exit 1
}

Write-Host "SC013_WATCHDOG_WRAPPER_ALIVE=$([bool]$truth.wrapper_alive)"
Write-Host "SC013_WATCHDOG_CDP_HEALTHY=$([bool]$truth.cdp_healthy)"
Write-Host "SC013_WATCHDOG_RUNTIME_MODE=$([string]$truth.runtime_mode)"
Write-Host "SC013_WATCHDOG_OWNER_STOP_BLOCKED=$([bool]$ownerStop.blocked)"

# Explicit Owner STOP remains authoritative and is not an unattended fault.
if($ownerStop.blocked){
  Write-Host 'SC013_WATCHDOG_STATUS=OWNER_STOP'
  exit 0
}

if(-not $truth.wrapper_alive){[void]$failures.Add('WRAPPER_NOT_ALIVE')}
if(-not $truth.cdp_healthy){[void]$failures.Add('CDP_NOT_HEALTHY')}

if(-not (Test-Path $statePath -PathType Leaf)){
  [void]$failures.Add('STATE_MISSING')
}else{
  try{
    $s=Get-Content $statePath -Raw -Encoding UTF8|ConvertFrom-Json
    $automation=[string]$s.automation.status
    $phase=[string]$s.automation.phase
    $reason=[string]$s.automation.reason
    $conversation=[string]$s.conversation.status
    $outbound=[string]$s.outbound.state
    $kind=[string]$s.outbound.kind
    $messageId=[string]$s.outbound.message_id
    $retry=[int]$s.outbound.retry_count
    $lastCode=[string]$s.outbound.last_error_code
    $updatedAt=[string]$s.updated_at

    Write-Host "SC013_WATCHDOG_AUTOMATION=$automation"
    Write-Host "SC013_WATCHDOG_PHASE=$phase"
    Write-Host "SC013_WATCHDOG_REASON=$reason"
    Write-Host "SC013_WATCHDOG_CONVERSATION=$conversation"
    Write-Host "SC013_WATCHDOG_OUTBOUND=$outbound"
    Write-Host "SC013_WATCHDOG_KIND=$kind"
    Write-Host "SC013_WATCHDOG_MESSAGE_ID=$messageId"
    Write-Host "SC013_WATCHDOG_RETRY_COUNT=$retry"
    Write-Host "SC013_WATCHDOG_LAST_ERROR_CODE=$lastCode"
    Write-Host "SC013_WATCHDOG_UPDATED_AT=$updatedAt"

    if($automation -eq 'BLOCKED'){
      $code=if($lastCode){$lastCode}elseif($reason){$reason}else{'UNKNOWN'}
      [void]$failures.Add("BLOCKED:$code")
    }
    if($automation -eq 'RUNNING' -and $conversation -ne 'ACTIVE'){
      [void]$failures.Add('CONVERSATION_NOT_ACTIVE')
    }
    if($retry -gt 1){[void]$failures.Add('RETRY_BUDGET_EXCEEDED')}

    $now=[DateTimeOffset]::UtcNow
    if($outbound -eq 'PREPARED' -and $s.outbound.prepared_at){
      $age=[int]($now-[DateTimeOffset]::Parse([string]$s.outbound.prepared_at)).TotalSeconds
      Write-Host "SC013_WATCHDOG_PREPARED_AGE_SECONDS=$age"
      if($age -ge $MaxPreparedSeconds){[void]$failures.Add("PREPARED_STALLED:$age")}
    }
    if($outbound -eq 'ENQUEUED' -and $s.outbound.enqueued_at){
      $age=[int]($now-[DateTimeOffset]::Parse([string]$s.outbound.enqueued_at)).TotalSeconds
      Write-Host "SC013_WATCHDOG_ENQUEUED_AGE_SECONDS=$age"
      if($age -ge $MaxEnqueuedSeconds){[void]$failures.Add("ENQUEUED_STALLED:$age")}
    }
  }catch{
    Write-Host "SC013_WATCHDOG_STATE_READ_ERROR=$($_.Exception.Message)"
    [void]$failures.Add('STATE_UNREADABLE')
  }
}

if($failures.Count -gt 0){
  $codes=($failures | Sort-Object) -join ','
  Write-Host "SC013_WATCHDOG_FAILURES=$codes"

  # When the automation browser is still reachable, capture the live page,
  # exact runtime identity, outbound state, and composer draft without sending.
  if($truth.cdp_healthy -and (Test-Path $statePath -PathType Leaf)){
    try{
      & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc013-rebind-diagnostic.ps1') -TargetComputer $TargetComputer -NonTargetHoldSeconds 0
      Write-Host "SC013_WATCHDOG_READONLY_CHATGPT_DIAGNOSTIC_EXIT=$LASTEXITCODE"
    }catch{
      Write-Host "SC013_WATCHDOG_READONLY_CHATGPT_DIAGNOSTIC_ERROR=$($_.Exception.Message)"
    }
  }

  Write-Host 'SC013_WATCHDOG_STATUS=FAIL'
  exit 1
}

Write-Host 'SC013_WATCHDOG_STATUS=PASS'
exit 0
