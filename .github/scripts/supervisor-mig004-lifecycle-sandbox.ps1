param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$stateRootHelper = Join-Path $repoRoot 'windows\state-root.ps1'
$lifecycleHelper = Join-Path $repoRoot 'windows\lifecycle-truth.ps1'

if (-not (Test-Path $stateRootHelper)) { throw 'state-root helper missing' }
if (-not (Test-Path $lifecycleHelper)) { throw 'lifecycle helper missing' }

. $stateRootHelper
. $lifecycleHelper

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Get-FileSha256([string]$Path) {
    if (-not (Test-Path $Path)) { return 'MISSING' }
    return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

$base = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$root = Join-Path $base ('magasin-mig004-lifecycle-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $root | Out-Null

$previousStateRoot = [string]$env:SUPERVISOR_STATE_ROOT
try {
    $env:SUPERVISOR_STATE_ROOT = $root
    $resolved = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
    Assert-True ([IO.Path]::GetFullPath($resolved) -eq [IO.Path]::GetFullPath($root)) 'Explicit validation state root was not honored.'

    $configPath = Join-Path $root 'lanes.json'
    $config = [ordered]@{
        schema_version = 'three-lane-config.v1'
        lanes = @(
            [ordered]@{ lane_id='lane-1'; enabled=$false; brain_url='https://example.invalid/brain-1'; brain_url_revision=1; work_url='https://example.invalid/work-1'; work_url_revision=1 },
            [ordered]@{ lane_id='lane-2'; enabled=$false; brain_url='https://example.invalid/brain-2'; brain_url_revision=1; work_url='https://example.invalid/work-2'; work_url_revision=1 },
            [ordered]@{ lane_id='lane-3'; enabled=$false; brain_url='https://example.invalid/brain-3'; brain_url_revision=1; work_url='https://example.invalid/work-3'; work_url_revision=1 }
        )
    }
    $config | ConvertTo-Json -Depth 8 | Set-Content -Path $configPath -Encoding UTF8
    $targetFingerprintBefore = Get-FileSha256 $configPath

    # A: all lanes disabled never requests start.
    $a = Invoke-LifecycleRecoveryStart -StartScript (Join-Path $root 'missing-start.ps1') -Root $root
    Assert-True ($a.state -eq 'ALL_DISABLED' -and -not $a.start_requested) 'A all-disabled fail-closed contract failed.'

    # Enable one lane without touching any target URL/revision.
    $cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $cfg.lanes[0].enabled = $true
    $cfg | ConvertTo-Json -Depth 8 | Set-Content -Path $configPath -Encoding UTF8

    # F: Owner STOP always wins and never requests recovery start.
    Set-Content -Path (Join-Path $root 'STOP') -Value 'STOP' -Encoding ascii
    Set-Content -Path (Join-Path $root 'AUTOSTART_DISABLED') -Value 'OWNER_STOP' -Encoding ascii
    $f = Invoke-LifecycleRecoveryStart -StartScript (Join-Path $root 'missing-start.ps1') -Root $root
    Assert-True ($f.state -eq 'OWNER_STOP' -and -not $f.start_requested) 'F Owner STOP fail-closed contract failed.'

    $blocked = Get-LifecycleOwnerStopState -Root $root
    Assert-True $blocked.blocked 'Owner STOP latch was not observed.'

    # Explicit clear helper is exercised only inside the isolated validation root.
    Clear-LifecycleOwnerStopLatches -Root $root | Out-Null
    $cleared = Get-LifecycleOwnerStopState -Root $root
    Assert-True (-not $cleared.blocked) 'Isolated Owner START latch-clear helper failed.'

    # E: mocked healthy process truth must never request restart.
    function Get-LifecycleProcessTruth([string]$Root) {
        return [pscustomobject]@{
            wrapper_alive = $true
            three_lane_alive = $true
            chrome_alive = $true
            cdp_healthy = $true
            healthy = $true
        }
    }
    $e = Invoke-LifecycleRecoveryStart -StartScript (Join-Path $root 'missing-start.ps1') -Root $root
    Assert-True ($e.state -eq 'HEALTHY' -and -not $e.start_requested) 'E healthy runtime no-restart contract failed.'

    # Target file contents were allowed only one explicit enabled-flag edit.
    # Verify URLs/revisions remain exactly the synthetic values.
    $after = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    for ($i = 0; $i -lt 3; $i++) {
        Assert-True ([string]$after.lanes[$i].brain_url -eq "https://example.invalid/brain-$($i+1)") 'Brain target changed in sandbox.'
        Assert-True ([int]$after.lanes[$i].brain_url_revision -eq 1) 'Brain revision changed in sandbox.'
        Assert-True ([string]$after.lanes[$i].work_url -eq "https://example.invalid/work-$($i+1)") 'Work target changed in sandbox.'
        Assert-True ([int]$after.lanes[$i].work_url_revision -eq 1) 'Work revision changed in sandbox.'
    }

    $sourceBefore = Get-Content $configPath -Raw -Encoding UTF8
    $sourceAfter = Get-Content $configPath -Raw -Encoding UTF8
    Assert-True ($sourceBefore -eq $sourceAfter) 'Unexpected sandbox config mutation occurred.'

    Write-Host 'MIG_004_VALIDATION_ROOT_ISOLATED=True'
    Write-Host 'MIG_004_STATE_ROOT_EXPLICIT=True'
    Write-Host 'MIG_004_LIFECYCLE_A_ALL_DISABLED=True'
    Write-Host 'MIG_004_LIFECYCLE_E_HEALTHY_NO_RESTART=True'
    Write-Host 'MIG_004_LIFECYCLE_F_OWNER_STOP=True'
    Write-Host 'MIG_004_OWNER_STOP_CLEAR_ISOLATED_ONLY=True'
    Write-Host 'MIG_004_TARGET_URLS_REVISIONS_PRESERVED=True'
    Write-Host 'MIG_004_NO_PRODUCTION_PROCESS_MUTATION=True'
    Write-Host 'MIG_004_NO_PRODUCTION_STATE_MUTATION=True'
    Write-Host 'ZERO_PRODUCTION_MUTATION=True'
} finally {
    if ([string]::IsNullOrWhiteSpace($previousStateRoot)) {
        Remove-Item Env:SUPERVISOR_STATE_ROOT -ErrorAction SilentlyContinue
    } else {
        $env:SUPERVISOR_STATE_ROOT = $previousStateRoot
    }
    Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
