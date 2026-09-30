param(
    [switch]$WaitForHeartbeat
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime = Join-Path $root 'runtime'
$watchdog = Join-Path $runtime 'windows\local-watchdog.ps1'
$statusPath = Join-Path $root 'local-watchdog-status.json'

if (-not (Test-Path $watchdog -PathType Leaf)) {
    throw "Local watchdog is missing from installed runtime: $watchdog"
}

$existing = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -and
        $_.CommandLine -like '*local-watchdog.ps1*' -and
        $_.CommandLine -like "*$root*"
    } |
    Select-Object -First 1

if ($existing) {
    Write-Host "LOCAL_WATCHDOG_ALREADY_RUNNING=True"
    Write-Host "LOCAL_WATCHDOG_PID=$($existing.ProcessId)"
} else {
    $env:RUNNER_TRACKING_ID = 'MAGASIN_LOCAL_WATCHDOG_PERSISTENT'
    $process = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        ('"' + $watchdog + '"')
    )
    Write-Host 'LOCAL_WATCHDOG_START_REQUESTED=True'
    Write-Host "LOCAL_WATCHDOG_PID=$($process.Id)"
}

if ($WaitForHeartbeat) {
    $fresh = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if (-not (Test-Path $statusPath -PathType Leaf)) { continue }
        try {
            $status = Get-Content $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $age = ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$status.timestamp)).TotalSeconds
            if ($age -le 15) {
                $fresh = $true
                Write-Host "LOCAL_WATCHDOG_MODE=$([string]$status.mode)"
                break
            }
        } catch {}
    }
    if (-not $fresh) {
        throw 'Local watchdog did not publish a fresh heartbeat within the bounded wait.'
    }
    Write-Host 'LOCAL_WATCHDOG_HEARTBEAT_FRESH=True'
}
