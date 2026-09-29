param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'state-root.ps1')
. (Join-Path $PSScriptRoot 'chatgpt-bridge-runtime.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime = Join-Path $root 'runtime'
$env:SUPERVISOR_STATE_ROOT = $root
$profile = Join-Path $root 'browser_profile'
$target = Join-Path $root 'target.json'
$stop = Join-Path $root 'STOP'
$autostartDisabled = Join-Path $root 'AUTOSTART_DISABLED'
$pidFile = Join-Path $root 'supervisor.pid'
$registryFile = Join-Path $root 'orchestration.json'
$runtimeStatusFile = Join-Path $root 'runtime-status.json'
$laneConfigFile = Join-Path $root 'lanes.json'
$laneStatusFile = Join-Path $root 'lane-status.json'
$plannerExecutorStateFile = Join-Path $root 'planner-executor-state.json'
$plannerExecutorTransportFile = Join-Path $root 'planner-executor-transport.json'
$singleConversationControlFile = Join-Path $root 'single-conversation-control.json'
$singleConversationStateFile = Join-Path $root 'single-conversation-state.json'
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

function Get-PlannerExecutorPrimaryTransport {
    if (-not (Test-Path $plannerExecutorTransportFile -PathType Leaf)) {
        return 'DIRECT_DOM_V1'
    }
    try {
        $transport = Get-Content $plannerExecutorTransportFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$transport.schema_version -ne 'planner-executor-transport.v1') {
            throw 'Unsupported Planner/Executor transport config schema.'
        }
        $primary = [string]$transport.primary
        if ($primary -notin @('DIRECT_DOM_V1','CHATGPT_BRIDGE_V1')) {
            throw "Unsupported Planner/Executor primary transport: $primary"
        }
        if (
            $primary -eq 'CHATGPT_BRIDGE_V1' -and
            [string]$transport.bridge_upstream_commit -ne $script:ChatGptBridgePinnedCommit
        ) {
            throw 'Planner/Executor Bridge transport pin mismatch.'
        }
        return $primary
    } catch {
        throw "Planner/Executor transport config is invalid: $($_.Exception.Message)"
    }
}

function Resolve-LocalRuntimeMode {
    # SINGLE_CONVERSATION_V1 is the forward runtime authority once the
    # Control Center persists a Source-of-Truth-only control record.
    try {
        if (Test-Path $singleConversationControlFile) {
            $singleControl = Get-Content $singleConversationControlFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if (
                [string]$singleControl.schema_version -eq 'single-conversation-control.v1' -and
                [string]$singleControl.mode -eq 'SINGLE_CONVERSATION_V1' -and
                -not [string]::IsNullOrWhiteSpace([string]$singleControl.source_of_truth_url)
            ) {
                return 'SINGLE_CONVERSATION_V1'
            }
        }
    } catch {}

    # Planner/Executor remains rollback-compatible when no forward control
    # record exists.
    try {
        if (Test-Path $plannerExecutorStateFile) {
            $plannerExecutorState = Get-Content $plannerExecutorStateFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$plannerExecutorState.mode -eq 'PLANNER_EXECUTOR_V1') {
                return 'PLANNER_EXECUTOR_V1'
            }
        }
    } catch {}

    # The standalone Supervisor owns platform-local orchestration truth.
    # A project adapter is optional for THREE_LANE_V1, so local mode
    # resolution must run whenever the adapter supplies no mode, not only
    # when adapter access throws.
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
$mutexName = 'Local\MAGASIN_BUSINESS_OS_SUPERVISOR'
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

function Get-ThreeLaneProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -match '(three-lane-cli|planner-executor-cli|planner-executor-bridge-cli|single-conversation-cli)\.mjs'
        })
}

function Test-WrapperProcessForCurrentRoot($Process) {
    return [bool](
        $Process -and
        $Process.Name -eq 'powershell.exe' -and
        $Process.CommandLine -and
        $Process.CommandLine -like '*run-supervisor.ps1*' -and
        $Process.CommandLine -like "*$root*"
    )
}

function Stop-OrphanedThreeLaneProcesses {
    foreach ($nodeProcess in (Get-ThreeLaneProcesses)) {
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($nodeProcess.ParentProcessId)" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not (Test-WrapperProcessForCurrentRoot $parent)) {
            Write-Host "Stopping orphaned Three-Lane Node PID $($nodeProcess.ProcessId) (parent $($nodeProcess.ParentProcessId))."
            Stop-Process -Id ([int]$nodeProcess.ProcessId) -Force -ErrorAction SilentlyContinue
        }
    }
}

function Stop-CurrentWrapperThreeLaneChildren {
    Get-ThreeLaneProcesses |
        Where-Object { [int]$_.ParentProcessId -eq [int]$PID } |
        ForEach-Object {
            Write-Host "Stopping Three-Lane child PID $($_.ProcessId) owned by wrapper $PID."
            Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
        }
}

# A wrapper crash/forced restart can orphan Node on Windows. Reclaim stale
# children before this wrapper becomes authoritative, so exactly one writer
# can own lane-registry/lane-status at a time.
Stop-OrphanedThreeLaneProcesses

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
                '--hide-crash-restore-bubble',
                '--start-minimized',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-features=CalculateNativeWinOcclusion',
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

        # Forward single-conversation and rollback Planner/Executor are both
        # local runtime authorities. Only legacy modes consult project adapters.
        $runtimeMode = Resolve-LocalRuntimeMode
        if ($runtimeMode -notin @('SINGLE_CONVERSATION_V1','PLANNER_EXECUTOR_V1')) {
            try {
                $projectState = Read-ConfiguredProjectAdapterState
                if ($projectState -and $projectState.supervisor_orchestration) {
                    $candidateMode = [string]$projectState.supervisor_orchestration.mode
                    if (-not [string]::IsNullOrWhiteSpace($candidateMode)) {
                        $runtimeMode = $candidateMode
                    }
                }
            } catch {
                # Adapter failure is not authority to downgrade. Keep local
                # platform truth when available.
            }
        }

        if (-not $runtimeMode) {
            Write-Host 'No authoritative runtime mode is available; preserving wrapper and retrying fail-closed.'
            Start-Sleep -Seconds 5
            continue
        }

        $plannerExecutorTransport = if ($runtimeMode -eq 'PLANNER_EXECUTOR_V1') {
            Get-PlannerExecutorPrimaryTransport
        } else {
            $null
        }

        $entryPoint = switch ($runtimeMode) {
            'SINGLE_CONVERSATION_V1' { 'src/runtime/single-conversation-cli.mjs' }
            'PLANNER_EXECUTOR_V1' {
                if ($plannerExecutorTransport -eq 'CHATGPT_BRIDGE_V1') {
                    'src/runtime/planner-executor-bridge-cli.mjs'
                } else {
                    'src/runtime/planner-executor-cli.mjs'
                }
            }
            'THREE_LANE_V1' { 'src/runtime/three-lane-cli.mjs' }
            'BRAIN_WORKER_V1' { 'src/runtime/brain-worker-cli.mjs' }
            default { 'src/runtime/supervisor-loop-cli.mjs' }
        }

        # target.json belongs only to legacy target-bound runtimes.
        # SINGLE_CONVERSATION_V1 is Source-of-Truth-only and MUST proceed when
        # target.json is absent.
        if ($runtimeMode -notin @('SINGLE_CONVERSATION_V1','PLANNER_EXECUTOR_V1','THREE_LANE_V1','BRAIN_WORKER_V1') -and -not (Test-Path $target)) {
            Write-Host 'Legacy mode was explicitly selected but no legacy target exists; waiting for authoritative project state instead of terminating.'
            Start-Sleep -Seconds 5
            continue
        }

        Write-Host "Supervisor entry point: $entryPoint"
        if ($runtimeMode -eq 'PLANNER_EXECUTOR_V1') {
            Write-Host "Planner/Executor transport: $plannerExecutorTransport"
        }

        $bridgeBackendProcess = $null
        if ($entryPoint -eq 'src/runtime/planner-executor-bridge-cli.mjs') {
            $bridgeInfo = Assert-ChatGptBridgePinnedInstall -Root $root
            $bridgeBackendProcess = Start-ChatGptBridgeBackend -Root $root
            $env:SUPERVISOR_CHATGPT_BRIDGE_ROOT = $bridgeInfo.RepoRoot
        }

        Push-Location $runtime
        try {
            $pollMs = if ($env:SUPERVISOR_THREE_LANE_POLL_MS) {
                [string]$env:SUPERVISOR_THREE_LANE_POLL_MS
            } else {
                '2000'
            }
            $pageBudget = if ($env:SUPERVISOR_CHATGPT_PAGE_BUDGET) {
                [string]$env:SUPERVISOR_CHATGPT_PAGE_BUDGET
            } else {
                '4'
            }

            $nodeArgs = @($entryPoint, '--cdp-url', $cdpBaseUrl, '--poll-ms', $pollMs)
            if ($entryPoint -eq 'src/runtime/single-conversation-cli.mjs') {
                $singleControl = Get-Content $singleConversationControlFile -Raw -Encoding UTF8 | ConvertFrom-Json
                $sourceOfTruth = [string]$singleControl.source_of_truth_url
                if ([string]::IsNullOrWhiteSpace($sourceOfTruth)) {
                    throw 'SINGLE_CONVERSATION_V1 control record has no Source of Truth.'
                }
                $nodeArgs += @(
                    '--state', $singleConversationStateFile,
                    '--source-of-truth', $sourceOfTruth
                )
            }
            if ($entryPoint -in @('src/runtime/planner-executor-cli.mjs','src/runtime/planner-executor-bridge-cli.mjs')) {
                $nodeArgs += @('--state', $plannerExecutorStateFile)
            }
            if ($entryPoint -eq 'src/runtime/planner-executor-bridge-cli.mjs') {
                $nodeArgs += @(
                    '--bridge-url', 'http://127.0.0.1:5000',
                    '--bridge-root', [string]$env:SUPERVISOR_CHATGPT_BRIDGE_ROOT
                )
            }
            if ($entryPoint -eq 'src/runtime/three-lane-cli.mjs') {
                $nodeArgs += @(
                    '--wrapper-pid', [string]$PID,
                    '--page-budget', $pageBudget
                )
            }
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
            & node @nodeArgs
            $nodeExitCode = $LASTEXITCODE
        } finally {
            Pop-Location
            if ($bridgeBackendProcess) {
                Stop-ChatGptBridgeBackend -Process $bridgeBackendProcess
                $bridgeBackendProcess = $null
            }
        }

        # SC-012: a durable BLOCKED single-conversation state is a
        # fail-closed autonomy boundary. Never relaunch the runtime in the
        # wrapper loop while that state remains BLOCKED; doing so can repeat
        # disposable replacement/bootstrap and create unbounded chat churn.
        if (
            $runtimeMode -eq 'SINGLE_CONVERSATION_V1' -and
            -not (Test-Path $stop) -and
            -not (Test-Path $autostartDisabled) -and
            (Test-Path $singleConversationStateFile -PathType Leaf)
        ) {
            try {
                $singleStateAfterRun = Get-Content $singleConversationStateFile -Raw -Encoding UTF8 | ConvertFrom-Json
                $singleAutomationAfterRun = [string]$singleStateAfterRun.automation.status
                if ($singleAutomationAfterRun -eq 'BLOCKED') {
                    Write-Host 'SINGLE_CONVERSATION_BLOCKED_PAUSE=True'
                    Write-Host 'Supervisor single-conversation state is BLOCKED; stopping wrapper retry loop to prevent chat churn.'
                    break
                }
            } catch {
                Write-Host "Single-conversation BLOCKED-state inspection failed closed: $($_.Exception.Message)"
                break
            }
        }

        if (-not (Test-Path $stop) -and -not (Test-Path $autostartDisabled) -and $nodeExitCode -eq 75) {
            # Exit code 75 is the Supervisor's explicit request for a clean CDP
            # recovery. Kill only the dedicated Supervisor Chrome profile even
            # when /json/version still answers, then let the outer gate relaunch it.
            Write-Host 'Supervisor requested dedicated Chrome restart after repeated CDP failures.'
            Stop-DedicatedChrome
            Start-Sleep -Milliseconds 750
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
    Stop-CurrentWrapperThreeLaneChildren
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    if ($ownsMutex) {
        try { $mutex.ReleaseMutex() } catch {}
    }
    $mutex.Dispose()
}
