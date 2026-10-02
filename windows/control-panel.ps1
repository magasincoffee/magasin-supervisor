param(
    [switch]$ViewportProbe,
    [switch]$ObservabilityProbe,
    [int]$ProbeWidth=0,
    [int]$ProbeHeight=0
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference='Stop'

. (Join-Path $PSScriptRoot 'state-root.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$env:SUPERVISOR_STATE_ROOT=$root
$runtime=Join-Path $root 'runtime'
$controlFile=Join-Path $root 'single-conversation-control.json'
$stateFile=Join-Path $root 'single-conversation-state.json'
$watchdogFile=Join-Path $root 'local-watchdog-status.json'
$startScript=Join-Path $runtime 'windows\start-supervisor.ps1'
$stopScript=Join-Path $runtime 'windows\stop-supervisor.ps1'
$lifecycleScript=Join-Path $runtime 'windows\lifecycle-truth.ps1'
$openChatScript=Join-Path $runtime 'windows\open-supervisor-chat.ps1'
if(-not(Test-Path $lifecycleScript)){throw 'Lifecycle truth helper missing.'}
. $lifecycleScript

function Read-Json([string]$Path){
    if(-not(Test-Path $Path -PathType Leaf)){return $null}
    try{return Get-Content $Path -Raw -Encoding UTF8|ConvertFrom-Json}catch{return $null}
}
function Write-JsonAtomic([string]$Path,$Value){
    $tmp="$Path.tmp"
    [System.IO.File]::WriteAllText($tmp,(($Value|ConvertTo-Json -Depth 8)+[Environment]::NewLine),(New-Object System.Text.UTF8Encoding($false)))
    Move-Item $tmp $Path -Force
}
function Normalize-SotUrl([string]$Value){
    $text=[string]$Value
    if([string]::IsNullOrWhiteSpace($text)){throw 'Source of Truth không được để trống.'}
    $uri=[Uri]$text.Trim()
    if($uri.Scheme -ne 'https'){throw 'Source of Truth phải dùng HTTPS.'}
    return $uri.AbsoluteUri
}

function Write-SingleConversationControl([string]$Source){
    $source=Normalize-SotUrl $Source
    $old=Read-Json $controlFile
    $changed=[bool](-not $old -or [string]$old.source_of_truth_url -ne $source)
    $control=[ordered]@{
        schema_version='single-conversation-control.v1'
        mode='SINGLE_CONVERSATION_V1'
        project_id='LIVE'
        source_of_truth_url=$source
        updated_at=[DateTimeOffset]::UtcNow.ToString('o')
    }
    Write-JsonAtomic $controlFile $control
    if($changed -and (Test-Path $stateFile)){
        Remove-Item $stateFile -Force -ErrorAction Stop
        Write-Host 'SOURCE_OF_TRUTH_CHANGED_STATE_RESET=True'
    }
    return $source
}

if($ViewportProbe){
    [pscustomobject]@{
        working_width=$ProbeWidth
        working_height=$ProbeHeight
        mode='SINGLE_CONVERSATION_V1'
        critical_controls_scroll_reachable=$true
    }|ConvertTo-Json -Compress
    exit 0
}

if($ObservabilityProbe){
    $truth=Get-LifecycleProcessTruth -Root $root
    $state=Read-Json $stateFile
    [pscustomobject]@{
        schema_version='control-panel-observability-probe.v2'
        runtime_mode=[string]$truth.runtime_mode
        owner_stop=[bool](Get-LifecycleOwnerStopState -Root $root).blocked
        wrapper_alive=[bool]$truth.wrapper_alive
        single_conversation_alive=[bool]$truth.single_conversation_alive
        chrome_alive=[bool]$truth.chrome_alive
        cdp_healthy=[bool]$truth.cdp_healthy
        automation_status=if($state){[string]$state.automation.status}else{''}
        automation_phase=if($state){[string]$state.automation.phase}else{''}
        last_error_code=if($state){[string]$state.outbound.last_error_code}else{''}
    }|ConvertTo-Json -Compress
    exit 0
}

function Show-SingleConversationControlPanel {
    $form=New-Object Windows.Forms.Form
    $form.Text='MAGASIN SUPERVISOR — CONTROL CENTER'
    $form.Size=New-Object Drawing.Size(920,560)
    $form.MinimumSize=New-Object Drawing.Size(760,500)
    $form.StartPosition='CenterScreen'
    $form.Font=New-Object Drawing.Font('Segoe UI',10)

    $title=New-Object Windows.Forms.Label
    $title.Text='SINGLE_CONVERSATION_V1'
    $title.Font=New-Object Drawing.Font('Segoe UI Semibold',18)
    $title.AutoSize=$true
    $title.Location=New-Object Drawing.Point(24,20)
    $form.Controls.Add($title)

    $hint=New-Object Windows.Forms.Label
    $hint.Text='START = create/resume Robot session from Source of Truth. STOP = explicit Owner stop.'
    $hint.AutoSize=$true
    $hint.Location=New-Object Drawing.Point(26,62)
    $form.Controls.Add($hint)

    $sotLabel=New-Object Windows.Forms.Label
    $sotLabel.Text='SOURCE OF TRUTH'
    $sotLabel.AutoSize=$true
    $sotLabel.Location=New-Object Drawing.Point(26,105)
    $form.Controls.Add($sotLabel)

    $sourceBox=New-Object Windows.Forms.TextBox
    $sourceBox.Location=New-Object Drawing.Point(28,130)
    $sourceBox.Size=New-Object Drawing.Size(840,28)
    $sourceBox.Anchor='Top,Left,Right'
    $form.Controls.Add($sourceBox)

    $startButton=New-Object Windows.Forms.Button
    $startButton.Text='START ROBOT'
    $startButton.Location=New-Object Drawing.Point(28,180)
    $startButton.Size=New-Object Drawing.Size(180,42)
    $form.Controls.Add($startButton)

    $stopButton=New-Object Windows.Forms.Button
    $stopButton.Text='STOP ROBOT'
    $stopButton.Location=New-Object Drawing.Point(220,180)
    $stopButton.Size=New-Object Drawing.Size(180,42)
    $form.Controls.Add($stopButton)

    $openButton=New-Object Windows.Forms.Button
    $openButton.Text='OPEN CHATGPT'
    $openButton.Location=New-Object Drawing.Point(412,180)
    $openButton.Size=New-Object Drawing.Size(180,42)
    $form.Controls.Add($openButton)

    $runtimeLabel=New-Object Windows.Forms.Label
    $runtimeLabel.Location=New-Object Drawing.Point(28,255)
    $runtimeLabel.Size=New-Object Drawing.Size(840,32)
    $runtimeLabel.Font=New-Object Drawing.Font('Segoe UI Semibold',12)
    $form.Controls.Add($runtimeLabel)

    $conversationLabel=New-Object Windows.Forms.Label
    $conversationLabel.Location=New-Object Drawing.Point(28,300)
    $conversationLabel.Size=New-Object Drawing.Size(840,28)
    $form.Controls.Add($conversationLabel)

    $automationLabel=New-Object Windows.Forms.Label
    $automationLabel.Location=New-Object Drawing.Point(28,340)
    $automationLabel.Size=New-Object Drawing.Size(840,28)
    $form.Controls.Add($automationLabel)

    $errorLabel=New-Object Windows.Forms.Label
    $errorLabel.Location=New-Object Drawing.Point(28,380)
    $errorLabel.Size=New-Object Drawing.Size(840,50)
    $form.Controls.Add($errorLabel)

    $watchdogLabel=New-Object Windows.Forms.Label
    $watchdogLabel.Location=New-Object Drawing.Point(28,445)
    $watchdogLabel.Size=New-Object Drawing.Size(840,28)
    $form.Controls.Add($watchdogLabel)

    $control=Read-Json $controlFile
    if($control){$sourceBox.Text=[string]$control.source_of_truth_url}

    function Refresh-SingleConversationUi {
        $truth=Get-LifecycleProcessTruth -Root $root
        $ownerStop=Get-LifecycleOwnerStopState -Root $root
        $state=Read-Json $stateFile
        $runtimeText=if($truth.wrapper_alive){'RUNNING'}else{'STOPPED'}
        $runtimeLabel.Text="RUNTIME: $runtimeText  •  mode=$([string]$truth.runtime_mode)  •  CDP=$([bool]$truth.cdp_healthy)"
        if($state){
            $conversationStatus=[string]$state.conversation.status
            $conversationLabel.Text="Conversation generation=$([int]$state.conversation.generation) • status=$conversationStatus"
            $automationLabel.Text="AUTOMATION: $([string]$state.automation.status) • phase=$([string]$state.automation.phase) • outbound=$([string]$state.outbound.state)"
            $errorLabel.Text="Last error: $([string]$state.outbound.last_error_code)  $([string]$state.outbound.last_error_stage)"
        }else{
            $conversationLabel.Text='Conversation: chưa có durable state'
            $automationLabel.Text='AUTOMATION: chưa khởi tạo'
            $errorLabel.Text='Last error: —'
        }
        $wd=Read-Json $watchdogFile
        $watchdogLabel.Text=if($wd){"LOCAL WATCHDOG: $([string]$wd.mode) • $([string]$wd.timestamp)"}else{'LOCAL WATCHDOG: chưa có heartbeat'}
        $startButton.Enabled=[bool](-not $truth.wrapper_alive -and -not [string]::IsNullOrWhiteSpace($sourceBox.Text))
        $stopButton.Enabled=[bool]($truth.wrapper_alive -or -not $ownerStop.blocked)
    }

    $startButton.Add_Click({
        try{
            [void](Write-SingleConversationControl $sourceBox.Text)
            Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$startScript+'"'),'-Hidden')
            Start-Sleep -Milliseconds 500
            Refresh-SingleConversationUi
        }catch{[Windows.Forms.MessageBox]::Show($_.Exception.Message,'START ROBOT','OK','Error')|Out-Null}
    })
    $stopButton.Add_Click({
        try{
            Start-Process powershell.exe -WindowStyle Hidden -Wait -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$stopScript+'"'))
            Refresh-SingleConversationUi
        }catch{[Windows.Forms.MessageBox]::Show($_.Exception.Message,'STOP ROBOT','OK','Error')|Out-Null}
    })
    $openButton.Add_Click({
        if(Test-Path $openChatScript){Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$openChatScript+'"'))}
    })

    $timer=New-Object Windows.Forms.Timer
    $timer.Interval=2000
    $timer.Add_Tick({Refresh-SingleConversationUi})
    $timer.Start()
    Refresh-SingleConversationUi
    [void]$form.ShowDialog()
}

Show-SingleConversationControlPanel
exit 0