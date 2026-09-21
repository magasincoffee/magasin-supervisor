param(
    [Parameter(Mandatory = $true)][string]$WorkflowPath,
    [Parameter(Mandatory = $true)][string]$HelperPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Match {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if ($Text -notmatch $Pattern) {
        throw $Message
    }
}

if (-not (Test-Path $WorkflowPath)) { throw 'State maintenance workflow is missing' }
if (-not (Test-Path $HelperPath)) { throw 'Canonical optional-property helper is missing' }

. $HelperPath
$workflow = Get-Content $WorkflowPath -Raw -Encoding UTF8

# Trigger/caller model: manual Owner action only; no release/source push path.
Assert-Match $workflow '(?m)^\s{2}workflow_dispatch:' 'workflow_dispatch must remain the only maintenance entry point'
Assert-True (-not ($workflow -match '(?m)^\s{2}push:')) 'push trigger must not exist on state maintenance'
Assert-True (-not $workflow.Contains('HEAD_MESSAGE')) 'push commit-message routing must be deleted'
Assert-True (-not $workflow.Contains('supervisor-reset-work-state')) 'legacy reset commit marker must be deleted'
Assert-True (-not $workflow.Contains('supervisor-owner-start')) 'legacy owner-start commit marker must be deleted'
Assert-Match $workflow 'Checkout canonical Supervisor source' 'manual maintenance must checkout canonical source'

# Runtime version is derived from source and checked before every production mutation.
Assert-Match $workflow '\$expectedVersion = Get-SupervisorRuntimeVersion -Path \$sourceRuntime' 'expected version must come from checked-out runtime source'
Assert-Match $workflow '\$installedVersion = Get-SupervisorRuntimeVersion -Path \$installedRuntimeSource' 'installed version must come from installed runtime source'
Assert-True (-not $workflow.Contains('2026-09-19.51')) 'state maintenance must not hard-code the current runtime version'

$versionGuard = $workflow.IndexOf('if ($installedVersion -ne $expectedVersion)')
$ownerStartBranch = $workflow.IndexOf('if ($operation -eq "owner-start")')
$ownerStartMutation = $workflow.IndexOf('& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startScript -Hidden')
$resetMutation = $workflow.IndexOf('& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $stopScript')
$configMutation = $workflow.IndexOf('$lane.work_state_reset_revision = $newResetRevision')
Assert-True ($versionGuard -ge 0) 'version mismatch guard is missing'
Assert-True ($ownerStartBranch -gt $versionGuard) 'version guard must precede owner-start branch'
Assert-True ($ownerStartMutation -gt $versionGuard) 'version guard must precede owner-start mutation'
Assert-True ($resetMutation -gt $versionGuard) 'version guard must precede reset stop mutation'
Assert-True ($configMutation -gt $versionGuard) 'version guard must precede revision mutation'

# Audit branch is read-only.
$auditStart = $workflow.IndexOf('if ($operation -eq "audit")')
$resetStart = $workflow.IndexOf('if (-not (Test-Path $stopScript))')
Assert-True ($auditStart -ge 0 -and $resetStart -gt $auditStart) 'audit branch boundaries are invalid'
$auditBlock = $workflow.Substring($auditStart, $resetStart - $auditStart)
foreach ($forbiddenMutation in @(
    '& powershell.exe',
    'Move-Item',
    'WriteAllText',
    'Stop-Process',
    '.work_url_revision =',
    'Remove-Item'
)) {
    Assert-True (-not $auditBlock.Contains($forbiddenMutation)) "audit branch must remain read-only: $forbiddenMutation"
}

# Workflow must reuse canonical optional access and avoid StrictMode-unsafe latch reads.
Assert-Match $workflow 'supervisor-integrity-registry\.ps1' 'canonical integrity helper must be reused'
Assert-Match $workflow 'Get-OptionalPropertyValue -InputObject \$relayInflight -Name "reconcile_blocked" -DefaultValue \$false' 'relay optional latch access must be safe'
Assert-Match $workflow 'Get-OptionalPropertyValue -InputObject \$dispatchInflight -Name "reconcile_blocked" -DefaultValue \$false' 'dispatch optional latch access must be safe'
Assert-Match $workflow 'Get-OptionalPropertyValue -InputObject \$registryLane -Name "applied_work_state_reset_revision" -DefaultValue 0' 'applied reset revision must be safe for legacy registry state'
Assert-True (-not ($workflow -match 'relay_inflight\.reconcile_blocked')) 'direct relay reconcile_blocked dereference must not exist'
Assert-True (-not ($workflow -match 'dispatch_inflight\.reconcile_blocked')) 'direct dispatch reconcile_blocked dereference must not exist'

# Dynamic StrictMode optional-latch regression for all lanes.
foreach ($laneId in @('lane-1','lane-2','lane-3')) {
    foreach ($case in @(
        [pscustomobject]@{ name='null'; relay=$null; dispatch=$null; expect=$false },
        [pscustomobject]@{
            name='missing'
            relay=[pscustomobject]@{ relay_id="relay-$laneId" }
            dispatch=[pscustomobject]@{ dispatch_id="dispatch-$laneId" }
            expect=$false
        },
        [pscustomobject]@{
            name='false'
            relay=[pscustomobject]@{ reconcile_blocked=$false }
            dispatch=[pscustomobject]@{ reconcile_blocked=$false }
            expect=$false
        }
    )) {
        $relayBlocked = [bool](Get-OptionalPropertyValue -InputObject $case.relay -Name 'reconcile_blocked' -DefaultValue $false)
        $dispatchBlocked = [bool](Get-OptionalPropertyValue -InputObject $case.dispatch -Name 'reconcile_blocked' -DefaultValue $false)
        Assert-True ($relayBlocked -eq $case.expect) "$laneId $($case.name) relay optional state is wrong"
        Assert-True ($dispatchBlocked -eq $case.expect) "$laneId $($case.name) dispatch optional state is wrong"
    }

    $trueRelay = [pscustomobject]@{ reconcile_blocked=$true }
    $trueDispatch = [pscustomobject]@{ reconcile_blocked=$true }
    Assert-True ([bool](Get-OptionalPropertyValue -InputObject $trueRelay -Name 'reconcile_blocked' -DefaultValue $false)) "$laneId true relay must fail closed"
    Assert-True ([bool](Get-OptionalPropertyValue -InputObject $trueDispatch -Name 'reconcile_blocked' -DefaultValue $false)) "$laneId true dispatch must fail closed"
}

# Explicit Owner START remains the only STOP-clearing maintenance action and preserves targets.
Assert-Match $workflow 'OWNER_START_EXPLICIT=True' 'explicit Owner START marker is missing'
Assert-Match $workflow '\$targetBefore = Get-TargetFingerprint \$configFile' 'Owner START target pre-fingerprint is missing'
Assert-Match $workflow '\$targetAfter = Get-TargetFingerprint \$configFile' 'Owner START target post-fingerprint is missing'
Assert-Match $workflow 'TARGET_URLS_UNCHANGED=True' 'target preservation marker is missing'
Assert-True (-not ($workflow -match '-File \$startScript -Hidden -Recovery')) 'Owner START must not use Recovery mode'

# Reset remains lane-scoped and preserves Brain/Work target URLs.
Assert-Match $workflow 'Where-Object \{ \[string\]\$_.lane_id -eq \$laneId \}' 'reset must select exactly the requested lane'
Assert-Match $workflow '\$lane\.work_state_reset_revision = \$newResetRevision' 'reset must only advance selected Work state reset revision'
Assert-Match $workflow 'applied_work_state_reset_revision' 'reset must wait for dedicated runtime reset acknowledgement'
Assert-True (-not ($workflow -match '\$lane\.work_url_revision\s*=\s*\$newRevision')) 'maintenance reset must not overload Work target revision'
Assert-True (-not ($workflow -match '(?m)\.brain_url\s*=')) 'reset must never assign Brain URL'
Assert-True (-not ($workflow -match '(?m)\.work_url\s*=')) 'reset must never assign Work URL'
Assert-Match $workflow 'Brain URL changed during state reset' 'Brain target preservation assertion is missing'
Assert-Match $workflow 'Work URL changed during state reset' 'Work target preservation assertion is missing'

# Output is metadata-only: no raw target/content/credential fields are printed.
$writeHostLines = @($workflow -split "\r?\n" | Where-Object { $_ -match 'Write-Host' }) -join "\n"
Assert-True (-not ($writeHostLines -match '(?i)brain_url|work_url|token|cookie|message_body|instruction|https?://')) 'maintenance output must not expose private values'

Write-Host 'STATE_MAINTENANCE_TRIGGER_MODEL=MANUAL_ONLY'
Write-Host 'STATE_MAINTENANCE_VERSION_PREFLIGHT=PASS'
Write-Host 'STATE_MAINTENANCE_AUDIT_READ_ONLY=PASS'
Write-Host 'STATE_MAINTENANCE_OPTIONAL_LATCHES=PASS'
Write-Host 'STATE_MAINTENANCE_TRUE_BLOCKED_FAIL_CLOSED=PASS'
Write-Host 'STATE_MAINTENANCE_TARGET_PRESERVATION=PASS'
Write-Host 'STATE_MAINTENANCE_PRIVACY=PASS'
