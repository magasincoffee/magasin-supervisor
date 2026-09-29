Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'state-root.ps1')

function Get-MagasinSupervisorRoot {
    return (Get-SupervisorStateRoot -Compatibility 'legacy-preserve')
}

function Read-LifecycleJson([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    try {
        return Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Get-EnabledLaneCount([string]$Root = (Get-MagasinSupervisorRoot)) {
    $singleControl = Read-LifecycleJson (Join-Path $Root 'single-conversation-control.json')
    if (
        $singleControl -and
        [string]$singleControl.mode -eq 'SINGLE_CONVERSATION_V1' -and
        -not [string]::IsNullOrWhiteSpace([string]$singleControl.source_of_truth_url)
    ) {
        return 1
    }

    # Preserve this historical function name as a lifecycle "active unit"
    # compatibility surface. After Planner/Executor cutover, one configured
    # Planner+Executor pair is the single active automation unit.
    $plannerExecutor = Read-LifecycleJson (Join-Path $Root 'planner-executor-state.json')
    if ($plannerExecutor -and [string]$plannerExecutor.mode -eq 'PLANNER_EXECUTOR_V1') {
        $automationStatus = [string]$plannerExecutor.automation.status
        $plannerTarget = [string]$plannerExecutor.planner.target
        $executorTarget = [string]$plannerExecutor.executor.target
        if (
            $automationStatus -notin @('DONE','STOPPED') -and
            -not [string]::IsNullOrWhiteSpace($plannerTarget) -and
            -not [string]::IsNullOrWhiteSpace($executorTarget)
        ) {
            return 1
        }
        return 0
    }

    $config = Read-LifecycleJson (Join-Path $Root 'lanes.json')
    if (-not $config -or -not $config.lanes) { return 0 }
    return @($config.lanes | Where-Object { [bool]$_.enabled }).Count
}

function Get-LifecycleOwnerStopState([string]$Root = (Get-MagasinSupervisorRoot)) {
    $stopPath = Join-Path $Root 'STOP'
    $autostartDisabledPath = Join-Path $Root 'AUTOSTART_DISABLED'
    $stopPresent = Test-Path $stopPath
    $autostartDisabledPresent = Test-Path $autostartDisabledPath
    return [pscustomobject]@{
        stop_present = [bool]$stopPresent
        autostart_disabled_present = [bool]$autostartDisabledPresent
        blocked = [bool]($stopPresent -or $autostartDisabledPresent)
    }
}

function Clear-LifecycleOwnerStopLatches([string]$Root = (Get-MagasinSupervisorRoot)) {
    $stopPath = Join-Path $Root 'STOP'
    $autostartDisabledPath = Join-Path $Root 'AUTOSTART_DISABLED'

    foreach ($path in @($stopPath, $autostartDisabledPath)) {
        if (Test-Path $path) {
            Remove-Item $path -Force -ErrorAction Stop
        }
    }

    $state = Get-LifecycleOwnerStopState -Root $Root
    if ($state.blocked) {
        throw 'Explicit Owner START could not clear STOP/AUTOSTART_DISABLED.'
    }

    return $state
}

function Get-LifecycleSupervisorWrapper([string]$Root = (Get-MagasinSupervisorRoot)) {
    return Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like '*run-supervisor.ps1*' -and
            $_.CommandLine -like "*$Root*"
        } |
        Select-Object -First 1
}

function Get-LifecycleThreeLaneProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like '*three-lane-cli.mjs*'
        })
}

function Get-LifecycleThreeLaneProcess([string]$Root = (Get-MagasinSupervisorRoot)) {
    # A Three-Lane Node is process truth only when it is the direct child of
    # the currently authoritative wrapper for this state root. An orphan Node
    # from a killed/restarted wrapper must never make the Control Panel report
    # THREE-LANE as healthy.
    $wrapper = Get-LifecycleSupervisorWrapper -Root $Root
    if (-not $wrapper) { return $null }

    $wrapperPid = [int]$wrapper.ProcessId
    return Get-LifecycleThreeLaneProcesses |
        Where-Object { [int]$_.ParentProcessId -eq $wrapperPid } |
        Select-Object -First 1
}

function Get-LifecycleSingleConversationProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like '*single-conversation-cli.mjs*'
        })
}

function Get-LifecycleSingleConversationProcess([string]$Root = (Get-MagasinSupervisorRoot)) {
    $wrapper = Get-LifecycleSupervisorWrapper -Root $Root
    if (-not $wrapper) { return $null }
    $wrapperPid = [int]$wrapper.ProcessId
    return Get-LifecycleSingleConversationProcesses |
        Where-Object { [int]$_.ParentProcessId -eq $wrapperPid } |
        Select-Object -First 1
}

function Get-LifecyclePlannerExecutorProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            ($_.CommandLine -like '*planner-executor-cli.mjs*' -or $_.CommandLine -like '*planner-executor-bridge-cli.mjs*')
        })
}

function Get-LifecyclePlannerExecutorProcess([string]$Root = (Get-MagasinSupervisorRoot)) {
    $wrapper = Get-LifecycleSupervisorWrapper -Root $Root
    if (-not $wrapper) { return $null }

    $wrapperPid = [int]$wrapper.ProcessId
    return Get-LifecyclePlannerExecutorProcesses |
        Where-Object { [int]$_.ParentProcessId -eq $wrapperPid } |
        Select-Object -First 1
}

function Get-LifecycleRuntimeMode([string]$Root = (Get-MagasinSupervisorRoot)) {
    $singleControl = Read-LifecycleJson (Join-Path $Root 'single-conversation-control.json')
    if (
        $singleControl -and
        [string]$singleControl.mode -eq 'SINGLE_CONVERSATION_V1' -and
        -not [string]::IsNullOrWhiteSpace([string]$singleControl.source_of_truth_url)
    ) {
        return 'SINGLE_CONVERSATION_V1'
    }

    $plannerExecutor = Read-LifecycleJson (Join-Path $Root 'planner-executor-state.json')
    if ($plannerExecutor -and [string]$plannerExecutor.mode -eq 'PLANNER_EXECUTOR_V1') {
        return 'PLANNER_EXECUTOR_V1'
    }

    $config = Read-LifecycleJson (Join-Path $Root 'lanes.json')
    if ($config -and [string]$config.mode -eq 'THREE_LANE_V1') {
        return 'THREE_LANE_V1'
    }
    return $null
}

function Get-LifecycleOrphanThreeLaneProcesses([string]$Root = (Get-MagasinSupervisorRoot)) {
    $wrapper = Get-LifecycleSupervisorWrapper -Root $Root
    $wrapperPid = if ($wrapper) { [int]$wrapper.ProcessId } else { 0 }

    return @(Get-LifecycleThreeLaneProcesses |
        Where-Object {
            $wrapperPid -le 0 -or
            [int]$_.ParentProcessId -ne $wrapperPid
        })
}

function Get-LifecycleRobotChrome([string]$Root = (Get-MagasinSupervisorRoot)) {
    $profile = Join-Path $Root 'browser_profile'
    return Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like "*$profile*" -and
            $_.CommandLine -match '--remote-debugging-port=(\d+)'
        } |
        Select-Object -First 1
}

function Test-LifecycleRobotCdp(
    $ChromeProcess,
    [string]$Root = (Get-MagasinSupervisorRoot)
) {
    if (-not $ChromeProcess -or -not $ChromeProcess.CommandLine) { return $false }
    $profile = Join-Path $Root 'browser_profile'
    if ($ChromeProcess.CommandLine -notlike "*$profile*") { return $false }
    if ($ChromeProcess.CommandLine -notmatch '--remote-debugging-port=(\d+)') { return $false }
    $port = [int]$Matches[1]

    try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
        return [bool]$version.webSocketDebuggerUrl
    } catch {
        return $false
    }
}

function Get-LifecycleProcessTruth([string]$Root = (Get-MagasinSupervisorRoot)) {
    $wrapper = Get-LifecycleSupervisorWrapper -Root $Root
    $runtimeMode = Get-LifecycleRuntimeMode -Root $Root
    $threeLane = Get-LifecycleThreeLaneProcess -Root $Root
    $plannerExecutor = Get-LifecyclePlannerExecutorProcess -Root $Root
    $singleConversation = Get-LifecycleSingleConversationProcess -Root $Root
    $runtimeProcess = if ($runtimeMode -eq 'SINGLE_CONVERSATION_V1') {
        $singleConversation
    } elseif ($runtimeMode -eq 'PLANNER_EXECUTOR_V1') {
        $plannerExecutor
    } else {
        $threeLane
    }
    $chrome = Get-LifecycleRobotChrome -Root $Root
    $cdpHealthy = Test-LifecycleRobotCdp -ChromeProcess $chrome -Root $Root

    return [pscustomobject]@{
        runtime_mode = [string]$runtimeMode
        wrapper_alive = [bool]$wrapper
        runtime_alive = [bool]$runtimeProcess
        single_conversation_alive = [bool]$singleConversation
        planner_executor_alive = [bool]$plannerExecutor
        three_lane_alive = [bool]$threeLane
        chrome_alive = [bool]$chrome
        cdp_healthy = [bool]$cdpHealthy
        healthy = [bool]($wrapper -and $runtimeProcess -and $chrome -and $cdpHealthy)
    }
}

function Invoke-LifecycleRecoveryStart(
    [string]$StartScript,
    [string]$Root = (Get-MagasinSupervisorRoot)
) {
    $enabledLaneCount = Get-EnabledLaneCount -Root $Root
    if ($enabledLaneCount -lt 1) {
        return [pscustomobject]@{
            state = 'ALL_DISABLED'
            start_requested = $false
        }
    }

    $ownerStop = Get-LifecycleOwnerStopState -Root $Root
    if ($ownerStop.blocked) {
        return [pscustomobject]@{
            state = 'OWNER_STOP'
            start_requested = $false
        }
    }

    $processTruth = Get-LifecycleProcessTruth -Root $Root
    if ($processTruth.healthy) {
        return [pscustomobject]@{
            state = 'HEALTHY'
            start_requested = $false
        }
    }

    if (-not $processTruth.wrapper_alive) {
        if (-not (Test-Path $StartScript)) {
            return [pscustomobject]@{
                state = 'RUNTIME_MISSING'
                start_requested = $false
            }
        }

        Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
            '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
            '-File',('"' + $StartScript + '"'),
            '-Hidden',
            '-Recovery'
        )

        return [pscustomobject]@{
            state = 'STARTING'
            start_requested = $true
        }
    }

    return [pscustomobject]@{
        state = 'RECOVERING'
        start_requested = $false
    }
}
