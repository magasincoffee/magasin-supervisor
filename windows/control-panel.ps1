param(
    [switch]$ViewportProbe,
    [switch]$ObservabilityProbe,
    [int]$ProbeWidth = 0,
    [int]$ProbeHeight = 0
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MagasinControlPanelWindow {
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$existingPanel = Get-Process -Name powershell -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Id -ne $PID -and
        $_.MainWindowHandle -ne 0 -and
        $_.MainWindowTitle -match 'MAGASIN SUPERVISOR.*CONTROL CENTER'
    } |
    Select-Object -First 1

if ($existingPanel) {
    [void][MagasinControlPanelWindow]::ShowWindow($existingPanel.MainWindowHandle, 9)
    Start-Sleep -Milliseconds 120
    [void][MagasinControlPanelWindow]::SetForegroundWindow($existingPanel.MainWindowHandle)
    exit 0
}

$ErrorActionPreference = 'Stop'

function Get-ControlPanelViewportLayout([Drawing.Rectangle]$WorkingArea) {
    $desiredWindow = New-Object Drawing.Size(1240, 930)
    $logicalCanvas = New-Object Drawing.Size(1215, 1510)

    $initialWidth = [Math]::Min($desiredWindow.Width, [Math]::Max(320, $WorkingArea.Width))
    $initialHeight = [Math]::Min($desiredWindow.Height, [Math]::Max(320, $WorkingArea.Height))

    # Keep a useful resize floor on normal displays without ever forcing the
    # window beyond the monitor WorkingArea on smaller/scaled displays.
    $minimumWidth = [Math]::Min(900, [Math]::Max(640, $WorkingArea.Width - 24))
    $minimumHeight = [Math]::Min(600, [Math]::Max(420, $WorkingArea.Height - 24))
    $minimumWidth = [Math]::Min($minimumWidth, $initialWidth)
    $minimumHeight = [Math]::Min($minimumHeight, $initialHeight)

    $left = $WorkingArea.Left + [Math]::Max(
        0,
        [int](($WorkingArea.Width - $initialWidth) / 2)
    )
    $top = $WorkingArea.Top + [Math]::Max(
        0,
        [int](($WorkingArea.Height - $initialHeight) / 2)
    )

    return [pscustomobject]@{
        InitialSize = New-Object Drawing.Size($initialWidth, $initialHeight)
        MinimumSize = New-Object Drawing.Size($minimumWidth, $minimumHeight)
        Location = New-Object Drawing.Point($left, $top)
        LogicalCanvasSize = $logicalCanvas
    }
}

if ($ViewportProbe) {
    $probeWorkingArea = if ($ProbeWidth -gt 0 -and $ProbeHeight -gt 0) {
        New-Object Drawing.Rectangle(0, 0, $ProbeWidth, $ProbeHeight)
    } else {
        [Windows.Forms.Screen]::FromPoint([Windows.Forms.Cursor]::Position).WorkingArea
    }
    $probeLayout = Get-ControlPanelViewportLayout -WorkingArea $probeWorkingArea
    [pscustomobject]@{
        working_width = $probeWorkingArea.Width
        working_height = $probeWorkingArea.Height
        initial_width = $probeLayout.InitialSize.Width
        initial_height = $probeLayout.InitialSize.Height
        minimum_width = $probeLayout.MinimumSize.Width
        minimum_height = $probeLayout.MinimumSize.Height
        logical_width = $probeLayout.LogicalCanvasSize.Width
        logical_height = $probeLayout.LogicalCanvasSize.Height
        vertical_scroll_required = [bool]($probeLayout.InitialSize.Height -lt $probeLayout.LogicalCanvasSize.Height)
        header_bottom = 230
        lane3_stop_bottom = 1072
        lane3_stop_in_canvas = [bool]($probeLayout.LogicalCanvasSize.Height -ge 1072)
        timeline_bottom = 1484
        critical_controls_scroll_reachable = [bool](
            $probeLayout.InitialSize.Height -gt 0 -and
            $probeLayout.LogicalCanvasSize.Height -ge 1072
        )
    } | ConvertTo-Json -Compress
    exit 0
}

. (Join-Path $PSScriptRoot 'state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$env:SUPERVISOR_STATE_ROOT = $root
$runtime = Join-Path $root 'runtime'
$configFile = Join-Path $root 'lanes.json'
$registryFile = Join-Path $root 'lane-registry.json'
$statusFile = Join-Path $root 'lane-status.json'
$eventFile = Join-Path $root 'lane-events.ndjson'
$plannerExecutorStateFile = Join-Path $root 'planner-executor-state.json'
$plannerExecutorStatusFile = Join-Path $root 'planner-executor-status.json'
$plannerExecutorStartupFailureFile = Join-Path $root 'planner-executor-startup-failure.json'
$plannerExecutorProjectsFile = Join-Path $root 'planner-executor-projects.json'
$plannerExecutorProjectsDir = Join-Path $root 'planner-executor-projects'
$singleConversationControlFile = Join-Path $root 'single-conversation-control.json'
$singleConversationStateFile = Join-Path $root 'single-conversation-state.json'
$startScript = Join-Path $runtime 'windows\start-supervisor.ps1'
$stopScript = Join-Path $runtime 'windows\stop-supervisor.ps1'
$lifecycleScript = Join-Path $runtime 'windows\lifecycle-truth.ps1'
$observabilityScript = Join-Path $runtime 'windows\control-panel-observability.ps1'
$openChatScript = Join-Path $runtime 'windows\open-supervisor-chat.ps1'
$resetAllProjectsScript = Join-Path $runtime 'windows\reset-all-projects.ps1'
$runnerRoot = [string]$env:SUPERVISOR_RUNNER_ROOT
if ([string]::IsNullOrWhiteSpace($runnerRoot)) {
    foreach ($candidate in @(
        'C:\actions-runner-magasin-supervisor\actions-runner',
        'C:\actions-runner-business\actions-runner'
    )) {
        if (Test-Path (Join-Path $candidate 'run.cmd')) {
            $runnerRoot = $candidate
            break
        }
    }
}
if ([string]::IsNullOrWhiteSpace($runnerRoot)) {
    $listener = Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath } |
        Select-Object -First 1
    if ($listener -and $listener.ExecutablePath) {
        $binDir = Split-Path ([string]$listener.ExecutablePath) -Parent
        $candidate = Split-Path $binDir -Parent
        if (Test-Path (Join-Path $candidate 'run.cmd')) {
            $runnerRoot = $candidate
        }
    }
}
if (-not [string]::IsNullOrWhiteSpace($runnerRoot)) {
    $env:SUPERVISOR_RUNNER_ROOT = $runnerRoot
}
$repoUrl = [string]$env:SUPERVISOR_PROJECT_REPOSITORY_URL
$vietnamTimeZone = [TimeZoneInfo]::FindSystemTimeZoneById('SE Asia Standard Time')
$script:lastRecoveryRequestAt = [DateTimeOffset]::MinValue
$script:lastRunnerRecoveryRequestAt = [DateTimeOffset]::MinValue
$script:runnerRecoveryBackoffSeconds = 5

if (-not (Test-Path $lifecycleScript)) {
    throw "Không tìm thấy lifecycle truth helper: $lifecycleScript"
}
if (-not (Test-Path $observabilityScript)) {
    throw "Không tìm thấy Control Panel observability helper: $observabilityScript"
}
. $lifecycleScript
. $observabilityScript

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    try {
        return Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Get-OptionalPropertyValue(
    $InputObject,
    [string]$Name,
    $DefaultValue = $null
) {
    if ($null -eq $InputObject) { return $DefaultValue }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $DefaultValue }
    return $property.Value
}

if ($ObservabilityProbe) {
    $configProbe = Read-JsonFile $configFile
    $statusProbe = Read-JsonFile $statusFile
    $ownerStopProbe = Get-LifecycleOwnerStopState -Root $root
    $processTruthProbe = Get-LifecycleProcessTruth -Root $root
    $enabledProbe = if ($configProbe -and $configProbe.lanes) {
        @($configProbe.lanes | Where-Object { [bool]$_.enabled }).Count
    } else { 0 }
    $schedulerProbe = Get-OptionalPropertyValue $statusProbe 'scheduler' $null
    $resourceProbe = Get-ControlPanelResourceSummary $schedulerProbe
    $tailProbe = Read-BoundedLaneEventTail -Path $eventFile -MaxEvents 30 -MaxBytes 262144

    [pscustomobject]@{
        schema_version = 'control-panel-observability-probe.v1'
        owner_stop = [bool]$ownerStopProbe.blocked
        wrapper_alive = [bool]$processTruthProbe.wrapper_alive
        three_lane_alive = [bool]$processTruthProbe.three_lane_alive
        chrome_alive = [bool]$processTruthProbe.chrome_alive
        cdp_healthy = [bool]$processTruthProbe.cdp_healthy
        runtime_version = [string](Get-OptionalPropertyValue $statusProbe 'supervisor_runtime_version' '')
        enabled_lane_count = [int]$enabledProbe
        page_summary = [string]$resourceProbe.page_text
        mutation_lease = [string]$resourceProbe.mutation_text
        timeline_event_count = @($tailProbe.events).Count
        timeline_bytes_read = [int]$tailProbe.bytes_read
        timeline_file_length = [long]$tailProbe.file_length
    } | ConvertTo-Json -Compress
    exit 0
}

function Write-JsonAtomic([string]$Path, $Value) {
    $dir = Split-Path $Path -Parent
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $tmp = "$Path.tmp"
    $json = $Value | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText(
        $tmp,
        $json + [Environment]::NewLine,
        (New-Object System.Text.UTF8Encoding($false))
    )
    Move-Item -Path $tmp -Destination $Path -Force
}

function New-DefaultConfig {
    return [ordered]@{
        schema_version = 'three-lane-config.v1'
        mode = 'THREE_LANE_V1'
        lanes = @(
            [ordered]@{ lane_id='lane-1'; project_name='Dự án 1'; brain_url=''; brain_url_revision=0; work_url=''; work_url_revision=0; work_url_saved_at=$null; work_mode='AUTO'; relay_retry_rearm_revision=0; relay_retry_rearm_requested_at=$null; resume_revision=0; resume_requested_at=$null; enabled=$false },
            [ordered]@{ lane_id='lane-2'; project_name='Dự án 2'; brain_url=''; brain_url_revision=0; work_url=''; work_url_revision=0; work_url_saved_at=$null; work_mode='AUTO'; relay_retry_rearm_revision=0; relay_retry_rearm_requested_at=$null; resume_revision=0; resume_requested_at=$null; enabled=$false },
            [ordered]@{ lane_id='lane-3'; project_name='Dự án 3'; brain_url=''; brain_url_revision=0; work_url=''; work_url_revision=0; work_url_saved_at=$null; work_mode='AUTO'; relay_retry_rearm_revision=0; relay_retry_rearm_requested_at=$null; resume_revision=0; resume_requested_at=$null; enabled=$false }
        )
    }
}

function Ensure-Config {
    $config = Read-JsonFile $configFile
    if (-not $config -or -not $config.lanes) {
        $config = New-DefaultConfig
        Write-JsonAtomic $configFile $config
    }
    return $config
}

function Get-LaneConfig($Config, [string]$LaneId) {
    return @($Config.lanes | Where-Object { [string]$_.lane_id -eq $LaneId } | Select-Object -First 1)[0]
}

function ConvertTo-CanonicalChatConversationUrl([string]$Url) {
    if (-not $Url) { throw 'URL trống' }
    $uri = [Uri]$Url
    if (
        $uri.Scheme -ne 'https' -or
        $uri.Host -notmatch '(^|\.)chatgpt\.com$' -or
        $uri.AbsolutePath -notmatch '^/(c|g|project)/'
    ) {
        throw 'URL phải là cuộc trò chuyện ChatGPT cụ thể'
    }

    $path = $uri.AbsolutePath
    if ($path -match '^/c/WEB:([0-9a-fA-F-]{36})$') {
        $path = '/c/' + $Matches[1]
    }
    return 'https://chatgpt.com' + $path
}

function Test-ChatConversationUrl([string]$Url) {
    try {
        [void](ConvertTo-CanonicalChatConversationUrl $Url)
        return $true
    } catch {
        return $false
    }
}
function Get-SupervisorProcess {
    return Get-LifecycleSupervisorWrapper -Root $root
}

function Request-LifecycleRecovery {
    $now = [DateTimeOffset]::UtcNow
    if (($now - $script:lastRecoveryRequestAt).TotalSeconds -lt 5) {
        return
    }

    $result = Invoke-LifecycleRecoveryStart -StartScript $startScript -Root $root
    if ([string]$result.state -in @('STARTING','RECOVERING')) {
        $script:lastRecoveryRequestAt = $now
    }
}

function Get-RunnerProcess {
    if ([string]::IsNullOrWhiteSpace($runnerRoot)) { return $null }
    return Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.ExecutablePath -and $_.ExecutablePath -like "$runnerRoot*") -or
            ($_.CommandLine -and $_.CommandLine -like "*$runnerRoot*")
        } |
        Select-Object -First 1
}

function Ensure-Runner {
    if ([string]::IsNullOrWhiteSpace($runnerRoot)) { return $false }
    if (Get-RunnerProcess) { return $true }
    $runCmd = Join-Path $runnerRoot 'run.cmd'
    if (-not (Test-Path $runCmd)) { return $false }
    try {
        $env:RUNNER_TRACKING_ID = 'MAGASIN_RUNNER_PERSISTENT'
        Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory $runnerRoot -ArgumentList @('/c','run.cmd')
        Start-Sleep -Seconds 2
        return [bool](Get-RunnerProcess)
    } catch {
        return $false
    }
}

function Request-RunnerRecovery {
    if ([string]::IsNullOrWhiteSpace($runnerRoot)) { return $false }
    if (Get-RunnerProcess) {
        $script:runnerRecoveryBackoffSeconds = 5
        return $true
    }

    $now = [DateTimeOffset]::UtcNow
    if (($now - $script:lastRunnerRecoveryRequestAt).TotalSeconds -lt $script:runnerRecoveryBackoffSeconds) {
        return $false
    }

    $script:lastRunnerRecoveryRequestAt = $now
    $recovered = Ensure-Runner
    if ($recovered) {
        $script:runnerRecoveryBackoffSeconds = 5
        return $true
    }

    $script:runnerRecoveryBackoffSeconds = [Math]::Min(
        60,
        [Math]::Max(5, $script:runnerRecoveryBackoffSeconds * 2)
    )
    return $false
}

function Open-RobotUrl([string]$Url) {
    if (-not (Test-ChatConversationUrl $Url)) {
        [Windows.Forms.MessageBox]::Show(
            'Chưa có URL cuộc trò chuyện hợp lệ.',
            'MAGASIN SUPERVISOR',
            'OK',
            'Information'
        ) | Out-Null
        return
    }
    if (-not (Test-Path $openChatScript)) {
        [Windows.Forms.MessageBox]::Show(
            'Không tìm thấy trình mở Chrome Robot.',
            'MAGASIN SUPERVISOR',
            'OK',
            'Error'
        ) | Out-Null
        return
    }
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
        '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
        '-File',('"' + $openChatScript + '"'),
        '-Url',('"' + $Url + '"')
    )
}

function Format-VietnamTime([string]$Value) {
    if (-not $Value) { return '—' }
    try {
        $dt = [DateTimeOffset]::Parse($Value)
        $vn = [TimeZoneInfo]::ConvertTime($dt, $vietnamTimeZone)
        return $vn.ToString('dd/MM/yyyy HH:mm:ss') + ' giờ Việt Nam'
    } catch {
        return '—'
    }
}

function Get-FriendlyStatus([string]$Status) {
    switch ($Status) {
        'STOPPED' { return 'ĐÃ DỪNG' }
        'NEED_BRAIN_URL' { return 'CẦN LINK BỘ NÃO' }
        'STARTING' { return 'ĐANG KHỞI ĐỘNG' }
        'WAITING_BRAIN' { return 'ĐANG CHỜ BỘ NÃO' }
        'WORKING' { return 'ĐANG LÀM VIỆC' }
        'WORKING_LONG' { return 'WORK ĐANG CHẠY LÂU' }
        'STALL_CHECK' { return 'ĐANG KIỂM TRA STALL' }
        'POSSIBLY_STALLED' { return 'WORK CÓ THỂ ĐÃ STALL' }
        'RELAYING_RESULT' { return 'ĐANG GỬI KẾT QUẢ' }
        'READY' { return 'SẴN SÀNG' }
        'RECOVERING' { return 'ĐANG TỰ KHÔI PHỤC' }
        'WAIT_OWNER' { return 'CẦN BẠN XỬ LÝ' }
        'ERROR' { return 'CÓ LỖI' }
        default { return 'ĐANG KHỞI TẠO' }
    }
}

function Get-StatusBackColor([string]$Status) {
    switch ($Status) {
        'WORKING' { return [Drawing.Color]::FromArgb(219,234,254) }
        'WORKING_LONG' { return [Drawing.Color]::FromArgb(224,242,254) }
        'STALL_CHECK' { return [Drawing.Color]::FromArgb(254,249,195) }
        'POSSIBLY_STALLED' { return [Drawing.Color]::FromArgb(255,237,213) }
        'RELAYING_RESULT' { return [Drawing.Color]::FromArgb(224,242,254) }
        'READY' { return [Drawing.Color]::FromArgb(220,252,231) }
        'WAITING_BRAIN' { return [Drawing.Color]::FromArgb(254,249,195) }
        'RECOVERING' { return [Drawing.Color]::FromArgb(254,249,195) }
        'WAIT_OWNER' { return [Drawing.Color]::FromArgb(255,237,213) }
        'ERROR' { return [Drawing.Color]::FromArgb(254,226,226) }
        'NEED_BRAIN_URL' { return [Drawing.Color]::FromArgb(255,237,213) }
        default { return [Drawing.Color]::FromArgb(248,250,252) }
    }
}

function Get-StatusForeColor([string]$Status) {
    switch ($Status) {
        'WORKING' { return [Drawing.Color]::FromArgb(29,78,216) }
        'WORKING_LONG' { return [Drawing.Color]::FromArgb(3,105,161) }
        'STALL_CHECK' { return [Drawing.Color]::FromArgb(161,98,7) }
        'POSSIBLY_STALLED' { return [Drawing.Color]::FromArgb(194,65,12) }
        'RELAYING_RESULT' { return [Drawing.Color]::FromArgb(3,105,161) }
        'READY' { return [Drawing.Color]::FromArgb(21,128,61) }
        'WAITING_BRAIN' { return [Drawing.Color]::FromArgb(161,98,7) }
        'RECOVERING' { return [Drawing.Color]::FromArgb(161,98,7) }
        'WAIT_OWNER' { return [Drawing.Color]::FromArgb(194,65,12) }
        'ERROR' { return [Drawing.Color]::FromArgb(185,28,28) }
        'NEED_BRAIN_URL' { return [Drawing.Color]::FromArgb(194,65,12) }
        default { return [Drawing.Color]::FromArgb(51,65,85) }
    }
}

function Save-Lane(
    [string]$LaneId,
    [string]$ProjectName,
    [string]$BrainUrl,
    [bool]$Enabled
) {
    $config = Ensure-Config
    $lane = Get-LaneConfig $config $LaneId
    if (-not $lane) { throw "Không tìm thấy $LaneId" }

    if (-not $lane.PSObject.Properties['brain_url_revision']) {
        $initialBrainRevision = if ([string]$lane.brain_url) { 1 } else { 0 }
        $lane | Add-Member -NotePropertyName 'brain_url_revision' -NotePropertyValue $initialBrainRevision
    }
    if (-not $lane.PSObject.Properties['resume_revision']) {
        $lane | Add-Member -NotePropertyName 'resume_revision' -NotePropertyValue 0
    }
    if (-not $lane.PSObject.Properties['resume_requested_at']) {
        $lane | Add-Member -NotePropertyName 'resume_requested_at' -NotePropertyValue $null
    }

    $wasEnabled = [bool]$lane.enabled
    $newBrainUrl = if ($BrainUrl) { $BrainUrl.Trim() } else { '' }
    if ([string]$lane.brain_url -ne $newBrainUrl) {
        $lane.brain_url_revision = [int]$lane.brain_url_revision + 1
    }

    if ($Enabled -and -not $wasEnabled) {
        $lane.resume_revision = [int]$lane.resume_revision + 1
        $lane.resume_requested_at = [DateTimeOffset]::UtcNow.ToString('o')
    }

    $lane.project_name = if ($ProjectName) { $ProjectName.Trim() } else { $LaneId }
    $lane.brain_url = $newBrainUrl
    $lane.enabled = $Enabled
    Write-JsonAtomic $configFile $config
}

function Save-WorkTarget(
    [string]$LaneId,
    [string]$WorkUrl = '',
    [bool]$RobotManaged = $false,
    [bool]$ForceRevision = $false
) {
    $config = Ensure-Config
    $lane = Get-LaneConfig $config $LaneId
    if (-not $lane) { throw "Không tìm thấy $LaneId" }

    if (-not $lane.PSObject.Properties['work_url']) {
        $lane | Add-Member -NotePropertyName 'work_url' -NotePropertyValue ''
    }
    if (-not $lane.PSObject.Properties['work_url_revision']) {
        $lane | Add-Member -NotePropertyName 'work_url_revision' -NotePropertyValue 0
    }
    if (-not $lane.PSObject.Properties['work_url_saved_at']) {
        $lane | Add-Member -NotePropertyName 'work_url_saved_at' -NotePropertyValue $null
    }
    if (-not $lane.PSObject.Properties['work_mode']) {
        $legacyMode = if ([string]$lane.work_url) { 'OWNER' } else { 'AUTO' }
        $lane | Add-Member -NotePropertyName 'work_mode' -NotePropertyValue $legacyMode
    }

    $newMode = if ($RobotManaged) { 'AUTO' } else { 'OWNER' }
    $newWorkUrl = if ($RobotManaged) {
        ''
    } else {
        ConvertTo-CanonicalChatConversationUrl $WorkUrl
    }

    $currentMode = ([string]$lane.work_mode).ToUpperInvariant()
    if ($currentMode -notin @('OWNER','AUTO')) {
        $currentMode = if ([string]$lane.work_url) { 'OWNER' } else { 'AUTO' }
    }
    $currentWorkUrl = ''
    if ($currentMode -eq 'OWNER' -and [string]$lane.work_url) {
        try {
            $currentWorkUrl = ConvertTo-CanonicalChatConversationUrl ([string]$lane.work_url)
        } catch {
            $currentWorkUrl = ([string]$lane.work_url).Trim()
        }
    }

    if (
        -not $ForceRevision -and
        $currentMode -eq $newMode -and
        $currentWorkUrl -eq $newWorkUrl
    ) {
        return [pscustomobject]@{
            Changed = $false
            Revision = [int]$lane.work_url_revision
            SavedAt = $lane.work_url_saved_at
            Mode = $currentMode
        }
    }

    $lane.work_url = $newWorkUrl
    $lane.work_mode = $newMode
    $lane.work_url_revision = [int]$lane.work_url_revision + 1
    $lane.work_url_saved_at = [DateTimeOffset]::UtcNow.ToString('o')
    Write-JsonAtomic $configFile $config

    return [pscustomobject]@{
        Changed = $true
        Revision = [int]$lane.work_url_revision
        SavedAt = [string]$lane.work_url_saved_at
        Mode = $newMode
    }
}

function Request-RelayRetryRearm([string]$LaneId) {
    $config = Ensure-Config
    $lane = Get-LaneConfig $config $LaneId
    if (-not $lane) { throw "Không tìm thấy $LaneId" }

    if (-not $lane.PSObject.Properties['relay_retry_rearm_revision']) {
        $lane | Add-Member -NotePropertyName 'relay_retry_rearm_revision' -NotePropertyValue 0
    }
    if (-not $lane.PSObject.Properties['relay_retry_rearm_requested_at']) {
        $lane | Add-Member -NotePropertyName 'relay_retry_rearm_requested_at' -NotePropertyValue $null
    }

    $lane.relay_retry_rearm_revision = [int]$lane.relay_retry_rearm_revision + 1
    $lane.relay_retry_rearm_requested_at = [DateTimeOffset]::UtcNow.ToString('o')
    Write-JsonAtomic $configFile $config

    return [pscustomobject]@{
        Revision = [int]$lane.relay_retry_rearm_revision
        RequestedAt = [string]$lane.relay_retry_rearm_requested_at
    }
}

function Save-BrainTarget(
    [string]$LaneId,
    [string]$BrainUrl
) {
    $config = Ensure-Config
    $lane = Get-LaneConfig $config $LaneId
    if (-not $lane) { throw "Không tìm thấy $LaneId" }

    if (-not $lane.PSObject.Properties['brain_url_revision']) {
        $initialBrainRevision = if ([string]$lane.brain_url) { 1 } else { 0 }
        $lane | Add-Member -NotePropertyName 'brain_url_revision' -NotePropertyValue $initialBrainRevision
    }

    $newBrainUrl = if ($BrainUrl) { $BrainUrl.Trim() } else { '' }
    if ([string]$lane.brain_url -ne $newBrainUrl) {
        $lane.brain_url_revision = [int]$lane.brain_url_revision + 1
        $lane.brain_url = $newBrainUrl
        Write-JsonAtomic $configFile $config
        return $true
    }

    return $false
}


function Save-PlannerExecutorTargets(
    [string]$PlannerUrl,
    [string]$ExecutorUrl
) {
    $state = Read-JsonFile $plannerExecutorStateFile
    if (-not $state -or [string]$state.mode -ne 'PLANNER_EXECUTOR_V1') {
        throw 'Planner/Executor state chưa sẵn sàng.'
    }

    $truth = Get-LifecycleProcessTruth -Root $root
    if ([bool]$truth.wrapper_alive) {
        throw 'Hãy STOP ROBOT trước khi đổi link Planner/Executor.'
    }

    $automation = Get-OptionalPropertyValue $state 'automation' $null
    $automationStatus = [string](Get-OptionalPropertyValue $automation 'status' '')
    if (
        $automationStatus -notin @('DONE','STOPPED') -and
        (
            $null -ne (Get-OptionalPropertyValue $state 'assignment' $null) -or
            $null -ne (Get-OptionalPropertyValue $state 'result' $null)
        )
    ) {
        throw 'Không thể đổi link khi task đang có assignment/result hoạt động. Hãy hoàn tất hoặc dừng ở điểm an toàn trước.'
    }

    $plannerCanonical = ConvertTo-CanonicalChatConversationUrl $PlannerUrl
    $executorCanonical = ConvertTo-CanonicalChatConversationUrl $ExecutorUrl
    if ($plannerCanonical -eq $executorCanonical) {
        throw 'Planner và Executor phải là hai cuộc trò chuyện ChatGPT khác nhau.'
    }

    $planner = Get-OptionalPropertyValue $state 'planner' $null
    $executor = Get-OptionalPropertyValue $state 'executor' $null
    if (-not $planner -or -not $executor) {
        throw 'Planner/Executor target state không hợp lệ.'
    }

    $changed = $false
    if ([string]$planner.target -ne $plannerCanonical) {
        $planner.target = $plannerCanonical
        $planner.target_revision = [int](Get-OptionalPropertyValue $planner 'target_revision' 0) + 1
        $planner.last_seen_assistant_turn_id = $null
        $changed = $true
    }
    if ([string]$executor.target -ne $executorCanonical) {
        $executor.target = $executorCanonical
        $executor.target_revision = [int](Get-OptionalPropertyValue $executor 'target_revision' 0) + 1
        $executor.last_seen_assistant_turn_id = $null
        $changed = $true
    }

    if ($changed) {
        Write-JsonAtomic $plannerExecutorStateFile $state
    }

    return [pscustomobject]@{
        Changed = $changed
        PlannerRevision = [int]$planner.target_revision
        ExecutorRevision = [int]$executor.target_revision
    }
}


function ConvertTo-CanonicalSourceOfTruthUrl([string]$Url) {
    if ([string]::IsNullOrWhiteSpace($Url)) { throw 'Source of Truth URL trống.' }
    $uri = [Uri]$Url.Trim()
    if ($uri.Scheme -ne 'https' -or [string]::IsNullOrWhiteSpace($uri.Host)) {
        throw 'Source of Truth phải là URL https hợp lệ.'
    }
    if ($uri.UserInfo) { throw 'Source of Truth URL không được chứa username/password.' }
    return $uri.AbsoluteUri
}

function Assert-ProjectId([string]$ProjectId) {
    $id = if ($ProjectId) { $ProjectId.Trim() } else { '' }
    if ($id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        throw 'Project ID chỉ dùng chữ, số, dấu chấm, gạch dưới hoặc gạch ngang; tối đa 64 ký tự.'
    }
    return $id
}

function Get-ProjectProfileStatePath([string]$ProjectId) {
    $id = Assert-ProjectId $ProjectId
    New-Item -ItemType Directory -Force -Path $plannerExecutorProjectsDir | Out-Null
    return Join-Path $plannerExecutorProjectsDir ($id + '.json')
}

function New-PlannerExecutorProjectState(
    [string]$ProjectId,
    [string]$ProjectName,
    [string]$SourceUrl,
    [string]$PlannerUrl,
    [string]$ExecutorUrl
) {
    $id = Assert-ProjectId $ProjectId
    $source = ConvertTo-CanonicalSourceOfTruthUrl $SourceUrl
    $planner = ConvertTo-CanonicalChatConversationUrl $PlannerUrl
    $executor = ConvertTo-CanonicalChatConversationUrl $ExecutorUrl
    if ($planner -eq $executor) { throw 'Planner và Executor phải là hai cuộc trò chuyện ChatGPT khác nhau.' }
    return [ordered]@{
        schema_version = 'planner-executor-state.v1'
        mode = 'PLANNER_EXECUTOR_V1'
        project_id = $id
        project_generation = 1
        project_name = if ($ProjectName) { $ProjectName.Trim() } else { $id }
        project_context = [ordered]@{ source_of_truth_url = $source; strict_correlation = $false }
        project_progress = [ordered]@{ known = $false; completed_tasks = 0; total_tasks = 0; percent = $null; updated_at = $null; source = $null }
        project_context_bootstrap = [ordered]@{
            required = $true; generation = 1; baseline_captured_at = $null
            baseline_assistant_turn_id = $null; baseline_user_turn_id = $null
            send_attempted_at = $null; send_confirmed_at = $null; send_evidence = $null
            completed_at = $null; message_digest = $null; last_send_error = $null
        }
        planner = [ordered]@{ target = $planner; target_revision = 1; last_seen_assistant_turn_id = $null }
        executor = [ordered]@{ target = $executor; target_revision = 1; last_seen_assistant_turn_id = $null }
        active_task_id = $null
        assignment = $null
        result = $null
        decision = $null
        last_completed = $null
        automation = [ordered]@{ status = 'RUNNING'; reason = $null; updated_at = [DateTimeOffset]::UtcNow.ToString('o') }
        identity_history = [ordered]@{ assignment_ids = @(); result_ids = @() }
    }
}

function Ensure-PlannerExecutorProjectProfiles {
    $profiles = Read-JsonFile $plannerExecutorProjectsFile
    if ($profiles -and [string]$profiles.schema_version -eq 'planner-executor-projects.v1' -and $null -ne $profiles.profiles) {
        return $profiles
    }
    $state = Read-JsonFile $plannerExecutorStateFile
    if (-not $state -or [string]$state.mode -ne 'PLANNER_EXECUTOR_V1') {
        $empty = [ordered]@{ schema_version='planner-executor-projects.v1'; active_project_id=$null; profiles=@() }
        Write-JsonAtomic $plannerExecutorProjectsFile $empty
        return Read-JsonFile $plannerExecutorProjectsFile
    }
    $projectId = Assert-ProjectId ([string]$state.project_id)
    if (-not $state.PSObject.Properties['project_generation']) { $state | Add-Member -NotePropertyName 'project_generation' -NotePropertyValue 1 }
    if (-not $state.PSObject.Properties['project_context']) {
        $state | Add-Member -NotePropertyName 'project_context' -NotePropertyValue ([pscustomobject]@{ source_of_truth_url=''; strict_correlation=$false })
    }
    if (-not $state.PSObject.Properties['project_progress']) {
        $state | Add-Member -NotePropertyName 'project_progress' -NotePropertyValue ([pscustomobject]@{ known=$false; completed_tasks=0; total_tasks=0; percent=$null; updated_at=$null; source=$null })
    }
    $statePath = Get-ProjectProfileStatePath $projectId
    Write-JsonAtomic $statePath $state
    $registry = [ordered]@{
        schema_version='planner-executor-projects.v1'
        active_project_id=$projectId
        profiles=@([ordered]@{
            project_id=$projectId
            project_name=[string](Get-OptionalPropertyValue $state 'project_name' $projectId)
            source_of_truth_url=[string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'project_context' $null) 'source_of_truth_url' '')
            planner_url=[string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'planner' $null) 'target' '')
            executor_url=[string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'executor' $null) 'target' '')
            project_generation=[int](Get-OptionalPropertyValue $state 'project_generation' 1)
            state_file=$statePath
        })
    }
    Write-JsonAtomic $plannerExecutorProjectsFile $registry
    return Read-JsonFile $plannerExecutorProjectsFile
}

function Get-PlannerExecutorProjectProfile($Registry, [string]$ProjectId) {
    return @($Registry.profiles | Where-Object { [string]$_.project_id -eq $ProjectId } | Select-Object -First 1)[0]
}

function Save-ActiveProjectSnapshot {
    $registry = Ensure-PlannerExecutorProjectProfiles
    $activeId = [string](Get-OptionalPropertyValue $registry 'active_project_id' '')
    if (-not $activeId) { return $registry }
    $state = Read-JsonFile $plannerExecutorStateFile
    if (-not $state) { return $registry }
    $profile = Get-PlannerExecutorProjectProfile $registry $activeId
    if (-not $profile) { return $registry }
    $profile.project_name = [string](Get-OptionalPropertyValue $state 'project_name' $activeId)
    $profile.source_of_truth_url = [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'project_context' $null) 'source_of_truth_url' '')
    $profile.planner_url = [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'planner' $null) 'target' '')
    $profile.executor_url = [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'executor' $null) 'target' '')
    $profile.project_generation = [int](Get-OptionalPropertyValue $state 'project_generation' 1)
    $stateFile = [string](Get-OptionalPropertyValue $profile 'state_file' '')
    if (-not $stateFile) { $stateFile = Get-ProjectProfileStatePath $activeId; $profile.state_file = $stateFile }
    Write-JsonAtomic $stateFile $state
    Write-JsonAtomic $plannerExecutorProjectsFile $registry
    return $registry
}

function Assert-SafeProjectMutation {
    $truth = Get-LifecycleProcessTruth -Root $root
    if ([bool]$truth.wrapper_alive) {
        throw 'Hãy STOP ROBOT trước khi chuyển project active.'
    }
    # A stopped project may be parked with an in-flight assignment/result.
    # The full durable state is snapshotted per project and resumed exactly
    # from that snapshot when the project becomes active again.
}

function New-LinkOnlyPlannerExecutorShell {
    return [ordered]@{
        schema_version='planner-executor-state.v1'
        mode='PLANNER_EXECUTOR_V1'
        project_id='LIVE'
        project_generation=1
        project_name='LIVE SESSION'
        project_context=[ordered]@{ source_of_truth_url=$null; strict_correlation=$false }
        project_progress=[ordered]@{ known=$false; completed_tasks=0; total_tasks=0; percent=$null; updated_at=$null; source=$null }
        project_context_bootstrap=$null
        planner=[ordered]@{ target=''; target_revision=0; last_seen_assistant_turn_id=$null }
        executor=[ordered]@{ target=''; target_revision=0; last_seen_assistant_turn_id=$null }
        active_task_id=$null
        assignment=$null
        result=$null
        decision=$null
        last_completed=$null
        automation=[ordered]@{ status='IDLE'; reason=$null; updated_at=[DateTimeOffset]::UtcNow.ToString('o') }
        identity_history=[ordered]@{ assignment_ids=@(); result_ids=@() }
    }
}

function Initialize-LinkOnlyPlannerExecutorSession(
    [string]$SourceUrl,
    [string]$PlannerUrl,
    [string]$ExecutorUrl
) {
    $truth = Get-LifecycleProcessTruth -Root $root
    if ([bool]$truth.wrapper_alive) {
        throw 'Hãy STOP ROBOT trước khi tạo phiên link-only mới.'
    }

    $source = ConvertTo-CanonicalSourceOfTruthUrl $SourceUrl
    $planner = ConvertTo-CanonicalChatConversationUrl $PlannerUrl
    $executor = ConvertTo-CanonicalChatConversationUrl $ExecutorUrl
    if ($planner -eq $executor) { throw 'Planner và Executor phải là hai cuộc trò chuyện ChatGPT khác nhau.' }

    # Link-only mode intentionally creates a fresh runtime session on every START.
    # No project profile/snapshot is restored; Source of Truth is the only project authority.
    $state = New-PlannerExecutorProjectState 'LIVE' 'LIVE SESSION' $source $planner $executor
    $state.project_generation = 1
    $state.project_context.strict_correlation = $false
    $state.project_context_bootstrap = New-ProjectContextBootstrap 1
    $state.project_progress = [pscustomobject]@{
        known=$false; completed_tasks=0; total_tasks=0; percent=$null; updated_at=$null; source=$null
    }
    $state.automation = [pscustomobject]@{
        status='RUNNING'; reason=$null; updated_at=[DateTimeOffset]::UtcNow.ToString('o')
    }

    # Remove all durable multi-project/profile artifacts before starting the fresh session.
    Remove-Item $plannerExecutorProjectsFile -Force -ErrorAction SilentlyContinue
    Remove-Item $plannerExecutorProjectsDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $plannerExecutorStatusFile -Force -ErrorAction SilentlyContinue
    Remove-Item $plannerExecutorStartupFailureFile -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $root 'planner-executor-incidents.ndjson') -Force -ErrorAction SilentlyContinue

    Write-JsonAtomic $plannerExecutorStateFile $state
    return $state
}

function Reset-LinkOnlyPlannerExecutorSession {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $stopScript
    if ($LASTEXITCODE -ne 0) {
        throw 'STOP ROBOT thất bại; không thể reset phiên.'
    }

    # RESET is destructive for all project/session-local data. Browser login,
    # Supervisor installation and GitHub Runner are intentionally preserved.
    Remove-Item $plannerExecutorStateFile -Force -ErrorAction SilentlyContinue
    Remove-Item $plannerExecutorStatusFile -Force -ErrorAction SilentlyContinue
    Remove-Item $plannerExecutorStartupFailureFile -Force -ErrorAction SilentlyContinue
    Remove-Item $plannerExecutorProjectsFile -Force -ErrorAction SilentlyContinue
    Remove-Item $plannerExecutorProjectsDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $root 'planner-executor-incidents.ndjson') -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $root 'diagnostics\submit') -Recurse -Force -ErrorAction SilentlyContinue

    # Keep only an empty mode shell so Control Center reopens in Planner/Executor mode.
    # This shell contains no project URL, chat URL, progress, task, assignment or result.
    $shell = New-LinkOnlyPlannerExecutorShell
    Write-JsonAtomic $plannerExecutorStateFile $shell
    return $shell
}

function New-ProjectContextBootstrap([int]$Generation) {
    return [pscustomobject]@{
        required=$true; generation=$Generation; baseline_captured_at=$null
        baseline_assistant_turn_id=$null; baseline_user_turn_id=$null
        send_attempted_at=$null; send_confirmed_at=$null; send_evidence=$null
        completed_at=$null; message_digest=$null; last_send_error=$null
    }
}

function Save-PlannerExecutorProjectProfile(
    [string]$ProjectId,
    [string]$ProjectName,
    [string]$SourceUrl,
    [string]$PlannerUrl,
    [string]$ExecutorUrl
) {
    $id = Assert-ProjectId $ProjectId
    $source = ConvertTo-CanonicalSourceOfTruthUrl $SourceUrl
    $planner = ConvertTo-CanonicalChatConversationUrl $PlannerUrl
    $executor = ConvertTo-CanonicalChatConversationUrl $ExecutorUrl
    if ($planner -eq $executor) { throw 'Planner và Executor phải là hai cuộc trò chuyện ChatGPT khác nhau.' }

    # Saving a new/inactive profile is registry-only configuration and MUST NOT
    # disturb the active runtime. Safe-boundary checks apply only when the
    # profile being edited is the active project.
    $registry = Ensure-PlannerExecutorProjectProfiles
    $profile = Get-PlannerExecutorProjectProfile $registry $id
    $isActiveProfile = [bool]([string]$registry.active_project_id -eq $id)
    if ($isActiveProfile) {
        $truth = Get-LifecycleProcessTruth -Root $root
        if ([bool]$truth.wrapper_alive) {
            throw 'Hãy STOP ROBOT trước khi đổi link của project đang active.'
        }
        $activeState = Read-JsonFile $plannerExecutorStateFile
        $activeSource = [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $activeState 'project_context' $null) 'source_of_truth_url' '')
        $hasActiveTransfer = [bool](
            $null -ne (Get-OptionalPropertyValue $activeState 'assignment' $null) -or
            $null -ne (Get-OptionalPropertyValue $activeState 'result' $null)
        )
        if ($hasActiveTransfer -and $activeSource -ne $source) {
            throw 'Bạn đang sửa SOURCE của project ACTIVE. Source of Truth không được đổi khi assignment/result còn mở. Nếu đây là dự án khác, bấm TẠO PROFILE MỚI và nhập PROJECT ID mới; project hiện tại sẽ được giữ nguyên.'
        }
        $registry = Save-ActiveProjectSnapshot
        $profile = Get-PlannerExecutorProjectProfile $registry $id
    }
    if (-not $profile) {
        $newState = New-PlannerExecutorProjectState $id $ProjectName $source $planner $executor
        $stateFile = Get-ProjectProfileStatePath $id
        Write-JsonAtomic $stateFile $newState
        $registry.profiles = @($registry.profiles) + @([pscustomobject]@{
            project_id=$id; project_name=$(if ($ProjectName) { $ProjectName.Trim() } else { $id })
            source_of_truth_url=$source; planner_url=$planner; executor_url=$executor
            project_generation=1; state_file=$stateFile
        })
        Write-JsonAtomic $plannerExecutorProjectsFile $registry
        return [pscustomobject]@{ Created=$true; ProjectId=$id; Active=$false }
    }

    $stateFile = [string](Get-OptionalPropertyValue $profile 'state_file' '')
    if (-not $stateFile) { $stateFile = Get-ProjectProfileStatePath $id }
    $state = Read-JsonFile $stateFile
    if (-not $state) { $state = New-PlannerExecutorProjectState $id $ProjectName $source $planner $executor }

    $oldSource = [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'project_context' $null) 'source_of_truth_url' '')
    $oldPlanner = [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'planner' $null) 'target' '')
    $oldExecutor = [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'executor' $null) 'target' '')
    $sourceChanged = ($oldSource -ne $source)
    $plannerChanged = ($oldPlanner -ne $planner)
    $executorChanged = ($oldExecutor -ne $executor)

    $state.project_name = if ($ProjectName) { $ProjectName.Trim() } else { $id }
    if (-not $state.PSObject.Properties['project_generation']) { $state | Add-Member -NotePropertyName 'project_generation' -NotePropertyValue 1 }
    if (-not $state.PSObject.Properties['project_context']) {
        $state | Add-Member -NotePropertyName 'project_context' -NotePropertyValue ([pscustomobject]@{ source_of_truth_url=$source; strict_correlation=$false })
    }
    $state.project_context.source_of_truth_url = $source

    if ($sourceChanged) {
        $state.project_generation = [int]$state.project_generation + 1
        $state.project_context.strict_correlation = $false
        $state.project_context_bootstrap = New-ProjectContextBootstrap ([int]$state.project_generation)
        $state.project_progress = [pscustomobject]@{ known=$false; completed_tasks=0; total_tasks=0; percent=$null; updated_at=$null; source=$null }
        $state.planner.last_seen_assistant_turn_id = $null
    }
    if ($plannerChanged) {
        $oldPlannerRevision = [int](Get-OptionalPropertyValue $state.planner 'target_revision' 0)
        if ($state.result -and -not $state.result.PSObject.Properties['target_revision']) {
            $state.result | Add-Member -NotePropertyName 'target_revision' -NotePropertyValue $oldPlannerRevision
        }
        if (-not $state.planner.PSObject.Properties['previous_target']) {
            $state.planner | Add-Member -NotePropertyName 'previous_target' -NotePropertyValue $oldPlanner
        } elseif (-not [string]$state.planner.previous_target) {
            $state.planner.previous_target = $oldPlanner
        }
        $state.planner.target = $planner
        $state.planner.target_revision = $oldPlannerRevision + 1
        $state.planner.last_seen_assistant_turn_id = $null

        # A new Planner conversation has no prior project context. Re-arm the
        # Source of Truth bootstrap without changing project identity/generation.
        $state.project_context.strict_correlation = $false
        $state.project_context_bootstrap = New-ProjectContextBootstrap ([int]$state.project_generation)
    }
    if ($executorChanged) {
        $oldExecutorRevision = [int](Get-OptionalPropertyValue $state.executor 'target_revision' 0)
        if ($state.assignment -and -not $state.result -and -not $state.assignment.PSObject.Properties['target_revision']) {
            $state.assignment | Add-Member -NotePropertyName 'target_revision' -NotePropertyValue $oldExecutorRevision
        }
        if (-not $state.executor.PSObject.Properties['previous_target']) {
            $state.executor | Add-Member -NotePropertyName 'previous_target' -NotePropertyValue $oldExecutor
        } elseif (-not [string]$state.executor.previous_target) {
            $state.executor.previous_target = $oldExecutor
        }
        $state.executor.target = $executor
        $state.executor.target_revision = $oldExecutorRevision + 1
        $state.executor.last_seen_assistant_turn_id = $null
    }

    $profile.project_name=$state.project_name
    $profile.source_of_truth_url=$source
    $profile.planner_url=$planner
    $profile.executor_url=$executor
    $profile.project_generation=[int]$state.project_generation
    $profile.state_file=$stateFile
    Write-JsonAtomic $stateFile $state
    if ([string]$registry.active_project_id -eq $id) {
        Write-JsonAtomic $plannerExecutorStateFile $state
        Remove-Item $plannerExecutorStatusFile -Force -ErrorAction SilentlyContinue
    }
    Write-JsonAtomic $plannerExecutorProjectsFile $registry
    return [pscustomobject]@{
        Created=$false
        ProjectId=$id
        Active=([string]$registry.active_project_id -eq $id)
        PlannerRollover=$plannerChanged
        ExecutorRollover=$executorChanged
        SourceChanged=$sourceChanged
    }
}

function Reset-PlannerExecutorActiveProject {
    # Explicit Owner escape hatch for a stuck Planner/Executor runtime.
    # Destructive scope: ACTIVE project runtime state only. Saved profiles,
    # Source/Chat targets, browser login, runtime install and Runner survive.
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $stopScript
    if ($LASTEXITCODE -ne 0) {
        throw 'STOP ROBOT thất bại; không reset state.'
    }

    $registry = Ensure-PlannerExecutorProjectProfiles
    $activeId = [string](Get-OptionalPropertyValue $registry 'active_project_id' '')
    if (-not $activeId) {
        throw 'Không có active project để reset.'
    }
    $profile = Get-PlannerExecutorProjectProfile $registry $activeId
    if (-not $profile) {
        throw "Không tìm thấy profile của active project: $activeId"
    }

    $stateFile = [string](Get-OptionalPropertyValue $profile 'state_file' '')
    if (-not $stateFile) {
        $stateFile = Get-ProjectProfileStatePath $activeId
        $profile.state_file = $stateFile
    }

    $state = Read-JsonFile $plannerExecutorStateFile
    if (-not $state) { $state = Read-JsonFile $stateFile }
    if (-not $state) {
        $state = New-PlannerExecutorProjectState $activeId ([string](Get-OptionalPropertyValue $profile 'project_name' $activeId)) ([string](Get-OptionalPropertyValue $profile 'source_of_truth_url' '')) ([string](Get-OptionalPropertyValue $profile 'planner_url' '')) ([string](Get-OptionalPropertyValue $profile 'executor_url' ''))
    }

    $nextGeneration = [int](Get-OptionalPropertyValue $state 'project_generation' 1) + 1
    $state.project_id = $activeId
    $state.project_generation = $nextGeneration
    $state.project_name = [string](Get-OptionalPropertyValue $profile 'project_name' $activeId)

    if (-not $state.PSObject.Properties['project_context']) {
        $state | Add-Member -NotePropertyName 'project_context' -NotePropertyValue ([pscustomobject]@{
            source_of_truth_url=[string](Get-OptionalPropertyValue $profile 'source_of_truth_url' '')
            strict_correlation=$false
        })
    } else {
        if (-not $state.project_context.PSObject.Properties['source_of_truth_url']) {
            $state.project_context | Add-Member -NotePropertyName 'source_of_truth_url' -NotePropertyValue ([string](Get-OptionalPropertyValue $profile 'source_of_truth_url' ''))
        } else {
            $state.project_context.source_of_truth_url = [string](Get-OptionalPropertyValue $profile 'source_of_truth_url' '')
        }
        if (-not $state.project_context.PSObject.Properties['strict_correlation']) {
            $state.project_context | Add-Member -NotePropertyName 'strict_correlation' -NotePropertyValue $false
        } else {
            $state.project_context.strict_correlation = $false
        }
    }
    $state.project_context_bootstrap = New-ProjectContextBootstrap $nextGeneration
    $state.project_progress = [pscustomobject]@{
        known=$false
        completed_tasks=0
        total_tasks=0
        percent=$null
        updated_at=$null
        source=$null
    }

    foreach ($roleName in @('planner','executor')) {
        $role = Get-OptionalPropertyValue $state $roleName $null
        if (-not $role) {
            $target = if ($roleName -eq 'planner') {
                [string](Get-OptionalPropertyValue $profile 'planner_url' '')
            } else {
                [string](Get-OptionalPropertyValue $profile 'executor_url' '')
            }
            $state | Add-Member -NotePropertyName $roleName -NotePropertyValue ([pscustomobject]@{
                target=$target
                target_revision=1
                last_seen_assistant_turn_id=$null
            })
            $role = Get-OptionalPropertyValue $state $roleName $null
        }
        $role.target = if ($roleName -eq 'planner') {
            [string](Get-OptionalPropertyValue $profile 'planner_url' '')
        } else {
            [string](Get-OptionalPropertyValue $profile 'executor_url' '')
        }
        if (-not $role.PSObject.Properties['target_revision']) {
            $role | Add-Member -NotePropertyName 'target_revision' -NotePropertyValue 1
        }
        $role.last_seen_assistant_turn_id = $null
        if ($role.PSObject.Properties['previous_target']) {
            $role.previous_target = $null
        }
    }

    $state.active_task_id = $null
    $state.assignment = $null
    $state.result = $null
    $state.decision = $null
    $state.last_completed = $null
    $state.identity_history = [pscustomobject]@{
        assignment_ids=@()
        result_ids=@()
    }
    $state.automation = [pscustomobject]@{
        status='RUNNING'
        reason=$null
        updated_at=[DateTimeOffset]::UtcNow.ToString('o')
    }

    $profile.project_generation = $nextGeneration
    Write-JsonAtomic $stateFile $state
    Write-JsonAtomic $plannerExecutorStateFile $state
    Write-JsonAtomic $plannerExecutorProjectsFile $registry
    Remove-Item $plannerExecutorStatusFile -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $root 'planner-executor-startup-failure.json') -Force -ErrorAction SilentlyContinue

    return [pscustomobject]@{
        ProjectId=$activeId
        ProjectGeneration=$nextGeneration
    }
}

function Switch-PlannerExecutorProject([string]$ProjectId) {
    Assert-SafeProjectMutation
    $id = Assert-ProjectId $ProjectId
    $registry = Ensure-PlannerExecutorProjectProfiles
    $currentActiveId = [string](Get-OptionalPropertyValue $registry 'active_project_id' '')

    if ($currentActiveId -eq $id) {
        $current = Read-JsonFile $plannerExecutorStateFile
        if (-not $current) { throw "Không tìm thấy active state cho project: $id" }
        return $current
    }

    # Park the current project exactly as-is, including any unresolved
    # assignment/result and send-recovery metadata.
    $registry = Save-ActiveProjectSnapshot
    $profile = Get-PlannerExecutorProjectProfile $registry $id
    if (-not $profile) { throw "Không tìm thấy project profile: $id" }
    $stateFile = [string](Get-OptionalPropertyValue $profile 'state_file' '')
    if (-not $stateFile) { $stateFile = Get-ProjectProfileStatePath $id }
    $state = Read-JsonFile $stateFile
    if (-not $state) { throw "Không tìm thấy state snapshot cho project: $id" }

    if (-not $state.PSObject.Properties['project_generation']) {
        $state | Add-Member -NotePropertyName 'project_generation' -NotePropertyValue 1
    }
    if (-not $state.PSObject.Properties['project_context']) {
        $state | Add-Member -NotePropertyName 'project_context' -NotePropertyValue ([pscustomobject]@{
            source_of_truth_url=[string]$profile.source_of_truth_url
            strict_correlation=$false
        })
    }
    $state.project_context.source_of_truth_url = [string]$profile.source_of_truth_url

    # Switching active projects is not a project reset. Preserve generation,
    # bootstrap state, last-seen turn IDs, task, assignment/result, progress,
    # identity history, and exact-once send metadata.
    $state.automation = [pscustomobject]@{
        status='RUNNING'
        reason=$null
        updated_at=[DateTimeOffset]::UtcNow.ToString('o')
    }

    Write-JsonAtomic $stateFile $state
    Write-JsonAtomic $plannerExecutorStateFile $state
    Remove-Item $plannerExecutorStatusFile -Force -ErrorAction SilentlyContinue
    $registry.active_project_id = $id
    $profile.project_generation = [int]$state.project_generation
    Write-JsonAtomic $plannerExecutorProjectsFile $registry
    return $state
}

function Show-SingleConversationControlPanel {
    [Windows.Forms.Application]::EnableVisualStyles()

    $watchdogStatusFile = Join-Path $root 'local-watchdog-status.json'

    $form = New-Object Windows.Forms.Form
    $form.Text = 'MAGASIN SUPERVISOR — TRUNG TÂM ĐIỀU KHIỂN'
    $form.StartPosition = 'CenterScreen'
    $form.Size = New-Object Drawing.Size(980, 850)
    $form.MinimumSize = New-Object Drawing.Size(900, 800)
    $form.AutoScaleMode = [Windows.Forms.AutoScaleMode]::Dpi
    $form.BackColor = [Drawing.Color]::FromArgb(241,245,249)
    $form.Font = New-Object Drawing.Font('Segoe UI', 9)

    $hero = New-Object Windows.Forms.Panel
    $hero.Location = New-Object Drawing.Point(20, 18)
    $hero.Size = New-Object Drawing.Size(920, 104)
    $hero.BackColor = [Drawing.Color]::FromArgb(15,23,42)
    $form.Controls.Add($hero)

    $title = New-Object Windows.Forms.Label
    $title.Text = 'MAGASIN SUPERVISOR'
    $title.Location = New-Object Drawing.Point(22, 14)
    $title.Size = New-Object Drawing.Size(520, 42)
    $title.Font = New-Object Drawing.Font('Segoe UI Semibold', 23)
    $title.ForeColor = [Drawing.Color]::White
    $hero.Controls.Add($title)

    $subtitle = New-Object Windows.Forms.Label
    $subtitle.Text = '1 CUỘC CHAT  •  CHAT CÓ THỂ THAY THẾ  •  SOURCE OF TRUTH LÀ BỘ NHỚ CHÍNH'
    $subtitle.Location = New-Object Drawing.Point(25, 62)
    $subtitle.Size = New-Object Drawing.Size(690, 24)
    $subtitle.ForeColor = [Drawing.Color]::FromArgb(203,213,225)
    $hero.Controls.Add($subtitle)

    $modeBadge = New-Object Windows.Forms.Label
    $modeBadge.Text = 'SINGLE_CONVERSATION_V1'
    $modeBadge.Location = New-Object Drawing.Point(700, 25)
    $modeBadge.Size = New-Object Drawing.Size(195, 32)
    $modeBadge.TextAlign = 'MiddleCenter'
    $modeBadge.BackColor = [Drawing.Color]::FromArgb(30,41,59)
    $modeBadge.ForeColor = [Drawing.Color]::FromArgb(226,232,240)
    $hero.Controls.Add($modeBadge)

    $control = New-Object Windows.Forms.Panel
    $control.Location = New-Object Drawing.Point(20, 140)
    $control.Size = New-Object Drawing.Size(920, 178)
    $control.BackColor = [Drawing.Color]::White
    $control.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
    $form.Controls.Add($control)

    $sourceLabel = New-Object Windows.Forms.Label
    $sourceLabel.Text = 'SOURCE OF TRUTH — NGUỒN DỮ LIỆU CHÍNH'
    $sourceLabel.Location = New-Object Drawing.Point(20, 22)
    $sourceLabel.Size = New-Object Drawing.Size(330, 24)
    $sourceLabel.Font = New-Object Drawing.Font('Segoe UI Semibold', 10)
    $control.Controls.Add($sourceLabel)

    $sourceBox = New-Object Windows.Forms.TextBox
    $sourceBox.Location = New-Object Drawing.Point(20, 52)
    $sourceBox.Size = New-Object Drawing.Size(875, 28)
    $control.Controls.Add($sourceBox)

    $startButton = New-Object Windows.Forms.Button
    $startButton.Location = New-Object Drawing.Point(20, 104)
    $startButton.Size = New-Object Drawing.Size(180, 44)
    $startButton.Text = '▶  KHỞI ĐỘNG ROBOT'
    $startButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $startButton.BackColor = [Drawing.Color]::FromArgb(22,163,74)
    $startButton.ForeColor = [Drawing.Color]::White
    $startButton.FlatAppearance.BorderSize = 0
    $control.Controls.Add($startButton)

    $stopButton = New-Object Windows.Forms.Button
    $stopButton.Location = New-Object Drawing.Point(215, 104)
    $stopButton.Size = New-Object Drawing.Size(180, 44)
    $stopButton.Text = '■  DỪNG ROBOT'
    $stopButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $stopButton.BackColor = [Drawing.Color]::FromArgb(185,28,28)
    $stopButton.ForeColor = [Drawing.Color]::White
    $stopButton.FlatAppearance.BorderSize = 0
    $control.Controls.Add($stopButton)

    $startMeaning = New-Object Windows.Forms.Label
    $startMeaning.Location = New-Object Drawing.Point(420, 98)
    $startMeaning.Size = New-Object Drawing.Size(470, 58)
    $startMeaning.ForeColor = [Drawing.Color]::FromArgb(71,85,105)
    $startMeaning.Text = 'KHỞI ĐỘNG = Robot tự tạo hoặc phục hồi phiên làm việc từ Source of Truth. Owner không cần cung cấp link cuộc chat.'
    $control.Controls.Add($startMeaning)

    $diagnostics = New-Object Windows.Forms.Panel
    $diagnostics.Location = New-Object Drawing.Point(20, 338)
    $diagnostics.Size = New-Object Drawing.Size(920, 420)
    $diagnostics.BackColor = [Drawing.Color]::White
    $diagnostics.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
    $form.Controls.Add($diagnostics)

    $diagTitle = New-Object Windows.Forms.Label
    $diagTitle.Text = 'TRẠNG THÁI ROBOT — CẬP NHẬT MỖI 1 GIÂY'
    $diagTitle.Location = New-Object Drawing.Point(20, 18)
    $diagTitle.Size = New-Object Drawing.Size(430, 24)
    $diagTitle.Font = New-Object Drawing.Font('Segoe UI Semibold', 10)
    $diagnostics.Controls.Add($diagTitle)

    $runtimeValue = New-Object Windows.Forms.Label
    $runtimeValue.Location = New-Object Drawing.Point(20, 50)
    $runtimeValue.Size = New-Object Drawing.Size(875, 26)
    $runtimeValue.Font = New-Object Drawing.Font('Segoe UI Semibold', 9)
    $diagnostics.Controls.Add($runtimeValue)

    $flowValue = New-Object Windows.Forms.Label
    $flowValue.Location = New-Object Drawing.Point(20, 82)
    $flowValue.Size = New-Object Drawing.Size(875, 26)
    $flowValue.Font = New-Object Drawing.Font('Segoe UI Semibold', 9)
    $diagnostics.Controls.Add($flowValue)

    $automationValue = New-Object Windows.Forms.Label
    $automationValue.Location = New-Object Drawing.Point(20, 114)
    $automationValue.Size = New-Object Drawing.Size(875, 26)
    $diagnostics.Controls.Add($automationValue)

    $conversationValue = New-Object Windows.Forms.Label
    $conversationValue.Location = New-Object Drawing.Point(20, 146)
    $conversationValue.Size = New-Object Drawing.Size(875, 26)
    $diagnostics.Controls.Add($conversationValue)

    $timerValue = New-Object Windows.Forms.Label
    $timerValue.Location = New-Object Drawing.Point(20, 178)
    $timerValue.Size = New-Object Drawing.Size(875, 26)
    $timerValue.ForeColor = [Drawing.Color]::FromArgb(30,64,175)
    $diagnostics.Controls.Add($timerValue)

    $milestoneValue = New-Object Windows.Forms.Label
    $milestoneValue.Location = New-Object Drawing.Point(20, 210)
    $milestoneValue.Size = New-Object Drawing.Size(875, 46)
    $milestoneValue.BackColor = [Drawing.Color]::FromArgb(248,250,252)
    $milestoneValue.ForeColor = [Drawing.Color]::FromArgb(71,85,105)
    $diagnostics.Controls.Add($milestoneValue)

    $errorValue = New-Object Windows.Forms.Label
    $errorValue.Location = New-Object Drawing.Point(20, 264)
    $errorValue.Size = New-Object Drawing.Size(875, 48)
    $errorValue.ForeColor = [Drawing.Color]::FromArgb(185,28,28)
    $diagnostics.Controls.Add($errorValue)

    $actionValue = New-Object Windows.Forms.Label
    $actionValue.Location = New-Object Drawing.Point(20, 318)
    $actionValue.Size = New-Object Drawing.Size(875, 44)
    $actionValue.ForeColor = [Drawing.Color]::FromArgb(71,85,105)
    $diagnostics.Controls.Add($actionValue)

    $syncValue = New-Object Windows.Forms.Label
    $syncValue.Location = New-Object Drawing.Point(20, 370)
    $syncValue.Size = New-Object Drawing.Size(875, 28)
    $syncValue.ForeColor = [Drawing.Color]::FromArgb(71,85,105)
    $diagnostics.Controls.Add($syncValue)

    function Read-SingleConversationControl {
        return Read-JsonFile $singleConversationControlFile
    }

    function Write-SingleConversationControl([string]$SourceUrl) {
        $source = ConvertTo-CanonicalSourceOfTruthUrl $SourceUrl
        $existing = Read-SingleConversationControl
        $previousSource = [string](Get-OptionalPropertyValue $existing 'source_of_truth_url' '')
        if ($previousSource -and $previousSource -ne $source -and (Test-Path $singleConversationStateFile)) {
            Remove-Item $singleConversationStateFile -Force -ErrorAction Stop
        }
        $controlState = [ordered]@{
            schema_version = 'single-conversation-control.v1'
            mode = 'SINGLE_CONVERSATION_V1'
            project_id = 'LIVE'
            source_of_truth_url = $source
            updated_at = [DateTimeOffset]::UtcNow.ToString('o')
        }
        Write-JsonAtomic $singleConversationControlFile $controlState
        return $source
    }

    function Format-OwnerDuration([int]$Seconds) {
        $safe = [Math]::Max(0, $Seconds)
        $span = [TimeSpan]::FromSeconds($safe)
        if ($span.TotalHours -ge 1) {
            return ('{0:00}:{1:00}:{2:00}' -f [int]$span.TotalHours, $span.Minutes, $span.Seconds)
        }
        return ('{0:00}:{1:00}' -f $span.Minutes, $span.Seconds)
    }

    function Format-OwnerClock([string]$Value) {
        if (-not $Value) { return '—' }
        try {
            $dt = [DateTimeOffset]::Parse($Value)
            $vn = [TimeZoneInfo]::ConvertTime($dt, $vietnamTimeZone)
            return $vn.ToString('HH:mm:ss')
        } catch {
            return '—'
        }
    }

    function Get-OwnerPhaseLabel([string]$Phase) {
        switch ($Phase.ToUpperInvariant()) {
            'STOPPED' { return 'R0 — Robot đang dừng' }
            'STARTING_BROWSER' { return 'R2 — Đang kết nối Chrome / phục hồi cuộc chat' }
            'SYNC_SOURCE_OF_TRUTH' { return 'R4 — Đang đọc và đồng bộ Source of Truth' }
            'NEW_CHAT' { return 'R3 — Đang tạo cuộc chat mới' }
            'REPLACE_CHAT' { return 'R3 — Cuộc chat cũ đã đầy / lỗi, Robot đang chuyển sang chat mới' }
            'SEND_BOOTSTRAP' { return 'R3 — Đang gửi yêu cầu khởi động vào ChatGPT' }
            'WAIT_RESPONSE' { return 'R10 — Đang chờ ChatGPT trả lời' }
            'CONTINUE_RESPONSE' { return 'R10 — ChatGPT còn đang trả lời, Robot đang tiếp tục phản hồi' }
            'BOOTSTRAP_RESPONSE_COMPLETE' { return 'R10 — ChatGPT đã trả lời yêu cầu khởi động' }
            'BOOTSTRAP_RECOVERY_REQUIRED' { return 'R15 — Đang phục hồi cuộc chat / bootstrap' }
            'BOOTSTRAP_FAILED' { return 'R3 — LỖI khởi động ChatGPT / bootstrap' }
            'SEND_WORK' { return 'R5–R9 — Đang chuẩn bị và gửi công việc cho ChatGPT' }
            'VERIFY_SOURCE_OF_TRUTH' { return 'R11 — Đang xác minh kết quả với Source of Truth' }
            'WAIT_TASK_RECHECK' { return 'R12 — Đang chờ công việc nền trước lần kiểm tra tiếp theo' }
            'WAIT_EXTERNAL' { return 'R12 — Đang chờ GitHub CI / công việc bên ngoài' }
            'AUTO_REPAIR' { return 'R12 — Đang tự sửa lỗi CI' }
            'TRIGGER_EXTERNAL_RUN' { return 'R12 — Đang xử lý workflow chưa tạo run' }
            'VERIFY_EXTERNAL_SUCCESS' { return 'R11 — CI đã PASS, đang xác minh và cập nhật checkpoint' }
            'NEXT_WORK' { return 'R12 — Đang chuẩn bị công việc tiếp theo' }
            'WAIT_OWNER' { return 'R13 — Cần Owner xử lý hoặc quyết định' }
            'CYCLE_FAILED' { return 'LỖI — Chu kỳ xử lý hiện tại thất bại' }
            'DONE' { return 'DONE — Dự án / chuỗi công việc đã hoàn tất' }
            default {
                if ([string]::IsNullOrWhiteSpace($Phase)) { return 'Chưa có trạng thái' }
                return ('PHA KỸ THUẬT: ' + $Phase)
            }
        }
    }

    function Get-OwnerAutomationLabel([string]$Status) {
        switch ($Status.ToUpperInvariant()) {
            'RUNNING' { return 'ĐANG HOẠT ĐỘNG' }
            'BLOCKED' { return 'ĐANG BỊ CHẶN' }
            'DONE' { return 'HOÀN TẤT' }
            'STOPPED' { return 'ĐÃ DỪNG' }
            'IDLE' { return 'ĐANG CHỜ' }
            default { return $(if ($Status) { $Status } else { 'CHƯA XÁC ĐỊNH' }) }
        }
    }

    function Get-OwnerConversationLabel([string]$Status) {
        switch ($Status.ToUpperInvariant()) {
            'NONE' { return 'chưa có cuộc chat đang hoạt động' }
            'CREATING' { return 'đang tạo cuộc chat' }
            'ACTIVE' { return 'đang hoạt động' }
            'UNUSABLE' { return 'cuộc chat không còn sử dụng được' }
            'RETIRED' { return 'cuộc chat cũ đã được thay thế' }
            default { return $(if ($Status) { $Status } else { 'chưa xác định' }) }
        }
    }

    function Get-OwnerSyncLabel([string]$Status) {
        switch ($Status.ToUpperInvariant()) {
            'NEVER' { return 'chưa đồng bộ' }
            'UNVERIFIED' { return 'chưa xác minh' }
            'SYNCING' { return 'đang đồng bộ' }
            'VERIFIED' { return 'đã xác minh' }
            'FAILED' { return 'đồng bộ thất bại' }
            default { return $(if ($Status) { $Status } else { 'chưa xác định' }) }
        }
    }

    function Get-OwnerErrorLabel([string]$Reason,[string]$Code) {
        $raw = if ($Code) { $Code } else { $Reason }
        if ([string]::IsNullOrWhiteSpace($raw)) { return 'không có lỗi được ghi nhận' }
        if ($raw -like 'OWNER_INPUT_REQUIRED*') { return ('Cần Owner xử lý: ' + $raw) }
        if ($raw -like 'TASK_RECHECK*') { return 'không phải lỗi — Robot đang chờ kiểm tra lại công việc' }
        switch ($raw.ToUpperInvariant()) {
            'AUTH_REQUIRED' { return 'ChatGPT chưa đăng nhập' }
            'CAPTCHA_REQUIRED' { return 'ChatGPT yêu cầu CAPTCHA / xác minh người dùng' }
            'ACCESS_DENIED' { return 'ChatGPT từ chối quyền truy cập' }
            'CONVERSATION_MISSING' { return 'Không tìm thấy cuộc chat đang dùng' }
            'CONVERSATION_FULL' { return 'Cuộc chat đã đầy / quá dài' }
            'CONVERSATION_FULL_IN_FLIGHT' { return 'Cuộc chat đầy giữa lúc ChatGPT đang xử lý; Robot đang chuyển chat và kiểm tra lại đúng task, không gửi lại lệnh thực thi cũ' }
            'NETWORK_ERROR' { return 'Lỗi mạng khi làm việc với ChatGPT' }
            'TRANSIENT_ERROR' { return 'ChatGPT gặp lỗi tạm thời' }
            'RESPONSE_TIMEOUT' { return 'Chờ ChatGPT quá thời gian cho phép' }
            'BOOTSTRAP_FAILED' { return 'Khởi động ChatGPT / bootstrap thất bại' }
            'CDP_RECOVERY_REQUIRED' { return 'Kết nối điều khiển Chrome/CDP cần phục hồi' }
            'COMPOSER_NOT_READY' { return 'Ô nhập ChatGPT chưa sẵn sàng' }
            'SEND_NOT_ACTUATED' { return 'Robot chưa thực hiện được thao tác gửi' }
            'TASK_PROTOCOL_INVALID' { return 'Phản hồi điều khiển task không đúng định dạng' }
            'POST_SEND_CONFIRMATION_PENDING' { return 'Không phải lỗi — Robot đã gửi và đang chờ xác nhận phản hồi tương ứng' }
            default { return $raw }
        }
    }

    function Get-OwnerActionLabel(
        [bool]$WrapperAlive,
        [string]$Phase,
        [string]$Reason,
        [string]$Code
    ) {
        $raw = if ($Code) { $Code } else { $Reason }
        if ($raw -like 'OWNER_INPUT_REQUIRED:EXTERNAL_REPAIR_LIMIT*') {
            return 'Robot đã dùng hết số lần tự sửa cho cùng một lỗi CI. Owner xem các run/commit được liệt kê trên bảng, xử lý nguyên nhân còn lại hoặc quyết định hướng tiếp theo rồi KHỞI ĐỘNG ROBOT.'
        }
        if ($raw -like 'OWNER_INPUT_REQUIRED*') {
            return 'Owner cần xử lý quyết định / điều kiện được ghi ở dòng lỗi, sau đó Robot mới có thể tiếp tục.'
        }
        switch ([string]$raw) {
            'AUTH_REQUIRED' { return 'Mở Chrome MAGASIN và đăng nhập ChatGPT, sau đó bấm KHỞI ĐỘNG ROBOT.' }
            'CAPTCHA_REQUIRED' { return 'Mở Chrome MAGASIN, hoàn thành CAPTCHA / xác minh, sau đó bấm KHỞI ĐỘNG ROBOT.' }
            'ACCESS_DENIED' { return 'Kiểm tra quyền truy cập ChatGPT trên Chrome MAGASIN. Không cần sửa task dự án.' }
        }
        if ($Phase -eq 'WAIT_TASK_RECHECK' -or $Phase -eq 'WAIT_EXTERNAL') {
            return 'Không cần thao tác. Robot sẽ tự kiểm tra lại khi bộ đếm về 00:00.'
        }
        if ($Phase -eq 'AUTO_REPAIR' -or $Phase -eq 'TRIGGER_EXTERNAL_RUN' -or $Phase -eq 'VERIFY_EXTERNAL_SUCCESS') {
            return 'Không cần thao tác. Robot đang tự xử lý CI của đúng task hiện tại.'
        }
        if ($Phase -eq 'WAIT_RESPONSE') {
            return 'Không cần thao tác. Robot đang chờ ChatGPT và watchdog vẫn giám sát.'
        }
        if ($Phase -eq 'REPLACE_CHAT') {
            return 'Không cần thao tác. Robot đang tự chuyển sang cuộc chat mới, đọc lại Source of Truth và kiểm tra tiếp đúng task hiện tại.'
        }
        if (-not $WrapperAlive -and ($Phase -eq 'BOOTSTRAP_FAILED' -or $raw)) {
            return 'Đây là lỗi kỹ thuật của Robot / Chrome / ChatGPT bootstrap. Không sửa task dự án; dùng mã lỗi ở trên để sửa đúng bước rồi chạy lại.'
        }
        if (-not $WrapperAlive) {
            return 'Robot hiện đã dừng. Bấm KHỞI ĐỘNG ROBOT khi muốn tiếp tục.'
        }
        return 'Không cần thao tác. Robot đang hoạt động.'
    }

    function Refresh-SingleConversationUi {
        $truth = Get-LifecycleProcessTruth -Root $root
        $ownerStop = Get-LifecycleOwnerStopState -Root $root
        $controlState = Read-SingleConversationControl
        $state = Read-JsonFile $singleConversationStateFile
        $watchdog = Read-JsonFile $watchdogStatusFile

        if (-not $sourceBox.Focused) {
            $configuredSource = [string](Get-OptionalPropertyValue $controlState 'source_of_truth_url' '')
            if (-not $configuredSource -and $state) {
                $configuredSource = [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'source_of_truth' $null) 'url' '')
            }
            if ($configuredSource) { $sourceBox.Text = $configuredSource }
        }

        $sourceReady = $false
        try {
            [void](ConvertTo-CanonicalSourceOfTruthUrl ($sourceBox.Text.Trim()))
            $sourceReady = $true
        } catch {}

        $robotStopped = [bool](-not $truth.wrapper_alive)
        $sourceBox.ReadOnly = -not $robotStopped
        $startButton.Enabled = [bool]($robotStopped -and $sourceReady)
        $stopButton.Enabled = [bool]($truth.wrapper_alive -or -not $ownerStop.blocked)

        $watchdogMode = [string](Get-OptionalPropertyValue $watchdog 'mode' 'UNKNOWN')
        $watchdogLabel = switch ($watchdogMode) {
            'HEALTHY' { 'BÌNH THƯỜNG' }
            'FAULT' { 'CÓ LỖI' }
            'OWNER_STOP' { 'OWNER ĐÃ DỪNG' }
            'INTERNAL_ERROR' { 'LỖI WATCHDOG' }
            default { 'CHƯA CÓ DỮ LIỆU' }
        }
        $cdpLabel = if ($truth.cdp_healthy) { 'KẾT NỐI' } else { 'MẤT KẾT NỐI' }
        $runtimeValue.Text =
            'ROBOT: ' +
            $(if ($truth.wrapper_alive) { 'ĐANG CHẠY' } else { 'ĐÃ DỪNG' }) +
            '  •  CHROME/CDP: ' + $cdpLabel +
            '  •  WATCHDOG: ' + $watchdogLabel

        $conversation = if ($state) { Get-OptionalPropertyValue $state 'conversation' $null } else { $null }
        $automation = if ($state) { Get-OptionalPropertyValue $state 'automation' $null } else { $null }
        $outbound = if ($state) { Get-OptionalPropertyValue $state 'outbound' $null } else { $null }
        $external = if ($state) { Get-OptionalPropertyValue $state 'external_work' $null } else { $null }
        $sourceState = if ($state) { Get-OptionalPropertyValue $state 'source_of_truth' $null } else { $null }
        $recovery = if ($state) { Get-OptionalPropertyValue $state 'recovery' $null } else { $null }

        $generation = if ($conversation) { [int](Get-OptionalPropertyValue $conversation 'generation' 0) } else { 0 }
        $conversationStatus = if ($conversation) { [string](Get-OptionalPropertyValue $conversation 'status' 'NONE') } else { 'NONE' }
        $automationStatus = if ($automation) { [string](Get-OptionalPropertyValue $automation 'status' 'STOPPED') } else { 'STOPPED' }
        $phase = if ($automation) { [string](Get-OptionalPropertyValue $automation 'phase' 'STOPPED') } else { 'STOPPED' }
        $reason = if ($automation) { [string](Get-OptionalPropertyValue $automation 'reason' '') } else { '' }
        $lastCode = if ($outbound) { [string](Get-OptionalPropertyValue $outbound 'last_error_code' '') } else { '' }

        $watchdogFaults = @()
        if ($watchdog) {
            $watchdogFaults = @(Get-OptionalPropertyValue $watchdog 'faults' @())
        }
        $chatFullFaults = @(
            $watchdogFaults | Where-Object {
                [string]$_ -eq 'CHATGPT_CONVERSATION_FULL'
            }
        )
        $nonRecoveryWatchdogFaults = @(
            $watchdogFaults | Where-Object {
                [string]$_ -ne 'CHATGPT_CONVERSATION_FULL'
            }
        )
        $chatRecoveryInProgress = [bool](
            $truth.wrapper_alive -and
            $chatFullFaults.Count -gt 0 -and
            $nonRecoveryWatchdogFaults.Count -eq 0 -and
            $phase -in @('STARTING_BROWSER','REPLACE_CHAT','NEW_CHAT','BOOTSTRAP_RECOVERY_REQUIRED')
        )

        if ($chatRecoveryInProgress) {
            $watchdogLabel = 'ĐANG PHỤC HỒI CHAT'
            $runtimeValue.Text =
                'ROBOT: ĐANG CHẠY' +
                '  •  CHROME/CDP: ' + $cdpLabel +
                '  •  WATCHDOG: ' + $watchdogLabel
        }

        $flowValue.Text = 'BƯỚC HIỆN TẠI: ' + (Get-OwnerPhaseLabel $phase)
        $automationValue.Text = if ($chatRecoveryInProgress) {
            'TRẠNG THÁI: ĐANG TỰ PHỤC HỒI CHAT  •  Owner không cần thao tác'
        } else {
            'TRẠNG THÁI: ' + (Get-OwnerAutomationLabel $automationStatus) +
            '  •  PHA: ' + $phase
        }
        $conversationValue.Text = "CUỘC CHAT: thế hệ=$generation  •  " + (Get-OwnerConversationLabel $conversationStatus)

        $externalDecision = if ($external) { [string](Get-OptionalPropertyValue $external 'decision' '') } else { '' }
        $externalTask = if ($external) { [string](Get-OptionalPropertyValue $external 'task_id' '') } else { '' }
        $checkpoint = if ($external) { [string](Get-OptionalPropertyValue $external 'checkpoint_id' '') } else { '' }
        $workflowName = if ($external) { [string](Get-OptionalPropertyValue $external 'workflow_name' '') } else { '' }
        $runId = if ($external) { [string](Get-OptionalPropertyValue $external 'workflow_run_id' '') } else { '' }
        $workflowStatus = if ($external) { [string](Get-OptionalPropertyValue $external 'workflow_status' '') } else { '' }
        $workflowConclusion = if ($external) { [string](Get-OptionalPropertyValue $external 'workflow_conclusion' '') } else { '' }
        $commitSha = if ($external) { [string](Get-OptionalPropertyValue $external 'commit_sha' '') } else { '' }
        $failureCount = if ($external) { [int](Get-OptionalPropertyValue $external 'failure_count' 0) } else { 0 }
        $repairAttempt = if ($external) { [int](Get-OptionalPropertyValue $external 'repair_attempt' 0) } else { 0 }
        $maxRepairAttempts = if ($external) { [int](Get-OptionalPropertyValue $external 'max_repair_attempts' 3) } else { 3 }
        $lastAction = if ($external) { [string](Get-OptionalPropertyValue $external 'last_action' '') } else { '' }
        $nextAction = if ($external) { [string](Get-OptionalPropertyValue $external 'next_action' '') } else { '' }

        $externalActive = $false
        switch ($externalDecision) {
            'WAIT_EXTERNAL' { $externalActive = ($phase -eq 'WAIT_EXTERNAL') }
            'AUTO_REPAIR' { $externalActive = ($phase -eq 'AUTO_REPAIR') }
            'TRIGGER_EXTERNAL_RUN' { $externalActive = ($phase -eq 'TRIGGER_EXTERNAL_RUN') }
            'VERIFY_EXTERNAL_SUCCESS' { $externalActive = ($phase -eq 'VERIFY_EXTERNAL_SUCCESS') }
            'BLOCKED_REPAIR_LIMIT' { $externalActive = ($phase -eq 'WAIT_OWNER') }
        }

        if ($externalActive) {
        switch ($externalDecision) {
            'WAIT_EXTERNAL' {
                $flowValue.Text = 'BƯỚC HIỆN TẠI: R12 — Đang chờ GitHub CI'
                $automationValue.Text =
                    'TRẠNG THÁI: ĐANG CHỜ GITHUB CI' +
                    $(if ($externalTask) { '  •  Task: ' + $externalTask } else { '' }) +
                    $(if ($checkpoint) { '  •  Checkpoint: ' + $checkpoint } else { '' })
            }
            'AUTO_REPAIR' {
                $flowValue.Text = 'BƯỚC HIỆN TẠI: R12 — Đang tự sửa lỗi CI'
                $automationValue.Text =
                    'TRẠNG THÁI: ĐANG TỰ SỬA LỖI CI' +
                    $(if ($externalTask) { '  •  Task: ' + $externalTask } else { '' }) +
                    $(if ($checkpoint) { '  •  Checkpoint: ' + $checkpoint } else { '' })
            }
            'TRIGGER_EXTERNAL_RUN' {
                $flowValue.Text = 'BƯỚC HIỆN TẠI: R12 — Workflow chưa tạo run, Robot đang xử lý trigger'
                $automationValue.Text =
                    'TRẠNG THÁI: ĐANG TẠO TIẾN ĐỘ THỰC TẾ' +
                    $(if ($externalTask) { '  •  Task: ' + $externalTask } else { '' }) +
                    $(if ($checkpoint) { '  •  Checkpoint: ' + $checkpoint } else { '' })
            }
            'VERIFY_EXTERNAL_SUCCESS' {
                $flowValue.Text = 'BƯỚC HIỆN TẠI: R11 — CI đã PASS, đang xác minh / cập nhật checkpoint'
                $automationValue.Text =
                    'TRẠNG THÁI: ĐANG XÁC MINH KẾT QUẢ CI' +
                    $(if ($externalTask) { '  •  Task: ' + $externalTask } else { '' }) +
                    $(if ($checkpoint) { '  •  Checkpoint: ' + $checkpoint } else { '' })
            }
            'BLOCKED_REPAIR_LIMIT' {
                $flowValue.Text = 'BƯỚC HIỆN TẠI: R13 — Đã hết số lần tự sửa CI'
                $automationValue.Text =
                    'TRẠNG THÁI: CẦN OWNER  •  Lần tự sửa: ' +
                    [string]$repairAttempt + '/' + [string]$maxRepairAttempts
            }
        }
        }

        $timerValue.Text = 'THỜI GIAN: —'
        if ($phase -eq 'REPLACE_CHAT') {
            $recoveryAtRaw = if ($recovery) {
                [string](Get-OptionalPropertyValue $recovery 'recorded_at' '')
            } else { '' }
            if ($recoveryAtRaw) {
                try {
                    $recoveryAge = [int][Math]::Max(
                        0,
                        ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($recoveryAtRaw)).TotalSeconds
                    )
                    $timerValue.Text =
                        'PHỤC HỒI CHAT: đã ' + (Format-OwnerDuration $recoveryAge) +
                        '  •  Robot đang tạo / phục hồi chat mới'
                } catch {
                    $timerValue.Text = 'PHỤC HỒI CHAT: đang tạo / phục hồi chat mới'
                }
            } else {
                $timerValue.Text = 'PHỤC HỒI CHAT: đang tạo / phục hồi chat mới'
            }
        } elseif (($phase -eq 'WAIT_TASK_RECHECK' -or $phase -eq 'WAIT_EXTERNAL') -and $automation) {
            $waitUntilRaw = [string](Get-OptionalPropertyValue $automation 'wait_until' '')
            $waitLabel = [string](Get-OptionalPropertyValue $automation 'wait_label' '')
            if ($waitUntilRaw) {
                try {
                    $remaining = [int][Math]::Ceiling(
                        ([DateTimeOffset]::Parse($waitUntilRaw) - [DateTimeOffset]::UtcNow).TotalSeconds
                    )
                    $remaining = [Math]::Max(0, $remaining)
                    $timerValue.Text =
                        'ĐẾM NGƯỢC: còn ' + (Format-OwnerDuration $remaining) +
                        $(if ($waitLabel) { '  •  ' + $waitLabel } else { '  •  Robot sẽ tự kiểm tra lại' })
                } catch {}
            }
        } elseif ($externalActive -and $externalDecision -eq 'AUTO_REPAIR') {
            $timerValue.Text =
                'CI VỪA LỖI: Run ' + $(if ($runId) { $runId } else { 'không xác định' }) +
                '  •  Kết quả: ' + $(if ($workflowConclusion) { $workflowConclusion.ToUpperInvariant() } else { 'FAILED' }) +
                '  •  Số lỗi phát hiện: ' + [string]$failureCount +
                '  •  Lần tự sửa: ' + [string]$repairAttempt + '/' + [string]$maxRepairAttempts
        } elseif ($externalActive -and $externalDecision -eq 'TRIGGER_EXTERNAL_RUN') {
            $timerValue.Text =
                'WORKFLOW: chưa tìm thấy run cho commit ' +
                $(if ($commitSha) { $commitSha.Substring(0, [Math]::Min(12, $commitSha.Length)) } else { 'chưa có' }) +
                '  •  Robot đang sửa trigger / tạo run mới'
        } elseif ($externalActive -and $externalDecision -eq 'VERIFY_EXTERNAL_SUCCESS') {
            $timerValue.Text =
                'CI PASS: Run ' + $(if ($runId) { $runId } else { 'không xác định' }) +
                '  •  Robot đang xác minh evidence và checkpoint'
        } elseif ($phase -eq 'WAIT_RESPONSE') {
            $startedRaw = if ($outbound) {
                [string](Get-OptionalPropertyValue $outbound 'response_running_at' (
                    Get-OptionalPropertyValue $outbound 'delivered_at' ''
                ))
            } else { '' }
            if (-not $startedRaw -and $automation) {
                $startedRaw = [string](Get-OptionalPropertyValue $automation 'updated_at' '')
            }
            if ($startedRaw) {
                try {
                    $elapsed = [int][Math]::Max(
                        0,
                        ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($startedRaw)).TotalSeconds
                    )
                    $timerValue.Text =
                        'THỜI GIAN: đã chờ ChatGPT ' + (Format-OwnerDuration $elapsed) +
                        '  •  Robot vẫn đang theo dõi phản hồi'
                } catch {}
            } else {
                $timerValue.Text = 'THỜI GIAN: đang chờ ChatGPT trả lời'
            }
        } elseif ($truth.wrapper_alive) {
            $timerValue.Text = 'THỜI GIAN: Robot đang hoạt động  •  bảng cập nhật mỗi 1 giây'
        }

        $timingFacts = New-Object Collections.Generic.List[string]
        $lastSentRaw = if ($outbound) {
            [string](Get-OptionalPropertyValue $outbound 'delivered_at' '')
        } else { '' }
        $responseDoneRaw = if ($outbound) {
            [string](Get-OptionalPropertyValue $outbound 'response_complete_at' '')
        } else { '' }
        $recoveryRecordedRaw = if ($recovery) {
            [string](Get-OptionalPropertyValue $recovery 'recorded_at' '')
        } else { '' }
        $rehydratedRaw = if ($recovery) {
            [string](Get-OptionalPropertyValue $recovery 'rehydrated_at' '')
        } else { '' }

        if ($lastSentRaw) {
            $timingFacts.Add('Gửi ' + (Format-OwnerClock $lastSentRaw))
        }
        if ($responseDoneRaw) {
            $timingFacts.Add('Trả lời xong ' + (Format-OwnerClock $responseDoneRaw))
        }
        if ($recoveryRecordedRaw) {
            $recoveryReason = [string](Get-OptionalPropertyValue $recovery 'reason' '')
            if ($recoveryReason -like '*CONVERSATION_FULL*') {
                $timingFacts.Add('Chat full ' + (Format-OwnerClock $recoveryRecordedRaw))
            } else {
                $timingFacts.Add('Recovery ' + (Format-OwnerClock $recoveryRecordedRaw))
            }
        }
        if ($rehydratedRaw) {
            $timingFacts.Add('Chat mới ' + (Format-OwnerClock $rehydratedRaw))
        }
        $milestoneValue.Text = if ($timingFacts.Count -gt 0) {
            'MỐC HOẠT ĐỘNG' + [Environment]::NewLine +
            ([string]::Join('  •  ', @($timingFacts)))
        } else {
            'MỐC HOẠT ĐỘNG' + [Environment]::NewLine + 'Chưa có mốc mới trong phiên hiện tại.'
        }
        $errorText = Get-OwnerErrorLabel $reason $lastCode
        if ($chatRecoveryInProgress) {
            $errorText = 'Chat đã đầy; Robot đang tự chuyển sang chat mới và tiếp tục đúng task.'
            $watchdogFaults = @()
        }
        if ($externalActive -and $externalDecision -eq 'WAIT_EXTERNAL') {
            $errorText =
                'Không có lỗi CI hiện tại  •  Workflow: ' + $workflowName +
                '  •  Run: ' + $(if ($runId) { $runId } else { 'đang chờ tạo run' }) +
                '  •  Trạng thái CI: ' + $workflowStatus +
                $(if ($commitSha) { '  •  Commit: ' + $commitSha.Substring(0, [Math]::Min(12, $commitSha.Length)) } else { '' })
        } elseif ($externalActive -and $externalDecision -eq 'AUTO_REPAIR') {
            $errorText =
                'CI FAILED' +
                '  •  Run vừa lỗi: ' + $(if ($runId) { $runId } else { 'không xác định' }) +
                '  •  Bước hiện tại: ' + $(if ($nextAction) { $nextAction } elseif ($lastAction) { $lastAction } else { 'AUTO_REPAIR' }) +
                '  •  Lần tự sửa: ' + [string]$repairAttempt + '/' + [string]$maxRepairAttempts
        } elseif ($externalActive -and $externalDecision -eq 'TRIGGER_EXTERNAL_RUN') {
            $errorText =
                'Không tìm thấy workflow run  •  Robot đang xác định path filter / trigger / workflow state thay vì chờ PASS'
        } elseif ($externalActive -and $externalDecision -eq 'VERIFY_EXTERNAL_SUCCESS') {
            $errorText =
                'CI SUCCESS  •  Run: ' + $(if ($runId) { $runId } else { 'không xác định' }) +
                '  •  Đang VERIFY evidence trước khi tiếp tục'
        } elseif ($externalActive -and $externalDecision -eq 'BLOCKED_REPAIR_LIMIT') {
            $history = @(Get-OptionalPropertyValue $external 'history' @())
            $historyText = @()
            foreach ($item in $history) {
                $hRun = [string](Get-OptionalPropertyValue $item 'workflow_run_id' '')
                $hSha = [string](Get-OptionalPropertyValue $item 'commit_sha' '')
                if ($hRun -or $hSha) {
                    $historyText += ('run=' + $(if ($hRun) { $hRun } else { 'NONE' }) +
                        '/sha=' + $(if ($hSha) { $hSha.Substring(0, [Math]::Min(10, $hSha.Length)) } else { 'NONE' }))
                }
            }
            $errorText =
                'Đã lặp cùng lỗi CI quá giới hạn tự sửa' +
                $(if ($historyText.Count -gt 0) { '  •  Đã thử: ' + ([string]::Join(', ', $historyText)) } else { '' })
        }
        if ($watchdogFaults.Count -gt 0) {
            $errorText += '  •  Watchdog: ' + ([string]::Join(', ', @($watchdogFaults)))
        }
        if ($chatRecoveryInProgress) {
            $errorValue.ForeColor = [Drawing.Color]::FromArgb(161,98,7)
            $errorValue.Text = 'SỰ KIỆN PHỤC HỒI: ' + $errorText
            $actionValue.Text = 'OWNER CẦN LÀM GÌ: Không cần thao tác. Robot đang tự phục hồi chat.'
        } elseif ([string]::IsNullOrWhiteSpace($reason) -and [string]::IsNullOrWhiteSpace($lastCode) -and $watchdogFaults.Count -eq 0) {
            $errorValue.ForeColor = [Drawing.Color]::FromArgb(22,101,52)
            $errorValue.Text = 'SỰ KIỆN / CẢNH BÁO: Không có lỗi cần xử lý.'
            $actionValue.Text =
                'OWNER CẦN LÀM GÌ: ' +
                (Get-OwnerActionLabel ([bool]$truth.wrapper_alive) $phase $reason $lastCode)
        } else {
            $errorValue.ForeColor = [Drawing.Color]::FromArgb(185,28,28)
            $errorValue.Text = 'LỖI / CẢNH BÁO: ' + $errorText
            $actionValue.Text =
                'OWNER CẦN LÀM GÌ: ' +
                (Get-OwnerActionLabel ([bool]$truth.wrapper_alive) $phase $reason $lastCode)
        }

        $syncStatus = if ($sourceState) {
            [string](Get-OptionalPropertyValue $sourceState 'sync_status' 'UNVERIFIED')
        } else { 'UNVERIFIED' }
        $syncValue.Text =
            'SOURCE OF TRUTH: ' + (Get-OwnerSyncLabel $syncStatus) +
            '  •  Robot không lưu link chat làm bộ nhớ dự án.'
    }

    $sourceBox.Add_TextChanged({ Refresh-SingleConversationUi })

    $startButton.Add_Click({
        try {
            $source = Write-SingleConversationControl ($sourceBox.Text.Trim())
            Refresh-SingleConversationUi
            Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
                '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
                '-File',('"' + $startScript + '"'),
                '-Hidden'
            )
        } catch {
            [Windows.Forms.MessageBox]::Show(
                $_.Exception.Message,
                'KHÔNG THỂ KHỞI ĐỘNG ROBOT',
                'OK',
                'Warning'
            ) | Out-Null
        }
    })

    $stopButton.Add_Click({
        Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
            '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
            '-File',('"' + $stopScript + '"')
        )
    })

    $timer = New-Object Windows.Forms.Timer
    $timer.Interval = 1000
    $timer.Add_Tick({ Refresh-SingleConversationUi })
    $form.Add_Shown({ Refresh-SingleConversationUi })
    $form.Add_FormClosed({ $timer.Stop(); $timer.Dispose() })
    $timer.Start()
    [void]$form.ShowDialog()
}

function Show-PlannerExecutorControlPanel {
    [Windows.Forms.Application]::EnableVisualStyles()
    $form = New-Object Windows.Forms.Form
    $form.Text = 'MAGASIN SUPERVISOR — CONTROL CENTER'
    $form.StartPosition = 'CenterScreen'
    $form.Size = New-Object Drawing.Size(1040, 900)
    $form.MinimumSize = New-Object Drawing.Size(920, 760)
    $form.AutoScaleMode = [Windows.Forms.AutoScaleMode]::Dpi
    $form.BackColor = [Drawing.Color]::FromArgb(241,245,249)
    $form.Font = New-Object Drawing.Font('Segoe UI', 9)

    # Planner/Executor uses a fixed logical canvas, but the Owner may run the
    # Control Center on a shorter display or at higher Windows DPI scaling.
    # Keep the canvas intact and make the viewport scroll instead of clipping
    # the footer / lower project controls below the visible screen.
    $scrollHost = New-Object Windows.Forms.Panel
    $scrollHost.Dock = [Windows.Forms.DockStyle]::Fill
    $scrollHost.AutoScroll = $true
    $scrollHost.BackColor = $form.BackColor
    $form.Controls.Add($scrollHost)

    $content = New-Object Windows.Forms.Panel
    $content.Location = New-Object Drawing.Point(0, 0)
    $content.Size = New-Object Drawing.Size(1020, 866)
    $content.BackColor = $form.BackColor
    $scrollHost.Controls.Add($content)
    $scrollHost.AutoScrollMinSize = New-Object Drawing.Size(1020, 866)

    $hero = New-Object Windows.Forms.Panel
    $hero.Location = New-Object Drawing.Point(20, 18)
    $hero.Size = New-Object Drawing.Size(980, 104)
    $hero.BackColor = [Drawing.Color]::FromArgb(15,23,42)
    $content.Controls.Add($hero)

    $title = New-Object Windows.Forms.Label
    $title.Text = 'MAGASIN SUPERVISOR'
    $title.Location = New-Object Drawing.Point(22, 14)
    $title.Size = New-Object Drawing.Size(470, 42)
    $title.Font = New-Object Drawing.Font('Segoe UI Semibold', 23)
    $title.ForeColor = [Drawing.Color]::White
    $hero.Controls.Add($title)

    $subtitle = New-Object Windows.Forms.Label
    $subtitle.Text = 'PLANNER / EXECUTOR  •  1 ACTIVE PROJECT  •  MULTI-PROJECT PROFILES'
    $subtitle.Location = New-Object Drawing.Point(25, 61)
    $subtitle.Size = New-Object Drawing.Size(620, 24)
    $subtitle.ForeColor = [Drawing.Color]::FromArgb(203,213,225)
    $hero.Controls.Add($subtitle)

    $modeBadge = New-Object Windows.Forms.Label
    $modeBadge.Text = 'PLANNER_EXECUTOR_V1'
    $modeBadge.Location = New-Object Drawing.Point(650, 22)
    $modeBadge.Size = New-Object Drawing.Size(300, 32)
    $modeBadge.TextAlign = 'MiddleCenter'
    $modeBadge.BackColor = [Drawing.Color]::FromArgb(30,41,59)
    $modeBadge.ForeColor = [Drawing.Color]::FromArgb(226,232,240)
    $modeBadge.Font = New-Object Drawing.Font('Segoe UI Semibold', 9)
    $hero.Controls.Add($modeBadge)

    $modeNote = New-Object Windows.Forms.Label
    $modeNote.Text = 'ChatGPT Work mode: 0'
    $modeNote.Location = New-Object Drawing.Point(650, 61)
    $modeNote.Size = New-Object Drawing.Size(300, 22)
    $modeNote.TextAlign = 'MiddleCenter'
    $modeNote.ForeColor = [Drawing.Color]::FromArgb(134,239,172)
    $hero.Controls.Add($modeNote)

    $overview = New-Object Windows.Forms.Panel
    $overview.Location = New-Object Drawing.Point(20, 136)
    $overview.Size = New-Object Drawing.Size(980, 112)
    $overview.BackColor = [Drawing.Color]::White
    $overview.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
    $content.Controls.Add($overview)

    $runtimeLabel = New-Object Windows.Forms.Label
    $runtimeLabel.Location = New-Object Drawing.Point(18, 12)
    $runtimeLabel.Size = New-Object Drawing.Size(590, 28)
    $runtimeLabel.Font = New-Object Drawing.Font('Segoe UI Semibold', 11)
    $overview.Controls.Add($runtimeLabel)

    $healthLabel = New-Object Windows.Forms.Label
    $healthLabel.Location = New-Object Drawing.Point(18, 42)
    $healthLabel.Size = New-Object Drawing.Size(600, 48)
    $healthLabel.ForeColor = [Drawing.Color]::FromArgb(71,85,105)
    $overview.Controls.Add($healthLabel)

    $startButton = New-Object Windows.Forms.Button
    $startButton.Location = New-Object Drawing.Point(650, 12)
    $startButton.Size = New-Object Drawing.Size(145, 38)
    $startButton.Text = '▶  START ROBOT'
    $startButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $startButton.BackColor = [Drawing.Color]::FromArgb(22,163,74)
    $startButton.ForeColor = [Drawing.Color]::White
    $startButton.FlatAppearance.BorderSize = 0
    $overview.Controls.Add($startButton)

    $stopButton = New-Object Windows.Forms.Button
    $stopButton.Location = New-Object Drawing.Point(807, 12)
    $stopButton.Size = New-Object Drawing.Size(145, 38)
    $stopButton.Text = '■  STOP ROBOT'
    $stopButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $stopButton.BackColor = [Drawing.Color]::FromArgb(185,28,28)
    $stopButton.ForeColor = [Drawing.Color]::White
    $stopButton.FlatAppearance.BorderSize = 0
    $overview.Controls.Add($stopButton)

    $runnerButton = New-Object Windows.Forms.Button
    $runnerButton.Location = New-Object Drawing.Point(650, 61)
    $runnerButton.Size = New-Object Drawing.Size(145, 32)
    $runnerButton.Text = 'KẾT NỐI GITHUB'
    $runnerButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $overview.Controls.Add($runnerButton)

    $refreshButton = New-Object Windows.Forms.Button
    $refreshButton.Location = New-Object Drawing.Point(807, 61)
    $refreshButton.Size = New-Object Drawing.Size(145, 32)
    $refreshButton.Text = '⟳  LÀM MỚI'
    $refreshButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $overview.Controls.Add($refreshButton)

    $projectPanel = New-Object Windows.Forms.Panel
    $projectPanel.Location = New-Object Drawing.Point(20, 264)
    $projectPanel.Size = New-Object Drawing.Size(980, 470)
    $projectPanel.BackColor = [Drawing.Color]::White
    $projectPanel.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
    $content.Controls.Add($projectPanel)

    $projectTitle = New-Object Windows.Forms.Label
    $projectTitle.Text = 'SOURCE OF TRUTH / LIVE SESSION'
    $projectTitle.Location = New-Object Drawing.Point(18, 14)
    $projectTitle.Size = New-Object Drawing.Size(380, 28)
    $projectTitle.Font = New-Object Drawing.Font('Segoe UI Semibold', 13)
    $projectPanel.Controls.Add($projectTitle)

    $projectSelector = New-Object Windows.Forms.ComboBox
    $projectSelector.Location = New-Object Drawing.Point(18, 50)
    $projectSelector.Size = New-Object Drawing.Size(240, 28)
    $projectSelector.DropDownStyle = [Windows.Forms.ComboBoxStyle]::DropDown
    $projectPanel.Controls.Add($projectSelector)

    $loadProjectButton = New-Object Windows.Forms.Button
    $loadProjectButton.Location = New-Object Drawing.Point(270, 48)
    $loadProjectButton.Size = New-Object Drawing.Size(125, 32)
    $loadProjectButton.Text = 'NẠP DỰ ÁN'
    $loadProjectButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $projectPanel.Controls.Add($loadProjectButton)

    $newProjectButton = New-Object Windows.Forms.Button
    $newProjectButton.Location = New-Object Drawing.Point(405, 48)
    $newProjectButton.Size = New-Object Drawing.Size(150, 32)
    $newProjectButton.Text = 'TẠO PROFILE MỚI'
    $newProjectButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $projectPanel.Controls.Add($newProjectButton)

    $resetRobotButton = New-Object Windows.Forms.Button
    $resetRobotButton.Location = New-Object Drawing.Point(565, 48)
    $resetRobotButton.Size = New-Object Drawing.Size(150, 32)
    $resetRobotButton.Text = 'RESET ROBOT'
    $resetRobotButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $resetRobotButton.BackColor = [Drawing.Color]::FromArgb(180,83,9)
    $resetRobotButton.ForeColor = [Drawing.Color]::White
    $resetRobotButton.FlatAppearance.BorderSize = 0
    $projectPanel.Controls.Add($resetRobotButton)

    $projectNameBox = New-Object Windows.Forms.TextBox
    $projectNameBox.Location = New-Object Drawing.Point(18, 92)
    $projectNameBox.Size = New-Object Drawing.Size(377, 27)
    $projectPanel.Controls.Add($projectNameBox)

    $sourceLabel = New-Object Windows.Forms.Label
    $sourceLabel.Location = New-Object Drawing.Point(18, 132)
    $sourceLabel.Size = New-Object Drawing.Size(120, 22)
    $sourceLabel.Text = 'SOURCE OF TRUTH'
    $projectPanel.Controls.Add($sourceLabel)

    $sourceBox = New-Object Windows.Forms.TextBox
    $sourceBox.Location = New-Object Drawing.Point(140, 129)
    $sourceBox.Size = New-Object Drawing.Size(560, 27)
    $projectPanel.Controls.Add($sourceBox)

    $openSourceButton = New-Object Windows.Forms.Button
    $openSourceButton.Location = New-Object Drawing.Point(710, 126)
    $openSourceButton.Size = New-Object Drawing.Size(110, 33)
    $openSourceButton.Text = 'MỞ SOURCE'
    $openSourceButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $projectPanel.Controls.Add($openSourceButton)

    $saveProjectButton = New-Object Windows.Forms.Button
    $saveProjectButton.Location = New-Object Drawing.Point(830, 126)
    $saveProjectButton.Size = New-Object Drawing.Size(125, 33)
    $saveProjectButton.Text = 'LƯU PROFILE'
    $saveProjectButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $saveProjectButton.BackColor = [Drawing.Color]::FromArgb(37,99,235)
    $saveProjectButton.ForeColor = [Drawing.Color]::White
    $saveProjectButton.FlatAppearance.BorderSize = 0
    $projectPanel.Controls.Add($saveProjectButton)

    $progressLabel = New-Object Windows.Forms.Label
    $progressLabel.Location = New-Object Drawing.Point(18, 174)
    $progressLabel.Size = New-Object Drawing.Size(260, 22)
    $progressLabel.Text = 'TIẾN ĐỘ DỰ ÁN: CHƯA ĐỒNG BỘ'
    $progressLabel.Font = New-Object Drawing.Font('Segoe UI Semibold', 9)
    $projectPanel.Controls.Add($progressLabel)

    $progressBar = New-Object Windows.Forms.ProgressBar
    $progressBar.Location = New-Object Drawing.Point(285, 178)
    $progressBar.Size = New-Object Drawing.Size(570, 16)
    $progressBar.Minimum = 0
    $progressBar.Maximum = 100
    $progressBar.Value = 0
    $projectPanel.Controls.Add($progressBar)

    $progressPercent = New-Object Windows.Forms.Label
    $progressPercent.Location = New-Object Drawing.Point(865, 172)
    $progressPercent.Size = New-Object Drawing.Size(90, 26)
    $progressPercent.TextAlign = 'MiddleRight'
    $progressPercent.Font = New-Object Drawing.Font('Segoe UI Semibold', 10)
    $progressPercent.Text = '—'
    $projectPanel.Controls.Add($progressPercent)

    $taskValue = New-Object Windows.Forms.Label
    $taskValue.Location = New-Object Drawing.Point(18, 212)
    $taskValue.Size = New-Object Drawing.Size(560, 24)
    $projectPanel.Controls.Add($taskValue)

    $automationValue = New-Object Windows.Forms.Label
    $automationValue.Location = New-Object Drawing.Point(18, 242)
    $automationValue.Size = New-Object Drawing.Size(560, 24)
    $projectPanel.Controls.Add($automationValue)

    $phaseValue = New-Object Windows.Forms.Label
    $phaseValue.Location = New-Object Drawing.Point(18, 272)
    $phaseValue.Size = New-Object Drawing.Size(560, 24)
    $projectPanel.Controls.Add($phaseValue)

    $lastValue = New-Object Windows.Forms.Label
    $lastValue.Location = New-Object Drawing.Point(18, 302)
    $lastValue.Size = New-Object Drawing.Size(560, 45)
    $projectPanel.Controls.Add($lastValue)

    $bootstrapValue = New-Object Windows.Forms.Label
    $bootstrapValue.Location = New-Object Drawing.Point(18, 358)
    $bootstrapValue.Size = New-Object Drawing.Size(550, 58)
    $bootstrapValue.ForeColor = [Drawing.Color]::FromArgb(100,116,139)
    $projectPanel.Controls.Add($bootstrapValue)

    $plannerLinkLabel = New-Object Windows.Forms.Label
    $plannerLinkLabel.Location = New-Object Drawing.Point(590, 212)
    $plannerLinkLabel.Size = New-Object Drawing.Size(360, 22)
    $plannerLinkLabel.Text = 'LINK CHAT PLANNER'
    $projectPanel.Controls.Add($plannerLinkLabel)

    $plannerBox = New-Object Windows.Forms.TextBox
    $plannerBox.Location = New-Object Drawing.Point(590, 238)
    $plannerBox.Size = New-Object Drawing.Size(225, 27)
    $projectPanel.Controls.Add($plannerBox)

    $plannerButton = New-Object Windows.Forms.Button
    $plannerButton.Location = New-Object Drawing.Point(825, 235)
    $plannerButton.Size = New-Object Drawing.Size(130, 33)
    $plannerButton.Text = 'MỞ PLANNER'
    $projectPanel.Controls.Add($plannerButton)

    $executorLinkLabel = New-Object Windows.Forms.Label
    $executorLinkLabel.Location = New-Object Drawing.Point(590, 278)
    $executorLinkLabel.Size = New-Object Drawing.Size(360, 22)
    $executorLinkLabel.Text = 'LINK CHAT EXECUTOR'
    $projectPanel.Controls.Add($executorLinkLabel)

    $executorBox = New-Object Windows.Forms.TextBox
    $executorBox.Location = New-Object Drawing.Point(590, 304)
    $executorBox.Size = New-Object Drawing.Size(225, 27)
    $projectPanel.Controls.Add($executorBox)

    $executorButton = New-Object Windows.Forms.Button
    $executorButton.Location = New-Object Drawing.Point(825, 301)
    $executorButton.Size = New-Object Drawing.Size(130, 33)
    $executorButton.Text = 'MỞ EXECUTOR'
    $projectPanel.Controls.Add($executorButton)

    $targetNote = New-Object Windows.Forms.Label
    $targetNote.Location = New-Object Drawing.Point(590, 346)
    $targetNote.Size = New-Object Drawing.Size(365, 70)
    $targetNote.TextAlign = 'MiddleCenter'
    $targetNote.ForeColor = [Drawing.Color]::FromArgb(100,116,139)
    $targetNote.Text = 'LINK-ONLY: dán Source of Truth + 2 link ChatGPT rồi START. Không có profile/project snapshot; RESET xóa sạch dữ liệu phiên.'
    $projectPanel.Controls.Add($targetNote)

    $projectSelector.Visible = $false
    $loadProjectButton.Visible = $false
    $newProjectButton.Visible = $false
    $projectNameBox.Visible = $false
    $saveProjectButton.Visible = $false
    $resetRobotButton.Location = New-Object Drawing.Point(805, 48)
    $sourceLabel.Location = New-Object Drawing.Point(18, 62)
    $sourceBox.Location = New-Object Drawing.Point(140, 59)
    $openSourceButton.Location = New-Object Drawing.Point(710, 56)
    $targetNote.Text = 'LINK-ONLY: dán Source of Truth + 2 link ChatGPT rồi START. Không cần LƯU/NẠP profile. RESET xóa toàn bộ dữ liệu phiên; Source of Truth là authority duy nhất.'

    $profileEditor = [pscustomobject]@{
        Draft = $false
        Suppress = $false
        Dirty = $false
    }
    foreach ($profileInput in @($projectNameBox,$sourceBox,$plannerBox,$executorBox)) {
        $profileInput.Add_TextChanged({
            if (-not $profileEditor.Suppress) { $profileEditor.Dirty = $true }
        })
    }

    $footer = New-Object Windows.Forms.Panel
    $footer.Location = New-Object Drawing.Point(20, 748)
    $footer.Size = New-Object Drawing.Size(980, 94)
    $footer.BackColor = [Drawing.Color]::FromArgb(248,250,252)
    $footer.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
    $content.Controls.Add($footer)

    $diagnosticLabel = New-Object Windows.Forms.Label
    $diagnosticLabel.Location = New-Object Drawing.Point(18, 12)
    $diagnosticLabel.Size = New-Object Drawing.Size(940, 48)
    $footer.Controls.Add($diagnosticLabel)

    $updatedLabel = New-Object Windows.Forms.Label
    $updatedLabel.Location = New-Object Drawing.Point(18, 65)
    $updatedLabel.Size = New-Object Drawing.Size(940, 22)
    $footer.Controls.Add($updatedLabel)

    function Set-ProjectProfileEditor([string]$ProjectId) {
        $id = [string]$ProjectId
        if (-not $id) { return $false }
        $registry = Ensure-PlannerExecutorProjectProfiles
        $profile = Get-PlannerExecutorProjectProfile $registry $id
        if (-not $profile) { return $false }

        $profileEditor.Suppress = $true
        try {
            $projectSelector.Text = [string]$profile.project_id
            $projectNameBox.Text = [string](Get-OptionalPropertyValue $profile 'project_name' $profile.project_id)
            $sourceBox.Text = [string](Get-OptionalPropertyValue $profile 'source_of_truth_url' '')
            $plannerBox.Text = [string](Get-OptionalPropertyValue $profile 'planner_url' '')
            $executorBox.Text = [string](Get-OptionalPropertyValue $profile 'executor_url' '')
            $profileEditor.Draft = $false
            $profileEditor.Dirty = $false
        } finally {
            $profileEditor.Suppress = $false
        }
        return $true
    }

    function Prompt-NewProjectProfileId {
        $dialog = New-Object Windows.Forms.Form
        $dialog.Text = 'TẠO PROJECT PROFILE MỚI'
        $dialog.StartPosition = [Windows.Forms.FormStartPosition]::CenterParent
        $dialog.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedDialog
        $dialog.MaximizeBox = $false
        $dialog.MinimizeBox = $false
        $dialog.ShowInTaskbar = $false
        $dialog.ClientSize = New-Object Drawing.Size(430, 170)

        $label = New-Object Windows.Forms.Label
        $label.Location = New-Object Drawing.Point(18, 16)
        $label.Size = New-Object Drawing.Size(390, 24)
        $label.Text = 'PROJECT ID MỚI'
        $label.Font = New-Object Drawing.Font('Segoe UI Semibold', 10)
        $dialog.Controls.Add($label)

        $idBox = New-Object Windows.Forms.TextBox
        $idBox.Location = New-Object Drawing.Point(18, 48)
        $idBox.Size = New-Object Drawing.Size(390, 27)
        $dialog.Controls.Add($idBox)

        $hint = New-Object Windows.Forms.Label
        $hint.Location = New-Object Drawing.Point(18, 82)
        $hint.Size = New-Object Drawing.Size(390, 34)
        $hint.ForeColor = [Drawing.Color]::FromArgb(100,116,139)
        $hint.Text = 'Ví dụ: AUTH-PROD. ID này tách biệt với project đang active và không làm mất task hiện tại.'
        $dialog.Controls.Add($hint)

        $ok = New-Object Windows.Forms.Button
        $ok.Location = New-Object Drawing.Point(242, 126)
        $ok.Size = New-Object Drawing.Size(78, 30)
        $ok.Text = 'TẠO'
        $ok.DialogResult = [Windows.Forms.DialogResult]::OK
        $dialog.Controls.Add($ok)

        $cancel = New-Object Windows.Forms.Button
        $cancel.Location = New-Object Drawing.Point(330, 126)
        $cancel.Size = New-Object Drawing.Size(78, 30)
        $cancel.Text = 'HỦY'
        $cancel.DialogResult = [Windows.Forms.DialogResult]::Cancel
        $dialog.Controls.Add($cancel)

        $dialog.AcceptButton = $ok
        $dialog.CancelButton = $cancel
        $idBox.Select()

        if ($dialog.ShowDialog($form) -ne [Windows.Forms.DialogResult]::OK) {
            $dialog.Dispose()
            return $null
        }
        $value = [string]$idBox.Text.Trim()
        $dialog.Dispose()
        return $value
    }

    function Begin-NewProjectProfileDraft([string]$ProjectId = '') {
        $profileEditor.Suppress = $true
        try {
            $profileEditor.Draft = $true
            $profileEditor.Dirty = $true
            $projectSelector.SelectedIndex = -1
            $projectSelector.Text = [string]$ProjectId
            $projectNameBox.Text = ''
            $sourceBox.Text = ''
            $plannerBox.Text = ''
            $executorBox.Text = ''
        } finally {
            $profileEditor.Suppress = $false
        }
    }

    function Reload-ProjectSelector([string]$PreferredProjectId = '') {
        $registry = Ensure-PlannerExecutorProjectProfiles
        $current = if ($PreferredProjectId) { [string]$PreferredProjectId } else { [string]$projectSelector.Text }
        $projectSelector.Items.Clear()
        foreach ($profile in @($registry.profiles)) { [void]$projectSelector.Items.Add([string]$profile.project_id) }
        $active = [string](Get-OptionalPropertyValue $registry 'active_project_id' '')
        $target = if ($current) { $current } else { $active }
        if ($target) {
            $profileEditor.Suppress = $true
            try { $projectSelector.Text = $target } finally { $profileEditor.Suppress = $false }
        }
    }

    function Refresh-PlannerExecutorUi {
        $state = Read-JsonFile $plannerExecutorStateFile
        $status = Read-JsonFile $plannerExecutorStatusFile
        $ownerStop = Get-LifecycleOwnerStopState -Root $root
        $truth = Get-LifecycleProcessTruth -Root $root

        $projectId = [string](Get-OptionalPropertyValue $state 'project_id' '')
        $projectName = [string](Get-OptionalPropertyValue $state 'project_name' $projectId)
        $sourceUrl = [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'project_context' $null) 'source_of_truth_url' '')
        $plannerUrl = [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'planner' $null) 'target' '')
        $executorUrl = [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'executor' $null) 'target' '')
        $generation = [int](Get-OptionalPropertyValue $state 'project_generation' 1)

        # Link-only editor is not backed by project profiles. While the Robot is
        # running, reflect the live session targets; while stopped, preserve whatever
        # the Owner is currently typing in the three link boxes.
        $editorProjectId = 'LIVE'
        $editingActiveProfile = $true
        if ([bool]$truth.wrapper_alive) {
            $profileEditor.Suppress = $true
            try {
                if (-not $sourceBox.Focused) { $sourceBox.Text = $sourceUrl }
                if (-not $plannerBox.Focused) { $plannerBox.Text = $plannerUrl }
                if (-not $executorBox.Focused) { $executorBox.Text = $executorUrl }
            } finally {
                $profileEditor.Suppress = $false
            }
        }

        $activeTask = [string](Get-OptionalPropertyValue $state 'active_task_id' '')
        if (-not $activeTask) { $activeTask = '—' }
        $automation = Get-OptionalPropertyValue $state 'automation' $null
        $automationStatus = [string](Get-OptionalPropertyValue $automation 'status' 'UNKNOWN')
        $automationReason = [string](Get-OptionalPropertyValue $automation 'reason' '')
        $phase = [string](Get-OptionalPropertyValue $status 'phase' '—')
        if (-not $phase) { $phase='—' }

        $running = [bool]([string]$truth.runtime_mode -eq 'PLANNER_EXECUTOR_V1' -and [bool]$truth.healthy -and [bool]$truth.planner_executor_alive)
        if ($ownerStop.blocked) { $runtimeLabel.Text='ROBOT: ĐÃ DỪNG (OWNER STOP)'; $runtimeLabel.ForeColor=[Drawing.Color]::FromArgb(185,28,28) }
        elseif ($running) { $runtimeLabel.Text='ROBOT: ĐANG CHẠY — PLANNER_EXECUTOR_V1'; $runtimeLabel.ForeColor=[Drawing.Color]::FromArgb(22,163,74) }
        elseif ($truth.wrapper_alive) { $runtimeLabel.Text='ROBOT: ĐANG KHỞI ĐỘNG / TỰ KHÔI PHỤC'; $runtimeLabel.ForeColor=[Drawing.Color]::FromArgb(217,119,6) }
        else { $runtimeLabel.Text='ROBOT: CHƯA CHẠY'; $runtimeLabel.ForeColor=[Drawing.Color]::FromArgb(71,85,105) }

        $tabs = Get-OptionalPropertyValue $status 'chatgpt_tabs' $null
        $workInvocations = Get-OptionalPropertyValue $status 'chatgpt_work_mode_invocations' 0
        $startupFailure = Read-JsonFile $plannerExecutorStartupFailureFile
        $healthText = "Chrome: " + $(if ($truth.chrome_alive) {'OK'} else {'OFF'}) + "  •  CDP: " + $(if ($truth.cdp_healthy) {'OK'} else {'OFF'}) + "  •  ChatGPT tabs: " + $(if ($null -eq $tabs) {'—'} else {[string]$tabs}) + [Environment]::NewLine + "ChatGPT Work mode invocations: $workInvocations"
        if ($status -and [string](Get-OptionalPropertyValue $status 'phase' '') -match 'BOOTSTRAP_RETRY') {
            $retryPhase = [string](Get-OptionalPropertyValue $status 'phase' '')
            $retryAttempt = [int](Get-OptionalPropertyValue $status 'bootstrap_retry_attempt' 0)
            $healthText += [Environment]::NewLine + "Bootstrap: $retryPhase • retry $retryAttempt"
        } elseif ($startupFailure -and $truth.wrapper_alive -and -not $truth.planner_executor_alive) {
            $failureStage = [string](Get-OptionalPropertyValue $startupFailure 'stage' '')
            $failureName = [string](Get-OptionalPropertyValue $startupFailure 'error_name' '')
            $healthText += [Environment]::NewLine + "Startup failure: $failureStage • $failureName"
        }
        $healthLabel.Text = $healthText

        $progress = Get-OptionalPropertyValue $state 'project_progress' $null
        $known = [bool](Get-OptionalPropertyValue $progress 'known' $false)
        $completed = [int](Get-OptionalPropertyValue $progress 'completed_tasks' 0)
        $total = [int](Get-OptionalPropertyValue $progress 'total_tasks' 0)
        $percentRaw = Get-OptionalPropertyValue $progress 'percent' $null
        if ($known -and $null -ne $percentRaw) {
            $percent=[Math]::Max(0,[Math]::Min(100,[int]$percentRaw))
            $progressLabel.Text="TIẾN ĐỘ DỰ ÁN: $completed/$total TASK"
            $progressBar.Value=$percent
            $progressPercent.Text="$percent%"
        } else {
            $progressLabel.Text='TIẾN ĐỘ DỰ ÁN: ĐANG CHỜ PLANNER ĐỌC SOURCE OF TRUTH'
            $progressBar.Value=0
            $progressPercent.Text='—'
        }

        $taskValue.Text="TASK ĐANG HOẠT ĐỘNG: $activeTask"
        $automationValue.Text="AUTOMATION: $automationStatus"
        $phaseValue.Text="PHA RUNTIME: $phase"
        $lastCompleted=Get-OptionalPropertyValue $state 'last_completed' $null
        $lastTask=[string](Get-OptionalPropertyValue $lastCompleted 'task_id' '')
        $lastResult=[string](Get-OptionalPropertyValue $lastCompleted 'result_id' '')
        if ($lastTask -or $lastResult) { $lastValue.Text="HOÀN TẤT GẦN NHẤT: task=$lastTask  result=$lastResult" }
        elseif ($automationReason) { $lastValue.Text="CHI TIẾT: $automationReason" }
        else { $lastValue.Text='HOÀN TẤT GẦN NHẤT: —' }

        $bootstrap=Get-OptionalPropertyValue $state 'project_context_bootstrap' $null
        $bootstrapRequired=[bool](Get-OptionalPropertyValue $bootstrap 'required' $false)
        $bootstrapDone=[string](Get-OptionalPropertyValue $bootstrap 'completed_at' '')
        if ($bootstrapRequired -and -not $bootstrapDone) {
            $bootstrapValue.Text='LIVE SESSION • Source of Truth chưa đọc' + [Environment]::NewLine + 'Planner sẽ đọc Source of Truth, xác định pc/pt rồi giao đúng một task.'
        } else {
            $bootstrapValue.Text='LIVE SESSION • Source of Truth đã đọc' + [Environment]::NewLine + 'Tiến độ hiển thị lấy từ pc/pt do Planner đọc từ Source of Truth.'
        }

        $activePlannerReady=Test-ChatConversationUrl $plannerUrl
        $activeExecutorReady=Test-ChatConversationUrl $executorUrl
        $activeSourceReady=$false
        try { [void](ConvertTo-CanonicalSourceOfTruthUrl $sourceUrl); $activeSourceReady=$true } catch {}

        $editorPlannerReady=Test-ChatConversationUrl ($plannerBox.Text.Trim())
        $editorExecutorReady=Test-ChatConversationUrl ($executorBox.Text.Trim())
        $editorSourceReady=$false
        try { [void](ConvertTo-CanonicalSourceOfTruthUrl ($sourceBox.Text.Trim())); $editorSourceReady=$true } catch {}
        $plannerButton.Enabled=$editorPlannerReady
        $executorButton.Enabled=$editorExecutorReady
        $openSourceButton.Enabled=$editorSourceReady

        $hasTransfer=[bool]($null -ne (Get-OptionalPropertyValue $state 'assignment' $null) -or $null -ne (Get-OptionalPropertyValue $state 'result' $null))
        $robotStopped=[bool](-not $truth.wrapper_alive)
        $linkSessionReady=[bool]($editorPlannerReady -and $editorExecutorReady -and $editorSourceReady)
        $resetRobotButton.Enabled=$true
        $sourceBox.ReadOnly=-not $robotStopped
        $plannerBox.ReadOnly=-not $robotStopped
        $executorBox.ReadOnly=-not $robotStopped
        $startButton.Enabled=[bool]($robotStopped -and $linkSessionReady -and -not $running)
        $startButton.Text = '▶  START ROBOT'
        $stopButton.Enabled=[bool]($truth.wrapper_alive -or -not $ownerStop.blocked)

        $runner=Get-RunnerProcess
        if ($runner) { $runnerButton.Text='GITHUB ĐANG KẾT NỐI'; $runnerButton.ForeColor=[Drawing.Color]::FromArgb(22,163,74) }
        else { [void](Request-RunnerRecovery); $runnerButton.Text='GITHUB ĐANG TỰ KẾT NỐI'; $runnerButton.ForeColor=[Drawing.Color]::FromArgb(217,119,6) }

        $vietnamNow=[TimeZoneInfo]::ConvertTime([DateTimeOffset]::UtcNow,$vietnamTimeZone)
        $updatedLabel.Text='Đồng bộ: '+$vietnamNow.ToString('dd/MM/yyyy HH:mm:ss')+' giờ Việt Nam'
        $diagnosticLabel.Text='LINK-ONLY SESSION • Source of Truth là authority duy nhất.' + [Environment]::NewLine + 'START luôn tạo phiên runtime mới từ 3 link hiện tại; RESET xóa toàn bộ dữ liệu phiên cục bộ.'
    }

    $projectSelector.Add_SelectionChangeCommitted({
        if ($profileEditor.Suppress) { return }
        [void](Set-ProjectProfileEditor ($projectSelector.Text.Trim()))
        Refresh-PlannerExecutorUi
    })

    $newProjectButton.Add_Click({
        try {
            $newId = Prompt-NewProjectProfileId
            if ([string]::IsNullOrWhiteSpace($newId)) { return }
            $newId = Assert-ProjectId $newId
            $registry = Ensure-PlannerExecutorProjectProfiles
            if (Get-PlannerExecutorProjectProfile $registry $newId) {
                throw "Project ID '$newId' đã tồn tại. Hãy chọn profile đó trong danh sách hoặc dùng một ID khác."
            }
            Begin-NewProjectProfileDraft $newId
            Refresh-PlannerExecutorUi
            $projectNameBox.Focus()
        } catch {
            [Windows.Forms.MessageBox]::Show($_.Exception.Message,'KHÔNG THỂ TẠO PROFILE','OK','Warning')|Out-Null
        }
    })

    $resetRobotButton.Add_Click({
        try {
            $nl = [Environment]::NewLine
            $confirmText = 'RESET ROBOT sẽ STOP Robot và XÓA TOÀN BỘ dữ liệu phiên cục bộ: Source link, chat links, progress, task, assignment/result, recovery state, profile/snapshot và diagnostics.' + $nl + $nl + 'Chrome login, Supervisor app và GitHub Runner được giữ lại. Tiếp tục?'
            $confirm = [Windows.Forms.MessageBox]::Show(
                $confirmText,
                'RESET ROBOT — XÓA TOÀN BỘ PHIÊN',
                [Windows.Forms.MessageBoxButtons]::YesNo,
                [Windows.Forms.MessageBoxIcon]::Warning
            )
            if ($confirm -ne [Windows.Forms.DialogResult]::Yes) { return }

            [void](Reset-LinkOnlyPlannerExecutorSession)
            $profileEditor.Suppress = $true
            try {
                $projectSelector.Text = 'LIVE'
                $projectNameBox.Text = ''
                $sourceBox.Text = ''
                $plannerBox.Text = ''
                $executorBox.Text = ''
                $profileEditor.Draft = $false
                $profileEditor.Dirty = $false
            } finally {
                $profileEditor.Suppress = $false
            }
            Refresh-PlannerExecutorUi
            [Windows.Forms.MessageBox]::Show(
                'ĐÃ RESET ROBOT. Toàn bộ dữ liệu dự án/phiên cục bộ đã bị xóa. Dán Source of Truth + link Planner + link Executor rồi START.',
                'RESET ROBOT HOÀN TẤT',
                'OK',
                'Information'
            ) | Out-Null
        } catch {
            [Windows.Forms.MessageBox]::Show($_.Exception.Message,'RESET ROBOT THẤT BẠI','OK','Warning')|Out-Null
        }
    })

    $saveProjectButton.Add_Click({
        try {
            $requestedProjectId = $projectSelector.Text.Trim()
            if ($profileEditor.Draft) {
                $requestedProjectId = Assert-ProjectId $requestedProjectId
                $registry = Ensure-PlannerExecutorProjectProfiles
                if (Get-PlannerExecutorProjectProfile $registry $requestedProjectId) {
                    throw "Project ID '$requestedProjectId' đã tồn tại. Draft mới không được ghi đè profile hiện có."
                }
            }
            $result=Save-PlannerExecutorProjectProfile $requestedProjectId ($projectNameBox.Text.Trim()) ($sourceBox.Text.Trim()) ($plannerBox.Text.Trim()) ($executorBox.Text.Trim())
            Reload-ProjectSelector $result.ProjectId
            [void](Set-ProjectProfileEditor $result.ProjectId)
            Refresh-PlannerExecutorUi
            if ($result.Created) {
                $msg='Đã tạo project profile. Bấm NẠP DỰ ÁN khi muốn kích hoạt.'
            } elseif ($result.PlannerRollover -or $result.ExecutorRollover) {
                $msg='Đã đổi link ChatGPT nhưng GIỮ NGUYÊN project/task hiện tại. Khi START, Supervisor sẽ handoff state sang chat mới; Source of Truth và assignment/result ID không bị reset.'
            } else {
                $msg='Đã cập nhật project profile.'
            }
            [Windows.Forms.MessageBox]::Show($msg,'MAGASIN SUPERVISOR','OK','Information')|Out-Null
        } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message,'KHÔNG THỂ LƯU PROJECT','OK','Warning')|Out-Null }
    })

    $loadProjectButton.Add_Click({
        try {
            if ($profileEditor.Draft -or $profileEditor.Dirty) {
                throw 'Hãy LƯU PROFILE trước khi NẠP DỰ ÁN.'
            }
            $loadedId = $projectSelector.Text.Trim()
            [void](Switch-PlannerExecutorProject $loadedId)
            $profileEditor.Draft = $false
            Reload-ProjectSelector $loadedId
            [void](Set-ProjectProfileEditor $loadedId)
            Refresh-PlannerExecutorUi
            [Windows.Forms.MessageBox]::Show('Đã nạp project. Project trước đã được park nguyên state; START sẽ chạy project đang active.','MAGASIN SUPERVISOR','OK','Information')|Out-Null
        } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message,'KHÔNG THỂ NẠP PROJECT','OK','Warning')|Out-Null }
    })

    $openSourceButton.Add_Click({
        try { $url=ConvertTo-CanonicalSourceOfTruthUrl ($sourceBox.Text.Trim()); Start-Process $url }
        catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message,'SOURCE OF TRUTH','OK','Warning')|Out-Null }
    })

    $startButton.Add_Click({
        try {
            $source = $sourceBox.Text.Trim()
            $planner = $plannerBox.Text.Trim()
            $executor = $executorBox.Text.Trim()
            try { [void](ConvertTo-CanonicalSourceOfTruthUrl $source) } catch { throw 'Hãy dán Source of Truth hợp lệ trước khi START.' }
            if (-not (Test-ChatConversationUrl $planner) -or -not (Test-ChatConversationUrl $executor)) {
                throw 'Planner hoặc Executor chưa có ChatGPT target hợp lệ.'
            }

            # Every START is a new link-only runtime session. Nothing is loaded
            # from a project profile or an older local project snapshot.
            [void](Initialize-LinkOnlyPlannerExecutorSession $source $planner $executor)
            $profileEditor.Dirty = $false
            Refresh-PlannerExecutorUi
            Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $startScript + '"'),'-Hidden')
        } catch {
            [Windows.Forms.MessageBox]::Show($_.Exception.Message,'KHÔNG THỂ START ROBOT','OK','Warning')|Out-Null
        }
    })

    $stopButton.Add_Click({ Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $stopScript + '"')) })
    $plannerButton.Add_Click({ Open-RobotUrl ($plannerBox.Text.Trim()) })
    $executorButton.Add_Click({ Open-RobotUrl ($executorBox.Text.Trim()) })
    $runnerButton.Add_Click({ [void](Ensure-Runner) })
    $refreshButton.Add_Click({ Refresh-PlannerExecutorUi })

    $timer=New-Object Windows.Forms.Timer
    $timer.Interval=2000
    $timer.Add_Tick({ Refresh-PlannerExecutorUi })
    $form.Add_Shown({
        $state = Read-JsonFile $plannerExecutorStateFile
        $profileEditor.Suppress = $true
        try {
            $projectSelector.Text = 'LIVE'
            if ($state) {
                $stateSource = [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'project_context' $null) 'source_of_truth_url' '')
                $statePlanner = [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'planner' $null) 'target' '')
                $stateExecutor = [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'executor' $null) 'target' '')
                if ($stateSource) { $sourceBox.Text = $stateSource }
                if ($statePlanner) { $plannerBox.Text = $statePlanner }
                if ($stateExecutor) { $executorBox.Text = $stateExecutor }
            }
            $profileEditor.Dirty = $false
        } finally {
            $profileEditor.Suppress = $false
        }
        Refresh-PlannerExecutorUi
    })
    $form.Add_FormClosed({ $timer.Stop(); $timer.Dispose() })
    $timer.Start()
    [void]$form.ShowDialog()
}

# SINGLE_CONVERSATION_V1 is the default forward Control Center. Legacy
# Planner/Executor and Three-Lane panels remain available only through an
# explicit rollback environment flag.
if ([string]$env:SUPERVISOR_CONTROL_PANEL_LEGACY -ne '1') {
    Show-SingleConversationControlPanel
    exit 0
}

$plannerExecutorPanelState = Read-JsonFile $plannerExecutorStateFile
if (
    $plannerExecutorPanelState -and
    [string]$plannerExecutorPanelState.mode -eq 'PLANNER_EXECUTOR_V1'
) {
    Show-PlannerExecutorControlPanel
    exit 0
}

[Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object Windows.Forms.Form
$form.Text = 'MAGASIN SUPERVISOR — CONTROL CENTER'
$form.StartPosition = 'Manual'
$form.AutoScaleMode = [Windows.Forms.AutoScaleMode]::Dpi
$form.AutoScaleDimensions = New-Object Drawing.SizeF(96, 96)

$currentScreen = [Windows.Forms.Screen]::FromPoint([Windows.Forms.Cursor]::Position)
$viewportLayout = Get-ControlPanelViewportLayout -WorkingArea $currentScreen.WorkingArea
$form.Size = $viewportLayout.InitialSize
$form.MinimumSize = $viewportLayout.MinimumSize
$form.Location = $viewportLayout.Location
$form.BackColor = [Drawing.Color]::FromArgb(241,245,249)
$form.Font = New-Object Drawing.Font('Segoe UI', 9)

$scrollHost = New-Object Windows.Forms.Panel
$scrollHost.Dock = [Windows.Forms.DockStyle]::Fill
$scrollHost.AutoScroll = $true
$scrollHost.BackColor = $form.BackColor
$form.Controls.Add($scrollHost)

$content = New-Object Windows.Forms.Panel
$content.Location = New-Object Drawing.Point(0, 0)
$content.Size = $viewportLayout.LogicalCanvasSize
$content.BackColor = $form.BackColor
$scrollHost.Controls.Add($content)
$scrollHost.AutoScrollMinSize = $viewportLayout.LogicalCanvasSize

$heroPanel = New-Object Windows.Forms.Panel
$heroPanel.Location = New-Object Drawing.Point(20, 18)
$heroPanel.Size = New-Object Drawing.Size(1175, 104)
$heroPanel.BackColor = [Drawing.Color]::FromArgb(15,23,42)
$content.Controls.Add($heroPanel)

$title = New-Object Windows.Forms.Label
$title.Text = 'MAGASIN SUPERVISOR'
$title.Location = New-Object Drawing.Point(22, 16)
$title.Size = New-Object Drawing.Size(500, 42)
$title.Font = New-Object Drawing.Font('Segoe UI Semibold', 23)
$title.ForeColor = [Drawing.Color]::White
$heroPanel.Controls.Add($title)

$subtitle = New-Object Windows.Forms.Label
$subtitle.Text = 'CONTROL CENTER  •  3 LUỒNG ĐỘC LẬP  •  LIVE STATUS'
$subtitle.Location = New-Object Drawing.Point(25, 62)
$subtitle.Size = New-Object Drawing.Size(560, 24)
$subtitle.ForeColor = [Drawing.Color]::FromArgb(203,213,225)
$heroPanel.Controls.Add($subtitle)

$versionBadge = New-Object Windows.Forms.Label
$versionBadge.Text = 'CONTROL PANEL V2'
$versionBadge.Location = New-Object Drawing.Point(630, 22)
$versionBadge.Size = New-Object Drawing.Size(180, 28)
$versionBadge.TextAlign = 'MiddleCenter'
$versionBadge.BackColor = [Drawing.Color]::FromArgb(30,41,59)
$versionBadge.ForeColor = [Drawing.Color]::FromArgb(226,232,240)
$versionBadge.Font = New-Object Drawing.Font('Segoe UI Semibold', 9)
$heroPanel.Controls.Add($versionBadge)

$resetAllButton = New-Object Windows.Forms.Button
$resetAllButton.Location = New-Object Drawing.Point(840, 18)
$resetAllButton.Size = New-Object Drawing.Size(315, 40)
$resetAllButton.Text = '⚠  LÀM SẠCH TẤT CẢ DỰ ÁN'
$resetAllButton.BackColor = [Drawing.Color]::FromArgb(127,29,29)
$resetAllButton.ForeColor = [Drawing.Color]::White
$resetAllButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
$resetAllButton.FlatAppearance.BorderSize = 0
$resetAllButton.Add_Click({
    $first = [Windows.Forms.MessageBox]::Show(
        'Thao tác này sẽ DỪNG Robot và xóa TOÀN BỘ 3 dự án khỏi Supervisor: tên dự án, Brain/Work URL, task cũ, dispatch/relay latch, pending target, quarantine, timeline và evidence. GitHub Runner, cài đặt Robot và Chrome profile đăng nhập được giữ nguyên. Tiếp tục?',
        'LÀM SẠCH TẤT CẢ DỰ ÁN',
        [Windows.Forms.MessageBoxButtons]::YesNo,
        [Windows.Forms.MessageBoxIcon]::Warning
    )
    if ($first -ne [Windows.Forms.DialogResult]::Yes) { return }

    $second = [Windows.Forms.MessageBox]::Show(
        'XÁC NHẬN LẦN CUỐI: cả 3 luồng sẽ trở về trống và TẮT. Dự án cũ sẽ không tự chạy lại. Sau khi nhập dự án mới, bạn bật luồng rồi bấm KHỞI ĐỘNG ROBOT NỀN. Thực hiện reset?',
        'XÁC NHẬN RESET',
        [Windows.Forms.MessageBoxButtons]::YesNo,
        [Windows.Forms.MessageBoxIcon]::Warning
    )
    if ($second -ne [Windows.Forms.DialogResult]::Yes) { return }

    if (-not (Test-Path $resetAllProjectsScript)) {
        [Windows.Forms.MessageBox]::Show(
            'Không tìm thấy reset-all-projects.ps1 trong runtime đã cài.',
            'MAGASIN SUPERVISOR',
            'OK',
            'Error'
        ) | Out-Null
        return
    }

    $resetAllButton.Enabled = $false
    try {
        $resetOutput = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $resetAllProjectsScript -Confirmed 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw ('Reset thất bại: ' + (($resetOutput | Select-Object -Last 8) -join [Environment]::NewLine))
        }
        Refresh-Ui
        [Windows.Forms.MessageBox]::Show(
            'ĐÃ LÀM SẠCH 3 DỰ ÁN. Robot đang ở trạng thái an toàn: tất cả lane tắt và Owner STOP được giữ. Hãy nhập dự án mới, lưu Brain/Work, BẮT ĐẦU LUỒNG rồi KHỞI ĐỘNG ROBOT NỀN.',
            'MAGASIN SUPERVISOR',
            'OK',
            'Information'
        ) | Out-Null
    } catch {
        [Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'RESET TẤT CẢ DỰ ÁN THẤT BẠI',
            'OK',
            'Error'
        ) | Out-Null
    } finally {
        $resetAllButton.Enabled = $true
    }
})
$heroPanel.Controls.Add($resetAllButton)

$overviewPanel = New-Object Windows.Forms.Panel
$overviewPanel.Location = New-Object Drawing.Point(20, 132)
$overviewPanel.Size = New-Object Drawing.Size(1175, 98)
$overviewPanel.BackColor = [Drawing.Color]::White
$overviewPanel.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
$content.Controls.Add($overviewPanel)

$runnerButton = New-Object Windows.Forms.Button
$runnerButton.Location = New-Object Drawing.Point(16, 14)
$runnerButton.Size = New-Object Drawing.Size(218, 36)
$runnerButton.Text = 'KẾT NỐI GITHUB'
$runnerButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
$runnerButton.Add_Click({
    if (-not (Ensure-Runner)) {
        [Windows.Forms.MessageBox]::Show(
            'Không thể khởi động GitHub Runner. Mở nhật ký Runner để kiểm tra kết nối mạng.',
            'MAGASIN SUPERVISOR',
            'OK',
            'Warning'
        ) | Out-Null
    }
})
$overviewPanel.Controls.Add($runnerButton)

$lastRefreshLabel = New-Object Windows.Forms.Label
$lastRefreshLabel.Location = New-Object Drawing.Point(16, 57)
$lastRefreshLabel.Size = New-Object Drawing.Size(218, 22)
$lastRefreshLabel.TextAlign = 'MiddleLeft'
$lastRefreshLabel.ForeColor = [Drawing.Color]::FromArgb(100,116,139)
$lastRefreshLabel.Text = 'Đồng bộ: —'
$overviewPanel.Controls.Add($lastRefreshLabel)

$runtimeLabel = New-Object Windows.Forms.Label
$runtimeLabel.Location = New-Object Drawing.Point(252, 10)
$runtimeLabel.Size = New-Object Drawing.Size(590, 24)
$runtimeLabel.Font = New-Object Drawing.Font('Segoe UI Semibold', 10)
$overviewPanel.Controls.Add($runtimeLabel)

$resourceLabel = New-Object Windows.Forms.Label
$resourceLabel.Location = New-Object Drawing.Point(252, 34)
$resourceLabel.Size = New-Object Drawing.Size(590, 36)
$resourceLabel.Font = New-Object Drawing.Font('Segoe UI', 8.5)
$resourceLabel.ForeColor = [Drawing.Color]::FromArgb(71,85,105)
$overviewPanel.Controls.Add($resourceLabel)

$runtimeStartButton = New-Object Windows.Forms.Button
$runtimeStartButton.Location = New-Object Drawing.Point(864, 10)
$runtimeStartButton.Size = New-Object Drawing.Size(286, 36)
$runtimeStartButton.Text = '▶  KHỞI ĐỘNG ROBOT NỀN'
$runtimeStartButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
$runtimeStartButton.Add_Click({
    $enabledLaneCount = Get-EnabledLaneCount -Root $root
    if ($enabledLaneCount -lt 1) {
        [Windows.Forms.MessageBox]::Show(
            'Hãy bật ít nhất một luồng trước khi khởi động Robot nền.',
            'MAGASIN SUPERVISOR',
            'OK',
            'Information'
        ) | Out-Null
        return
    }

    if (-not (Test-Path $startScript)) {
        [Windows.Forms.MessageBox]::Show(
            'Không tìm thấy Supervisor runtime.',
            'MAGASIN SUPERVISOR',
            'OK',
            'Error'
        ) | Out-Null
        return
    }

    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
        '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass',
        '-File',('"' + $startScript + '"'),'-Hidden'
    )
})
$overviewPanel.Controls.Add($runtimeStartButton)

$repoButton = New-Object Windows.Forms.Button
$repoButton.Location = New-Object Drawing.Point(864, 53)
$repoButton.Size = New-Object Drawing.Size(138, 32)
$repoButton.Text = 'MỞ DỰ ÁN'
$repoButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
$repoButton.Add_Click({
    if ([string]::IsNullOrWhiteSpace($repoUrl)) {
        [Windows.Forms.MessageBox]::Show(
            'Chưa cấu hình SUPERVISOR_PROJECT_REPOSITORY_URL.',
            'MAGASIN SUPERVISOR',
            'OK',
            'Information'
        ) | Out-Null
        return
    }
    Start-Process $repoUrl
})
$overviewPanel.Controls.Add($repoButton)

$refreshButton = New-Object Windows.Forms.Button
$refreshButton.Location = New-Object Drawing.Point(1012, 53)
$refreshButton.Size = New-Object Drawing.Size(138, 32)
$refreshButton.Text = '⟳  LÀM MỚI'
$refreshButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
$refreshButton.Add_Click({ Refresh-Ui })
$overviewPanel.Controls.Add($refreshButton)

$laneUi = @{}
$cardY = @(244, 530, 816)

for ($i = 0; $i -lt 3; $i++) {
    $laneId = "lane-$($i + 1)"
    $panel = New-Object Windows.Forms.Panel
    $panel.Location = New-Object Drawing.Point(20, $cardY[$i])
    $panel.Size = New-Object Drawing.Size(1175, 272)
    $panel.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
    $panel.BackColor = [Drawing.Color]::White
    $content.Controls.Add($panel)

    $accentPanel = New-Object Windows.Forms.Panel
    $accentPanel.Location = New-Object Drawing.Point(0, 0)
    $accentPanel.Size = New-Object Drawing.Size(6, 270)
    $accentPanel.BackColor = [Drawing.Color]::FromArgb(226,232,240)
    $panel.Controls.Add($accentPanel)

    $laneTitle = New-Object Windows.Forms.Label
    $laneTitle.Text = "LUỒNG $($i + 1)"
    $laneTitle.Location = New-Object Drawing.Point(18, 12)
    $laneTitle.Size = New-Object Drawing.Size(105, 28)
    $laneTitle.Font = New-Object Drawing.Font('Segoe UI Semibold', 13)
    $panel.Controls.Add($laneTitle)

    $projectLabel = New-Object Windows.Forms.Label
    $projectLabel.Text = 'DỰ ÁN'
    $projectLabel.Location = New-Object Drawing.Point(130, 17)
    $projectLabel.Size = New-Object Drawing.Size(70, 22)
    $projectLabel.ForeColor = [Drawing.Color]::FromArgb(71,85,105)
    $panel.Controls.Add($projectLabel)

    $projectBox = New-Object Windows.Forms.TextBox
    $projectBox.Location = New-Object Drawing.Point(200, 13)
    $projectBox.Size = New-Object Drawing.Size(480, 27)
    $projectBox.Font = New-Object Drawing.Font('Segoe UI Semibold', 9.5)
    $panel.Controls.Add($projectBox)

    $statusValue = New-Object Windows.Forms.Label
    $statusValue.Location = New-Object Drawing.Point(915, 10)
    $statusValue.Size = New-Object Drawing.Size(230, 34)
    $statusValue.Font = New-Object Drawing.Font('Segoe UI Semibold', 10)
    $statusValue.TextAlign = 'MiddleCenter'
    $statusValue.BackColor = [Drawing.Color]::FromArgb(248,250,252)
    $statusValue.ForeColor = [Drawing.Color]::FromArgb(51,65,85)
    $panel.Controls.Add($statusValue)

    $brainLabel = New-Object Windows.Forms.Label
    $brainLabel.Text = 'LINK BỘ NÃO'
    $brainLabel.Location = New-Object Drawing.Point(18, 59)
    $brainLabel.Size = New-Object Drawing.Size(100, 24)
    $brainLabel.ForeColor = [Drawing.Color]::FromArgb(71,85,105)
    $panel.Controls.Add($brainLabel)

    $brainBox = New-Object Windows.Forms.TextBox
    $brainBox.Location = New-Object Drawing.Point(118, 56)
    $brainBox.Size = New-Object Drawing.Size(642, 27)
    $panel.Controls.Add($brainBox)

    $openBrain = New-Object Windows.Forms.Button
    $openBrain.Text = 'MỞ BỘ NÃO'
    $openBrain.Location = New-Object Drawing.Point(775, 53)
    $openBrain.Size = New-Object Drawing.Size(110, 34)
    $openBrain.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $panel.Controls.Add($openBrain)

    $saveBrain = New-Object Windows.Forms.Button
    $saveBrain.Text = 'LƯU BỘ NÃO'
    $saveBrain.Location = New-Object Drawing.Point(895, 53)
    $saveBrain.Size = New-Object Drawing.Size(120, 34)
    $saveBrain.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $panel.Controls.Add($saveBrain)

    $workLabel = New-Object Windows.Forms.Label
    $workLabel.Text = 'LINK WORK'
    $workLabel.Location = New-Object Drawing.Point(18, 101)
    $workLabel.Size = New-Object Drawing.Size(100, 24)
    $workLabel.ForeColor = [Drawing.Color]::FromArgb(71,85,105)
    $panel.Controls.Add($workLabel)

    $workBox = New-Object Windows.Forms.TextBox
    $workBox.Location = New-Object Drawing.Point(118, 98)
    $workBox.Size = New-Object Drawing.Size(517, 27)
    $workBox.ReadOnly = $false
    $workBox.BackColor = [Drawing.Color]::White
    $panel.Controls.Add($workBox)

    $openWork = New-Object Windows.Forms.Button
    $openWork.Text = 'MỞ WORK'
    $openWork.Location = New-Object Drawing.Point(650, 95)
    $openWork.Size = New-Object Drawing.Size(110, 34)
    $openWork.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $panel.Controls.Add($openWork)

    $saveWork = New-Object Windows.Forms.Button
    $saveWork.Text = 'LƯU WORK'
    $saveWork.Location = New-Object Drawing.Point(770, 95)
    $saveWork.Size = New-Object Drawing.Size(110, 34)
    $saveWork.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $panel.Controls.Add($saveWork)

    $resetWork = New-Object Windows.Forms.Button
    $resetWork.Text = 'TỰ TẠO WORK'
    $resetWork.Location = New-Object Drawing.Point(890, 95)
    $resetWork.Size = New-Object Drawing.Size(125, 34)
    $resetWork.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $panel.Controls.Add($resetWork)

    $summaryPanel = New-Object Windows.Forms.Panel
    $summaryPanel.Location = New-Object Drawing.Point(18, 136)
    $summaryPanel.Size = New-Object Drawing.Size(850, 126)
    $summaryPanel.BackColor = [Drawing.Color]::FromArgb(248,250,252)
    $summaryPanel.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
    $panel.Controls.Add($summaryPanel)

    $executionValue = New-Object Windows.Forms.Label
    $executionValue.Location = New-Object Drawing.Point(10, 7)
    $executionValue.Size = New-Object Drawing.Size(828, 22)
    $executionValue.Font = New-Object Drawing.Font('Segoe UI Semibold', 9)
    $executionValue.AutoEllipsis = $true
    $summaryPanel.Controls.Add($executionValue)

    $progressValue = New-Object Windows.Forms.Label
    $progressValue.Location = New-Object Drawing.Point(10, 30)
    $progressValue.Size = New-Object Drawing.Size(250, 20)
    $progressValue.Font = New-Object Drawing.Font('Segoe UI Semibold', 8.5)
    $progressValue.ForeColor = [Drawing.Color]::FromArgb(51,65,85)
    $progressValue.Text = 'TIẾN ĐỘ DỰ ÁN: CHƯA CÓ KẾ HOẠCH'
    $summaryPanel.Controls.Add($progressValue)

    $progressBar = New-Object Windows.Forms.ProgressBar
    $progressBar.Location = New-Object Drawing.Point(270, 33)
    $progressBar.Size = New-Object Drawing.Size(455, 15)
    $progressBar.Minimum = 0
    $progressBar.Maximum = 100
    $progressBar.Value = 0
    $summaryPanel.Controls.Add($progressBar)

    $progressPercent = New-Object Windows.Forms.Label
    $progressPercent.Location = New-Object Drawing.Point(735, 29)
    $progressPercent.Size = New-Object Drawing.Size(100, 22)
    $progressPercent.TextAlign = 'MiddleRight'
    $progressPercent.Font = New-Object Drawing.Font('Segoe UI Semibold', 9)
    $progressPercent.Text = '—'
    $summaryPanel.Controls.Add($progressPercent)

    $healthValue = New-Object Windows.Forms.Label
    $healthValue.Location = New-Object Drawing.Point(10, 53)
    $healthValue.Size = New-Object Drawing.Size(828, 30)
    $healthValue.Font = New-Object Drawing.Font('Segoe UI', 8.5)
    $healthValue.ForeColor = [Drawing.Color]::FromArgb(71,85,105)
    $summaryPanel.Controls.Add($healthValue)

    $updatedValue = New-Object Windows.Forms.Label
    $updatedValue.Location = New-Object Drawing.Point(10, 83)
    $updatedValue.Size = New-Object Drawing.Size(828, 18)
    $updatedValue.ForeColor = [Drawing.Color]::FromArgb(100,116,139)
    $summaryPanel.Controls.Add($updatedValue)

    $messageValue = New-Object Windows.Forms.Label
    $messageValue.Location = New-Object Drawing.Point(10, 101)
    $messageValue.Size = New-Object Drawing.Size(828, 21)
    $messageValue.AutoEllipsis = $true
    $summaryPanel.Controls.Add($messageValue)

    $retryRelayButton = New-Object Windows.Forms.Button
    $retryRelayButton.Text = 'THỬ LẠI RELAY'
    $retryRelayButton.Location = New-Object Drawing.Point(885, 140)
    $retryRelayButton.Size = New-Object Drawing.Size(260, 34)
    $retryRelayButton.Enabled = $false
    $retryRelayButton.Visible = $false
    $retryRelayButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $panel.Controls.Add($retryRelayButton)

    $startButton = New-Object Windows.Forms.Button
    $startButton.Text = '▶  BẮT ĐẦU LUỒNG'
    $startButton.Location = New-Object Drawing.Point(885, 182)
    $startButton.Size = New-Object Drawing.Size(260, 36)
    $startButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $panel.Controls.Add($startButton)

    $stopButton = New-Object Windows.Forms.Button
    $stopButton.Text = '■  DỪNG LUỒNG'
    $stopButton.Location = New-Object Drawing.Point(885, 226)
    $stopButton.Size = New-Object Drawing.Size(260, 32)
    $stopButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $panel.Controls.Add($stopButton)

    $laneUi[$laneId] = [pscustomobject]@{
        Panel = $panel
        Accent = $accentPanel
        Project = $projectBox
        Brain = $brainBox
        Work = $workBox
        Status = $statusValue
        Execution = $executionValue
        Progress = $progressValue
        ProgressBar = $progressBar
        ProgressPercent = $progressPercent
        Health = $healthValue
        Message = $messageValue
        Updated = $updatedValue
        Start = $startButton
        Stop = $stopButton
        OpenBrain = $openBrain
        SaveBrain = $saveBrain
        OpenWork = $openWork
        SaveWork = $saveWork
        ResetWork = $resetWork
        RetryRelay = $retryRelayButton
    }

    $currentLaneId = $laneId
    $startButton.Add_Click({
        $id = $this.Tag
        $ui = $laneUi[$id]
        $brainUrl = $ui.Brain.Text.Trim()
        if (-not (Test-ChatConversationUrl $brainUrl)) {
            [Windows.Forms.MessageBox]::Show(
                'Hãy dán đúng link cuộc trò chuyện ChatGPT dùng làm BỘ NÃO cho luồng này.',
                'MAGASIN SUPERVISOR',
                'OK',
                'Warning'
            ) | Out-Null
            return
        }
        # Lane START changes only Owner lane intent: disabled -> enabled.
        # Process recovery is a separate lifecycle concern handled by Refresh-Ui.
        Save-Lane $id $ui.Project.Text $brainUrl $true
    })
    $startButton.Tag = $currentLaneId

    $stopButton.Add_Click({
        $id = $this.Tag
        $ui = $laneUi[$id]
        Save-Lane $id $ui.Project.Text $ui.Brain.Text $false
    })
    $stopButton.Tag = $currentLaneId

    $openBrain.Add_Click({
        $id = $this.Tag
        Open-RobotUrl $laneUi[$id].Brain.Text
    })
    $openBrain.Tag = $currentLaneId

    $saveBrain.Add_Click({
        $id = $this.Tag
        $ui = $laneUi[$id]
        $brainUrl = $ui.Brain.Text.Trim()
        if (-not (Test-ChatConversationUrl $brainUrl)) {
            [Windows.Forms.MessageBox]::Show(
                'LINK BỘ NÃO không hợp lệ. Hãy dán đúng link cuộc trò chuyện ChatGPT mới.',
                'MAGASIN SUPERVISOR',
                'OK',
                'Warning'
            ) | Out-Null
            return
        }

        $changed = Save-BrainTarget $id $brainUrl
        if ($changed) {
            [Windows.Forms.MessageBox]::Show(
                'Đã lưu Bộ não mới. Robot sẽ chuyển sang Bộ não này ở vòng xử lý kế tiếp, kể cả khi Work hiện tại vẫn đang chạy.',
                'MAGASIN SUPERVISOR',
                'OK',
                'Information'
            ) | Out-Null
        }
    })
    $saveBrain.Tag = $currentLaneId

    $openWork.Add_Click({
        $id = $this.Tag
        Open-RobotUrl $laneUi[$id].Work.Text
    })
    $openWork.Tag = $currentLaneId

    $saveWork.Add_Click({
        $id = $this.Tag
        $ui = $laneUi[$id]
        $workUrl = $ui.Work.Text.Trim()
        if (-not (Test-ChatConversationUrl $workUrl)) {
            [Windows.Forms.MessageBox]::Show(
                'LINK WORK không hợp lệ. Hãy dán đúng link cuộc trò chuyện ChatGPT.',
                'MAGASIN SUPERVISOR',
                'OK',
                'Warning'
            ) | Out-Null
            return
        }

        $saved = Save-WorkTarget $id $workUrl
        if ($saved.Changed) {
            [Windows.Forms.MessageBox]::Show(
                ('ĐÃ LƯU WORK · revision ' + $saved.Revision + ' · ' + (Format-VietnamTime $saved.SavedAt) + '. Robot sẽ nhận revision ở vòng xử lý kế tiếp; task đang chạy không bị bỏ.'),
                'MAGASIN SUPERVISOR',
                'OK',
                'Information'
            ) | Out-Null
        } else {
            [Windows.Forms.MessageBox]::Show(
                ('WORK không đổi · revision ' + $saved.Revision + '. Không tăng revision.'),
                'MAGASIN SUPERVISOR',
                'OK',
                'Information'
            ) | Out-Null
        }
    })
    $saveWork.Tag = $currentLaneId

    $resetWork.Add_Click({
        $id = $this.Tag
        $saved = Save-WorkTarget $id '' $true $true
        [Windows.Forms.MessageBox]::Show(
            ('ĐÃ LƯU TỰ TẠO WORK · revision ' + $saved.Revision + ' · ' + (Format-VietnamTime $saved.SavedAt) + '. Nếu có task đang chạy, Work hiện tại được giữ đến safe boundary; Robot không bỏ task.'),
            'MAGASIN SUPERVISOR',
            'OK',
            'Information'
        ) | Out-Null
    })
    $resetWork.Tag = $currentLaneId

    $retryRelayButton.Add_Click({
        $id = $this.Tag
        $requested = Request-RelayRetryRearm $id
        [Windows.Forms.MessageBox]::Show(
            ('ĐÃ YÊU CẦU THỬ LẠI RELAY — revision ' + $requested.Revision + '. Robot sẽ reconcile marker trước; không đổi Brain/Work và không reset task.'),
            'MAGASIN SUPERVISOR',
            'OK',
            'Information'
        ) | Out-Null
        $this.Enabled = $false
    })
    $retryRelayButton.Tag = $currentLaneId
}

$timelineGroup = New-Object Windows.Forms.GroupBox
$timelineGroup.Text = 'NHẬT KÝ HOẠT ĐỘNG · MỚI NHẤT Ở TRÊN'
$timelineGroup.Location = New-Object Drawing.Point(20, 1104)
$timelineGroup.Size = New-Object Drawing.Size(1175, 380)
$timelineGroup.BackColor = [Drawing.Color]::White
$content.Controls.Add($timelineGroup)

$timelineList = New-Object Windows.Forms.ListView
$timelineList.Location = New-Object Drawing.Point(12, 24)
$timelineList.Size = New-Object Drawing.Size(1149, 340)
$timelineList.View = [Windows.Forms.View]::Details
$timelineList.FullRowSelect = $true
$timelineList.GridLines = $false
$timelineList.HideSelection = $false
$timelineList.MultiSelect = $false
$timelineList.HeaderStyle = [Windows.Forms.ColumnHeaderStyle]::Nonclickable
$timelineList.BackColor = [Drawing.Color]::FromArgb(248,250,252)
[void]$timelineList.Columns.Add('Giờ', 90)
[void]$timelineList.Columns.Add('Luồng', 82)
[void]$timelineList.Columns.Add('Sự kiện', 330)
[void]$timelineList.Columns.Add('Task', 300)
[void]$timelineList.Columns.Add('Chi tiết', 315)
$timelineGroup.Controls.Add($timelineList)

function Format-ProcessFlag([bool]$Value) {
    if ($Value) { return '✓' }
    return '✕'
}

function Refresh-Timeline {
    $tail = Read-BoundedLaneEventTail -Path $eventFile -MaxEvents 30 -MaxBytes 262144

    $timelineList.BeginUpdate()
    try {
        $timelineList.Items.Clear()
        $events = @($tail.events)
        for ($eventIndex = $events.Count - 1; $eventIndex -ge 0; $eventIndex--) {
            $event = $events[$eventIndex]
            $clock = '—'
            try {
                $dt = [DateTimeOffset]::Parse([string]$event.timestamp)
                $vn = [TimeZoneInfo]::ConvertTime($dt, $vietnamTimeZone)
                $clock = $vn.ToString('HH:mm:ss')
            } catch {}

            $laneText = switch ([string]$event.lane_id) {
                'lane-1' { 'Lane 1' }
                'lane-2' { 'Lane 2' }
                'lane-3' { 'Lane 3' }
                default { 'Robot' }
            }

            $detailParts = New-Object Collections.Generic.List[string]
            if ([string]$event.phase) {
                $detailParts.Add([string]$event.phase)
            }
            if ([string]$event.reason_label) {
                $detailParts.Add([string]$event.reason_label)
            }

            $item = New-Object Windows.Forms.ListViewItem($clock)
            [void]$item.SubItems.Add($laneText)
            [void]$item.SubItems.Add([string]$event.label)
            [void]$item.SubItems.Add([string]$event.task_id)
            [void]$item.SubItems.Add(($detailParts -join ' · '))
            [void]$timelineList.Items.Add($item)
        }
        $timelineGroup.Text = 'NHẬT KÝ HOẠT ĐỘNG · MỚI → CŨ · ' + @($tail.events).Count + ' / 30'
    } finally {
        $timelineList.EndUpdate()
    }
}

function Refresh-Ui {
    $config = Ensure-Config
    $registry = Read-JsonFile $registryFile
    $status = Read-JsonFile $statusFile

    $runner = Get-RunnerProcess
    if (-not $runner) {
        [void](Request-RunnerRecovery)
        $runner = Get-RunnerProcess
    }

    if ($runner) {
        $runnerButton.Text = '✓  GITHUB ĐANG KẾT NỐI'
        $runnerButton.BackColor = [Drawing.Color]::FromArgb(220,252,231)
    } else {
        $runnerButton.Text = '⟳  GITHUB ĐANG TỰ KẾT NỐI'
        $runnerButton.BackColor = [Drawing.Color]::FromArgb(255,247,237)
    }

    $enabledLaneCount = @($config.lanes | Where-Object { [bool]$_.enabled }).Count
    $ownerStop = Get-LifecycleOwnerStopState -Root $root
    $processTruth = Get-LifecycleProcessTruth -Root $root

    if ($enabledLaneCount -gt 0 -and -not $ownerStop.blocked -and -not $processTruth.healthy) {
        Request-LifecycleRecovery
        $processTruth = Get-LifecycleProcessTruth -Root $root
    }

    $processState = if ($enabledLaneCount -lt 1) {
        'ALL_DISABLED'
    } elseif ($ownerStop.blocked) {
        'OWNER_STOP'
    } elseif ($processTruth.healthy) {
        'HEALTHY'
    } elseif (-not $processTruth.wrapper_alive) {
        'STARTING'
    } else {
        'RECOVERING'
    }

    switch ($processState) {
        'HEALTHY' {
            $runtimeLabel.Text = 'ROBOT NỀN: ĐANG HOẠT ĐỘNG'
            $runtimeLabel.ForeColor = [Drawing.Color]::FromArgb(22,101,52)
        }
        'OWNER_STOP' {
            $runtimeLabel.Text = 'ROBOT NỀN: OWNER STOP — CHỈ BẠN CÓ THỂ KHỞI ĐỘNG LẠI'
            $runtimeLabel.ForeColor = [Drawing.Color]::FromArgb(185,28,28)
        }
        'ALL_DISABLED' {
            $runtimeLabel.Text = 'ROBOT NỀN: KHÔNG CẦN CHẠY — TẤT CẢ LUỒNG ĐANG TẮT'
            $runtimeLabel.ForeColor = [Drawing.Color]::FromArgb(71,85,105)
        }
        'STARTING' {
            $runtimeLabel.Text = 'ROBOT NỀN: ĐANG KHỞI ĐỘNG'
            $runtimeLabel.ForeColor = [Drawing.Color]::FromArgb(161,98,7)
        }
        default {
            $runtimeLabel.Text = 'ROBOT NỀN: ĐANG TỰ KHÔI PHỤC'
            $runtimeLabel.ForeColor = [Drawing.Color]::FromArgb(161,98,7)
        }
    }

    $runtimeStartButton.Enabled = [bool]($enabledLaneCount -gt 0 -and $ownerStop.blocked)

    $runtimeVersion = [string](Get-OptionalPropertyValue $status 'supervisor_runtime_version' '—')
    $schedulerSnapshot = Get-OptionalPropertyValue $status 'scheduler' $null
    $wrapperFlag = Format-ProcessFlag ([bool]$processTruth.wrapper_alive)
    $threeLaneFlag = Format-ProcessFlag ([bool]$processTruth.three_lane_alive)
    $chromeFlag = Format-ProcessFlag ([bool]$processTruth.chrome_alive)
    $cdpFlag = Format-ProcessFlag ([bool]$processTruth.cdp_healthy)

    $resourceSummary = Get-ControlPanelResourceSummary $schedulerSnapshot
    $resourceLine2 =
        'TRANG CHATGPT: ' + [string]$resourceSummary.page_text +
        ' · MUTATION: ' + [string]$resourceSummary.mutation_text +
        ' · MUT ' + [string]$resourceSummary.active_mutation +
        ' · OBS ' + [string]$resourceSummary.active_observation +
        ' · PARK ' + [string]$resourceSummary.parked +
        ' · EVICT ' + [string]$resourceSummary.evictable

    $resourceLabel.Text =
        'WRAPPER ' + $wrapperFlag +
        ' · THREE-LANE ' + $threeLaneFlag +
        ' · CHROME ' + $chromeFlag +
        ' · CDP ' + $cdpFlag +
        ' · v' + $runtimeVersion +
        ' · LUỒNG ' + [string]$enabledLaneCount +
        [Environment]::NewLine +
        $resourceLine2

    foreach ($laneId in @('lane-1','lane-2','lane-3')) {
        $ui = $laneUi[$laneId]
        $cfg = Get-LaneConfig $config $laneId
        $reg = $null
        if ($registry -and $registry.lanes) {
            $reg = $registry.lanes.$laneId
        }
        $st = $null
        if ($status -and $status.lanes) {
            $st = @($status.lanes | Where-Object { [string]$_.lane_id -eq $laneId } | Select-Object -First 1)[0]
        }

        if (-not $ui.Project.Focused) { $ui.Project.Text = [string]$cfg.project_name }

        $enabled = [bool]$cfg.enabled
        if (-not $ui.Brain.Focused) {
            if ($enabled -and $st -and $st.brain_url) {
                $ui.Brain.Text = [string]$st.brain_url
            } elseif ($enabled -and $reg -and $reg.brain_url) {
                $ui.Brain.Text = [string]$reg.brain_url
            } elseif ($cfg -and $cfg.brain_url) {
                $ui.Brain.Text = [string]$cfg.brain_url
            } elseif ($reg -and $reg.brain_url) {
                $ui.Brain.Text = [string]$reg.brain_url
            } else {
                $ui.Brain.Text = ''
            }
        }
        if (-not $ui.Work.Focused) {
            $configuredMode = if ($cfg -and $cfg.work_mode) {
                ([string]$cfg.work_mode).ToUpperInvariant()
            } elseif ($cfg -and $cfg.work_url) {
                'OWNER'
            } else {
                'AUTO'
            }

            if ($configuredMode -eq 'OWNER' -and $cfg -and $cfg.work_url) {
                # The textbox represents the latest Owner intent. During an
                # active task the runtime may still execute the old Work until
                # the pending revision reaches a safe boundary.
                $ui.Work.Text = [string]$cfg.work_url
            } elseif ($enabled -and $st -and $st.work_url) {
                $ui.Work.Text = [string]$st.work_url
            } elseif ($reg -and $reg.work_url) {
                $ui.Work.Text = [string]$reg.work_url
            } else {
                $ui.Work.Text = ''
            }
        }

        $ui.Project.Enabled = -not $enabled
        $ui.Brain.Enabled = $true
        $ui.Work.Enabled = $true
        $ui.Start.Enabled = -not $enabled
        $ui.Stop.Enabled = $enabled
        $ui.SaveBrain.Enabled = $true
        $ui.SaveWork.Enabled = $true

        $relayExhaustedStatus = Get-OptionalPropertyValue $st 'relay_retry_exhausted' $null
        $relayInflight = Get-OptionalPropertyValue $reg 'relay_inflight' $null
        $relayExhausted = if ($null -ne $relayExhaustedStatus) {
            [bool]$relayExhaustedStatus
        } else {
            [bool](Get-OptionalPropertyValue $relayInflight 'retry_exhausted' $false)
        }
        $relayRearmRevision = [int](Get-OptionalPropertyValue $st 'relay_rearm_revision' (
            Get-OptionalPropertyValue $cfg 'relay_retry_rearm_revision' 0
        ))
        $appliedRelayRearmRevision = [int](Get-OptionalPropertyValue $st 'applied_relay_rearm_revision' (
            Get-OptionalPropertyValue $reg 'applied_relay_retry_rearm_revision' 0
        ))
        $relayRearmPendingValue = Get-OptionalPropertyValue $st 'relay_rearm_pending' $null
        $relayRearmPending = if ($null -ne $relayRearmPendingValue) {
            [bool]$relayRearmPendingValue
        } else {
            [bool]($relayRearmRevision -gt $appliedRelayRearmRevision)
        }
        $ui.RetryRelay.Visible = $relayExhausted
        $ui.RetryRelay.Enabled = [bool]($relayExhausted -and -not $relayRearmPending)

        $laneStatusValue = [string](Get-OptionalPropertyValue $st 'status' '')
        $state = Get-ControlPanelEffectiveLaneState -Enabled $enabled -OwnerStopped ([bool]$ownerStop.blocked) -ProcessHealthy ([bool]$processTruth.healthy) -ProcessState $processState -LaneStatus $laneStatusValue

        $message = 'Luồng đang dừng. Nhập link Bộ não rồi bấm BẮT ĐẦU LUỒNG.'
        if ($enabled) {
            if ($ownerStop.blocked) {
                $message = 'Robot nền đang ở Owner STOP. Luồng vẫn được lưu; bấm KHỞI ĐỘNG ROBOT NỀN khi bạn muốn tiếp tục.'
            } elseif (-not $processTruth.healthy) {
                $message = if ($processState -eq 'STARTING') {
                    'Đang khởi động Robot nền; lane status cũ chỉ là recovery state.'
                } else {
                    'Đang tự khôi phục Supervisor / Three-Lane / Chrome / CDP trước khi tiếp tục task.'
                }
            } else {
                $message = [string](Get-OptionalPropertyValue $st 'message' 'Robot đang hoạt động.')
            }
        }

        $structuredPhase = [string](Get-OptionalPropertyValue $st 'phase' $state)
        if ($processTruth.healthy -and -not $ownerStop.blocked) {
            if ($structuredPhase -eq 'WORK_TARGET_QUARANTINED') {
                $state = 'WAIT_OWNER'
                $message = 'WORK KHÔNG CÒN TỒN TẠI / ĐÃ NGỪNG MỞ LẠI — hãy LƯU WORK mới hoặc dùng TỰ TẠO WORK khi safe boundary cho phép.'
            } elseif ($structuredPhase -eq 'BRAIN_TARGET_QUARANTINED') {
                $state = 'WAIT_OWNER'
                $message = 'BỘ NÃO KHÔNG CÒN TỒN TẠI / ĐƯỢC TRUY CẬP — hãy dán Brain URL mới và LƯU BỘ NÃO.'
            }
        }

        if ($relayExhausted) {
            $state = 'WAIT_OWNER'
            if ($relayRearmPending) {
                $message = 'ĐÃ YÊU CẦU THỬ LẠI RELAY — revision ' + $relayRearmRevision + '. Đang chờ Robot reconcile marker và apply đúng một lần.'
            } else {
                $message = 'RELAY HẾT LƯỢT THỬ — kiểm tra Brain rồi bấm THỬ LẠI RELAY.'
            }
            if ($ownerStop.blocked) {
                $message += ' Robot đang Owner STOP; intent được lưu nhưng chỉ apply sau khi bạn START lại.'
            }
        }

        $ui.Status.Text = Get-FriendlyStatus $state
        $statusBackColor = Get-StatusBackColor $state
        $ui.Status.BackColor = $statusBackColor
        $ui.Status.ForeColor = Get-StatusForeColor $state
        $ui.Accent.BackColor = $statusBackColor
        $ui.Panel.BackColor = [Drawing.Color]::White
        $ui.Message.Text = $message

        $taskId = [string](Get-OptionalPropertyValue $st 'task_id' (
            Get-OptionalPropertyValue $reg 'task_id' '—'
        ))
        if (-not $taskId) { $taskId = '—' }

        $phase = [string](Get-OptionalPropertyValue $st 'phase' $state)
        if (-not $phase) { $phase = $state }

        $elapsed = Format-ControlPanelDuration (
            Get-OptionalPropertyValue $st 'task_elapsed_ms' $null
        )
        $lastActivityAge = Format-ControlPanelAge (
            [string](Get-OptionalPropertyValue $st 'last_activity_at' '')
        )
        $workGeneration = [int](Get-OptionalPropertyValue $st 'work_generation' (
            Get-OptionalPropertyValue $reg 'work_generation' 0
        ))

        $ui.Execution.Text =
            'TASK: ' + $taskId +
            ' · PHA: ' + $phase +
            ' · THỜI GIAN: ' + $elapsed +
            ' · HOẠT ĐỘNG CUỐI: ' + $lastActivityAge +
            ' · GEN ' + [string]$workGeneration

        $projectProgressKnown = [bool](Get-OptionalPropertyValue $st 'project_progress_known' $false)
        $projectTotalTasks = [int](Get-OptionalPropertyValue $st 'project_total_tasks' 0)
        $projectCompletedTasks = [int](Get-OptionalPropertyValue $st 'project_completed_tasks' 0)
        $projectProgressRaw = Get-OptionalPropertyValue $st 'project_progress_percent' $null

        if ($projectProgressKnown -and $projectTotalTasks -gt 0 -and $null -ne $projectProgressRaw) {
            $projectProgressPercent = [Math]::Max(
                0,
                [Math]::Min(100, [int]$projectProgressRaw)
            )
            $ui.Progress.Text =
                'TIẾN ĐỘ DỰ ÁN: ' +
                [string]$projectCompletedTasks +
                '/' +
                [string]$projectTotalTasks +
                ' TASK'
            $ui.ProgressBar.Value = $projectProgressPercent
            $ui.ProgressPercent.Text = [string]$projectProgressPercent + '%'
        } elseif ($projectProgressKnown) {
            $ui.Progress.Text = 'TIẾN ĐỘ DỰ ÁN: 0/0 TASK'
            $ui.ProgressBar.Value = 0
            $ui.ProgressPercent.Text = '0%'
        } else {
            $ui.Progress.Text = 'TIẾN ĐỘ DỰ ÁN: CHƯA CÓ KẾ HOẠCH'
            $ui.ProgressBar.Value = 0
            $ui.ProgressPercent.Text = '—'
        }

        $brainHealth = Get-OptionalPropertyValue $st 'brain_target_health' (
            Get-OptionalPropertyValue $reg 'brain_target_health' $null
        )
        $workHealth = Get-OptionalPropertyValue $st 'work_target_health' (
            Get-OptionalPropertyValue $reg 'work_target_health' $null
        )
        $watchdogPhase = [string](Get-OptionalPropertyValue $st 'watchdog_phase' '')
        if (-not $watchdogPhase -or $watchdogPhase -eq 'IDLE') {
            $watchdogPhase = '—'
        }
        $rolloverStage = [string](Get-OptionalPropertyValue $st 'rollover_phase' '')
        $rolloverText = Get-ControlPanelRolloverText $rolloverStage
        $healthLine2 = 'WATCHDOG: ' + $watchdogPhase
        if ($rolloverText) {
            $healthLine2 += ' · ' + $rolloverText
        }
        $ui.Health.Text =
            (Get-ControlPanelTargetHealthText $brainHealth 'BRAIN') +
            ' · ' +
            (Get-ControlPanelTargetHealthText $workHealth 'WORK') +
            [Environment]::NewLine +
            $healthLine2

        $configuredRevision = [int](Get-OptionalPropertyValue $st 'configured_work_url_revision' (
            Get-OptionalPropertyValue $cfg 'work_url_revision' 0
        ))
        $appliedRevision = [int](Get-OptionalPropertyValue $st 'applied_work_url_revision' (
            Get-OptionalPropertyValue $reg 'applied_work_url_revision' 0
        ))
        $pendingRevision = [int](Get-OptionalPropertyValue $st 'pending_work_url_revision' (
            Get-OptionalPropertyValue $reg 'pending_work_url_revision' 0
        ))
        $configuredMode = [string](Get-OptionalPropertyValue $st 'work_mode' (
            Get-OptionalPropertyValue $cfg 'work_mode' 'AUTO'
        ))
        if (-not $configuredMode) { $configuredMode = 'AUTO' }
        $configuredMode = $configuredMode.ToUpperInvariant()

        $workApplyState = if ($configuredRevision -gt 0 -and $pendingRevision -ge $configuredRevision) {
            'ĐANG CHỜ ÁP DỤNG'
        } elseif ($configuredRevision -gt 0 -and $appliedRevision -ge $configuredRevision) {
            'ĐÃ ÁP DỤNG'
        } elseif ($configuredRevision -gt 0) {
            'ĐÃ LƯU'
        } else {
            'CHƯA CÓ REVISION'
        }

        $savedAtRaw = [string](Get-OptionalPropertyValue $st 'work_url_saved_at' (
            Get-OptionalPropertyValue $cfg 'work_url_saved_at' ''
        ))
        $savedAt = if ($savedAtRaw) {
            Format-VietnamTime $savedAtRaw
        } else {
            '—'
        }
        $ui.Updated.Text =
            'WORK ' + $configuredMode +
            ' · cấu hình r' + [string]$configuredRevision +
            ' · áp dụng r' + [string]$appliedRevision +
            ' · pending r' + [string]$pendingRevision +
            ' · ' + $workApplyState +
            ' · lưu ' + $savedAt

        $ui.OpenBrain.Enabled = Test-ChatConversationUrl $ui.Brain.Text
        $ui.OpenWork.Enabled = Test-ChatConversationUrl $ui.Work.Text
        $ui.ResetWork.Enabled = $true
    }

    $refreshNow = [TimeZoneInfo]::ConvertTime([DateTimeOffset]::UtcNow, $vietnamTimeZone)
    $lastRefreshLabel.Text = 'Đồng bộ: ' + $refreshNow.ToString('HH:mm:ss') + ' · Việt Nam'
    Refresh-Timeline
}

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({ Refresh-Ui })
$timer.Start()

Ensure-Config | Out-Null

# Enter the WinForms message loop before the first runtime refresh. Refresh-Ui
# can perform runner/process recovery and CIM queries, so running it here before
# ShowDialog can leave powershell.exe alive with no visible Control Center.
# The 2-second UI timer performs the first refresh after the window is visible.
[void]$form.ShowDialog()
