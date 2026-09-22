$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repoRoot = Split-Path -Parent $PSScriptRoot
$transfer = Join-Path $repoRoot 'windows\mig-005-state-transfer.ps1'
$candidate = '1111111111111111111111111111111111111111'
$tempRoot = Join-Path $env:RUNNER_TEMP ('mig005-transfer-fixture-' + [guid]::NewGuid().ToString('N'))

function Write-Json([string]$Path, $Value) {
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [System.IO.File]::WriteAllText(
        $Path,
        (($Value | ConvertTo-Json -Depth 40) + [Environment]::NewLine),
        (New-Object System.Text.UTF8Encoding($false))
    )
}

function New-StateFixture([string]$Root, [bool]$OwnerStop) {
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Root 'lane-evidence') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Root 'browser_profile') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Root 'runtime') | Out-Null

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
            enabled = $true
        }
    }

    $config = [ordered]@{
        schema_version = 'three-lane-config.v1'
        mode = 'THREE_LANE_V1'
        lanes = $lanes
    }
    Write-Json (Join-Path $Root 'lanes.json') $config

    $shot = Join-Path $Root 'lane-evidence\lane-1-fixture-relay.png'
    [IO.File]::WriteAllBytes($shot, [byte[]](1,2,3,4,5,6,7,8))

    $registryLanes = [ordered]@{}
    foreach ($i in 1..3) {
        $relay = $null
        if ($i -eq 1) {
            $relay = [ordered]@{
                relay_id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
                response_digest = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
                text_digest = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
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
            dispatch_inflight = if ($i -eq 2) { [ordered]@{ dispatch_id = 'fixture-dispatch'; send_state = 'SEND_CLICKED' } } else { $null }
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

    $registry = [ordered]@{
        schema_version = 'three-lane-registry.v1'
        mode = 'THREE_LANE_V1'
        lanes = $registryLanes
    }
    Write-Json (Join-Path $Root 'lane-registry.json') $registry

    $status = [ordered]@{
        schema_version = 'three-lane-status.v1'
        mode = 'THREE_LANE_V1'
        supervisor_runtime_version = 'fixture'
        lanes = @(
            [ordered]@{ lane_id='lane-1'; state='WORKING' },
            [ordered]@{ lane_id='lane-2'; state='WORKING' },
            [ordered]@{ lane_id='lane-3'; state='READY' }
        )
    }
    Write-Json (Join-Path $Root 'lane-status.json') $status
    Set-Content -Path (Join-Path $Root 'lane-events.ndjson') -Value '{"event_type":"FIXTURE"}' -Encoding ascii

    Set-Content -Path (Join-Path $Root 'browser_profile\Cookies') -Value 'DO_NOT_TRANSFER' -Encoding ascii
    Set-Content -Path (Join-Path $Root 'runtime\machine-local.txt') -Value 'DO_NOT_TRANSFER' -Encoding ascii
    Set-Content -Path (Join-Path $Root 'supervisor.log') -Value 'DO_NOT_TRANSFER' -Encoding ascii
    Set-Content -Path (Join-Path $Root 'supervisor.pid') -Value '99999' -Encoding ascii

    if ($OwnerStop) {
        Set-Content -Path (Join-Path $Root 'STOP') -Value 'STOP' -Encoding ascii
        Set-Content -Path (Join-Path $Root 'AUTOSTART_DISABLED') -Value 'OWNER_STOP' -Encoding ascii
    }
}

function Invoke-Transfer([string[]]$Arguments) {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $transfer @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Transfer command failed: $($Arguments -join ' ')"
    }
}

try {
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

    # Scenario 1: production was running without an actual Owner STOP. The handoff
    # STOP creates temporary blockers, but import must not misclassify them as Owner intent.
    $source = Join-Path $tempRoot 'source-normal'
    $capture = Join-Path $tempRoot 'capture-normal.json'
    $zip = Join-Path $tempRoot 'normal.zip'
    $dest = Join-Path $tempRoot 'dest-normal'

    New-StateFixture -Root $source -OwnerStop $false
    Invoke-Transfer @('-Mode','Capture','-SourceRoot',$source,'-CapturePath',$capture,'-CandidateSha',$candidate)

    Set-Content -Path (Join-Path $source 'STOP') -Value 'STOP' -Encoding ascii
    Set-Content -Path (Join-Path $source 'AUTOSTART_DISABLED') -Value 'OWNER_STOP' -Encoding ascii
    Invoke-Transfer @('-Mode','Export','-SourceRoot',$source,'-CapturePath',$capture,'-PackageZip',$zip,'-CandidateSha',$candidate)

    $zipHash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()

    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Set-Content -Path (Join-Path $dest 'STOP') -Value 'BOOTSTRAP_BLOCK' -Encoding ascii
    Set-Content -Path (Join-Path $dest 'AUTOSTART_DISABLED') -Value 'BOOTSTRAP_BLOCK' -Encoding ascii
    New-Item -ItemType Directory -Force -Path (Join-Path $dest 'browser_profile') | Out-Null
    Set-Content -Path (Join-Path $dest 'browser_profile\Cookies') -Value 'DESTINATION_KEEP' -Encoding ascii

    Invoke-Transfer @('-Mode','Import','-DestinationRoot',$dest,'-PackageZip',$zip,'-ExpectedPackageSha256',$zipHash,'-CandidateSha',$candidate)
    Invoke-Transfer @('-Mode','Verify','-DestinationRoot',$dest,'-PackageZip',$zip,'-ExpectedPackageSha256',$zipHash,'-CandidateSha',$candidate)

    if (Test-Path (Join-Path $dest 'STOP')) { throw 'Synthetic handoff STOP leaked into imported canonical state.' }
    if (Test-Path (Join-Path $dest 'AUTOSTART_DISABLED')) { throw 'Synthetic handoff AUTOSTART_DISABLED leaked into imported canonical state.' }
    if (-not (Test-Path (Join-Path $dest 'browser_profile\Cookies'))) { throw 'Existing destination browser_profile was not preserved.' }
    $destinationCookieSentinel = (Get-Content (Join-Path $dest 'browser_profile\Cookies') -Raw).Trim()
    if ($destinationCookieSentinel -ne 'DESTINATION_KEEP') { throw 'Source browser_profile leaked into destination.' }
    if (Test-Path (Join-Path $dest 'runtime')) { throw 'runtime must not be in canonical transfer payload.' }
    if (Test-Path (Join-Path $dest 'supervisor.pid')) { throw 'supervisor.pid must not be transferred.' }
    if (Test-Path (Join-Path $dest 'supervisor.log')) { throw 'supervisor.log must not be transferred.' }

    $importedRegistry = Get-Content (Join-Path $dest 'lane-registry.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $rebasedShot = [string]$importedRegistry.lanes.'lane-1'.relay_inflight.screenshot_path
    $expectedEvidenceRoot = [IO.Path]::GetFullPath((Join-Path $dest 'lane-evidence')).TrimEnd('\') + '\'
    if (-not ([IO.Path]::GetFullPath($rebasedShot).StartsWith($expectedEvidenceRoot,[StringComparison]::OrdinalIgnoreCase))) {
        throw 'Relay screenshot path was not rebased to destination lane-evidence.'
    }
    if (-not (Test-Path $rebasedShot -PathType Leaf)) { throw 'Rebased relay screenshot is missing.' }

    # Scenario 2: an actual pre-existing Owner STOP must remain preserved.
    $sourceStop = Join-Path $tempRoot 'source-owner-stop'
    $captureStop = Join-Path $tempRoot 'capture-owner-stop.json'
    $zipStop = Join-Path $tempRoot 'owner-stop.zip'
    $destStop = Join-Path $tempRoot 'dest-owner-stop'

    New-StateFixture -Root $sourceStop -OwnerStop $true
    Invoke-Transfer @('-Mode','Capture','-SourceRoot',$sourceStop,'-CapturePath',$captureStop,'-CandidateSha',$candidate)
    Invoke-Transfer @('-Mode','Export','-SourceRoot',$sourceStop,'-CapturePath',$captureStop,'-PackageZip',$zipStop,'-CandidateSha',$candidate)
    $zipStopHash = (Get-FileHash $zipStop -Algorithm SHA256).Hash.ToLowerInvariant()

    Invoke-Transfer @('-Mode','Import','-DestinationRoot',$destStop,'-PackageZip',$zipStop,'-ExpectedPackageSha256',$zipStopHash,'-CandidateSha',$candidate)
    Invoke-Transfer @('-Mode','Verify','-DestinationRoot',$destStop,'-PackageZip',$zipStop,'-ExpectedPackageSha256',$zipStopHash,'-CandidateSha',$candidate)

    if (-not (Test-Path (Join-Path $destStop 'STOP'))) { throw 'Actual pre-existing STOP was not preserved.' }
    if (-not (Test-Path (Join-Path $destStop 'AUTOSTART_DISABLED'))) { throw 'Actual pre-existing AUTOSTART_DISABLED was not preserved.' }

    Write-Host 'MIG_005_STATE_TRANSFER_FIXTURE=PASS'
    Write-Host 'MIG_005_HASH_ROUNDTRIP=True'
    Write-Host 'MIG_005_THREE_LANE_PRESERVED=True'
    Write-Host 'MIG_005_RELAY_EVIDENCE_REBASED=True'
    Write-Host 'MIG_005_OWNER_STOP_DISTINCTION=True'
    Write-Host 'MIG_005_BROWSER_PROFILE_EXCLUDED=True'
    Write-Host 'MIG_005_DESTINATION_BROWSER_PROFILE_PRESERVED=True'
    Write-Host 'RBT009_TIER_B_480M=NOT_RUN'
}
finally {
    Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
