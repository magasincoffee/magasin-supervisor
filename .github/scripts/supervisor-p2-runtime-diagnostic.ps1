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

function Test-CanonicalCandidate([string]$Root) {
  try {
    if ([string]::IsNullOrWhiteSpace($Root)) { return $false }
    $full = [System.IO.Path]::GetFullPath($Root)
    $lanes = Read-JsonSafe (Join-Path $full "lanes.json")
    $registry = Read-JsonSafe (Join-Path $full "lane-registry.json")
    $start = Join-Path $full "runtime\windows\start-supervisor.ps1"
    return [bool]($lanes -and $lanes.lanes -and $registry -and $registry.lanes -and (Test-ReadableLeaf $start))
  } catch {
    return $false
  }
}

$wrapperAlive = [bool](Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*run-supervisor.ps1*" } |
  Select-Object -First 1)
$threeLaneAlive = [bool](Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*three-lane-cli.mjs*" } |
  Select-Object -First 1)
$chromeProcess = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match "--remote-debugging-port=(\d+)" } |
  Select-Object -First 1
$chromeAlive = [bool]$chromeProcess
$cdpHealthy = $false
if ($chromeProcess -and ([string]$chromeProcess.CommandLine -match "--remote-debugging-port=(\d+)")) {
  try {
    $port = [int]$Matches[1]
    $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
    $cdpHealthy = [bool]$version.webSocketDebuggerUrl
  } catch {
    $cdpHealthy = $false
  }
}

$candidateRoots = New-Object System.Collections.Generic.List[string]
$defaultRoot = Get-SupervisorStateRoot -Compatibility "legacy-preserve"
if (Test-CanonicalCandidate $defaultRoot) {
  $candidateRoots.Add([System.IO.Path]::GetFullPath($defaultRoot))
}

foreach ($proc in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
  $cmd = [string]$proc.CommandLine
  if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
  foreach ($pattern in @(
    '([A-Za-z]:\\[^"]*?\\MAGASIN\\BusinessOS\\supervisor)\\runtime\\windows\\run-supervisor\.ps1',
    '([A-Za-z]:\\[^"]*?\\MAGASIN\\BusinessOS\\supervisor)\\browser_profile'
  )) {
    $match = [regex]::Match($cmd,$pattern,[System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($match.Success -and (Test-CanonicalCandidate ([string]$match.Groups[1].Value))) {
      $candidateRoots.Add([System.IO.Path]::GetFullPath([string]$match.Groups[1].Value))
    }
  }
}

$profileDeniedCount = 0
foreach ($userProfile in @(Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue | Where-Object { $_.LocalPath -and -not $_.Special })) {
  $candidate = Join-Path ([string]$userProfile.LocalPath) "AppData\Local\MAGASIN\BusinessOS\supervisor"
  try {
    $null = Test-Path -LiteralPath $candidate -ErrorAction Stop
  } catch [System.UnauthorizedAccessException] {
    $profileDeniedCount += 1
    continue
  } catch {
    if ($_.Exception -is [System.UnauthorizedAccessException] -or $_.FullyQualifiedErrorId -like "*UnauthorizedAccess*") {
      $profileDeniedCount += 1
    }
    continue
  }
  if (Test-CanonicalCandidate $candidate) {
    $candidateRoots.Add([System.IO.Path]::GetFullPath($candidate))
  }
}

$roots = @($candidateRoots | Select-Object -Unique)
$root = if ($roots.Count -eq 1) { [string]$roots[0] } else { $null }
$condition = if ($roots.Count -eq 1) {
  "VALID_UNIQUE"
} elseif ($roots.Count -gt 1) {
  "AMBIGUOUS"
} else {
  "NO_READABLE_VALID_ROOT"
}

Write-Host "LIVE_P2_DIAG_RUNNER_NAME=$env:COMPUTERNAME"
Write-Host "LIVE_P2_DIAG_WRAPPER_ALIVE=$wrapperAlive"
Write-Host "LIVE_P2_DIAG_THREE_LANE_ALIVE=$threeLaneAlive"
Write-Host "LIVE_P2_DIAG_CHROME_ALIVE=$chromeAlive"
Write-Host "LIVE_P2_DIAG_CDP_HEALTHY=$cdpHealthy"
Write-Host "LIVE_P2_DIAG_VALID_ROOT_COUNT=$($roots.Count)"
Write-Host "LIVE_P2_DIAG_PROFILE_DENIED_COUNT=$profileDeniedCount"
Write-Host "LIVE_P2_DIAG_STATE_ROOT_CONDITION=$condition"

if (-not $root) {
  Write-Host "LIVE_P2_DIAG_LANES_READABLE=False"
  Write-Host "LIVE_P2_DIAG_REGISTRY_READABLE=False"
  Write-Host "LIVE_P2_DIAG_STATUS_READABLE=False"
  Write-Host "LIVE_P2_DIAG_INSTALLED_RUNTIME_PRESENT=False"
  Write-Host "LIVE_P2_DIAG_OWNER_STOP=UNKNOWN"
  Write-Host "LIVE_P2_DIAG_LANE1_ENABLED=UNKNOWN"
  Write-Host "LIVE_P2_DIAG_LANE1_WORK_MODE=UNKNOWN"
  Write-Host "LIVE_P2_DIAG_LANE1_BRAIN_PRESENT=UNKNOWN"
  exit 0
}

$lanesFile = Join-Path $root "lanes.json"
$registryFile = Join-Path $root "lane-registry.json"
$statusFile = Join-Path $root "lane-status.json"
$runtimeFile = Join-Path $root "runtime\src\runtime\three-lane-cli.mjs"
$lanes = Read-JsonSafe $lanesFile
$registry = Read-JsonSafe $registryFile
$status = Read-JsonSafe $statusFile
$runtimePresent = Test-ReadableLeaf $runtimeFile
$runtimeVersion = ""
$runtimeHash = ""
if ($runtimePresent) {
  try {
    $source = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 -ErrorAction Stop
    $versionMatch = [regex]::Match($source,'SUPERVISOR_RUNTIME_VERSION\s*=\s*"([^"]+)"')
    if ($versionMatch.Success) { $runtimeVersion = [string]$versionMatch.Groups[1].Value }
    $runtimeHash = (Get-FileHash -LiteralPath $runtimeFile -Algorithm SHA256 -ErrorAction Stop).Hash
  } catch {}
}

$ownerStopKnown = $true
$ownerStop = $false
try {
  $ownerStop = [bool](
    (Test-Path -LiteralPath (Join-Path $root "STOP") -ErrorAction Stop) -or
    (Test-Path -LiteralPath (Join-Path $root "AUTOSTART_DISABLED") -ErrorAction Stop)
  )
} catch {
  $ownerStopKnown = $false
}

$lane1 = @($lanes.lanes | Where-Object { [string]$_.lane_id -eq "lane-1" }) | Select-Object -First 1

Write-Host "LIVE_P2_DIAG_LANES_READABLE=$([bool]$lanes)"
Write-Host "LIVE_P2_DIAG_REGISTRY_READABLE=$([bool]$registry)"
Write-Host "LIVE_P2_DIAG_STATUS_READABLE=$([bool]$status)"
Write-Host "LIVE_P2_DIAG_INSTALLED_RUNTIME_PRESENT=$runtimePresent"
Write-Host "LIVE_P2_DIAG_RUNTIME_VERSION_PRESENT=$([bool](-not [string]::IsNullOrWhiteSpace($runtimeVersion)))"
Write-Host "LIVE_P2_DIAG_RUNTIME_HASH=$runtimeHash"
if ($ownerStopKnown) {
  Write-Host "LIVE_P2_DIAG_OWNER_STOP=$ownerStop"
} else {
  Write-Host "LIVE_P2_DIAG_OWNER_STOP=UNKNOWN"
}
Write-Host "LIVE_P2_DIAG_LANE1_ENABLED=$([bool]($lane1 -and [bool]$lane1.enabled))"
Write-Host "LIVE_P2_DIAG_LANE1_WORK_MODE=$(if ($lane1) { [string]$lane1.work_mode } else { "UNKNOWN" })"
Write-Host "LIVE_P2_DIAG_LANE1_BRAIN_PRESENT=$([bool]($lane1 -and -not [string]::IsNullOrWhiteSpace([string]$lane1.brain_url)))"
