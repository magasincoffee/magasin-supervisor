param(
    [string]$Url = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'state-root.ps1')

$root = Get-SupervisorStateRoot
$profile = Join-Path $root 'browser_profile'
$targetFile = Join-Path $root 'target.json'
$orchestrationFile = Join-Path $root 'orchestration.json'

function Resolve-ChromeExecutable {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe' }),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    ) | Where-Object { $_ -and (Test-Path $_) }

    return $candidates | Select-Object -First 1
}

function Get-DedicatedChromeProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" })
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MagasinSupervisorChromeWindow {
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@

function Show-DedicatedChromeWindow {
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        foreach ($candidate in (Get-DedicatedChromeProcesses)) {
            $process = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
            if ($process -and $process.MainWindowHandle -ne [IntPtr]::Zero) {
                [MagasinSupervisorChromeWindow]::ShowWindowAsync($process.MainWindowHandle, 9) | Out-Null
                Start-Sleep -Milliseconds 100
                [MagasinSupervisorChromeWindow]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
                return $true
            }
        }
        Start-Sleep -Milliseconds 100
    }
    return $false
}

function Get-FreeCdpPort {
    foreach ($candidate in 9222..9232) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $listener) { return $candidate }
    }
    throw 'No free Supervisor CDP port in range 9222-9232.'
}

function Test-ExplicitChatUrl([string]$Value) {
    if (-not $Value) { return $false }
    try {
        $uri = [Uri]$Value
        return (
            $uri.Scheme -eq 'https' -and
            $uri.Host -match '(^|\.)chatgpt\.com$' -and
            $uri.AbsolutePath -match '^/(c|g|project)/'
        )
    } catch {
        return $false
    }
}

function Resolve-TargetUrl {
    if (Test-ExplicitChatUrl $Url) {
        return $Url
    }

    # Compatibility fallback for the superseded Brain/Worker runtime.
    if (Test-Path $orchestrationFile) {
        try {
            $orchestration = Get-Content $orchestrationFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $brain = $orchestration.brain.target
            if (
                $brain.origin -eq 'https://chatgpt.com' -and
                [string]$brain.pathname -match '^/(c|g|project)/'
            ) {
                return "$($brain.origin)$($brain.pathname)"
            }
        } catch {}
    }

    # Compatibility fallback for the legacy single-conversation runtime.
    if (Test-Path $targetFile) {
        try {
            $target = Get-Content $targetFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if (
                $target.origin -eq 'https://chatgpt.com' -and
                [string]$target.pathname -match '^/(c|g|project)/'
            ) {
                return "$($target.origin)$($target.pathname)"
            }
        } catch {}
    }

    return 'https://chatgpt.com/'
}

$chrome = Resolve-ChromeExecutable
if (-not $chrome) {
    throw 'Google Chrome executable was not found.'
}

New-Item -ItemType Directory -Force -Path $profile | Out-Null
$urlToOpen = Resolve-TargetUrl
$existing = Get-DedicatedChromeProcesses | Select-Object -First 1

if ($existing) {
    Start-Process -FilePath $chrome -ArgumentList @(
        ('--user-data-dir="' + $profile + '"'),
        $urlToOpen
    )
    Show-DedicatedChromeWindow | Out-Null
    exit 0
}

$port = Get-FreeCdpPort
Start-Process -FilePath $chrome -ArgumentList @(
    '--remote-debugging-address=127.0.0.1',
    "--remote-debugging-port=$port",
    ('--user-data-dir="' + $profile + '"'),
    '--no-first-run',
    '--no-default-browser-check',
    $urlToOpen
)

Show-DedicatedChromeWindow | Out-Null
