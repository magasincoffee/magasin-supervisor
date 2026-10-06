param(
    [switch]$StartNow
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime = Join-Path $root 'runtime'
$bootstrap = Join-Path $runtime 'windows\autostart-bootstrap.ps1'
$watchdogStart = Join-Path $runtime 'windows\start-local-watchdog.ps1'
$guardianStart = Join-Path $runtime 'windows\start-supervisor-guardian.ps1'
$disabled = Join-Path $root 'AUTOSTART_DISABLED'
$statusPath = Join-Path $root 'autostart-install-status.json'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'MAGASINBusinessOSAutostart'
$watchdogRunName = 'MAGASINSupervisorLocalWatchdog'
$guardianRunName = 'MAGASINSupervisorGuardian'

if (-not (Test-Path $bootstrap)) {
    throw "Autostart bootstrap is missing from installed runtime: $bootstrap"
}
if (-not (Test-Path $watchdogStart)) {
    throw "Local watchdog launcher is missing from installed runtime: $watchdogStart"
}
if (-not (Test-Path $guardianStart)) {
    throw "Supervisor guardian launcher is missing from installed runtime: $guardianStart"
}

New-Item -ItemType Directory -Force -Path $root | Out-Null
New-Item -Path $runKey -Force | Out-Null

$command = 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $bootstrap + '"'
$watchdogCommand = 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $watchdogStart + '"'
$guardianCommand = 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $guardianStart + '"'
Set-ItemProperty -Path $runKey -Name $runName -Value $command -Type String
Set-ItemProperty -Path $runKey -Name $watchdogRunName -Value $watchdogCommand -Type String
Set-ItemProperty -Path $runKey -Name $guardianRunName -Value $guardianCommand -Type String

# Installing the recovery registration must never clear an Owner STOP latch.
# Only explicit Owner START may clear AUTOSTART_DISABLED.
if (Test-Path $disabled) {
    Write-Host 'OWNER_STOP_PRESERVED_DURING_AUTOSTART_INSTALL=True'
}

$stored = (Get-ItemProperty -Path $runKey -Name $runName -ErrorAction Stop).$runName
$watchdogStored = (Get-ItemProperty -Path $runKey -Name $watchdogRunName -ErrorAction Stop).$watchdogRunName
$guardianStored = (Get-ItemProperty -Path $runKey -Name $guardianRunName -ErrorAction Stop).$guardianRunName
if ($stored -ne $command) {
    throw 'Failed to verify HKCU Run autostart registration.'
}
if ($watchdogStored -ne $watchdogCommand) {
    throw 'Failed to verify local watchdog HKCU Run registration.'
}
if ($guardianStored -ne $guardianCommand) {
    throw 'Failed to verify Supervisor guardian HKCU Run registration.'
}

$status = [ordered]@{
    installed_at = [DateTimeOffset]::UtcNow.ToString('o')
    mechanism = 'HKCU_RUN_AT_USER_LOGON'
    registry_name = $runName
    bootstrap_path = $bootstrap
    watchdog_registry_name = $watchdogRunName
    watchdog_launcher_path = $watchdogStart
    guardian_registry_name = $guardianRunName
    guardian_launcher_path = $guardianStart
    owner_stop_latch = $disabled
    windows_session_required = $true
    bypass_windows_login = $false
    verified = $true
}
$status | ConvertTo-Json | Set-Content -Path $statusPath -Encoding UTF8

Write-Host "Autostart registered: $runName"
Write-Host "Local watchdog autostart registered: $watchdogRunName"
Write-Host "Supervisor guardian autostart registered: $guardianRunName"
Write-Host 'Recovery boundary: Windows user logon is required for Chrome/ChatGPT automation.'
Write-Host 'Owner STOP creates AUTOSTART_DISABLED; only explicit Owner START clears it.'

if ($StartNow) {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $watchdogStart -WaitForHeartbeat
    if ($LASTEXITCODE -ne 0) {
        throw "Local watchdog StartNow failed with exit code $LASTEXITCODE."
    }

    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $guardianStart -WaitForHeartbeat
    if ($LASTEXITCODE -ne 0) {
        throw "Supervisor guardian StartNow failed with exit code $LASTEXITCODE."
    }

    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $bootstrap
    if ($LASTEXITCODE -ne 0) {
        throw "Autostart bootstrap StartNow failed with exit code $LASTEXITCODE."
    }
}