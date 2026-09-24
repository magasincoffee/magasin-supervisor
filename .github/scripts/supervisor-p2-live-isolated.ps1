$ErrorActionPreference = "Stop"

. "$env:GITHUB_WORKSPACE\windows\state-root.ps1"

function Read-JsonSafe([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  try { return Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}
function Resolve-CanonicalSupervisorRoot {
  $candidates = New-Object System.Collections.Generic.List[string]
  try { $candidates.Add((Get-SupervisorStateRoot -Compatibility "legacy-preserve")) } catch {}
  foreach ($proc in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $cmd = [string]$proc.CommandLine
    if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
    foreach ($pattern in @(
      '([A-Za-z]:\\[^"]*?\\MAGASIN\\BusinessOS\\supervisor)\\runtime\\windows\\run-supervisor\.ps1',
      '([A-Za-z]:\\[^"]*?\\MAGASIN\\BusinessOS\\supervisor)\\browser_profile'
    )) {
      $m = [regex]::Match($cmd,$pattern,[System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
      if ($m.Success) { $candidates.Add([string]$m.Groups[1].Value) }
    }
  }
  $valid = @($candidates |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    ForEach-Object { try { [System.IO.Path]::GetFullPath($_) } catch { $null } } |
    Where-Object { $_ -and (Test-Path (Join-Path $_ "lanes.json")) -and (Test-Path (Join-Path $_ "lane-registry.json")) } |
    Select-Object -Unique)
  if ($valid.Count -ne 1) { throw "P2_LIVE_STATE_ROOT_AMBIGUOUS_OR_MISSING" }
  return [string]$valid[0]
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
$chromeExe = [string]$existingChrome.ExecutablePath
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
  & node "$env:GITHUB_WORKSPACE\.github\scripts\supervisor-p2-live-brain-fixture.mjs"
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
    $runtimeCli,"--cdp-url",$env:P2_CDP_URL,"--poll-ms","1000","--execute"
  ) -PassThru -RedirectStandardOutput $nodeOut -RedirectStandardError $nodeErr

  $liveReached = $false
  for ($i=0; $i -lt 150; $i++) {
    Start-Sleep -Seconds 1
    if ($testNode.HasExited) { break }
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
  if (-not $liveReached) { throw "P2_LIVE_RUNTIME_ACCEPTANCE_NOT_REACHED" }

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
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startScript -Hidden -Recovery
    if ($LASTEXITCODE -ne 0) { throw "recovery start failed" }

    $restored = $false
    for ($i=0; $i -lt 60; $i++) {
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
  } catch {
    $restoreError = $_.Exception.Message
  }

  Remove-Item $tempBase -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $fixtureFile,$nodeOut,$nodeErr -Force -ErrorAction SilentlyContinue
}

if ($restoreError) { throw $restoreError }
if (-not $acceptancePassed) { throw "P2_LIVE_ACCEPTANCE_FAILED" }
Write-Host "LIVE_P2_ISOLATED_PRODUCTION_STATE=True"
Write-Host "LIVE_P2_ACCEPTANCE=PASS"
