param(
    [string]$HelperPath = (Join-Path $PSScriptRoot 'control-panel-observability.ps1'),
    [string]$PanelPath = (Join-Path $PSScriptRoot 'control-panel.ps1')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $HelperPath)) { throw "Missing helper: $HelperPath" }
if (-not (Test-Path $PanelPath)) { throw "Missing panel: $PanelPath" }
. $HelperPath

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('magasin-rbt007-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $root | Out-Null

try {
    $large = Join-Path $root 'lane-events-large.ndjson'
    $utf8 = New-Object Text.UTF8Encoding($false)
    $writer = New-Object IO.StreamWriter($large, $false, $utf8)

    try {
        for ($i = 0; $i -lt 9000; $i++) {
            $lane = 1 + ($i % 3)
            $task = 'TASK-' + $i
            $line = '{"schema_version":"lane-event.v1","timestamp":"2026-09-21T01:00:00.000Z","lane_id":"lane-' +
                $lane + '","actor":"WORK","event_type":"WORK_ACTIVITY","task_id":"' +
                $task + '","phase":"WORKING","reason_code":"TURN_COUNT_CHANGED"}'
            $writer.WriteLine($line)
        }

        $writer.WriteLine('{bad-json')
        $writer.WriteLine('{"schema_version":"lane-event.v1","timestamp":"2026-09-21T01:10:00.000Z","lane_id":"lane-1","actor":"WORK","event_type":"WORK_COMPLETED","task_id":"PRIVATE-EVENT","phase":"COMPLETED","url":"https://chatgpt.com/c/private"}')
        $writer.WriteLine('{"schema_version":"lane-event.v1","timestamp":"2026-09-21T01:11:00.000Z","lane_id":"lane-2","actor":"SUPERVISOR","event_type":"FUTURE_SAFE_EVENT","task_id":"TASK-FUTURE","phase":"RECOVERY"}')
        $writer.WriteLine('{"schema_version":"lane-event.v1","timestamp":"2026-09-21T01:12:00.000Z","lane_id":"lane-3","actor":"WORK","event_type":"WORK_COMPLETED","task_id":"TASK-FINAL","phase":"COMPLETED"}')
        $writer.Flush()
    } finally {
        $writer.Dispose()
    }

    # A corrupt in-flight final line must be ignored, not parsed.
    [IO.File]::AppendAllText(
        $large,
        '{"schema_version":"lane-event.v1","timestamp":"2026-09-21T01:13:00.000Z"',
        $utf8
    )

    $tail = Read-BoundedLaneEventTail -Path $large -MaxEvents 30 -MaxBytes 65536
    Assert-True ($tail.file_length -gt $tail.bytes_read) 'Large event file was read in full'
    Assert-True ($tail.bytes_read -le 65536) 'Bounded reader exceeded byte budget'
    Assert-True (@($tail.events).Count -le 30) 'Bounded reader exceeded event limit'
    Assert-True (@($tail.events).Count -ge 2) 'Expected valid tail events'
    Assert-True (@($tail.events | Where-Object { $_.task_id -eq 'TASK-FINAL' }).Count -eq 1) 'Valid event before partial tail missing'
    Assert-True (@($tail.events | Where-Object { $_.task_id -eq 'PRIVATE-EVENT' }).Count -eq 0) 'Privacy-invalid event was not rejected'

    $future = @($tail.events | Where-Object { $_.event_type -eq 'FUTURE_SAFE_EVENT' } | Select-Object -First 1)
    Assert-True ($future.Count -eq 1) 'Unknown future event was not tolerated'
    Assert-True ([string]$future[0].label -eq 'Sự kiện vận hành') 'Unknown future event did not get safe generic label'

    $serializedTail = $tail.events | ConvertTo-Json -Depth 6 -Compress
    Assert-True ($serializedTail -notmatch 'chatgpt\.com|https?://|cookie|token|screenshot') 'Timeline projection leaked private fields'

    $missing = Read-BoundedLaneEventTail -Path (Join-Path $root 'missing.ndjson') -MaxEvents 30
    Assert-True ([bool]$missing.source_missing) 'Missing event file was not tolerated'
    Assert-True (@($missing.events).Count -eq 0) 'Missing event file should return empty timeline'

    # Keep a writer open while the reader tails the same file. FileShare.ReadWrite
    # is the concurrency contract used against the real append-only runtime file.
    $concurrent = Join-Path $root 'concurrent.ndjson'
    $stream = New-Object IO.FileStream(
        $concurrent,
        [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::Write,
        [IO.FileShare]::ReadWrite
    )
    try {
        [void]$stream.Seek(0, [IO.SeekOrigin]::End)
        $bytes = $utf8.GetBytes('{"schema_version":"lane-event.v1","timestamp":"2026-09-21T01:20:00.000Z","lane_id":"lane-1","actor":"WORK","event_type":"RESULT_RELAY_CONFIRMED","task_id":"TASK-CONCURRENT","phase":"RELAYED"}' + [Environment]::NewLine)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
        $concurrentTail = Read-BoundedLaneEventTail -Path $concurrent -MaxEvents 30
        Assert-True (@($concurrentTail.events | Where-Object { $_.task_id -eq 'TASK-CONCURRENT' }).Count -eq 1) 'Concurrent append/read failed'
    } finally {
        $stream.Dispose()
    }

    foreach ($count in 0,1,2,3) {
        $scheduler = [pscustomobject]@{
            resident_chatgpt_pages = $count
            page_budget = 3
            mutation_lease_active = ($count -eq 3)
            lease_states = [pscustomobject]@{
                ACTIVE_MUTATION = if ($count -eq 3) { 1 } else { 0 }
                ACTIVE_OBSERVATION = [Math]::Min($count, 1)
                PARKED = [Math]::Max(0, $count - 1)
                EVICTABLE = 0
                CLOSED = 0
            }
        }
        $summary = Get-ControlPanelResourceSummary $scheduler
        Assert-True ([string]$summary.page_text -eq "$count / 3") "Page budget rendering failed for count=$count"
    }
    $missingScheduler = Get-ControlPanelResourceSummary $null
    Assert-True ([string]$missingScheduler.page_text -eq '— / —') 'Missing scheduler did not degrade safely'

    Assert-True ((Get-ControlPanelEffectiveLaneState $true $false $false 'RECOVERING' 'WORKING') -eq 'RECOVERING') 'Process truth did not override stale WORKING'
    Assert-True ((Get-ControlPanelEffectiveLaneState $true $true $true 'HEALTHY' 'WORKING') -eq 'WAIT_OWNER') 'Owner STOP did not remain authoritative'
    Assert-True ((Get-ControlPanelEffectiveLaneState $true $false $true 'HEALTHY' 'WORKING_LONG') -eq 'WORKING_LONG') 'Healthy process truth did not expose lane state'

    $healthText = Get-ControlPanelTargetHealthText ([pscustomobject]@{
        state = 'QUARANTINED'
        reason_code = 'CONVERSATION_MISSING'
    }) 'WORK'
    Assert-True ($healthText -match 'QUARANTINED') 'Quarantined target was not visible'
    Assert-True ($healthText -notmatch 'https?://') 'Target health leaked URL'

    Assert-True ((Get-ControlPanelRolloverText 'BLANK_TARGET_CREATING') -match 'TẠO WORK MỚI') 'Rollover UX mapping missing'
    Assert-True ((Get-ControlPanelRolloverText 'TARGET_PERSISTED') -match 'ĐÃ LƯU WORK MỚI') 'Rollover target persisted UX missing'

    $panelSource = Get-Content $PanelPath -Raw -Encoding UTF8
    $refreshStart = $panelSource.IndexOf('function Refresh-Ui')
    $timerStart = $panelSource.IndexOf('$timer = New-Object Windows.Forms.Timer', $refreshStart)
    Assert-True ($refreshStart -ge 0 -and $timerStart -gt $refreshStart) 'Refresh-Ui source boundary missing'
    $refreshSource = $panelSource.Substring($refreshStart, $timerStart - $refreshStart)
    Assert-True ($refreshSource -match 'Get-LifecycleProcessTruth') 'Process truth is not composed in Refresh-Ui'
    Assert-True ($refreshSource -match 'Get-ControlPanelEffectiveLaneState') 'Lane state does not consume process-truth helper'
    Assert-True ($refreshSource -notmatch 'Open-RobotUrl|open-supervisor-chat|reopenTargetPage|newChatPage') 'Refresh path can mutate browser pages'
    Assert-True ($panelSource -match 'TRANG CHATGPT:') 'Page budget summary is not visible'
    Assert-True ($panelSource -match 'WORKING_LONG') 'Long-running UX mapping missing'
    Assert-True ($panelSource -match 'POSSIBLY_STALLED') 'Stalled UX mapping missing'
    Assert-True ($panelSource -match 'THỬ LẠI RELAY') 'Relay rearm Owner action was lost'

    Write-Host 'CONTROL_PANEL_PROCESS_TRUTH_FIRST=True'
    Write-Host 'CONTROL_PANEL_PAGE_BUDGET_VISIBLE=True'
    Write-Host 'CONTROL_PANEL_LANE_TIMING_VISIBLE=True'
    Write-Host 'CONTROL_PANEL_EVENT_TAIL_BOUNDED=True'
    Write-Host 'CONTROL_PANEL_EVENT_CORRUPT_TAIL_TOLERATED=True'
    Write-Host 'CONTROL_PANEL_EVENT_MALFORMED_SKIPPED=True'
    Write-Host 'CONTROL_PANEL_EVENT_CONCURRENT_APPEND=True'
    Write-Host 'CONTROL_PANEL_PRIVACY_SAFE=True'
    Write-Host 'CONTROL_PANEL_NO_BROWSER_MUTATION=True'
    Write-Host 'CONTROL_PANEL_UNKNOWN_EVENT_TOLERATED=True'
    Write-Host 'CONTROL_PANEL_PROCESS_RESOURCE_DEGRADED_SAFE=True'
} finally {
    Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
