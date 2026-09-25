param(
    [Parameter(Mandatory=$true)]
    [string]$TargetComputer
)

$ErrorActionPreference = 'Stop'

if ($env:COMPUTERNAME -ne $TargetComputer) {
    Write-Host 'TARGET_MATCH=False'
    Write-Host 'TARGET_SKIP_SAFE=True'
    exit 0
}
Write-Host 'TARGET_MATCH=True'

$mutex = New-Object System.Threading.Mutex($false, 'Global\MAGASIN_THREE_LANE_STARTUP_HOTFIX_DEPLOY')
$ownsMutex = $false
try {
    try {
        $ownsMutex = $mutex.WaitOne([TimeSpan]::FromMinutes(4))
    } catch [System.Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }
    if (-not $ownsMutex) {
        throw 'Could not acquire targeted Supervisor deployment mutex.'
    }

    . (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
    $root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
    $runtime = Join-Path $root 'runtime'
    $sourceWrapper = Join-Path $env:GITHUB_WORKSPACE 'windows\run-supervisor.ps1'
    $targetWrapper = Join-Path $runtime 'windows\run-supervisor.ps1'
    $targetStart = Join-Path $runtime 'windows\start-supervisor.ps1'
    $targetLifecycle = Join-Path $runtime 'windows\lifecycle-truth.ps1'
    $configFile = Join-Path $root 'lanes.json'
    $pidFile = Join-Path $root 'supervisor.pid'

    foreach ($required in @($sourceWrapper,$targetWrapper,$targetStart,$targetLifecycle,$configFile)) {
        if (-not (Test-Path $required)) {
            throw "Required Supervisor path is missing: $required"
        }
    }

    $source = Get-Content $sourceWrapper -Raw -Encoding UTF8
    foreach ($marker in @(
        'function Resolve-LocalRuntimeMode',
        "return 'THREE_LANE_V1'",
        'No authoritative runtime mode is available; preserving wrapper and retrying fail-closed.'
    )) {
        if ($source -notmatch [regex]::Escape($marker)) {
            throw "Checked-out wrapper is missing hotfix marker: $marker"
        }
    }

    function Get-TargetFingerprint([string]$Path) {
        $config = Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        $canonical = @($config.lanes | Sort-Object lane_id | ForEach-Object {
            "$([string]$_.lane_id)|$([bool]$_.enabled)|$([string]$_.brain_url)|$([int]$_.brain_url_revision)|$([string]$_.work_url)|$([int]$_.work_url_revision)|$([string]$_.work_mode)"
        }) -join "`n"
        $bytes = [Text.Encoding]::UTF8.GetBytes($canonical)
        $hasher = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()
        } finally {
            $hasher.Dispose()
        }
    }

    $targetFingerprintBefore = Get-TargetFingerprint $configFile
    $sourceHash = (Get-FileHash -Algorithm SHA256 -Path $sourceWrapper).Hash
    $targetHashBefore = (Get-FileHash -Algorithm SHA256 -Path $targetWrapper).Hash

    . $targetLifecycle
    $ownerStop = Get-LifecycleOwnerStopState -Root $root
    if ($ownerStop.blocked) {
        throw 'Owner STOP is active; targeted hotfix refuses to override Owner authority.'
    }

    $truthBefore = Get-LifecycleProcessTruth -Root $root
    Write-Host "PRE_WRAPPER_ALIVE=$([bool]$truthBefore.wrapper_alive)"
    Write-Host "PRE_THREE_LANE_ALIVE=$([bool]$truthBefore.three_lane_alive)"
    Write-Host "PRE_CHROME_ALIVE=$([bool]$truthBefore.chrome_alive)"
    Write-Host "PRE_CDP_HEALTHY=$([bool]$truthBefore.cdp_healthy)"

    $needsFileDeploy = $sourceHash -ne $targetHashBefore
    if ($needsFileDeploy) {
        $utf8Bom = New-Object System.Text.UTF8Encoding($true)
        [System.IO.File]::WriteAllText($targetWrapper, $source, $utf8Bom)
        Write-Host 'WRAPPER_FILE_DEPLOYED=True'
    } else {
        Write-Host 'WRAPPER_FILE_DEPLOYED=False'
        Write-Host 'WRAPPER_FILE_ALREADY_CURRENT=True'
    }

    $targetHashAfter = (Get-FileHash -Algorithm SHA256 -Path $targetWrapper).Hash
    if ($targetHashAfter -ne $sourceHash) {
        throw 'Installed run-supervisor.ps1 hash does not match checked-out source.'
    }

    # A running PowerShell wrapper keeps the old parsed script in memory.
    # Restart only the exact Supervisor wrapper/runtime process tree; preserve
    # dedicated Chrome/profile and all lane target configuration.
    $truthAfterCopy = Get-LifecycleProcessTruth -Root $root
    if (-not $truthAfterCopy.healthy -or $needsFileDeploy) {
        $wrapper = Get-LifecycleSupervisorWrapper -Root $root
        if ($wrapper) {
            Stop-Process -Id ([int]$wrapper.ProcessId) -Force -ErrorAction Stop
            Write-Host 'OLD_WRAPPER_STOPPED=True'
        }

        $runtimeRoot = Join-Path $root 'runtime'
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine -like '*three-lane-cli.mjs*' -and
                $_.CommandLine -like "*$runtimeRoot*"
            } |
            ForEach-Object {
                Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
                Write-Host 'OLD_THREE_LANE_NODE_STOPPED=True'
            }

        Start-Sleep -Milliseconds 900
        if (Test-Path $pidFile) {
            $pidText = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
            $pidValue = 0
            if (-not $pidText -or -not [int]::TryParse([string]$pidText, [ref]$pidValue) -or
                -not (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
                Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
            }
        }

        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $targetStart -Hidden -Recovery
        if ($LASTEXITCODE -ne 0) {
            throw 'Targeted Supervisor recovery start returned non-zero.'
        }
        Write-Host 'RECOVERY_START_REQUESTED=True'
    } else {
        Write-Host 'RECOVERY_START_REQUESTED=False'
        Write-Host 'RUNTIME_ALREADY_HEALTHY=True'
    }

    $finalTruth = $null
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        $finalTruth = Get-LifecycleProcessTruth -Root $root
        if ($finalTruth.healthy) { break }
    }

    if (-not $finalTruth -or -not $finalTruth.healthy) {
        if ($finalTruth) {
            Write-Host "POST_WRAPPER_ALIVE=$([bool]$finalTruth.wrapper_alive)"
            Write-Host "POST_THREE_LANE_ALIVE=$([bool]$finalTruth.three_lane_alive)"
            Write-Host "POST_CHROME_ALIVE=$([bool]$finalTruth.chrome_alive)"
            Write-Host "POST_CDP_HEALTHY=$([bool]$finalTruth.cdp_healthy)"
        }
        $mode = ''
        try {
            $cfg = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $mode = [string]$cfg.mode
        } catch {}
        Write-Host "LOCAL_CONFIG_MODE=$mode"
        throw 'Three-Lane startup hotfix did not reach healthy process truth.'
    }

    $targetFingerprintAfter = Get-TargetFingerprint $configFile
    if ($targetFingerprintBefore -ne $targetFingerprintAfter) {
        throw 'Brain/Work/lane target configuration changed during targeted deployment.'
    }

    Write-Host 'POST_WRAPPER_ALIVE=True'
    Write-Host 'POST_THREE_LANE_ALIVE=True'
    Write-Host 'POST_CHROME_ALIVE=True'
    Write-Host 'POST_CDP_HEALTHY=True'
    Write-Host 'TARGET_FINGERPRINT_UNCHANGED=True'
    Write-Host 'STANDALONE_THREE_LANE_STARTUP_RECOVERY=PASS'
} finally {
    if ($ownsMutex) {
        try { $mutex.ReleaseMutex() } catch {}
    }
    $mutex.Dispose()
}
