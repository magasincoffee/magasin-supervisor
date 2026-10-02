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

. (Join-Path $PSScriptRoot 'state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$env:SUPERVISOR_STATE_ROOT = $root
$runtime = Join-Path $root 'runtime'
$singleConversationControlFile = Join-Path $root 'single-conversation-control.json'
$singleConversationStateFile = Join-Path $root 'single-conversation-state.json'
$startScript = Join-Path $runtime 'windows\start-supervisor.ps1'
$stopScript = Join-Path $runtime 'windows\stop-supervisor.ps1'
$lifecycleScript = Join-Path $runtime 'windows\lifecycle-truth.ps1'

if (-not (Test-Path $lifecycleScript -PathType Leaf)) {
    throw "Không tìm thấy lifecycle truth helper: $lifecycleScript"
}
. $lifecycleScript

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path $Path -PathType Leaf)) { return $null }
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

function ConvertTo-CanonicalSourceOfTruthUrl([string]$Url) {
    if ([string]::IsNullOrWhiteSpace($Url)) {
        throw 'Source of Truth URL trống.'
    }
    $uri = [Uri]$Url.Trim()
    if ($uri.Scheme -ne 'https' -or [string]::IsNullOrWhiteSpace($uri.Host)) {
        throw 'Source of Truth phải là URL https hợp lệ.'
    }
    if ($uri.UserInfo) {
        throw 'Source of Truth URL không được chứa username/password.'
    }
    return $uri.AbsoluteUri
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
    $subtitle.Text = 'SINGLE CONVERSATION  •  PERSISTENT SOURCE OF TRUTH'
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
        if (
            $previousSource -and
            $previousSource -ne $source -and
            (Test-Path $singleConversationStateFile -PathType Leaf)
        ) {
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
                $configuredSource = [string](
                    Get-OptionalPropertyValue (
                        Get-OptionalPropertyValue $state 'source_of_truth' $null
                    ) 'url' ''
                )
            }
            if ($configuredSource) {
                $sourceBox.Text = $configuredSource
            }
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
            [int](Get-OptionalPropertyValue (
                Get-OptionalPropertyValue $state 'conversation' $null
            ) 'generation' 0)
        } else { 0 }
        $conversationStatus = if ($state) {
            [string](Get-OptionalPropertyValue (
                Get-OptionalPropertyValue $state 'conversation' $null
            ) 'status' 'NONE')
        } else { 'NONE' }
        $conversationValue.Text = "CONVERSATION: generation=$generation  •  status=$conversationStatus"

        $automationStatus = if ($state) {
            [string](Get-OptionalPropertyValue (
                Get-OptionalPropertyValue $state 'automation' $null
            ) 'status' 'STOPPED')
        } else { 'STOPPED' }
        $phase = if ($state) {
            [string](Get-OptionalPropertyValue (
                Get-OptionalPropertyValue $state 'automation' $null
            ) 'phase' 'STOPPED')
        } else { 'STOPPED' }
        $automationValue.Text = "AUTOMATION: $automationStatus  •  phase=$phase"

        $syncStatus = if ($state) {
            [string](Get-OptionalPropertyValue (
                Get-OptionalPropertyValue $state 'source_of_truth' $null
            ) 'sync_status' 'UNVERIFIED')
        } else { 'UNVERIFIED' }
        $syncValue.Text =
            "SOURCE OF TRUTH SYNC: $syncStatus  •  Chat URLs are disposable diagnostics and are not persisted."
    }

    $sourceBox.Add_TextChanged({ Refresh-SingleConversationUi })

    $startButton.Add_Click({
        try {
            [void](Write-SingleConversationControl ($sourceBox.Text.Trim()))
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

Show-SingleConversationControlPanel
exit 0
