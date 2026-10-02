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

    $form = New-Object Windows.Forms.Form
    $form.Text = 'MAGASIN SUPERVISOR — CONTROL CENTER'
    $form.StartPosition = 'CenterScreen'
    $form.Size = New-Object Drawing.Size(900, 620)
    $form.MinimumSize = New-Object Drawing.Size(820, 560)
    $form.AutoScaleMode = [Windows.Forms.AutoScaleMode]::Dpi
    $form.BackColor = [Drawing.Color]::FromArgb(241,245,249)
    $form.Font = New-Object Drawing.Font('Segoe UI', 9)

    $hero = New-Object Windows.Forms.Panel
    $hero.Location = New-Object Drawing.Point(20, 18)
    $hero.Size = New-Object Drawing.Size(840, 104)
    $hero.BackColor = [Drawing.Color]::FromArgb(15,23,42)
    $form.Controls.Add($hero)

    $title = New-Object Windows.Forms.Label
    $title.Text = 'MAGASIN SUPERVISOR'
    $title.Location = New-Object Drawing.Point(22, 14)
    $title.Size = New-Object Drawing.Size(470, 42)
    $title.Font = New-Object Drawing.Font('Segoe UI Semibold', 23)
    $title.ForeColor = [Drawing.Color]::White
    $hero.Controls.Add($title)

    $subtitle = New-Object Windows.Forms.Label
    $subtitle.Text = 'SINGLE CONVERSATION  •  DISPOSABLE CHAT  •  PERSISTENT SOURCE OF TRUTH'
    $subtitle.Location = New-Object Drawing.Point(25, 62)
    $subtitle.Size = New-Object Drawing.Size(610, 24)
    $subtitle.ForeColor = [Drawing.Color]::FromArgb(203,213,225)
    $hero.Controls.Add($subtitle)

    $modeBadge = New-Object Windows.Forms.Label
    $modeBadge.Text = 'SINGLE_CONVERSATION_V1'
    $modeBadge.Location = New-Object Drawing.Point(620, 25)
    $modeBadge.Size = New-Object Drawing.Size(195, 32)
    $modeBadge.TextAlign = 'MiddleCenter'
    $modeBadge.BackColor = [Drawing.Color]::FromArgb(30,41,59)
    $modeBadge.ForeColor = [Drawing.Color]::FromArgb(226,232,240)
    $hero.Controls.Add($modeBadge)

    $control = New-Object Windows.Forms.Panel
    $control.Location = New-Object Drawing.Point(20, 140)
    $control.Size = New-Object Drawing.Size(840, 178)
    $control.BackColor = [Drawing.Color]::White
    $control.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
    $form.Controls.Add($control)

    $sourceLabel = New-Object Windows.Forms.Label
    $sourceLabel.Text = 'SOURCE OF TRUTH'
    $sourceLabel.Location = New-Object Drawing.Point(20, 22)
    $sourceLabel.Size = New-Object Drawing.Size(130, 24)
    $sourceLabel.Font = New-Object Drawing.Font('Segoe UI Semibold', 10)
    $control.Controls.Add($sourceLabel)

    $sourceBox = New-Object Windows.Forms.TextBox
    $sourceBox.Location = New-Object Drawing.Point(20, 52)
    $sourceBox.Size = New-Object Drawing.Size(795, 28)
    $control.Controls.Add($sourceBox)

    $startButton = New-Object Windows.Forms.Button
    $startButton.Location = New-Object Drawing.Point(20, 104)
    $startButton.Size = New-Object Drawing.Size(180, 44)
    $startButton.Text = '▶  START ROBOT'
    $startButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $startButton.BackColor = [Drawing.Color]::FromArgb(22,163,74)
    $startButton.ForeColor = [Drawing.Color]::White
    $startButton.FlatAppearance.BorderSize = 0
    $control.Controls.Add($startButton)

    $stopButton = New-Object Windows.Forms.Button
    $stopButton.Location = New-Object Drawing.Point(215, 104)
    $stopButton.Size = New-Object Drawing.Size(180, 44)
    $stopButton.Text = '■  STOP ROBOT'
    $stopButton.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $stopButton.BackColor = [Drawing.Color]::FromArgb(185,28,28)
    $stopButton.ForeColor = [Drawing.Color]::White
    $stopButton.FlatAppearance.BorderSize = 0
    $control.Controls.Add($stopButton)

    $startMeaning = New-Object Windows.Forms.Label
    $startMeaning.Location = New-Object Drawing.Point(420, 100)
    $startMeaning.Size = New-Object Drawing.Size(395, 54)
    $startMeaning.ForeColor = [Drawing.Color]::FromArgb(71,85,105)
    $startMeaning.Text = 'START = create/resume Robot session from Source of Truth. No chat URL is required.'
    $control.Controls.Add($startMeaning)

    $diagnostics = New-Object Windows.Forms.Panel
    $diagnostics.Location = New-Object Drawing.Point(20, 338)
    $diagnostics.Size = New-Object Drawing.Size(840, 190)
    $diagnostics.BackColor = [Drawing.Color]::White
    $diagnostics.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
    $form.Controls.Add($diagnostics)

    $diagTitle = New-Object Windows.Forms.Label
    $diagTitle.Text = 'RUNTIME DIAGNOSTICS'
    $diagTitle.Location = New-Object Drawing.Point(20, 18)
    $diagTitle.Size = New-Object Drawing.Size(260, 24)
    $diagTitle.Font = New-Object Drawing.Font('Segoe UI Semibold', 10)
    $diagnostics.Controls.Add($diagTitle)

    $runtimeValue = New-Object Windows.Forms.Label
    $runtimeValue.Location = New-Object Drawing.Point(20, 52)
    $runtimeValue.Size = New-Object Drawing.Size(795, 28)
    $diagnostics.Controls.Add($runtimeValue)

    $conversationValue = New-Object Windows.Forms.Label
    $conversationValue.Location = New-Object Drawing.Point(20, 82)
    $conversationValue.Size = New-Object Drawing.Size(795, 28)
    $diagnostics.Controls.Add($conversationValue)

    $automationValue = New-Object Windows.Forms.Label
    $automationValue.Location = New-Object Drawing.Point(20, 112)
    $automationValue.Size = New-Object Drawing.Size(795, 28)
    $diagnostics.Controls.Add($automationValue)

    $syncValue = New-Object Windows.Forms.Label
    $syncValue.Location = New-Object Drawing.Point(20, 142)
    $syncValue.Size = New-Object Drawing.Size(795, 28)
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

    function Refresh-SingleConversationUi {
        $truth = Get-LifecycleProcessTruth -Root $root
        $ownerStop = Get-LifecycleOwnerStopState -Root $root
        $controlState = Read-SingleConversationControl
        $state = Read-JsonFile $singleConversationStateFile

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

        $runtimeValue.Text =
            'RUNTIME: ' +
            $(if ($truth.wrapper_alive) { 'RUNNING' } else { 'STOPPED' }) +
            '  •  mode=' +
            $(if ($truth.runtime_mode) { [string]$truth.runtime_mode } else { '—' })

        $generation = if ($state) {
            [int](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'conversation' $null) 'generation' 0)
        } else { 0 }
        $conversationStatus = if ($state) {
            [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'conversation' $null) 'status' 'NONE')
        } else { 'NONE' }
        $conversationValue.Text = "CONVERSATION: generation=$generation  •  status=$conversationStatus"

        $automationStatus = if ($state) {
            [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'automation' $null) 'status' 'STOPPED')
        } else { 'STOPPED' }
        $phase = if ($state) {
            [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'automation' $null) 'phase' 'STOPPED')
        } else { 'STOPPED' }
        $automationValue.Text = "AUTOMATION: $automationStatus  •  phase=$phase"

        $syncStatus = if ($state) {
            [string](Get-OptionalPropertyValue (Get-OptionalPropertyValue $state 'source_of_truth' $null) 'sync_status' 'UNVERIFIED')
        } else { 'UNVERIFIED' }
        $syncValue.Text = "SOURCE OF TRUTH SYNC: $syncStatus  •  Chat URLs are disposable diagnostics and are not persisted."
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
                'KHÔNG THỂ START ROBOT',
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
    $timer.Interval = 2000
    $timer.Add_Tick({ Refresh-SingleConversationUi })
    $form.Add_Shown({ Refresh-SingleConversationUi })
    $form.Add_FormClosed({ $timer.Stop(); $timer.Dispose() })
    $timer.Start()
    [void]$form.ShowDialog()
}

# SINGLE_CONVERSATION_V1 is the only Control Center mode.
Show-SingleConversationControlPanel
exit 0
