param(
  [string]$TargetComputer='DESKTOP-4K7IM13',
  [int]$NonTargetHoldSeconds=60
)
$ErrorActionPreference='Stop'
Write-Host "SC010_POSTFAIL_MACHINE=$env:COMPUTERNAME"
if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Host 'SC010_POSTFAIL_TARGET=False'
  Start-Sleep -Seconds $NonTargetHoldSeconds
  exit 0
}
Write-Host 'SC010_POSTFAIL_TARGET=True'
. (Join-Path $PSScriptRoot '..\..\windows\state-root.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$diag=Join-Path $root 'diagnostics\sc010-live'
Write-Host "SC010_POSTFAIL_DIAG_DIR=$diag"
if (-not (Test-Path $diag)) { throw 'SC010 diagnostics directory missing.' }
$states=@(Get-ChildItem $diag -Filter '*.state.json' -File | Sort-Object LastWriteTimeUtc -Descending)
Write-Host ("SC010_POSTFAIL_STATE_COUNT=" + $states.Count)
foreach($file in @($states | Select-Object -First 5)) {
  Write-Host ("SC010_POSTFAIL_FILE=" + $file.Name + ";WRITE_UTC=" + $file.LastWriteTimeUtc.ToString('o'))
  try {
    $s=Get-Content $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host ("SC010_POSTFAIL_UPDATED_AT=" + [string]$s.updated_at)
    Write-Host ("SC010_POSTFAIL_GENERATION=" + [string]$s.conversation.generation)
    Write-Host ("SC010_POSTFAIL_CONVERSATION_STATUS=" + [string]$s.conversation.status)
    Write-Host ("SC010_POSTFAIL_PHASE=" + [string]$s.automation.phase)
    Write-Host ("SC010_POSTFAIL_AUTOMATION_STATUS=" + [string]$s.automation.status)
    Write-Host ("SC010_POSTFAIL_REASON=" + [string]$s.automation.reason)
    Write-Host ("SC010_POSTFAIL_OUTBOUND_STATE=" + [string]$s.outbound.state)
    Write-Host ("SC010_POSTFAIL_OUTBOUND_KIND=" + [string]$s.outbound.kind)
    Write-Host ("SC010_POSTFAIL_MESSAGE_ID=" + [string]$s.outbound.message_id)
    Write-Host ("SC010_POSTFAIL_RETRY_COUNT=" + [string]$s.outbound.retry_count)
    Write-Host ("SC010_POSTFAIL_PREPARED_AT=" + [string]$s.outbound.prepared_at)
    Write-Host ("SC010_POSTFAIL_ENQUEUED_AT=" + [string]$s.outbound.enqueued_at)
    Write-Host ("SC010_POSTFAIL_DELIVERED_AT=" + [string]$s.outbound.delivered_at)
    Write-Host ("SC010_POSTFAIL_RESPONSE_RUNNING_AT=" + [string]$s.outbound.response_running_at)
    Write-Host ("SC010_POSTFAIL_RESPONSE_COMPLETE_AT=" + [string]$s.outbound.response_complete_at)
    Write-Host ("SC010_POSTFAIL_VERIFIED_AT=" + [string]$s.outbound.verified_at)
    Write-Host ("SC010_POSTFAIL_LAST_ERROR=" + [string]$s.outbound.last_error_code)
    Write-Host ("SC010_POSTFAIL_SOT_SYNC=" + [string]$s.source_of_truth.sync_status)
    if ($s.recovery) {
      Write-Host ("SC010_POSTFAIL_RECOVERY_REASON=" + [string]$s.recovery.reason)
      Write-Host ("SC010_POSTFAIL_RECOVERY_RETIRED_GENERATION=" + [string]$s.recovery.retired_generation)
      Write-Host ("SC010_POSTFAIL_RECOVERY_REHYDRATED_GENERATION=" + [string]$s.recovery.rehydrated_generation)
    }
  } catch {
    Write-Host ("SC010_POSTFAIL_STATE_READ_ERROR=" + $_.Exception.GetType().Name)
  }
}
$single=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {$_.CommandLine -and $_.CommandLine -like '*single-conversation-cli.mjs*'})
Write-Host ("SC010_POSTFAIL_PRODUCTION_SINGLE_NODE_COUNT=" + $single.Count)
Write-Host 'SC010_POSTFAIL_DIAGNOSTIC=PASS'
