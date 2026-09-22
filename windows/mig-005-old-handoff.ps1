param(
    [Parameter(Mandatory=$true)]
    [string]$PackageZip,
    [Parameter(Mandatory=$true)]
    [string]$CandidateSha,
    [string]$SourceRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'state-root.ps1')
. (Join-Path $PSScriptRoot 'lifecycle-truth.ps1')

if (-not $SourceRoot) {
    $SourceRoot = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
}

$transfer = Join-Path $PSScriptRoot 'mig-005-state-transfer.ps1'
$installedStop = Join-Path $SourceRoot 'runtime\windows\stop-supervisor.ps1'
$installedStart = Join-Path $SourceRoot 'runtime\windows\start-supervisor.ps1'
$capturePath = Join-Path $env:TEMP ('mig005-prestop-' + [guid]::NewGuid().ToString('N') + '.json')
$rollbackAttempted = $false
$rollbackSucceeded = $false
$capture = $null

try {
    $captureArgs = @(
        '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$transfer,
        '-Mode','Capture',
        '-SourceRoot',$SourceRoot,
        '-CapturePath',$capturePath,
        '-CandidateSha',$CandidateSha
    )
    & powershell.exe @captureArgs
    if ($LASTEXITCODE -ne 0) { throw 'MIG-005 pre-stop capture failed.' }

    $capture = Get-Content $capturePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $preActive = [bool]($capture.authority_before.wrapper_alive -or $capture.authority_before.three_lane_alive)
    $preOwnerStop = [bool]$capture.owner_stop_before.blocked

    if (-not $preActive -and -not $preOwnerStop) {
        throw 'Old authority is neither active nor Owner-stopped; fail closed before mutation.'
    }

    if ($preActive) {
        if (-not (Test-Path $installedStop -PathType Leaf)) {
            throw 'Supported old Supervisor stop mechanism is missing.'
        }

        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installedStop
        if ($LASTEXITCODE -ne 0) { throw 'Supported old Supervisor STOP failed.' }

        $truthAfterStop = Get-LifecycleProcessTruth -Root $SourceRoot
        if ($truthAfterStop.wrapper_alive -or $truthAfterStop.three_lane_alive) {
            throw 'Old authority did not reach zero after STOP.'
        }
        Write-Host 'MIG_005_OLD_STOP=PASS'
        Write-Host 'MIG_005_AUTHORITY_COUNT_AFTER_OLD_STOP=0'
    } else {
        Write-Host 'MIG_005_OLD_STOP=ALREADY_OWNER_STOPPED'
        Write-Host 'MIG_005_AUTHORITY_COUNT_AFTER_OLD_STOP=0'
    }

    $exportArgs = @(
        '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$transfer,
        '-Mode','Export',
        '-SourceRoot',$SourceRoot,
        '-CapturePath',$capturePath,
        '-PackageZip',$PackageZip,
        '-CandidateSha',$CandidateSha
    )
    & powershell.exe @exportArgs
    if ($LASTEXITCODE -ne 0) { throw 'MIG-005 final state export failed.' }

    Write-Host 'MIG_005_OLD_HANDOFF_PACKAGE_READY=True'
    Write-Host 'MIG_005_OLD_STATE_ROOT_UNTOUCHED=True'
    Write-Host 'MIG_005_NEW_AUTHORITY_STARTED=False'
    Write-Host 'RBT009_TIER_B_480M=NOT_RUN'
}
catch {
    if ($capture) {
        $preActive = [bool]($capture.authority_before.wrapper_alive -or $capture.authority_before.three_lane_alive)
        $preOwnerStop = [bool]$capture.owner_stop_before.blocked

        if ($preActive -and -not $preOwnerStop) {
            $rollbackAttempted = $true
            try {
                if (-not (Test-Path $installedStart -PathType Leaf)) {
                    throw 'Supported old Supervisor start mechanism is missing.'
                }

                & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installedStart -Hidden
                if ($LASTEXITCODE -ne 0) { throw 'Old Supervisor rollback START returned non-zero.' }

                $healthy = $false
                for ($i = 0; $i -lt 60; $i++) {
                    Start-Sleep -Seconds 1
                    $truth = Get-LifecycleProcessTruth -Root $SourceRoot
                    if ($truth.healthy) {
                        $healthy = $true
                        break
                    }
                }
                if (-not $healthy) { throw 'Old Supervisor rollback did not become healthy.' }

                $rollbackSucceeded = $true
                Write-Host 'MIG_005_ROLLBACK_ATTEMPTED=True'
                Write-Host 'MIG_005_ROLLBACK_SUCCEEDED=True'
                Write-Host 'MIG_005_PRODUCTION_AUTHORITY=OLD_RESTORED'
            }
            catch {
                Write-Host 'MIG_005_ROLLBACK_ATTEMPTED=True'
                Write-Host 'MIG_005_ROLLBACK_SUCCEEDED=False'
                throw
            }
        }
    }

    if (-not $rollbackAttempted) {
        Write-Host 'MIG_005_ROLLBACK_ATTEMPTED=False'
    } elseif (-not $rollbackSucceeded) {
        Write-Host 'MIG_005_ROLLBACK_SUCCEEDED=False'
    }

    throw
}
finally {
    Remove-Item $capturePath -Force -ErrorAction SilentlyContinue
}
