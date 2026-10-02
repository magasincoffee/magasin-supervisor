param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime = Join-Path $root 'runtime'
$env:SUPERVISOR_STATE_ROOT = $root
$profile = Join-Path $root 'browser_profile'
$singleConversationControlFile = Join-Path $root 'single-conversation-control.json'
$singleConversationStateFile = Join-Path $root 'single-conversation-state.json'
function Resolve-LocalRuntimeMode {
    try {
        if (-not (Test-Path $singleConversationControlFile -PathType Leaf)) {
            return $null
        }
        $singleControl = Get-Content $singleConversationControlFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if (
            [string]$singleControl.schema_version -eq 'single-conversation-control.v1' -and
            [string]$singleControl.mode -eq 'SINGLE_CONVERSATION_V1' -and
            -not [string]::IsNullOrWhiteSpace([string]$singleControl.source_of_truth_url)
        ) {
            return 'SINGLE_CONVERSATION_V1'
        }
    } catch {}
    return $null
}

# SINGLE_CONVERSATION_V1 owns its own singleton namespace. The historical
# MAGASIN_BUSINESS_OS_SUPERVISOR mutex is intentionally not reused because a
# legacy process from the superseded architecture must never block the forward
# wrapper from starting.
$mutexName = 'Local\MAGASIN_SUPERVISOR_SINGLE_CONVERSATION_V1'
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

function Get-SingleConversationProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -match 'single-conversation-cli\.mjs'
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

function Stop-OrphanedSingleConversationProcesses {
    foreach ($nodeProcess in (Get-SingleConversationProcesses)) {
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($nodeProcess.ParentProcessId)" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not (Test-WrapperProcessForCurrentRoot $parent)) {
            Write-Host "Stopping orphaned Single-Conversation Node PID $($nodeProcess.ProcessId) (parent $($nodeProcess.ParentProcessId))."
            Stop-Process -Id ([int]$nodeProcess.ProcessId) -Force -ErrorAction SilentlyContinue
        }
    }
}

function Stop-CurrentWrapperSingleConversationChildren {
    Get-SingleConversationProcesses |
        Where-Object { [int]$_.ParentProcessId -eq [int]$PID } |
        ForEach-Object {
            Write-Host "Stopping Single-Conversation child PID $($_.ProcessId) owned by wrapper $PID."
            Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
        }
}

# A wrapper crash/forced restart can orphan Node on Windows. Reclaim stale
# children before this wrapper becomes authoritative, so exactly one writer
# can own lane-registry/lane-status at a time.
Stop-OrphanedSingleConversationProcesses

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

        $runtimeMode = Resolve-LocalRuntimeMode
        if ($runtimeMode -ne 'SINGLE_CONVERSATION_V1') {
            Write-Host 'SINGLE_CONVERSATION_CONTROL_REQUIRED=True'
            Write-Host 'No valid SINGLE_CONVERSATION_V1 control record is available; waiting fail-closed.'
            Start-Sleep -Seconds 5
            continue
        }

        $entryPoint = 'src/runtime/single-conversation-cli.mjs'
        Write-Host "Supervisor entry point: $entryPoint"

        Push-Location $runtime
        try {
            $pollMs = if ($env:SUPERVISOR_SINGLE_CONVERSATION_POLL_MS) {
                [string]$env:SUPERVISOR_SINGLE_CONVERSATION_POLL_MS
            } else {
                '2000'
            }

            $singleControl = Get-Content $singleConversationControlFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $sourceOfTruth = [string]$singleControl.source_of_truth_url
            if ([string]::IsNullOrWhiteSpace($sourceOfTruth)) {
                throw 'SINGLE_CONVERSATION_V1 control record has no Source of Truth.'
            }

            $nodeArgs = @(
                $entryPoint,
                '--cdp-url', $cdpBaseUrl,
                '--poll-ms', $pollMs,
                '--state', $singleConversationStateFile,
                '--source-of-truth', $sourceOfTruth
            )
            if (-not $DryRun) { $nodeArgs += '--execute' }

            & node @nodeArgs
            $nodeExitCode = $LASTEXITCODE
        } finally {
            Pop-Location
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
    Stop-CurrentWrapperSingleConversationChildren
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    if ($ownsMutex) {
        try { $mutex.ReleaseMutex() } catch {}
    }
    $mutex.Dispose()
}
