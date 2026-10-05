param(
    [int]$PollSeconds = 5,
    [int]$UiProbeSeconds = 30,
    [int]$MaxPreparedSeconds = 180,
    [int]$MaxEnqueuedSeconds = 180,
    [int]$MaxStartingBrowserSeconds = 180,
    [int]$FailureCaptureCooldownSeconds = 60,
    [int64]$MaxEventLogBytes = 5242880
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime = Join-Path $root 'runtime'
$lifecycleScript = Join-Path $runtime 'windows\lifecycle-truth.ps1'
$statePath = Join-Path $root 'single-conversation-state.json'
$statusPath = Join-Path $root 'local-watchdog-status.json'
$eventsPath = Join-Path $root 'local-watchdog-events.ndjson'
$failuresDir = Join-Path $root 'local-watchdog-failures'
$pidPath = Join-Path $root 'local-watchdog.pid'
$probeCli = Join-Path $runtime 'src\runtime\local-watchdog-probe-cli.mjs'
$mutexName = 'Local\MAGASIN_SUPERVISOR_LOCAL_WATCHDOG'

if (-not (Test-Path $lifecycleScript -PathType Leaf)) {
    throw "Lifecycle truth helper is missing: $lifecycleScript"
}
. $lifecycleScript

New-Item -ItemType Directory -Force -Path $root | Out-Null
New-Item -ItemType Directory -Force -Path $failuresDir | Out-Null

$mutex = New-Object -TypeName System.Threading.Mutex -ArgumentList $false, $mutexName
$ownsMutex = $false
try {
    try {
        $ownsMutex = $mutex.WaitOne(0, $false)
    } catch [System.Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }

    if (-not $ownsMutex) {
        Write-Host 'LOCAL_WATCHDOG_ALREADY_RUNNING=True'
        exit 0
    }

    Set-Content -Path $pidPath -Value $PID -Encoding ascii

    function Rotate-EventLogIfNeeded {
        if (-not (Test-Path $eventsPath -PathType Leaf)) { return }
        $item = Get-Item $eventsPath -ErrorAction SilentlyContinue
        if (-not $item -or $item.Length -lt $MaxEventLogBytes) { return }
        $archive = "$eventsPath.1"
        Remove-Item $archive -Force -ErrorAction SilentlyContinue
        Move-Item $eventsPath $archive -Force
    }

    function Write-WatchdogEvent([hashtable]$Record) {
        Rotate-EventLogIfNeeded
        if (-not $Record.ContainsKey('timestamp')) {
            $Record.timestamp = [DateTimeOffset]::UtcNow.ToString('o')
        }
        ($Record | ConvertTo-Json -Compress -Depth 8) |
            Add-Content -Path $eventsPath -Encoding UTF8
    }

    function Write-StatusAtomically($Status) {
        $temp = "$statusPath.tmp.$PID"
        ($Status | ConvertTo-Json -Depth 8) | Set-Content -Path $temp -Encoding UTF8
        Move-Item -Path $temp -Destination $statusPath -Force
    }

    function Get-CdpUrl {
        try {
            $chrome = Get-LifecycleRobotChrome -Root $root
            if ($chrome -and [string]$chrome.CommandLine -match '--remote-debugging-port=(\d+)') {
                return "http://127.0.0.1:$($matches[1])"
            }
        } catch {}
        return $null
    }

    function New-UiProbeErrorResult([string]$Code) {
        return [pscustomobject]@{
            schema_version = 1
            timestamp = [DateTimeOffset]::UtcNow.ToString('o')
            expected_runtime_id_present = $false
            page_count = 0
            exact_runtime_match = $false
            ui_state = 'UNAVAILABLE'
            observation = 'UNAVAILABLE'
            conversation_path = $false
            composer_ready = $false
            response_running = $false
            assistant_busy = $false
            login_required = $false
            has_captcha = $false
            has_network_error = $false
            has_transient_error = $false
            has_continue_control = $false
            has_retry_control = $false
            conversation_full = $false
            conversation_missing = $false
            conversation_access_denied = $false
            draft_has_text = $false
            draft_digest = $null
            draft_rendered_digest = $null
            draft_length = 0
            probe_error = $Code
        }
    }

    function Invoke-ReadOnlyUiProbe([string]$CdpUrl) {
        if ([string]::IsNullOrWhiteSpace($CdpUrl)) { return $null }
        if (-not (Test-Path $probeCli -PathType Leaf)) { return $null }

        $stdout = Join-Path $root "local-watchdog-probe-$PID.out"
        $stderr = Join-Path $root "local-watchdog-probe-$PID.err"
        Remove-Item $stdout,$stderr -Force -ErrorAction SilentlyContinue

        try {
            $arguments = @(
                ('"' + $probeCli + '"'),
                '--state',
                ('"' + $statePath + '"'),
                '--cdp-url',
                ('"' + $CdpUrl + '"')
            )
            $process = Start-Process node.exe -PassThru -WindowStyle Hidden -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr
            $finished = $process.WaitForExit(20000)
            if (-not $finished) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                return (New-UiProbeErrorResult -Code 'UI_PROBE_TIMEOUT')
            }
            if (-not (Test-Path $stdout -PathType Leaf)) {
                return (New-UiProbeErrorResult -Code 'UI_PROBE_FAILED')
            }
            $raw = Get-Content $stdout -Raw -Encoding UTF8
            if ([string]::IsNullOrWhiteSpace([string]$raw)) {
                return (New-UiProbeErrorResult -Code 'UI_PROBE_EMPTY')
            }

            $parsed = $null
            try {
                $parsed = ([string]$raw | ConvertFrom-Json)
            } catch {
                return (New-UiProbeErrorResult -Code 'UI_PROBE_INVALID_JSON')
            }

            # On Windows PowerShell 5.1, Start-Process can report a blank
            # ExitCode even after WaitForExit(timeout) returned true. A complete
            # structured JSON result is stronger success evidence than a null
            # process exit code, so only reject an explicit non-zero code.
            $exitCode = $null
            try {
                if ($process.HasExited) {
                    $process.Refresh()
                    $exitCode = $process.ExitCode
                }
            } catch {}
            if ($null -ne $exitCode -and [int]$exitCode -ne 0) {
                return (New-UiProbeErrorResult -Code 'UI_PROBE_FAILED')
            }
            return $parsed
        } catch {
            return (New-UiProbeErrorResult -Code 'UI_PROBE_EXCEPTION')
        } finally {
            Remove-Item $stdout,$stderr -Force -ErrorAction SilentlyContinue
        }
    }

    function Write-FailureCapture(
        [string]$FaultSignature,
        [string[]]$FaultCodes,
        $State,
        $Truth,
        $UiProbe
    ) {
        $stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
        $safeSignature = ($FaultSignature -replace '[^A-Za-z0-9._-]', '_')
        if ($safeSignature.Length -gt 80) {
            $safeSignature = $safeSignature.Substring(0, 80)
        }
        $path = Join-Path $failuresDir "$stamp-$safeSignature.json"

        $capture = [ordered]@{
            schema_version = 1
            timestamp = [DateTimeOffset]::UtcNow.ToString('o')
            faults = @($FaultCodes)
            runtime = [ordered]@{
                wrapper_alive = [bool]$Truth.wrapper_alive
                runtime_alive = [bool]$Truth.runtime_alive
                single_conversation_alive = [bool]$Truth.single_conversation_alive
                chrome_alive = [bool]$Truth.chrome_alive
                cdp_healthy = [bool]$Truth.cdp_healthy
                runtime_mode = [string]$Truth.runtime_mode
            }
            state = if ($State) {
                [ordered]@{
                    conversation_status = [string]$State.conversation.status
                    conversation_generation = [int]$State.conversation.generation
                    automation_status = [string]$State.automation.status
                    automation_phase = [string]$State.automation.phase
                    automation_reason = [string]$State.automation.reason
                    outbound_state = [string]$State.outbound.state
                    outbound_kind = [string]$State.outbound.kind
                    message_id = [string]$State.outbound.message_id
                    retry_count = [int]$State.outbound.retry_count
                    last_error_code = [string]$State.outbound.last_error_code
                    last_error_stage = [string]$State.outbound.last_error_stage
                    updated_at = [string]$State.updated_at
                }
            } else { $null }
            ui = $UiProbe
        }

        ($capture | ConvertTo-Json -Depth 10) | Set-Content -Path $path -Encoding UTF8
        Write-WatchdogEvent @{
            type = 'FAULT_CAPTURED'
            faults = @($FaultCodes)
            evidence_file = [System.IO.Path]::GetFileName($path)
        }

        $old = @(Get-ChildItem $failuresDir -Filter '*.json' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -Skip 200)
        foreach ($item in $old) {
            Remove-Item $item.FullName -Force -ErrorAction SilentlyContinue
        }
    }

    $lastSignature = ''
    $lastFaultSignature = ''
    $lastFaultCaptureAt = [DateTimeOffset]::MinValue
    # Publish local runtime heartbeat immediately; the first heavier CDP/UI
    # probe runs after one UiProbeSeconds interval and is separately bounded.
    $lastUiProbeAt = [DateTimeOffset]::UtcNow
    $lastUiProbe = $null
    $runtimeDownSince = $null
    $cdpDownSince = $null
    $lastHeartbeatAt = [DateTimeOffset]::MinValue

    Write-WatchdogEvent @{
        type = 'WATCHDOG_STARTED'
        pid = $PID
        poll_seconds = [Math]::Max(2, $PollSeconds)
        ui_probe_seconds = [Math]::Max(10, $UiProbeSeconds)
    }

    while ($true) {
        $now = [DateTimeOffset]::UtcNow
        try {
            $truth = Get-LifecycleProcessTruth -Root $root
            $ownerStop = Get-LifecycleOwnerStopState -Root $root
            if ($ownerStop.blocked) {
                $lastUiProbe = $null
                $lastUiProbeAt = [DateTimeOffset]::MinValue
            }
            $state = $null
            $stateReadable = $false

            if (Test-Path $statePath -PathType Leaf) {
                try {
                    $state = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
                    $stateReadable = $true
                } catch {}
            }

            if ($truth.wrapper_alive) {
                $runtimeDownSince = $null
            } elseif ($null -eq $runtimeDownSince) {
                $runtimeDownSince = $now
            }

            if ($truth.cdp_healthy) {
                $cdpDownSince = $null
            } elseif ($null -eq $cdpDownSince) {
                $cdpDownSince = $now
            }

            $cdpUrl = Get-CdpUrl
            if (
                $truth.cdp_healthy -and
                $stateReadable -and
                (($now - $lastUiProbeAt).TotalSeconds -ge [Math]::Max(10, $UiProbeSeconds))
            ) {
                $lastUiProbeAt = $now
                $lastUiProbe = Invoke-ReadOnlyUiProbe -CdpUrl $cdpUrl
            }

            $faults = New-Object 'System.Collections.Generic.HashSet[string]'

            if (-not $ownerStop.blocked) {
                if (
                    $null -ne $runtimeDownSince -and
                    ($now - $runtimeDownSince).TotalSeconds -ge 30
                ) {
                    [void]$faults.Add('WRAPPER_NOT_ALIVE')
                }
                if (
                    $null -ne $cdpDownSince -and
                    ($now - $cdpDownSince).TotalSeconds -ge 30
                ) {
                    [void]$faults.Add('CDP_NOT_HEALTHY')
                }
                if (-not (Test-Path $statePath -PathType Leaf)) {
                    [void]$faults.Add('STATE_MISSING')
                } elseif (-not $stateReadable) {
                    [void]$faults.Add('STATE_UNREADABLE')
                }
            }

            $preparedAge = $null
            $enqueuedAge = $null
            $startingBrowserAge = $null
            if ($stateReadable) {
                $automation = [string]$state.automation.status
                $phase = [string]$state.automation.phase
                $reason = [string]$state.automation.reason
                $conversation = [string]$state.conversation.status
                $outbound = [string]$state.outbound.state
                $retry = [int]$state.outbound.retry_count
                $lastCode = [string]$state.outbound.last_error_code

                if (-not $ownerStop.blocked) {
                    if ($automation -eq 'BLOCKED') {
                        $code = if ($lastCode) { $lastCode } elseif ($reason) { $reason } else { 'UNKNOWN' }
                        [void]$faults.Add("BLOCKED:$code")
                    }
                    if ($automation -eq 'RUNNING' -and $conversation -ne 'ACTIVE') {
                        [void]$faults.Add('CONVERSATION_NOT_ACTIVE')
                    }
                    if ($retry -gt 1) {
                        [void]$faults.Add('RETRY_BUDGET_EXCEEDED')
                    }

                    if ($automation -eq 'RUNNING' -and $phase -eq 'STARTING_BROWSER' -and $state.automation.updated_at) {
                        try {
                            $startingBrowserAge = [int]($now - [DateTimeOffset]::Parse([string]$state.automation.updated_at)).TotalSeconds
                            if ($startingBrowserAge -ge $MaxStartingBrowserSeconds) {
                                [void]$faults.Add("STARTING_BROWSER_STALLED:$startingBrowserAge")
                            }
                        } catch {}
                    }

                    if ($outbound -eq 'PREPARED' -and $state.outbound.prepared_at) {
                        $preparedAge = [int]($now - [DateTimeOffset]::Parse([string]$state.outbound.prepared_at)).TotalSeconds
                        if ($preparedAge -ge $MaxPreparedSeconds) {
                            [void]$faults.Add("PREPARED_STALLED:$preparedAge")
                        }
                    }
                    if ($outbound -eq 'ENQUEUED' -and $state.outbound.enqueued_at) {
                        $enqueuedAge = [int]($now - [DateTimeOffset]::Parse([string]$state.outbound.enqueued_at)).TotalSeconds
                        $pendingPostSendConfirmation = [bool](
                            $phase -eq 'WAIT_RESPONSE' -and
                            $lastCode -eq 'POST_SEND_CONFIRMATION_PENDING'
                        )
                        if (
                            $enqueuedAge -ge $MaxEnqueuedSeconds -and
                            -not $pendingPostSendConfirmation
                        ) {
                            [void]$faults.Add("ENQUEUED_STALLED:$enqueuedAge")
                        }
                    }
                }
            }

            if (-not $ownerStop.blocked -and $lastUiProbe) {
                if ([bool]$lastUiProbe.login_required) { [void]$faults.Add('CHATGPT_LOGIN_REQUIRED') }
                if ([bool]$lastUiProbe.has_captcha) { [void]$faults.Add('CHATGPT_CAPTCHA') }
                if ([bool]$lastUiProbe.has_network_error) { [void]$faults.Add('CHATGPT_NETWORK_ERROR') }
                if ([bool]$lastUiProbe.has_transient_error) { [void]$faults.Add('CHATGPT_TRANSIENT_ERROR') }
                if ([bool]$lastUiProbe.has_retry_control) { [void]$faults.Add('CHATGPT_RETRY_CONTROL') }
                if ([bool]$lastUiProbe.conversation_full) { [void]$faults.Add('CHATGPT_CONVERSATION_FULL') }
                if ([bool]$lastUiProbe.conversation_missing) { [void]$faults.Add('CHATGPT_CONVERSATION_MISSING') }
                if ([bool]$lastUiProbe.conversation_access_denied) { [void]$faults.Add('CHATGPT_CONVERSATION_ACCESS_DENIED') }
                if (
                    $stateReadable -and
                    [string]$state.conversation.status -eq 'ACTIVE' -and
                    [bool]$lastUiProbe.expected_runtime_id_present -and
                    -not [bool]$lastUiProbe.exact_runtime_match
                ) {
                    [void]$faults.Add('CHATGPT_RUNTIME_IDENTITY_MISMATCH')
                }
                if ($lastUiProbe.probe_error) {
                    [void]$faults.Add("CHATGPT_PROBE:$([string]$lastUiProbe.probe_error)")
                }
            }

            $faultList = @($faults | Sort-Object)
            $faultSignature = $faultList -join '|'
            $mode = if ($ownerStop.blocked) {
                'OWNER_STOP'
            } elseif ($faultList.Count -gt 0) {
                'FAULT'
            } else {
                'HEALTHY'
            }

            $status = [ordered]@{
                schema_version = 1
                timestamp = $now.ToString('o')
                pid = $PID
                mode = $mode
                owner_stop = [bool]$ownerStop.blocked
                runtime = [ordered]@{
                    wrapper_alive = [bool]$truth.wrapper_alive
                    runtime_alive = [bool]$truth.runtime_alive
                    single_conversation_alive = [bool]$truth.single_conversation_alive
                    chrome_alive = [bool]$truth.chrome_alive
                    cdp_healthy = [bool]$truth.cdp_healthy
                    runtime_mode = [string]$truth.runtime_mode
                }
                state = if ($stateReadable) {
                    [ordered]@{
                        conversation_status = [string]$state.conversation.status
                        conversation_generation = [int]$state.conversation.generation
                        automation_status = [string]$state.automation.status
                        automation_phase = [string]$state.automation.phase
                        automation_reason = [string]$state.automation.reason
                        outbound_state = [string]$state.outbound.state
                        outbound_kind = [string]$state.outbound.kind
                        message_id = [string]$state.outbound.message_id
                        retry_count = [int]$state.outbound.retry_count
                        last_error_code = [string]$state.outbound.last_error_code
                        last_error_stage = [string]$state.outbound.last_error_stage
                        prepared_age_seconds = $preparedAge
                        enqueued_age_seconds = $enqueuedAge
                        starting_browser_age_seconds = $startingBrowserAge
                        updated_at = [string]$state.updated_at
                    }
                } else { $null }
                ui = $lastUiProbe
                faults = $faultList
            }
            Write-StatusAtomically -Status $status

            $signatureAutomation = if ($stateReadable) { [string]$state.automation.status } else { 'NO_STATE' }
            $signaturePhase = if ($stateReadable) { [string]$state.automation.phase } else { 'NO_PHASE' }
            $signatureOutbound = if ($stateReadable) { [string]$state.outbound.state } else { 'NO_OUTBOUND' }
            $signatureError = if ($stateReadable) { [string]$state.outbound.last_error_code } else { 'NO_ERROR' }
            $signature = [string]::Join('~', @(
                $mode,
                [string]$truth.wrapper_alive,
                [string]$truth.cdp_healthy,
                $signatureAutomation,
                $signaturePhase,
                $signatureOutbound,
                $signatureError,
                $faultSignature
            ))

            if (
                $signature -ne $lastSignature -or
                ($now - $lastHeartbeatAt).TotalSeconds -ge 60
            ) {
                $lastSignature = $signature
                $lastHeartbeatAt = $now
                Write-WatchdogEvent @{
                    type = if ($faultList.Count -gt 0) { 'FAULT' } else { 'HEARTBEAT' }
                    mode = $mode
                    wrapper_alive = [bool]$truth.wrapper_alive
                    cdp_healthy = [bool]$truth.cdp_healthy
                    automation_status = if ($stateReadable) { [string]$state.automation.status } else { $null }
                    automation_phase = if ($stateReadable) { [string]$state.automation.phase } else { $null }
                    outbound_state = if ($stateReadable) { [string]$state.outbound.state } else { $null }
                    last_error_code = if ($stateReadable) { [string]$state.outbound.last_error_code } else { $null }
                    faults = $faultList
                }
            }

            if (
                $faultList.Count -gt 0 -and
                (
                    $faultSignature -ne $lastFaultSignature -or
                    ($now - $lastFaultCaptureAt).TotalSeconds -ge $FailureCaptureCooldownSeconds
                )
            ) {
                $lastFaultSignature = $faultSignature
                $lastFaultCaptureAt = $now

                if ($truth.cdp_healthy -and $stateReadable) {
                    $lastUiProbe = Invoke-ReadOnlyUiProbe -CdpUrl $cdpUrl
                }

                Write-FailureCapture -FaultSignature $faultSignature -FaultCodes $faultList -State $state -Truth $truth -UiProbe $lastUiProbe
            }
        } catch {
            Write-WatchdogEvent @{
                type = 'WATCHDOG_INTERNAL_ERROR'
                error = [string]$_.Exception.Message
            }
            try {
                Write-StatusAtomically -Status ([ordered]@{
                    schema_version = 1
                    timestamp = [DateTimeOffset]::UtcNow.ToString('o')
                    pid = $PID
                    mode = 'INTERNAL_ERROR'
                    faults = @('WATCHDOG_INTERNAL_ERROR')
                    error = [string]$_.Exception.Message
                })
            } catch {}
        }

        Start-Sleep -Seconds ([Math]::Max(2, $PollSeconds))
    }
} finally {
    Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
    if ($ownsMutex) {
        try { $mutex.ReleaseMutex() } catch {}
    }
    $mutex.Dispose()
}
