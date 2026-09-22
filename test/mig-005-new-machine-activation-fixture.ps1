$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repoRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repoRoot 'windows\mig-005-new-machine-activate.ps1'
$transfer = Join-Path $repoRoot 'windows\mig-005-state-transfer.ps1'
$packageCandidate = 'dc0b5f369f6a9c3ae89d821f1ddf603e1135f51e'
$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$tempRoot = Join-Path $tempBase ('mig005-new-machine-fixture-' + [guid]::NewGuid().ToString('N'))
$oldLocalAppData = $env:LOCALAPPDATA
$oldProcessStateRoot = [string]$env:SUPERVISOR_STATE_ROOT
$oldUserStateRoot = [Environment]::GetEnvironmentVariable('SUPERVISOR_STATE_ROOT','User')
$worktree = Join-Path $tempRoot 'changed-transfer-worktree'

function Write-Json([string]$Path,$Value) {
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [IO.File]::WriteAllText($Path,(($Value | ConvertTo-Json -Depth 40) + [Environment]::NewLine),(New-Object Text.UTF8Encoding($false)))
}

function New-ManifestZip([string]$Candidate,[string]$ZipPath) {
    $dir = Join-Path $tempRoot ('manifest-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Write-Json (Join-Path $dir 'MIG_005_STATE_TRANSFER_MANIFEST.json') ([ordered]@{
        schema_version = 'supervisor-mig005-state-transfer.v1'
        candidate_sha = $Candidate
    })
    Compress-Archive -Path (Join-Path $dir '*') -DestinationPath $ZipPath -CompressionLevel Optimal
    Remove-Item $dir -Recurse -Force
    return (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Invoke-ExpectedFailure([string[]]$CommandArgs,[string]$ExpectedText) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & powershell.exe @CommandArgs 2>&1
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
    $joined = $output | Out-String
    if ($code -eq 0) { throw "Expected failure unexpectedly succeeded: $ExpectedText" }
    if ($joined -notmatch [regex]::Escape($ExpectedText)) { throw ("Expected failure text missing: $ExpectedText" + [Environment]::NewLine + $joined) }
}

function New-StateFixture([string]$Root) {
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Root 'lane-evidence') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Root 'browser_profile') | Out-Null

    $lanes = @()
    foreach ($i in 1..3) {
        $lanes += [ordered]@{
            lane_id = "lane-$i"
            project_name = "Fixture $i"
            brain_url = "https://chatgpt.com/c/fixture-brain-$i"
            brain_url_revision = 1
            work_url = "https://chatgpt.com/c/fixture-work-$i"
            work_url_revision = 1
            work_url_saved_at = '2026-09-22T00:00:00Z'
            work_mode = 'OWNER'
            work_state_reset_revision = 2
            relay_retry_rearm_revision = 0
            relay_retry_rearm_requested_at = $null
            enabled = $false
        }
    }
    Write-Json (Join-Path $Root 'lanes.json') ([ordered]@{
        schema_version = 'three-lane-config.v1'
        mode = 'THREE_LANE_V1'
        lanes = $lanes
    })

    $shot = Join-Path $Root 'lane-evidence\lane-1-fixture-relay.png'
    [IO.File]::WriteAllBytes($shot,[byte[]](1,2,3,4,5,6,7,8))
    $registryLanes = [ordered]@{}
    foreach ($i in 1..3) {
        $relay = $null
        if ($i -eq 1) {
            $relay = [ordered]@{
                relay_id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
                response_digest = ('b' * 64)
                text_digest = ('c' * 64)
                screenshot_path = $shot
                attempt_count = 1
                retry_not_before = $null
                retry_exhausted = $false
                last_attempt_state = 'READY'
            }
        }
        $registryLanes["lane-$i"] = [ordered]@{
            lane_id = "lane-$i"
            brain_url = "https://chatgpt.com/c/fixture-brain-$i"
            applied_brain_url_revision = 1
            work_url = "https://chatgpt.com/c/fixture-work-$i"
            work_generation = 1
            applied_work_mode = 'OWNER'
            applied_work_saved_at = '2026-09-22T00:00:00Z'
            pending_work_url = ''
            pending_work_url_revision = 0
            pending_work_saved_at = $null
            pending_work_mode = $null
            applied_work_state_reset_revision = 2
            task_id = "FIXTURE-$i"
            instruction_digest = ('d' * 64)
            last_brain_directive_digest = ('e' * 64)
            last_work_result_digest = $null
            last_result_relay_id = $null
            last_result_verdict = $null
            last_dispatch_id = "dispatch-$i"
            dispatch_inflight = if ($i -eq 2) { [ordered]@{ dispatch_id='fixture-dispatch'; send_state='SEND_CLICKED' } } else { $null }
            relay_inflight = $relay
            applied_relay_retry_rearm_revision = 0
            brain_request_inflight = $null
            brain_request_sent = $false
            awaiting_work = $true
            task_timing = [ordered]@{}
            work_watchdog = [ordered]@{}
            work_rollover = $null
            brain_target_health = [ordered]@{}
            work_target_health = [ordered]@{}
            applied_work_url_revision = 1
        }
    }
    Write-Json (Join-Path $Root 'lane-registry.json') ([ordered]@{
        schema_version = 'three-lane-registry.v1'
        mode = 'THREE_LANE_V1'
        lanes = $registryLanes
    })
    Write-Json (Join-Path $Root 'lane-status.json') ([ordered]@{
        schema_version = 'three-lane-status.v1'
        mode = 'THREE_LANE_V1'
        supervisor_runtime_version = 'fixture'
        lanes = @(
            [ordered]@{lane_id='lane-1';state='READY'},
            [ordered]@{lane_id='lane-2';state='READY'},
            [ordered]@{lane_id='lane-3';state='READY'}
        )
    })
    Set-Content -Path (Join-Path $Root 'lane-events.ndjson') -Value '{"event_type":"FIXTURE"}' -Encoding ascii
    Set-Content -Path (Join-Path $Root 'browser_profile\Cookies') -Value 'DO_NOT_TRANSFER' -Encoding ascii
}

function Invoke-Transfer([string[]]$CommandArgs) {
    $output = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $transfer @CommandArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("Transfer command failed:" + [Environment]::NewLine + ($output | Out-String)) }
    return ($output | Out-String)
}

try {
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    $env:LOCALAPPDATA = Join-Path $tempRoot 'LocalAppData'
    $env:SUPERVISOR_STATE_ROOT = $null

    $runtimeSha = (& git -C $repoRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $runtimeSha -notmatch '^[a-f0-9]{40}$') { throw 'Unable to resolve exact runtime candidate SHA.' }
    & git -C $repoRoot cat-file -e ($packageCandidate + '^{commit}')
    if ($LASTEXITCODE -ne 0) { throw 'Package candidate is missing from checkout history.' }

    $platformRoot = Join-Path $env:LOCALAPPDATA 'MAGASIN\Supervisor'
    if (Test-Path $platformRoot) { throw 'Fixture platform root unexpectedly exists before validation.' }

    $compatibleZip = Join-Path $tempRoot 'compatible.zip'
    $compatibleHash = New-ManifestZip -Candidate $packageCandidate -ZipPath $compatibleZip
    $output = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $wrapper -Mode Validate -PackageZip $compatibleZip -ExpectedPackageSha256 $compatibleHash -PackageCandidateSha $packageCandidate -CandidateSha $runtimeSha 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("Compatible provenance validation failed:" + [Environment]::NewLine + ($output | Out-String)) }
    $joined = $output | Out-String
    foreach ($marker in @(
        'MIG_005_PACKAGE_CANDIDATE_SHA_VERIFIED=True',
        'MIG_005_RUNTIME_CANDIDATE_SHA_VERIFIED=True',
        'MIG_005_PACKAGE_RUNTIME_ANCESTRY_VERIFIED=True',
        'MIG_005_TRANSFER_BLOB_IDENTITY_VERIFIED=True',
        'MIG_005_PACKAGE_RUNTIME_PROVENANCE_COMPATIBLE=True',
        'MIG_005_NEW_MACHINE_VALIDATE_ONLY=PASS'
    )) {
        if ($joined -notmatch [regex]::Escape($marker)) { throw "Compatible provenance marker missing: $marker" }
    }

    $wrongCandidateArgs = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$wrapper,'-Mode','Validate','-PackageZip',$compatibleZip,'-ExpectedPackageSha256',$compatibleHash,'-PackageCandidateSha',$runtimeSha,'-CandidateSha',$runtimeSha)
    Invoke-ExpectedFailure -CommandArgs $wrongCandidateArgs -ExpectedText 'Package manifest candidate SHA does not match PackageCandidateSha.'

    $tree = (& git -C $repoRoot rev-parse ($runtimeSha + '^{tree}')).Trim()
    $env:GIT_AUTHOR_NAME='MIG005 Fixture'; $env:GIT_AUTHOR_EMAIL='fixture@example.invalid'
    $env:GIT_COMMITTER_NAME='MIG005 Fixture'; $env:GIT_COMMITTER_EMAIL='fixture@example.invalid'
    $orphan = (& git -C $repoRoot commit-tree $tree -m 'MIG005 non-ancestor fixture').Trim()
    if ($LASTEXITCODE -ne 0 -or $orphan -notmatch '^[a-f0-9]{40}$') { throw 'Could not create non-ancestor fixture commit.' }
    $orphanZip = Join-Path $tempRoot 'orphan.zip'
    $orphanHash = New-ManifestZip -Candidate $orphan -ZipPath $orphanZip
    $orphanArgs = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$wrapper,'-Mode','Validate','-PackageZip',$orphanZip,'-ExpectedPackageSha256',$orphanHash,'-PackageCandidateSha',$orphan,'-CandidateSha',$runtimeSha)
    Invoke-ExpectedFailure -CommandArgs $orphanArgs -ExpectedText 'PackageCandidateSha is not an ancestor of CandidateSha.'

    & git -C $repoRoot worktree add --detach $worktree $runtimeSha | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not create changed-transfer fixture worktree.' }
    git -C $worktree config user.name 'MIG005 Fixture'
    git -C $worktree config user.email 'fixture@example.invalid'
    Add-Content -Path (Join-Path $worktree 'windows\mig-005-state-transfer.ps1') -Value '# fixture transfer blob change'
    git -C $worktree add windows/mig-005-state-transfer.ps1
    git -C $worktree commit -m 'fixture: change transfer blob' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not commit changed transfer blob fixture.' }
    $changedRuntimeSha = (& git -C $worktree rev-parse HEAD).Trim()
    $changedWrapper = Join-Path $worktree 'windows\mig-005-new-machine-activate.ps1'
    $changedZip = Join-Path $tempRoot 'changed-blob.zip'
    $changedHash = New-ManifestZip -Candidate $runtimeSha -ZipPath $changedZip
    $changedArgs = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$changedWrapper,'-Mode','Validate','-PackageZip',$changedZip,'-ExpectedPackageSha256',$changedHash,'-PackageCandidateSha',$runtimeSha,'-CandidateSha',$changedRuntimeSha)
    Invoke-ExpectedFailure -CommandArgs $changedArgs -ExpectedText 'Package/runtime transfer blob identity mismatch.'

    $wrongHash = '0' * 64
    if ($wrongHash -eq $compatibleHash) { $wrongHash = 'f' * 64 }
    $hashArgs = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$wrapper,'-Mode','Validate','-PackageZip',$compatibleZip,'-ExpectedPackageSha256',$wrongHash,'-PackageCandidateSha',$packageCandidate,'-CandidateSha',$runtimeSha)
    Invoke-ExpectedFailure -CommandArgs $hashArgs -ExpectedText 'MIG-005 package SHA256 mismatch; fail closed before mutation.'

    $source = Join-Path $tempRoot 'source'
    $capture = Join-Path $tempRoot 'capture.json'
    $realZip = Join-Path $tempRoot 'real-package.zip'
    $dest = Join-Path $tempRoot 'dest'
    New-StateFixture -Root $source
    Invoke-Transfer -CommandArgs @('-Mode','Capture','-SourceRoot',$source,'-CapturePath',$capture,'-CandidateSha',$packageCandidate) | Out-Null
    Invoke-Transfer -CommandArgs @('-Mode','Export','-SourceRoot',$source,'-CapturePath',$capture,'-PackageZip',$realZip,'-CandidateSha',$packageCandidate) | Out-Null
    $realHash = (Get-FileHash $realZip -Algorithm SHA256).Hash.ToLowerInvariant()

    $validateReal = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $wrapper -Mode Validate -PackageZip $realZip -ExpectedPackageSha256 $realHash -PackageCandidateSha $packageCandidate -CandidateSha $runtimeSha 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("Real package provenance validation failed:" + [Environment]::NewLine + ($validateReal | Out-String)) }

    $importOutput = Invoke-Transfer -CommandArgs @('-Mode','Import','-DestinationRoot',$dest,'-PackageZip',$realZip,'-ExpectedPackageSha256',$realHash,'-CandidateSha',$packageCandidate)
    $verifyOutput = Invoke-Transfer -CommandArgs @('-Mode','Verify','-DestinationRoot',$dest,'-PackageZip',$realZip,'-ExpectedPackageSha256',$realHash,'-CandidateSha',$packageCandidate)
    $combined = $importOutput + $verifyOutput
    foreach ($marker in @(
        'MIG_005_IMPORT_LANE_COUNT=3',
        'MIG_005_IMPORT_REGISTRY_LANE_COUNT=3',
        'MIG_005_IMPORT_ENABLED_LANE_COUNT=0',
        'MIG_005_IMPORT_TARGET_FINGERPRINT_MATCH=True',
        'MIG_005_IMPORT_LATCH_FINGERPRINT_MATCH=True',
        'MIG_005_IMPORTED_OWNER_STOP_BLOCKED=False',
        'MIG_005_VERIFY_LANE_COUNT=3',
        'MIG_005_VERIFY_REGISTRY_LANE_COUNT=3',
        'MIG_005_VERIFY_ENABLED_LANE_COUNT=0',
        'MIG_005_VERIFY_TARGETS_PRESERVED=True',
        'MIG_005_VERIFY_LATCHES_PRESERVED=True',
        'MIG_005_VERIFY_OWNER_STOP_BLOCKED=False'
    )) {
        if ($combined -notmatch [regex]::Escape($marker)) { throw "Cross-candidate state marker missing: $marker" }
    }

    if (Test-Path $platformRoot) { throw 'Validation/provenance tests mutated the platform state root.' }
    if ([Environment]::GetEnvironmentVariable('SUPERVISOR_STATE_ROOT','User') -ne $oldUserStateRoot) { throw 'Fixture changed CurrentUser SUPERVISOR_STATE_ROOT.' }

    Write-Host 'MIG_005_NEW_MACHINE_VALIDATE_FIXTURE=PASS'
    Write-Host 'MIG_005_PACKAGE_RUNTIME_COMPATIBLE_ANCESTOR_SAME_BLOB=True'
    Write-Host 'MIG_005_NON_ANCESTOR_FAIL_BEFORE_MUTATION=True'
    Write-Host 'MIG_005_CHANGED_TRANSFER_BLOB_FAIL_BEFORE_MUTATION=True'
    Write-Host 'MIG_005_WRONG_PACKAGE_CANDIDATE_FAIL=True'
    Write-Host 'MIG_005_PACKAGE_HASH_FAIL_BEFORE_MUTATION=True'
    Write-Host 'MIG_005_DC0_PACKAGE_CURRENT_RUNTIME_STATE_CONTINUITY=True'
    Write-Host 'MIG_005_PLATFORM_DEFAULT_EXPLICIT_ROOT=True'
    Write-Host 'MIG_005_PERSISTENT_ENV_UNCHANGED_IN_VALIDATE=True'
    Write-Host 'RBT009_TIER_B_480M=NOT_RUN'
}
finally {
    if (Test-Path $worktree) { & git -C $repoRoot worktree remove --force $worktree 2>$null | Out-Null }
    $env:LOCALAPPDATA = $oldLocalAppData
    $env:SUPERVISOR_STATE_ROOT = $oldProcessStateRoot
    [Environment]::SetEnvironmentVariable('SUPERVISOR_STATE_ROOT',$oldUserStateRoot,'User')
    Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
