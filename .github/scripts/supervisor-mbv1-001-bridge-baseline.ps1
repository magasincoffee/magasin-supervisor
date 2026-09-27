param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13',
  [string]$BridgeCommit = '848efb9e85f52f251c82ab099747833c0693c072'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Write-Kv([string]$Key, $Value) {
  $safe = [string]$Value
  $safe = $safe -replace '[\r\n|]+', ' '
  if ($safe.Length -gt 500) { $safe = $safe.Substring(0, 500) }
  Write-Host "$Key=$safe"
}

function Test-Cdp([int]$Port) {
  try {
    $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
    return [bool]$version.webSocketDebuggerUrl
  } catch {
    return $false
  }
}

function Test-Bridge([int]$Port) {
  try {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status" -TimeoutSec 2
    return $null -ne $status.pages_connected
  } catch {
    return $false
  }
}

function Get-QualificationChromeExecutable {
  $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $programFilesX86 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  )
  return $candidates |
    Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) -and (Test-Path $_ -PathType Leaf) } |
    Select-Object -First 1
}

function Get-FreeQualificationCdpPort {
  foreach ($candidate in 9240..9260) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $listener) { return [int]$candidate }
  }
  throw 'No free MBV1 qualification CDP port in range 9240-9260.'
}

Write-Kv 'MBV1_001_MACHINE' $env:COMPUTERNAME
Write-Kv 'MBV1_001_REVISION' $env:GITHUB_SHA
Write-Kv 'MBV1_001_BRIDGE_COMMIT_REQUESTED' $BridgeCommit

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Kv 'MBV1_001_TARGET_MATCH' 'False'
  Write-Kv 'MBV1_001_SKIP_SAFE' 'True'
  exit 0
}
Write-Kv 'MBV1_001_TARGET_MATCH' 'True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$sourceProfileRoot = Join-Path $root 'browser_profile'
$diagDir = Join-Path $root 'diagnostics\mbv1-001'
$artifactDir = Join-Path $env:GITHUB_WORKSPACE '.github\qualification\mbv1-001-artifact'
$resultPath = Join-Path $artifactDir 'mbv1-001-result.json'
$persistentResult = Join-Path $diagDir ("{0}.result.json" -f $env:GITHUB_SHA)
$lockPath = Join-Path $diagDir 'live.lock'

New-Item -ItemType Directory -Force -Path $diagDir | Out-Null
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null

Write-Kv 'MBV1_001_STATE_ROOT' $root
Write-Kv 'MBV1_001_PRODUCTION_STATE_MUTATED' 'False'
Write-Kv 'MBV1_001_PRODUCTION_TARGETS_MUTATED' 'False'
Write-Kv 'MBV1_001_PREEXISTING_PAGES_CLOSED' 'False'
Write-Kv 'MBV1_001_PRODUCTION_BROWSER_STOPPED' 'False'

if (Test-Path $persistentResult -PathType Leaf) {
  try {
    $prior = Get-Content -Raw -LiteralPath $persistentResult | ConvertFrom-Json
    if ([string]$prior.status -eq 'PASS') {
      Copy-Item -LiteralPath $persistentResult -Destination $resultPath -Force
      Write-Kv 'MBV1_001_PRIOR_PASS' 'True'
      exit 0
    }
  } catch {}
}

$lockStream = $null
try {
  $lockStream = [System.IO.File]::Open(
    $lockPath,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
} catch {
  Write-Kv 'MBV1_001_ALREADY_RUNNING' 'True'
  exit 0
}

$tempRoot = Join-Path $env:TEMP ("magasin-mbv1-001-{0}-{1}-{2}" -f $env:GITHUB_RUN_ID, $env:GITHUB_RUN_ATTEMPT, $PID)
$bridgeDir = Join-Path $tempRoot 'chatgpt-bridge'
$bridgeStdout = Join-Path $artifactDir 'bridge-stdout.log'
$bridgeStderr = Join-Path $artifactDir 'bridge-stderr.log'
$bridgeProcess = $null
$bridgePort = 5000
$nodeExit = 1
$startedByQualification = $false
$qualificationBrowserPid = 0
$cdpPort = 0

try {
  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

  $existingChrome = Get-LifecycleRobotChrome -Root $root
  if ($existingChrome) {
    if ($existingChrome.CommandLine -notmatch '--remote-debugging-port=(\d+)') {
      throw 'Dedicated Supervisor Chrome exists without a readable CDP port.'
    }
    $cdpPort = [int]$Matches[1]
    if (-not (Test-Cdp -Port $cdpPort)) {
      throw "Dedicated Supervisor Chrome CDP port $cdpPort is unhealthy."
    }
    Write-Kv 'MBV1_001_DEDICATED_CHROME_REUSED' 'True'
  } else {
    $profileUsers = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*$sourceProfileRoot*" })
    if ($profileUsers.Count -gt 0) {
      throw 'Supervisor browser profile is already in use without a healthy dedicated CDP endpoint.'
    }

    $chrome = Get-QualificationChromeExecutable
    if (-not $chrome) { throw 'Installed Google Chrome not found.' }

    $cdpPort = Get-FreeQualificationCdpPort
    $chromeArgs = @(
      '--remote-debugging-address=127.0.0.1',
      "--remote-debugging-port=$cdpPort",
      ('--user-data-dir="' + $sourceProfileRoot + '"'),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--start-minimized',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
      'https://chatgpt.com/'
    )
    $started = Start-Process -FilePath $chrome -WindowStyle Minimized -PassThru -ArgumentList $chromeArgs
    $startedByQualification = $true

    for ($i = 0; $i -lt 60; $i++) {
      if (Test-Cdp -Port $cdpPort) { break }
      Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Cdp -Port $cdpPort)) {
      throw "Qualification-owned Chrome did not expose healthy CDP on port $cdpPort."
    }

    $browserProcess = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and
        $_.CommandLine -like "*$sourceProfileRoot*" -and
        $_.CommandLine -match ("--remote-debugging-port=" + $cdpPort + "(\s|$)")
      } |
      Select-Object -First 1

    if ($browserProcess) { $qualificationBrowserPid = [int]$browserProcess.ProcessId }
    elseif ($started) { $qualificationBrowserPid = [int]$started.Id }

    Write-Kv 'MBV1_001_DEDICATED_CHROME_REUSED' 'False'
  }

  Write-Kv 'MBV1_001_BROWSER_STARTED_BY_QUALIFICATION' $startedByQualification
  Write-Kv 'MBV1_001_CDP_PORT' $cdpPort
  Write-Kv 'MBV1_001_CDP_HEALTHY' 'True'

  if (Get-NetTCPConnection -State Listen -LocalPort $bridgePort -ErrorAction SilentlyContinue) {
    throw "Bridge qualification port $bridgePort is already in use."
  }

  $pythonCmd = Get-Command python.exe -ErrorAction SilentlyContinue
  if (-not $pythonCmd) {
    throw 'Python is required for chatgpt-bridge but python.exe was not found on the target machine.'
  }
  $python = $pythonCmd.Source
  Write-Kv 'MBV1_001_PYTHON' (& $python --version 2>&1)

  & git clone --no-checkout https://github.com/OLmatter/chatgpt-bridge.git $bridgeDir
  if ($LASTEXITCODE -ne 0) { throw 'Failed to clone chatgpt-bridge.' }
  & git -C $bridgeDir checkout --detach $BridgeCommit
  if ($LASTEXITCODE -ne 0) { throw "Failed to checkout pinned bridge commit $BridgeCommit." }

  $actualCommit = (& git -C $bridgeDir rev-parse HEAD).Trim()
  if ($actualCommit -ne $BridgeCommit) {
    throw "Pinned bridge commit mismatch: expected $BridgeCommit got $actualCommit"
  }
  Write-Kv 'MBV1_001_BRIDGE_COMMIT_PIN' $actualCommit

  $venvDir = Join-Path $tempRoot 'venv'
  & $python -m venv $venvDir
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create Python virtual environment.' }

  $venvPython = Join-Path $venvDir 'Scripts\python.exe'
  & $venvPython -m pip install --disable-pip-version-check -r (Join-Path $bridgeDir 'requirements.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Failed to install pinned bridge dependencies.' }

  $userscriptPath = Join-Path $bridgeDir 'userscript\chatgpt_bridge.user.js'
  $userscriptHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $userscriptPath).Hash.ToLowerInvariant()
  Write-Kv 'MBV1_001_USERSCRIPT_SHA256' $userscriptHash
  Write-Kv 'MBV1_001_USERSCRIPT_TRANSPORT' 'PINNED_UPSTREAM_WITH_PLAYWRIGHT_EXPOSED_GM_BRIDGE'

  $bridgeArgs = @('run.py', '--host', '127.0.0.1', '--port', [string]$bridgePort)
  $bridgeProcess = Start-Process -FilePath $venvPython -WorkingDirectory $bridgeDir -PassThru -RedirectStandardOutput $bridgeStdout -RedirectStandardError $bridgeStderr -ArgumentList $bridgeArgs

  for ($i = 0; $i -lt 60; $i++) {
    if (Test-Bridge -Port $bridgePort) { break }
    if ($bridgeProcess.HasExited) {
      throw "chatgpt-bridge exited early with code $($bridgeProcess.ExitCode)"
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Bridge -Port $bridgePort)) {
    throw 'chatgpt-bridge backend did not become healthy.'
  }
  Write-Kv 'MBV1_001_BRIDGE_SERVICE' 'ONLINE'

  $cdpUrl = "http://127.0.0.1:$cdpPort"
  $bridgeBase = "http://127.0.0.1:$bridgePort"
  $nodeScript = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-mbv1-001-bridge-baseline.mjs'

  & node $nodeScript $cdpUrl $bridgeBase $resultPath $BridgeCommit $userscriptHash $userscriptPath
  $nodeExit = $LASTEXITCODE

  if (Test-Path $resultPath -PathType Leaf) {
    Copy-Item -LiteralPath $resultPath -Destination $persistentResult -Force
  }

  if ($nodeExit -ne 0) {
    throw "MBV1-001 live bridge baseline failed with exit code $nodeExit"
  }

  $result = Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json
  if ([string]$result.status -ne 'PASS') {
    throw 'MBV1-001 result file did not record PASS.'
  }

  Write-Kv 'MBV1_001_STATUS' 'PASS'
} finally {
  if ($startedByQualification) {
    $owned = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and
        $_.CommandLine -like "*$sourceProfileRoot*" -and
        $_.CommandLine -match ("--remote-debugging-port=" + $cdpPort + "(\s|$)")
      })
    foreach ($proc in $owned) {
      Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction SilentlyContinue
    }
    if ($qualificationBrowserPid -gt 0) {
      Stop-Process -Id $qualificationBrowserPid -Force -ErrorAction SilentlyContinue
    }
    Write-Kv 'MBV1_001_QUALIFICATION_CHROME_CLEANUP' 'True'
  }

  if ($bridgeProcess) {
    Stop-Process -Id $bridgeProcess.Id -Force -ErrorAction SilentlyContinue
  }

  if (Test-Path $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }

  if ($lockStream) { $lockStream.Dispose() }
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
