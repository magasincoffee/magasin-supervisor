param(
    [ValidateSet('Activate','Validate','RollbackNew')]
    [string]$Mode = 'Activate',
    [string]$PackageZip,
    [string]$ExpectedPackageSha256,
    [string]$CandidateSha,
    [string]$RollbackRecord
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'state-root.ps1')
. (Join-Path $PSScriptRoot 'lifecycle-truth.ps1')

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'MAGASINBusinessOSAutostart'
$requiredState = @('lanes.json','lane-registry.json','lane-status.json','lane-events.ndjson')

function Get-StringSha256([string]$Value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes([string]$Value)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Get-FileSha256([string]$Path) {
    if (-not (Test-Path $Path -PathType Leaf)) { throw "Required file is missing: $Path" }
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-Utf8NoBom([string]$Path,[string]$Text) {
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false)))
}

function Get-AutostartRegistration {
    if (-not (Test-Path $runKey)) { return [pscustomobject]@{ present=$false; value=$null } }
    $props = Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue
    if (-not $props -or -not ($props.PSObject.Properties.Name -contains $runName)) {
        return [pscustomobject]@{ present=$false; value=$null }
    }
    return [pscustomobject]@{ present=$true; value=[string]$props.$runName }
}

function Get-RunnerProcessIds {
    return @(Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId | Sort-Object)
}

function Get-DirectoryFingerprint([string]$Path) {
    if (-not (Test-Path $Path -PathType Container)) { return 'ABSENT' }
    $rows = @()
    foreach ($file in @(Get-ChildItem -Path $Path -File -Recurse -Force | Sort-Object FullName)) {
        $relative = $file.FullName.Substring($Path.Length).TrimStart('\').Replace('\','/')
        $rows += "$relative|$($file.Length)|$(Get-FileSha256 $file.FullName)"
    }
    return Get-StringSha256 ($rows -join [Environment]::NewLine)
}

function Get-StateSummary([string]$Root) {
    foreach ($name in $requiredState) {
        if (-not (Test-Path (Join-Path $Root $name) -PathType Leaf)) { throw "Required imported state file is missing: $name" }
    }
    $config = Get-Content (Join-Path $Root 'lanes.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $registry = Get-Content (Join-Path $Root 'lane-registry.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    return [pscustomobject]@{
        lane_count = @($config.lanes | Where-Object { [string]$_.lane_id -match '^lane-[123]$' }).Count
        registry_lane_count = @($registry.lanes.PSObject.Properties | Where-Object { $_.Name -match '^lane-[123]$' }).Count
        enabled_lane_count = @($config.lanes | Where-Object { [bool]$_.enabled }).Count
    }
}

function Assert-GitCandidate([string]$Sha) {
    if ($Sha -notmatch '^[a-f0-9]{40}$') { throw 'CandidateSha must be an exact 40-character git SHA.' }
    $actual = (& git -C $repoRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve repository HEAD.' }
    if ($actual -ne $Sha) { throw "Repository HEAD does not match CandidateSha. actual=$actual" }
}

function Get-PlatformStateRoot {
    $root = Get-SupervisorStateRoot -ExplicitRoot '' -Compatibility 'platform-default'
    $expected = [IO.Path]::GetFullPath((Join-Path ([string]$env:LOCALAPPDATA) 'MAGASIN\Supervisor'))
    if ([IO.Path]::GetFullPath($root) -ne $expected) { throw 'Platform-default state root did not resolve to the independent Supervisor path.' }
    if ($root -like '*\MAGASIN\BusinessOS\supervisor') { throw 'Legacy BusinessOS state root is forbidden for new-machine activation.' }
    return $root
}

function Assert-NoNewAuthority([string]$Root) {
    $truth = Get-LifecycleProcessTruth -Root $Root
    if ($truth.wrapper_alive -or $truth.three_lane_alive) { throw 'New-machine Supervisor authority is active before import/activation.' }
    if ((Get-AutostartRegistration).present) { throw 'New-machine production autostart ownership already exists before activation.' }
}

function Assert-NoPendingReboot {
    $pending = [bool]((Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\Auto Update\RebootRequired'))
    if ($pending) { throw 'New machine has a pending reboot; activation is blocked.' }
}

function Assert-StateContinuity([string]$Root) {
    $summary = Get-StateSummary -Root $Root
    if ($summary.lane_count -ne 3) { throw "Imported lane_count mismatch: $($summary.lane_count)" }
    if ($summary.registry_lane_count -ne 3) { throw "Imported registry_lane_count mismatch: $($summary.registry_lane_count)" }
    if ($summary.enabled_lane_count -ne 0) { throw "Imported enabled_lane_count must remain 0; observed $($summary.enabled_lane_count)" }
    if ((Get-LifecycleOwnerStopState -Root $Root).blocked) { throw 'Imported Owner STOP semantics changed; expected preserved false.' }
    return $summary
}

function Assert-InstalledRuntimeExact([string]$Root,[string]$Sha) {
    $runtime = Join-Path $Root 'runtime'
    $pairs = @(
        @((Join-Path $repoRoot 'package.json'),(Join-Path $runtime 'package.json')),
        @((Join-Path $repoRoot 'src\runtime\three-lane-cli.mjs'),(Join-Path $runtime 'src\runtime\three-lane-cli.mjs')),
        @((Join-Path $repoRoot 'windows\autostart-bootstrap.ps1'),(Join-Path $runtime 'windows\autostart-bootstrap.ps1')),
        @((Join-Path $repoRoot 'windows\lifecycle-truth.ps1'),(Join-Path $runtime 'windows\lifecycle-truth.ps1')),
        @((Join-Path $repoRoot 'windows\state-root.ps1'),(Join-Path $runtime 'windows\state-root.ps1'))
    )
    foreach ($pair in $pairs) {
        if ((Get-FileSha256 $pair[0]) -ne (Get-FileSha256 $pair[1])) { throw "Installed runtime candidate verification failed for $([IO.Path]::GetFileName($pair[0]))." }
    }
    Write-Utf8NoBom (Join-Path $runtime 'MIG_005_CANDIDATE_SHA.txt') ($Sha + [Environment]::NewLine)
    if ((Get-Content (Join-Path $runtime 'MIG_005_CANDIDATE_SHA.txt') -Raw).Trim() -ne $Sha) { throw 'Installed runtime candidate marker verification failed.' }
}

function Write-NewMachineRollbackRecord([string]$Path,[string]$Root,[string]$Sha,[bool]$PriorUserEnvPresent,[string]$PriorUserEnvValue,[string]$PriorProcessEnvValue,[string]$LegacyProfileFingerprint,[string]$PlatformProfileFingerprint) {
    $record = [ordered]@{
        schema_version = 'supervisor-mig005-new-machine-rollback.v1'
        candidate_sha = $Sha
        selected_state_root = $Root
        prior_user_env_present = $PriorUserEnvPresent
        prior_user_env_value = $PriorUserEnvValue
        prior_process_env_value = $PriorProcessEnvValue
        legacy_browser_profile_fingerprint = $LegacyProfileFingerprint
        platform_browser_profile_fingerprint = $PlatformProfileFingerprint
        private_local_record = $true
    }
    Write-Utf8NoBom $Path (($record | ConvertTo-Json -Depth 12) + [Environment]::NewLine)
}

function Restore-NewMachineUserEnvironment($Record) {
    if ([bool]$Record.prior_user_env_present) {
        [Environment]::SetEnvironmentVariable('SUPERVISOR_STATE_ROOT',[string]$Record.prior_user_env_value,'User')
    } else {
        [Environment]::SetEnvironmentVariable('SUPERVISOR_STATE_ROOT',$null,'User')
    }
    $env:SUPERVISOR_STATE_ROOT = [string]$Record.prior_process_env_value
}

function Remove-NewAutostartOwnership {
    if (Test-Path $runKey) { Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue }
    if ((Get-AutostartRegistration).present) { throw 'Failed to remove new-machine autostart ownership.' }
}

function Remove-NewTransactionArtifacts([string]$Root) {
    foreach ($name in @('lanes.json','lane-registry.json','lane-status.json','lane-events.ndjson','lane-evidence','runtime','autostart-install-status.json','autostart.log','supervisor.pid','runtime-status.json','supervisor.log')) {
        $path = Join-Path $Root $name
        if (Test-Path $path) { Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

function Invoke-NewMachineRollback([string]$RecordPath) {
    if (-not (Test-Path $RecordPath -PathType Leaf)) { throw 'New-machine rollback record is missing.' }
    $record = Get-Content $RecordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$record.schema_version -ne 'supervisor-mig005-new-machine-rollback.v1') { throw 'Invalid new-machine rollback record schema.' }
    $root = [string]$record.selected_state_root
    Remove-NewAutostartOwnership
    $truth = Get-LifecycleProcessTruth -Root $root
    if ($truth.wrapper_alive -or $truth.three_lane_alive) { throw 'New authority is active during rollback; automatic rollback refuses to continue.' }
    Remove-NewTransactionArtifacts -Root $root
    Restore-NewMachineUserEnvironment -Record $record
    $legacyRoot = Get-SupervisorStateRoot -ExplicitRoot '' -Compatibility 'legacy-preserve'
    if ((Get-DirectoryFingerprint (Join-Path $legacyRoot 'browser_profile')) -ne [string]$record.legacy_browser_profile_fingerprint) { throw 'Legacy machine-local browser profile changed during activation/rollback.' }
    if ((Get-DirectoryFingerprint (Join-Path $root 'browser_profile')) -ne [string]$record.platform_browser_profile_fingerprint) { throw 'Platform machine-local browser profile changed during activation/rollback.' }
    Write-Host 'MIG_005_NEW_MACHINE_ROLLBACK=PASS'
    Write-Host 'MIG_005_NEW_AUTOSTART_OWNERSHIP_PRESENT=False'
    Write-Host 'MIG_005_NEW_RUNTIME_AUTHORITY_ACTIVE=False'
    Write-Host 'MIG_005_OWNER_MUST_RESTORE_OLD_AUTHORITY_USING_PRESERVED_OLD_ROLLBACK_RECORD=True'
    Write-Host 'RBT009_TIER_B_480M=NOT_RUN'
}

if ($Mode -eq 'RollbackNew') {
    if (-not $RollbackRecord) { throw 'RollbackNew requires RollbackRecord.' }
    Invoke-NewMachineRollback -RecordPath $RollbackRecord
    exit 0
}

if (-not $PackageZip -or -not $ExpectedPackageSha256 -or -not $CandidateSha) { throw 'Activate/Validate requires PackageZip, ExpectedPackageSha256 and CandidateSha.' }
if ($ExpectedPackageSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'ExpectedPackageSha256 must be an exact SHA256 hex digest.' }

Assert-GitCandidate -Sha $CandidateSha
$actualPackageSha = Get-FileSha256 $PackageZip
if ($actualPackageSha -ne $ExpectedPackageSha256.ToLowerInvariant()) { throw 'MIG-005 package SHA256 mismatch; fail closed before mutation.' }

$destinationRoot = Get-PlatformStateRoot
Assert-NoPendingReboot
Assert-NoNewAuthority -Root $destinationRoot

$legacyRoot = Get-SupervisorStateRoot -ExplicitRoot '' -Compatibility 'legacy-preserve'
$legacyProfileBefore = Get-DirectoryFingerprint (Join-Path $legacyRoot 'browser_profile')
$platformProfileBefore = Get-DirectoryFingerprint (Join-Path $destinationRoot 'browser_profile')
$runnerPidsBefore = Get-RunnerProcessIds
if ($Mode -ne 'Validate' -and $runnerPidsBefore.Count -lt 1) { throw 'GitHub self-hosted runner is not visible; activation is blocked.' }

Write-Host 'MIG_005_PACKAGE_SHA256_VERIFIED=True'
Write-Host 'MIG_005_SELECTED_STATE_ROOT_PLATFORM_DEFAULT=True'
Write-Host 'MIG_005_PREIMPORT_NEW_RUNTIME_AUTHORITY_ACTIVE=False'
Write-Host 'MIG_005_PREIMPORT_NEW_AUTOSTART_OWNERSHIP_PRESENT=False'

if ($Mode -eq 'Validate') {
    Write-Host 'MIG_005_NEW_MACHINE_VALIDATE_ONLY=PASS'
    Write-Host 'ZERO_PRODUCTION_MUTATION=True'
    Write-Host 'RBT009_TIER_B_480M=NOT_RUN'
    exit 0
}

if (-not $RollbackRecord) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $RollbackRecord = Join-Path $desktop 'MIG005_NEW_MACHINE_ROLLBACK.json'
}

$transfer = Join-Path $PSScriptRoot 'mig-005-state-transfer.ps1'
$install = Join-Path $PSScriptRoot 'install-supervisor.ps1'
$priorUserEnv = [Environment]::GetEnvironmentVariable('SUPERVISOR_STATE_ROOT','User')
$priorUserEnvPresent = -not [string]::IsNullOrEmpty($priorUserEnv)
$priorProcessEnv = [string]$env:SUPERVISOR_STATE_ROOT
$importCompleted = $false
$userEnvChanged = $false
$runtimeInstalled = $false
$newOwnershipInstalled = $false

try {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $transfer -Mode Import -DestinationRoot $destinationRoot -PackageZip $PackageZip -ExpectedPackageSha256 $ExpectedPackageSha256 -CandidateSha $CandidateSha
    if ($LASTEXITCODE -ne 0) { throw 'MIG-005 new-machine state Import failed.' }
    $importCompleted = $true

    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $transfer -Mode Verify -DestinationRoot $destinationRoot -PackageZip $PackageZip -ExpectedPackageSha256 $ExpectedPackageSha256 -CandidateSha $CandidateSha
    if ($LASTEXITCODE -ne 0) { throw 'MIG-005 new-machine state Verify failed.' }

    $summary = Assert-StateContinuity -Root $destinationRoot
    if ((Get-DirectoryFingerprint (Join-Path $legacyRoot 'browser_profile')) -ne $legacyProfileBefore) { throw 'Legacy machine-local browser profile changed during import.' }
    if ((Get-DirectoryFingerprint (Join-Path $destinationRoot 'browser_profile')) -ne $platformProfileBefore) { throw 'Platform machine-local browser profile changed during import.' }

    Write-NewMachineRollbackRecord -Path $RollbackRecord -Root $destinationRoot -Sha $CandidateSha -PriorUserEnvPresent $priorUserEnvPresent -PriorUserEnvValue $priorUserEnv -PriorProcessEnvValue $priorProcessEnv -LegacyProfileFingerprint $legacyProfileBefore -PlatformProfileFingerprint $platformProfileBefore

    [Environment]::SetEnvironmentVariable('SUPERVISOR_STATE_ROOT',$destinationRoot,'User')
    $env:SUPERVISOR_STATE_ROOT = $destinationRoot
    $userEnvChanged = $true
    $persisted = [Environment]::GetEnvironmentVariable('SUPERVISOR_STATE_ROOT','User')
    if ([IO.Path]::GetFullPath([string]$persisted) -ne [IO.Path]::GetFullPath($destinationRoot)) { throw 'CurrentUser SUPERVISOR_STATE_ROOT persistence verification failed.' }

    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $install -SourceRoot $repoRoot
    if ($LASTEXITCODE -ne 0) { throw 'Independent Supervisor runtime installation failed.' }
    $runtimeInstalled = $true
    Assert-InstalledRuntimeExact -Root $destinationRoot -Sha $CandidateSha

    $truthAfterInstall = Get-LifecycleProcessTruth -Root $destinationRoot
    if ($truthAfterInstall.wrapper_alive -or $truthAfterInstall.three_lane_alive) { throw 'Runtime installation unexpectedly started Supervisor authority.' }

    $installedAutostart = Join-Path $destinationRoot 'runtime\windows\install-autostart.ps1'
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installedAutostart
    if ($LASTEXITCODE -ne 0) { throw 'New-machine autostart ownership installation failed.' }
    $newOwnershipInstalled = $true

    $registration = Get-AutostartRegistration
    $expectedBootstrap = Join-Path $destinationRoot 'runtime\windows\autostart-bootstrap.ps1'
    if (-not $registration.present) { throw 'New-machine autostart ownership is missing after installation.' }
    if ([string]$registration.value -notlike "*$expectedBootstrap*") { throw 'New-machine autostart registration does not point to independent installed runtime.' }

    $summary = Assert-StateContinuity -Root $destinationRoot
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $expectedBootstrap -DryRun
    if ($LASTEXITCODE -ne 0) { throw 'ALL_DISABLED bootstrap verification failed.' }

    $truthAfterBootstrap = Get-LifecycleProcessTruth -Root $destinationRoot
    if ($truthAfterBootstrap.wrapper_alive -or $truthAfterBootstrap.three_lane_alive) { throw 'ALL_DISABLED bootstrap unexpectedly started Supervisor runtime.' }
    $lastBootstrapRecord = Get-Content (Join-Path $destinationRoot 'autostart.log') -Tail 1 -Encoding UTF8 | ConvertFrom-Json
    if ([string]$lastBootstrapRecord.type -ne 'AUTOSTART_ALL_LANES_DISABLED') { throw 'Bootstrap did not prove ALL_LANES_DISABLED no-start behavior.' }

    $runnerPidsAfter = Get-RunnerProcessIds
    if (($runnerPidsAfter -join ',') -ne ($runnerPidsBefore -join ',')) { throw 'GitHub runner process identity changed during activation.' }
    if ((Get-DirectoryFingerprint (Join-Path $legacyRoot 'browser_profile')) -ne $legacyProfileBefore) { throw 'Legacy machine-local browser profile changed during activation.' }
    if ((Get-DirectoryFingerprint (Join-Path $destinationRoot 'browser_profile')) -ne $platformProfileBefore) { throw 'Platform machine-local browser profile changed during activation.' }
    if ((Get-LifecycleOwnerStopState -Root $destinationRoot).blocked) { throw 'Owner STOP semantics changed during activation.' }

    Write-Host 'MIG_005_NEW_MACHINE_IMPORT=PASS'
    Write-Host "MIG_005_NEW_LANE_COUNT=$($summary.lane_count)"
    Write-Host "MIG_005_NEW_REGISTRY_LANE_COUNT=$($summary.registry_lane_count)"
    Write-Host "MIG_005_NEW_ENABLED_LANE_COUNT=$($summary.enabled_lane_count)"
    Write-Host 'MIG_005_NEW_TARGET_FINGERPRINT_MATCH=True'
    Write-Host 'MIG_005_NEW_LATCH_FINGERPRINT_MATCH=True'
    Write-Host 'MIG_005_NEW_OWNER_STOP_BLOCKED=False'
    Write-Host 'MIG_005_NEW_BROWSER_PROFILE_UNTOUCHED=True'
    Write-Host 'MIG_005_GITHUB_RUNNER_UNTOUCHED=True'
    Write-Host 'MIG_005_NEW_RUNTIME_EXACT_CANDIDATE=True'
    Write-Host 'MIG_005_NEW_AUTOSTART_OWNERSHIP_PRESENT=True'
    Write-Host 'MIG_005_NEW_RUNTIME_AUTHORITY_ACTIVE=False'
    Write-Host 'MIG_005_PRODUCTION_OWNERSHIP_AUTHORITY_INSTANCES=1'
    Write-Host 'MIG_005_NEW_AUTHORITY_OWNERSHIP_STATE=NEW_AUTHORITY_OWNERSHIP_ACTIVE_ALL_DISABLED_RUNTIME_QUIESCENT'
    Write-Host 'MIG_005_ROLLBACK_RECORD_READY=True'
    Write-Host 'RBT009_TIER_B_480M=NOT_RUN'
}
catch {
    $activationError = $_
    try {
        if ($newOwnershipInstalled -or (Get-AutostartRegistration).present) { Remove-NewAutostartOwnership }
        $truth = Get-LifecycleProcessTruth -Root $destinationRoot
        if ($truth.wrapper_alive -or $truth.three_lane_alive) { throw 'New runtime authority is active during failed activation; automatic cleanup refuses overlap risk.' }
        if ($runtimeInstalled -or $importCompleted) { Remove-NewTransactionArtifacts -Root $destinationRoot }
        if ($userEnvChanged) {
            if (Test-Path $RollbackRecord -PathType Leaf) {
                Restore-NewMachineUserEnvironment -Record (Get-Content $RollbackRecord -Raw -Encoding UTF8 | ConvertFrom-Json)
            } else {
                if ($priorUserEnvPresent) { [Environment]::SetEnvironmentVariable('SUPERVISOR_STATE_ROOT',$priorUserEnv,'User') } else { [Environment]::SetEnvironmentVariable('SUPERVISOR_STATE_ROOT',$null,'User') }
                $env:SUPERVISOR_STATE_ROOT = $priorProcessEnv
            }
        }
        Write-Host 'MIG_005_NEW_MACHINE_ACTIVATION_ROLLED_BACK=True'
        Write-Host 'MIG_005_NEW_AUTOSTART_OWNERSHIP_PRESENT=False'
        Write-Host 'MIG_005_NEW_RUNTIME_AUTHORITY_ACTIVE=False'
        Write-Host 'MIG_005_OWNER_MUST_RESTORE_OLD_AUTHORITY_USING_PRESERVED_OLD_ROLLBACK_RECORD=True'
        Write-Host 'RBT009_TIER_B_480M=NOT_RUN'
    }
    catch {
        Write-Host 'MIG_005_NEW_MACHINE_ACTIVATION_ROLLBACK_INCOMPLETE=True'
        Write-Host 'MIG_005_OWNER_MUST_RESTORE_OLD_AUTHORITY_USING_PRESERVED_OLD_ROLLBACK_RECORD=True'
        throw
    }
    throw $activationError
}
