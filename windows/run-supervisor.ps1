param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$root = & (Join-Path $PSScriptRoot 'state-root.ps1')
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
$projectInputUrl = [string]$env:MAGASIN_SUPERVISOR_PROJECT_INPUT_URL
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
        try {
            if (-not [string]::IsNullOrWhiteSpace($projectInputUrl)) {
                $projectState = Invoke-RestMethod -Uri $projectInputUrl -TimeoutSec 4 -Headers @{ 'Cache-Control'='no-cache' }
                $adapterOrchestration = if ($projectState.orchestration) { $projectState.orchestration } else { $projectState.supervisor_orchestration }
                if ($adapterOrchestration) {
                    $runtimeMode = [string]$adapterOrchestration.mode
                }
            } else {
                throw 'No explicit project input URL configured'
            }
        } catch {
            # Preserve the last locally verified runtime mode during transient
            # repository/network failures; never guess a downgrade.
            try {
                if (Test-Path $laneStatusFile) {
                    $laneStatus = Get-Content $laneStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json
                    if ([string]$laneStatus.mode -eq 'THREE_LANE_V1') {
                        $runtimeMode = 'THREE_LANE_V1'
                    }
                }
            } catch {}

            if (-not $runtimeMode) {
                try {
                    if (Test-Path $laneConfigFile) {
                        $laneConfig = Get-Content $laneConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
                        if ([string]$laneConfig.mode -eq 'THREE_LANE_V1') {
                            $runtimeMode = 'THREE_LANE_V1'
                        }
                    }
                } catch {}
            }

            if (-not $runtimeMode) {
                try {
                    if (Test-Path $registryFile) {
                        $registry = Get-Content $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json
                        if ([string]$registry.mode -eq 'BRAIN_WORKER_V1') {
                            $runtimeMode = 'BRAIN_WORKER_V1'
                        }
                    }
                } catch {}
            }

            if (-not $runtimeMode) {
                try {
                    if (Test-Path $runtimeStatusFile) {
                        $runtimeStatus = Get-Content $runtimeStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json
                        if ([string]$runtimeStatus.orchestration_mode -eq 'BRAIN_WORKER_V1') {
                            $runtimeMode = 'BRAIN_WORKER_V1'
                        }
                    }
                } catch {}
            }

            if (-not $runtimeMode) {
                Write-Host 'Project state is temporarily unavailable; preserving wrapper and retrying without mode downgrade.'
                Start-Sleep -Seconds 5
                continue
            }
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

        Push-Location $runtime
        try {
            $nodeArgs = @($entryPoint, '--cdp-url', $cdpBaseUrl, '--poll-ms', '5000')
            if ($entryPoint -ne 'src/runtime/three-lane-cli.mjs' -and -not [string]::IsNullOrWhiteSpace($projectInputUrl)) {
                $nodeArgs += @('--project-input-url', $projectInputUrl)
            }
            if (-not $DryRun) { $nodeArgs += '--execute' }
            & node @nodeArgs
            $nodeExitCode = $LASTEXITCODE
        } finally {
            Pop-Location
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
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    if ($ownsMutex) {
        try { $mutex.ReleaseMutex() } catch {}
    }
    $mutex.Dispose()
}
