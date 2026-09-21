param(
    [switch]$SkipGitPull
)

$ErrorActionPreference = 'Stop'

$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = $sourceRoot
$installScript = Join-Path $sourceRoot 'windows\install-supervisor.ps1'
$sourceLifecycle = Join-Path $sourceRoot 'windows\lifecycle-truth.ps1'
. (Join-Path $PSScriptRoot 'state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime = Join-Path $root 'runtime'
$runtimeLoop = Join-Path $runtime 'src\runtime\supervisor-loop-cli.mjs'
$runtimeBrainWorker = Join-Path $runtime 'src\runtime\brain-worker-cli.mjs'
$runtimeThreeLane = Join-Path $runtime 'src\runtime\three-lane-cli.mjs'
$runtimeRun = Join-Path $runtime 'windows\run-supervisor.ps1'
$runtimeStart = Join-Path $runtime 'windows\start-supervisor.ps1'
$profile = Join-Path $root 'browser_profile'
$target = Join-Path $root 'target.json'
$pidFile = Join-Path $root 'supervisor.pid'
$logFile = Join-Path $root 'supervisor.log'
$projectAdapterPath = [string]$env:SUPERVISOR_PROJECT_ADAPTER_PATH
$projectAdapterUrl = [string]$env:SUPERVISOR_PROJECT_ADAPTER_URL
if (-not [string]::IsNullOrWhiteSpace($projectAdapterPath) -and -not [string]::IsNullOrWhiteSpace($projectAdapterUrl)) {
    throw 'Configure exactly one project adapter source during repair.'
}
$sourceThreeLane = Join-Path $sourceRoot 'src\runtime\three-lane-cli.mjs'

function Get-SupervisorRuntimeVersion([string]$Path) {
    if (-not (Test-Path $Path)) { throw "Supervisor runtime source missing: $Path" }
    $source = Get-Content $Path -Raw -Encoding UTF8
    $match = [regex]::Match($source, 'SUPERVISOR_RUNTIME_VERSION\s*=\s*"([^"]+)"')
    if (-not $match.Success) { throw "Supervisor runtime version marker missing: $Path" }
    return [string]$match.Groups[1].Value
}

$expectedRuntimeVersion = Get-SupervisorRuntimeVersion -Path $sourceThreeLane

if (-not (Test-Path $sourceLifecycle)) { throw "Lifecycle truth helper missing: $sourceLifecycle" }
. $sourceLifecycle

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Stop-DedicatedSupervisorChrome {
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
        ForEach-Object {
            Write-Host "Stopping dedicated Supervisor Chrome PID $($_.ProcessId)."
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
}

function Stop-OrphanedSupervisorLoops {
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like '*run-supervisor.ps1*' -and
            $_.CommandLine -like "*$root*"
        } |
        ForEach-Object {
            Write-Host "Stopping Supervisor wrapper PID $($_.ProcessId)."
            & taskkill.exe /PID $_.ProcessId /T /F | Out-Host
        }

    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match '(supervisor-loop-cli|brain-worker-cli|three-lane-cli)\.mjs' } |
        ForEach-Object {
            Write-Host "Stopping Supervisor Node PID $($_.ProcessId)."
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
}

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

function Assert-SourceFingerprint {
    $threeLaneSource = Join-Path $sourceRoot 'src\runtime\three-lane-cli.mjs'
    $runSource = Join-Path $sourceRoot 'windows\run-supervisor.ps1'

    if (-not (Test-Path $threeLaneSource)) {
        throw 'Source is missing three-lane-cli.mjs.'
    }
    $sourceVersion = Get-SupervisorRuntimeVersion -Path $threeLaneSource
    if ($sourceVersion -ne $expectedRuntimeVersion) {
        throw "Three-Lane source runtime version changed during repair."
    }
    if (-not (Select-String -Path $runSource -SimpleMatch 'THREE_LANE_V1' -Quiet)) {
        throw 'Source launcher is missing THREE_LANE_V1 mode.'
    }
    if (-not (Select-String -Path $runSource -SimpleMatch 'Get-FreeCdpPort' -Quiet)) {
        throw 'Source is missing Get-FreeCdpPort.'
    }
    if (-not (Select-String -Path $runSource -SimpleMatch 'Test-DedicatedCdpEndpoint' -Quiet)) {
        throw 'Source is missing Test-DedicatedCdpEndpoint.'
    }
    if (-not (Select-String -Path $runSource -SimpleMatch 'MAGASIN_BUSINESS_OS_SUPERVISOR' -Quiet)) {
        throw 'Source is missing the singleton Supervisor mutex.'
    }
}

function Assert-InstalledFingerprint {
    if (-not (Test-Path $runtimeRun)) {
        throw "Installed runtime launcher missing: $runtimeRun"
    }
    if (-not (Test-Path $runtimeThreeLane)) {
        throw "Installed Three-Lane runtime missing: $runtimeThreeLane"
    }
    if (-not (Select-String -Path $runtimeThreeLane -SimpleMatch $expectedRuntimeVersion -Quiet)) {
        throw "Installed Three-Lane runtime is not version $expectedRuntimeVersion."
    }
    if (-not (Select-String -Path $runtimeRun -SimpleMatch 'THREE_LANE_V1' -Quiet)) {
        throw 'Installed runtime launcher is missing THREE_LANE_V1 mode.'
    }
    if (-not (Select-String -Path $runtimeRun -SimpleMatch 'Get-FreeCdpPort' -Quiet)) {
        throw 'Installed runtime is missing Get-FreeCdpPort.'
    }
    if (-not (Select-String -Path $runtimeRun -SimpleMatch 'Test-DedicatedCdpEndpoint' -Quiet)) {
        throw 'Installed runtime is missing Test-DedicatedCdpEndpoint.'
    }
    if (-not (Select-String -Path $runtimeRun -SimpleMatch 'MAGASIN_BUSINESS_OS_SUPERVISOR' -Quiet)) {
        throw 'Installed runtime is missing the singleton Supervisor mutex.'
    }
}

try {
    Write-Step '1/7 Verify prerequisites'
    Require-Command 'git'
    Require-Command 'node'
    Require-Command 'npm'

    $nodeVersion = (& node --version).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'node --version failed.' }
    $nodeMajor = [int](($nodeVersion -replace '^v','').Split('.')[0])
    if ($nodeMajor -lt 20) {
        throw "Node.js 20+ is required; found $nodeVersion."
    }
    Write-Host "Node: $nodeVersion"
    Write-Host "Repository: $repoRoot"

    if (-not $SkipGitPull) {
        Write-Step '2/7 Update repository main'
        $branchName = (& git -C $repoRoot branch --show-current).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Could not read current Git branch.' }
        if ($branchName -ne 'main') {
            throw "Repository must be on main; current branch is '$branchName'."
        }

        $dirty = & git -C $repoRoot status --porcelain
        if ($LASTEXITCODE -ne 0) { throw 'git status failed.' }
        if ($dirty) {
            throw 'Repository has local changes. Repair stopped to avoid overwriting them.'
        }

        & git -C $repoRoot pull --ff-only origin main
        if ($LASTEXITCODE -ne 0) { throw 'git pull --ff-only origin main failed.' }
    } else {
        Write-Step '2/7 Repository update skipped by request'
    }

    Assert-SourceFingerprint
    Write-Host "Source fingerprint: PASS ($expectedRuntimeVersion)"

    Write-Step '3/7 Stop old Supervisor runtime without changing Owner STOP'
    $ownerStopBeforeRepair = Get-LifecycleOwnerStopState -Root $root
    $enabledLaneCountBeforeRepair = Get-EnabledLaneCount -Root $root

    if (Test-Path $pidFile) {
        $pidValue = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($pidValue -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
            & taskkill.exe /PID $pidValue /T /F | Out-Host
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
    Stop-OrphanedSupervisorLoops
    Stop-DedicatedSupervisorChrome
    Start-Sleep -Milliseconds 750

    Write-Step '4/7 Install fresh runtime'
    if (-not (Test-Path $installScript)) {
        throw "Installer missing: $installScript"
    }
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installScript -SourceRoot $sourceRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Installer exited with code $LASTEXITCODE."
    }

    Write-Step '5/7 Verify installed runtime'
    Assert-InstalledFingerprint
    Write-Host "Installed runtime fingerprint: PASS ($expectedRuntimeVersion)"

    $projectState = $null
    try {
        $adapter = $null
        if (-not [string]::IsNullOrWhiteSpace($projectAdapterPath)) {
            if (-not (Test-Path $projectAdapterPath)) { throw "Configured project adapter file is missing: $projectAdapterPath" }
            $adapter = Get-Content $projectAdapterPath -Raw -Encoding UTF8 | ConvertFrom-Json
        } elseif (-not [string]::IsNullOrWhiteSpace($projectAdapterUrl)) {
            $adapter = Invoke-RestMethod -Uri $projectAdapterUrl -TimeoutSec 4 -Headers @{ 'Cache-Control'='no-cache' }
        }
        if ($adapter) {
            if ([string]$adapter.schema_version -ne 'supervisor-project-adapter.v1' -or -not $adapter.project_state) {
                throw 'Configured project adapter is invalid.'
            }
            $projectState = $adapter.project_state
        }
    } catch {
        throw "Project adapter validation failed during repair: $($_.Exception.Message)"
    }

    $threeLaneMode = [bool](
        $projectState -and
        $projectState.supervisor_orchestration -and
        [string]$projectState.supervisor_orchestration.mode -eq 'THREE_LANE_V1'
    )
    $brainWorkerMode = [bool](
        $projectState -and
        $projectState.supervisor_orchestration -and
        [string]$projectState.supervisor_orchestration.mode -eq 'BRAIN_WORKER_V1'
    )
    if (-not $projectState) {
        $localLaneConfig = Read-LifecycleJson (Join-Path $root 'lanes.json')
        $localRegistry = Read-LifecycleJson (Join-Path $root 'orchestration.json')
        $threeLaneMode = [bool]($localLaneConfig -and [string]$localLaneConfig.mode -eq 'THREE_LANE_V1')
        $brainWorkerMode = [bool]($localRegistry -and [string]$localRegistry.mode -eq 'BRAIN_WORKER_V1')
    }

    $ownerStopAfterInstall = Get-LifecycleOwnerStopState -Root $root
    $enabledLaneCountAfterInstall = Get-EnabledLaneCount -Root $root
    $bootSuppressed = [bool]($ownerStopAfterInstall.blocked -or $enabledLaneCountAfterInstall -lt 1)

    if ($bootSuppressed) {
        Write-Step '6/7 Runtime boot intentionally suppressed by lifecycle truth'
        if ($ownerStopAfterInstall.blocked) {
            Write-Host 'OWNER_STOP_PRESERVED=True'
        } else {
            Write-Host 'ALL_LANES_DISABLED=True'
        }
    } else {
        Write-Step '6/7 Recover Supervisor and verify boot'
        $beforeCount = 0
        if (Test-Path $logFile) {
            $beforeCount = @(Get-Content $logFile -ErrorAction SilentlyContinue).Count
        }

        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runtimeStart -Hidden -Recovery
        if ($LASTEXITCODE -ne 0) {
            throw "Supervisor recovery START exited with code $LASTEXITCODE."
        }

        $bootVerified = $false
        $newLines = @()
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Seconds 1

            if (Test-Path $logFile) {
                $allLines = @(Get-Content $logFile -ErrorAction SilentlyContinue)
                if ($allLines.Count -gt $beforeCount) {
                    $newLines = @($allLines | Select-Object -Skip $beforeCount)
                    if ($newLines -match "RUNTIME_BOOT.*version=$([regex]::Escape($expectedRuntimeVersion))") {
                        $bootVerified = $true
                        break
                    }
                }
            }
        }

        if (-not $bootVerified) {
            $tail = if (Test-Path $logFile) {
                (Get-Content $logFile -Tail 12 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
            } else {
                'Supervisor log not found.'
            }
            throw "Supervisor did not emit RUNTIME_BOOT version=$expectedRuntimeVersion within 20 seconds.
$tail"
        }

        Write-Host "Runtime boot marker: PASS (version=$expectedRuntimeVersion)"
    }

    Write-Step '7/7 Runtime status'
    Start-Sleep -Seconds 2

    $wrapperProcesses = @(
        Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine -like '*run-supervisor.ps1*' -and
                $_.CommandLine -like "*$root*"
            }
    )
    $loopProcesses = @(
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match '(supervisor-loop-cli|brain-worker-cli|three-lane-cli)\.mjs' }
    )

    if ($bootSuppressed) {
        Write-Host "Supervisor wrapper count: $($wrapperProcesses.Count)"
        Write-Host "Supervisor Node loop count: $($loopProcesses.Count)"
        if ($wrapperProcesses.Count -ne 0 -or $loopProcesses.Count -ne 0) {
            throw "Lifecycle-suppressed repair must leave runtime stopped: wrappers=$($wrapperProcesses.Count), nodeLoops=$($loopProcesses.Count)."
        }
        Write-Host 'Runtime status: STOPPED_BY_LIFECYCLE_TRUTH'
    } else {
        $pidValue = if (Test-Path $pidFile) {
            Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        } else {
            $null
        }

        if (-not $pidValue -or -not (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
            throw 'Supervisor wrapper process is not running after verified boot.'
        }

        Write-Host "Supervisor PID: $pidValue"
        Write-Host "Supervisor wrapper count: $($wrapperProcesses.Count)"
        Write-Host "Supervisor Node loop count: $($loopProcesses.Count)"

        if ($wrapperProcesses.Count -ne 1 -or $loopProcesses.Count -ne 1) {
            throw "Supervisor singleton verification failed: wrappers=$($wrapperProcesses.Count), nodeLoops=$($loopProcesses.Count)."
        }

        Write-Host 'Last safe log lines:'
        Get-Content $logFile -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }

        $statusFile = if ($threeLaneMode) {
            Join-Path $root 'lane-status.json'
        } else {
            Join-Path $root 'runtime-status.json'
        }
        if (Test-Path $statusFile) {
            try {
                $status = Get-Content $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
                Write-Host ""
                if ($threeLaneMode) {
                    Write-Host "Runtime mode: THREE_LANE_V1"
                    Write-Host "Lane status count: $(@($status.lanes).Count)"
                } else {
                    Write-Host "Runtime status: $($status.status)"
                    Write-Host "Task: $($status.current_task) - $($status.current_task_title)"
                    if ($status.error_name) { Write-Host "Error: $($status.error_name)" -ForegroundColor Yellow }
                }
            } catch {}
        }
    }

    $shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MAGASIN BUSINESS OS CONTROL.lnk'
    if (Test-Path $shortcutPath) {
        Start-Process $shortcutPath
    }

    Write-Host ""
    Write-Host 'REPAIR_RESULT=PASS' -ForegroundColor Green
    if ($bootSuppressed) {
        Write-Host 'Supervisor was reinstalled; runtime boot remained suppressed by Owner STOP or all-lanes-disabled truth.'
    } else {
        Write-Host 'Supervisor was reinstalled and recovered with the expected runtime version.'
    }
} catch {
    Write-Host ""
    Write-Host 'REPAIR_RESULT=FAIL' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host 'Do not retry repeatedly. Copy or screenshot this result for diagnosis.' -ForegroundColor Yellow
    exit 1
}
