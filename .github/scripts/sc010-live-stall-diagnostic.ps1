param(
  [int]$Attempt = 1,
  [string]$TargetComputer = 'DESKTOP-4K7IM13',
  [int]$NonTargetHoldSeconds = 75
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Set-Output([string]$Name, [string]$Value) {
  "$Name=$Value" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
}

Set-Output 'target_match' 'false'
Set-Output 'diagnosed' 'false'
Write-Host "SC010_ATTEMPT=$Attempt"
Write-Host "SC010_MACHINE=$env:COMPUTERNAME"

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Host 'SC010_TARGET_MATCH=False'
  Start-Sleep -Seconds $NonTargetHoldSeconds
  exit 0
}

Set-Output 'target_match' 'true'
Write-Host 'SC010_TARGET_MATCH=True'

. (Join-Path $PSScriptRoot '..\..\windows\state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
Write-Host "SC010_STATE_ROOT=$root"
Write-Host ("SC010_DIAG_UTC=" + [DateTimeOffset]::UtcNow.ToString('o'))

$controlPath = Join-Path $root 'single-conversation-control.json'
$statePath = Join-Path $root 'single-conversation-state.json'
Write-Host ("SC010_CONTROL_EXISTS=" + (Test-Path $controlPath))
Write-Host ("SC010_STATE_EXISTS=" + (Test-Path $statePath))

if (Test-Path $controlPath) {
  $control = Get-Content $controlPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host ("SC010_CONTROL_SCHEMA=" + [string]$control.schema_version)
  Write-Host ("SC010_CONTROL_MODE=" + [string]$control.mode)
}

if (Test-Path $statePath) {
  $state = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host ("SC010_STATE_SCHEMA=" + [string]$state.schema_version)
  Write-Host ("SC010_STATE_MODE=" + [string]$state.mode)
  Write-Host ("SC010_STATE_UPDATED_AT=" + [string]$state.updated_at)
  Write-Host ("SC010_AUTOMATION_STATUS=" + [string]$state.automation.status)
  Write-Host ("SC010_AUTOMATION_PHASE=" + [string]$state.automation.phase)
  Write-Host ("SC010_AUTOMATION_REASON=" + [string]$state.automation.reason)
  Write-Host ("SC010_AUTOMATION_UPDATED_AT=" + [string]$state.automation.updated_at)
  Write-Host ("SC010_CONVERSATION_GENERATION=" + [string]$state.conversation.generation)
  Write-Host ("SC010_CONVERSATION_STATUS=" + [string]$state.conversation.status)
  Write-Host ("SC010_CONVERSATION_CREATED_AT=" + [string]$state.conversation.created_at)
  Write-Host ("SC010_CONVERSATION_LAST_SEEN_AT=" + [string]$state.conversation.last_seen_at)
  Write-Host ("SC010_SOT_SYNC_STATUS=" + [string]$state.source_of_truth.sync_status)
  Write-Host ("SC010_SOT_LAST_VERIFIED_AT=" + [string]$state.source_of_truth.last_verified_at)
  Write-Host ("SC010_OUTBOUND_STATE=" + [string]$state.outbound.state)
  Write-Host ("SC010_OUTBOUND_KIND=" + [string]$state.outbound.kind)
  Write-Host ("SC010_OUTBOUND_MESSAGE_ID=" + [string]$state.outbound.message_id)
  Write-Host ("SC010_OUTBOUND_CMD_ID_PRESENT=" + (-not [string]::IsNullOrWhiteSpace([string]$state.outbound.cmd_id)))
  Write-Host ("SC010_OUTBOUND_RETRY_COUNT=" + [string]$state.outbound.retry_count)
  Write-Host ("SC010_OUTBOUND_PREPARED_AT=" + [string]$state.outbound.prepared_at)
  Write-Host ("SC010_OUTBOUND_ENQUEUED_AT=" + [string]$state.outbound.enqueued_at)
  Write-Host ("SC010_OUTBOUND_DELIVERED_AT=" + [string]$state.outbound.delivered_at)
  Write-Host ("SC010_OUTBOUND_RESPONSE_RUNNING_AT=" + [string]$state.outbound.response_running_at)
  Write-Host ("SC010_OUTBOUND_RESPONSE_COMPLETE_AT=" + [string]$state.outbound.response_complete_at)
  Write-Host ("SC010_OUTBOUND_VERIFIED_AT=" + [string]$state.outbound.verified_at)
  Write-Host ("SC010_OUTBOUND_LAST_ERROR_CODE=" + [string]$state.outbound.last_error_code)
}

$wrappers = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*run-supervisor.ps1*' })
Write-Host ("SC010_WRAPPER_COUNT=" + $wrappers.Count)
foreach ($p in $wrappers) {
  Write-Host ("SC010_WRAPPER_PID=" + $p.ProcessId + ";PARENT=" + $p.ParentProcessId)
}

$singleNodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*single-conversation-cli.mjs*' })
Write-Host ("SC010_SINGLE_NODE_COUNT=" + $singleNodes.Count)
foreach ($p in $singleNodes) {
  Write-Host ("SC010_SINGLE_NODE_PID=" + $p.ProcessId + ";PARENT=" + $p.ParentProcessId + ";CREATED=" + $p.CreationDate)
}

$profile = Join-Path $root 'browser_profile'
$chromes = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" })
Write-Host ("SC010_DEDICATED_CHROME_COUNT=" + $chromes.Count)
$ports = @()
foreach ($p in $chromes) {
  if ($p.CommandLine -match '--remote-debugging-port=(\d+)') {
    $ports += [int]$Matches[1]
  }
}
$ports = @($ports | Select-Object -Unique)
Write-Host ("SC010_CDP_PORTS=" + (($ports | ForEach-Object { [string]$_ }) -join ','))
foreach ($port in $ports) {
  try {
    $tabs = @(Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 3)
    $chatTabs = @($tabs | Where-Object { [string]$_.url -match '^https://chatgpt\.com/' })
    Write-Host ("SC010_CDP_TAB_COUNT=" + $tabs.Count)
    Write-Host ("SC010_CDP_CHATGPT_TAB_COUNT=" + $chatTabs.Count)
    foreach ($t in $chatTabs) {
      $u = [Uri]([string]$t.url)
      $shape = if ($u.AbsolutePath -match '^/c/') { '/c/<conversation>' } elseif ($u.AbsolutePath -eq '/') { '/' } else { $u.AbsolutePath }
      $title = ([string]$t.title).Replace([Environment]::NewLine,' ')
      Write-Host ("SC010_CHAT_TAB_SHAPE=" + $shape + ";TITLE=" + $title)
    }
  } catch {
    Write-Host ("SC010_CDP_READ_ERROR=" + $_.Exception.GetType().Name)
  }
}

$installedRoot = Join-Path $root 'runtime'
foreach ($rel in @(
  'windows\run-supervisor.ps1',
  'src\runtime\single-conversation-cli.mjs',
  'src\runtime\single-conversation-loop.mjs',
  'src\runtime\single-conversation-transaction.mjs'
)) {
  $installed = Join-Path $installedRoot $rel
  $checkout = Join-Path $env:GITHUB_WORKSPACE $rel
  if ((Test-Path $installed) -and (Test-Path $checkout)) {
    $a = (Get-FileHash -Algorithm SHA256 $installed).Hash
    $b = (Get-FileHash -Algorithm SHA256 $checkout).Hash
    Write-Host ("SC010_RUNTIME_FILE_MATCH_" + ($rel -replace '[^A-Za-z0-9]','_') + "=" + ($a -eq $b))
  } else {
    Write-Host ("SC010_RUNTIME_FILE_PRESENT_" + ($rel -replace '[^A-Za-z0-9]','_') + "=False")
  }
}

Set-Output 'diagnosed' 'true'
Write-Host 'SC010_DIAGNOSTIC=PASS'
