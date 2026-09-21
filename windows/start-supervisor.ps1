param(
    [switch]$DryRun,
    [switch]$Hidden,
    [switch]$Recovery
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'state-root.ps1')
$root = Get-SupervisorStateRoot
$runtime = Join-Path $root 'runtime'
$runScript = Join-Path $runtime 'windows\run-supervisor.ps1'
$lifecycleScript = Join-Path $runtime 'windows\lifecycle-truth.ps1'
$pidFile = Join-Path $root 'supervisor.pid'
$stop = Join-Path $root 'STOP'
$autostartDisabled = Join-Path $root 'AUTOSTART_DISABLED'

if (-not (Test-Path $runScript)) {
    throw "Supervisor runtime is not installed: $runScript"
}
if (-not (Test-Path $lifecycleScript)) {
    throw "Lifecycle truth helper is not installed: $lifecycleScript"
}

. $lifecycleScript

if ($Recovery) {
    # Recovery is never Owner authority. It must fail closed before any
    # "already running" shortcut and must never clear STOP/AUTOSTART_DISABLED.
    $ownerStop = Get-LifecycleOwnerStopState -Root $root
    if ($ownerStop.blocked) {
        Write-Host 'RECOVERY_START_BLOCKED_OWNER_STOP=True'
        exit 0
    }

    $enabledLaneCount = Get-EnabledLaneCount -Root $root
    if ($enabledLaneCount -lt 1) {
        Write-Host 'RECOVERY_START_SKIPPED_ALL_LANES_DISABLED=True'
        exit 0
    }
} else {
    # Explicit Owner START is the sole normal authority that clears lifecycle
    # STOP latches. This happens BEFORE any wrapper/PID early return.
    $ownerStopAfterClear = Clear-LifecycleOwnerStopLatches -Root $root
    if ($ownerStopAfterClear.blocked) {
        throw 'Explicit Owner START could not clear STOP/AUTOSTART_DISABLED.'
    }
    Write-Host 'OWNER_START_LATCH_CLEAR=True'
}

$existingWrapper = Get-LifecycleSupervisorWrapper -Root $root
if ($existingWrapper) {
    Set-Content -Path $pidFile -Value $existingWrapper.ProcessId -Encoding ascii
    if (-not $Recovery) {
        $ownerStopBeforeReturn = Get-LifecycleOwnerStopState -Root $root
        if ($ownerStopBeforeReturn.blocked) {
            throw 'Explicit Owner START refused success because Owner STOP remains active.'
        }
        Write-Host 'OWNER_START_EXISTING_WRAPPER_REUSED=True'
    }
    Write-Host "Supervisor wrapper already running (PID $($existingWrapper.ProcessId))."
    exit 0
}

if (Test-Path $pidFile) {
    $existing = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    $existingProcess = $null
    $parsedPid = 0
    if ($existing -and [int]::TryParse([string]$existing, [ref]$parsedPid)) {
        $existingProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$parsedPid" -ErrorAction SilentlyContinue |
            Select-Object -First 1
    }

    if ($existingProcess) {
        $looksLikeWrapper = [bool](
            $existingProcess.Name -eq 'powershell.exe' -and
            $existingProcess.CommandLine -and
            $existingProcess.CommandLine -like '*run-supervisor.ps1*' -and
            $existingProcess.CommandLine -like "*$root*"
        )
        if ($looksLikeWrapper) {
            if (-not $Recovery) {
                $ownerStopBeforeReturn = Get-LifecycleOwnerStopState -Root $root
                if ($ownerStopBeforeReturn.blocked) {
                    throw 'Explicit Owner START refused success because Owner STOP remains active.'
                }
                Write-Host 'OWNER_START_EXISTING_WRAPPER_REUSED=True'
            }
            Write-Host "Supervisor wrapper already running (PID $parsedPid)."
            exit 0
        }

        # PID reuse/stale pid file is not proof that Supervisor is running.
        # Never kill an unrelated process; discard only the stale pid record.
        Remove-Item $pidFile -Force -ErrorAction Stop
        Write-Host 'STALE_SUPERVISOR_PID_IGNORED=True'
    } else {
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
}

# Prevent GitHub Actions orphan-process cleanup from claiming the persistent Supervisor shell.
$env:RUNNER_TRACKING_ID = 'MAGASIN_SUPERVISOR_PERSISTENT'

$args = @(
    '-NoLogo',
    '-ExecutionPolicy', 'Bypass',
    '-File', ('"' + $runScript + '"')
)
if ($DryRun) { $args += '-DryRun' }

if ($Hidden) {
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList $args
    Write-Host 'MAGASIN Supervisor started in background mode.'
} else {
    $visibleArgs = @('-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $runScript + '"'))
    if ($DryRun) { $visibleArgs += '-DryRun' }
    Start-Process powershell.exe -ArgumentList $visibleArgs
    Write-Host 'MAGASIN Supervisor started in a separate PowerShell window.'
}
