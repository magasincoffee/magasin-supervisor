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

$seen = New-Object System.Collections.Generic.HashSet[string]
$cycleIds = New-Object System.Collections.Generic.List[string]
$cycleGenerations = New-Object System.Collections.Generic.List[int]
$deadline = [DateTimeOffset]::UtcNow.AddMinutes(22)
$nodeObserved = $false
$maxNextWorkAge = [TimeSpan]::Zero
$recoveryObserved = $false

while ([DateTimeOffset]::UtcNow -lt $deadline -and $cycleIds.Count -lt 5) {
  $nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'single-conversation-cli\.mjs' })
  if ($nodes.Count -gt 0) { $nodeObserved = $true }

  if (Test-Path $statePath) {
    try {
      $state = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
      $phase = [string]$state.automation.phase
      $updatedAt = [DateTimeOffset]::Parse([string]$state.updated_at)
      $age = [DateTimeOffset]::UtcNow - $updatedAt
      if ($phase -eq 'NEXT_WORK' -and $age -gt $maxNextWorkAge) { $maxNextWorkAge = $age }
      if ($phase -eq 'NEXT_WORK' -and $age.TotalSeconds -gt 45) {
        Write-Host "SC010_LIVE_NEXT_WORK_STALL_SECONDS=$([int]$age.TotalSeconds)"
        throw 'NEXT_WORK remained stale for more than 45 seconds.'
      }
      if ($phase -eq 'RECOVERY_REQUESTED') { $recoveryObserved = $true }

      $messageId = [string]$state.outbound.message_id
      $verifiedAtRaw = [string]$state.outbound.verified_at
      if (
        [string]$state.outbound.state -eq 'VERIFIED' -and
        -not [string]::IsNullOrWhiteSpace($messageId) -and
        $messageId -ne $baselineMessageId -and
        -not [string]::IsNullOrWhiteSpace($verifiedAtRaw)
      ) {
        $verifiedAt = [DateTimeOffset]::Parse($verifiedAtRaw)
        if ($verifiedAt -gt $qualificationStart -and $seen.Add($messageId)) {
          if ([string]$state.source_of_truth.sync_status -ne 'VERIFIED') {
            throw "Cycle $messageId reached VERIFIED without Source of Truth verification."
          }
          $cycleIds.Add($messageId)
          $cycleGenerations.Add([int]$state.conversation.generation)
          $n = $cycleIds.Count
          Write-Host "SC010_LIVE_CYCLE_$($n)_VERIFIED=True"
          Write-Host "SC010_LIVE_CYCLE_$($n)_MESSAGE_ID=$messageId"
          Write-Host "SC010_LIVE_CYCLE_$($n)_GENERATION=$($state.conversation.generation)"
          Write-Host "SC010_LIVE_CYCLE_$($n)_RETRY_COUNT=$($state.outbound.retry_count)"
        }
      }
    } catch {
      if ($_.Exception.Message -like 'NEXT_WORK remained stale*' -or $_.Exception.Message -like 'Cycle *') { throw }
    }
  }
  Start-Sleep -Milliseconds 250
}

Write-Host "SC010_LIVE_SINGLE_NODE_OBSERVED=$nodeObserved"
Write-Host "SC010_LIVE_VERIFIED_CYCLE_COUNT=$($cycleIds.Count)"
Write-Host "SC010_LIVE_MAX_NEXT_WORK_AGE_SECONDS=$([int]$maxNextWorkAge.TotalSeconds)"
Write-Host "SC010_LIVE_RECOVERY_OBSERVED=$recoveryObserved"
if (-not $nodeObserved) { throw 'single-conversation runtime was never observed.' }
if ($cycleIds.Count -lt 5) { throw "Only $($cycleIds.Count) verified work cycles completed before timeout." }

$profile = Join-Path $root 'browser_profile'
$browser = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and $_.CommandLine -like "*$profile*" -and $_.CommandLine -match '--remote-debugging-port=(\d+)'
  } | Select-Object -First 1
if (-not $browser -or $browser.CommandLine -notmatch '--remote-debugging-port=(\d+)') {
  throw 'Dedicated Supervisor Chrome CDP port was not found.'
}
$cdpUrl = "http://127.0.0.1:$([int]$Matches[1])"
$idsPath = Join-Path $env:RUNNER_TEMP ("sc010-cycle-ids-" + [Guid]::NewGuid().ToString('N') + ".json")
[System.IO.File]::WriteAllText($idsPath, ($cycleIds | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))

& node "$env:GITHUB_WORKSPACE\.github\scripts\supervisor-sc010-production-verify.mjs" $cdpUrl $idsPath
$verifyExit = $LASTEXITCODE
Remove-Item $idsPath -Force -ErrorAction SilentlyContinue
if ($verifyExit -ne 0) { throw "Production DOM verification failed with exit code $verifyExit." }

$final = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host "SC010_LIVE_FINAL_AUTOMATION_STATUS=$($final.automation.status)"
Write-Host "SC010_LIVE_FINAL_AUTOMATION_PHASE=$($final.automation.phase)"
Write-Host "SC010_LIVE_FINAL_CONVERSATION_STATUS=$($final.conversation.status)"
Write-Host "SC010_LIVE_FINAL_GENERATION=$($final.conversation.generation)"
Write-Host 'SC010_LIVE_FIVE_SEQUENTIAL_CYCLES=True'
Write-Host 'SC010_LIVE_NO_NEXT_WORK_STALL=True'
Write-Host 'SC010_LIVE_PRODUCTION_QUALIFICATION=PASS'
Set-Output 'qualified' 'true'
