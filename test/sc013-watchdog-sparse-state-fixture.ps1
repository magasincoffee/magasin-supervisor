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
$sparse = '{"automation":{"status":"STOPPED"},"outbound":{"state":"NONE"}}' | ConvertFrom-Json
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
$present = '{"automation":{"status":"STOPPED"},"outbound":{"state":"BLOCKED","last_error_code":"EXACT_ONCE_FAILED","last_error_stage":"DELIVERY"}}' | ConvertFrom-Json
if ((Get-OptionalWatchdogStateField -State $present -Section 'outbound' -Field 'last_error_code') -ne 'EXACT_ONCE_FAILED') {
    throw 'PRESENT_FIELD_CHANGED'
}
if ((Get-OptionalWatchdogStateField -State $present -Section 'outbound' -Field 'last_error_stage') -ne 'DELIVERY') {
    throw 'PRESENT_STAGE_CHANGED'
}
Write-Host 'SC013_WATCHDOG_SPARSE_STATE_FIXTURE_PASS=True'
