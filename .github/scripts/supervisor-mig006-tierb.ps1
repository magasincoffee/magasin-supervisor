param(
    [Parameter(Mandatory=$true)][string]$CandidateRoot,
    [Parameter(Mandatory=$true)][string]$RuntimeCandidateSha,
    [Parameter(Mandatory=$true)][string]$ControlPlaneSha,
    [Parameter(Mandatory=$true)][string]$ExpectedRunnerName,
    [Parameter(Mandatory=$true)][string]$OwnerReleaseSha,
    [int]$DurationMinutes = 480,
    [int]$SampleSeconds = 120,
    [Parameter(Mandatory=$true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$ExpectedOwnerReleaseSha = 'fac10cff7fc1c5f05ce9b80d101ebd53b3331190'
$ExpectedRuntimeCandidateSha = '218f330ee86eea4f0fb79ef9293bd43cf96a45de'
$ExpectedRunner = 'DESKTOP-4K7IM13'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'MAGASINBusinessOSAutostart'
$failureReason = 'PREFLIGHT_NOT_COMPLETE'
$timerStarted = $false
$attemptStart = $null
$candidateProcess = $null
$rawCandidateSummary = Join-Path $env:RUNNER_TEMP 'mig006-rbt009-candidate-summary.json'
$candidateStdout = Join-Path $env:RUNNER_TEMP 'mig006-rbt009-candidate.stdout.log'
$candidateStderr = Join-Path $env:RUNNER_TEMP 'mig006-rbt009-candidate.stderr.log'
$eventWindowFile = Join-Path $env:RUNNER_TEMP 'mig006-rbt009-event-window.ndjson'

function Write-Utf8NoBom([string]$Path,[string]$Text) {
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false)))
}

function Get-FileSha256([string]$Path) {
    if (-not (Test-Path $Path -PathType Leaf)) { throw 'MIG006_REQUIRED_FILE_MISSING' }
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Append-Utf8NoBomLines([string]$Path,[object[]]$Lines) {
    if (-not $Lines -or @($Lines).Count -lt 1) { return }
    $text = ([string]::Join([Environment]::NewLine,@($Lines))) + [Environment]::NewLine
    [IO.File]::AppendAllText($Path,$text,(New-Object Text.UTF8Encoding($false)))
}

function Read-Json([string]$Path) {
    if (-not (Test-Path $Path -PathType Leaf)) { throw 'MIG006_REQUIRED_STATE_FILE_MISSING' }
    return Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-Topology([string]$Root) {
    $config = Read-Json (Join-Path $Root 'lanes.json')
    $registry = Read-Json (Join-Path $Root 'lane-registry.json')
    return [pscustomobject]@{
        lane_count = @($config.lanes | Where-Object { [string]$_.lane_id -match '^lane-[123]$' }).Count
        registry_lane_count = @($registry.lanes.PSObject.Properties | Where-Object { $_.Name -match '^lane-[123]$' }).Count
        enabled_lane_count = @($config.lanes | Where-Object { [bool]$_.enabled }).Count
    }
}

function Get-AutostartRegistration {
    if (-not (Test-Path $runKey)) {
        return [pscustomobject]@{ present=$false; value=$null }
    }
    $props = Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue
    if (-not $props -or -not ($props.PSObject.Properties.Name -contains $runName)) {
        return [pscustomobject]@{ present=$false; value=$null }
    }
    return [pscustomobject]@{ present=$true; value=[string]$props.$runName }
}

function Assert-NoPendingReboot {
    if (
        (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or
        (Test-Path 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\Auto Update\RebootRequired')
    ) {
        throw 'MIG006_PENDING_REBOOT'
    }
}

function Get-CurrentPowerSource {
    $battery = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $battery) { return 'AC' }
    $status = [int]$battery.BatteryStatus
    if ($status -in @(1,4,5)) { return 'BATTERY' }
    return 'AC'
}

function Get-SleepTimeoutSeconds([string]$PowerSource) {
    $text = (& powercfg.exe /QUERY SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'MIG006_POWERCFG_QUERY_FAILED' }
    $label = if ($PowerSource -eq 'BATTERY') { 'Current DC Power Setting Index' } else { 'Current AC Power Setting Index' }
    $pattern = [regex]::Escape($label) + ':\s+0x([0-9a-fA-F]+)'
    $match = [regex]::Match($text,$pattern)
    if (-not $match.Success) { throw 'MIG006_POWERCFG_SLEEP_PARSE_FAILED' }
    return [Convert]::ToInt64($match.Groups[1].Value,16)
}

function Assert-SleepSafe {
    $source = Get-CurrentPowerSource
    $timeout = Get-SleepTimeoutSeconds -PowerSource $source
    if ($timeout -ne 0) { throw 'MIG006_SLEEP_TIMEOUT_NOT_NEVER' }
    return $source
}

function Assert-NoScheduledUpdateReboot([DateTimeOffset]$Deadline) {
    try {
        $now = Get-Date
        $tasks = @(Get-ScheduledTask -ErrorAction Stop |
            Where-Object {
                (
                    [string]$_.TaskPath -match '(?i)UpdateOrchestrator' -or
                    [string]$_.TaskName -match '(?i)reboot|restart'
                ) -and [string]$_.State -ne 'Disabled'
            })
        foreach ($task in $tasks) {
            $info = Get-ScheduledTaskInfo -InputObject $task -ErrorAction Stop
            if ($info.NextRunTime -and $info.NextRunTime -gt $now -and $info.NextRunTime -le $Deadline.LocalDateTime) {
                throw 'MIG006_UPDATE_REBOOT_SCHEDULED_WITHIN_WINDOW'
            }
        }
        Write-Host "MIG_006_REBOOT_RELATED_TASKS_CHECKED=$($tasks.Count)"
        Write-Host 'MIG_006_UPDATE_REBOOT_WINDOW_CLEAR=True'
    } catch {
        if ($_.Exception.Message -eq 'MIG006_UPDATE_REBOOT_SCHEDULED_WITHIN_WINDOW') { throw }
        throw 'MIG006_UPDATE_REBOOT_QUERY_UNPROVEN'
    }
}

function Assert-ExactRuntimeIdentity([string]$Root,[string]$Candidate) {
    $runtime = Join-Path $Root 'runtime'
    $marker = Join-Path $runtime 'MIG_005_CANDIDATE_SHA.txt'
    if (-not (Test-Path $marker -PathType Leaf)) { throw 'MIG006_RUNTIME_CANDIDATE_MARKER_MISSING' }
    if ((Get-Content $marker -Raw -Encoding UTF8).Trim() -ne $RuntimeCandidateSha) {
        throw 'MIG006_RUNTIME_CANDIDATE_MARKER_MISMATCH'
    }

    $candidateHead = (& git -C $Candidate rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $candidateHead -ne $RuntimeCandidateSha) {
        throw 'MIG006_ISOLATED_CANDIDATE_CHECKOUT_MISMATCH'
    }

    foreach ($top in @('src','windows')) {
        $candidateTop = Join-Path $Candidate $top
        foreach ($file in @(Get-ChildItem -Path $candidateTop -File -Recurse | Sort-Object FullName)) {
            $relative = $file.FullName.Substring($Candidate.Length).TrimStart('\')
            if ($relative -ieq 'windows\control-panel.ps1') { continue }
            $installed = Join-Path $runtime $relative
            if (-not (Test-Path $installed -PathType Leaf)) { throw 'MIG006_INSTALLED_RUNTIME_FILE_MISSING' }
            if ((Get-FileSha256 $file.FullName) -ne (Get-FileSha256 $installed)) {
                throw 'MIG006_INSTALLED_RUNTIME_FILE_IDENTITY_MISMATCH'
            }
        }
    }

    if ((Get-FileSha256 (Join-Path $Candidate 'package.json')) -ne (Get-FileSha256 (Join-Path $runtime 'package.json'))) {
        throw 'MIG006_INSTALLED_PACKAGE_IDENTITY_MISMATCH'
    }
}

function Get-SanitizedCandidateFailureReason([string]$StdoutPath,[string]$StderrPath) {
    $text = ''
    foreach ($path in @($StdoutPath,$StderrPath)) {
        if (Test-Path $path -PathType Leaf) {
            try {
                $chunk = Get-Content $path -Raw -Encoding UTF8 -ErrorAction Stop
                if ($chunk.Length -gt 65536) { $chunk = $chunk.Substring($chunk.Length - 65536) }
                $text += [Environment]::NewLine + $chunk
            } catch {
                return 'LOCKED_CANDIDATE_DIAGNOSTIC_READ_FAILED'
            }
        }
    }

    if ($text -match 'Owner STOP became active during soak') { return 'LOCKED_CANDIDATE_OWNER_STOP_OBSERVED' }
    if ($text -match 'Owner-configured Brain/Work target identity or revision changed during soak|Owner-configured production targets changed by end of soak|TARGET_CHANGED_EXTERNALLY=True') { return 'LOCKED_CANDIDATE_TARGET_CHANGED' }
    if ($text -match 'Supervisor/Chrome/CDP remained unhealthy beyond bounded recovery window') { return 'LOCKED_CANDIDATE_RUNTIME_HEALTH_FAILED' }
    if ($text -match 'ChatGPT page budget exceeded 3') { return 'LOCKED_CANDIDATE_PAGE_BUDGET_EXCEEDED' }
    if ($text -match 'Repeated identical ERROR/RECOVERY event flood detected during soak window') { return 'LOCKED_CANDIDATE_EVENT_FLOOD' }
    if ($text -match 'Continuous soak duration was shorter than requested') { return 'LOCKED_CANDIDATE_DURATION_SHORT' }
    if ($text -match 'Installed lifecycle truth helper is missing') { return 'LOCKED_CANDIDATE_LIFECYCLE_HELPER_MISSING' }
    if ($text -match 'ConvertFrom-Json') { return 'LOCKED_CANDIDATE_JSON_PARSE_FAILED' }
    if ($text -match 'cannot access the file|being used by another process|sharing violation') { return 'LOCKED_CANDIDATE_FILE_ACCESS_FAILED' }
    if ($text -match 'Cannot find path|does not exist') { return 'LOCKED_CANDIDATE_REQUIRED_PATH_MISSING' }
    if ($text -match 'Property .* cannot be found') { return 'LOCKED_CANDIDATE_STRICTMODE_PROPERTY_FAILED' }
    if ($text -match 'Cannot convert value|Invalid cast') { return 'LOCKED_CANDIDATE_TYPE_CONVERSION_FAILED' }
    return 'LOCKED_CANDIDATE_MONITOR_FAILED_UNCLASSIFIED'
}

function Write-FailureSummary([string]$Reason) {
    $now = [DateTimeOffset]::UtcNow
    $duration = 0
    if ($timerStarted -and $attemptStart) {
        $duration = [math]::Max(0,[math]::Floor(($now - $attemptStart).TotalSeconds))
    }
    $summary = [ordered]@{
        schema_version = 'supervisor-mig006-rbt009-final.v1'
        qualification = 'NON_QUALIFYING'
        control_plane_sha = $ControlPlaneSha
        runtime_candidate_sha = $RuntimeCandidateSha
        owner_release_sha = $OwnerReleaseSha
        start_utc = if ($attemptStart) { $attemptStart.ToString('o') } else { $null }
        end_utc = $now.ToString('o')
        duration_seconds = [int64]$duration
        required_duration_seconds = 28800
        sample_seconds = $SampleSeconds
        start_from_zero = $true
        historical_partial_credit_seconds = 0
        interruption_status = 'INTERRUPTED_OR_BLOCKED'
        interruption_reason = $Reason
        runtime_mode = 'ALL_DISABLED_QUIESCENT'
        runtime_authority_active = $false
        chrome_cdp_status = 'NOT_APPLICABLE_ALL_DISABLED'
        privacy_safe = $true
        raw_state_in_artifact = $false
        raw_events_in_artifact = $false
        screenshot_in_artifact = $false
    }
    Write-Utf8NoBom $OutputPath (($summary | ConvertTo-Json -Depth 10) + [Environment]::NewLine)
}

function Stop-CandidateMonitor {
    if ($candidateProcess -and -not $candidateProcess.HasExited) {
        & taskkill.exe /PID $candidateProcess.Id /T /F | Out-Null
        $global:LASTEXITCODE = 0
    }
}

try {
    $CandidateRoot = [IO.Path]::GetFullPath($CandidateRoot)
    if ($DurationMinutes -ne 480) { throw 'MIG006_DURATION_MUST_BE_480_MINUTES' }
    if ($SampleSeconds -ne 120) { throw 'MIG006_SAMPLE_INTERVAL_MUST_BE_120_SECONDS' }
    if ($RuntimeCandidateSha -ne $ExpectedRuntimeCandidateSha) { throw 'MIG006_RUNTIME_CANDIDATE_NOT_LOCKED_SHA' }
    if ($OwnerReleaseSha -ne $ExpectedOwnerReleaseSha) { throw 'MIG006_OWNER_RELEASE_SHA_MISMATCH' }
    if ($ExpectedRunnerName -ne $ExpectedRunner) { throw 'MIG006_EXPECTED_RUNNER_CONTRACT_MISMATCH' }
    if ($ControlPlaneSha -notmatch '^[a-f0-9]{40}$') { throw 'MIG006_CONTROL_PLANE_SHA_INVALID' }

    $workspaceHead = (& git -C $env:GITHUB_WORKSPACE rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $workspaceHead -ne $ControlPlaneSha) { throw 'MIG006_CONTROL_PLANE_CHECKOUT_MISMATCH' }

    if ([string]$env:RUNNER_NAME -ne $ExpectedRunnerName) { throw 'MIG006_RUNNER_NAME_MISMATCH' }
    if ([string]$env:RUNNER_OS -ne 'Windows') { throw 'MIG006_RUNNER_OS_MISMATCH' }
    if ([string]$env:RUNNER_ARCH -ne 'X64') { throw 'MIG006_RUNNER_ARCH_MISMATCH' }

    $nodeVersion = (& node --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.') { throw 'MIG006_NODE_VERSION_UNPROVEN' }
    if ([int]$Matches[1] -lt 20) { throw 'MIG006_NODE_MAJOR_TOO_OLD' }

    $explicitRoot = Join-Path ([string]$env:LOCALAPPDATA) 'MAGASIN\Supervisor'
    $env:SUPERVISOR_STATE_ROOT = [IO.Path]::GetFullPath($explicitRoot)
    . (Join-Path $CandidateRoot 'windows\state-root.ps1')
    $root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
    $expectedRoot = [IO.Path]::GetFullPath($explicitRoot)
    if ([IO.Path]::GetFullPath($root) -ne $expectedRoot) { throw 'MIG006_STATE_ROOT_NOT_PLATFORM_ROOT' }
    if ($root -like '*\MAGASIN\BusinessOS\supervisor') { throw 'MIG006_LEGACY_STATE_ROOT_FORBIDDEN' }

    . (Join-Path $CandidateRoot 'windows\lifecycle-truth.ps1')
    . (Join-Path $CandidateRoot '.github\scripts\supervisor-rbt009-soak-lib.ps1')

    Assert-NoPendingReboot
    $powerSource = Assert-SleepSafe
    Assert-NoScheduledUpdateReboot -Deadline ([DateTimeOffset]::UtcNow.AddMinutes(510))

    $topology = Get-Topology -Root $root
    if ($topology.lane_count -ne 3) { throw 'MIG006_LANE_COUNT_MISMATCH' }
    if ($topology.registry_lane_count -ne 3) { throw 'MIG006_REGISTRY_LANE_COUNT_MISMATCH' }
    if ($topology.enabled_lane_count -ne 0) { throw 'MIG006_ENABLED_LANES_MUST_BE_ZERO' }

    $ownerStop = Get-LifecycleOwnerStopState -Root $root
    if ($ownerStop.blocked) { throw 'MIG006_OWNER_STOP_ACTIVE_BEFORE_TIMER' }

    $truth = Get-LifecycleProcessTruth -Root $root
    if ($truth.wrapper_alive -or $truth.three_lane_alive) { throw 'MIG006_RUNTIME_AUTHORITY_MUST_BE_OFF' }

    $autostart = Get-AutostartRegistration
    if (-not $autostart.present) { throw 'MIG006_NEW_AUTOSTART_OWNERSHIP_MISSING' }
    $expectedBootstrap = Join-Path $root 'runtime\windows\autostart-bootstrap.ps1'
    if ([string]$autostart.value -notlike ('*' + $expectedBootstrap + '*')) {
        throw 'MIG006_AUTOSTART_OWNERSHIP_TARGET_MISMATCH'
    }

    Assert-ExactRuntimeIdentity -Root $root -Candidate $CandidateRoot

    $runnerProcesses = @(Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" -ErrorAction SilentlyContinue)
    if ($runnerProcesses.Count -lt 1) { throw 'MIG006_RUNNER_PROCESS_NOT_VISIBLE' }
    $runnerPidBefore = [int]$runnerProcesses[0].ProcessId

    $configFile = Join-Path $root 'lanes.json'
    $registryFile = Join-Path $root 'lane-registry.json'
    $eventFile = Join-Path $root 'lane-events.ndjson'
    $configFingerprint = Get-FileSha256 $configFile
    $registryLatchFingerprint = Get-FileSha256 $registryFile
    $autostartFingerprint = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$autostart.value))
    $eventStartLength = if (Test-Path $eventFile -PathType Leaf) { [int64](Get-Item $eventFile).Length } else { 0L }
    $eventOffset = [int64]$eventStartLength
    if (Test-Path $eventWindowFile) { Remove-Item $eventWindowFile -Force }
    Write-Utf8NoBom $eventWindowFile ''

    Write-Host 'MIG_006_PREFLIGHT=PASS'
    Write-Host 'MIG_006_OWNER_RELEASE_SOURCE_VERIFIED=True'
    Write-Host 'MIG_006_RUNNER_IDENTITY_VERIFIED=True'
    Write-Host 'MIG_006_POWER_CONTINUITY_PREFLIGHT=True'
    Write-Host 'MIG_006_PENDING_REBOOT=False'
    Write-Host 'MIG_006_EXPLICIT_PLATFORM_STATE_ROOT=True'
    Write-Host 'MIG_006_INSTALLED_RUNTIME_IDENTITY_VERIFIED=True'
    Write-Host 'MIG_006_LANE_COUNT=3'
    Write-Host 'MIG_006_REGISTRY_LANE_COUNT=3'
    Write-Host 'MIG_006_ENABLED_LANE_COUNT=0'
    Write-Host 'MIG_006_OWNER_STOP_BLOCKED=False'
    Write-Host 'MIG_006_OWNERSHIP_AUTHORITY_INSTANCES=1'
    Write-Host 'MIG_006_RUNTIME_AUTHORITY_INSTANCES=0'
    Write-Host 'MIG_006_RUNTIME_MODE=ALL_DISABLED_QUIESCENT'
    Write-Host 'MIG_006_CHROME_CDP_STATUS=NOT_APPLICABLE_ALL_DISABLED'
    Write-Host 'MIG_006_START_FROM_ZERO=True'
    Write-Host 'MIG_006_HISTORICAL_PARTIAL_CREDIT_SECONDS=0'
    Write-Host "MIG_006_POWER_SOURCE=$powerSource"

    $candidateScript = Join-Path $CandidateRoot '.github\scripts\supervisor-rbt009-soak.ps1'
    if (-not (Test-Path $candidateScript -PathType Leaf)) { throw 'MIG006_LOCKED_CANDIDATE_MONITOR_MISSING' }

    $attemptStart = [DateTimeOffset]::UtcNow
    $timerStarted = $true
    $failureReason = 'MONITOR_EXCEPTION'
    Write-Host 'MIG_006_TIER_B_STARTED=True'
    Write-Host "MIG_006_CONTROL_PLANE_SHA=$ControlPlaneSha"
    Write-Host "MIG_006_RUNTIME_CANDIDATE_SHA=$RuntimeCandidateSha"
    Write-Host "MIG_006_TIER_B_START_UTC=$($attemptStart.ToString('o'))"
    Write-Host 'MIG_006_REQUIRED_CONTINUOUS_MINUTES=480'
    Write-Host 'MIG_006_SAMPLE_SECONDS=120'

    $originalGithubSha = [string]$env:GITHUB_SHA
    $env:GITHUB_SHA = $RuntimeCandidateSha
    try {
        $args = @(
            '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
            '-File',('"' + $candidateScript + '"'),
            '-DurationMinutes','480',
            '-SampleSeconds','120',
            '-OutputPath',('"' + $rawCandidateSummary + '"')
        )
        $candidateProcess = Start-Process powershell.exe -ArgumentList $args -PassThru -WindowStyle Hidden -RedirectStandardOutput $candidateStdout -RedirectStandardError $candidateStderr
    } finally {
        $env:GITHUB_SHA = $originalGithubSha
    }

    $nextSafetySample = [DateTimeOffset]::UtcNow
    $guardianSamples = 0
    while (-not $candidateProcess.HasExited) {
        $now = [DateTimeOffset]::UtcNow
        if ($now -ge $nextSafetySample) {
            $failureReason = 'OWNER_STOP_OR_STATE_SAFETY_SAMPLE_FAILED'
            $ownerStopNow = Get-LifecycleOwnerStopState -Root $root
            if ($ownerStopNow.blocked) { $failureReason='OWNER_STOP_OBSERVED'; throw 'MIG006_OWNER_STOP_OBSERVED' }

            $topologyNow = Get-Topology -Root $root
            if ($topologyNow.lane_count -ne 3 -or $topologyNow.registry_lane_count -ne 3 -or $topologyNow.enabled_lane_count -ne 0) {
                $failureReason='TOPOLOGY_OR_ENABLED_STATE_CHANGED'; throw 'MIG006_TOPOLOGY_CHANGED'
            }

            if ((Get-FileSha256 $configFile) -ne $configFingerprint) {
                $failureReason='TARGET_CONFIG_CHANGED'; throw 'MIG006_TARGET_CONFIG_CHANGED'
            }
            if ((Get-FileSha256 $registryFile) -ne $registryLatchFingerprint) {
                $failureReason='REGISTRY_OR_LATCH_CHANGED'; throw 'MIG006_REGISTRY_LATCH_CHANGED'
            }

            $truthNow = Get-LifecycleProcessTruth -Root $root
            if ($truthNow.wrapper_alive -or $truthNow.three_lane_alive) {
                $failureReason='RUNTIME_AUTHORITY_BECAME_ACTIVE'; throw 'MIG006_RUNTIME_AUTHORITY_BECAME_ACTIVE'
            }

            $autostartNow = Get-AutostartRegistration
            if (-not $autostartNow.present) {
                $failureReason='AUTOSTART_OWNERSHIP_DISAPPEARED'; throw 'MIG006_AUTOSTART_OWNERSHIP_DISAPPEARED'
            }
            $autostartNowFingerprint = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$autostartNow.value))
            if ($autostartNowFingerprint -ne $autostartFingerprint) {
                $failureReason='AUTOSTART_OWNERSHIP_CHANGED'; throw 'MIG006_AUTOSTART_OWNERSHIP_CHANGED'
            }

            Assert-NoPendingReboot
            [void](Assert-SleepSafe)

            $delta = Read-Rbt009BoundedTextDelta -Path $eventFile -StartOffset $eventOffset -MaxBytes 262144
            if ([bool]$delta.rotated_or_truncated) {
                $failureReason='EVENT_STREAM_ROTATED_OR_TRUNCATED'; throw 'MIG006_EVENT_STREAM_ROTATED_OR_TRUNCATED'
            }
            if (@($delta.lines).Count -gt 0) {
                Append-Utf8NoBomLines -Path $eventWindowFile -Lines @($delta.lines)
            }
            $eventOffset = [int64]$delta.next_offset
            $guardianSamples++
            $nextSafetySample = $nextSafetySample.AddSeconds($SampleSeconds)
        }

        Start-Sleep -Seconds 5
        $candidateProcess.Refresh()
    }

    $candidateProcess.WaitForExit()
    $candidateProcess.Refresh()
    $candidateExitCode = $candidateProcess.ExitCode
    if ($null -eq $candidateExitCode) {
        $failureReason = 'LOCKED_CANDIDATE_EXIT_CODE_UNAVAILABLE'
        throw 'MIG006_LOCKED_CANDIDATE_EXIT_CODE_UNAVAILABLE'
    }
    Write-Host "MIG_006_CANDIDATE_EXIT_CODE=$candidateExitCode"
    if ([int]$candidateExitCode -ne 0) {
        $failureReason = Get-SanitizedCandidateFailureReason -StdoutPath $candidateStdout -StderrPath $candidateStderr
        Write-Host "MIG_006_CANDIDATE_FAILURE_CODE=$failureReason"
        throw 'MIG006_LOCKED_CANDIDATE_MONITOR_FAILED'
    }

    $failureReason='FINAL_STATE_SAFETY_CHECK_FAILED'
    $ownerStopEnd = Get-LifecycleOwnerStopState -Root $root
    if ($ownerStopEnd.blocked) { $failureReason='OWNER_STOP_OBSERVED'; throw 'MIG006_OWNER_STOP_OBSERVED_AT_END' }
    $topologyEnd = Get-Topology -Root $root
    if ($topologyEnd.lane_count -ne 3 -or $topologyEnd.registry_lane_count -ne 3 -or $topologyEnd.enabled_lane_count -ne 0) {
        $failureReason='TOPOLOGY_OR_ENABLED_STATE_CHANGED'; throw 'MIG006_TOPOLOGY_CHANGED_AT_END'
    }
    if ((Get-FileSha256 $configFile) -ne $configFingerprint) { $failureReason='TARGET_CONFIG_CHANGED'; throw 'MIG006_TARGET_CONFIG_CHANGED_AT_END' }
    if ((Get-FileSha256 $registryFile) -ne $registryLatchFingerprint) { $failureReason='REGISTRY_OR_LATCH_CHANGED'; throw 'MIG006_REGISTRY_LATCH_CHANGED_AT_END' }
    $truthEnd = Get-LifecycleProcessTruth -Root $root
    if ($truthEnd.wrapper_alive -or $truthEnd.three_lane_alive) { $failureReason='RUNTIME_AUTHORITY_BECAME_ACTIVE'; throw 'MIG006_RUNTIME_AUTHORITY_ACTIVE_AT_END' }

    $deltaEnd = Read-Rbt009BoundedTextDelta -Path $eventFile -StartOffset $eventOffset -MaxBytes 262144
    if ([bool]$deltaEnd.rotated_or_truncated) { $failureReason='EVENT_STREAM_ROTATED_OR_TRUNCATED'; throw 'MIG006_EVENT_STREAM_ROTATED_OR_TRUNCATED_AT_END' }
    if (@($deltaEnd.lines).Count -gt 0) { Append-Utf8NoBomLines -Path $eventWindowFile -Lines @($deltaEnd.lines) }
    $eventOffset = [int64]$deltaEnd.next_offset

    if (-not (Test-Path $rawCandidateSummary -PathType Leaf)) { throw 'MIG006_LOCKED_CANDIDATE_SUMMARY_MISSING' }
    $candidateSummary = Read-Json $rawCandidateSummary
    if ([int64]$candidateSummary.duration_seconds -lt 28800) {
        $failureReason='CONTINUOUS_DURATION_LT_480_MINUTES'; throw 'MIG006_DURATION_SHORT'
    }
    if ([bool]$candidateSummary.owner_stop_observed) { $failureReason='OWNER_STOP_OBSERVED'; throw 'MIG006_CANDIDATE_OWNER_STOP_OBSERVED' }
    if ([int]$candidateSummary.max_page_count -gt 3) { $failureReason='PAGE_BUDGET_EXCEEDED'; throw 'MIG006_PAGE_BUDGET_EXCEEDED' }
    if ([bool]$candidateSummary.registry_target_evolved) { $failureReason='REGISTRY_TARGET_CHANGED'; throw 'MIG006_REGISTRY_TARGET_EVOLVED' }

    $eventWindowBytes = if (Test-Path $eventWindowFile -PathType Leaf) { [int64](Get-Item $eventWindowFile).Length } else { 0L }
    $eventWindowEmpty = ($eventWindowBytes -eq 0)
    $dispatchCount = 0
    $relayCount = 0
    if (-not $eventWindowEmpty) {
        $validator = Join-Path $CandidateRoot '.github\scripts\supervisor-release-event-validator.mjs'
        $validatorOutput = & node $validator $eventWindowFile 2>&1
        if ($LASTEXITCODE -ne 0) { $failureReason='EVENT_WINDOW_VALIDATION_FAILED'; throw 'MIG006_EVENT_WINDOW_VALIDATION_FAILED' }
        foreach ($line in @($validatorOutput)) {
            if ([string]$line -match '^SOAK_DISPATCH_CONFIRMED_COUNT=(\d+)$') { $dispatchCount = [int]$Matches[1] }
            if ([string]$line -match '^SOAK_RELAY_CONFIRMED_COUNT=(\d+)$') { $relayCount = [int]$Matches[1] }
        }
    }

    $runnerProcessesEnd = @(Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" -ErrorAction SilentlyContinue)
    if ($runnerProcessesEnd.Count -lt 1 -or [int]$runnerProcessesEnd[0].ProcessId -ne $runnerPidBefore) {
        $failureReason='RUNNER_IDENTITY_CHANGED'; throw 'MIG006_RUNNER_IDENTITY_CHANGED'
    }

    $end = [DateTimeOffset]::UtcNow
    $eventEndLength = if (Test-Path $eventFile -PathType Leaf) { [int64](Get-Item $eventFile).Length } else { 0L }
    $eventGrowth = $eventEndLength - $eventStartLength
    if ($eventGrowth -lt 0) { $failureReason='EVENT_STREAM_TRUNCATED'; throw 'MIG006_EVENT_STREAM_TRUNCATED' }

    $finalSummary = [ordered]@{
        schema_version = 'supervisor-mig006-rbt009-final.v1'
        qualification = 'QUALIFIED'
        control_plane_sha = $ControlPlaneSha
        runtime_candidate_sha = $RuntimeCandidateSha
        owner_release_sha = $OwnerReleaseSha
        start_utc = [string]$candidateSummary.start_utc
        end_utc = [string]$candidateSummary.end_utc
        duration_seconds = [int64]$candidateSummary.duration_seconds
        required_duration_seconds = 28800
        sample_count = [int]$candidateSummary.sample_count
        guardian_sample_count = $guardianSamples
        sample_seconds = $SampleSeconds
        lane_count = 3
        registry_lane_count = 3
        enabled_lane_count = 0
        runtime_mode = 'ALL_DISABLED_QUIESCENT'
        runtime_authority_active = $false
        ownership_authority_instances = 1
        max_page_count = [int]$candidateSummary.max_page_count
        event_file_bytes_start = $eventStartLength
        event_file_bytes_end = $eventEndLength
        event_file_growth_bytes = $eventGrowth
        event_window_empty = [bool]$eventWindowEmpty
        event_dispatch_confirmed_count = $dispatchCount
        event_relay_confirmed_count = $relayCount
        event_duplicate_dispatch = $false
        event_duplicate_relay = $false
        event_order_valid = $true
        event_rotation_observed = $false
        target_fingerprint_equal = $true
        registry_latch_fingerprint_equal = $true
        owner_stop_observed = $false
        pending_reboot_observed = $false
        runner_identity_unchanged = $true
        installed_runtime_identity_equal = $true
        chrome_cdp_status = 'NOT_APPLICABLE_ALL_DISABLED'
        interruption_status = 'NONE'
        start_from_zero = $true
        historical_partial_credit_seconds = 0
        monitor_browser_mutations = 0
        privacy_safe = $true
        raw_state_in_artifact = $false
        raw_events_in_artifact = $false
        screenshot_in_artifact = $false
        browser_profile_in_artifact = $false
    }
    Write-Utf8NoBom $OutputPath (($finalSummary | ConvertTo-Json -Depth 10) + [Environment]::NewLine)

    Write-Host 'MIG_006_TIER_B_QUALIFIED=True'
    Write-Host "MIG_006_DURATION_SECONDS=$([int64]$candidateSummary.duration_seconds)"
    Write-Host "MIG_006_SAMPLE_COUNT=$([int]$candidateSummary.sample_count)"
    Write-Host 'MIG_006_TARGET_FINGERPRINT_EQUAL=True'
    Write-Host 'MIG_006_REGISTRY_LATCH_FINGERPRINT_EQUAL=True'
    Write-Host 'MIG_006_OWNER_STOP_OBSERVED=False'
    Write-Host 'MIG_006_OWNERSHIP_AUTHORITY_INSTANCES=1'
    Write-Host 'MIG_006_RUNTIME_AUTHORITY_ACTIVE=False'
    Write-Host 'MIG_006_RUNTIME_MODE=ALL_DISABLED_QUIESCENT'
    Write-Host 'MIG_006_CHROME_CDP_STATUS=NOT_APPLICABLE_ALL_DISABLED'
    Write-Host "MIG_006_EVENT_WINDOW_EMPTY=$eventWindowEmpty"
    Write-Host 'MIG_006_EVENT_DUPLICATE_DISPATCH=False'
    Write-Host 'MIG_006_EVENT_DUPLICATE_RELAY=False'
    Write-Host 'MIG_006_EVENT_ORDER_VALID=True'
    Write-Host 'MIG_006_ARTIFACT_PRIVACY_SAFE=True'
    Write-Host 'RBT009_TIER_B_480M=PASS'
}
catch {
    Stop-CandidateMonitor
    Write-FailureSummary -Reason $failureReason
    Write-Host 'MIG_006_TIER_B_QUALIFIED=False'
    Write-Host "MIG_006_NON_QUALIFYING_REASON=$failureReason"
    Write-Host 'MIG_006_PARTIAL_DURATION_CREDIT_SECONDS=0'
    Write-Host 'RBT009_TIER_B_480M=NON_QUALIFYING'
    throw
}
finally {
    foreach ($path in @($candidateStdout,$candidateStderr,$rawCandidateSummary,$eventWindowFile)) {
        Remove-Item $path -Force -ErrorAction SilentlyContinue
    }
}
