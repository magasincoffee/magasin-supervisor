$ErrorActionPreference = 'Stop'

function Get-OptionalPropertyValue {
    param(
        [AllowNull()][object]$InputObject,
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowNull()][object]$DefaultValue = $null
    )

    if ($null -eq $InputObject) {
        return $DefaultValue
    }

    if ($InputObject -is [System.Collections.IDictionary]) {
        if ($InputObject.Contains($Name)) {
            return $InputObject[$Name]
        }
        return $DefaultValue
    }

    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $DefaultValue
    }

    return $property.Value
}

function Get-SupervisorLatchIntegrityAudit {
    param(
        [AllowNull()][object]$Registry,
        [Parameter(Mandatory = $true)][string]$EvidenceDir
    )

    $blockedRelayCount = 0
    $blockedDispatchCount = 0
    $activeEvidence = New-Object System.Collections.Generic.HashSet[string]

    $lanes = Get-OptionalPropertyValue -InputObject $Registry -Name 'lanes'
    if ($null -ne $lanes) {
        foreach ($laneId in @('lane-1','lane-2','lane-3')) {
            $lane = Get-OptionalPropertyValue -InputObject $lanes -Name $laneId
            if ($null -eq $lane) {
                continue
            }

            $relayInflight = Get-OptionalPropertyValue -InputObject $lane -Name 'relay_inflight'
            if ($null -ne $relayInflight) {
                $relayBlocked = [bool](Get-OptionalPropertyValue -InputObject $relayInflight -Name 'reconcile_blocked' -DefaultValue $false)
                if ($relayBlocked) {
                    $blockedRelayCount += 1
                }

                $screenshotPath = [string](Get-OptionalPropertyValue -InputObject $relayInflight -Name 'screenshot_path' -DefaultValue '')
                if (-not [string]::IsNullOrWhiteSpace($screenshotPath)) {
                    [void]$activeEvidence.Add([IO.Path]::GetFullPath($screenshotPath))
                }
            }

            $dispatchInflight = Get-OptionalPropertyValue -InputObject $lane -Name 'dispatch_inflight'
            if ($null -ne $dispatchInflight) {
                $dispatchBlocked = [bool](Get-OptionalPropertyValue -InputObject $dispatchInflight -Name 'reconcile_blocked' -DefaultValue $false)
                if ($dispatchBlocked) {
                    $blockedDispatchCount += 1
                }
            }
        }
    }

    $orphanEvidenceCount = 0
    if (Test-Path $EvidenceDir) {
        foreach ($file in @(Get-ChildItem $EvidenceDir -File -Filter '*.png' -ErrorAction SilentlyContinue)) {
            if (-not $activeEvidence.Contains([IO.Path]::GetFullPath($file.FullName))) {
                $orphanEvidenceCount += 1
            }
        }
    }

    return [pscustomobject]@{
        blocked_relay_count = $blockedRelayCount
        blocked_dispatch_count = $blockedDispatchCount
        orphan_evidence_count = $orphanEvidenceCount
    }
}

function Assert-SupervisorLatchIntegrity {
    param(
        [AllowNull()][object]$Registry,
        [Parameter(Mandatory = $true)][string]$EvidenceDir
    )

    $audit = Get-SupervisorLatchIntegrityAudit -Registry $Registry -EvidenceDir $EvidenceDir

    if ([int]$audit.blocked_relay_count -gt 0) {
        throw 'A relay_inflight latch remains reconcile_blocked'
    }
    if ([int]$audit.blocked_dispatch_count -gt 0) {
        throw 'A dispatch_inflight latch remains reconcile_blocked'
    }
    if ([int]$audit.orphan_evidence_count -gt 0) {
        throw 'Orphan relay evidence remains after runtime startup cleanup'
    }

    return $audit
}
