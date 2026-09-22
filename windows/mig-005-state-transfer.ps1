param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('Capture','Export','Import','Verify')]
    [string]$Mode,
    [string]$SourceRoot,
    [string]$DestinationRoot,
    [string]$CapturePath,
    [string]$PackageZip,
    [string]$ExpectedPackageSha256,
    [string]$CandidateSha
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'state-root.ps1')
. (Join-Path $PSScriptRoot 'lifecycle-truth.ps1')

$ManifestName = 'MIG_005_STATE_TRANSFER_MANIFEST.json'
$Schema = 'supervisor-mig005-state-transfer.v1'
$CaptureSchema = 'supervisor-mig005-prestop-capture.v1'
$RequiredStateFiles = @('lanes.json','lane-registry.json','lane-status.json','lane-events.ndjson')

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [System.IO.File]::WriteAllText($Path,$Text,(New-Object System.Text.UTF8Encoding($false)))
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

function Get-FileSha256([string]$Path) {
    if (-not (Test-Path $Path -PathType Leaf)) { throw "Required file is missing: $Path" }
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-JsonStrict([string]$Path) {
    if (-not (Test-Path $Path -PathType Leaf)) { throw "Required JSON is missing: $Path" }
    return Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-RootHash([string]$Root) {
    if (-not $Root) { throw 'State root is required.' }
    return Get-StringSha256 ([IO.Path]::GetFullPath($Root).TrimEnd('\'))
}

function Get-ConfigLaneCount($Config) {
    if (-not $Config -or -not $Config.lanes) { return 0 }
    return @($Config.lanes | Where-Object { [string]$_.lane_id -match '^lane-[123]$' }).Count
}

function Get-RegistryLaneCount($Registry) {
    if (-not $Registry -or -not $Registry.lanes) { return 0 }
    return @($Registry.lanes.PSObject.Properties | Where-Object { $_.Name -match '^lane-[123]$' }).Count
}

function Get-EnabledLaneCountFromConfig($Config) {
    if (-not $Config -or -not $Config.lanes) { return 0 }
    return @($Config.lanes | Where-Object { [bool]$_.enabled }).Count
}

function Get-TargetFingerprint($Config) {
    $rows = @()
    foreach ($lane in @($Config.lanes | Sort-Object lane_id)) {
        $rows += (@(
            [string]$lane.lane_id,
            [string]$lane.brain_url,
            [string]$lane.brain_url_revision,
            [string]$lane.work_url,
            [string]$lane.work_url_revision,
            [string]$lane.work_mode,
            [string]$lane.work_state_reset_revision,
            [string]$lane.relay_retry_rearm_revision,
            [string]([bool]$lane.enabled)
        ) -join '|')
    }
    return Get-StringSha256 ($rows -join [Environment]::NewLine)
}

function Get-RegistryContinuityFingerprint($Registry) {
    $clone = ($Registry | ConvertTo-Json -Depth 40) | ConvertFrom-Json
    foreach ($prop in @($clone.lanes.PSObject.Properties)) {
        $lane = $prop.Value
        if ($lane -and $lane.relay_inflight -and $lane.relay_inflight.screenshot_path) {
            $leaf = [IO.Path]::GetFileName([string]$lane.relay_inflight.screenshot_path)
            $lane.relay_inflight.screenshot_path = "lane-evidence/$leaf"
        }
    }
    return Get-StringSha256 ($clone | ConvertTo-Json -Depth 40 -Compress)
}

function Get-AutostartPresent {
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $runName = 'MAGASINBusinessOSAutostart'
    if (-not (Test-Path $runKey)) { return $false }
    $props = Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue
    return [bool]($props -and ($props.PSObject.Properties.Name -contains $runName))
}

function Get-CoreState([string]$Root) {
    foreach ($name in $RequiredStateFiles) {
        if (-not (Test-Path (Join-Path $Root $name) -PathType Leaf)) {
            throw "Required authoritative state file is missing: $name"
        }
    }
    $config = Read-JsonStrict (Join-Path $Root 'lanes.json')
    $registry = Read-JsonStrict (Join-Path $Root 'lane-registry.json')
    [void](Read-JsonStrict (Join-Path $Root 'lane-status.json'))
    $laneCount = Get-ConfigLaneCount $config
    $registryLaneCount = Get-RegistryLaneCount $registry
    if ($laneCount -ne 3) { throw "Expected exactly 3 config lanes; observed $laneCount." }
    if ($registryLaneCount -ne 3) { throw "Expected exactly 3 registry lanes; observed $registryLaneCount." }
    return [pscustomobject]@{
        config = $config
        registry = $registry
        lane_count = $laneCount
        registry_lane_count = $registryLaneCount
        enabled_lane_count = Get-EnabledLaneCountFromConfig $config
        target_fingerprint = Get-TargetFingerprint $config
        registry_continuity_fingerprint = Get-RegistryContinuityFingerprint $registry
    }
}

function Get-ReferencedRelayEvidence([string]$Root, $Registry) {
    $evidenceRoot = [IO.Path]::GetFullPath((Join-Path $Root 'lane-evidence')).TrimEnd('\') + '\'
    $items = @()
    foreach ($prop in @($Registry.lanes.PSObject.Properties)) {
        $laneId = [string]$prop.Name
        $lane = $prop.Value
        if (-not $lane -or -not $lane.relay_inflight) { continue }
        $raw = [string]$lane.relay_inflight.screenshot_path
        if ([string]::IsNullOrWhiteSpace($raw)) { throw "Relay latch for $laneId has no screenshot_path." }
        $full = [IO.Path]::GetFullPath($raw)
        if (-not $full.StartsWith($evidenceRoot,[StringComparison]::OrdinalIgnoreCase)) {
            throw "Relay screenshot for $laneId is outside lane-evidence."
        }
        if (-not (Test-Path $full -PathType Leaf)) { throw "Relay screenshot for $laneId is missing." }
        $leaf = [IO.Path]::GetFileName($full)
        $items += [pscustomobject]@{
            lane_id = $laneId
            source_path = $full
            relative_path = "lane-evidence\$leaf"
        }
    }
    return @($items)
}

function Assert-CandidateSha([string]$Sha) {
    if ($Sha -notmatch '^[a-f0-9]{40}$') { throw 'CandidateSha must be an exact 40-character git SHA.' }
}

function New-Capture([string]$Root,[string]$OutputPath,[string]$Sha) {
    Assert-CandidateSha $Sha
    $core = Get-CoreState $Root
    $ownerStop = Get-LifecycleOwnerStopState -Root $Root
    $truth = Get-LifecycleProcessTruth -Root $Root
    $fileHashes = [ordered]@{}
    foreach ($name in $RequiredStateFiles) {
        $fileHashes[$name] = Get-FileSha256 (Join-Path $Root $name)
    }
    $capture = [ordered]@{
        schema_version = $CaptureSchema
        candidate_sha = $Sha
        source_root_fingerprint = Get-RootHash $Root
        lane_count = $core.lane_count
        registry_lane_count = $core.registry_lane_count
        enabled_lane_count = $core.enabled_lane_count
        target_fingerprint = $core.target_fingerprint
        registry_continuity_fingerprint = $core.registry_continuity_fingerprint
        core_file_hashes = $fileHashes
        owner_stop_before = [ordered]@{
            stop_present = [bool]$ownerStop.stop_present
            autostart_disabled_present = [bool]$ownerStop.autostart_disabled_present
            blocked = [bool]$ownerStop.blocked
        }
        authority_before = [ordered]@{
            wrapper_alive = [bool]$truth.wrapper_alive
            three_lane_alive = [bool]$truth.three_lane_alive
            chrome_alive = [bool]$truth.chrome_alive
            healthy = [bool]$truth.healthy
        }
        autostart_registration_present = [bool](Get-AutostartPresent)
        privacy = [ordered]@{
            raw_targets_logged = $false
            raw_messages_logged = $false
            browser_profile_included = $false
        }
    }
    Write-Utf8NoBom $OutputPath (($capture | ConvertTo-Json -Depth 20) + [Environment]::NewLine)
    Write-Host 'MIG_005_PRESTOP_CAPTURE=PASS'
    Write-Host "MIG_005_CAPTURE_LANE_COUNT=$($core.lane_count)"
    Write-Host "MIG_005_CAPTURE_REGISTRY_LANE_COUNT=$($core.registry_lane_count)"
    Write-Host "MIG_005_CAPTURE_OWNER_STOP_BLOCKED=$([bool]$ownerStop.blocked)"
    Write-Host "MIG_005_CAPTURE_AUTHORITY_ACTIVE=$([bool]($truth.wrapper_alive -or $truth.three_lane_alive))"
    Write-Host 'MIG_005_RAW_PRIVATE_VALUES_LOGGED=False'
}

function New-ExportPackage([string]$Root,[string]$PreStopCapturePath,[string]$ZipPath,[string]$Sha) {
    Assert-CandidateSha $Sha
    $capture = Read-JsonStrict $PreStopCapturePath
    if ([string]$capture.schema_version -ne $CaptureSchema) { throw 'Invalid pre-stop capture schema.' }
    if ([string]$capture.candidate_sha -ne $Sha) { throw 'Pre-stop capture candidate SHA mismatch.' }
    if ([string]$capture.source_root_fingerprint -ne (Get-RootHash $Root)) {
        throw 'Pre-stop capture state-root fingerprint mismatch.'
    }
    $truth = Get-LifecycleProcessTruth -Root $Root
    if ($truth.wrapper_alive -or $truth.three_lane_alive) {
        throw 'Old production authority is still active; export is forbidden.'
    }
    $core = Get-CoreState $Root
    if ($core.target_fingerprint -ne [string]$capture.target_fingerprint) {
        throw 'Brain/Work target fingerprint changed between pre-stop capture and export.'
    }
    if ($core.registry_continuity_fingerprint -ne [string]$capture.registry_continuity_fingerprint) {
        throw 'Registry/latch continuity fingerprint changed between pre-stop capture and export.'
    }
    foreach ($name in $RequiredStateFiles) {
        if ((Get-FileSha256 (Join-Path $Root $name)) -ne [string]$capture.core_file_hashes.$name) {
            throw "Authoritative state changed after pre-stop capture: $name"
        }
    }

    $packageParent = Split-Path -Parent $ZipPath
    if (-not $packageParent) { $packageParent = (Get-Location).Path }
    New-Item -ItemType Directory -Force -Path $packageParent | Out-Null
    $stage = Join-Path $packageParent ('.mig005-export-' + [guid]::NewGuid().ToString('N'))
    $payload = Join-Path $stage 'payload'
    New-Item -ItemType Directory -Force -Path $payload | Out-Null

    try {
        foreach ($name in $RequiredStateFiles) {
            Copy-Item -Path (Join-Path $Root $name) -Destination (Join-Path $payload $name) -Force
        }
        $relayEvidence = Get-ReferencedRelayEvidence -Root $Root -Registry $core.registry
        foreach ($item in $relayEvidence) {
            $dest = Join-Path $payload $item.relative_path
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
            Copy-Item -Path $item.source_path -Destination $dest -Force
        }

        # Preserve actual pre-stop Owner intent only. The supported STOP mechanism
        # creates STOP/AUTOSTART_DISABLED for handoff safety; those synthetic
        # transfer latches are not reclassified as historical Owner STOP.
        if ([bool]$capture.owner_stop_before.stop_present) {
            Copy-Item -Path (Join-Path $Root 'STOP') -Destination (Join-Path $payload 'STOP') -Force
        }
        if ([bool]$capture.owner_stop_before.autostart_disabled_present) {
            Copy-Item -Path (Join-Path $Root 'AUTOSTART_DISABLED') -Destination (Join-Path $payload 'AUTOSTART_DISABLED') -Force
        }

        $entries = @()
        foreach ($file in @(Get-ChildItem -Path $payload -File -Recurse | Sort-Object FullName)) {
            $relative = $file.FullName.Substring($payload.Length).TrimStart('\').Replace('\','/')
            $entries += [ordered]@{
                relative_path = $relative
                size_bytes = [int64]$file.Length
                sha256 = Get-FileSha256 $file.FullName
            }
        }

        $manifest = [ordered]@{
            schema_version = $Schema
            candidate_sha = $Sha
            source_root_fingerprint = [string]$capture.source_root_fingerprint
            lane_count = $core.lane_count
            registry_lane_count = $core.registry_lane_count
            enabled_lane_count = $core.enabled_lane_count
            target_fingerprint = $core.target_fingerprint
            registry_continuity_fingerprint = $core.registry_continuity_fingerprint
            owner_stop_preserved = [ordered]@{
                stop_present = [bool]$capture.owner_stop_before.stop_present
                autostart_disabled_present = [bool]$capture.owner_stop_before.autostart_disabled_present
                blocked = [bool]$capture.owner_stop_before.blocked
            }
            authority_transition = [ordered]@{
                pre_stop_wrapper_alive = [bool]$capture.authority_before.wrapper_alive
                pre_stop_three_lane_alive = [bool]$capture.authority_before.three_lane_alive
                post_stop_wrapper_alive = [bool]$truth.wrapper_alive
                post_stop_three_lane_alive = [bool]$truth.three_lane_alive
                zero_authority_verified = [bool](-not $truth.wrapper_alive -and -not $truth.three_lane_alive)
            }
            autostart_registration_pre_stop = [bool]$capture.autostart_registration_present
            referenced_relay_evidence_count = @($relayEvidence).Count
            files = $entries
            excluded_surfaces = @(
                'runtime/','supervisor.pid','runtime-status.json','supervisor.log',
                'browser_profile/','autostart-install-status.json','unreferenced lane-evidence'
            )
            privacy = [ordered]@{
                raw_targets_in_manifest = $false
                raw_messages_in_manifest = $false
                cookies_tokens_browser_profile_in_package = $false
            }
            rbt009_tier_b_480m = 'NOT_RUN'
        }
        Write-Utf8NoBom (Join-Path $stage $ManifestName) (($manifest | ConvertTo-Json -Depth 30) + [Environment]::NewLine)
        if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
        Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $ZipPath -CompressionLevel Optimal
        $zipHash = Get-FileSha256 $ZipPath
        Write-Host 'MIG_005_STATE_EXPORT=PASS'
        Write-Host 'MIG_005_OLD_AUTHORITY_ZERO=True'
        Write-Host "MIG_005_PACKAGE_FILE_COUNT=$(@($entries).Count)"
        Write-Host "MIG_005_RELAY_EVIDENCE_COUNT=$(@($relayEvidence).Count)"
        Write-Host "MIG_005_PACKAGE_SHA256=$zipHash"
        Write-Host 'MIG_005_RAW_PRIVATE_VALUES_LOGGED=False'
        Write-Host 'RBT009_TIER_B_480M=NOT_RUN'
    } finally {
        Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Expand-And-ValidatePackage([string]$ZipPath,[string]$ExpectedHash,[string]$Sha) {
    Assert-CandidateSha $Sha
    if ($ExpectedHash -notmatch '^[a-fA-F0-9]{64}$') {
        throw 'ExpectedPackageSha256 must be an exact SHA256 hex digest.'
    }
    $actual = Get-FileSha256 $ZipPath
    if ($actual -ne $ExpectedHash.ToLowerInvariant()) { throw 'Package SHA256 mismatch.' }

    $parent = Split-Path -Parent $ZipPath
    if (-not $parent) { $parent = (Get-Location).Path }
    $stage = Join-Path $parent ('.mig005-import-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Expand-Archive -Path $ZipPath -DestinationPath $stage -Force
    $manifest = Read-JsonStrict (Join-Path $stage $ManifestName)
    if ([string]$manifest.schema_version -ne $Schema) {
        Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
        throw 'Invalid transfer manifest schema.'
    }
    if ([string]$manifest.candidate_sha -ne $Sha) {
        Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
        throw 'Transfer manifest candidate SHA mismatch.'
    }

    $payload = Join-Path $stage 'payload'
    foreach ($entry in @($manifest.files)) {
        $relative = ([string]$entry.relative_path).Replace('/','\')
        if ($relative -match '(^|\\)\.\.(\\|$)') {
            Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
            throw 'Unsafe relative path in transfer manifest.'
        }
        $file = Join-Path $payload $relative
        if (-not (Test-Path $file -PathType Leaf)) {
            Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
            throw "Transfer payload file missing: $relative"
        }
        $item = Get-Item $file
        if ([int64]$item.Length -ne [int64]$entry.size_bytes) {
            Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
            throw "Transfer payload size mismatch: $relative"
        }
        if ((Get-FileSha256 $file) -ne [string]$entry.sha256) {
            Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
            throw "Transfer payload hash mismatch: $relative"
        }
    }
    return [pscustomobject]@{
        stage = $stage
        payload = $payload
        manifest = $manifest
        package_sha256 = $actual
    }
}

function Assert-NewMachineInactive([string]$Root) {
    $truth = Get-LifecycleProcessTruth -Root $Root
    if ($truth.wrapper_alive -or $truth.three_lane_alive) {
        throw 'New-machine Supervisor authority is already active; import/verify is forbidden.'
    }
    if (Get-AutostartPresent) {
        throw 'New-machine production autostart is already registered; import is forbidden.'
    }
}

function Assert-DestinationBootstrapOnly([string]$Root) {
    if (-not (Test-Path $Root)) { return }
    $allowed = @('STOP','AUTOSTART_DISABLED')
    $unexpected = @(Get-ChildItem -Path $Root -Force | Where-Object { $_.Name -notin $allowed })
    if ($unexpected.Count -gt 0) {
        throw 'Destination state root is not empty/bootstrap-only; refusing overwrite.'
    }
}

function Rebase-RelayScreenshotPaths([string]$Root) {
    $registryPath = Join-Path $Root 'lane-registry.json'
    $registry = Read-JsonStrict $registryPath
    $changed = $false
    foreach ($prop in @($registry.lanes.PSObject.Properties)) {
        $lane = $prop.Value
        if (-not $lane -or -not $lane.relay_inflight -or -not $lane.relay_inflight.screenshot_path) { continue }
        $leaf = [IO.Path]::GetFileName([string]$lane.relay_inflight.screenshot_path)
        $newPath = Join-Path (Join-Path $Root 'lane-evidence') $leaf
        if (-not (Test-Path $newPath -PathType Leaf)) { throw "Referenced relay screenshot was not imported: $leaf" }
        $lane.relay_inflight.screenshot_path = $newPath
        $changed = $true
    }
    if ($changed) {
        Write-Utf8NoBom $registryPath (($registry | ConvertTo-Json -Depth 40) + [Environment]::NewLine)
    }
}

function Import-Package([string]$ZipPath,[string]$ExpectedHash,[string]$Root,[string]$Sha) {
    Assert-NewMachineInactive $Root
    Assert-DestinationBootstrapOnly $Root
    $validated = Expand-And-ValidatePackage -ZipPath $ZipPath -ExpectedHash $ExpectedHash -Sha $Sha
    $finalStage = $null
    try {
        $payloadCore = Get-CoreState $validated.payload
        if ($payloadCore.target_fingerprint -ne [string]$validated.manifest.target_fingerprint) {
            throw 'Payload target fingerprint mismatch.'
        }
        if ($payloadCore.registry_continuity_fingerprint -ne [string]$validated.manifest.registry_continuity_fingerprint) {
            throw 'Payload registry/latch continuity fingerprint mismatch.'
        }

        $finalStage = "$Root.mig005-stage-" + [guid]::NewGuid().ToString('N')
        New-Item -ItemType Directory -Force -Path $finalStage | Out-Null
        Copy-Item -Path (Join-Path $validated.payload '*') -Destination $finalStage -Recurse -Force
        Rebase-RelayScreenshotPaths -Root $finalStage

        $finalCore = Get-CoreState $finalStage
        if ($finalCore.target_fingerprint -ne [string]$validated.manifest.target_fingerprint) {
            throw 'Imported target fingerprint mismatch after path rebase.'
        }
        if ($finalCore.registry_continuity_fingerprint -ne [string]$validated.manifest.registry_continuity_fingerprint) {
            throw 'Imported registry/latch continuity mismatch after path rebase.'
        }

        $expectedStop = [bool]$validated.manifest.owner_stop_preserved.stop_present
        $expectedDisabled = [bool]$validated.manifest.owner_stop_preserved.autostart_disabled_present
        if ((Test-Path (Join-Path $finalStage 'STOP')) -ne $expectedStop) {
            throw 'Imported STOP state does not match preserved pre-stop Owner intent.'
        }
        if ((Test-Path (Join-Path $finalStage 'AUTOSTART_DISABLED')) -ne $expectedDisabled) {
            throw 'Imported AUTOSTART_DISABLED state does not match preserved pre-stop Owner intent.'
        }

        if (Test-Path $Root) {
            foreach ($name in @('STOP','AUTOSTART_DISABLED')) {
                $path = Join-Path $Root $name
                if (Test-Path $path) { Remove-Item $path -Force }
            }
            if (@(Get-ChildItem -Path $Root -Force).Count -ne 0) {
                throw 'Destination bootstrap root did not become empty.'
            }
            Remove-Item $Root -Force
            Write-Host 'MIG_005_DEFAULT_BLOCKED_BOOTSTRAP_REPLACED=True'
        }

        Move-Item -Path $finalStage -Destination $Root
        $finalStage = $null
        Write-Host 'MIG_005_STATE_IMPORT=PASS'
        Write-Host "MIG_005_IMPORT_LANE_COUNT=$($finalCore.lane_count)"
        Write-Host "MIG_005_IMPORT_REGISTRY_LANE_COUNT=$($finalCore.registry_lane_count)"
        Write-Host 'MIG_005_IMPORT_TARGET_FINGERPRINT_MATCH=True'
        Write-Host 'MIG_005_IMPORT_LATCH_FINGERPRINT_MATCH=True'
        Write-Host "MIG_005_IMPORTED_OWNER_STOP_BLOCKED=$([bool]$validated.manifest.owner_stop_preserved.blocked)"
        Write-Host 'MIG_005_NEW_AUTHORITY_STARTED=False'
        Write-Host 'RBT009_TIER_B_480M=NOT_RUN'
    } finally {
        Remove-Item $validated.stage -Recurse -Force -ErrorAction SilentlyContinue
        if ($finalStage -and (Test-Path $finalStage)) {
            Remove-Item $finalStage -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Verify-ImportedState([string]$ZipPath,[string]$ExpectedHash,[string]$Root,[string]$Sha) {
    Assert-NewMachineInactive $Root
    $validated = Expand-And-ValidatePackage -ZipPath $ZipPath -ExpectedHash $ExpectedHash -Sha $Sha
    try {
        $core = Get-CoreState $Root
        if ($core.target_fingerprint -ne [string]$validated.manifest.target_fingerprint) {
            throw 'Destination target fingerprint mismatch.'
        }
        if ($core.registry_continuity_fingerprint -ne [string]$validated.manifest.registry_continuity_fingerprint) {
            throw 'Destination registry/latch continuity mismatch.'
        }
        foreach ($entry in @($validated.manifest.files)) {
            $relative = ([string]$entry.relative_path).Replace('/','\')
            if ($relative -eq 'lane-registry.json') { continue }
            $dest = Join-Path $Root $relative
            if (-not (Test-Path $dest -PathType Leaf)) { throw "Imported state file missing: $relative" }
            if ((Get-FileSha256 $dest) -ne [string]$entry.sha256) {
                throw "Imported state hash mismatch: $relative"
            }
        }
        $owner = Get-LifecycleOwnerStopState -Root $Root
        if ([bool]$owner.stop_present -ne [bool]$validated.manifest.owner_stop_preserved.stop_present) {
            throw 'Destination STOP semantics mismatch.'
        }
        if ([bool]$owner.autostart_disabled_present -ne [bool]$validated.manifest.owner_stop_preserved.autostart_disabled_present) {
            throw 'Destination AUTOSTART_DISABLED semantics mismatch.'
        }
        Write-Host 'MIG_005_STATE_VERIFY=PASS'
        Write-Host "MIG_005_VERIFY_LANE_COUNT=$($core.lane_count)"
        Write-Host "MIG_005_VERIFY_REGISTRY_LANE_COUNT=$($core.registry_lane_count)"
        Write-Host 'MIG_005_VERIFY_TARGETS_PRESERVED=True'
        Write-Host 'MIG_005_VERIFY_LATCHES_PRESERVED=True'
        Write-Host "MIG_005_VERIFY_OWNER_STOP_BLOCKED=$([bool]$owner.blocked)"
        Write-Host 'MIG_005_NEW_AUTHORITY_STARTED=False'
        Write-Host 'RBT009_TIER_B_480M=NOT_RUN'
    } finally {
        Remove-Item $validated.stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}

switch ($Mode) {
    'Capture' {
        if (-not $SourceRoot -or -not $CapturePath -or -not $CandidateSha) {
            throw 'Capture requires SourceRoot, CapturePath and CandidateSha.'
        }
        New-Capture -Root $SourceRoot -OutputPath $CapturePath -Sha $CandidateSha
    }
    'Export' {
        if (-not $SourceRoot -or -not $CapturePath -or -not $PackageZip -or -not $CandidateSha) {
            throw 'Export requires SourceRoot, CapturePath, PackageZip and CandidateSha.'
        }
        New-ExportPackage -Root $SourceRoot -PreStopCapturePath $CapturePath -ZipPath $PackageZip -Sha $CandidateSha
    }
    'Import' {
        if (-not $DestinationRoot -or -not $PackageZip -or -not $ExpectedPackageSha256 -or -not $CandidateSha) {
            throw 'Import requires DestinationRoot, PackageZip, ExpectedPackageSha256 and CandidateSha.'
        }
        Import-Package -ZipPath $PackageZip -ExpectedHash $ExpectedPackageSha256 -Root $DestinationRoot -Sha $CandidateSha
    }
    'Verify' {
        if (-not $DestinationRoot -or -not $PackageZip -or -not $ExpectedPackageSha256 -or -not $CandidateSha) {
            throw 'Verify requires DestinationRoot, PackageZip, ExpectedPackageSha256 and CandidateSha.'
        }
        Verify-ImportedState -ZipPath $PackageZip -ExpectedHash $ExpectedPackageSha256 -Root $DestinationRoot -Sha $CandidateSha
    }
}
