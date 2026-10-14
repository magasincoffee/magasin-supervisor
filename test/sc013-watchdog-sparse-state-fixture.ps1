$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$watchdog = Join-Path $PSScriptRoot '..\windows\local-watchdog.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $watchdog, [ref]$tokens, [ref]$errors
)
if (@($errors).Count -ne 0) { throw 'WATCHDOG_POWERSHELL_PARSE_FAILED' }
$match = @($ast.FindAll({
    param($item)
    $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $item.Name -eq 'Get-OptionalWatchdogStateField'
}, $true))
if ($match.Count -ne 1) { throw 'WATCHDOG_OPTIONAL_READER_MISSING' }

# Evaluate ONLY the pure helper function AST. Never run the watchdog loop
# or touch production H4, SQLite, services, lifecycle or queue state.
. ([scriptblock]::Create($match[0].Extent.Text))
$sparse = '{"automation":{"status":"STOPPED","phase":"IDLE"},"outbound":{"state":"NONE"}}' | ConvertFrom-Json
foreach ($field in @('last_error_code','last_error_stage','prepared_at','enqueued_at')) {
    if ($null -ne (Get-OptionalWatchdogStateField -State $sparse -Section 'outbound' -Field $field)) {
        throw 'SPARSE_OUTBOUND_FIELD_NOT_NULL'
    }
}
if ($null -ne (Get-OptionalWatchdogStateField -State $sparse -Section 'automation' -Field 'updated_at')) {
    throw 'SPARSE_AUTOMATION_FIELD_NOT_NULL'
}
if ($null -ne (Get-OptionalWatchdogStateField -State $sparse -Section 'missing' -Field 'value')) {
    throw 'MISSING_SECTION_NOT_NULL'
}
if ($null -ne (Get-OptionalWatchdogStateField -State $null -Section 'outbound' -Field 'last_error_code')) {
    throw 'NULL_STATE_NOT_NULL'
}
$present = '{"automation":{"status":"STOPPED","phase":"IDLE"},"outbound":{"state":"BLOCKED","last_error_code":"EXACT_ONCE_FAILED","last_error_stage":"DELIVERY"}}' | ConvertFrom-Json
if ((Get-OptionalWatchdogStateField -State $present -Section 'outbound' -Field 'last_error_code') -ne 'EXACT_ONCE_FAILED') {
    throw 'PRESENT_FIELD_CHANGED'
}
if ((Get-OptionalWatchdogStateField -State $present -Section 'outbound' -Field 'last_error_stage') -ne 'DELIVERY') {
    throw 'PRESENT_STAGE_CHANGED'
}
# Extract and exercise only the three timestamp guard AST branches, never
# the daemon loop, process probes, local file I/O or GitHub dispatch.
function Assert-IsolatedTimestampFault([string]$ConditionText, [string]$Json, [string]$FaultCode) {
    $branch = @($ast.FindAll({
        param($node)
        if ($node -isnot [System.Management.Automation.Language.IfStatementAst]) { return $false }
        $condition = [string]$node.Clauses[0].Item1.Extent.Text
        return $condition.Contains($ConditionText)
    }.GetNewClosure(), $true))
    if ($branch.Count -ne 1) { throw ('TIMESTAMP_BRANCH_NOT_UNIQUE_' + $ConditionText) }
    $state = $Json | ConvertFrom-Json
    $automation = [string]$state.automation.status
    $phase = [string]$state.automation.phase
    $outbound = [string]$state.outbound.state
    $faults = New-Object 'System.Collections.Generic.List[string]'
    $now = [DateTimeOffset]::UtcNow
    $lastCode = ''
    $MaxStartingBrowserSeconds = 180
    $MaxPreparedSeconds = 180
    $MaxEnqueuedSeconds = 180
    . ([scriptblock]::Create($branch[0].Extent.Text))
    if (-not ($faults -contains $FaultCode)) { throw ('MISSING_EXPECTED_FAULT_' + $FaultCode) }
}
$startupCondition = '$automation -eq ''RUNNING'' -and $phase -eq ''STARTING_BROWSER'''
$preparedCondition = '$outbound -eq ''PREPARED'''
$enqueuedCondition = '$outbound -eq ''ENQUEUED'''
Assert-IsolatedTimestampFault $startupCondition '{"automation":{"status":"RUNNING","phase":"STARTING_BROWSER"},"outbound":{"state":"NONE"}}' 'STARTING_BROWSER_TIMESTAMP_MISSING'
Assert-IsolatedTimestampFault $preparedCondition '{"automation":{"status":"STOPPED","phase":"IDLE"},"outbound":{"state":"PREPARED"}}' 'PREPARED_TIMESTAMP_MISSING'
Assert-IsolatedTimestampFault $enqueuedCondition '{"automation":{"status":"STOPPED","phase":"IDLE"},"outbound":{"state":"ENQUEUED"}}' 'ENQUEUED_TIMESTAMP_MISSING'
Assert-IsolatedTimestampFault $startupCondition '{"automation":{"status":"RUNNING","phase":"STARTING_BROWSER","updated_at":"INVALID_TIMESTAMP"},"outbound":{"state":"NONE"}}' 'STARTING_BROWSER_TIMESTAMP_INVALID'
Assert-IsolatedTimestampFault $preparedCondition '{"automation":{"status":"STOPPED","phase":"IDLE"},"outbound":{"state":"PREPARED","prepared_at":"INVALID_TIMESTAMP"}}' 'PREPARED_TIMESTAMP_INVALID'
Assert-IsolatedTimestampFault $enqueuedCondition '{"automation":{"status":"STOPPED","phase":"IDLE"},"outbound":{"state":"ENQUEUED","enqueued_at":"INVALID_TIMESTAMP"}}' 'ENQUEUED_TIMESTAMP_INVALID'

Write-Host 'SC013_WATCHDOG_SPARSE_STATE_FIXTURE_PASS=True'
