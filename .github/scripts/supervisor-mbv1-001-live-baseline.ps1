param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13',
  [string]$UpstreamRepo = 'https://github.com/OLmatter/chatgpt-bridge.git',
  [string]$UpstreamCommit = '848efb9e85f52f251c82ab099747833c0693c072'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Write-Host "MBV1_001_MACHINE=$env:COMPUTERNAME"
Write-Host "MBV1_001_SUPERVISOR_REVISION=$env:GITHUB_SHA"
Write-Host "MBV1_001_UPSTREAM_REPO=$UpstreamRepo"
Write-Host "MBV1_001_UPSTREAM_COMMIT=$UpstreamCommit"

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Host 'MBV1_001_TARGET_MATCH=False'
  Write-Host 'MBV1_001_SKIP_SAFE=True'
  exit 0
}
Write-Host 'MBV1_001_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$profile = Join-Path $root 'browser_profile'
$diagDir = Join-Path $root 'diagnostics\mbv1-001'
New-Item -ItemType Directory -Force -Path $diagDir | Out-Null

function Get-QualificationChromeExecutable {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "\${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  return $candidates |
    Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) -and (Test-Path $_ -PathType Leaf) } |
    Select-Object -First 1
}

function Get-FreeQualificationCdpPort {
  foreach ($candidate in 9222..9232) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $listener) { return [int]$candidate }
  }
  throw 'No free Supervisor CDP port in range 9222-9232.'
}

function Test-QualificationCdp([int]$Port) {
  try {
    $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
    return [bool]$version.webSocketDebuggerUrl
  } catch {
    return $false
  }
}

function Test-BridgeStatus {
  try {
    $status = Invoke-RestMethod -Uri 'http://127.0.0.1:5000/status' -TimeoutSec 2
    return $null -ne $status.pages_connected
  } catch {
    return $false
  }
}

$workRoot = Join-Path $env:RUNNER_TEMP ("mbv1-001-" + [Guid]::NewGuid().ToString('N'))
$bridgeRoot = Join-Path $workRoot 'chatgpt-bridge'
$venv = Join-Path $workRoot '.venv'
$bridgeProcess = $null
$startedBridge = $false
$startedBrowser = $false
$qualificationBrowserPid = 0
$cdpPort = 0

try {
  New-Item -ItemType Directory -Force -Path $workRoot | Out-Null

  if (Test-BridgeStatus) {
    throw 'Port 5000 already hosts a Bridge-like service. MBV1-001 refuses to replace or trust an unpinned running instance.'
  }

  & git clone --quiet $UpstreamRepo $bridgeRoot
  if ($LASTEXITCODE -ne 0) { throw 'Failed to clone chatgpt-bridge upstream.' }

  Push-Location $bridgeRoot
  try {
    & git checkout --quiet --detach $UpstreamCommit
    if ($LASTEXITCODE -ne 0) { throw 'Failed to checkout pinned upstream commit.' }
    $actualCommit = (& git rev-parse HEAD).Trim()
  } finally {
    Pop-Location
  }

  if ($actualCommit -ne $UpstreamCommit) {
    throw "Pinned upstream mismatch: expected $UpstreamCommit got $actualCommit"
  }
  Write-Host 'MBV1_001_UPSTREAM_PIN_VERIFIED=True'

  $python = Get-Command python -ErrorAction SilentlyContinue
  if (-not $python) { throw 'Python not found on target machine.' }

  & python -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create Python venv.' }

  $venvPython = Join-Path $venv 'Scripts\python.exe'
  & $venvPython -m pip install --disable-pip-version-check --no-input -q -r (Join-Path $bridgeRoot 'requirements.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Failed to install pinned Bridge dependencies.' }

  $bridgeStdout = Join-Path $diagDir ("$env:GITHUB_SHA.bridge.stdout.log")
  $bridgeStderr = Join-Path $diagDir ("$env:GITHUB_SHA.bridge.stderr.log")
  $bridgeProcess = Start-Process -FilePath $venvPython -WorkingDirectory $bridgeRoot -PassThru -WindowStyle Hidden `
    -ArgumentList @('run.py','--host','127.0.0.1','--port','5000') `
    -RedirectStandardOutput $bridgeStdout -RedirectStandardError $bridgeStderr
  $startedBridge = $true

  for ($i = 0; $i -lt 60; $i++) {
    if (Test-BridgeStatus) { break }
    if ($bridgeProcess.HasExited) {
      throw "Pinned Bridge process exited early with code $($bridgeProcess.ExitCode)."
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-BridgeStatus)) { throw 'Pinned Bridge did not become healthy on 127.0.0.1:5000.' }
  Write-Host 'MBV1_001_BRIDGE_SERVICE_ONLINE=True'

  $existingChrome = Get-LifecycleRobotChrome -Root $root
  if ($existingChrome) {
    if ($existingChrome.CommandLine -notmatch '--remote-debugging-port=(\d+)') {
      throw 'Dedicated Supervisor Chrome exists without readable CDP port.'
    }
    $cdpPort = [int]$Matches[1]
    if (-not (Test-QualificationCdp -Port $cdpPort)) {
      throw "Dedicated Supervisor Chrome CDP port $cdpPort is unhealthy."
    }
    Write-Host 'MBV1_001_EXISTING_DEDICATED_CHROME=True'
  } else {
    $profileUsers = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" })
    if ($profileUsers.Count -gt 0) {
      throw 'Supervisor browser profile is in use without a healthy dedicated CDP endpoint.'
    }

    $chrome = Get-QualificationChromeExecutable
    if (-not $chrome) { throw 'Installed Google Chrome not found.' }

    $cdpPort = Get-FreeQualificationCdpPort
    $started = Start-Process -FilePath $chrome -WindowStyle Minimized -PassThru -ArgumentList @(
      '--remote-debugging-address=127.0.0.1',
      "--remote-debugging-port=$cdpPort",
      ('--user-data-dir="' + $profile + '"'),
      '--no-first-run',
      '--no-default-browser-check',
      '--start-minimized',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
      'https://chatgpt.com/'
    )
    $startedBrowser = $true

    for ($i = 0; $i -lt 30; $i++) {
      if (Test-QualificationCdp -Port $cdpPort) { break }
      Start-Sleep -Milliseconds 500
    }
    if (-not (Test-QualificationCdp -Port $cdpPort)) {
      throw "Qualification Chrome did not expose healthy CDP on port $cdpPort."
    }

    $browserProcess = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and
        $_.CommandLine -like "*$profile*" -and
        $_.CommandLine -match ("--remote-debugging-port=" + $cdpPort + "(\s|$)")
      } |
      Select-Object -First 1
    if ($browserProcess) { $qualificationBrowserPid = [int]$browserProcess.ProcessId }
    elseif ($started) { $qualificationBrowserPid = [int]$started.Id }

    Write-Host 'MBV1_001_EXISTING_DEDICATED_CHROME=False'
  }

  $env:MBV1_001_CDP_URL = "http://127.0.0.1:$cdpPort"
  $env:MBV1_001_UPSTREAM_ROOT = $bridgeRoot
  $env:MBV1_001_UPSTREAM_COMMIT = $UpstreamCommit
  $env:MBV1_001_DIAG_DIR = $diagDir
  $env:MBV1_001_BROWSER_STARTED = if ($startedBrowser) { 'true' } else { 'false' }

  Write-Host "MBV1_001_CDP_PORT=$cdpPort"
  Write-Host 'MBV1_001_CDP_HEALTHY=True'

  $script = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-mbv1-001-live-baseline.mjs'
  & node $script
  if ($LASTEXITCODE -ne 0) {
    throw "MBV1-001 Node qualification failed with exit code $LASTEXITCODE"
  }
} finally {
  if ($startedBrowser) {
    $owned = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and
        $_.CommandLine -like "*$profile*" -and
        $_.CommandLine -match ("--remote-debugging-port=" + $cdpPort + "(\s|$)")
      })
    foreach ($proc in $owned) {
      Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction SilentlyContinue
    }
    if ($qualificationBrowserPid -gt 0) {
      Stop-Process -Id $qualificationBrowserPid -Force -ErrorAction SilentlyContinue
    }
    Write-Host 'MBV1_001_ISOLATED_CHROME_CLEANUP=True'
  }

  if ($startedBridge -and $bridgeProcess -and -not $bridgeProcess.HasExited) {
    Stop-Process -Id $bridgeProcess.Id -Force -ErrorAction SilentlyContinue
    Write-Host 'MBV1_001_BRIDGE_CLEANUP=True'
  }

  if (Test-Path $workRoot) {
    Remove-Item -Recurse -Force $workRoot -ErrorAction SilentlyContinue
  }
}
