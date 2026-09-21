param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'state-root.ps1')
$root = Get-SupervisorStateRoot
$runtime = Join-Path $root 'runtime'
$disabled = Join-Path $root 'AUTOSTART_DISABLED'
$stop = Join-Path $root 'STOP'
$lifecycleScript = Join-Path $runtime 'windows\lifecycle-truth.ps1'
$bootstrapLog = Join-Path $root 'autostart.log'
$startSupervisor = Join-Path $runtime 'windows\start-supervisor.ps1'
$runnerRoot = 'C:\actions-runner-business\actions-runner'
$runnerCmd = Join-Path $runnerRoot 'run.cmd'

New-Item -ItemType Directory -Force -Path $root | Out-Null

if (-not (Test-Path $lifecycleScript)) {
    throw "Lifecycle truth helper is missing: $lifecycleScript"
}
. $lifecycleScript

function Write-BootstrapLog([string]$Type, [string]$Message) {
    $record = [ordered]@{
        timestamp = [DateTimeOffset]::UtcNow.ToString('o')
        type = $Type
        message = $Message
    }
    ($record | ConvertTo-Json -Compress) | Add-Content -Path $bootstrapLog -Encoding UTF8
}

function Get-CanonicalRunnerProcess {
    return Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.ExecutablePath -and $_.ExecutablePath -like "$runnerRoot*") -or
            ($_.CommandLine -and $_.CommandLine -like "*$runnerRoot*")
        } |
        Select-Object -First 1
}

function Get-SupervisorWrapper {
    return Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like '*run-supervisor.ps1*' -and
            $_.CommandLine -like "*$root*"
        } |
        Select-Object -First 1
}

Write-BootstrapLog 'AUTOSTART_BOOT' 'Business OS autostart bootstrap invoked.'

$ownerStop = Get-LifecycleOwnerStopState -Root $root
if ($ownerStop.blocked) {
    Write-BootstrapLog 'AUTOSTART_DISABLED' 'Owner STOP/AUTOSTART_DISABLED is present; automatic restart is suppressed.'
    exit 0
}

$enabledLaneCount = Get-EnabledLaneCount -Root $root
if ($enabledLaneCount -lt 1) {
    Write-BootstrapLog 'AUTOSTART_ALL_LANES_DISABLED' 'No enabled lane exists; automatic Supervisor startup is not required.'
    exit 0
}

if ($DryRun) {
    Write-BootstrapLog 'AUTOSTART_DRY_RUN' 'Dry run completed without starting processes.'
    exit 0
}

$runner = Get-CanonicalRunnerProcess
if (-not $runner) {
    if (-not (Test-Path $runnerCmd)) {
        Write-BootstrapLog 'RUNNER_MISSING' 'Canonical GitHub Runner run.cmd is missing.'
    } else {
        $env:RUNNER_TRACKING_ID = 'MAGASIN_RUNNER_PERSISTENT'
        $command = 'cd /d "' + $runnerRoot + '" && call run.cmd'
        Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory $runnerRoot -ArgumentList @('/c', $command)
        Write-BootstrapLog 'RUNNER_START_REQUESTED' 'Canonical GitHub Runner start requested.'

        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            $runner = Get-CanonicalRunnerProcess
            if ($runner) { break }
        }

        if ($runner) {
            Write-BootstrapLog 'RUNNER_ONLINE' 'Canonical GitHub Runner is online.'
        } else {
            Write-BootstrapLog 'RUNNER_START_TIMEOUT' 'Runner did not become visible within the bounded wait.'
        }
    }
} else {
    Write-BootstrapLog 'RUNNER_ALREADY_ONLINE' 'Canonical GitHub Runner is already online.'
}

$supervisor = Get-SupervisorWrapper
if ($supervisor) {
    Write-BootstrapLog 'SUPERVISOR_ALREADY_ONLINE' 'Supervisor wrapper is already running.'
    exit 0
}

if (-not (Test-Path $startSupervisor)) {
    Write-BootstrapLog 'SUPERVISOR_RUNTIME_MISSING' 'Installed Supervisor start script is missing.'
    exit 2
}

$env:RUNNER_TRACKING_ID = 'MAGASIN_SUPERVISOR_PERSISTENT'
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startSupervisor -Hidden -Recovery
if ($LASTEXITCODE -ne 0) {
    Write-BootstrapLog 'SUPERVISOR_START_FAILED' "start-supervisor exited with code $LASTEXITCODE."
    exit 3
}

for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    $supervisor = Get-SupervisorWrapper
    if ($supervisor) { break }
}

if ($supervisor) {
    Write-BootstrapLog 'SUPERVISOR_ONLINE' 'Supervisor wrapper is online and may recover the dedicated Business OS Chrome session.'
    exit 0
}

Write-BootstrapLog 'SUPERVISOR_START_TIMEOUT' 'Supervisor wrapper was not visible after bounded wait.'
exit 4
