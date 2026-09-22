param(
    [ValidateSet('Handoff','RestoreOldAuthority')]
    [string]$Mode = 'Handoff',
    [string]$PackageZip,
    [string]$CandidateSha,
    [string]$SourceRoot,
    [string]$RollbackRecord,
    [string]$CapturePath,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'state-root.ps1')
. (Join-Path $PSScriptRoot 'lifecycle-truth.ps1')

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'MAGASINBusinessOSAutostart'

function Write-Utf8NoBom([string]$Path,[string]$Text) {
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false)))
}

function Get-StringSha256([string]$Value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes([string]$Value)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Get-PreHandoffMode($Capture) {
    $preActive = [bool]($Capture.authority_before.wrapper_alive -or $Capture.authority_before.three_lane_alive)
    $preOwnerStop = [bool]$Capture.owner_stop_before.blocked
    if ($preActive) { return 'ACTIVE' }
    if ($preOwnerStop) { return 'OWNER_STOPPED' }
    if (
        [int]$Capture.enabled_lane_count -eq 0 -and
        [int]$Capture.lane_count -eq 3 -and
        [int]$Capture.registry_lane_count -eq 3
    ) {
        return 'ALL_DISABLED_QUIESCENT'
    }
    return 'INVALID_INACTIVE'
}

function Get-OldAutostartRegistration {
    if (-not (Test-Path $runKey)) {
        return [pscustomobject]@{ present=$false; value=$null }
    }
    $props = Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue
    if (-not $props -or -not ($props.PSObject.Properties.Name -contains $runName)) {
        return [pscustomobject]@{ present=$false; value=$null }
    }
    return [pscustomobject]@{
        present = $true
        value = [string]$props.$runName
    }
}

function Write-AutostartRollbackRecord([string]$Path,$Registration,[string]$PreHandoffMode,[string]$Root) {
    $record = [ordered]@{
        schema_version = 'supervisor-mig005-old-authority-rollback.v1'
        pre_handoff_mode = $PreHandoffMode
        source_root_fingerprint = Get-StringSha256 ([IO.Path]::GetFullPath($Root).TrimEnd('\'))
        autostart_registration_present = [bool]$Registration.present
        autostart_registration_value = if ($Registration.present) { [string]$Registration.value } else { $null }
        private_local_record = $true
    }
    Write-Utf8NoBom $Path (($record | ConvertTo-Json -Depth 10) + [Environment]::NewLine)
}

function Restore-OldAuthority([string]$RecordPath,[string]$Root,[string]$InstalledStart) {
    if (-not (Test-Path $RecordPath -PathType Leaf)) {
        throw 'MIG-005 old-authority rollback record is missing.'
    }
    $record = Get-Content $RecordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$record.schema_version -ne 'supervisor-mig005-old-authority-rollback.v1') {
        throw 'Invalid MIG-005 old-authority rollback schema.'
    }
    $rootFingerprint = Get-StringSha256 ([IO.Path]::GetFullPath($Root).TrimEnd('\'))
    if ([string]$record.source_root_fingerprint -ne $rootFingerprint) {
        throw 'Rollback record state-root fingerprint mismatch.'
    }

    if ([bool]$record.autostart_registration_present) {
        if (-not (Test-Path $runKey)) { New-Item -Path $runKey -Force | Out-Null }
        Set-ItemProperty -Path $runKey -Name $runName -Value ([string]$record.autostart_registration_value)
    } elseif (Test-Path $runKey) {
        Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
    }

    $restored = Get-OldAutostartRegistration
    if ([bool]$restored.present -ne [bool]$record.autostart_registration_present) {
        throw 'Old autostart ownership rollback verification failed.'
    }
    if ($restored.present -and [string]$restored.value -ne [string]$record.autostart_registration_value) {
        throw 'Old autostart registration value rollback mismatch.'
    }

    if ([string]$record.pre_handoff_mode -eq 'ACTIVE') {
        if (-not (Test-Path $InstalledStart -PathType Leaf)) {
            throw 'Supported old Supervisor start mechanism is missing.'
        }
        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $InstalledStart -Hidden
        if ($LASTEXITCODE -ne 0) { throw 'Old Supervisor rollback START returned non-zero.' }
        $healthy = $false
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Seconds 1
            $truth = Get-LifecycleProcessTruth -Root $Root
            if ($truth.healthy) { $healthy=$true; break }
        }
        if (-not $healthy) { throw 'Old Supervisor rollback did not become healthy.' }
    } else {
        $truth = Get-LifecycleProcessTruth -Root $Root
        if ($truth.wrapper_alive -or $truth.three_lane_alive) {
            throw 'Non-active pre-handoff mode unexpectedly has live old authority during rollback.'
        }
    }

    Write-Host 'MIG_005_ROLLBACK_ATTEMPTED=True'
    Write-Host 'MIG_005_ROLLBACK_SUCCEEDED=True'
    Write-Host 'MIG_005_OLD_AUTOSTART_REGISTRATION_RESTORED=True'
    Write-Host 'MIG_005_RAW_AUTOSTART_VALUE_LOGGED=False'
}

if (-not $SourceRoot) {
    $SourceRoot = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
}
$installedStop = Join-Path $SourceRoot 'runtime\windows\stop-supervisor.ps1'
$installedStart = Join-Path $SourceRoot 'runtime\windows\start-supervisor.ps1'

if ($Mode -eq 'RestoreOldAuthority') {
    if (-not $RollbackRecord) { throw 'RestoreOldAuthority requires RollbackRecord.' }
    Restore-OldAuthority -RecordPath $RollbackRecord -Root $SourceRoot -InstalledStart $installedStart
    exit 0
}

if (-not $PackageZip -or -not $CandidateSha) {
    throw 'Handoff requires PackageZip and CandidateSha.'
}
if (-not $RollbackRecord) {
    $RollbackRecord = "$PackageZip.old-authority-rollback.json"
}

$transfer = Join-Path $PSScriptRoot 'mig-005-state-transfer.ps1'
$createdCapture = $false
if (-not $CapturePath) {
    $CapturePath = Join-Path $env:TEMP ('mig005-prestop-' + [guid]::NewGuid().ToString('N') + '.json')
    $createdCapture = $true
}
$capture = $null
$autostartOwnershipTransferred = $false
$rollbackAttempted = $false
$rollbackSucceeded = $false

try {
    if ($createdCapture) {
        $captureArgs = @(
            '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$transfer,
            '-Mode','Capture',
            '-SourceRoot',$SourceRoot,
            '-CapturePath',$CapturePath,
            '-CandidateSha',$CandidateSha
        )
        & powershell.exe @captureArgs
        if ($LASTEXITCODE -ne 0) { throw 'MIG-005 pre-stop capture failed.' }
    }

    $capture = Get-Content $CapturePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $preHandoffMode = Get-PreHandoffMode $capture
    Write-Host "MIG_005_PRE_HANDOFF_MODE=$preHandoffMode"
    Write-Host "MIG_005_PRE_HANDOFF_ENABLED_LANE_COUNT=$([int]$capture.enabled_lane_count)"

    if ($preHandoffMode -eq 'INVALID_INACTIVE') {
        throw 'Old authority is inactive without Owner STOP and is not a verified 3/3 all-disabled quiescent state.'
    }

    if ($ValidateOnly) {
        Write-Host 'MIG_005_HANDOFF_CLASSIFICATION_VALID=True'
        Write-Host 'MIG_005_ZERO_PRODUCTION_MUTATION=True'
        exit 0
    }

    if ($preHandoffMode -eq 'ACTIVE') {
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
    } elseif ($preHandoffMode -eq 'OWNER_STOPPED') {
        Write-Host 'MIG_005_OLD_STOP=ALREADY_OWNER_STOPPED'
    } elseif ($preHandoffMode -eq 'ALL_DISABLED_QUIESCENT') {
        $truthQuiescent = Get-LifecycleProcessTruth -Root $SourceRoot
        if ($truthQuiescent.wrapper_alive -or $truthQuiescent.three_lane_alive) {
            throw 'All-disabled quiescent state unexpectedly became active.'
        }
        Write-Host 'MIG_005_OLD_STOP=NOT_REQUIRED_ALL_DISABLED_QUIESCENT'
    }
    Write-Host 'MIG_005_AUTHORITY_COUNT_AFTER_OLD_STOP=0'

    $exportArgs = @(
        '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$transfer,
        '-Mode','Export',
        '-SourceRoot',$SourceRoot,
        '-CapturePath',$CapturePath,
        '-PackageZip',$PackageZip,
        '-CandidateSha',$CandidateSha
    )
    & powershell.exe @exportArgs
    if ($LASTEXITCODE -ne 0) { throw 'MIG-005 final state export failed.' }

    $oldAutostart = Get-OldAutostartRegistration
    Write-AutostartRollbackRecord -Path $RollbackRecord -Registration $oldAutostart -PreHandoffMode $preHandoffMode -Root $SourceRoot
    if ($oldAutostart.present) {
        Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction Stop
    }
    $afterAutostart = Get-OldAutostartRegistration
    if ($afterAutostart.present) {
        throw 'Old autostart ownership remains registered after handoff.'
    }
    $autostartOwnershipTransferred = $true

    Write-Host 'MIG_005_OLD_HANDOFF_PACKAGE_READY=True'
    Write-Host 'MIG_005_OLD_STATE_ROOT_UNTOUCHED=True'
    Write-Host 'MIG_005_OLD_AUTOSTART_OWNERSHIP_RELEASED=True'
    Write-Host 'MIG_005_OLD_AUTOSTART_ROLLBACK_RECORD_READY=True'
    Write-Host 'MIG_005_RAW_AUTOSTART_VALUE_LOGGED=False'
    Write-Host 'MIG_005_NEW_AUTHORITY_STARTED=False'
    Write-Host 'RBT009_TIER_B_480M=NOT_RUN'
}
catch {
    if ($autostartOwnershipTransferred -and (Test-Path $RollbackRecord -PathType Leaf)) {
        $rollbackAttempted = $true
        try {
            Restore-OldAuthority -RecordPath $RollbackRecord -Root $SourceRoot -InstalledStart $installedStart
            $rollbackSucceeded = $true
        } catch {
            Write-Host 'MIG_005_ROLLBACK_ATTEMPTED=True'
            Write-Host 'MIG_005_ROLLBACK_SUCCEEDED=False'
            throw
        }
    } elseif ($capture) {
        $preHandoffMode = Get-PreHandoffMode $capture
        if ($preHandoffMode -eq 'ACTIVE') {
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
                    if ($truth.healthy) { $healthy=$true; break }
                }
                if (-not $healthy) { throw 'Old Supervisor rollback did not become healthy.' }
                $rollbackSucceeded = $true
                Write-Host 'MIG_005_ROLLBACK_ATTEMPTED=True'
                Write-Host 'MIG_005_ROLLBACK_SUCCEEDED=True'
                Write-Host 'MIG_005_PRODUCTION_AUTHORITY=OLD_RESTORED'
            } catch {
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
    if ($createdCapture) {
        Remove-Item $CapturePath -Force -ErrorAction SilentlyContinue
    }
}
