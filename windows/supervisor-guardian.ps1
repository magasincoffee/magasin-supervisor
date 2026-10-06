param(
    [int]$PollSeconds = 20,
    [int]$WatchdogStaleSeconds = 180,
    [int]$WrapperRestartCooldownSeconds = 90,
    [int]$MaxWrapperRestartsPerHour = 5
)

$ErrorActionPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime = Join-Path $root 'runtime'
$watchdogStatus = Join-Path $root 'local-watchdog-status.json'
$control = Join-Path $root 'single-conversation-control.json'
$statePath = Join-Path $root 'single-conversation-state.json'
$stopPath = Join-Path $root 'STOP'
$autostartDisabled = Join-Path $root 'AUTOSTART_DISABLED'
$runScript = Join-Path $runtime 'windows\run-supervisor.ps1'
$startWatchdog = Join-Path $runtime 'windows\start-local-watchdog.ps1'
$eventsPath = Join-Path $root 'guardian-events.ndjson'
$statusPath = Join-Path $root 'guardian-status.json'
$recoveryPath = Join-Path $root 'guardian-recovery.json'
$pidPath = Join-Path $root 'guardian.pid'
$mutexName = 'Local\MAGASIN_SUPERVISOR_GUARDIAN_V1'
$restartTimes = New-Object System.Collections.Generic.List[datetimeoffset]
$lastWrapperRestart = [DateTimeOffset]::MinValue

function Write-GuardianEvent([string]$Type, [hashtable]$Extra = @{}) {
    $record = [ordered]@{
        timestamp = [DateTimeOffset]::UtcNow.ToString('o')
        type = $Type
    }
    foreach ($key in $Extra.Keys) { $record[$key] = $Extra[$key] }
    ($record | ConvertTo-Json -Compress -Depth 8) | Add-Content -Path $eventsPath -Encoding UTF8
}

function Write-GuardianStatus([hashtable]$Status) {
    $temp = "$statusPath.tmp.$PID"
    ($Status | ConvertTo-Json -Depth 8) | Set-Content -Path $temp -Encoding UTF8
    Move-Item -Path $temp -Destination $statusPath -Force
}

function Test-OwnerStop {
    return [bool]((Test-Path $stopPath) -or (Test-Path $autostartDisabled))
}

function Read-Json([string]$Path) {
    try {
        if (Test-Path $Path -PathType Leaf) {
            return Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        }
    } catch {}
    return $null
}

function Save-RestartHistory {
    $payload = [ordered]@{
        schema_version = 1
        updated_at = [DateTimeOffset]::UtcNow.ToString('o')
        restart_times = @($restartTimes | ForEach-Object { $_.ToString('o') })
    }
    $temp = "$recoveryPath.tmp.$PID"
    ($payload | ConvertTo-Json -Depth 4) | Set-Content -Path $temp -Encoding UTF8
    Move-Item -Path $temp -Destination $recoveryPath -Force
}

function Load-RestartHistory {
    $restartTimes.Clear()
    $record = Read-Json $recoveryPath
    if ($record -and $record.restart_times) {
        $parsed = @()
        foreach ($value in @($record.restart_times)) {
            try {
                $parsed += [DateTimeOffset]::Parse([string]$value)
            } catch {}
        }
        foreach ($value in @($parsed | Sort-Object)) {
            $restartTimes.Add($value)
        }
    }
    if ($restartTimes.Count -gt 0) {
        $script:lastWrapperRestart = $restartTimes[$restartTimes.Count - 1]
    } else {
        $script:lastWrapperRestart = [DateTimeOffset]::MinValue
    }
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

function Get-LocalWatchdog {
    return Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like '*local-watchdog.ps1*' -and
            $_.CommandLine -notlike '*start-local-watchdog.ps1*' -and
            $_.CommandLine -like "*$root*"
        } |
        Select-Object -First 1
}

function Test-SingleConversationControl {
    $record = Read-Json $control
    return [bool](
        $record -and
        [string]$record.schema_version -eq 'single-conversation-control.v1' -and
        [string]$record.mode -eq 'SINGLE_CONVERSATION_V1' -and
        -not [string]::IsNullOrWhiteSpace([string]$record.source_of_truth_url)
    )
}

function Test-StateAllowsProcessRecovery {
    $state = Read-Json $statePath
    if (-not $state) { return $true }

    $status = [string]$state.automation.status
    if ($status -in @('BLOCKED','DONE')) { return $false }
    return [bool]($status -eq 'RUNNING' -or [string]::IsNullOrWhiteSpace($status))
}

function Ensure-LocalWatchdog {
    $watchdog = Get-LocalWatchdog
    $stale = $false

    if (Test-Path $watchdogStatus -PathType Leaf) {
        try {
            $status = Read-Json $watchdogStatus
            if ($status -and $status.timestamp) {
                $age = ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$status.timestamp)).TotalSeconds
                if ($age -gt $WatchdogStaleSeconds) { $stale = $true }
            }
        } catch { $stale = $true }
    } elseif ($watchdog) {
        $stale = $true
    }

    if ($watchdog -and $stale) {
        Write-GuardianEvent 'WATCHDOG_STALE_RESTART' @{ pid = [int]$watchdog.ProcessId }
        Stop-Process -Id ([int]$watchdog.ProcessId) -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
        $watchdog = $null
    }

    if (-not $watchdog -and (Test-Path $startWatchdog -PathType Leaf)) {
        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startWatchdog | Out-Null
        Write-GuardianEvent 'WATCHDOG_START_REQUESTED'
    }
}

function Ensure-GitHubRunner {
    $service = Get-Service -Name 'actions.runner.magasincoffee-magasin-supervisor*' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($service -and $service.Status -ne 'Running') {
        try {
            Start-Service -Name $service.Name
            Write-GuardianEvent 'GITHUB_RUNNER_SERVICE_STARTED' @{ service = $service.Name }
        } catch {
            Write-GuardianEvent 'GITHUB_RUNNER_SERVICE_START_FAILED' @{
                service = $service.Name
                error = [string]$_.Exception.Message
            }
        }
    }
}

function Ensure-SupervisorWrapper {
    if (Test-OwnerStop) { return }
    if (-not (Test-SingleConversationControl)) { return }
    if (-not (Test-StateAllowsProcessRecovery)) { return }
    if (Get-SupervisorWrapper) { return }
    if (-not (Test-Path $runScript -PathType Leaf)) { return }

    $now = [DateTimeOffset]::UtcNow
    $historyChanged = $false
    for ($index = $restartTimes.Count - 1; $index -ge 0; $index--) {
        if (($now - $restartTimes[$index]).TotalHours -ge 1) {
            $restartTimes.RemoveAt($index)
            $historyChanged = $true
        }
    }
    if ($historyChanged) { Save-RestartHistory }

    if ($restartTimes.Count -ge $MaxWrapperRestartsPerHour) {
        Write-GuardianEvent 'WRAPPER_RESTART_RATE_LIMITED' @{ count = $restartTimes.Count }
        return
    }
    if (($now - $lastWrapperRestart).TotalSeconds -lt $WrapperRestartCooldownSeconds) { return }

    # Persist the recovery attempt before process creation. If Guardian itself
    # crashes during launch, the rate budget survives restart and remains fail-closed.
    $lastWrapperRestart = $now
    $restartTimes.Add($now)
    Save-RestartHistory

    # Guardian recovery deliberately launches run-supervisor.ps1 directly.
    # run-supervisor.ps1 re-checks STOP/AUTOSTART_DISABLED before runtime mutation,
    # so a race with a new Owner STOP fails closed. Guardian never clears either latch.
    try {
        $env:RUNNER_TRACKING_ID = 'MAGASIN_SUPERVISOR_GUARDIAN'
        $process = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ErrorAction Stop -ArgumentList @(
            '-NoLogo',
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            ('"' + $runScript + '"')
        )
        Write-GuardianEvent 'WRAPPER_RECOVERY_STARTED' @{
            pid = [int]$process.Id
            restarts_last_hour = $restartTimes.Count
        }
    } catch {
        Write-GuardianEvent 'WRAPPER_RECOVERY_LAUNCH_FAILED' @{
            error = [string]$_.Exception.Message
            restarts_last_hour = $restartTimes.Count
        }
    }
}

$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$ownsMutex = $false
try {
    try {
        $ownsMutex = $mutex.WaitOne(0, $false)
    } catch [System.Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }

    if (-not $ownsMutex) {
        Write-Host 'SUPERVISOR_GUARDIAN_ALREADY_RUNNING=True'
        exit 0
    }

    Set-Content -Path $pidPath -Value $PID -Encoding ascii
    Load-RestartHistory
    Write-GuardianEvent 'GUARDIAN_STARTED' @{
        pid = $PID
        persisted_restarts_last_hour = $restartTimes.Count
    }

    while ($true) {
        try {
            Ensure-GitHubRunner
            Ensure-LocalWatchdog
            Ensure-SupervisorWrapper

            $wrapper = Get-SupervisorWrapper
            $watchdog = Get-LocalWatchdog
            $state = Read-Json $statePath
            $watchdogState = Read-Json $watchdogStatus
            $runner = Get-Service -Name 'actions.runner.magasincoffee-magasin-supervisor*' -ErrorAction SilentlyContinue |
                Select-Object -First 1

            Write-GuardianStatus ([ordered]@{
                schema_version = 1
                timestamp = [DateTimeOffset]::UtcNow.ToString('o')
                pid = $PID
                owner_stop = (Test-OwnerStop)
                control_valid = (Test-SingleConversationControl)
                wrapper_alive = [bool]$wrapper
                watchdog_alive = [bool]$watchdog
                watchdog_mode = if ($watchdogState) { [string]$watchdogState.mode } else { $null }
                automation_status = if ($state) { [string]$state.automation.status } else { $null }
                automation_phase = if ($state) { [string]$state.automation.phase } else { $null }
                github_runner_service = if ($runner) { [string]$runner.Status } else { 'NOT_FOUND' }
                wrapper_restarts_last_hour = $restartTimes.Count
            })
        } catch {
            Write-GuardianEvent 'GUARDIAN_INTERNAL_ERROR' @{ error = [string]$_.Exception.Message }
        }

        Start-Sleep -Seconds ([Math]::Max(10, $PollSeconds))
    }
} finally {
    Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
    if ($ownsMutex) {
        try { $mutex.ReleaseMutex() } catch {}
    }
    $mutex.Dispose()
}