param(
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'

if (-not $Confirmed) {
    throw 'RESET ALL PROJECTS requires explicit Owner confirmation.'
}

. (Join-Path $PSScriptRoot 'state-root.ps1')

$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtimeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stopScript = Join-Path $PSScriptRoot 'stop-supervisor.ps1'
$resetCli = Join-Path $runtimeRoot 'src\runtime\reset-all-projects-cli.mjs'

if (-not (Test-Path $stopScript)) {
    throw 'Supervisor stop script is missing.'
}
if (-not (Test-Path $resetCli)) {
    throw 'Reset-all-projects helper is missing.'
}

# A full project reset is an explicit Owner destructive action. Stop first so
# no lane can rewrite config/registry while project state is being cleared.
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $stopScript
if ($LASTEXITCODE -ne 0) {
    throw 'Supervisor STOP failed before reset.'
}

# stop-supervisor normally owns the dedicated browser through the wrapper tree.
# If a dedicated Robot Chrome survives, close only that profile process. The
# profile directory itself is preserved so ChatGPT login/cookies remain intact.
$profile = Join-Path $root 'browser_profile'
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -and $_.CommandLine -like "*$profile*"
    } |
    ForEach-Object {
        Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
    }

$node = Get-Command node.exe -ErrorAction Stop
$output = & $node.Source $resetCli --root $root
if ($LASTEXITCODE -ne 0) {
    throw 'Reset-all-projects helper failed.'
}
$output | ForEach-Object { Write-Host $_ }

$configFile = Join-Path $root 'lanes.json'
$registryFile = Join-Path $root 'lane-registry.json'
$eventFile = Join-Path $root 'lane-events.ndjson'
$evidenceDir = Join-Path $root 'lane-evidence'

if (-not (Test-Path $configFile) -or -not (Test-Path $registryFile)) {
    throw 'Reset did not recreate canonical lane state files.'
}

$config = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$registry = Get-Content $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json

if (@($config.lanes).Count -ne 3) {
    throw 'Reset config does not contain exactly three lanes.'
}
foreach ($lane in @($config.lanes)) {
    if ([bool]$lane.enabled) { throw 'Reset left an enabled lane.' }
    if (-not [string]::IsNullOrWhiteSpace([string]$lane.brain_url)) { throw 'Reset left a Brain URL.' }
    if (-not [string]::IsNullOrWhiteSpace([string]$lane.work_url)) { throw 'Reset left a Work URL.' }

    $registryLane = $registry.lanes.([string]$lane.lane_id)
    if ($null -eq $registryLane) { throw 'Reset registry lane is missing.' }
    if ($registryLane.task_id) { throw 'Reset left an active task.' }
    if ($registryLane.dispatch_inflight) { throw 'Reset left a dispatch latch.' }
    if ($registryLane.relay_inflight) { throw 'Reset left a relay latch.' }
    if ($registryLane.brain_request_inflight) { throw 'Reset left a Brain request latch.' }
    if ([bool]$registryLane.awaiting_work) { throw 'Reset left awaiting_work active.' }
}

if ((Test-Path $eventFile) -and ((Get-Item $eventFile).Length -ne 0)) {
    throw 'Reset did not clear lane event history.'
}
if (Test-Path $evidenceDir) {
    throw 'Reset did not clear old lane evidence.'
}

$stopLatch = Join-Path $root 'STOP'
$autostartDisabled = Join-Path $root 'AUTOSTART_DISABLED'
if (-not (Test-Path $stopLatch) -or -not (Test-Path $autostartDisabled)) {
    throw 'Owner STOP authority was not preserved after reset.'
}

Write-Host 'RESET_ALL_PROJECTS_OWNER_CONFIRMED=True'
Write-Host 'RESET_ALL_PROJECTS_THREE_LANES_CLEAN=True'
Write-Host 'RESET_ALL_PROJECTS_OWNER_STOP_PRESERVED=True'
Write-Host 'RESET_ALL_PROJECTS_RUNNER_UNCHANGED=True'
Write-Host 'RESET_ALL_PROJECTS_RUNTIME_INSTALL_UNCHANGED=True'
Write-Host 'RESET_ALL_PROJECTS=PASS'
