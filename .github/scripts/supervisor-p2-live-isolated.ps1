$ErrorActionPreference = "Stop"

. "$env:GITHUB_WORKSPACE\windows\state-root.ps1"

function Test-ReadableLeaf([string]$Path) {
  try {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf -ErrorAction Stop)) { return $false }
    $stream = [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::ReadWrite
    )
    try { return $true } finally { $stream.Dispose() }
  } catch {
    return $false
  }
}
function Read-JsonSafe([string]$Path) {
  try {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf -ErrorAction Stop)) { return $null }
    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return $raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return $null
  }
}
function Get-OptionalPropertyValue($Object,[string]$Name) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($property) { return $property.Value }
  return $null
}

function Test-CanonicalSupervisorRootCandidate([string]$Candidate) {
  try {
    if ([string]::IsNullOrWhiteSpace($Candidate)) { return $false }
    $full = [System.IO.Path]::GetFullPath($Candidate)
    $lanes = Read-JsonSafe (Join-Path $full "lanes.json")
    $registry = Read-JsonSafe (Join-Path $full "lane-registry.json")
    $startScript = Join-Path $full "runtime\\windows\\start-supervisor.ps1"
    if (-not $lanes -or -not $lanes.lanes) { return $false }
    if (-not $registry -or -not $registry.lanes) { return $false }
    if (-not (Test-ReadableLeaf $startScript)) { return $false }
    return $true
  } catch {
    return $false
  }
}
function Resolve-CanonicalSupervisorRoot {
  $processCandidates = New-Object System.Collections.Generic.List[string]
  foreach ($proc in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $cmd = [string]$proc.CommandLine
    if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
    foreach ($pattern in @(
      '([A-Za-z]:\\[^"]*?\\MAGASIN\\BusinessOS\\supervisor)\\runtime\\windows\\run-supervisor\.ps1',
      '([A-Za-z]:\\[^"]*?\\MAGASIN\\BusinessOS\\supervisor)\\browser_profile'
    )) {
      $m = [regex]::Match($cmd,$pattern,[System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
      if ($m.Success) { $processCandidates.Add([string]$m.Groups[1].Value) }
    }
  }
  $processRoots = @($processCandidates |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    ForEach-Object { try { [System.IO.Path]::GetFullPath($_) } catch { $null } } |
    Where-Object { $_ -and (Test-CanonicalSupervisorRootCandidate $_) } |
    Select-Object -Unique)
  Write-Host "LIVE_P2_PROCESS_ROOT_COUNT=$($processRoots.Count)"
  if ($processRoots.Count -eq 1) { return [string]$processRoots[0] }
  if ($processRoots.Count -gt 1) { throw "P2_LIVE_PROCESS_ROOT_AMBIGUOUS" }

  $fallback = Get-SupervisorStateRoot -Compatibility "legacy-preserve"
  if (Test-CanonicalSupervisorRootCandidate $fallback) {
    Write-Host "LIVE_P2_ROOT_FALLBACK=RUNNER_PROFILE"
    return [System.IO.Path]::GetFullPath($fallback)
  }

  $profileCandidates = @(
    Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalPath -and -not $_.Special } |
      ForEach-Object {
        try {
          $candidate = Join-Path ([string]$_.LocalPath) "AppData\\Local\\MAGASIN\\BusinessOS\\supervisor"
          if (Test-CanonicalSupervisorRootCandidate $candidate) {
            [System.IO.Path]::GetFullPath($candidate)
          }
        } catch {
          $null
        }
      } |
      Where-Object { $_ } |
      Select-Object -Unique
  )
  Write-Host "LIVE_P2_PROFILE_ROOT_COUNT=$($profileCandidates.Count)"
  if ($profileCandidates.Count -eq 1) {
    Write-Host "LIVE_P2_ROOT_FALLBACK=WINDOWS_PROFILE_INVENTORY"
    return [System.IO.Path]::GetFullPath([string]$profileCandidates[0])
  }
  if ($profileCandidates.Count -gt 1) { throw "P2_LIVE_PROFILE_ROOT_AMBIGUOUS" }
  throw "P2_LIVE_STATE_ROOT_MISSING"
}
function Stop-ProcessTree([int]$ProcessId) {
  if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
  & taskkill.exe /PID $ProcessId /T /F | Out-Null
  for ($i=0; $i -lt 20; $i++) {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
      $global:LASTEXITCODE = 0
      return
    }
    Start-Sleep -Milliseconds 250
  }
  throw "P2_LIVE_PROCESS_TREE_STILL_ALIVE"
}
function Get-FreeCdpPort {
  foreach ($port in 9222..9232) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) { return $port }
  }
  throw "P2_LIVE_NO_FREE_CDP_PORT"
}
function Test-Cdp([int]$Port) {
  try {
    $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
    return [bool]$v.webSocketDebuggerUrl
  } catch { return $false }
}
function Write-JsonFile([string]$Path,$Value) {
  $dir = Split-Path $Path -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $Value | ConvertTo-Json -Depth 20 | Set-Content -Path $Path -Encoding UTF8
}

$mutationPacingMs = 5000
$parsedPacing = 0
if ([int]::TryParse([string]$env:P2_LIVE_MUTATION_PACING_MS,[ref]$parsedPacing)) {
  $mutationPacingMs = [Math]::Max(5000,$parsedPacing)
}
$cooldownMinutes = 5
$parsedCooldown = 0
if ([int]::TryParse([string]$env:P2_LIVE_RATE_LIMIT_COOLDOWN_MINUTES,[ref]$parsedCooldown)) {
  $cooldownMinutes = [Math]::Max(5,$parsedCooldown)
}
$cooldownFile = Join-Path $env:USERPROFILE ".magasin-supervisor\p2-live-rate-limit-cooldown.json"
$cooldownState = Read-JsonSafe $cooldownFile
if ($cooldownState -and $cooldownState.until_utc) {
  $until = [DateTimeOffset]::MinValue
  if ([DateTimeOffset]::TryParse([string]$cooldownState.until_utc,[ref]$until)) {
    if ([DateTimeOffset]::UtcNow -lt $until) {
      Write-Host "LIVE_P2_RATE_LIMIT_COOLDOWN_ACTIVE=True"
      throw "P2_LIVE_RATE_LIMIT_COOLDOWN_ACTIVE"
    }
  }
  Remove-Item -LiteralPath $cooldownFile -Force -ErrorAction SilentlyContinue
}

function Set-RateLimitCooldown {
  $until = [DateTimeOffset]::UtcNow.AddMinutes($cooldownMinutes).ToString("o")
  Write-JsonFile $cooldownFile ([pscustomobject]@{
    schema_version = "p2-rate-limit-cooldown.v1"
    until_utc = $until
  })
  Write-Host "LIVE_P2_RATE_LIMIT_DETECTED=True"
  Write-Host "LIVE_P2_RATE_LIMIT_COOLDOWN_SET=True"
}

$root = Resolve-CanonicalSupervisorRoot
$configFile = Join-Path $root "lanes.json"
$registryFile = Join-Path $root "lane-registry.json"
$stopFile = Join-Path $root "STOP"
$autostartDisabled = Join-Path $root "AUTOSTART_DISABLED"
$profile = Join-Path $root "browser_profile"
$startScript = Join-Path $root "runtime\windows\start-supervisor.ps1"

if ((Test-Path $stopFile) -or (Test-Path $autostartDisabled)) {
  throw "P2_LIVE_OWNER_STOP_ACTIVE"
}
if (-not (Test-Path $startScript)) { throw "P2_LIVE_INSTALLED_RUNTIME_MISSING" }

$productionConfigHashBefore = (Get-FileHash $configFile -Algorithm SHA256).Hash
$productionRegistryHashBefore = (Get-FileHash $registryFile -Algorithm SHA256).Hash
Write-Host "LIVE_P2_PRODUCTION_STATE_HASHED=True"
Write-Host "LIVE_P2_OWNER_STOP=False"

$existingChrome = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  Select-Object -First 1
$chromeExe = ""
if ($null -ne $existingChrome) {
  $executablePathProperty = $existingChrome.PSObject.Properties["ExecutablePath"]
  if ($executablePathProperty -and -not [string]::IsNullOrWhiteSpace([string]$executablePathProperty.Value)) {
    $chromeExe = [string]$executablePathProperty.Value
  }
}
if ([string]::IsNullOrWhiteSpace($chromeExe) -or -not (Test-Path $chromeExe)) {
  $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  $chromeExe = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$programFilesX86\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $chromeExe) { throw "P2_LIVE_CHROME_NOT_FOUND" }

$tempBase = Join-Path $env:RUNNER_TEMP "magasin-p2-live-isolated"
$tempRoot = Join-Path $tempBase "MAGASIN\BusinessOS\supervisor"
$fixtureFile = Join-Path $env:RUNNER_TEMP "magasin-p2-live-fixture.json"
$fixtureCacheFile = Join-Path $env:USERPROFILE ".magasin-supervisor\p2-live-fixture-cache.json"
$nodeOut = Join-Path $env:RUNNER_TEMP "magasin-p2-live-runtime.out.log"
$nodeErr = Join-Path $env:RUNNER_TEMP "magasin-p2-live-runtime.err.log"
Remove-Item $tempBase -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $fixtureFile,$nodeOut,$nodeErr -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

$mutex = $null
$ownsMutex = $false
$testNode = $null
$restoreError = $null
$acceptancePassed = $false
$savedLocalAppData = [string]$env:LOCALAPPDATA

try {
  $wrappers = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like "*run-supervisor.ps1*" -and
      $_.CommandLine -like "*$root*"
    })
  foreach ($wrapper in $wrappers) { Stop-ProcessTree -ProcessId ([int]$wrapper.ProcessId) }

  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*three-lane-cli.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 750

  $mutex = New-Object System.Threading.Mutex($false,'Local\MAGASIN_BUSINESS_OS_SUPERVISOR')
  try {
    $ownsMutex = $mutex.WaitOne(5000,$false)
  } catch [System.Threading.AbandonedMutexException] {
    $ownsMutex = $true
  }
  if (-not $ownsMutex) { throw "P2_LIVE_SINGLETON_MUTEX_NOT_ACQUIRED" }

  $cdpPort = Get-FreeCdpPort
  Start-Process -FilePath $chromeExe -WindowStyle Minimized -ArgumentList @(
    '--remote-debugging-address=127.0.0.1',
    "--remote-debugging-port=$cdpPort",
    ('--user-data-dir="' + $profile + '"'),
    '--no-first-run',
    '--no-default-browser-check',
    '--start-minimized',
    'https://chatgpt.com/'
  ) | Out-Null
  for ($i=0; $i -lt 45 -and -not (Test-Cdp $cdpPort); $i++) { Start-Sleep -Seconds 1 }
  if (-not (Test-Cdp $cdpPort)) { throw "P2_LIVE_CDP_NOT_READY" }

  $env:P2_CDP_URL = "http://127.0.0.1:$cdpPort"
  $env:P2_FIXTURE_FILE = $fixtureFile
  $env:P2_FIXTURE_CACHE_FILE = $fixtureCacheFile
  & node "$env:GITHUB_WORKSPACE\.github\scripts\supervisor-p2-live-brain-fixture.mjs"
  if ($LASTEXITCODE -eq 75) {
    Set-RateLimitCooldown
    throw "P2_LIVE_RATE_LIMITED_NON_SEMANTIC"
  }
  if ($LASTEXITCODE -ne 0) { throw "P2_LIVE_BRAIN_FIXTURE_FAILED" }

  $fixture = Read-JsonSafe $fixtureFile
  if (-not $fixture -or [string]$fixture.task_id -ne "SUP-SELFHEAL-P2-LIVE-FIXTURE") {
    throw "P2_LIVE_FIXTURE_IDENTITY_INVALID"
  }

  $now = [DateTimeOffset]::UtcNow.ToString("o")
  $config = [pscustomobject]@{
    schema_version = "three-lane-config.v1"
    mode = "THREE_LANE_V1"
    lanes = @(
      [pscustomobject]@{
        lane_id = "lane-1"; project_name = "P2 Live Acceptance Fixture"
        brain_url = [string]$fixture.brain_url; brain_url_revision = 1
        work_url = ""; work_url_revision = 1; work_url_saved_at = $now; work_mode = "AUTO"
        work_state_reset_revision = 0; relay_retry_rearm_revision = 0
        relay_retry_rearm_requested_at = $null; enabled = $true
      },
      [pscustomobject]@{
        lane_id = "lane-2"; project_name = "Unused"
        brain_url = ""; brain_url_revision = 0
        work_url = ""; work_url_revision = 0; work_url_saved_at = $null; work_mode = "AUTO"
        work_state_reset_revision = 0; relay_retry_rearm_revision = 0
        relay_retry_rearm_requested_at = $null; enabled = $false
      },
      [pscustomobject]@{
        lane_id = "lane-3"; project_name = "Unused"
        brain_url = ""; brain_url_revision = 0
        work_url = ""; work_url_revision = 0; work_url_saved_at = $null; work_mode = "AUTO"
        work_state_reset_revision = 0; relay_retry_rearm_revision = 0
        relay_retry_rearm_requested_at = $null; enabled = $false
      }
    )
  }
  Write-JsonFile (Join-Path $tempRoot "lanes.json") $config
  Write-Host "LIVE_P2_INITIAL_WORK_TARGET_ABSENT=True"

  $env:LOCALAPPDATA = $tempBase
  $runtimeCli = Join-Path $env:GITHUB_WORKSPACE "src\runtime\three-lane-cli.mjs"
  $testNode = Start-Process -FilePath "node.exe" -ArgumentList @(
    $runtimeCli,"--cdp-url",$env:P2_CDP_URL,"--poll-ms","5000","--execute"
  ) -PassThru -RedirectStandardOutput $nodeOut -RedirectStandardError $nodeErr

  $liveReached = $false
  $rateLimitDetected = $false
  for ($i=0; $i -lt 150; $i++) {
    Start-Sleep -Seconds 1
    $safeLog = Join-Path $tempRoot "supervisor.log"
    if (Test-Path $safeLog) {
      foreach ($line in @(Get-Content -LiteralPath $safeLog -Tail 80 -Encoding UTF8)) {
        try { $safeEvent = $line | ConvertFrom-Json } catch { continue }
        $safeType = ""
        $safeReasonCode = ""
        $safeReason = ""
        $typeProperty = $safeEvent.PSObject.Properties["type"]
        $reasonCodeProperty = $safeEvent.PSObject.Properties["reason_code"]
        $reasonProperty = $safeEvent.PSObject.Properties["reason"]
        if ($typeProperty) { $safeType = [string]$typeProperty.Value }
        if ($reasonCodeProperty) { $safeReasonCode = [string]$reasonCodeProperty.Value }
        if ($reasonProperty) { $safeReason = [string]$reasonProperty.Value }
        if (
          $safeType -eq "LANE_CHATGPT_RATE_LIMIT_DETECTED" -or
          $safeReasonCode -eq "CHATGPT_RATE_LIMITED" -or
          $safeReason -eq "CHATGPT_RATE_LIMITED"
        ) {
          $rateLimitDetected = $true
          break
        }
      }
    }
    if ($rateLimitDetected -or $testNode.HasExited) { break }
    $reg = Read-JsonSafe (Join-Path $tempRoot "lane-registry.json")
    $lane = $reg.lanes.'lane-1'
    if (
      $lane -and
      -not [string]::IsNullOrWhiteSpace([string]$lane.work_url) -and
      -not [string]::IsNullOrWhiteSpace([string]$lane.last_dispatch_id)
    ) {
      $liveReached = $true
      break
    }
  }
  if ($rateLimitDetected) {
    if ($testNode -and -not $testNode.HasExited) {
      Stop-Process -Id $testNode.Id -Force -ErrorAction SilentlyContinue
      $testNode.WaitForExit()
    }
    $testNode = $null
    Set-RateLimitCooldown
    throw "P2_LIVE_RATE_LIMITED_NON_SEMANTIC"
  }

  if (-not $liveReached) {
    $diag = Read-JsonSafe (Join-Path $tempRoot "lane-registry.json")
    $diagLanes = Get-OptionalPropertyValue $diag "lanes"
    $diagLane = if ($diagLanes) { Get-OptionalPropertyValue $diagLanes "lane-1" } else { $null }
    $diagRollover = Get-OptionalPropertyValue $diagLane "work_rollover"
    $diagStage = if ($diagRollover) { [string](Get-OptionalPropertyValue $diagRollover "stage") } else { "" }
    $diagWorkUrl = [string](Get-OptionalPropertyValue $diagLane "work_url")
    $diagDispatchId = [string](Get-OptionalPropertyValue $diagLane "last_dispatch_id")
    Write-Host "LIVE_P2_DIAG_ROLLOVER_STAGE=$diagStage"
    Write-Host "LIVE_P2_DIAG_WORK_PRESENT=$([bool](-not [string]::IsNullOrWhiteSpace($diagWorkUrl)))"
    Write-Host "LIVE_P2_DIAG_DISPATCH_ID_PRESENT=$([bool](-not [string]::IsNullOrWhiteSpace($diagDispatchId)))"
    $safeLog = Join-Path $tempRoot "supervisor.log"
    $createRequested = 0
    $targetPersisted = 0
    $createErrors = 0
    $createErrorClasses = @{}
    $ambiguous = 0
    if (Test-Path $safeLog) {
      foreach ($line in Get-Content $safeLog -Encoding UTF8) {
        try { $event = $line | ConvertFrom-Json } catch { continue }
        $eventType = [string](Get-OptionalPropertyValue $event "type")
        switch ($eventType) {
          "LANE_AUTO_WORK_CREATE_REQUESTED" { $createRequested += 1 }
          "LANE_AUTO_WORK_TARGET_PERSISTED" { $targetPersisted += 1 }
          "LANE_WORK_ROLLOVER_BLANK_CREATE_ERROR" {
            $createErrors += 1
            $errorName = [string](Get-OptionalPropertyValue $event "error_name")
            $reason = [string](Get-OptionalPropertyValue $event "reason")
            $class = if ($reason -match "CHATGPT_RATE_LIMITED") {
              "RATE_LIMITED"
            } elseif ($reason -match "AUTO_WORK_BOOTSTRAP_NOT_EXECUTED") {
              "BOOTSTRAP_NOT_EXECUTED"
            } elseif ($reason -match "AUTO_WORK_BOOTSTRAP_SEND_NOT_CONFIRMED") {
              "BOOTSTRAP_SEND_NOT_CONFIRMED"
            } elseif ($reason -match "AUTO_WORK_BOOTSTRAP_RESPONSE_NOT_CONFIRMED") {
              "BOOTSTRAP_RESPONSE_NOT_CONFIRMED"
            } elseif ($reason -match "AUTO_WORK_BOOTSTRAP_CONVERSATION_NOT_CONFIRMED") {
              "BOOTSTRAP_CONVERSATION_NOT_CONFIRMED"
            } elseif ($reason -match "AUTO_WORK_BOOTSTRAP_CANONICAL_IDENTITY_NOT_CONFIRMED") {
              "BOOTSTRAP_CANONICAL_IDENTITY_NOT_CONFIRMED"
            } elseif ($reason -match "AUTO_WORK_BOOTSTRAP_CANONICAL_RELOAD_NOT_CONFIRMED") {
              "BOOTSTRAP_CANONICAL_RELOAD_NOT_CONFIRMED"
            } elseif ($reason -match "AUTO_WORK_TARGET_CREATE_NOT_CONFIRMED") {
              "TARGET_CREATE_NOT_CONFIRMED"
            } elseif ($errorName -match "Timeout" -or $reason -match "Timeout") {
              "TIMEOUT"
            } elseif ($reason -match "AUTO_WORK_TARGET_NOT_CANONICAL_C" -or $reason -match "canonical /c/ identity") {
              "NON_CANONICAL_C"
            } elseif ($errorName) {
              ("ERROR_" + ($errorName -replace '[^A-Za-z0-9_]','_'))
            } else {
              "UNKNOWN"
            }
            if (-not $createErrorClasses.ContainsKey($class)) { $createErrorClasses[$class] = 0 }
            $createErrorClasses[$class] += 1
          }
          "LANE_AUTO_WORK_CREATE_AMBIGUOUS" { $ambiguous += 1 }
        }
      }
    }
    Write-Host "LIVE_P2_DIAG_CREATE_REQUESTED_COUNT=$createRequested"
    Write-Host "LIVE_P2_DIAG_TARGET_PERSISTED_COUNT=$targetPersisted"
    Write-Host "LIVE_P2_DIAG_CREATE_ERROR_COUNT=$createErrors"
    foreach ($class in @($createErrorClasses.Keys | Sort-Object)) {
      Write-Host ("LIVE_P2_DIAG_CREATE_ERROR_" + $class + "=" + $createErrorClasses[$class])
    }
    Write-Host "LIVE_P2_DIAG_CREATE_AMBIGUOUS_COUNT=$ambiguous"

    $brainAdopted = 0
    $brainRequestSent = 0
    $brainSendPending = 0
    $brainAdoptionBlocked = @{}
    $laneErrorCount = 0
    $laneErrorNames = @{}
    if (Test-Path $safeLog) {
      foreach ($line in Get-Content $safeLog -Encoding UTF8) {
        try { $event = $line | ConvertFrom-Json } catch { continue }
        $eventType = [string](Get-OptionalPropertyValue $event "type")
        switch ($eventType) {
          "LANE_BRAIN_DIRECTIVE_ADOPTED" { $brainAdopted += 1 }
          "LANE_BRAIN_REQUEST_SENT" { $brainRequestSent += 1 }
          "LANE_BRAIN_SEND_PENDING_CONFIRMATION" { $brainSendPending += 1 }
          "LANE_BRAIN_DIRECTIVE_ADOPTION_BLOCKED" {
            $reason = [string](Get-OptionalPropertyValue $event "reason_code")
            if ([string]::IsNullOrWhiteSpace($reason)) { $reason = "UNKNOWN" }
            if (-not $brainAdoptionBlocked.ContainsKey($reason)) { $brainAdoptionBlocked[$reason] = 0 }
            $brainAdoptionBlocked[$reason] += 1
          }
          "LANE_ERROR" {
            $laneErrorCount += 1
            $name = [string](Get-OptionalPropertyValue $event "error_name")
            if ([string]::IsNullOrWhiteSpace($name)) { $name = "UNKNOWN" }
            if (-not $laneErrorNames.ContainsKey($name)) { $laneErrorNames[$name] = 0 }
            $laneErrorNames[$name] += 1
          }
        }
      }
    }
    Write-Host "LIVE_P2_DIAG_BRAIN_DIRECTIVE_ADOPTED_COUNT=$brainAdopted"
    Write-Host "LIVE_P2_DIAG_BRAIN_REQUEST_SENT_COUNT=$brainRequestSent"
    Write-Host "LIVE_P2_DIAG_BRAIN_SEND_PENDING_COUNT=$brainSendPending"
    foreach ($reason in @($brainAdoptionBlocked.Keys | Sort-Object)) {
      Write-Host ("LIVE_P2_DIAG_BRAIN_ADOPTION_BLOCKED_" + $reason + "=" + $brainAdoptionBlocked[$reason])
    }
    Write-Host "LIVE_P2_DIAG_LANE_ERROR_COUNT=$laneErrorCount"
    foreach ($name in @($laneErrorNames.Keys | Sort-Object)) {
      Write-Host ("LIVE_P2_DIAG_LANE_ERROR_" + $name + "=" + $laneErrorNames[$name])
    }

    $status = Read-JsonSafe (Join-Path $tempRoot "lane-status.json")
    $statusLanes = @(Get-OptionalPropertyValue $status "lanes")
    $statusLane = @($statusLanes | Where-Object {
      [string](Get-OptionalPropertyValue $_ "lane_id") -eq "lane-1"
    }) | Select-Object -First 1
    $statusLaneStatus = if ($statusLane) {
      [string](Get-OptionalPropertyValue $statusLane "status")
    } else {
      "MISSING"
    }
    Write-Host "LIVE_P2_DIAG_LANE_STATUS=$statusLaneStatus"
    $statusLaneErrorName = "NONE"
    if ($statusLane) {
      $errorNameProperty = $statusLane.PSObject.Properties["error_name"]
      if ($errorNameProperty -and -not [string]::IsNullOrWhiteSpace([string]$errorNameProperty.Value)) {
        $statusLaneErrorName = [string]$errorNameProperty.Value
      }
    }
    Write-Host "LIVE_P2_DIAG_LANE_ERROR_NAME=$statusLaneErrorName"
    throw "P2_LIVE_RUNTIME_ACCEPTANCE_NOT_REACHED"
  }

  if ($testNode -and -not $testNode.HasExited) {
    Stop-Process -Id $testNode.Id -Force -ErrorAction SilentlyContinue
    $testNode.WaitForExit()
  }
  $testNode = $null
  $env:LOCALAPPDATA = $savedLocalAppData

  $env:P2_TEMP_STATE_ROOT = $tempRoot
  & node "$env:GITHUB_WORKSPACE\.github\scripts\supervisor-p2-live-isolated-evidence.mjs"
  if ($LASTEXITCODE -ne 0) { throw "P2_LIVE_EVIDENCE_FAILED" }

  $productionConfigHashAfterTest = (Get-FileHash $configFile -Algorithm SHA256).Hash
  $productionRegistryHashAfterTest = (Get-FileHash $registryFile -Algorithm SHA256).Hash
  if ($productionConfigHashBefore -ne $productionConfigHashAfterTest) {
    throw "P2_LIVE_PRODUCTION_CONFIG_CHANGED"
  }
  if ($productionRegistryHashBefore -ne $productionRegistryHashAfterTest) {
    throw "P2_LIVE_PRODUCTION_REGISTRY_CHANGED"
  }
  Write-Host "LIVE_P2_PRODUCTION_CONFIG_UNCHANGED=True"
  Write-Host "LIVE_P2_PRODUCTION_REGISTRY_UNCHANGED=True"
  $acceptancePassed = $true
}
finally {
  $env:LOCALAPPDATA = $savedLocalAppData
  if ($testNode -and -not $testNode.HasExited) {
    Stop-Process -Id $testNode.Id -Force -ErrorAction SilentlyContinue
  }

  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  if ($ownsMutex -and $mutex) {
    try { $mutex.ReleaseMutex() } catch {}
    $ownsMutex = $false
  }
  if ($mutex) { $mutex.Dispose() }

  try {
    $env:SUPERVISOR_STATE_ROOT = $root
    $productionConfig = Read-JsonSafe $configFile
    $enabledLaneCount = @(
      @(Get-OptionalPropertyValue $productionConfig "lanes") |
        Where-Object { [bool](Get-OptionalPropertyValue $_ "enabled") }
    ).Count

    if ($enabledLaneCount -lt 1) {
      # Production was intentionally stopped before the isolated acceptance.
      # Recovery must preserve that state and must not manufacture a runtime.
      Write-Host "LIVE_P2_PRODUCTION_RUNTIME_RESTORE_SKIPPED_ALL_LANES_DISABLED=True"
    } else {
      $recovery = Start-Process -FilePath "powershell.exe" -PassThru -ArgumentList @(
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy","Bypass",
        "-File",('"' + $startScript + '"'),
        "-Hidden",
        "-Recovery"
      )
      if (-not $recovery.WaitForExit(15000)) {
        Stop-Process -Id $recovery.Id -Force -ErrorAction SilentlyContinue
        throw "P2_LIVE_RECOVERY_START_TIMEOUT"
      }
      if ($recovery.ExitCode -ne 0) { throw "recovery start failed" }

      $restored = $false
      for ($i=0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        $wrapper = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -and $_.CommandLine -like "*run-supervisor.ps1*" -and $_.CommandLine -like "*$root*" } |
          Select-Object -First 1
        $threeLane = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -and $_.CommandLine -like "*three-lane-cli.mjs*" } |
          Select-Object -First 1
        $robotChrome = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" -and $_.CommandLine -match '--remote-debugging-port=(\d+)' } |
          Select-Object -First 1
        if ($wrapper -and $threeLane -and $robotChrome) {
          $restored = $true
          break
        }
      }
      if (-not $restored) { throw "P2_LIVE_PRODUCTION_RUNTIME_NOT_RESTORED" }
      Write-Host "LIVE_P2_PRODUCTION_RUNTIME_RESTORED=True"
    }
  } catch {
    $restoreError = $_.Exception.Message
  }

  Remove-Item $tempBase -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $fixtureFile,$nodeOut,$nodeErr -Force -ErrorAction SilentlyContinue
}

if ($restoreError) { throw $restoreError }
if (-not $acceptancePassed) { throw "P2_LIVE_ACCEPTANCE_FAILED" }
Write-Host "LIVE_P2_RATE_LIMIT_DETECTED=False"
Write-Host "LIVE_P2_ISOLATED_PRODUCTION_STATE=True"
Write-Host "LIVE_P2_ACCEPTANCE=PASS"
