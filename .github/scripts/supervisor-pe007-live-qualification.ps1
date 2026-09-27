param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Write-Host "PE007_QUAL_MACHINE=$env:COMPUTERNAME"
if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Host 'PE007_QUAL_TARGET_MATCH=False'
  Write-Host 'PE007_QUAL_SKIP_SAFE=True'
  exit 0
}
Write-Host 'PE007_QUAL_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

# Resolve authoritative local root only. Qualification must not persist or
# rewrite SUPERVISOR_STATE_ROOT.
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$profile = Join-Path $root 'browser_profile'

Write-Host "PE007_QUAL_STATE_ROOT=$root"
Write-Host "PE007_QUAL_REVISION=$env:GITHUB_SHA"
Write-Host "PE007_QUAL_STATE_ROOT_BINDING_MUTATED=False"

function Get-QualificationChromeExecutable {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
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

$startedByQualification = $false
$qualificationBrowserPid = 0
$cdpPort = 0

$existingChrome = Get-LifecycleRobotChrome -Root $root
if ($existingChrome) {
  if ($existingChrome.CommandLine -notmatch '--remote-debugging-port=(\d+)') {
    throw 'Dedicated Supervisor Chrome exists without a readable CDP port.'
  }
  $cdpPort = [int]$Matches[1]
  if (-not (Test-QualificationCdp -Port $cdpPort)) {
    throw "Dedicated Supervisor Chrome exists but CDP port $cdpPort is unhealthy."
  }
  Write-Host 'PE007_QUAL_EXISTING_DEDICATED_CHROME=True'
} else {
  # Never start/repair/stop the Supervisor runtime. If its browser is absent,
  # launch a qualification-owned browser only if the exact profile is unused.
  $profileUsers = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" })
  if ($profileUsers.Count -gt 0) {
    throw 'Supervisor browser profile is already in use without a healthy dedicated CDP endpoint.'
  }

  $chrome = Get-QualificationChromeExecutable
  if (-not $chrome) { throw 'Installed Google Chrome not found.' }

  $cdpPort = Get-FreeQualificationCdpPort
  Write-Host "PE007_QUAL_STARTING_ISOLATED_CDP_PORT=$cdpPort"

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
  $startedByQualification = $true

  for ($i = 0; $i -lt 30; $i++) {
    if (Test-QualificationCdp -Port $cdpPort) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-QualificationCdp -Port $cdpPort)) {
    throw "Qualification-owned Chrome did not expose healthy CDP on port $cdpPort."
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

  Write-Host 'PE007_QUAL_EXISTING_DEDICATED_CHROME=False'
}

$cdpUrl = "http://127.0.0.1:$cdpPort"
Write-Host "PE007_QUAL_CDP_PORT=$cdpPort"
Write-Host 'PE007_QUAL_CDP_HEALTHY=True'
Write-Host "PE007_QUAL_BROWSER_STARTED_BY_QUALIFICATION=$startedByQualification"

$env:SUPERVISOR_PE007_CDP_URL = $cdpUrl
$env:SUPERVISOR_PE007_BROWSER_STARTED = if ($startedByQualification) { 'true' } else { 'false' }

$script = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-pe007-live-qualification.mjs'
if (-not (Test-Path $script -PathType Leaf)) {
  throw "Missing qualification script: $script"
}

$nodeExit = 1
try {
  & node $script $root $env:GITHUB_SHA
  $nodeExit = $LASTEXITCODE
} finally {
  if ($startedByQualification) {
    # No process used this exact profile before launch. Close only the
    # qualification-owned dedicated browser, never the Owner's normal Chrome.
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
    Write-Host 'PE007_QUAL_ISOLATED_CHROME_CLEANUP=True'
  }
}

if ($nodeExit -ne 0) {
  throw "PE-007 live qualification failed with exit code $nodeExit"
}
