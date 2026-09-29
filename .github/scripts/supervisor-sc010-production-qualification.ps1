param(
  [int]$Attempt = 1,
  [string]$TargetComputer = 'DESKTOP-4K7IM13',
  [int]$NonTargetHoldSeconds = 90
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Set-Output([string]$Name, [string]$Value) {
  "$Name=$Value" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
}

Set-Output 'target_match' 'false'
Set-Output 'qualified' 'false'
Write-Host "SC010_QUAL_ATTEMPT=$Attempt"
Write-Host "SC010_QUAL_MACHINE=$env:COMPUTERNAME"

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Host 'SC010_QUAL_TARGET_MATCH=False'
  Start-Sleep -Seconds $NonTargetHoldSeconds
  exit 0
}

Set-Output 'target_match' 'true'
Write-Host 'SC010_QUAL_TARGET_MATCH=True'

. "$env:GITHUB_WORKSPACE\windows\state-root.ps1"
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$controlPath = Join-Path $root 'single-conversation-control.json'
$statePath = Join-Path $root 'single-conversation-state.json'
if (-not (Test-Path $controlPath)) { throw 'Production single-conversation control record is missing.' }

$controlRawBefore = Get-Content $controlPath -Raw -Encoding UTF8
$control = $controlRawBefore | ConvertFrom-Json
if ([string]$control.schema_version -ne 'single-conversation-control.v1') { throw 'Wrong production control schema.' }
if ([string]$control.mode -ne 'SINGLE_CONVERSATION_V1') { throw 'Production mode is not SINGLE_CONVERSATION_V1.' }
$sourceOfTruthUrl = [string]$control.source_of_truth_url
if ([string]::IsNullOrWhiteSpace($sourceOfTruthUrl)) { throw 'Production Source of Truth is empty.' }
Write-Host 'SC010_LIVE_CONTROL_VALID=True'

$qualificationStart = [DateTimeOffset]::UtcNow
$baselineMessageId = ''
if (Test-Path $statePath) {
  try {
    $baseline = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $baselineMessageId = [string]$baseline.outbound.message_id
  } catch {}
}

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$env:GITHUB_WORKSPACE\windows\install-supervisor.ps1" -SourceRoot "$env:GITHUB_WORKSPACE"
if ($LASTEXITCODE -ne 0) { throw "Candidate install failed with exit code $LASTEXITCODE." }
Write-Host 'SC010_LIVE_CANDIDATE_INSTALLED=True'

$installedRoot = Join-Path $root 'runtime'
$installedStart = Join-Path $installedRoot 'windows\start-supervisor.ps1'
foreach ($rel in @(
  'src\runtime\single-conversation-cli.mjs',
  'src\runtime\single-conversation-rollover.mjs'
)) {
  $source = Join-Path $env:GITHUB_WORKSPACE $rel
  $installed = Join-Path $installedRoot $rel
  if (-not (Test-Path $installed)) { throw "Installed candidate missing: $rel" }
  if ((Get-FileHash $source -Algorithm SHA256).Hash -ne (Get-FileHash $installed -Algorithm SHA256).Hash) {
    throw "Installed candidate mismatch: $rel"
  }
}
Write-Host 'SC010_LIVE_INSTALLED_RUNTIME_MATCH=True'

$controlRawAfterInstall = Get-Content $controlPath -Raw -Encoding UTF8
if ($controlRawBefore -ne $controlRawAfterInstall) { throw 'Candidate install changed production control record.' }
Write-Host 'SC010_LIVE_CONTROL_PRESERVED=True'

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installedStart -Hidden
if ($LASTEXITCODE -ne 0) { throw "Production START failed with exit code $LASTEXITCODE." }
Write-Host 'SC010_LIVE_OWNER_START_INVOKED=True'

$nodeObserved = $false
$candidateStateObserved = $false
$cdpPort = $null
$startupDeadline = [DateTimeOffset]::UtcNow.AddSeconds(120)
$profile = Join-Path $root 'browser_profile'

while ([DateTimeOffset]::UtcNow -lt $startupDeadline) {
  $nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'single-conversation-cli\.mjs' })
  if ($nodes.Count -gt 0) { $nodeObserved = $true }

  if (Test-Path $statePath) {
    try {
      $state = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
      $updatedAt = [DateTimeOffset]::Parse([string]$state.updated_at)
      if ($updatedAt -gt $qualificationStart) { $candidateStateObserved = $true }
    } catch {}
  }

  $browser = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and $_.CommandLine -like "*$profile*" -and $_.CommandLine -match '--remote-debugging-port=(\d+)'
    } | Select-Object -First 1
  if ($browser -and $browser.CommandLine -match '--remote-debugging-port=(\d+)') {
    $cdpPort = [int]$Matches[1]
  }

  if ($nodeObserved -and $candidateStateObserved -and $cdpPort) { break }
  Start-Sleep -Milliseconds 500
}

Write-Host "SC010_LIVE_SINGLE_NODE_OBSERVED=$nodeObserved"
Write-Host "SC010_LIVE_CANDIDATE_STATE_OBSERVED=$candidateStateObserved"
if (-not $nodeObserved) { throw 'single-conversation runtime was never observed after candidate START.' }
if (-not $candidateStateObserved) { throw 'candidate runtime never updated production state after START.' }
if (-not $cdpPort) { throw 'Dedicated Supervisor Chrome CDP port was not found.' }

$cdpUrl = "http://127.0.0.1:$cdpPort"
$startedAtIso = $qualificationStart.ToString('o')
& node "$env:GITHUB_WORKSPACE\.github\scripts\supervisor-sc010-production-verify.mjs" $cdpUrl $statePath $startedAtIso 1320000
$verifyExit = $LASTEXITCODE
if ($verifyExit -ne 0) { throw "Production continuity verification failed with exit code $verifyExit." }

$final = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host "SC010_LIVE_FINAL_AUTOMATION_STATUS=$($final.automation.status)"
Write-Host "SC010_LIVE_FINAL_AUTOMATION_PHASE=$($final.automation.phase)"
Write-Host "SC010_LIVE_FINAL_CONVERSATION_STATUS=$($final.conversation.status)"
Write-Host "SC010_LIVE_FINAL_GENERATION=$($final.conversation.generation)"
Write-Host 'SC010_LIVE_FIVE_SEQUENTIAL_CYCLES=True'
Write-Host 'SC010_LIVE_NO_NEXT_WORK_STALL=True'
Write-Host 'SC010_LIVE_PRODUCTION_QUALIFICATION=PASS'
Set-Output 'qualified' 'true'
