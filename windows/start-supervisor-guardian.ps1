param(
    [switch]$WaitForHeartbeat
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime = Join-Path $root 'runtime'
$guardian = Join-Path $runtime 'windows\supervisor-guardian.ps1'
$statusPath = Join-Path $root 'guardian-status.json'

if (-not (Test-Path $guardian -PathType Leaf)) {
    throw "Supervisor guardian is missing from installed runtime: $guardian"
}

$existing = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -and
        $_.CommandLine -like '*supervisor-guardian.ps1*' -and
        $_.CommandLine -notlike '*start-supervisor-guardian.ps1*' -and
        $_.CommandLine -like "*$root*"
    } |
    Select-Object -First 1

if ($existing) {
    Write-Host 'SUPERVISOR_GUARDIAN_ALREADY_RUNNING=True'
    Write-Host "SUPERVISOR_GUARDIAN_PID=$($existing.ProcessId)"
} else {
    $env:RUNNER_TRACKING_ID = 'MAGASIN_SUPERVISOR_GUARDIAN_PERSISTENT'
    $process = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @(
        '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $guardian + '"')
    )
    Write-Host 'SUPERVISOR_GUARDIAN_START_REQUESTED=True'
    Write-Host "SUPERVISOR_GUARDIAN_PID=$($process.Id)"
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
                Write-Host "SUPERVISOR_GUARDIAN_WRAPPER_ALIVE=$([bool]$status.wrapper_alive)"
                Write-Host "SUPERVISOR_GUARDIAN_WATCHDOG_ALIVE=$([bool]$status.watchdog_alive)"
                break
            }
        } catch {}
    }
    if (-not $fresh) {
        throw 'Supervisor guardian did not publish a fresh heartbeat within the bounded wait.'
    }
    Write-Host 'SUPERVISOR_GUARDIAN_HEARTBEAT_FRESH=True'
}