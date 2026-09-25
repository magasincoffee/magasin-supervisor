param(
    [string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$root = Set-SupervisorStateRootBinding -Root $root
$runtime = Join-Path $root 'runtime'
$pidFile = Join-Path $root 'supervisor.pid'
$stopFile = Join-Path $root 'STOP'
$autostartDisabled = Join-Path $root 'AUTOSTART_DISABLED'
$ownerStopWasPresent = [bool]((Test-Path $stopFile) -or (Test-Path $autostartDisabled))
$desktop = [Environment]::GetFolderPath('Desktop')

New-Item -ItemType Directory -Force -Path $root | Out-Null

# Close any existing control-panel process before replacing the runtime. The
# desktop shortcut used to set runtime as its working directory, which keeps
# that directory locked on Windows even after the Supervisor itself stops.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*control-panel.ps1*' } |
    ForEach-Object {
        Write-Host "Stopping existing control panel PID $($_.ProcessId) before runtime upgrade."
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
Start-Sleep -Milliseconds 500

# Stop every Supervisor wrapper that points at the installed local runtime.
# A stale/missing pid file must not leave an orphaned loop alive during upgrade.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -and
        $_.CommandLine -like '*run-supervisor.ps1*' -and
        $_.CommandLine -like "*$root*"
    } |
    ForEach-Object {
        Write-Host "Stopping orphaned Supervisor wrapper PID $($_.ProcessId) before runtime upgrade."
        & taskkill.exe /PID $_.ProcessId /T /F | Out-Host
    }

Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match '(supervisor-loop-cli|brain-worker-cli|three-lane-cli)\.mjs' } |
    ForEach-Object {
        Write-Host "Stopping orphaned Supervisor Node PID $($_.ProcessId) before runtime upgrade."
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Start-Sleep -Milliseconds 500

# Upgrades are allowed only after stopping the dedicated Supervisor process.
if (Test-Path $pidFile) {
    $pidValue = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pidValue -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
        Write-Host "Stopping existing Supervisor PID $pidValue before runtime upgrade."
        & taskkill.exe /PID $pidValue /T /F | Out-Host
        Start-Sleep -Seconds 1
    }
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
# Installation is process replacement, not an Owner START. Preserve STOP/AUTOSTART_DISABLED exactly as found.
if ($ownerStopWasPresent) { Write-Host 'OWNER_STOP_PRESERVED_DURING_INSTALL=True' }

if (Test-Path $runtime) {
    $removed = $false
    for ($i = 0; $i -lt 8; $i++) {
        try {
            Remove-Item $runtime -Recurse -Force -ErrorAction Stop
            $removed = $true
            break
        } catch {
            if ($i -ge 7) { throw }
            Start-Sleep -Milliseconds 750
        }
    }
    if (-not $removed -and (Test-Path $runtime)) {
        throw "Could not replace Supervisor runtime after bounded retries."
    }
}

New-Item -ItemType Directory -Force -Path $runtime | Out-Null

Copy-Item (Join-Path $SourceRoot 'src') (Join-Path $runtime 'src') -Recurse -Force
Copy-Item (Join-Path $SourceRoot 'windows') (Join-Path $runtime 'windows') -Recurse -Force
Copy-Item (Join-Path $SourceRoot 'package.json') (Join-Path $runtime 'package.json') -Force

Push-Location $runtime
try {
    npm install --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
} finally {
    Pop-Location
}

$panelTarget = Join-Path $runtime 'windows\control-panel.ps1'
if (-not (Test-Path $panelTarget)) {
    throw "Control panel is missing from installed runtime: $panelTarget"
}

# Windows PowerShell 5.1 treats UTF-8 files without BOM as the active ANSI
# code page. The panel contains Vietnamese UI text, so normalize it to UTF-8
# with BOM before PowerShell executes it.
$panelText = Get-Content $panelTarget -Raw -Encoding UTF8
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($panelTarget, $panelText, $utf8Bom)

# Fail installation instead of leaving a desktop shortcut to a broken script.
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
    $panelTarget,
    [ref]$null,
    [ref]$parseErrors
) | Out-Null
if ($parseErrors.Count -gt 0) {
    $summary = ($parseErrors | ForEach-Object {
        "$($_.Message) at line $($_.Extent.StartLineNumber)"
    }) -join '; '
    throw "Control panel PowerShell syntax check failed: $summary"
}

# The unified control panel replaces old separate START/STOP launchers and the
# unrelated SAYDI panel that may have been installed by another repository.
@(
    'START_MAGASIN_SUPERVISOR.cmd',
    'STOP_MAGASIN_SUPERVISOR.cmd',
    'START_MAGASIN_SUPERVISOR.lnk',
    'STOP_MAGASIN_SUPERVISOR.lnk',
    'SAYDI CONTROL.lnk',
    'MAGASIN BUSINESS OS CONTROL.lnk'
) | ForEach-Object {
    $old = Join-Path $desktop $_
    if (Test-Path $old) {
        Remove-Item $old -Force -ErrorAction SilentlyContinue
    }
}

$shortcutDisplayName = 'MAGASIN SUPERVISOR ' + [char]0x2014 + ' CONTROL CENTER.lnk'
$shortcutPath = Join-Path $desktop $shortcutDisplayName
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = 'powershell.exe'
$shortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $panelTarget + '"'
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'MAGASIN Supervisor Control Center V2'
$shortcut.IconLocation = "$env:SystemRoot\System32\imageres.dll,72"
$shortcut.Save()

Write-Host "Installed runtime: $runtime"
Write-Host "Unified control panel: $shortcutPath"
Write-Host 'Old separate START/STOP and unrelated SAYDI desktop shortcuts were removed when present.'
