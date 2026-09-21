param(
    [switch]$ViewportProbe,
    [switch]$ObservabilityProbe,
    [int]$ProbeWidth = 0,
    [int]$ProbeHeight = 0
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'state-root.ps1')

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
        lane3_stop_bottom = 1047
        lane3_stop_in_canvas = [bool]($probeLayout.LogicalCanvasSize.Height -ge 1047)
        timeline_bottom = 1485
        critical_controls_scroll_reachable = [bool](
            $probeLayout.InitialSize.Height -gt 0 -and
            $probeLayout.LogicalCanvasSize.Height -ge 1047
        )
    } | ConvertTo-Json -Compress
    exit 0
}

$root = Get-SupervisorStateRoot
$runtime = Join-Path $root 'runtime'
$configFile = Join-Path $root 'lanes.json'
$registryFile = Join-Path $root 'lane-registry.json'
$statusFile = Join-Path $root 'lane-status.json'
$eventFile = Join-Path $root 'lane-events.ndjson'
$startScript = Join-Path $runtime 'windows\start-supervisor.ps1'
$lifecycleScript = Join-Path $runtime 'windows\lifecycle-truth.ps1'
$observabilityScript = Join-Path $runtime 'windows\control-panel-observability.ps1'
$openChatScript = Join-Path $runtime 'windows\open-supervisor-chat.ps1'
$runnerRoot = 'C:\actions-runner-business\actions-runner'
$repoUrl = [string]$env:MAGASIN_SUPERVISOR_PROJECT_REPOSITORY_URL
$vietnamTimeZone = [TimeZoneInfo]::FindSystemTimeZoneById('SE Asia Standard Time')
$script:lastRecoveryRequestAt = [DateTimeOffset]::MinValue

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
            [ordered]@{ lane_id='lane-1'; project_name='Dự án 1'; brain_url=''; brain_url_revision=0; work_url=''; work_url_revision=0; work_url_saved_at=$null; work_mode='AUTO'; relay_retry_rearm_revision=0; relay_retry_rearm_requested_at=$null; enabled=$false },
            [ordered]@{ lane_id='lane-2'; project_name='Dự án 2'; brain_url=''; brain_url_revision=0; work_url=''; work_url_revision=0; work_url_saved_at=$null; work_mode='AUTO'; relay_retry_rearm_revision=0; relay_retry_rearm_requested_at=$null; enabled=$false },
            [ordered]@{ lane_id='lane-3'; project_name='Dự án 3'; brain_url=''; brain_url_revision=0; work_url=''; work_url_revision=0; work_url_saved_at=$null; work_mode='AUTO'; relay_retry_rearm_revision=0; relay_retry_rearm_requested_at=$null; enabled=$false }
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
    return Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.ExecutablePath -and $_.ExecutablePath -like "$runnerRoot*") -or
            ($_.CommandLine -and $_.CommandLine -like "*$runnerRoot*")
        } |
        Select-Object -First 1
}

function Ensure-Runner {
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

function Open-RobotUrl([string]$Url) {
    if (-not (Test-ChatConversationUrl $Url)) {
        [Windows.Forms.MessageBox]::Show(
            'Chưa có URL cuộc trò chuyện hợp lệ.',
            'MAGASIN BUSINESS OS',
            'OK',
            'Information'
        ) | Out-Null
        return
    }
    if (-not (Test-Path $openChatScript)) {
        [Windows.Forms.MessageBox]::Show(
            'Không tìm thấy trình mở Chrome Robot.',
            'MAGASIN BUSINESS OS',
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

    $newBrainUrl = if ($BrainUrl) { $BrainUrl.Trim() } else { '' }
    if ([string]$lane.brain_url -ne $newBrainUrl) {
        $lane.brain_url_revision = [int]$lane.brain_url_revision + 1
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

[Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object Windows.Forms.Form
$form.Text = 'MAGASIN BUSINESS OS — 3 LUỒNG LÀM VIỆC'
$form.StartPosition = 'Manual'
$form.AutoScaleMode = [Windows.Forms.AutoScaleMode]::Dpi
$form.AutoScaleDimensions = New-Object Drawing.SizeF(96, 96)

$currentScreen = [Windows.Forms.Screen]::FromPoint([Windows.Forms.Cursor]::Position)
$viewportLayout = Get-ControlPanelViewportLayout -WorkingArea $currentScreen.WorkingArea
$form.Size = $viewportLayout.InitialSize
$form.MinimumSize = $viewportLayout.MinimumSize
$form.Location = $viewportLayout.Location
$form.BackColor = [Drawing.Color]::FromArgb(248,250,252)
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

$title = New-Object Windows.Forms.Label
$title.Text = 'MAGASIN BUSINESS OS'
$title.Location = New-Object Drawing.Point(28, 22)
$title.Size = New-Object Drawing.Size(430, 42)
$title.Font = New-Object Drawing.Font('Segoe UI Semibold', 23)
$content.Controls.Add($title)

$subtitle = New-Object Windows.Forms.Label
$subtitle.Text = '3 LUỒNG ĐỘC LẬP  •  BỘ NÃO DO BẠN CHỌN  •  WORK: BẠN CHỌN HOẶC ROBOT TỰ TẠO'
$subtitle.Location = New-Object Drawing.Point(520, 34)
$subtitle.Size = New-Object Drawing.Size(665, 26)
$subtitle.TextAlign = 'MiddleRight'
$subtitle.ForeColor = [Drawing.Color]::FromArgb(71,85,105)
$content.Controls.Add($subtitle)

$runnerButton = New-Object Windows.Forms.Button
$runnerButton.Location = New-Object Drawing.Point(28, 76)
$runnerButton.Size = New-Object Drawing.Size(260, 42)
$runnerButton.Text = 'KẾT NỐI GITHUB'
$runnerButton.Add_Click({
    if (-not (Ensure-Runner)) {
        [Windows.Forms.MessageBox]::Show(
            'Không thể khởi động GitHub Runner. Mở nhật ký Runner để kiểm tra kết nối mạng.',
            'MAGASIN BUSINESS OS',
            'OK',
            'Warning'
        ) | Out-Null
    }
})
$content.Controls.Add($runnerButton)

$runtimeLabel = New-Object Windows.Forms.Label
$runtimeLabel.Location = New-Object Drawing.Point(310, 77)
$runtimeLabel.Size = New-Object Drawing.Size(500, 20)
$runtimeLabel.Font = New-Object Drawing.Font('Segoe UI Semibold', 10)
$content.Controls.Add($runtimeLabel)

$resourceLabel = New-Object Windows.Forms.Label
$resourceLabel.Location = New-Object Drawing.Point(310, 98)
$resourceLabel.Size = New-Object Drawing.Size(500, 36)
$resourceLabel.Font = New-Object Drawing.Font('Segoe UI', 8.5)
$resourceLabel.ForeColor = [Drawing.Color]::FromArgb(71,85,105)
$content.Controls.Add($resourceLabel)

$runtimeStartButton = New-Object Windows.Forms.Button
$runtimeStartButton.Location = New-Object Drawing.Point(820, 76)
$runtimeStartButton.Size = New-Object Drawing.Size(175, 42)
$runtimeStartButton.Text = 'KHỞI ĐỘNG ROBOT NỀN'
$runtimeStartButton.Add_Click({
    $enabledLaneCount = Get-EnabledLaneCount -Root $root
    if ($enabledLaneCount -lt 1) {
        [Windows.Forms.MessageBox]::Show(
            'Hãy bật ít nhất một luồng trước khi khởi động Robot nền.',
            'MAGASIN BUSINESS OS',
            'OK',
            'Information'
        ) | Out-Null
        return
    }

    if (-not (Test-Path $startScript)) {
        [Windows.Forms.MessageBox]::Show(
            'Không tìm thấy Supervisor runtime.',
            'MAGASIN BUSINESS OS',
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
$content.Controls.Add($runtimeStartButton)

$repoButton = New-Object Windows.Forms.Button
$repoButton.Location = New-Object Drawing.Point(1015, 76)
$repoButton.Size = New-Object Drawing.Size(170, 42)
if ([string]::IsNullOrWhiteSpace($repoUrl)) {
    $repoButton.Text = 'CHƯA CẤU HÌNH DỰ ÁN'
    $repoButton.Enabled = $false
} else {
    $repoButton.Text = 'MỞ DỰ ÁN'
    $repoButton.Add_Click({ Start-Process $repoUrl })
}
$content.Controls.Add($repoButton)

$laneUi = @{}
$cardY = @(135, 445, 755)

for ($i = 0; $i -lt 3; $i++) {
    $laneId = "lane-$($i + 1)"
    $panel = New-Object Windows.Forms.Panel
    $panel.Location = New-Object Drawing.Point(28, $cardY[$i])
    $panel.Size = New-Object Drawing.Size(1157, 298)
    $panel.BorderStyle = 'FixedSingle'
    $panel.BackColor = [Drawing.Color]::White
    $content.Controls.Add($panel)

    $laneTitle = New-Object Windows.Forms.Label
    $laneTitle.Text = "LUỒNG $($i + 1)"
    $laneTitle.Location = New-Object Drawing.Point(18, 12)
    $laneTitle.Size = New-Object Drawing.Size(130, 26)
    $laneTitle.Font = New-Object Drawing.Font('Segoe UI Semibold', 13)
    $panel.Controls.Add($laneTitle)

    $projectLabel = New-Object Windows.Forms.Label
    $projectLabel.Text = 'TÊN DỰ ÁN'
    $projectLabel.Location = New-Object Drawing.Point(165, 15)
    $projectLabel.Size = New-Object Drawing.Size(85, 22)
    $panel.Controls.Add($projectLabel)

    $projectBox = New-Object Windows.Forms.TextBox
    $projectBox.Location = New-Object Drawing.Point(250, 12)
    $projectBox.Size = New-Object Drawing.Size(340, 26)
    $panel.Controls.Add($projectBox)

    $statusValue = New-Object Windows.Forms.Label
    $statusValue.Location = New-Object Drawing.Point(610, 10)
    $statusValue.Size = New-Object Drawing.Size(520, 32)
    $statusValue.Font = New-Object Drawing.Font('Segoe UI Semibold', 13)
    $statusValue.TextAlign = 'MiddleRight'
    $panel.Controls.Add($statusValue)

    $brainLabel = New-Object Windows.Forms.Label
    $brainLabel.Text = 'LINK BỘ NÃO'
    $brainLabel.Location = New-Object Drawing.Point(18, 58)
    $brainLabel.Size = New-Object Drawing.Size(105, 24)
    $panel.Controls.Add($brainLabel)

    $brainBox = New-Object Windows.Forms.TextBox
    $brainBox.Location = New-Object Drawing.Point(125, 55)
    $brainBox.Size = New-Object Drawing.Size(760, 27)
    $panel.Controls.Add($brainBox)

    $openBrain = New-Object Windows.Forms.Button
    $openBrain.Text = 'MỞ BỘ NÃO'
    $openBrain.Location = New-Object Drawing.Point(900, 52)
    $openBrain.Size = New-Object Drawing.Size(108, 34)
    $panel.Controls.Add($openBrain)

    $saveBrain = New-Object Windows.Forms.Button
    $saveBrain.Text = 'LƯU BỘ NÃO'
    $saveBrain.Location = New-Object Drawing.Point(1017, 52)
    $saveBrain.Size = New-Object Drawing.Size(108, 34)
    $panel.Controls.Add($saveBrain)

    $workLabel = New-Object Windows.Forms.Label
    $workLabel.Text = 'LINK WORK (TÙY CHỌN)'
    $workLabel.Location = New-Object Drawing.Point(18, 100)
    $workLabel.Size = New-Object Drawing.Size(105, 24)
    $panel.Controls.Add($workLabel)

    $workBox = New-Object Windows.Forms.TextBox
    $workBox.Location = New-Object Drawing.Point(125, 97)
    $workBox.Size = New-Object Drawing.Size(635, 27)
    $workBox.ReadOnly = $false
    $workBox.BackColor = [Drawing.Color]::White
    $panel.Controls.Add($workBox)

    $openWork = New-Object Windows.Forms.Button
    $openWork.Text = 'MỞ WORK'
    $openWork.Location = New-Object Drawing.Point(775, 94)
    $openWork.Size = New-Object Drawing.Size(108, 34)
    $panel.Controls.Add($openWork)

    $saveWork = New-Object Windows.Forms.Button
    $saveWork.Text = 'LƯU WORK'
    $saveWork.Location = New-Object Drawing.Point(892, 94)
    $saveWork.Size = New-Object Drawing.Size(108, 34)
    $panel.Controls.Add($saveWork)

    $resetWork = New-Object Windows.Forms.Button
    $resetWork.Text = 'TỰ TẠO WORK'
    $resetWork.Location = New-Object Drawing.Point(1009, 94)
    $resetWork.Size = New-Object Drawing.Size(116, 34)
    $panel.Controls.Add($resetWork)

    $executionValue = New-Object Windows.Forms.Label
    $executionValue.Location = New-Object Drawing.Point(18, 136)
    $executionValue.Size = New-Object Drawing.Size(742, 24)
    $executionValue.Font = New-Object Drawing.Font('Segoe UI Semibold', 9)
    $executionValue.AutoEllipsis = $true
    $panel.Controls.Add($executionValue)

    $healthValue = New-Object Windows.Forms.Label
    $healthValue.Location = New-Object Drawing.Point(18, 162)
    $healthValue.Size = New-Object Drawing.Size(742, 42)
    $healthValue.Font = New-Object Drawing.Font('Segoe UI', 8.5)
    $healthValue.ForeColor = [Drawing.Color]::FromArgb(71,85,105)
    $panel.Controls.Add($healthValue)

    $updatedValue = New-Object Windows.Forms.Label
    $updatedValue.Location = New-Object Drawing.Point(18, 207)
    $updatedValue.Size = New-Object Drawing.Size(742, 24)
    $updatedValue.ForeColor = [Drawing.Color]::FromArgb(100,116,139)
    $panel.Controls.Add($updatedValue)

    $messageValue = New-Object Windows.Forms.Label
    $messageValue.Location = New-Object Drawing.Point(18, 235)
    $messageValue.Size = New-Object Drawing.Size(742, 50)
    $messageValue.AutoEllipsis = $true
    $panel.Controls.Add($messageValue)

    $retryRelayButton = New-Object Windows.Forms.Button
    $retryRelayButton.Text = 'THỬ LẠI RELAY'
    $retryRelayButton.Location = New-Object Drawing.Point(775, 145)
    $retryRelayButton.Size = New-Object Drawing.Size(110, 71)
    $retryRelayButton.Enabled = $false
    $retryRelayButton.Visible = $false
    $panel.Controls.Add($retryRelayButton)

    $startButton = New-Object Windows.Forms.Button
    $startButton.Text = '▶  BẮT ĐẦU LUỒNG'
    $startButton.Location = New-Object Drawing.Point(900, 220)
    $startButton.Size = New-Object Drawing.Size(225, 34)
    $panel.Controls.Add($startButton)

    $stopButton = New-Object Windows.Forms.Button
    $stopButton.Text = '■  DỪNG LUỒNG'
    $stopButton.Location = New-Object Drawing.Point(900, 260)
    $stopButton.Size = New-Object Drawing.Size(225, 32)
    $panel.Controls.Add($stopButton)

    $laneUi[$laneId] = [pscustomobject]@{
        Panel = $panel
        Project = $projectBox
        Brain = $brainBox
        Work = $workBox
        Status = $statusValue
        Execution = $executionValue
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
                'MAGASIN BUSINESS OS',
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
                'MAGASIN BUSINESS OS',
                'OK',
                'Warning'
            ) | Out-Null
            return
        }

        $changed = Save-BrainTarget $id $brainUrl
        if ($changed) {
            [Windows.Forms.MessageBox]::Show(
                'Đã lưu Bộ não mới. Robot sẽ chuyển sang Bộ não này ở vòng xử lý kế tiếp, kể cả khi Work hiện tại vẫn đang chạy.',
                'MAGASIN BUSINESS OS',
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
                'MAGASIN BUSINESS OS',
                'OK',
                'Warning'
            ) | Out-Null
            return
        }

        $saved = Save-WorkTarget $id $workUrl
        if ($saved.Changed) {
            [Windows.Forms.MessageBox]::Show(
                ('ĐÃ LƯU WORK · revision ' + $saved.Revision + ' · ' + (Format-VietnamTime $saved.SavedAt) + '. Robot sẽ nhận revision ở vòng xử lý kế tiếp; task đang chạy không bị bỏ.'),
                'MAGASIN BUSINESS OS',
                'OK',
                'Information'
            ) | Out-Null
        } else {
            [Windows.Forms.MessageBox]::Show(
                ('WORK không đổi · revision ' + $saved.Revision + '. Không tăng revision.'),
                'MAGASIN BUSINESS OS',
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
            'MAGASIN BUSINESS OS',
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
            'MAGASIN BUSINESS OS',
            'OK',
            'Information'
        ) | Out-Null
        $this.Enabled = $false
    })
    $retryRelayButton.Tag = $currentLaneId
}

$timelineGroup = New-Object Windows.Forms.GroupBox
$timelineGroup.Text = 'DÒNG SỰ KIỆN GẦN NHẤT'
$timelineGroup.Location = New-Object Drawing.Point(28, 1070)
$timelineGroup.Size = New-Object Drawing.Size(1157, 415)
$content.Controls.Add($timelineGroup)

$timelineList = New-Object Windows.Forms.ListView
$timelineList.Location = New-Object Drawing.Point(14, 24)
$timelineList.Size = New-Object Drawing.Size(1128, 372)
$timelineList.View = [Windows.Forms.View]::Details
$timelineList.FullRowSelect = $true
$timelineList.GridLines = $true
$timelineList.HideSelection = $false
$timelineList.MultiSelect = $false
$timelineList.HeaderStyle = [Windows.Forms.ColumnHeaderStyle]::Nonclickable
[void]$timelineList.Columns.Add('Giờ', 82)
[void]$timelineList.Columns.Add('Luồng', 72)
[void]$timelineList.Columns.Add('Sự kiện', 335)
[void]$timelineList.Columns.Add('Task', 315)
[void]$timelineList.Columns.Add('Chi tiết', 300)
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
        foreach ($event in @($tail.events)) {
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
        $timelineGroup.Text = 'DÒNG SỰ KIỆN GẦN NHẤT · ' + @($tail.events).Count + ' / 30'
    } finally {
        $timelineList.EndUpdate()
    }
}

function Refresh-Ui {
    $config = Ensure-Config
    $registry = Read-JsonFile $registryFile
    $status = Read-JsonFile $statusFile

    $runner = Get-RunnerProcess
    if ($runner) {
        $runnerButton.Text = '✓  GITHUB ĐANG KẾT NỐI'
        $runnerButton.BackColor = [Drawing.Color]::FromArgb(220,252,231)
    } else {
        $runnerButton.Text = '▶  KẾT NỐI GITHUB'
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
        $ui.Panel.BackColor = Get-StatusBackColor $state
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

    Refresh-Timeline
}

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({ Refresh-Ui })
$timer.Start()

Ensure-Config | Out-Null
Refresh-Ui
[void]$form.ShowDialog()
