Set-StrictMode -Version 2.0

$script:ControlPanelSafeEventFields = @(
    'schema_version','timestamp','lane_id','actor','event_type','task_id',
    'phase','reason_code','work_generation','work_url_revision',
    'elapsed_ms','queue_time_ms','execution_time_ms',
    'dispatch_id','relay_id','target_role','target_digest','target_revision'
)

$script:ControlPanelEventLabels = @{
    BRAIN_TASK_ASSIGNED = 'Brain đã giao việc'
    WORK_DISPATCH_CONFIRMED = 'Task đã được xác nhận tại Work'
    WORK_STARTED = 'Work bắt đầu'
    WORK_ACTIVITY = 'Work có hoạt động'
    WORK_COMPLETED = 'Work đã thực hiện xong'
    RESULT_RELAY_CONFIRMED = 'Kết quả đã relay về Brain'
    BRAIN_RESULT_ACCEPTED = 'Brain đã chấp nhận kết quả'
    BRAIN_RESULT_REJECTED = 'Brain yêu cầu sửa lại'
    WORK_TARGET_SAVED = 'Work target đã lưu'
    WORK_TARGET_PENDING = 'Work target đang chờ áp dụng'
    WORK_TARGET_APPLIED = 'Work target đã áp dụng'
    WORK_LONG_RUNNING = 'Work chạy lâu'
    WATCHDOG_STALL_CHECK = 'Watchdog kiểm tra stall'
    PAGE_RECOVERY_RELOAD = 'Watchdog reload phục hồi'
    WATCHDOG_PROGRESS_REARMED = 'Watchdog ghi nhận tiến triển mới'
    POSSIBLY_STALLED = 'Work có thể đã stalled'
    RELAY_REARM_APPLIED = 'Đã mở retry epoch cho relay'
    RELAY_REARM_DEDUPED = 'Relay đã được xác nhận, không gửi lại'
    RELAY_REARM_EXHAUSTED = 'Relay lại hết lượt thử'
    WORK_FULL_EVIDENCE = 'Có bằng chứng Work gần đầy'
    WORK_FULL_CONFIRMED = 'Work đã đầy'
    WORK_FULL_AMBIGUOUS = 'Trạng thái Work-full chưa đủ chắc chắn'
    WORK_ROLLOVER_INTENT = 'Bắt đầu chuyển sang Work mới'
    WORK_ROLLOVER_TARGET_PERSISTED = 'Đã lưu Work mới'
    WORK_ROLLOVER_DISPATCH_CONFIRMED = 'Task đã gửi sang Work mới'
    TARGET_QUARANTINED = 'Target đã bị cách ly'
    TARGET_QUARANTINE_CLEARED = 'Target mới đã gỡ cách ly'
    TARGET_REOPEN_SUPPRESSED = 'Đã chặn mở lại target lỗi'
    RECOVERY = 'Robot đang phục hồi'
    ERROR = 'Có lỗi vận hành'
}

$script:ControlPanelReasonLabels = @{
    OWNER_WORK_REVISION = 'Owner lưu Work revision mới'
    ACTIVE_WORK_PRESERVED = 'Task hiện tại được giữ nguyên'
    SAFE_BOUNDARY = 'Đã tới safe boundary'
    SAME_TARGET_NO_CHURN = 'Cùng target, không churn'
    WATCHDOG_OBSERVATION_BAND = 'Đang trong vùng quan sát dài'
    WATCHDOG_STALL_ELIGIBLE = 'Đủ điều kiện stall check'
    WATCHDOG_RELOAD_ELIGIBLE = 'Đủ điều kiện bounded reload'
    WATCHDOG_RELOAD_COOLDOWN = 'Watchdog đang cooldown'
    WATCHDOG_PROGRESS_REARMED = 'Có tiến triển mới'
    OWNER_RELAY_REARM = 'Owner yêu cầu thử lại relay'
    OWNER_RELAY_REARM_DEDUPED = 'Relay đã tồn tại ở Brain'
    OWNER_RELAY_REARM_EXHAUSTED = 'Retry epoch đã hết'
    CAPACITY_MULTI_SIGNAL = 'Nhiều tín hiệu xác nhận Work đầy'
    CAPACITY_AMBIGUOUS = 'Tín hiệu Work-full chưa đủ'
    ROLLOVER_INTENT_PERSISTED = 'Đã lưu ý định rollover'
    ROLLOVER_TARGET_PERSISTED = 'Đã lưu exact Work mới'
    ROLLOVER_DISPATCH_LATCH_PERSISTED = 'Đã lưu dispatch latch'
    ROLLOVER_DISPATCH_CONFIRMED = 'Dispatch sang Work mới đã xác nhận'
    TARGET_CONVERSATION_MISSING = 'Cuộc trò chuyện không còn tồn tại'
    TARGET_CONVERSATION_ACCESS_DENIED = 'Không còn quyền truy cập'
    TARGET_STABLE_REDIRECT_AWAY = 'Target ổn định đã chuyển khỏi conversation'
    TARGET_NEW_CANONICAL_IDENTITY = 'Owner đã cung cấp target mới'
    TARGET_QUARANTINED = 'Target đang bị cách ly'
    ACCEPT_DOD_MET = 'Đạt Definition of Done'
    ACCEPT_EVIDENCE_VERIFIED = 'Evidence đã được xác minh'
    REJECT_DOD_NOT_MET = 'Chưa đạt Definition of Done'
    REJECT_EVIDENCE_INCOMPLETE = 'Evidence chưa đủ'
    REJECT_CORRECTION_REQUIRED = 'Cần correction bounded'
    OWNER_INTERVENTION_REQUIRED = 'Cần Owner can thiệp'
}

function Test-ControlPanelSafeIdentifier([string]$Value) {
    if (-not $Value) { return $true }
    if ($Value.Length -gt 192) { return $false }
    if ($Value -match '://') { return $false }
    if ($Value -match '^[A-Za-z]:[\\/]') { return $false }
    return [bool]($Value -match '^[A-Za-z0-9][A-Za-z0-9._:\\/-]*$')
}

function Test-ControlPanelSafeLaneEvent($Event) {
    if ($null -eq $Event) { return $false }

    foreach ($property in @($Event.PSObject.Properties)) {
        if ($script:ControlPanelSafeEventFields -notcontains [string]$property.Name) {
            return $false
        }
    }

    if ([string]$Event.schema_version -ne 'lane-event.v1') { return $false }

    $timestamp = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string]$Event.timestamp, [ref]$timestamp)) {
        return $false
    }

    if ($Event.PSObject.Properties['lane_id']) {
        if ([string]$Event.lane_id -notin @('lane-1','lane-2','lane-3')) {
            return $false
        }
    }

    if ([string]$Event.actor -notin @('BRAIN','WORK','SUPERVISOR')) {
        return $false
    }

    $eventType = [string]$Event.event_type
    if (-not $eventType -or $eventType.Length -gt 80 -or $eventType -notmatch '^[A-Z0-9_]+$') {
        return $false
    }

    if ($Event.PSObject.Properties['task_id']) {
        if (-not (Test-ControlPanelSafeIdentifier ([string]$Event.task_id))) {
            return $false
        }
    }

    foreach ($name in @('phase','reason_code','target_role')) {
        if ($Event.PSObject.Properties[$name]) {
            $value = [string]$Event.$name
            if ($value -and ($value.Length -gt 100 -or $value -notmatch '^[A-Z0-9_]+$')) {
                return $false
            }
        }
    }

    return $true
}

function ConvertTo-ControlPanelTimelineItem($Event) {
    if (-not (Test-ControlPanelSafeLaneEvent $Event)) { return $null }

    $eventType = [string]$Event.event_type
    $label = if ($script:ControlPanelEventLabels.ContainsKey($eventType)) {
        [string]$script:ControlPanelEventLabels[$eventType]
    } else {
        'Sự kiện vận hành'
    }

    $reason = ''
    if ($Event.PSObject.Properties['reason_code']) {
        $reasonCode = [string]$Event.reason_code
        if ($script:ControlPanelReasonLabels.ContainsKey($reasonCode)) {
            $reason = [string]$script:ControlPanelReasonLabels[$reasonCode]
        }
    }

    return [pscustomobject]@{
        timestamp = [string]$Event.timestamp
        lane_id = if ($Event.PSObject.Properties['lane_id']) { [string]$Event.lane_id } else { '' }
        event_type = $eventType
        label = $label
        task_id = if ($Event.PSObject.Properties['task_id']) { [string]$Event.task_id } else { '' }
        phase = if ($Event.PSObject.Properties['phase']) { [string]$Event.phase } else { '' }
        reason_label = $reason
    }
}

function Read-BoundedLaneEventTail(
    [string]$Path,
    [int]$MaxEvents = 30,
    [int]$MaxBytes = 262144
) {
    $eventLimit = [Math]::Max(1, [Math]::Min(50, $MaxEvents))
    $byteLimit = [Math]::Max(4096, [Math]::Min(1048576, $MaxBytes))

    $result = [pscustomobject]@{
        events = @()
        bytes_read = 0
        file_length = 0
        source_missing = $false
    }

    if (-not (Test-Path $Path)) {
        $result.source_missing = $true
        return $result
    }

    $stream = $null
    try {
        $stream = New-Object IO.FileStream(
            $Path,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
        )
        $length = [long]$stream.Length
        $result.file_length = $length
        if ($length -le 0) { return $result }

        $readLength = [int][Math]::Min([long]$byteLimit, $length)
        $start = [long]($length - $readLength)
        [void]$stream.Seek($start, [IO.SeekOrigin]::Begin)

        $buffer = New-Object byte[] $readLength
        $offset = 0
        while ($offset -lt $readLength) {
            $read = $stream.Read($buffer, $offset, $readLength - $offset)
            if ($read -le 0) { break }
            $offset += $read
        }
        $result.bytes_read = $offset
        if ($offset -le 0) { return $result }

        $actual = if ($offset -eq $buffer.Length) {
            $buffer
        } else {
            $slice = New-Object byte[] $offset
            [Array]::Copy($buffer, 0, $slice, 0, $offset)
            $slice
        }

        $endsWithNewline = $actual[$actual.Length - 1] -eq 10
        $text = [Text.Encoding]::UTF8.GetString($actual)
        $lines = @($text -split "\r?\n")

        # If we sought into the middle of a large file, the first decoded line
        # may be partial. It is intentionally discarded rather than guessing.
        if ($start -gt 0 -and $lines.Count -gt 0) {
            $lines = @($lines | Select-Object -Skip 1)
        }

        # Runtime appends complete NDJSON lines ending in LF. A non-LF final
        # segment is an in-flight/partial write and must not be parsed.
        if (-not $endsWithNewline -and $lines.Count -gt 0) {
            $lines = @($lines | Select-Object -First ([Math]::Max(0, $lines.Count - 1)))
        }

        $items = New-Object Collections.Generic.List[object]
        for ($i = $lines.Count - 1; $i -ge 0 -and $items.Count -lt $eventLimit; $i--) {
            $line = [string]$lines[$i]
            if (-not $line.Trim()) { continue }

            try {
                $event = $line | ConvertFrom-Json -ErrorAction Stop
            } catch {
                continue
            }

            $item = ConvertTo-ControlPanelTimelineItem $event
            if ($null -ne $item) {
                $items.Add($item)
            }
        }

        # Generic.List must be materialized before reversing. Wrapping the
        # list directly in @() can preserve it as one collection object under
        # Windows PowerShell 5.1 instead of yielding individual events.
        [object[]]$ordered = $items.ToArray()
        [Array]::Reverse($ordered)
        $result.events = $ordered
        return $result
    } catch {
        return $result
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

function Format-ControlPanelDuration($Milliseconds) {
    if ($null -eq $Milliseconds) { return '—' }
    try { $ms = [long]$Milliseconds } catch { return '—' }
    if ($ms -lt 0) { return '—' }
    $seconds = [Math]::Floor($ms / 1000)
    if ($seconds -lt 60) { return "$seconds giây" }
    $minutes = [Math]::Floor($seconds / 60)
    if ($minutes -lt 60) { return "$minutes phút" }
    $hours = [Math]::Floor($minutes / 60)
    $remain = $minutes % 60
    return "$hours giờ $remain phút"
}

function Format-ControlPanelAge(
    [string]$Timestamp,
    [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
) {
    if (-not $Timestamp) { return '—' }
    try {
        $then = [DateTimeOffset]::Parse($Timestamp)
    } catch {
        return '—'
    }
    $delta = $Now.ToUniversalTime() - $then.ToUniversalTime()
    if ($delta.TotalSeconds -lt 0) { return '—' }
    if ($delta.TotalSeconds -lt 60) { return 'vừa xong' }
    if ($delta.TotalMinutes -lt 60) {
        return ([Math]::Floor($delta.TotalMinutes)).ToString() + ' phút trước'
    }
    if ($delta.TotalHours -lt 24) {
        return ([Math]::Floor($delta.TotalHours)).ToString() + ' giờ trước'
    }
    return ([Math]::Floor($delta.TotalDays)).ToString() + ' ngày trước'
}

function Get-ControlPanelEffectiveLaneState(
    [bool]$Enabled,
    [bool]$OwnerStopped,
    [bool]$ProcessHealthy,
    [string]$ProcessState,
    [string]$LaneStatus
) {
    if (-not $Enabled) { return 'STOPPED' }
    if ($OwnerStopped) { return 'WAIT_OWNER' }
    if (-not $ProcessHealthy) {
        if ($ProcessState -eq 'NODE_DOWN') { return 'NODE_DOWN' }
        if ($ProcessState -eq 'STATUS_STALE') { return 'STATUS_STALE' }
        if ($ProcessState -eq 'STARTING') { return 'STARTING' }
        return 'RECOVERING'
    }
    if ($LaneStatus) { return $LaneStatus }
    return 'STARTING'
}

function Get-ControlPanelResourceSummary($Scheduler) {
    if ($null -eq $Scheduler) {
        return [pscustomobject]@{
            page_text = '— / —'
            mutation_text = '—'
            active_mutation = 0
            active_observation = 0
            parked = 0
            evictable = 0
            closed = 0
        }
    }

    $pageCount = if ($Scheduler.PSObject.Properties['resident_chatgpt_pages']) {
        [int]$Scheduler.resident_chatgpt_pages
    } else { $null }
    $pageBudget = if ($Scheduler.PSObject.Properties['page_budget']) {
        [int]$Scheduler.page_budget
    } else { $null }
    $leaseStates = if ($Scheduler.PSObject.Properties['lease_states']) {
        $Scheduler.lease_states
    } else { $null }

    function Lease-Count([string]$Name) {
        if ($null -eq $leaseStates) { return 0 }
        $property = $leaseStates.PSObject.Properties[$Name]
        if ($null -eq $property) { return 0 }
        return [int]$property.Value
    }

    return [pscustomobject]@{
        page_text = if ($null -ne $pageCount -and $null -ne $pageBudget) {
            [string]$pageCount + ' / ' + [string]$pageBudget
        } else {
            '— / —'
        }
        mutation_text = if ($Scheduler.PSObject.Properties['mutation_lease_active']) {
            if ([bool]$Scheduler.mutation_lease_active) { 'BUSY' } else { 'FREE' }
        } else {
            '—'
        }
        active_mutation = Lease-Count 'ACTIVE_MUTATION'
        active_observation = Lease-Count 'ACTIVE_OBSERVATION'
        parked = Lease-Count 'PARKED'
        evictable = Lease-Count 'EVICTABLE'
        closed = Lease-Count 'CLOSED'
    }
}

function Get-ControlPanelTargetHealthText($Health, [string]$Role) {
    if ($null -eq $Health) { return "${Role}: —" }
    $state = [string]$Health.state
    if (-not $state) { return "${Role}: —" }
    if ($state -ne 'QUARANTINED') { return "${Role}: $state" }

    $reason = switch ([string]$Health.reason_code) {
        'CONVERSATION_MISSING' { 'không còn tồn tại' }
        'CONVERSATION_ACCESS_DENIED' { 'không còn quyền truy cập' }
        'STABLE_REDIRECT_AWAY' { 'đã chuyển khỏi conversation' }
        default { 'đã bị cách ly' }
    }
    return "${Role}: QUARANTINED ($reason)"
}

function Get-ControlPanelRolloverText([string]$Stage) {
    switch ($Stage) {
        'FULL_CONFIRMED' { return 'WORK ĐẦY — chuẩn bị rollover' }
        'INTENT_PERSISTED' { return 'TẠO WORK MỚI — đã lưu intent' }
        'BLANK_TARGET_CREATING' { return 'TẠO WORK MỚI' }
        'TARGET_PERSISTED' { return 'ĐÃ LƯU WORK MỚI' }
        'DISPATCH_LATCH_PERSISTED' { return 'ĐANG GỬI TASK SANG WORK MỚI' }
        'DISPATCH_CONFIRMED' { return 'TASK ĐÃ SANG WORK MỚI' }
        default { return '' }
    }
}
