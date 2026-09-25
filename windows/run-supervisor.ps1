param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'state-root.ps1')
. (Join-Path $PSScriptRoot 'lifecycle-truth.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime = Join-Path $root 'runtime'
$profile = Join-Path $root 'browser_profile'
$target = Join-Path $root 'target.json'
$stop = Join-Path $root 'STOP'
$autostartDisabled = Join-Path $root 'AUTOSTART_DISABLED'
$pidFile = Join-Path $root 'supervisor.pid'
$registryFile = Join-Path $root 'orchestration.json'
$runtimeStatusFile = Join-Path $root 'runtime-status.json'
$laneConfigFile = Join-Path $root 'lanes.json'
$laneStatusFile = Join-Path $root 'lane-status.json'
$wrapperLogFile = Join-Path $root 'wrapper.log'
$projectAdapterPath = [string]$env:SUPERVISOR_PROJECT_ADAPTER_PATH
$projectAdapterUrl = [string]$env:SUPERVISOR_PROJECT_ADAPTER_URL
if (-not [string]::IsNullOrWhiteSpace($projectAdapterPath) -and -not [string]::IsNullOrWhiteSpace($projectAdapterUrl)) {
    throw 'Configure exactly one project adapter source: SUPERVISOR_PROJECT_ADAPTER_PATH or SUPERVISOR_PROJECT_ADAPTER_URL.'
}

function Read-ConfiguredProjectAdapterState {
    $adapter = $null
    if (-not [string]::IsNullOrWhiteSpace($projectAdapterPath)) {
        if (-not (Test-Path $projectAdapterPath)) { throw "Configured project adapter file is missing: $projectAdapterPath" }
        $adapter = Get-Content $projectAdapterPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } elseif (-not [string]::IsNullOrWhiteSpace($projectAdapterUrl)) {
        $adapter = Invoke-RestMethod -Uri $projectAdapterUrl -TimeoutSec 4 -Headers @{ 'Cache-Control'='no-cache' }
    } else {
        return $null
    }

    if ([string]$adapter.schema_version -ne 'supervisor-project-adapter.v1' -or -not $adapter.project_state) {
        throw 'Configured project adapter does not satisfy supervisor-project-adapter.v1.'
    }
    return $adapter.project_state
}

function Get-WrapperRuntimeVersion {
    try {
        $runtimeFile = Join-Path $runtime 'src\runtime\three-lane-cli.mjs'
        if (-not (Test-Path $runtimeFile)) { return 'UNKNOWN' }
        $text = Get-Content $runtimeFile -Raw -Encoding UTF8
        $match = [regex]::Match($text, 'SUPERVISOR_RUNTIME_VERSION\s*=\s*"([^"]+)"')
        if ($match.Success -and $match.Groups[1].Value -match '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}
function Resolve-LocalRuntimeMode {
    # Platform-local orchestration truth is allowed to select the runtime
    # even when no project adapter is configured. It does not provide project
    # business state and therefore does not violate the explicit adapter boundary.
    try {
        if (Test-Path $laneStatusFile) {
            $laneStatus = Get-Content $laneStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$laneStatus.mode -eq 'THREE_LANE_V1') {
                return 'THREE_LANE_V1'
            }
        }
    } catch {}

    try {
        if (Test-Path $laneConfigFile) {
            $laneConfig = Get-Content $laneConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$laneConfig.mode -eq 'THREE_LANE_V1') {
                return 'THREE_LANE_V1'
            }
        }
    } catch {}

    try {
        if (Test-Path $registryFile) {
            $registry = Get-Content $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$registry.mode -eq 'BRAIN_WORKER_V1') {
                return 'BRAIN_WORKER_V1'
            }
        }
    } catch {}

    try {
        if (Test-Path $runtimeStatusFile) {
            $runtimeStatus = Get-Content $runtimeStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$runtimeStatus.orchestration_mode -eq 'BRAIN_WORKER_V1') {
                return 'BRAIN_WORKER_V1'
            }
        }
    } catch {}

    return $null
}

$mutexName = if (-not [string]::IsNullOrWhiteSpace([string]$env:SUPERVISOR_MUTEX_NAME)) {
    [string]$env:SUPERVISOR_MUTEX_NAME
} else {
    'Local\MAGASIN_BUSINESS_OS_SUPERVISOR'
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
        Write-Host 'Another MAGASIN Supervisor wrapper already owns the singleton mutex.'
        exit 0
    }
} catch {
    $mutex.Dispose()
    throw
}

function Get-DedicatedChromeProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" })
}

function Stop-DedicatedChrome {
    # Only terminate Chrome processes that explicitly use the dedicated
    # Supervisor profile. Never touch the Owner's normal Chrome profile.
    Get-DedicatedChromeProcesses | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Get-ExistingDedicatedCdpPort {
    foreach ($process in (Get-DedicatedChromeProcesses)) {
        if ($process.CommandLine -match '--remote-debugging-port=(\d+)') {
            return [int]$Matches[1]
        }
    }
    return $null
}

function Get-FreeCdpPort {
    foreach ($candidate in 9222..9232) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $listener) { return $candidate }
    }
    throw 'No free Supervisor CDP port in range 9222-9232.'
}

function Test-DedicatedCdpEndpoint([int]$Port) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $listener) { return $false }

    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (
        -not $owner -or
        $owner.Name -ne 'chrome.exe' -or
        -not $owner.CommandLine -or
        $owner.CommandLine -notlike "*$profile*" -or
        $owner.CommandLine -notmatch ("--remote-debugging-port=" + $Port + "(\s|$)")
    ) {
        return $false
    }

    try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
        return [bool]$version.webSocketDebuggerUrl
    } catch {
        return $false
    }
}

function Get-ThreeLaneStatusStaleSeconds {
    $value = 120
    $parsed = 0
    if (
        [int]::TryParse([string]$env:SUPERVISOR_STATUS_STALE_SECONDS, [ref]$parsed) -and
        $parsed -ge 5
    ) {
        $value = $parsed
    }
    return $value
}

function Invoke-MonitoredThreeLaneNode(
    [string[]]$NodeArgs,
    [int]$CdpPort
) {
    $threshold = Get-ThreeLaneStatusStaleSeconds
    $startedAt = [DateTimeOffset]::UtcNow
    $nodeProcess = Start-Process -FilePath 'node.exe' -ArgumentList $NodeArgs -PassThru -NoNewWindow
    $staleRestart = $false

    Write-WrapperLog 'THREE_LANE_MONITOR_STARTED' @{
        pid = [int]$nodeProcess.Id
        stale_after_seconds = [int]$threshold
        cdp_port = $CdpPort
    }

    while (-not $nodeProcess.HasExited) {
        if ((Test-Path $stop) -or (Test-Path $autostartDisabled)) {
            break
        }

        $elapsed = ([DateTimeOffset]::UtcNow - $startedAt).TotalSeconds
        if ($elapsed -ge $threshold) {
            $freshness = Get-LifecycleLaneStatusFreshness -Root $root -StaleAfterSeconds $threshold
            if ($freshness.stale) {
                Write-Host 'THREE-LANE STATUS_STALE detected; restarting Node without mutating lane/project state.'
                Write-Host 'SUPERVISOR_P4_STATUS_STALE_DETECTED=True'
                Write-WrapperLog 'THREE_LANE_STATUS_STALE_RESTART' @{
                    pid = [int]$nodeProcess.Id
                    status_age_seconds = $freshness.age_seconds
                    stale_after_seconds = [int]$threshold
                    status_reason = [string]$freshness.reason
                    cdp_port = $CdpPort
                }
                Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue
                $staleRestart = $true
                break
            }
        }

        Start-Sleep -Seconds 2
        $nodeProcess.Refresh()
    }

    if (-not $nodeProcess.HasExited -and ((Test-Path $stop) -or (Test-Path $autostartDisabled))) {
        for ($i = 0; $i -lt 10 -and -not $nodeProcess.HasExited; $i++) {
            Start-Sleep -Milliseconds 500
            $nodeProcess.Refresh()
        }
        if (-not $nodeProcess.HasExited) {
            Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }

    try { $nodeProcess.WaitForExit() } catch {}

    return [pscustomobject]@{
        exit_code = $(if ($staleRestart) { 77 } elseif ($nodeProcess.HasExited) { [int]$nodeProcess.ExitCode } else { 1 })
        status_stale_restart = [bool]$staleRestart
        pid = [int]$nodeProcess.Id
    }
}

if ((Test-Path $stop) -or (Test-Path $autostartDisabled)) {
    Write-Host 'Supervisor launch blocked by Owner STOP/AUTOSTART_DISABLED.'
    exit 0
}
Set-Content -Path $pidFile -Value $PID -Encoding ascii

try {
    $chromeCandidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    $chrome = $chromeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $chrome) { throw 'Installed Google Chrome not found.' }

    while (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled)) {
        $cdpPort = Get-ExistingDedicatedCdpPort
        if (-not $cdpPort) { $cdpPort = Get-FreeCdpPort }
        $cdpBaseUrl = "http://127.0.0.1:$cdpPort"
        $ready = Test-DedicatedCdpEndpoint -Port $cdpPort

        if (-not $ready) {
            Stop-DedicatedChrome
            Start-Sleep -Milliseconds 750
            $cdpPort = Get-FreeCdpPort
            $cdpBaseUrl = "http://127.0.0.1:$cdpPort"

            # Keep the real Supervisor Chrome UI available for CDP, but automatic
            # boot/recovery must not jump in front of the Owner.
            Start-Process -FilePath $chrome -WindowStyle Minimized -ArgumentList @(
                '--remote-debugging-address=127.0.0.1',
                "--remote-debugging-port=$cdpPort",
                ('--user-data-dir="' + $profile + '"'),
                '--no-first-run',
                '--no-default-browser-check',
                '--start-minimized',
                'https://chatgpt.com/'
            )

            for ($i = 0; $i -lt 30; $i++) {
                if (Test-Path $stop) { break }
                if (Test-DedicatedCdpEndpoint -Port $cdpPort) {
                    $ready = $true
                    break
                }
                Start-Sleep -Seconds 1
            }
        }

        if (-not $ready) {
            Start-Sleep -Seconds 5
            continue
        }

        $runtimeMode = $null
        $adapterFailure = $null
        try {
            $projectState = Read-ConfiguredProjectAdapterState
            if ($projectState -and $projectState.supervisor_orchestration) {
                $candidateMode = [string]$projectState.supervisor_orchestration.mode
                if (-not [string]::IsNullOrWhiteSpace($candidateMode)) {
                    $runtimeMode = $candidateMode
                    Write-WrapperLog 'RUNTIME_MODE_FROM_PROJECT_ADAPTER' @{
                        mode = $runtimeMode
                    }
                }
            }
        } catch {
            $adapterFailure = $_.Exception.GetType().Name
            Write-WrapperLog 'PROJECT_ADAPTER_UNAVAILABLE' @{
                error_name = $adapterFailure
            }
        }

        if (-not $runtimeMode) {
            $runtimeMode = Resolve-LocalRuntimeMode
            if ($runtimeMode) {
                Write-WrapperLog 'RUNTIME_MODE_FROM_LOCAL_PLATFORM_TRUTH' @{
                    mode = $runtimeMode
                    adapter_state = $(if ($adapterFailure) { 'ERROR' } else { 'NOT_CONFIGURED_OR_NO_MODE' })
                }
            }
        }

        if (-not $runtimeMode) {
            Write-WrapperLog 'RUNTIME_MODE_UNRESOLVED' @{
                adapter_state = $(if ($adapterFailure) { 'ERROR' } else { 'NOT_CONFIGURED_OR_NO_MODE' })
            }
            Write-Host 'No authoritative runtime mode is available; preserving wrapper and retrying fail-closed.'
            Start-Sleep -Seconds 5
            continue
        }

        $entryPoint = switch ($runtimeMode) {
            'THREE_LANE_V1' { 'src/runtime/three-lane-cli.mjs' }
            'BRAIN_WORKER_V1' { 'src/runtime/brain-worker-cli.mjs' }
            default { 'src/runtime/supervisor-loop-cli.mjs' }
        }

        if ($runtimeMode -notin @('THREE_LANE_V1','BRAIN_WORKER_V1') -and -not (Test-Path $target)) {
            Write-Host 'Legacy mode was explicitly selected but no legacy target exists; waiting for authoritative project state instead of terminating.'
            Start-Sleep -Seconds 5
            continue
        }

        Write-Host "Supervisor entry point: $entryPoint"
        Write-WrapperLog 'NODE_LAUNCH' @{
            mode = $runtimeMode
            entry_point = $entryPoint
            cdp_port = $cdpPort
            dry_run = [bool]$DryRun
        }

        Push-Location $runtime
        try {
            $entryPointPath = Join-Path $runtime $entryPoint
            $nodeArgs = @($entryPointPath, '--cdp-url', $cdpBaseUrl, '--poll-ms', '5000')
            if ($entryPoint -in @('src/runtime/brain-worker-cli.mjs','src/runtime/supervisor-loop-cli.mjs')) {
                if (-not [string]::IsNullOrWhiteSpace($projectAdapterPath)) {
                    $nodeArgs += @('--project-adapter', $projectAdapterPath)
                } elseif (-not [string]::IsNullOrWhiteSpace($projectAdapterUrl)) {
                    $nodeArgs += @('--project-adapter-url', $projectAdapterUrl)
                } else {
                    Write-Host 'Project adapter is required for legacy/brain-worker mode; waiting fail-closed.'
                    Start-Sleep -Seconds 5
                    continue
                }
            }
            if (-not $DryRun) { $nodeArgs += '--execute' }

            $statusStaleRestart = $false
            if ($entryPoint -eq 'src/runtime/three-lane-cli.mjs') {
                $nodeOutcome = Invoke-MonitoredThreeLaneNode -NodeArgs $nodeArgs -CdpPort $cdpPort
                $nodeExitCode = [int]$nodeOutcome.exit_code
                $statusStaleRestart = [bool]$nodeOutcome.status_stale_restart
            } else {
                & node @nodeArgs
                $nodeExitCode = $LASTEXITCODE
            }

            Write-WrapperLog 'NODE_EXIT' @{
                mode = $runtimeMode
                entry_point = $entryPoint
                exit_code = $nodeExitCode
                cdp_port = $cdpPort
                status_stale_restart = [bool]$statusStaleRestart
            }
        } finally {
            Pop-Location
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled) -and $nodeExitCode -eq 75) {
            # Exit code 75 is the Supervisor's explicit request for a clean CDP
            # recovery. Kill only the dedicated Supervisor Chrome profile even
            # when /json/version still answers, then let the outer gate relaunch it.
            Write-Host 'Supervisor requested dedicated Chrome restart after repeated CDP failures.'
            Write-WrapperLog 'CDP_RECYCLE_REQUESTED' @{
                exit_code = $nodeExitCode
                cdp_port = $cdpPort
            }
            Stop-DedicatedChrome
            Start-Sleep -Milliseconds 750
            continue
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled) -and $statusStaleRestart) {
            Write-Host 'Three-Lane Node restarted because lane-status exceeded freshness threshold.'
            Write-WrapperLog 'THREE_LANE_STATUS_STALE_RELAUNCH' @{
                stale_after_seconds = [int](Get-ThreeLaneStatusStaleSeconds)
                cdp_port = $cdpPort
            }
            Start-Sleep -Seconds 1
            continue
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled) -and $nodeExitCode -eq 76) {
            # Exit code 76 is an intentional autonomy pause. Do not keep an
            # automation browser open when source-of-truth says there is no
            # authorized work to execute.
            Write-Host 'Supervisor entered PAUSED autonomy; closing dedicated Chrome and stopping wrapper.'
            Stop-DedicatedChrome
            break
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled)) {
            Start-Sleep -Seconds 3
        }
    }
} finally {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    if ($ownsMutex) {
        try { $mutex.ReleaseMutex() } catch {}
    }
    $mutex.Dispose()
}
) {
            return [string]$match.Groups[1].Value
        }
    } catch {}
    return 'UNKNOWN'
}

function Write-WrapperLog(
    [string]$Type,
    [hashtable]$Fields = @{}
) {
    try {
        if (Test-Path $wrapperLogFile) {
            $item = Get-Item $wrapperLogFile -ErrorAction SilentlyContinue
            if ($item -and $item.Length -gt 2097152) {
                $tail = @(Get-Content $wrapperLogFile -Tail 500 -ErrorAction SilentlyContinue)
                [System.IO.File]::WriteAllLines(
                    $wrapperLogFile,
                    $tail,
                    (New-Object System.Text.UTF8Encoding($false))
                )
            }
        }

        $safeType = if ($Type -match '^[A-Z0-9_]{1,96}
function Resolve-LocalRuntimeMode {
    # Platform-local orchestration truth is allowed to select the runtime
    # even when no project adapter is configured. It does not provide project
    # business state and therefore does not violate the explicit adapter boundary.
    try {
        if (Test-Path $laneStatusFile) {
            $laneStatus = Get-Content $laneStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$laneStatus.mode -eq 'THREE_LANE_V1') {
                return 'THREE_LANE_V1'
            }
        }
    } catch {}

    try {
        if (Test-Path $laneConfigFile) {
            $laneConfig = Get-Content $laneConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$laneConfig.mode -eq 'THREE_LANE_V1') {
                return 'THREE_LANE_V1'
            }
        }
    } catch {}

    try {
        if (Test-Path $registryFile) {
            $registry = Get-Content $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$registry.mode -eq 'BRAIN_WORKER_V1') {
                return 'BRAIN_WORKER_V1'
            }
        }
    } catch {}

    try {
        if (Test-Path $runtimeStatusFile) {
            $runtimeStatus = Get-Content $runtimeStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$runtimeStatus.orchestration_mode -eq 'BRAIN_WORKER_V1') {
                return 'BRAIN_WORKER_V1'
            }
        }
    } catch {}

    return $null
}

$mutexName = if (-not [string]::IsNullOrWhiteSpace([string]$env:SUPERVISOR_MUTEX_NAME)) {
    [string]$env:SUPERVISOR_MUTEX_NAME
} else {
    'Local\MAGASIN_BUSINESS_OS_SUPERVISOR'
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
        Write-Host 'Another MAGASIN Supervisor wrapper already owns the singleton mutex.'
        exit 0
    }
} catch {
    $mutex.Dispose()
    throw
}

function Get-DedicatedChromeProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" })
}

function Stop-DedicatedChrome {
    # Only terminate Chrome processes that explicitly use the dedicated
    # Supervisor profile. Never touch the Owner's normal Chrome profile.
    Get-DedicatedChromeProcesses | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Get-ExistingDedicatedCdpPort {
    foreach ($process in (Get-DedicatedChromeProcesses)) {
        if ($process.CommandLine -match '--remote-debugging-port=(\d+)') {
            return [int]$Matches[1]
        }
    }
    return $null
}

function Get-FreeCdpPort {
    foreach ($candidate in 9222..9232) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $listener) { return $candidate }
    }
    throw 'No free Supervisor CDP port in range 9222-9232.'
}

function Test-DedicatedCdpEndpoint([int]$Port) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $listener) { return $false }

    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (
        -not $owner -or
        $owner.Name -ne 'chrome.exe' -or
        -not $owner.CommandLine -or
        $owner.CommandLine -notlike "*$profile*" -or
        $owner.CommandLine -notmatch ("--remote-debugging-port=" + $Port + "(\s|$)")
    ) {
        return $false
    }

    try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
        return [bool]$version.webSocketDebuggerUrl
    } catch {
        return $false
    }
}

function Get-ThreeLaneStatusStaleSeconds {
    $value = 120
    $parsed = 0
    if (
        [int]::TryParse([string]$env:SUPERVISOR_STATUS_STALE_SECONDS, [ref]$parsed) -and
        $parsed -ge 5
    ) {
        $value = $parsed
    }
    return $value
}

function Invoke-MonitoredThreeLaneNode(
    [string[]]$NodeArgs,
    [int]$CdpPort
) {
    $threshold = Get-ThreeLaneStatusStaleSeconds
    $startedAt = [DateTimeOffset]::UtcNow
    $nodeProcess = Start-Process -FilePath 'node.exe' -ArgumentList $NodeArgs -PassThru -NoNewWindow
    $staleRestart = $false

    Write-WrapperLog 'THREE_LANE_MONITOR_STARTED' @{
        pid = [int]$nodeProcess.Id
        stale_after_seconds = [int]$threshold
        cdp_port = $CdpPort
    }

    while (-not $nodeProcess.HasExited) {
        if ((Test-Path $stop) -or (Test-Path $autostartDisabled)) {
            break
        }

        $elapsed = ([DateTimeOffset]::UtcNow - $startedAt).TotalSeconds
        if ($elapsed -ge $threshold) {
            $freshness = Get-LifecycleLaneStatusFreshness -Root $root -StaleAfterSeconds $threshold
            if ($freshness.stale) {
                Write-Host 'THREE-LANE STATUS_STALE detected; restarting Node without mutating lane/project state.'
                Write-Host 'SUPERVISOR_P4_STATUS_STALE_DETECTED=True'
                Write-WrapperLog 'THREE_LANE_STATUS_STALE_RESTART' @{
                    pid = [int]$nodeProcess.Id
                    status_age_seconds = $freshness.age_seconds
                    stale_after_seconds = [int]$threshold
                    status_reason = [string]$freshness.reason
                    cdp_port = $CdpPort
                }
                Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue
                $staleRestart = $true
                break
            }
        }

        Start-Sleep -Seconds 2
        $nodeProcess.Refresh()
    }

    if (-not $nodeProcess.HasExited -and ((Test-Path $stop) -or (Test-Path $autostartDisabled))) {
        for ($i = 0; $i -lt 10 -and -not $nodeProcess.HasExited; $i++) {
            Start-Sleep -Milliseconds 500
            $nodeProcess.Refresh()
        }
        if (-not $nodeProcess.HasExited) {
            Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }

    try { $nodeProcess.WaitForExit() } catch {}

    return [pscustomobject]@{
        exit_code = $(if ($staleRestart) { 77 } elseif ($nodeProcess.HasExited) { [int]$nodeProcess.ExitCode } else { 1 })
        status_stale_restart = [bool]$staleRestart
        pid = [int]$nodeProcess.Id
    }
}

if ((Test-Path $stop) -or (Test-Path $autostartDisabled)) {
    Write-Host 'Supervisor launch blocked by Owner STOP/AUTOSTART_DISABLED.'
    exit 0
}
Set-Content -Path $pidFile -Value $PID -Encoding ascii

try {
    $chromeCandidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    $chrome = $chromeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $chrome) { throw 'Installed Google Chrome not found.' }

    while (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled)) {
        $cdpPort = Get-ExistingDedicatedCdpPort
        if (-not $cdpPort) { $cdpPort = Get-FreeCdpPort }
        $cdpBaseUrl = "http://127.0.0.1:$cdpPort"
        $ready = Test-DedicatedCdpEndpoint -Port $cdpPort

        if (-not $ready) {
            Stop-DedicatedChrome
            Start-Sleep -Milliseconds 750
            $cdpPort = Get-FreeCdpPort
            $cdpBaseUrl = "http://127.0.0.1:$cdpPort"

            # Keep the real Supervisor Chrome UI available for CDP, but automatic
            # boot/recovery must not jump in front of the Owner.
            Start-Process -FilePath $chrome -WindowStyle Minimized -ArgumentList @(
                '--remote-debugging-address=127.0.0.1',
                "--remote-debugging-port=$cdpPort",
                ('--user-data-dir="' + $profile + '"'),
                '--no-first-run',
                '--no-default-browser-check',
                '--start-minimized',
                'https://chatgpt.com/'
            )

            for ($i = 0; $i -lt 30; $i++) {
                if (Test-Path $stop) { break }
                if (Test-DedicatedCdpEndpoint -Port $cdpPort) {
                    $ready = $true
                    break
                }
                Start-Sleep -Seconds 1
            }
        }

        if (-not $ready) {
            Start-Sleep -Seconds 5
            continue
        }

        $runtimeMode = $null
        $adapterFailure = $null
        try {
            $projectState = Read-ConfiguredProjectAdapterState
            if ($projectState -and $projectState.supervisor_orchestration) {
                $candidateMode = [string]$projectState.supervisor_orchestration.mode
                if (-not [string]::IsNullOrWhiteSpace($candidateMode)) {
                    $runtimeMode = $candidateMode
                    Write-WrapperLog 'RUNTIME_MODE_FROM_PROJECT_ADAPTER' @{
                        mode = $runtimeMode
                    }
                }
            }
        } catch {
            $adapterFailure = $_.Exception.GetType().Name
            Write-WrapperLog 'PROJECT_ADAPTER_UNAVAILABLE' @{
                error_name = $adapterFailure
            }
        }

        if (-not $runtimeMode) {
            $runtimeMode = Resolve-LocalRuntimeMode
            if ($runtimeMode) {
                Write-WrapperLog 'RUNTIME_MODE_FROM_LOCAL_PLATFORM_TRUTH' @{
                    mode = $runtimeMode
                    adapter_state = $(if ($adapterFailure) { 'ERROR' } else { 'NOT_CONFIGURED_OR_NO_MODE' })
                }
            }
        }

        if (-not $runtimeMode) {
            Write-WrapperLog 'RUNTIME_MODE_UNRESOLVED' @{
                adapter_state = $(if ($adapterFailure) { 'ERROR' } else { 'NOT_CONFIGURED_OR_NO_MODE' })
            }
            Write-Host 'No authoritative runtime mode is available; preserving wrapper and retrying fail-closed.'
            Start-Sleep -Seconds 5
            continue
        }

        $entryPoint = switch ($runtimeMode) {
            'THREE_LANE_V1' { 'src/runtime/three-lane-cli.mjs' }
            'BRAIN_WORKER_V1' { 'src/runtime/brain-worker-cli.mjs' }
            default { 'src/runtime/supervisor-loop-cli.mjs' }
        }

        if ($runtimeMode -notin @('THREE_LANE_V1','BRAIN_WORKER_V1') -and -not (Test-Path $target)) {
            Write-Host 'Legacy mode was explicitly selected but no legacy target exists; waiting for authoritative project state instead of terminating.'
            Start-Sleep -Seconds 5
            continue
        }

        Write-Host "Supervisor entry point: $entryPoint"
        Write-WrapperLog 'NODE_LAUNCH' @{
            mode = $runtimeMode
            entry_point = $entryPoint
            cdp_port = $cdpPort
            dry_run = [bool]$DryRun
        }

        Push-Location $runtime
        try {
            $entryPointPath = Join-Path $runtime $entryPoint
            $nodeArgs = @($entryPointPath, '--cdp-url', $cdpBaseUrl, '--poll-ms', '5000')
            if ($entryPoint -in @('src/runtime/brain-worker-cli.mjs','src/runtime/supervisor-loop-cli.mjs')) {
                if (-not [string]::IsNullOrWhiteSpace($projectAdapterPath)) {
                    $nodeArgs += @('--project-adapter', $projectAdapterPath)
                } elseif (-not [string]::IsNullOrWhiteSpace($projectAdapterUrl)) {
                    $nodeArgs += @('--project-adapter-url', $projectAdapterUrl)
                } else {
                    Write-Host 'Project adapter is required for legacy/brain-worker mode; waiting fail-closed.'
                    Start-Sleep -Seconds 5
                    continue
                }
            }
            if (-not $DryRun) { $nodeArgs += '--execute' }

            $statusStaleRestart = $false
            if ($entryPoint -eq 'src/runtime/three-lane-cli.mjs') {
                $nodeOutcome = Invoke-MonitoredThreeLaneNode -NodeArgs $nodeArgs -CdpPort $cdpPort
                $nodeExitCode = [int]$nodeOutcome.exit_code
                $statusStaleRestart = [bool]$nodeOutcome.status_stale_restart
            } else {
                & node @nodeArgs
                $nodeExitCode = $LASTEXITCODE
            }

            Write-WrapperLog 'NODE_EXIT' @{
                mode = $runtimeMode
                entry_point = $entryPoint
                exit_code = $nodeExitCode
                cdp_port = $cdpPort
                status_stale_restart = [bool]$statusStaleRestart
            }
        } finally {
            Pop-Location
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled) -and $nodeExitCode -eq 75) {
            # Exit code 75 is the Supervisor's explicit request for a clean CDP
            # recovery. Kill only the dedicated Supervisor Chrome profile even
            # when /json/version still answers, then let the outer gate relaunch it.
            Write-Host 'Supervisor requested dedicated Chrome restart after repeated CDP failures.'
            Write-WrapperLog 'CDP_RECYCLE_REQUESTED' @{
                exit_code = $nodeExitCode
                cdp_port = $cdpPort
            }
            Stop-DedicatedChrome
            Start-Sleep -Milliseconds 750
            continue
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled) -and $statusStaleRestart) {
            Write-Host 'Three-Lane Node restarted because lane-status exceeded freshness threshold.'
            Write-WrapperLog 'THREE_LANE_STATUS_STALE_RELAUNCH' @{
                stale_after_seconds = [int](Get-ThreeLaneStatusStaleSeconds)
                cdp_port = $cdpPort
            }
            Start-Sleep -Seconds 1
            continue
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled) -and $nodeExitCode -eq 76) {
            # Exit code 76 is an intentional autonomy pause. Do not keep an
            # automation browser open when source-of-truth says there is no
            # authorized work to execute.
            Write-Host 'Supervisor entered PAUSED autonomy; closing dedicated Chrome and stopping wrapper.'
            Stop-DedicatedChrome
            break
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled)) {
            Start-Sleep -Seconds 3
        }
    }
} finally {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    if ($ownsMutex) {
        try { $mutex.ReleaseMutex() } catch {}
    }
    $mutex.Dispose()
}
) { $Type } else { 'WRAPPER_EVENT' }
        $record = [ordered]@{
            timestamp = [DateTimeOffset]::UtcNow.ToString('o')
            type = $safeType
            runtime_version = Get-WrapperRuntimeVersion
        }

        $allowed = @(
            'adapter_state',
            'cdp_port',
            'dry_run',
            'entry_point',
            'error_name',
            'exit_code',
            'mode',
            'pid',
            'stale_after_seconds',
            'status_age_seconds',
            'status_reason',
            'status_stale_restart'
        )

        foreach ($key in $Fields.Keys) {
            if ($key -notin $allowed) { continue }
            $value = $Fields[$key]

            switch ($key) {
                'cdp_port' {
                    $number = [int]$value
                    if ($number -ge 1 -and $number -le 65535) { $record[$key] = $number }
                }
                'pid' {
                    $number = [int]$value
                    if ($number -ge 0) { $record[$key] = $number }
                }
                'stale_after_seconds' {
                    $number = [int]$value
                    if ($number -ge 0) { $record[$key] = $number }
                }
                'status_age_seconds' {
                    $number = [int]$value
                    if ($number -ge 0) { $record[$key] = $number }
                }
                'exit_code' {
                    $number = [int]$value
                    $record[$key] = $number
                    $record['node_exit_code'] = $number
                }
                'dry_run' { $record[$key] = [bool]$value }
                'status_stale_restart' { $record[$key] = [bool]$value }
                default {
                    $text = [string]$value
                    if (
                        $text -match '^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}
function Resolve-LocalRuntimeMode {
    # Platform-local orchestration truth is allowed to select the runtime
    # even when no project adapter is configured. It does not provide project
    # business state and therefore does not violate the explicit adapter boundary.
    try {
        if (Test-Path $laneStatusFile) {
            $laneStatus = Get-Content $laneStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$laneStatus.mode -eq 'THREE_LANE_V1') {
                return 'THREE_LANE_V1'
            }
        }
    } catch {}

    try {
        if (Test-Path $laneConfigFile) {
            $laneConfig = Get-Content $laneConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$laneConfig.mode -eq 'THREE_LANE_V1') {
                return 'THREE_LANE_V1'
            }
        }
    } catch {}

    try {
        if (Test-Path $registryFile) {
            $registry = Get-Content $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$registry.mode -eq 'BRAIN_WORKER_V1') {
                return 'BRAIN_WORKER_V1'
            }
        }
    } catch {}

    try {
        if (Test-Path $runtimeStatusFile) {
            $runtimeStatus = Get-Content $runtimeStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$runtimeStatus.orchestration_mode -eq 'BRAIN_WORKER_V1') {
                return 'BRAIN_WORKER_V1'
            }
        }
    } catch {}

    return $null
}

$mutexName = if (-not [string]::IsNullOrWhiteSpace([string]$env:SUPERVISOR_MUTEX_NAME)) {
    [string]$env:SUPERVISOR_MUTEX_NAME
} else {
    'Local\MAGASIN_BUSINESS_OS_SUPERVISOR'
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
        Write-Host 'Another MAGASIN Supervisor wrapper already owns the singleton mutex.'
        exit 0
    }
} catch {
    $mutex.Dispose()
    throw
}

function Get-DedicatedChromeProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" })
}

function Stop-DedicatedChrome {
    # Only terminate Chrome processes that explicitly use the dedicated
    # Supervisor profile. Never touch the Owner's normal Chrome profile.
    Get-DedicatedChromeProcesses | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Get-ExistingDedicatedCdpPort {
    foreach ($process in (Get-DedicatedChromeProcesses)) {
        if ($process.CommandLine -match '--remote-debugging-port=(\d+)') {
            return [int]$Matches[1]
        }
    }
    return $null
}

function Get-FreeCdpPort {
    foreach ($candidate in 9222..9232) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $listener) { return $candidate }
    }
    throw 'No free Supervisor CDP port in range 9222-9232.'
}

function Test-DedicatedCdpEndpoint([int]$Port) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $listener) { return $false }

    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (
        -not $owner -or
        $owner.Name -ne 'chrome.exe' -or
        -not $owner.CommandLine -or
        $owner.CommandLine -notlike "*$profile*" -or
        $owner.CommandLine -notmatch ("--remote-debugging-port=" + $Port + "(\s|$)")
    ) {
        return $false
    }

    try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
        return [bool]$version.webSocketDebuggerUrl
    } catch {
        return $false
    }
}

function Get-ThreeLaneStatusStaleSeconds {
    $value = 120
    $parsed = 0
    if (
        [int]::TryParse([string]$env:SUPERVISOR_STATUS_STALE_SECONDS, [ref]$parsed) -and
        $parsed -ge 5
    ) {
        $value = $parsed
    }
    return $value
}

function Invoke-MonitoredThreeLaneNode(
    [string[]]$NodeArgs,
    [int]$CdpPort
) {
    $threshold = Get-ThreeLaneStatusStaleSeconds
    $startedAt = [DateTimeOffset]::UtcNow
    $nodeProcess = Start-Process -FilePath 'node.exe' -ArgumentList $NodeArgs -PassThru -NoNewWindow
    $staleRestart = $false

    Write-WrapperLog 'THREE_LANE_MONITOR_STARTED' @{
        pid = [int]$nodeProcess.Id
        stale_after_seconds = [int]$threshold
        cdp_port = $CdpPort
    }

    while (-not $nodeProcess.HasExited) {
        if ((Test-Path $stop) -or (Test-Path $autostartDisabled)) {
            break
        }

        $elapsed = ([DateTimeOffset]::UtcNow - $startedAt).TotalSeconds
        if ($elapsed -ge $threshold) {
            $freshness = Get-LifecycleLaneStatusFreshness -Root $root -StaleAfterSeconds $threshold
            if ($freshness.stale) {
                Write-Host 'THREE-LANE STATUS_STALE detected; restarting Node without mutating lane/project state.'
                Write-Host 'SUPERVISOR_P4_STATUS_STALE_DETECTED=True'
                Write-WrapperLog 'THREE_LANE_STATUS_STALE_RESTART' @{
                    pid = [int]$nodeProcess.Id
                    status_age_seconds = $freshness.age_seconds
                    stale_after_seconds = [int]$threshold
                    status_reason = [string]$freshness.reason
                    cdp_port = $CdpPort
                }
                Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue
                $staleRestart = $true
                break
            }
        }

        Start-Sleep -Seconds 2
        $nodeProcess.Refresh()
    }

    if (-not $nodeProcess.HasExited -and ((Test-Path $stop) -or (Test-Path $autostartDisabled))) {
        for ($i = 0; $i -lt 10 -and -not $nodeProcess.HasExited; $i++) {
            Start-Sleep -Milliseconds 500
            $nodeProcess.Refresh()
        }
        if (-not $nodeProcess.HasExited) {
            Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }

    try { $nodeProcess.WaitForExit() } catch {}

    return [pscustomobject]@{
        exit_code = $(if ($staleRestart) { 77 } elseif ($nodeProcess.HasExited) { [int]$nodeProcess.ExitCode } else { 1 })
        status_stale_restart = [bool]$staleRestart
        pid = [int]$nodeProcess.Id
    }
}

if ((Test-Path $stop) -or (Test-Path $autostartDisabled)) {
    Write-Host 'Supervisor launch blocked by Owner STOP/AUTOSTART_DISABLED.'
    exit 0
}
Set-Content -Path $pidFile -Value $PID -Encoding ascii

try {
    $chromeCandidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    $chrome = $chromeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $chrome) { throw 'Installed Google Chrome not found.' }

    while (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled)) {
        $cdpPort = Get-ExistingDedicatedCdpPort
        if (-not $cdpPort) { $cdpPort = Get-FreeCdpPort }
        $cdpBaseUrl = "http://127.0.0.1:$cdpPort"
        $ready = Test-DedicatedCdpEndpoint -Port $cdpPort

        if (-not $ready) {
            Stop-DedicatedChrome
            Start-Sleep -Milliseconds 750
            $cdpPort = Get-FreeCdpPort
            $cdpBaseUrl = "http://127.0.0.1:$cdpPort"

            # Keep the real Supervisor Chrome UI available for CDP, but automatic
            # boot/recovery must not jump in front of the Owner.
            Start-Process -FilePath $chrome -WindowStyle Minimized -ArgumentList @(
                '--remote-debugging-address=127.0.0.1',
                "--remote-debugging-port=$cdpPort",
                ('--user-data-dir="' + $profile + '"'),
                '--no-first-run',
                '--no-default-browser-check',
                '--start-minimized',
                'https://chatgpt.com/'
            )

            for ($i = 0; $i -lt 30; $i++) {
                if (Test-Path $stop) { break }
                if (Test-DedicatedCdpEndpoint -Port $cdpPort) {
                    $ready = $true
                    break
                }
                Start-Sleep -Seconds 1
            }
        }

        if (-not $ready) {
            Start-Sleep -Seconds 5
            continue
        }

        $runtimeMode = $null
        $adapterFailure = $null
        try {
            $projectState = Read-ConfiguredProjectAdapterState
            if ($projectState -and $projectState.supervisor_orchestration) {
                $candidateMode = [string]$projectState.supervisor_orchestration.mode
                if (-not [string]::IsNullOrWhiteSpace($candidateMode)) {
                    $runtimeMode = $candidateMode
                    Write-WrapperLog 'RUNTIME_MODE_FROM_PROJECT_ADAPTER' @{
                        mode = $runtimeMode
                    }
                }
            }
        } catch {
            $adapterFailure = $_.Exception.GetType().Name
            Write-WrapperLog 'PROJECT_ADAPTER_UNAVAILABLE' @{
                error_name = $adapterFailure
            }
        }

        if (-not $runtimeMode) {
            $runtimeMode = Resolve-LocalRuntimeMode
            if ($runtimeMode) {
                Write-WrapperLog 'RUNTIME_MODE_FROM_LOCAL_PLATFORM_TRUTH' @{
                    mode = $runtimeMode
                    adapter_state = $(if ($adapterFailure) { 'ERROR' } else { 'NOT_CONFIGURED_OR_NO_MODE' })
                }
            }
        }

        if (-not $runtimeMode) {
            Write-WrapperLog 'RUNTIME_MODE_UNRESOLVED' @{
                adapter_state = $(if ($adapterFailure) { 'ERROR' } else { 'NOT_CONFIGURED_OR_NO_MODE' })
            }
            Write-Host 'No authoritative runtime mode is available; preserving wrapper and retrying fail-closed.'
            Start-Sleep -Seconds 5
            continue
        }

        $entryPoint = switch ($runtimeMode) {
            'THREE_LANE_V1' { 'src/runtime/three-lane-cli.mjs' }
            'BRAIN_WORKER_V1' { 'src/runtime/brain-worker-cli.mjs' }
            default { 'src/runtime/supervisor-loop-cli.mjs' }
        }

        if ($runtimeMode -notin @('THREE_LANE_V1','BRAIN_WORKER_V1') -and -not (Test-Path $target)) {
            Write-Host 'Legacy mode was explicitly selected but no legacy target exists; waiting for authoritative project state instead of terminating.'
            Start-Sleep -Seconds 5
            continue
        }

        Write-Host "Supervisor entry point: $entryPoint"
        Write-WrapperLog 'NODE_LAUNCH' @{
            mode = $runtimeMode
            entry_point = $entryPoint
            cdp_port = $cdpPort
            dry_run = [bool]$DryRun
        }

        Push-Location $runtime
        try {
            $entryPointPath = Join-Path $runtime $entryPoint
            $nodeArgs = @($entryPointPath, '--cdp-url', $cdpBaseUrl, '--poll-ms', '5000')
            if ($entryPoint -in @('src/runtime/brain-worker-cli.mjs','src/runtime/supervisor-loop-cli.mjs')) {
                if (-not [string]::IsNullOrWhiteSpace($projectAdapterPath)) {
                    $nodeArgs += @('--project-adapter', $projectAdapterPath)
                } elseif (-not [string]::IsNullOrWhiteSpace($projectAdapterUrl)) {
                    $nodeArgs += @('--project-adapter-url', $projectAdapterUrl)
                } else {
                    Write-Host 'Project adapter is required for legacy/brain-worker mode; waiting fail-closed.'
                    Start-Sleep -Seconds 5
                    continue
                }
            }
            if (-not $DryRun) { $nodeArgs += '--execute' }

            $statusStaleRestart = $false
            if ($entryPoint -eq 'src/runtime/three-lane-cli.mjs') {
                $nodeOutcome = Invoke-MonitoredThreeLaneNode -NodeArgs $nodeArgs -CdpPort $cdpPort
                $nodeExitCode = [int]$nodeOutcome.exit_code
                $statusStaleRestart = [bool]$nodeOutcome.status_stale_restart
            } else {
                & node @nodeArgs
                $nodeExitCode = $LASTEXITCODE
            }

            Write-WrapperLog 'NODE_EXIT' @{
                mode = $runtimeMode
                entry_point = $entryPoint
                exit_code = $nodeExitCode
                cdp_port = $cdpPort
                status_stale_restart = [bool]$statusStaleRestart
            }
        } finally {
            Pop-Location
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled) -and $nodeExitCode -eq 75) {
            # Exit code 75 is the Supervisor's explicit request for a clean CDP
            # recovery. Kill only the dedicated Supervisor Chrome profile even
            # when /json/version still answers, then let the outer gate relaunch it.
            Write-Host 'Supervisor requested dedicated Chrome restart after repeated CDP failures.'
            Write-WrapperLog 'CDP_RECYCLE_REQUESTED' @{
                exit_code = $nodeExitCode
                cdp_port = $cdpPort
            }
            Stop-DedicatedChrome
            Start-Sleep -Milliseconds 750
            continue
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled) -and $statusStaleRestart) {
            Write-Host 'Three-Lane Node restarted because lane-status exceeded freshness threshold.'
            Write-WrapperLog 'THREE_LANE_STATUS_STALE_RELAUNCH' @{
                stale_after_seconds = [int](Get-ThreeLaneStatusStaleSeconds)
                cdp_port = $cdpPort
            }
            Start-Sleep -Seconds 1
            continue
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled) -and $nodeExitCode -eq 76) {
            # Exit code 76 is an intentional autonomy pause. Do not keep an
            # automation browser open when source-of-truth says there is no
            # authorized work to execute.
            Write-Host 'Supervisor entered PAUSED autonomy; closing dedicated Chrome and stopping wrapper.'
            Stop-DedicatedChrome
            break
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled)) {
            Start-Sleep -Seconds 3
        }
    }
} finally {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    if ($ownsMutex) {
        try { $mutex.ReleaseMutex() } catch {}
    }
    $mutex.Dispose()
}
 -and
                        $text -notmatch '://' -and
                        $text -notmatch '\\' -and
                        $text -notmatch '\.\.'
                    ) {
                        $record[$key] = $text
                    }
                }
            }
        }

        Add-Content -Path $wrapperLogFile -Value ($record | ConvertTo-Json -Compress) -Encoding UTF8
    } catch {
        # Observability must never become runtime authority.
    }
}

function Resolve-LocalRuntimeMode {
    # Platform-local orchestration truth is allowed to select the runtime
    # even when no project adapter is configured. It does not provide project
    # business state and therefore does not violate the explicit adapter boundary.
    try {
        if (Test-Path $laneStatusFile) {
            $laneStatus = Get-Content $laneStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$laneStatus.mode -eq 'THREE_LANE_V1') {
                return 'THREE_LANE_V1'
            }
        }
    } catch {}

    try {
        if (Test-Path $laneConfigFile) {
            $laneConfig = Get-Content $laneConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$laneConfig.mode -eq 'THREE_LANE_V1') {
                return 'THREE_LANE_V1'
            }
        }
    } catch {}

    try {
        if (Test-Path $registryFile) {
            $registry = Get-Content $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$registry.mode -eq 'BRAIN_WORKER_V1') {
                return 'BRAIN_WORKER_V1'
            }
        }
    } catch {}

    try {
        if (Test-Path $runtimeStatusFile) {
            $runtimeStatus = Get-Content $runtimeStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$runtimeStatus.orchestration_mode -eq 'BRAIN_WORKER_V1') {
                return 'BRAIN_WORKER_V1'
            }
        }
    } catch {}

    return $null
}

$mutexName = if (-not [string]::IsNullOrWhiteSpace([string]$env:SUPERVISOR_MUTEX_NAME)) {
    [string]$env:SUPERVISOR_MUTEX_NAME
} else {
    'Local\MAGASIN_BUSINESS_OS_SUPERVISOR'
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
        Write-Host 'Another MAGASIN Supervisor wrapper already owns the singleton mutex.'
        exit 0
    }
} catch {
    $mutex.Dispose()
    throw
}

function Get-DedicatedChromeProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" })
}

function Stop-DedicatedChrome {
    # Only terminate Chrome processes that explicitly use the dedicated
    # Supervisor profile. Never touch the Owner's normal Chrome profile.
    Get-DedicatedChromeProcesses | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Get-ExistingDedicatedCdpPort {
    foreach ($process in (Get-DedicatedChromeProcesses)) {
        if ($process.CommandLine -match '--remote-debugging-port=(\d+)') {
            return [int]$Matches[1]
        }
    }
    return $null
}

function Get-FreeCdpPort {
    foreach ($candidate in 9222..9232) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $listener) { return $candidate }
    }
    throw 'No free Supervisor CDP port in range 9222-9232.'
}

function Test-DedicatedCdpEndpoint([int]$Port) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $listener) { return $false }

    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (
        -not $owner -or
        $owner.Name -ne 'chrome.exe' -or
        -not $owner.CommandLine -or
        $owner.CommandLine -notlike "*$profile*" -or
        $owner.CommandLine -notmatch ("--remote-debugging-port=" + $Port + "(\s|$)")
    ) {
        return $false
    }

    try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
        return [bool]$version.webSocketDebuggerUrl
    } catch {
        return $false
    }
}

function Get-ThreeLaneStatusStaleSeconds {
    $value = 120
    $parsed = 0
    if (
        [int]::TryParse([string]$env:SUPERVISOR_STATUS_STALE_SECONDS, [ref]$parsed) -and
        $parsed -ge 5
    ) {
        $value = $parsed
    }
    return $value
}

function Invoke-MonitoredThreeLaneNode(
    [string[]]$NodeArgs,
    [int]$CdpPort
) {
    $threshold = Get-ThreeLaneStatusStaleSeconds
    $startedAt = [DateTimeOffset]::UtcNow
    $nodeProcess = Start-Process -FilePath 'node.exe' -ArgumentList $NodeArgs -PassThru -NoNewWindow
    $staleRestart = $false

    Write-WrapperLog 'THREE_LANE_MONITOR_STARTED' @{
        pid = [int]$nodeProcess.Id
        stale_after_seconds = [int]$threshold
        cdp_port = $CdpPort
    }

    while (-not $nodeProcess.HasExited) {
        if ((Test-Path $stop) -or (Test-Path $autostartDisabled)) {
            break
        }

        $elapsed = ([DateTimeOffset]::UtcNow - $startedAt).TotalSeconds
        if ($elapsed -ge $threshold) {
            $freshness = Get-LifecycleLaneStatusFreshness -Root $root -StaleAfterSeconds $threshold
            if ($freshness.stale) {
                Write-Host 'THREE-LANE STATUS_STALE detected; restarting Node without mutating lane/project state.'
                Write-Host 'SUPERVISOR_P4_STATUS_STALE_DETECTED=True'
                Write-WrapperLog 'THREE_LANE_STATUS_STALE_RESTART' @{
                    pid = [int]$nodeProcess.Id
                    status_age_seconds = $freshness.age_seconds
                    stale_after_seconds = [int]$threshold
                    status_reason = [string]$freshness.reason
                    cdp_port = $CdpPort
                }
                Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue
                $staleRestart = $true
                break
            }
        }

        Start-Sleep -Seconds 2
        $nodeProcess.Refresh()
    }

    if (-not $nodeProcess.HasExited -and ((Test-Path $stop) -or (Test-Path $autostartDisabled))) {
        for ($i = 0; $i -lt 10 -and -not $nodeProcess.HasExited; $i++) {
            Start-Sleep -Milliseconds 500
            $nodeProcess.Refresh()
        }
        if (-not $nodeProcess.HasExited) {
            Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }

    try { $nodeProcess.WaitForExit() } catch {}

    return [pscustomobject]@{
        exit_code = $(if ($staleRestart) { 77 } elseif ($nodeProcess.HasExited) { [int]$nodeProcess.ExitCode } else { 1 })
        status_stale_restart = [bool]$staleRestart
        pid = [int]$nodeProcess.Id
    }
}

if ((Test-Path $stop) -or (Test-Path $autostartDisabled)) {
    Write-Host 'Supervisor launch blocked by Owner STOP/AUTOSTART_DISABLED.'
    exit 0
}
Set-Content -Path $pidFile -Value $PID -Encoding ascii

try {
    $chromeCandidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    $chrome = $chromeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $chrome) { throw 'Installed Google Chrome not found.' }

    while (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled)) {
        $cdpPort = Get-ExistingDedicatedCdpPort
        if (-not $cdpPort) { $cdpPort = Get-FreeCdpPort }
        $cdpBaseUrl = "http://127.0.0.1:$cdpPort"
        $ready = Test-DedicatedCdpEndpoint -Port $cdpPort

        if (-not $ready) {
            Stop-DedicatedChrome
            Start-Sleep -Milliseconds 750
            $cdpPort = Get-FreeCdpPort
            $cdpBaseUrl = "http://127.0.0.1:$cdpPort"

            # Keep the real Supervisor Chrome UI available for CDP, but automatic
            # boot/recovery must not jump in front of the Owner.
            Start-Process -FilePath $chrome -WindowStyle Minimized -ArgumentList @(
                '--remote-debugging-address=127.0.0.1',
                "--remote-debugging-port=$cdpPort",
                ('--user-data-dir="' + $profile + '"'),
                '--no-first-run',
                '--no-default-browser-check',
                '--start-minimized',
                'https://chatgpt.com/'
            )

            for ($i = 0; $i -lt 30; $i++) {
                if (Test-Path $stop) { break }
                if (Test-DedicatedCdpEndpoint -Port $cdpPort) {
                    $ready = $true
                    break
                }
                Start-Sleep -Seconds 1
            }
        }

        if (-not $ready) {
            Start-Sleep -Seconds 5
            continue
        }

        $runtimeMode = $null
        $adapterFailure = $null
        try {
            $projectState = Read-ConfiguredProjectAdapterState
            if ($projectState -and $projectState.supervisor_orchestration) {
                $candidateMode = [string]$projectState.supervisor_orchestration.mode
                if (-not [string]::IsNullOrWhiteSpace($candidateMode)) {
                    $runtimeMode = $candidateMode
                    Write-WrapperLog 'RUNTIME_MODE_FROM_PROJECT_ADAPTER' @{
                        mode = $runtimeMode
                    }
                }
            }
        } catch {
            $adapterFailure = $_.Exception.GetType().Name
            Write-WrapperLog 'PROJECT_ADAPTER_UNAVAILABLE' @{
                error_name = $adapterFailure
            }
        }

        if (-not $runtimeMode) {
            $runtimeMode = Resolve-LocalRuntimeMode
            if ($runtimeMode) {
                Write-WrapperLog 'RUNTIME_MODE_FROM_LOCAL_PLATFORM_TRUTH' @{
                    mode = $runtimeMode
                    adapter_state = $(if ($adapterFailure) { 'ERROR' } else { 'NOT_CONFIGURED_OR_NO_MODE' })
                }
            }
        }

        if (-not $runtimeMode) {
            Write-WrapperLog 'RUNTIME_MODE_UNRESOLVED' @{
                adapter_state = $(if ($adapterFailure) { 'ERROR' } else { 'NOT_CONFIGURED_OR_NO_MODE' })
            }
            Write-Host 'No authoritative runtime mode is available; preserving wrapper and retrying fail-closed.'
            Start-Sleep -Seconds 5
            continue
        }

        $entryPoint = switch ($runtimeMode) {
            'THREE_LANE_V1' { 'src/runtime/three-lane-cli.mjs' }
            'BRAIN_WORKER_V1' { 'src/runtime/brain-worker-cli.mjs' }
            default { 'src/runtime/supervisor-loop-cli.mjs' }
        }

        if ($runtimeMode -notin @('THREE_LANE_V1','BRAIN_WORKER_V1') -and -not (Test-Path $target)) {
            Write-Host 'Legacy mode was explicitly selected but no legacy target exists; waiting for authoritative project state instead of terminating.'
            Start-Sleep -Seconds 5
            continue
        }

        Write-Host "Supervisor entry point: $entryPoint"
        Write-WrapperLog 'NODE_LAUNCH' @{
            mode = $runtimeMode
            entry_point = $entryPoint
            cdp_port = $cdpPort
            dry_run = [bool]$DryRun
        }

        Push-Location $runtime
        try {
            $entryPointPath = Join-Path $runtime $entryPoint
            $nodeArgs = @($entryPointPath, '--cdp-url', $cdpBaseUrl, '--poll-ms', '5000')
            if ($entryPoint -in @('src/runtime/brain-worker-cli.mjs','src/runtime/supervisor-loop-cli.mjs')) {
                if (-not [string]::IsNullOrWhiteSpace($projectAdapterPath)) {
                    $nodeArgs += @('--project-adapter', $projectAdapterPath)
                } elseif (-not [string]::IsNullOrWhiteSpace($projectAdapterUrl)) {
                    $nodeArgs += @('--project-adapter-url', $projectAdapterUrl)
                } else {
                    Write-Host 'Project adapter is required for legacy/brain-worker mode; waiting fail-closed.'
                    Start-Sleep -Seconds 5
                    continue
                }
            }
            if (-not $DryRun) { $nodeArgs += '--execute' }

            $statusStaleRestart = $false
            if ($entryPoint -eq 'src/runtime/three-lane-cli.mjs') {
                $nodeOutcome = Invoke-MonitoredThreeLaneNode -NodeArgs $nodeArgs -CdpPort $cdpPort
                $nodeExitCode = [int]$nodeOutcome.exit_code
                $statusStaleRestart = [bool]$nodeOutcome.status_stale_restart
            } else {
                & node @nodeArgs
                $nodeExitCode = $LASTEXITCODE
            }

            Write-WrapperLog 'NODE_EXIT' @{
                mode = $runtimeMode
                entry_point = $entryPoint
                exit_code = $nodeExitCode
                cdp_port = $cdpPort
                status_stale_restart = [bool]$statusStaleRestart
            }
        } finally {
            Pop-Location
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled) -and $nodeExitCode -eq 75) {
            # Exit code 75 is the Supervisor's explicit request for a clean CDP
            # recovery. Kill only the dedicated Supervisor Chrome profile even
            # when /json/version still answers, then let the outer gate relaunch it.
            Write-Host 'Supervisor requested dedicated Chrome restart after repeated CDP failures.'
            Write-WrapperLog 'CDP_RECYCLE_REQUESTED' @{
                exit_code = $nodeExitCode
                cdp_port = $cdpPort
            }
            Stop-DedicatedChrome
            Start-Sleep -Milliseconds 750
            continue
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled) -and $statusStaleRestart) {
            Write-Host 'Three-Lane Node restarted because lane-status exceeded freshness threshold.'
            Write-WrapperLog 'THREE_LANE_STATUS_STALE_RELAUNCH' @{
                stale_after_seconds = [int](Get-ThreeLaneStatusStaleSeconds)
                cdp_port = $cdpPort
            }
            Start-Sleep -Seconds 1
            continue
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled) -and $nodeExitCode -eq 76) {
            # Exit code 76 is an intentional autonomy pause. Do not keep an
            # automation browser open when source-of-truth says there is no
            # authorized work to execute.
            Write-Host 'Supervisor entered PAUSED autonomy; closing dedicated Chrome and stopping wrapper.'
            Stop-DedicatedChrome
            break
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled)) {
            Start-Sleep -Seconds 3
        }
    }
} finally {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    if ($ownsMutex) {
        try { $mutex.ReleaseMutex() } catch {}
    }
    $mutex.Dispose()
}
