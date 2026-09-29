param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13',
  [int]$Attempt = 1,
  [int]$NonTargetHoldSeconds = 45
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Write-Host "SC007_QUAL_ATTEMPT=$Attempt"
Write-Host "SC007_QUAL_MACHINE=$env:COMPUTERNAME"

if ([string]::IsNullOrWhiteSpace([string]$env:GITHUB_OUTPUT)) {
  throw 'GITHUB_OUTPUT is unavailable.'
}
function Set-JobOutput([string]$Name, [string]$Value) {
  "$Name=$Value" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
}

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Set-JobOutput -Name 'target_match' -Value 'false'
  Set-JobOutput -Name 'qualified' -Value 'false'
  Write-Host 'SC007_QUAL_TARGET_MATCH=False'
  $hold = [math]::Max(0, [math]::Min(90, $NonTargetHoldSeconds))
  if ($hold -gt 0) { Start-Sleep -Seconds $hold }
  exit 0
}

Set-JobOutput -Name 'target_match' -Value 'true'
Write-Host 'SC007_QUAL_TARGET_MATCH=True'

$workspace = [string]$env:GITHUB_WORKSPACE
$panelPath = Join-Path $workspace 'windows\control-panel.ps1'
$lifecyclePath = Join-Path $workspace 'windows\lifecycle-truth.ps1'
$cliPath = Join-Path $workspace 'src\runtime\single-conversation-cli.mjs'
foreach ($path in @($panelPath,$lifecyclePath,$cliPath)) {
  if (-not (Test-Path $path -PathType Leaf)) { throw "Missing qualification input: $path" }
}

$panel = Get-Content $panelPath -Raw -Encoding UTF8
$start = $panel.IndexOf('function Show-SingleConversationControlPanel')
$end = $panel.IndexOf('function Show-PlannerExecutorControlPanel', $start)
if ($start -lt 0 -or $end -le $start) {
  throw 'Forward single-conversation Control Center section is missing.'
}
$forward = $panel.Substring($start, $end - $start)
foreach ($required in @(
  'SOURCE OF TRUTH',
  'START ROBOT',
  'STOP ROBOT',
  'SINGLE_CONVERSATION_V1',
  'single-conversation-control.v1',
  'source_of_truth_url'
)) {
  if (-not $forward.Contains($required)) {
    throw "Forward Control Center missing contract token: $required"
  }
}
foreach ($forbidden in @(
  'Planner URL',
  'Executor URL',
  'LINK CHAT PLANNER',
  'LINK CHAT EXECUTOR',
  'MỞ PLANNER',
  'MỞ EXECUTOR'
)) {
  if ($forward.Contains($forbidden)) {
    throw "Forward Control Center still exposes legacy target control: $forbidden"
  }
}
Write-Host 'SC007_QUAL_FORWARD_UI_CONTRACT=True'

$tempRoot = Join-Path $env:RUNNER_TEMP ("sc007-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
try {
  $source = 'https://github.com/magasincoffee/magasin-supervisor/blob/main/SOURCE_OF_TRUTH.md'
  $control = [ordered]@{
    schema_version = 'single-conversation-control.v1'
    mode = 'SINGLE_CONVERSATION_V1'
    project_id = 'LIVE'
    source_of_truth_url = $source
    updated_at = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $controlPath = Join-Path $tempRoot 'single-conversation-control.json'
  [System.IO.File]::WriteAllText(
    $controlPath,
    (($control | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
    (New-Object System.Text.UTF8Encoding($false))
  )

  $raw = Get-Content $controlPath -Raw -Encoding UTF8
  if ($raw -match '(?i)planner|executor|chat_url|conversation_url') {
    throw 'SC-007 isolated control record persisted a legacy chat target.'
  }
  Write-Host 'SC007_QUAL_SOURCE_ONLY_CONTROL=True'

  $oldRoot = [string]$env:SUPERVISOR_STATE_ROOT
  $env:SUPERVISOR_STATE_ROOT = $tempRoot
  try {
    . $lifecyclePath
    $mode = Get-LifecycleRuntimeMode -Root $tempRoot
    if ([string]$mode -ne 'SINGLE_CONVERSATION_V1') {
      throw "Lifecycle did not select SINGLE_CONVERSATION_V1: $mode"
    }
    Write-Host 'SC007_QUAL_LIFECYCLE_MODE=True'

    $statePath = Join-Path $tempRoot 'single-conversation-state.json'
    & node $cliPath --state $statePath --source-of-truth $source --cdp-url 'http://127.0.0.1:9222'
    if ($LASTEXITCODE -ne 0) {
      throw "Single-conversation READY CLI failed with exit code $LASTEXITCODE"
    }
    if (-not (Test-Path $statePath -PathType Leaf)) {
      throw 'Single-conversation READY CLI did not create state.'
    }
    $state = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$state.mode -ne 'SINGLE_CONVERSATION_V1') {
      throw 'READY state did not select SINGLE_CONVERSATION_V1.'
    }
    if ([string]$state.source_of_truth.url -ne $source) {
      throw 'READY state did not preserve Source of Truth.'
    }
    $stateRaw = Get-Content $statePath -Raw -Encoding UTF8
    if ($stateRaw -match 'https://chatgpt\.com/(?:c|g|project)/') {
      throw 'READY state persisted a conversation URL.'
    }
    Write-Host 'SC007_QUAL_RUNTIME_READY_FROM_SOT=True'
  } finally {
    $env:SUPERVISOR_STATE_ROOT = $oldRoot
  }

  Write-Host 'SC007_QUAL_PRODUCTION_STATE_MUTATED=False'
  Write-Host 'SC007_QUAL_CHAT_URL_REQUIRED=False'
  Set-JobOutput -Name 'qualified' -Value 'true'
  Write-Host 'SC007_QUAL_QUALIFIED=True'
} finally {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
