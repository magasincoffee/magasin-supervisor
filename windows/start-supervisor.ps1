param(
    [switch]$DryRun,
    [switch]$Hidden,
    [switch]$Recovery
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$env:SUPERVISOR_STATE_ROOT = $root
$runtime = Join-Path $root 'runtime'
$runScript = Join-Path $runtime 'windows\run-supervisor.ps1'
$lifecycleScript = Join-Path $runtime 'windows\lifecycle-truth.ps1'
$pidFile = Join-Path $root 'supervisor.pid'
$startStatusFile = Join-Path $root 'start-attempt-status.json'
$wrapperStdoutLog = Join-Path $root 'wrapper-startup.stdout.log'
$wrapperStderrLog = Join-Path $root 'wrapper-startup.stderr.log'

function Write-StartAttemptStatus([string]$Status,[int]$ProcessId=0,[string]$Reason='') {
    $payload = [ordered]@{
        schema_version = 'supervisor-start-attempt.v1'
        status = $Status
        process_id = $ProcessId
        reason = $Reason
        recovery = [bool]$Recovery
        recorded_at = [DateTimeOffset]::UtcNow.ToString('o')
    }
    [System.IO.File]::WriteAllText(
        $startStatusFile,
        (($payload | ConvertTo-Json -Depth 4) + [Environment]::NewLine),
        (New-Object System.Text.UTF8Encoding($false))
    )
}

foreach($required in @($runScript,$lifecycleScript)){
    if(-not (Test-Path $required -PathType Leaf)){ throw "Supervisor runtime is not installed: $required" }
}
. $lifecycleScript

$control = Get-LifecycleSingleConversationControl -Root $root
if(-not $control){
    Write-StartAttemptStatus -Status 'UNCONFIGURED' -Reason 'SINGLE_CONVERSATION_CONTROL_MISSING'
    throw 'SINGLE_CONVERSATION_V1 control record is required before START.'
}

if($Recovery){
    $ownerStop = Get-LifecycleOwnerStopState -Root $root
    if($ownerStop.blocked){
        Write-Host 'RECOVERY_START_BLOCKED_OWNER_STOP=True'
        Write-StartAttemptStatus -Status 'RECOVERY_BLOCKED_OWNER_STOP'
        exit 0
    }
} else {
    [void](Clear-LifecycleOwnerStopLatches -Root $root)
    Write-Host 'OWNER_START_LATCH_CLEAR=True'
}

$existingWrapper = Get-LifecycleSupervisorWrapper -Root $root
if($existingWrapper){
    Set-Content -Path $pidFile -Value $existingWrapper.ProcessId -Encoding ascii
    Write-StartAttemptStatus -Status 'WRAPPER_REUSED' -ProcessId ([int]$existingWrapper.ProcessId)
    Write-Host "Supervisor wrapper already running (PID $($existingWrapper.ProcessId))."
    exit 0
}

if(Test-Path $pidFile){
    $existing = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    $parsed = 0
    if($existing -and [int]::TryParse([string]$existing,[ref]$parsed)){
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$parsed" -ErrorAction SilentlyContinue | Select-Object -First 1
        if($process -and $process.CommandLine -and $process.CommandLine -like '*run-supervisor.ps1*' -and $process.CommandLine -like "*$root*"){
            Set-Content -Path $pidFile -Value $parsed -Encoding ascii
            Write-StartAttemptStatus -Status 'WRAPPER_REUSED' -ProcessId $parsed
            exit 0
        }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

$env:RUNNER_TRACKING_ID = 'MAGASIN_SUPERVISOR_PERSISTENT'
$args = @('-NoLogo','-ExecutionPolicy','Bypass','-File',('"' + $runScript + '"'))
if($DryRun){ $args += '-DryRun' }

if($Hidden){
    Remove-Item $wrapperStdoutLog,$wrapperStderrLog -Force -ErrorAction SilentlyContinue
    Write-StartAttemptStatus -Status 'LAUNCH_REQUESTED'
    $started = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList $args `
        -RedirectStandardOutput $wrapperStdoutLog -RedirectStandardError $wrapperStderrLog
    Write-StartAttemptStatus -Status 'PROCESS_CREATED' -ProcessId ([int]$started.Id)

    $observed = $null
    for($i=0;$i -lt 12;$i++){
        Start-Sleep -Milliseconds 150
        $observed = Get-LifecycleSupervisorWrapper -Root $root
        if($observed){ break }
        if(-not (Get-Process -Id $started.Id -ErrorAction SilentlyContinue)){ break }
    }
    if($observed){
        Set-Content -Path $pidFile -Value $observed.ProcessId -Encoding ascii
        Write-StartAttemptStatus -Status 'WRAPPER_OBSERVED' -ProcessId ([int]$observed.ProcessId)
        Write-Host "MAGASIN Supervisor started in background mode (PID $($observed.ProcessId))."
        exit 0
    }

    if(-not (Get-Process -Id $started.Id -ErrorAction SilentlyContinue)){
        $stderrTail = ''
        if(Test-Path $wrapperStderrLog){ $stderrTail = (Get-Content $wrapperStderrLog | Select-Object -Last 8) -join ' | ' }
        $reason = if($stderrTail){$stderrTail}else{'wrapper exited before lifecycle observation'}
        Write-StartAttemptStatus -Status 'EXITED_EARLY' -ProcessId ([int]$started.Id) -Reason $reason
        throw "Supervisor wrapper exited during START: $reason"
    }

    Write-StartAttemptStatus -Status 'PROCESS_ALIVE_WRAPPER_PENDING' -ProcessId ([int]$started.Id)
    Write-Host "MAGASIN Supervisor process created; wrapper observation is pending (PID $($started.Id))."
    exit 0
}

$visibleArgs = @('-NoLogo','-NoExit','-ExecutionPolicy','Bypass','-File',('"' + $runScript + '"'))
if($DryRun){ $visibleArgs += '-DryRun' }
Start-Process powershell.exe -ArgumentList $visibleArgs
Write-Host 'MAGASIN Supervisor started in a separate PowerShell window.'