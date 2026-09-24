$ErrorActionPreference = "Stop"

function Read-JsonSafe([string]$Path) {
  try {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf -ErrorAction Stop)) { return $null }
    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return $raw | ConvertFrom-Json -ErrorAction Stop
  } catch { return $null }
}
function Write-JsonFile([string]$Path,$Value) {
  $dir = Split-Path $Path -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $Value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $Path -Encoding UTF8
}
function Test-Cdp([int]$Port) {
  try {
    $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
    return [bool]$v.webSocketDebuggerUrl
  } catch { return $false }
}
function Get-FreeCdpPort {
  foreach ($port in 9222..9238) {
    if (-not (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1)) {
      return $port
    }
  }
  throw "P2_RUNNER_ISOLATED_NO_FREE_CDP_PORT"
}
function Stop-Tree([int]$Pid) {
  if (Get-Process -Id $Pid -ErrorAction SilentlyContinue) {
    & taskkill.exe /PID $Pid /T /F | Out-Null
  }
}
function Get-ChatPageCount([int]$Port) {
  try {
    $targets = @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 3)
    return @($targets | Where-Object { [string]$_.type -eq "page" -and [string]$_.url -like "https://chatgpt.com/*" }).Count
  } catch { return -1 }
}
function Count-TaskEvents([string]$Root,[string]$TaskId,[string]$Type) {
  $file = Join-Path $Root "lane-events.ndjson"
  if (-not (Test-Path -LiteralPath $file)) { return 0 }
  $count = 0
  foreach ($line in Get-Content -LiteralPath $file -Encoding UTF8) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try { $e = $line | ConvertFrom-Json } catch { continue }
    if ([string]$e.task_id -eq $TaskId -and [string]$e.event_type -eq $Type) { $count += 1 }
  }
  return $count
}

$chromeExe = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$([Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $chromeExe) { throw "P2_RUNNER_ISOLATED_CHROME_NOT_FOUND" }

$tempBase = Join-Path $env:RUNNER_TEMP "magasin-p2-runner-isolated"
$tempRoot = Join-Path $tempBase "MAGASIN\BusinessOS\supervisor"
$profile = Join-Path $tempBase "browser_profile"
$fixtureFile = Join-Path $tempBase "fixture.json"
$nodeOut = Join-Path $tempBase "runtime.out.log"
$nodeErr = Join-Path $tempBase "runtime.err.log"
$runtimeCli = Join-Path $env:GITHUB_WORKSPACE "src\runtime\three-lane-cli.mjs"
Remove-Item -LiteralPath $tempBase -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tempRoot,$profile | Out-Null

$chrome = $null
$node = $null
$savedLocalAppData = [string]$env:LOCALAPPDATA
try {
  $cdpPort = Get-FreeCdpPort
  $chrome = Start-Process -FilePath $chromeExe -PassThru -ArgumentList @(
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$cdpPort",
    ('--user-data-dir="' + $profile + '"'),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "https://chatgpt.com/"
  )
  for ($i=0; $i -lt 45 -and -not (Test-Cdp $cdpPort); $i++) { Start-Sleep -Seconds 1 }
  if (-not (Test-Cdp $cdpPort)) { throw "P2_RUNNER_ISOLATED_CDP_NOT_READY" }
  Write-Host "LIVE_P2_RUNNER_ISOLATED_CDP=True"

  $env:P2_CDP_URL = "http://127.0.0.1:$cdpPort"
  $env:P2_FIXTURE_FILE = $fixtureFile
  & node "$env:GITHUB_WORKSPACE\.github\scripts\supervisor-p2-live-brain-fixture.mjs"
  if ($LASTEXITCODE -ne 0) { throw "P2_RUNNER_ISOLATED_BRAIN_FIXTURE_FAILED" }

  $fixture = Read-JsonSafe $fixtureFile
  if (-not $fixture -or [string]$fixture.task_id -ne "SUP-SELFHEAL-P2-LIVE-FIXTURE") {
    throw "P2_RUNNER_ISOLATED_FIXTURE_INVALID"
  }
  Write-Host "LIVE_P2_RUNNER_ISOLATED_BRAIN_READY=True"

  $now = [DateTimeOffset]::UtcNow.ToString("o")
  $config = [pscustomobject]@{
    schema_version = "three-lane-config.v1"
    mode = "THREE_LANE_V1"
    lanes = @(
      [pscustomobject]@{
        lane_id = "lane-1"; project_name = "P2 Runner Isolated"
        brain_url = [string]$fixture.brain_url; brain_url_revision = 1
        work_url = ""; work_url_revision = 1; work_url_saved_at = $now; work_mode = "AUTO"
        work_state_reset_revision = 0; relay_retry_rearm_revision = 0
        relay_retry_rearm_requested_at = $null; enabled = $true
      },
      [pscustomobject]@{
        lane_id = "lane-2"; project_name = "Unused"; brain_url = ""; brain_url_revision = 0
        work_url = ""; work_url_revision = 0; work_url_saved_at = $null; work_mode = "AUTO"
        work_state_reset_revision = 0; relay_retry_rearm_revision = 0; relay_retry_rearm_requested_at = $null; enabled = $false
      },
      [pscustomobject]@{
        lane_id = "lane-3"; project_name = "Unused"; brain_url = ""; brain_url_revision = 0
        work_url = ""; work_url_revision = 0; work_url_saved_at = $null; work_mode = "AUTO"
        work_state_reset_revision = 0; relay_retry_rearm_revision = 0; relay_retry_rearm_requested_at = $null; enabled = $false
      }
    )
  }
  Write-JsonFile (Join-Path $tempRoot "lanes.json") $config
  $env:LOCALAPPDATA = $tempBase

  # Live negative proof: Owner STOP must block before AUTO create or send.
  Set-Content -LiteralPath (Join-Path $tempRoot "STOP") -Value "P2_LIVE_TEST_STOP" -Encoding ascii
  $pagesBeforeStop = Get-ChatPageCount $cdpPort
  $node = Start-Process -FilePath "node.exe" -ArgumentList @($runtimeCli,"--cdp-url",$env:P2_CDP_URL,"--poll-ms","500","--execute") -PassThru -RedirectStandardOutput $nodeOut -RedirectStandardError $nodeErr
  Start-Sleep -Seconds 5
  if ($node -and -not $node.HasExited) { Stop-Tree $node.Id }
  $node = $null
  $stopReg = Read-JsonSafe (Join-Path $tempRoot "lane-registry.json")
  $stopLane = $stopReg.lanes.'lane-1'
  $pagesAfterStop = Get-ChatPageCount $cdpPort
  $stopCreate = Count-TaskEvents $tempRoot ([string]$fixture.task_id) "AUTO_WORK_CREATE_REQUESTED"
  $stopDispatch = Count-TaskEvents $tempRoot ([string]$fixture.task_id) "WORK_DISPATCH_CONFIRMED"
  if (($stopLane -and -not [string]::IsNullOrWhiteSpace([string]$stopLane.work_url)) -or $stopCreate -ne 0 -or $stopDispatch -ne 0 -or $pagesAfterStop -gt $pagesBeforeStop) {
    throw "P2_RUNNER_ISOLATED_OWNER_STOP_FAILED"
  }
  Write-Host "LIVE_P2_OWNER_STOP_BLOCKED_CREATE=True"
  Write-Host "LIVE_P2_OWNER_STOP_BLOCKED_SEND=True"
  Remove-Item -LiteralPath (Join-Path $tempRoot "STOP") -Force

  # Positive AUTO lifecycle.
  Remove-Item -LiteralPath $nodeOut,$nodeErr -Force -ErrorAction SilentlyContinue
  $node = Start-Process -FilePath "node.exe" -ArgumentList @($runtimeCli,"--cdp-url",$env:P2_CDP_URL,"--poll-ms","700","--execute") -PassThru -RedirectStandardOutput $nodeOut -RedirectStandardError $nodeErr
  $reached = $false
  for ($i=0; $i -lt 210; $i++) {
    Start-Sleep -Seconds 1
    if ($node.HasExited) { break }
    $reg = Read-JsonSafe (Join-Path $tempRoot "lane-registry.json")
    $lane = $reg.lanes.'lane-1'
    if ($lane -and -not [string]::IsNullOrWhiteSpace([string]$lane.work_url) -and -not [string]::IsNullOrWhiteSpace([string]$lane.last_dispatch_id)) {
      $reached = $true
      break
    }
  }
  if (-not $reached) {
    $reg = Read-JsonSafe (Join-Path $tempRoot "lane-registry.json")
    $lane = $reg.lanes.'lane-1'
    Write-Host "LIVE_P2_RUNNER_DIAG_WORK_PRESENT=$([bool]($lane -and -not [string]::IsNullOrWhiteSpace([string]$lane.work_url)))"
    Write-Host "LIVE_P2_RUNNER_DIAG_DISPATCH_PRESENT=$([bool]($lane -and -not [string]::IsNullOrWhiteSpace([string]$lane.last_dispatch_id)))"
    Write-Host "LIVE_P2_RUNNER_DIAG_CREATE_COUNT=$(Count-TaskEvents $tempRoot ([string]$fixture.task_id) 'AUTO_WORK_CREATE_REQUESTED')"
    Write-Host "LIVE_P2_RUNNER_DIAG_PERSIST_COUNT=$(Count-TaskEvents $tempRoot ([string]$fixture.task_id) 'AUTO_WORK_TARGET_PERSISTED')"
    throw "P2_RUNNER_ISOLATED_AUTO_ACCEPTANCE_NOT_REACHED"
  }

  if ($node -and -not $node.HasExited) { Stop-Tree $node.Id }
  $node = $null

  $env:P2_TEMP_STATE_ROOT = $tempRoot
  & node "$env:GITHUB_WORKSPACE\.github\scripts\supervisor-p2-live-isolated-evidence.mjs"
  if ($LASTEXITCODE -ne 0) { throw "P2_RUNNER_ISOLATED_EVIDENCE_FAILED" }

  $beforeRestart = Read-JsonSafe (Join-Path $tempRoot "lane-registry.json")
  $beforeLane = $beforeRestart.lanes.'lane-1'
  $createBefore = Count-TaskEvents $tempRoot ([string]$fixture.task_id) "AUTO_WORK_CREATE_REQUESTED"
  $persistBefore = Count-TaskEvents $tempRoot ([string]$fixture.task_id) "AUTO_WORK_TARGET_PERSISTED"
  $dispatchBefore = Count-TaskEvents $tempRoot ([string]$fixture.task_id) "AUTO_WORK_DISPATCH_CONFIRMED"

  $node = Start-Process -FilePath "node.exe" -ArgumentList @($runtimeCli,"--cdp-url",$env:P2_CDP_URL,"--poll-ms","700","--execute") -PassThru -RedirectStandardOutput $nodeOut -RedirectStandardError $nodeErr
  Start-Sleep -Seconds 6
  if ($node -and -not $node.HasExited) { Stop-Tree $node.Id }
  $node = $null

  $afterRestart = Read-JsonSafe (Join-Path $tempRoot "lane-registry.json")
  $afterLane = $afterRestart.lanes.'lane-1'
  $createAfter = Count-TaskEvents $tempRoot ([string]$fixture.task_id) "AUTO_WORK_CREATE_REQUESTED"
  $persistAfter = Count-TaskEvents $tempRoot ([string]$fixture.task_id) "AUTO_WORK_TARGET_PERSISTED"
  $dispatchAfter = Count-TaskEvents $tempRoot ([string]$fixture.task_id) "AUTO_WORK_DISPATCH_CONFIRMED"
  if (
    [string]$beforeLane.work_url -ne [string]$afterLane.work_url -or
    [string]$beforeLane.last_dispatch_id -ne [string]$afterLane.last_dispatch_id -or
    $createBefore -ne $createAfter -or
    $persistBefore -ne $persistAfter -or
    $dispatchBefore -ne $dispatchAfter
  ) {
    throw "P2_RUNNER_ISOLATED_RESTART_DUPLICATED"
  }
  Write-Host "LIVE_P2_RESTART_PERSISTED_TARGET_REUSED=True"
  Write-Host "LIVE_P2_RESTART_DUPLICATE_CREATE=False"
  Write-Host "LIVE_P2_RESTART_DUPLICATE_DISPATCH=False"
  Write-Host "LIVE_P2_RUNNER_ISOLATED_ACCEPTANCE=PASS"
} finally {
  $env:LOCALAPPDATA = $savedLocalAppData
  if ($node -and -not $node.HasExited) { Stop-Tree $node.Id }
  if ($chrome -and -not $chrome.HasExited) { Stop-Tree $chrome.Id }
  Remove-Item -LiteralPath $tempBase -Recurse -Force -ErrorAction SilentlyContinue
}
