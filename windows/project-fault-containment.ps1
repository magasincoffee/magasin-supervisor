# SC-013 project fault containment for the live Supervisor wrapper.
# MONITORING_ONLY never clears STOP, retries ChatGPT, restarts Node or changes
# the durable exact-once transaction. It keeps the Owner-started wrapper alive
# for independently scheduled/read-only supervision when a project is paused.
function Get-SupervisorProjectHoldClassification($State) {
    if (-not $State -or -not $State.automation) { return $null }
    $status = [string]$State.automation.status
    $reason = [string]$State.automation.reason
    $outbound = $State.outbound
    $outboundState = [string]$outbound.state
    $kind = [string]$outbound.kind
    $taskId = [string]$outbound.task_id
    if ($status -notin @('BLOCKED','DONE')) { return $null }

    $scope = 'SUPERVISOR_TECHNICAL_HOLD'
    if ($outboundState -in @('PREPARED','ENQUEUED','DELIVERED','RESPONSE_RUNNING','UNKNOWN','SENDING')) {
        $scope = 'TRANSACTION_OUTCOME_UNRESOLVED'
    } elseif (
        $status -eq 'BLOCKED' -and
        $reason -like 'OWNER_INPUT_REQUIRED*' -and
        $outboundState -eq 'VERIFIED'
    ) {
        $scope = 'PROJECT_WAIT_OWNER'
    } elseif ($status -eq 'DONE' -and $outboundState -eq 'VERIFIED') {
        $scope = 'PROJECT_COMPLETE'
    }

    return [pscustomobject]@{
        scope = $scope
        project_task_id = if ([string]::IsNullOrWhiteSpace($taskId)) { $null } else { $taskId }
        automation_state = $status
        outbound_state = $outboundState
        outbound_kind = $kind
        reason = $reason
        supervisor_monitoring_only = $true
        active_project_execution_allowed = $false
        pending_transaction_replay_allowed = $false
        project_switch_allowed = $false
        requires_explicit_owner_rearm = $true
    }
}

function Invoke-SupervisorProjectHold {
    param(
        [Parameter(Mandatory=$true)][string]$StateFile,
        [Parameter(Mandatory=$true)][string]$HoldFile,
        [Parameter(Mandatory=$true)][string]$StopFile,
        [Parameter(Mandatory=$true)][string]$AutostartDisabledFile,
        [Parameter(Mandatory=$true)][string]$CoordinatorHeartbeatFile,
        [int]$PollSeconds = 15
    )
    $pause = [Math]::Max(5, [Math]::Min(60, $PollSeconds))
    $count = 0
    while (-not (Test-Path $StopFile) -and -not (Test-Path $AutostartDisabledFile)) {
        # Observation only. Malformed or missing state must never turn into
        # a new outbound send, source switch or automatic Owner re-arm.
        $classification = $null
        try {
            $snapshot = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $classification = Get-SupervisorProjectHoldClassification -State $snapshot
        } catch {}
        if ($null -eq $classification) {
            $classification = [pscustomobject]@{
                scope = 'STATE_CHANGED_REARM_REQUIRED'
                project_task_id = $null
                automation_state = 'UNVERIFIED'
                outbound_state = 'UNVERIFIED'
                outbound_kind = $null
                reason = 'OWNER_REARM_REQUIRED'
                supervisor_monitoring_only = $true
                active_project_execution_allowed = $false
                pending_transaction_replay_allowed = $false
                project_switch_allowed = $false
                requires_explicit_owner_rearm = $true
            }
        }
        $otherHeartbeat = 'NOT_VERIFIED'
        $otherAt = $null
        try {
            if (Test-Path $CoordinatorHeartbeatFile -PathType Leaf) {
                $item = Get-Item -LiteralPath $CoordinatorHeartbeatFile -ErrorAction Stop
                $otherAt = $item.LastWriteTimeUtc.ToString('o')
                $age = ([DateTime]::UtcNow - $item.LastWriteTimeUtc).TotalMinutes
                $otherHeartbeat = if ($age -ge 0 -and $age -le 75) {
                    'RECENT_FILE_ONLY'
                } else {
                    'STALE_FILE_ONLY'
                }
            }
        } catch {
            $otherHeartbeat = 'NOT_VERIFIED'
        }
        $status = [ordered]@{
            schema_version = 'supervisor-project-hold.v1'
            observed_at = [DateTimeOffset]::UtcNow.ToString('o')
            wrapper_pid = $PID
            mode = 'MONITORING_ONLY'
            scope = $classification.scope
            project_task_id = $classification.project_task_id
            automation_state = $classification.automation_state
            outbound_state = $classification.outbound_state
            outbound_kind = $classification.outbound_kind
            reason = $classification.reason
            supervisor_monitoring_only = $true
            active_project_execution_allowed = $false
            pending_transaction_replay_allowed = $false
            project_switch_allowed = $false
            requires_explicit_owner_rearm = $true
            independent_coordinator_heartbeat = $otherHeartbeat
            independent_coordinator_heartbeat_file_at = $otherAt
            monitor_cycle = $count
        }
        $temp = "$HoldFile.tmp.$PID"
        try {
            ($status | ConvertTo-Json -Depth 4) |
                Set-Content -LiteralPath $temp -Encoding UTF8
            Move-Item -LiteralPath $temp -Destination $HoldFile -Force
        } catch {
            Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
            # A monitoring receipt failure is NOT permission to resume tasks.
            Write-Host 'SUPERVISOR_MONITOR_RECEIPT_UNAVAILABLE=True'
        }
        if ($count -eq 0 -or $count % 20 -eq 0) {
            Write-Host "SUPERVISOR_MONITORING_ONLY=True SCOPE=$($classification.scope) TASK=$($classification.project_task_id)"
        }
        $count++
        Start-Sleep -Seconds $pause
    }
    # The Owner STOP remains effective and is never cleared by this observer.
    Write-Host 'SUPERVISOR_MONITORING_ONLY_OWNER_STOP=True'
}
