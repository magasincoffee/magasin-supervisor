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

function Get-LifecycleThreeLaneProcess([string]$Root = (Get-MagasinSupervisorRoot)) {
    $runtimeRoot = Join-Path $Root 'runtime'
    return Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like '*three-lane-cli.mjs*' -and
            $_.CommandLine -like "*$runtimeRoot*"
        } |
        Select-Object -First 1
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

function Get-LifecycleLaneStatusFreshness(
    [string]$Root = (Get-MagasinSupervisorRoot),
    [int]$StaleAfterSeconds = 120,
    [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
) {
    $threshold = [Math]::Max(5, $StaleAfterSeconds)
    $statusPath = Join-Path $Root 'lane-status.json'

    if (-not (Test-Path $statusPath)) {
        return [pscustomobject]@{
            present = $false
            readable = $false
            updated_at = $null
            age_seconds = $null
            stale_after_seconds = $threshold
            stale = $true
            reason = 'STATUS_MISSING'
        }
    }

    $status = Read-LifecycleJson $statusPath
    if (-not $status) {
        return [pscustomobject]@{
            present = $true
            readable = $false
            updated_at = $null
            age_seconds = $null
            stale_after_seconds = $threshold
            stale = $true
            reason = 'STATUS_UNREADABLE'
        }
    }

    $updatedAt = [DateTimeOffset]::MinValue
    if (
        -not $status.PSObject.Properties['updated_at'] -or
        -not [DateTimeOffset]::TryParse([string]$status.updated_at, [ref]$updatedAt)
    ) {
        return [pscustomobject]@{
            present = $true
            readable = $true
            updated_at = $null
            age_seconds = $null
            stale_after_seconds = $threshold
            stale = $true
            reason = 'STATUS_TIMESTAMP_INVALID'
        }
    }

    $age = [Math]::Max(0, [Math]::Floor(
        ($Now.ToUniversalTime() - $updatedAt.ToUniversalTime()).TotalSeconds
    ))
    $stale = [bool]($age -gt $threshold)
    return [pscustomobject]@{
        present = $true
        readable = $true
        updated_at = $updatedAt.ToUniversalTime().ToString('o')
        age_seconds = [long]$age
        stale_after_seconds = $threshold
        stale = $stale
        reason = $(if ($stale) { 'STATUS_STALE' } else { 'STATUS_FRESH' })
    }
}

function Get-LifecycleProcessTruth(
    [string]$Root = (Get-MagasinSupervisorRoot),
    [int]$StatusStaleAfterSeconds = 120
) {
    $wrapper = Get-LifecycleSupervisorWrapper -Root $Root
    $threeLane = Get-LifecycleThreeLaneProcess -Root $Root
    $chrome = Get-LifecycleRobotChrome -Root $Root
    $cdpHealthy = Test-LifecycleRobotCdp -ChromeProcess $chrome -Root $Root
    $freshness = Get-LifecycleLaneStatusFreshness -Root $Root -StaleAfterSeconds $StatusStaleAfterSeconds

    $nodeDown = [bool]($wrapper -and $chrome -and $cdpHealthy -and -not $threeLane)
    $statusStale = [bool]($threeLane -and $freshness.stale)

    return [pscustomobject]@{
        wrapper_alive = [bool]$wrapper
        three_lane_alive = [bool]$threeLane
        chrome_alive = [bool]$chrome
        cdp_healthy = [bool]$cdpHealthy
        lane_status_present = [bool]$freshness.present
        lane_status_readable = [bool]$freshness.readable
        lane_status_updated_at = $freshness.updated_at
        status_age_seconds = $freshness.age_seconds
        status_stale_after_seconds = [int]$freshness.stale_after_seconds
        status_stale = $statusStale
        node_down = $nodeDown
        runtime_state = $(if ($nodeDown) {
            'NODE_DOWN'
        } elseif ($statusStale) {
            'STATUS_STALE'
        } elseif ($wrapper -and $threeLane -and $chrome -and $cdpHealthy) {
            'HEALTHY'
        } elseif (-not $wrapper) {
            'WRAPPER_DOWN'
        } else {
            'RECOVERING'
        })
        healthy = [bool](
            $wrapper -and
            $threeLane -and
            $chrome -and
            $cdpHealthy -and
            -not $freshness.stale
        )
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

    if ($processTruth.node_down) {
        return [pscustomobject]@{
            state = 'NODE_DOWN'
            start_requested = $false
        }
    }

    if ($processTruth.status_stale) {
        return [pscustomobject]@{
            state = 'STATUS_STALE'
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
