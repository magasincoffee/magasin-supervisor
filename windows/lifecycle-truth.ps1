Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'state-root.ps1')

function Get-MagasinSupervisorRoot {
    return (Get-SupervisorStateRoot -Compatibility 'legacy-preserve')
}

function Read-LifecycleJson([string]$Path) {
    if (-not (Test-Path $Path -PathType Leaf)) { return $null }
    try { return Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Get-LifecycleOwnerStopState([string]$Root = (Get-MagasinSupervisorRoot)) {
    $stopPath = Join-Path $Root 'STOP'
    $disabledPath = Join-Path $Root 'AUTOSTART_DISABLED'
    $stopPresent = Test-Path $stopPath
    $disabledPresent = Test-Path $disabledPath
    return [pscustomobject]@{
        stop_present = [bool]$stopPresent
        autostart_disabled_present = [bool]$disabledPresent
        blocked = [bool]($stopPresent -or $disabledPresent)
    }
}

function Clear-LifecycleOwnerStopLatches([string]$Root = (Get-MagasinSupervisorRoot)) {
    foreach ($path in @((Join-Path $Root 'STOP'),(Join-Path $Root 'AUTOSTART_DISABLED'))) {
        if (Test-Path $path) { Remove-Item $path -Force -ErrorAction Stop }
    }
    $state = Get-LifecycleOwnerStopState -Root $Root
    if ($state.blocked) { throw 'Explicit START could not clear STOP/AUTOSTART_DISABLED.' }
    return $state
}

function Get-LifecycleSingleConversationControl([string]$Root = (Get-MagasinSupervisorRoot)) {
    $control = Read-LifecycleJson (Join-Path $Root 'single-conversation-control.json')
    if (-not $control) { return $null }
    if ([string]$control.schema_version -ne 'single-conversation-control.v1') { return $null }
    if ([string]$control.mode -ne 'SINGLE_CONVERSATION_V1') { return $null }
    if ([string]::IsNullOrWhiteSpace([string]$control.source_of_truth_url)) { return $null }
    return $control
}

function Get-LifecycleRuntimeMode([string]$Root = (Get-MagasinSupervisorRoot)) {
    if (Get-LifecycleSingleConversationControl -Root $Root) { return 'SINGLE_CONVERSATION_V1' }
    return $null
}

function Get-LifecycleSupervisorWrapper([string]$Root = (Get-MagasinSupervisorRoot)) {
    return Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like '*run-supervisor.ps1*' -and
            $_.CommandLine -like "*$Root*"
        } |
        Select-Object -First 1
}

function Get-LifecycleSingleConversationProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*single-conversation-cli.mjs*' })
}

function Get-LifecycleSingleConversationProcess([string]$Root = (Get-MagasinSupervisorRoot)) {
    $wrapper = Get-LifecycleSupervisorWrapper -Root $Root
    if (-not $wrapper) { return $null }
    $wrapperPid = [int]$wrapper.ProcessId
    return Get-LifecycleSingleConversationProcesses |
        Where-Object { [int]$_.ParentProcessId -eq $wrapperPid } |
        Select-Object -First 1
}

function Get-LifecycleRobotChrome([string]$Root = (Get-MagasinSupervisorRoot)) {
    $profile = Join-Path $Root 'browser_profile'
    return Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like "*$profile*" -and
            $_.CommandLine -match '--remote-debugging-port=(\d+)'
        } |
        Select-Object -First 1
}

function Test-LifecycleRobotCdp($ChromeProcess,[string]$Root = (Get-MagasinSupervisorRoot)) {
    if (-not $ChromeProcess -or -not $ChromeProcess.CommandLine) { return $false }
    if ($ChromeProcess.CommandLine -notmatch '--remote-debugging-port=(\d+)') { return $false }
    $port = [int]$Matches[1]
    try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
        return [bool]$version.webSocketDebuggerUrl
    } catch { return $false }
}

function Get-LifecycleProcessTruth([string]$Root = (Get-MagasinSupervisorRoot)) {
    $wrapper = Get-LifecycleSupervisorWrapper -Root $Root
    $single = Get-LifecycleSingleConversationProcess -Root $Root
    $chrome = Get-LifecycleRobotChrome -Root $Root
    $cdp = Test-LifecycleRobotCdp -ChromeProcess $chrome -Root $Root
    $mode = Get-LifecycleRuntimeMode -Root $Root
    return [pscustomobject]@{
        runtime_mode = [string]$mode
        wrapper_alive = [bool]$wrapper
        runtime_alive = [bool]$single
        single_conversation_alive = [bool]$single
        chrome_alive = [bool]$chrome
        cdp_healthy = [bool]$cdp
        healthy = [bool]($mode -eq 'SINGLE_CONVERSATION_V1' -and $wrapper -and $single -and $chrome -and $cdp)
    }
}

function Invoke-LifecycleRecoveryStart([string]$StartScript,[string]$Root = (Get-MagasinSupervisorRoot)) {
    if (-not (Get-LifecycleSingleConversationControl -Root $Root)) {
        return [pscustomobject]@{ state='UNCONFIGURED'; start_requested=$false }
    }
    $ownerStop = Get-LifecycleOwnerStopState -Root $Root
    if ($ownerStop.blocked) { return [pscustomobject]@{ state='OWNER_STOP'; start_requested=$false } }
    $truth = Get-LifecycleProcessTruth -Root $Root
    if ($truth.healthy) { return [pscustomobject]@{ state='HEALTHY'; start_requested=$false } }
    if (-not $truth.wrapper_alive) {
        if (-not (Test-Path $StartScript)) { return [pscustomobject]@{ state='RUNTIME_MISSING'; start_requested=$false } }
        Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
            '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $StartScript + '"'),'-Hidden','-Recovery'
        )
        return [pscustomobject]@{ state='STARTING'; start_requested=$true }
    }
    return [pscustomobject]@{ state='RECOVERING'; start_requested=$false }
}