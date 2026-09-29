param(
  [Parameter(Mandatory=$true)]
  [string]$TargetComputer
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Write-Host "SC011_DIAG_MACHINE=$env:COMPUTERNAME"
if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Host 'SC011_DIAG_TARGET_MATCH=False'
  exit 0
}
Write-Host 'SC011_DIAG_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$control = Join-Path $root 'single-conversation-control.json'
$statePath = Join-Path $root 'single-conversation-state.json'

$wrappers = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*run-supervisor.ps1*' -and $_.CommandLine -like "*$root*" })
$nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*single-conversation-cli.mjs*' })
$chrome = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$(Join-Path $root 'browser_profile')*" })

Write-Host "SC011_DIAG_WRAPPER_COUNT=$($wrappers.Count)"
Write-Host "SC011_DIAG_NODE_COUNT=$($nodes.Count)"
Write-Host "SC011_DIAG_CHROME_COUNT=$($chrome.Count)"

foreach ($p in $nodes) {
  $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if ($proc) {
    Write-Host "SC011_DIAG_NODE_PID=$($p.ProcessId)"
    Write-Host "SC011_DIAG_NODE_STARTED_UTC=$($proc.StartTime.ToUniversalTime().ToString('o'))"
  }
}

if (Test-Path $control) {
  $c = Get-Content $control -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host "SC011_DIAG_CONTROL_MODE=$([string]$c.mode)"
  Write-Host "SC011_DIAG_CONTROL_PRESENT=True"
} else {
  Write-Host 'SC011_DIAG_CONTROL_PRESENT=False'
}

if (Test-Path $statePath) {
  $s = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host 'SC011_DIAG_STATE_PRESENT=True'
  Write-Host "SC011_DIAG_GENERATION=$([int]$s.conversation.generation)"
  Write-Host "SC011_DIAG_CONVERSATION_STATUS=$([string]$s.conversation.status)"
  Write-Host "SC011_DIAG_AUTOMATION_STATUS=$([string]$s.automation.status)"
  Write-Host "SC011_DIAG_AUTOMATION_PHASE=$([string]$s.automation.phase)"
  Write-Host "SC011_DIAG_OUTBOUND_STATE=$([string]$s.outbound.state)"
  Write-Host "SC011_DIAG_OUTBOUND_KIND=$([string]$s.outbound.kind)"
  Write-Host "SC011_DIAG_OUTBOUND_RETRY_COUNT=$([int]$s.outbound.retry_count)"
  Write-Host "SC011_DIAG_STATE_UPDATED_AT=$([string]$s.automation.updated_at)"
} else {
  Write-Host 'SC011_DIAG_STATE_PRESENT=False'
}

$port = $null
foreach ($p in $chrome) {
  if ($p.CommandLine -match '--remote-debugging-port=(\d+)') {
    $port = [int]$Matches[1]
    break
  }
}
if ($null -ne $port) {
  Write-Host "SC011_DIAG_CDP_PORT=$port"
  try {
    $pages = @(Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 3 |
      Where-Object { [string]$_.type -eq 'page' -and [string]$_.url -like 'https://chatgpt.com/*' })
    Write-Host "SC011_DIAG_CHATGPT_PAGE_COUNT=$($pages.Count)"
  } catch {
    Write-Host 'SC011_DIAG_CHATGPT_PAGE_COUNT=-1'
  }
} else {
  Write-Host 'SC011_DIAG_CDP_PORT=NONE'
}

Write-Host 'SC011_DIAG_PRODUCTION_MUTATION=False'
