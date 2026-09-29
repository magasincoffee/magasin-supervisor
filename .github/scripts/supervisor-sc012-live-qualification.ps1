param(
  [Parameter(Mandatory=$true)]
  [string]$TargetComputer,
  [int]$Attempt = 1,
  [int]$NonTargetHoldSeconds = 90
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

function Set-JobOutput([string]$Name,[string]$Value){
  "$Name=$Value" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
}

function Get-FreeQualificationCdpPort {
  foreach ($candidate in 9222..9232) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $listener) { return [int]$candidate }
  }
  throw 'No free Supervisor CDP port is available.'
}

function Ensure-QualificationChrome([string]$Root) {
  $profile = Join-Path $Root 'browser_profile'
  $existing = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" })

  foreach ($proc in $existing) {
    if ($proc.CommandLine -match '--remote-debugging-port=(\d+)') {
      $port = [int]$Matches[1]
      try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
        if ($version.webSocketDebuggerUrl) { return $port }
      } catch {}
    }
  }

  foreach ($proc in $existing) {
    Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500

  $chromeCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  $chrome = $chromeCandidates |
    Where-Object { $_ -and (Test-Path $_ -PathType Leaf) } |
    Select-Object -First 1
  if (-not $chrome) { throw 'Installed Google Chrome not found.' }

  $port = Get-FreeQualificationCdpPort
  Start-Process -FilePath $chrome -WindowStyle Minimized -ArgumentList @(
    '--remote-debugging-address=127.0.0.1',
    "--remote-debugging-port=$port",
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

  for ($i = 0; $i -lt 40; $i++) {
    try {
      $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
      if ($version.webSocketDebuggerUrl) { return $port }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  throw 'Dedicated Supervisor Chrome did not expose a healthy CDP endpoint.'
}

Write-Host "SC012_QUAL_ATTEMPT=$Attempt"
Write-Host "SC012_QUAL_MACHINE=$env:COMPUTERNAME"

if($env:COMPUTERNAME -ne $TargetComputer){
  Set-JobOutput 'target_match' 'false'
  Set-JobOutput 'qualified' 'false'
  Write-Host 'SC012_QUAL_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}

Set-JobOutput 'target_match' 'true'
Write-Host 'SC012_QUAL_TARGET_MATCH=True'

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
. (Join-Path $env:GITHUB_WORKSPACE 'windows\lifecycle-truth.ps1')

$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime = Join-Path $root 'runtime'
$installedStop = Join-Path $runtime 'windows\stop-supervisor.ps1'
$stopPath = Join-Path $root 'STOP'
$autostartDisabledPath = Join-Path $root 'AUTOSTART_DISABLED'

if(Test-Path $installedStop -PathType Leaf){
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installedStop
  Write-Host 'SC012_QUAL_PREFLIGHT_PRODUCTION_STOP=True'
} else {
  Set-Content -Path $stopPath -Value 'SC012_QUALIFICATION_STOP' -Encoding ascii
  Set-Content -Path $autostartDisabledPath -Value 'SC012_QUALIFICATION_STOP' -Encoding ascii
}

for($i=0;$i -lt 30;$i++){
  if(-not (Get-LifecycleSupervisorWrapper -Root $root)){ break }
  Start-Sleep -Milliseconds 250
}
if(Get-LifecycleSupervisorWrapper -Root $root){
  throw 'SC-012 could not stop the pre-fix production wrapper.'
}

$cdpPort = Ensure-QualificationChrome -Root $root
$env:SUPERVISOR_SC012_CDP_URL = "http://127.0.0.1:$cdpPort"
Write-Host "SC012_QUAL_CDP_PORT=$cdpPort"
Write-Host 'SC012_QUAL_CDP_HEALTHY=True'

$script = Join-Path $env:GITHUB_WORKSPACE '.github\scripts\supervisor-sc012-live-qualification.mjs'
& node $script $root $env:GITHUB_SHA
$nodeExit = $LASTEXITCODE
if($nodeExit -ne 0){
  Set-JobOutput 'qualified' 'false'
  throw "SC-012 live qualification failed with exit $nodeExit."
}

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $env:GITHUB_WORKSPACE 'windows\install-supervisor.ps1') -SourceRoot $env:GITHUB_WORKSPACE
if($LASTEXITCODE -ne 0){ throw "SC-012 candidate install failed with exit $LASTEXITCODE." }

$installedRollover = Join-Path $root 'runtime\src\runtime\single-conversation-rollover.mjs'
$installedRun = Join-Path $root 'runtime\windows\run-supervisor.ps1'
if(-not (Test-Path $installedRollover) -or -not (Test-Path $installedRun)){
  throw 'SC-012 installed candidate files are missing.'
}
if((Get-Content $installedRollover -Raw -Encoding UTF8) -notmatch 'never close the current/last Chrome page before a replacement'){
  throw 'SC-012 rollover fix is not installed.'
}
if((Get-Content $installedRun -Raw -Encoding UTF8) -notmatch 'SINGLE_CONVERSATION_BLOCKED_PAUSE=True'){
  throw 'SC-012 wrapper BLOCKED pause fix is not installed.'
}

$ownerStop = Get-LifecycleOwnerStopState -Root $root
if(-not $ownerStop.blocked){
  throw 'SC-012 qualification/install unexpectedly cleared Owner STOP.'
}

Write-Host 'SC012_QUAL_CANDIDATE_INSTALLED=True'
Write-Host 'SC012_QUAL_OWNER_STOP_PRESERVED=True'
Write-Host 'SC012_QUAL_QUALIFIED=True'
Set-JobOutput 'qualified' 'true'
exit 0
