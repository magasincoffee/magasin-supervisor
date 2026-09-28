param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Write-Host "MBV1_008_QUAL_MACHINE=$env:COMPUTERNAME"
if ($env:COMPUTERNAME -ne $TargetComputer) {
  throw "MBV1-008 target qualification must run on $TargetComputer."
}

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\chatgpt-bridge-runtime.ps1')

$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$profile = Join-Path $root 'browser_profile'
$diagDir = Join-Path $root 'diagnostics\mbv1-008-live'
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

$workRoot = Join-Path $env:RUNNER_TEMP ("mbv1-008-" + [Guid]::NewGuid().ToString('N'))
$bridgeProcess = $null
$startedBrowser = $false
$qualificationBrowserPid = 0
$cdpPort = 0

try {
  if (Test-ChatGptBridgeHealth) {
    throw 'Port 5000 already hosts a Bridge service; qualification refuses to share production transport.'
  }

  [void](Install-ChatGptBridgeRuntime -Root $workRoot)
  $bridgeInfo = Assert-ChatGptBridgePinnedInstall -Root $workRoot
  $bridgeProcess = Start-ChatGptBridgeBackend -Root $workRoot

  $existingChrome = Get-LifecycleRobotChrome -Root $root
  if ($existingChrome) {
    if ($existingChrome.CommandLine -notmatch '--remote-debugging-port=(\d+)') {
      throw 'Dedicated Supervisor Chrome exists without readable CDP port.'
    }
    $cdpPort = [int]$Matches[1]
    if (-not (Test-QualificationCdp -Port $cdpPort)) {
      throw "Dedicated Supervisor Chrome CDP port $cdpPort is unhealthy."
    }
    Write-Host 'MBV1_008_EXISTING_DEDICATED_CHROME=True'
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
      '--hide-crash-restore-bubble',
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
    Write-Host 'MBV1_008_EXISTING_DEDICATED_CHROME=False'
  }

  $env:MBV1_008_CDP_URL = "http://127.0.0.1:$cdpPort"
  $env:MBV1_008_BRIDGE_ROOT = $bridgeInfo.RepoRoot
  $env:MBV1_008_BRIDGE_PYTHON = $bridgeInfo.Python
  $env:MBV1_008_BRIDGE_PID = [string]$bridgeProcess.Id
  $env:MBV1_008_DIAG_DIR = $diagDir

  Write-Host "MBV1_008_CDP_PORT=$cdpPort"
  Write-Host 'MBV1_008_BRIDGE_PIN_VERIFIED=True'
  Write-Host "MBV1_008_BRIDGE_UPSTREAM_COMMIT=$script:ChatGptBridgePinnedCommit"

  $scriptPath = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-mbv1-008-live-qualification.mjs'
  & node $scriptPath
  if ($LASTEXITCODE -ne 0) {
    throw "MBV1-008 live qualification failed with exit code $LASTEXITCODE"
  }

  Write-Host 'MBV1_008_TARGET_QUALIFICATION=PASS'
  Write-Host 'MBV1_008_PRODUCTION_STATE_MUTATED=False'
  Write-Host 'MBV1_008_PRODUCTION_TARGETS_MUTATED=False'
} finally {
  if ($bridgeProcess) {
    Stop-ChatGptBridgeBackend -Process $bridgeProcess
  }
  Stop-ChatGptBridgeRuntimeProcesses -Root $workRoot -ErrorAction SilentlyContinue

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
    Write-Host 'MBV1_008_ISOLATED_CHROME_CLEANUP=True'
  }

  Remove-Item $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}
