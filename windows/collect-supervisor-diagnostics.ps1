$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$diagnosticsRoot = Join-Path $root 'diagnostics'
$submitDiagnostics = Join-Path $diagnosticsRoot 'submit'
$latest = Join-Path $diagnosticsRoot 'latest.json'
$incidents = Join-Path $diagnosticsRoot 'incidents.ndjson'
$status = Join-Path $root 'runtime-status.json'
$log = Join-Path $root 'supervisor.log'

Write-Host '=== MAGASIN SUPERVISOR DIAGNOSTICS ==='

if (Test-Path $latest) {
    Write-Host '--- latest.json ---'
    Get-Content $latest -Raw -Encoding UTF8 | Write-Host
} else {
    Write-Host 'latest.json: missing'
}

if (Test-Path $incidents) {
    Write-Host '--- recent incidents ---'
    Get-Content $incidents -Tail 10 -Encoding UTF8 | ForEach-Object { Write-Host $_ }
} else {
    Write-Host 'incidents.ndjson: missing'
}

$submitLatest = Join-Path $submitDiagnostics 'latest.json'
$submitIncidents = Join-Path $submitDiagnostics 'incidents.ndjson'
if (Test-Path $submitLatest) {
    Write-Host '--- latest submit flight recorder incident ---'
    Get-Content $submitLatest -Raw -Encoding UTF8 | Write-Host
}
if (Test-Path $submitIncidents) {
    Write-Host '--- recent submit flight recorder incidents ---'
    Get-Content $submitIncidents -Tail 5 -Encoding UTF8 | ForEach-Object { Write-Host $_ }
}

if (Test-Path $status) {
    Write-Host '--- runtime-status.json ---'
    Get-Content $status -Raw -Encoding UTF8 | Write-Host
} else {
    Write-Host 'runtime-status.json: missing'
}

if (Test-Path $log) {
    Write-Host '--- supervisor.log tail ---'
    Get-Content $log -Tail 40 -Encoding UTF8 | ForEach-Object { Write-Host $_ }
} else {
    Write-Host 'supervisor.log: missing'
}

Write-Host "DIAGNOSTICS_PATH=$diagnosticsRoot"
