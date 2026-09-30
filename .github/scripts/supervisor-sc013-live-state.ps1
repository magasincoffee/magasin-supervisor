param([Parameter(Mandatory=$true)][string]$TargetComputer,[int]$NonTargetHoldSeconds=90)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
Write-Host "SC013_STATE_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC013_STATE_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'SC013_STATE_TARGET_MATCH=True'
. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$statePath=Join-Path $root 'single-conversation-state.json'
$truth=Get-LifecycleProcessTruth -Root $root
Write-Host "SC013_STATE_ROOT=$root"
Write-Host "SC013_STATE_WRAPPER=$([bool]$truth.wrapper_alive)"
Write-Host "SC013_STATE_RUNTIME=$([bool]$truth.runtime_alive)"
Write-Host "SC013_STATE_CHROME=$([bool]$truth.chrome_alive)"
Write-Host "SC013_STATE_CDP=$([bool]$truth.cdp_healthy)"
if(Test-Path $statePath -PathType Leaf){
  $s=Get-Content $statePath -Raw -Encoding UTF8|ConvertFrom-Json
  Write-Host "SC013_STATE_GENERATION=$([int]$s.conversation.generation)"
  Write-Host "SC013_STATE_CONVERSATION=$([string]$s.conversation.status)"
  Write-Host "SC013_STATE_RUNTIME_ID=$([string]$s.conversation.runtime_id)"
  Write-Host "SC013_STATE_AUTOMATION=$([string]$s.automation.status)"
  Write-Host "SC013_STATE_PHASE=$([string]$s.automation.phase)"
  Write-Host "SC013_STATE_REASON=$([string]$s.automation.reason)"
  Write-Host "SC013_STATE_OUTBOUND=$([string]$s.outbound.state)"
  Write-Host "SC013_STATE_KIND=$([string]$s.outbound.kind)"
  Write-Host "SC013_STATE_MESSAGE_ID=$([string]$s.outbound.message_id)"
  Write-Host "SC013_STATE_RETRY_COUNT=$([int]$s.outbound.retry_count)"
  Write-Host "SC013_STATE_LAST_ERROR=$([string]$s.outbound.last_error_code)"
  Write-Host "SC013_STATE_DELIVERED_AT=$([string]$s.outbound.delivered_at)"
  Write-Host "SC013_STATE_RESPONSE_COMPLETE_AT=$([string]$s.outbound.response_complete_at)"
}
$chrome=Get-LifecycleRobotChrome -Root $root
if($chrome -and $chrome.CommandLine -match '--remote-debugging-port=(\d+)'){
  $port=[int]$Matches[1]
  Write-Host "SC013_STATE_CDP_PORT=$port"
  try{
    $pages=Invoke-RestMethod -Uri "http://127.0.0.1:$port/json" -TimeoutSec 3
    $chat=@($pages|Where-Object{[string]$_.url -like 'https://chatgpt.com/*'})
    Write-Host "SC013_STATE_CHAT_PAGE_COUNT=$($chat.Count)"
    foreach($p in $chat){
      try{
        $u=[Uri]([string]$p.url)
        Write-Host "SC013_STATE_CHAT_PATH=$($u.AbsolutePath)"
      }catch{}
    }
  }catch{
    Write-Host 'SC013_STATE_CDP_JSON_FAILED=True'
  }
}
