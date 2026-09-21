$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$stop = Join-Path $root 'STOP'
$pidFile = Join-Path $root 'supervisor.pid'
$autostartDisabled = Join-Path $root 'AUTOSTART_DISABLED'

function Test-ProcessAlive([int]$ProcessId) {
    return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Stop-DedicatedProcessTree([int]$ProcessId, [string]$Label) {
    if (-not (Test-ProcessAlive $ProcessId)) {
        return
    }

    & taskkill.exe /PID $ProcessId /T /F | Out-Host
    $taskkillExit = $LASTEXITCODE

    # taskkill may report a child-exit race even though the root tree is gone.
    # Root process truth is authoritative; only a surviving root is fatal.
    for ($i = 0; $i -lt 10; $i++) {
        if (-not (Test-ProcessAlive $ProcessId)) {
            if ($taskkillExit -ne 0) {
                Write-Host "STOP_TASKKILL_RACE_RESOLVED=True label=$Label"
            }
            return
        }
        Start-Sleep -Milliseconds 200
    }

    throw "$Label PID $ProcessId is still alive after bounded force-stop."
}

New-Item -ItemType Directory -Force -Path $root | Out-Null
Set-Content -Path $stop -Value 'STOP' -Encoding ascii
Set-Content -Path $autostartDisabled -Value 'OWNER_STOP' -Encoding ascii

$pidValue = $null
if (Test-Path $pidFile) {
    $pidValue = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
}

if ($pidValue) {
    Write-Host "Cooperative STOP requested for Supervisor PID $pidValue."

    for ($i = 0; $i -lt 5; $i++) {
        if (-not (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
            break
        }
        Start-Sleep -Seconds 1
    }

    if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {
        Write-Host "Grace period expired; forcing dedicated Supervisor process tree to stop."
        Stop-DedicatedProcessTree -ProcessId ([int]$pidValue) -Label 'Supervisor wrapper'
    }
}

$rootPattern = "*$root*"

Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -and
        $_.CommandLine -like '*run-supervisor.ps1*' -and
        $_.CommandLine -like $rootPattern
    } |
    ForEach-Object {
        Write-Host "Stopping orphaned Supervisor wrapper PID $($_.ProcessId)."
        Stop-DedicatedProcessTree -ProcessId ([int]$_.ProcessId) -Label 'Orphaned Supervisor wrapper'
    }

Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match '(supervisor-loop-cli|brain-worker-cli|three-lane-cli)\.mjs' } |
    ForEach-Object {
        Write-Host "Stopping orphaned Supervisor Node PID $($_.ProcessId)."
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

$remainingWrapper = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -and
        $_.CommandLine -like '*run-supervisor.ps1*' -and
        $_.CommandLine -like $rootPattern
    } |
    Select-Object -First 1

if ($remainingWrapper) {
    throw "Supervisor STOP refused success because wrapper PID $($remainingWrapper.ProcessId) is still alive."
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host 'MAGASIN Supervisor stopped. Owner STOP latch disables automatic reboot/logon restart until next explicit START.'
