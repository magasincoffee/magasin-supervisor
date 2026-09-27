$script:ChatGptBridgePinnedRepository = 'https://github.com/OLmatter/chatgpt-bridge.git'
$script:ChatGptBridgePinnedCommit = '848efb9e85f52f251c82ab099747833c0693c072'

function Get-ChatGptBridgeRuntimeInfo {
    param([Parameter(Mandatory=$true)][string]$Root)

    $bridgeBase = Join-Path $Root 'bridge'
    $repoRoot = Join-Path $bridgeBase 'chatgpt-bridge'
    $venvRoot = Join-Path $bridgeBase '.venv'
    return [pscustomobject]@{
        BridgeBase = $bridgeBase
        RepoRoot = $repoRoot
        VenvRoot = $venvRoot
        Python = Join-Path $venvRoot 'Scripts\python.exe'
        Marker = Join-Path $repoRoot '.magasin-upstream-commit'
        Stdout = Join-Path $bridgeBase 'bridge.stdout.log'
        Stderr = Join-Path $bridgeBase 'bridge.stderr.log'
    }
}

function Test-ChatGptBridgeHealth {
    try {
        $status = Invoke-RestMethod -Uri 'http://127.0.0.1:5000/status' -TimeoutSec 2
        return [bool](
            $null -ne $status -and
            $null -ne $status.pages_connected -and
            -not [bool]$status.supervisor_running
        )
    } catch {
        return $false
    }
}

function Assert-ChatGptBridgePinnedInstall {
    param([Parameter(Mandatory=$true)][string]$Root)
    $info = Get-ChatGptBridgeRuntimeInfo -Root $Root
    if (-not (Test-Path $info.RepoRoot -PathType Container)) {
        throw "Pinned ChatGPT Bridge is not installed: $($info.RepoRoot)"
    }
    if (-not (Test-Path $info.Python -PathType Leaf)) {
        throw "Pinned ChatGPT Bridge Python venv is missing: $($info.Python)"
    }
    if (-not (Test-Path $info.Marker -PathType Leaf)) {
        throw 'Pinned ChatGPT Bridge commit marker is missing.'
    }
    $marker = (Get-Content $info.Marker -Raw -Encoding UTF8).Trim()
    if ($marker -ne $script:ChatGptBridgePinnedCommit) {
        throw "ChatGPT Bridge pin mismatch: expected $($script:ChatGptBridgePinnedCommit), got $marker"
    }
    return $info
}

function Install-ChatGptBridgeRuntime {
    param([Parameter(Mandatory=$true)][string]$Root)

    $info = Get-ChatGptBridgeRuntimeInfo -Root $Root
    if (
        (Test-Path $info.Marker -PathType Leaf) -and
        (Test-Path $info.Python -PathType Leaf)
    ) {
        $marker = (Get-Content $info.Marker -Raw -Encoding UTF8).Trim()
        if ($marker -eq $script:ChatGptBridgePinnedCommit) {
            Write-Host "CHATGPT_BRIDGE_INSTALL_REUSED=True"
            Write-Host "CHATGPT_BRIDGE_UPSTREAM_COMMIT=$marker"
            return $info
        }
    }

    $git = Get-Command git -ErrorAction SilentlyContinue
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $git) { throw 'Git is required to install pinned ChatGPT Bridge.' }
    if (-not $python) { throw 'Python is required to install pinned ChatGPT Bridge.' }

    New-Item -ItemType Directory -Force -Path $info.BridgeBase | Out-Null
    $tempRoot = Join-Path $info.BridgeBase ('install-' + [Guid]::NewGuid().ToString('N'))
    $tempRepo = Join-Path $tempRoot 'chatgpt-bridge'
    $tempVenv = Join-Path $tempRoot '.venv'
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

    try {
        & git clone --quiet $script:ChatGptBridgePinnedRepository $tempRepo
        if ($LASTEXITCODE -ne 0) { throw 'Failed to clone pinned ChatGPT Bridge repository.' }

        Push-Location $tempRepo
        try {
            & git checkout --quiet --detach $script:ChatGptBridgePinnedCommit
            if ($LASTEXITCODE -ne 0) { throw 'Failed to checkout pinned ChatGPT Bridge commit.' }
            $actual = (& git rev-parse HEAD).Trim()
        } finally {
            Pop-Location
        }
        if ($actual -ne $script:ChatGptBridgePinnedCommit) {
            throw "Pinned ChatGPT Bridge checkout mismatch: $actual"
        }

        & python -m venv $tempVenv
        if ($LASTEXITCODE -ne 0) { throw 'Failed to create ChatGPT Bridge Python venv.' }

        $tempPython = Join-Path $tempVenv 'Scripts\python.exe'
        & $tempPython -m pip install --disable-pip-version-check --no-input -q -r (Join-Path $tempRepo 'requirements.txt')
        if ($LASTEXITCODE -ne 0) { throw 'Failed to install ChatGPT Bridge Python dependencies.' }

        [System.IO.File]::WriteAllText(
            (Join-Path $tempRepo '.magasin-upstream-commit'),
            $script:ChatGptBridgePinnedCommit + [Environment]::NewLine,
            (New-Object System.Text.UTF8Encoding($false))
        )

        if (Test-Path $info.RepoRoot) { Remove-Item $info.RepoRoot -Recurse -Force }
        if (Test-Path $info.VenvRoot) { Remove-Item $info.VenvRoot -Recurse -Force }
        Move-Item $tempRepo $info.RepoRoot
        Move-Item $tempVenv $info.VenvRoot
    } finally {
        Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    $verified = Assert-ChatGptBridgePinnedInstall -Root $Root
    Write-Host 'CHATGPT_BRIDGE_INSTALL_PASS=True'
    Write-Host "CHATGPT_BRIDGE_UPSTREAM_COMMIT=$script:ChatGptBridgePinnedCommit"
    return $verified
}

function Stop-ChatGptBridgeRuntimeProcesses {
    param([Parameter(Mandatory=$true)][string]$Root)
    $info = Get-ChatGptBridgeRuntimeInfo -Root $Root
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like "*$($info.RepoRoot)*" -and
            $_.CommandLine -match 'run\.py'
        } |
        ForEach-Object {
            Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
        }
}

function Start-ChatGptBridgeBackend {
    param([Parameter(Mandatory=$true)][string]$Root)

    $info = Assert-ChatGptBridgePinnedInstall -Root $Root
    Stop-ChatGptBridgeRuntimeProcesses -Root $Root
    Start-Sleep -Milliseconds 250
    $listener = Get-NetTCPConnection -State Listen -LocalPort 5000 -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($listener) {
        throw "Port 5000 is already occupied by PID $($listener.OwningProcess); refusing unsafe Bridge takeover."
    }

    Remove-Item $info.Stdout -Force -ErrorAction SilentlyContinue
    Remove-Item $info.Stderr -Force -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $info.Python -WorkingDirectory $info.RepoRoot -PassThru -WindowStyle Hidden `
        -ArgumentList @('run.py','--host','127.0.0.1','--port','5000') `
        -RedirectStandardOutput $info.Stdout -RedirectStandardError $info.Stderr

    for ($i = 0; $i -lt 60; $i++) {
        if (Test-ChatGptBridgeHealth) {
            Write-Host 'CHATGPT_BRIDGE_BACKEND_HEALTHY=True'
            return $process
        }
        if ($process.HasExited) {
            throw "ChatGPT Bridge backend exited early with code $($process.ExitCode)."
        }
        Start-Sleep -Milliseconds 500
    }

    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw 'ChatGPT Bridge backend did not become healthy.'
}

function Stop-ChatGptBridgeBackend {
    param($Process)
    if ($Process -and -not $Process.HasExited) {
        Stop-Process -Id ([int]$Process.Id) -Force -ErrorAction SilentlyContinue
    }
}
