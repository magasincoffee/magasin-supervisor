# H4 one-shot read-only inventory PRE-FLIGHT; it must never start/stop workers.
# No file-system enumeration, code install, audio reads, credentials, or process args.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$false)][string]$ExpectedSha = "",
  [Parameter(Mandatory=$false)][switch]$SelfTest
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-TargetHost([string]$Name) {
  return ($Name -ceq 'DESKTOP-H4A16IL')
}
function Test-ProbeEnvelope([object]$Envelope) {
  if ($null -eq $Envelope) { return $false }
  $names = @($Envelope.PSObject.Properties.Name | Sort-Object)
  $expected = @('mode','request_id','schema','target') | Sort-Object
  if ((Compare-Object $names $expected | Measure-Object).Count -ne 0) { return $false }
  if ($Envelope.schema -cne 'MAGASIN_SC013_H4_READONLY_PROBE_REQUEST_V1') { return $false }
  if ($Envelope.mode -cne 'READ_ONLY') { return $false }
  if ($Envelope.target -cne 'DESKTOP-H4A16IL') { return $false }
  if ($Envelope.request_id -isnot [string] -or $Envelope.request_id -cnotmatch '^H4RO-20261012-[A-Z0-9]{6}$') { return $false }
  return $true
}
if ($SelfTest) {
  $good = '{"mode":"READ_ONLY","request_id":"H4RO-20261012-V5DIAG","schema":"MAGASIN_SC013_H4_READONLY_PROBE_REQUEST_V1","target":"DESKTOP-H4A16IL"}' | ConvertFrom-Json
  if (-not (Test-TargetHost 'DESKTOP-H4A16IL')) { throw 'SELFTEST_HOST_POSITIVE_FAILED' }
  if (Test-TargetHost 'DESKTOP-4K7IM13') { throw 'SELFTEST_HOST_NEGATIVE_FAILED' }
  if (-not (Test-ProbeEnvelope $good)) { throw 'SELFTEST_ENVELOPE_POSITIVE_FAILED' }
  $good.mode = 'EXECUTE_TASK'
  if (Test-ProbeEnvelope $good) { throw 'SELFTEST_ENVELOPE_NEGATIVE_FAILED' }
  Write-Output 'SC013_H4_READONLY_PROBE_SYNTHETIC_PASS=True'
  return
}

# Strict host gate before any production filesystem read.
$machine = [Environment]::MachineName
if (-not (Test-TargetHost $machine)) {
  Write-Output 'SC013_H4_PROBE_HOLD=WRONG_MACHINE'
  throw 'WRONG_TARGET_MACHINE'
}
if ($env:GITHUB_REPOSITORY -cne 'magasincoffee/magasin-supervisor' -or
    $env:GITHUB_REF -cne 'refs/heads/main' -or
    $env:GITHUB_EVENT_NAME -notin @('push','workflow_dispatch')) {
  throw 'UNQUALIFIED_GITHUB_CONTEXT'
}
if ($ExpectedSha -cnotmatch '^[a-f0-9]{40}$' -or $env:GITHUB_SHA -cne $ExpectedSha) {
  throw 'INVALID_OR_CHANGED_MAIN_SHA'
}
$currentGit = (& git rev-parse HEAD 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $currentGit -cne $ExpectedSha) { throw 'CHECKOUT_NOT_EXACT_COMMIT' }
$path = '.github/sc013-h4-readonly-probe-request.json'
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'REQUEST_FILE_MISSING' }
$fi = Get-Item -LiteralPath $path
if ($fi.Length -gt 4096) { throw 'REQUEST_OVERSIZED' }
try {
  $request = Get-Content -LiteralPath $path -Encoding UTF8 -Raw | ConvertFrom-Json
} catch { throw 'REQUEST_NOT_VALID_JSON' }
if (-not (Test-ProbeEnvelope $request)) { throw 'REQUEST_NOT_ALLOWLISTED' }

function Probe-Exists([string]$CheckedPath) {
  try {
    if (Test-Path -LiteralPath $CheckedPath) { return 'PRESENT' }
    return 'ABSENT'
  } catch { return 'UNKNOWN' }
}
function Probe-Disk([string]$DriveLetter) {
  try {
    $disk = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $DriveLetter + ":'") -ErrorAction Stop
    if ($null -eq $disk -or $null -eq $disk.FreeSpace) { return $null }
    return [Math]::Round($disk.FreeSpace / 1GB, 2)
  } catch { return $null }
}
function Probe-FreeRam() {
  try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    return [Math]::Round($os.FreePhysicalMemory / 1MB, 2)
  } catch { return $null }
}
function Probe-ProcessCount() {
  try {
    $p = @(Get-Process -Name python,pythonw,ffmpeg -ErrorAction SilentlyContinue)
    return $p.Count
  } catch { return $null }
}

# Only known SOT-approved booleans and summarized resource data.
# Presence of STOP is NOT proof of its owner generation or permissions.
$receipt = [ordered]@{
  schema = 'MAGASIN_SC013_H4_READONLY_PROBE_V1'
  request_id = $request.request_id
  status = 'READ_ONLY_OBSERVED_UNATTESTED'
  target_hostname_verified = $true
  host = 'DESKTOP-H4A16IL'
  inspected_utc = (Get-Date).ToUniversalTime().ToString('o')
  main_sha = $ExpectedSha
  ram_free_gib = (Probe-FreeRam)
  c_free_gib = (Probe-Disk 'C')
  d_free_gib = (Probe-Disk 'D')
  heavy_process_candidates = (Probe-ProcessCount)
  supervisor_stop_latch = (Probe-Exists 'C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor\STOP')
  supervisor_autostart_disabled = (Probe-Exists 'C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor\AUTOSTART_DISABLED')
  mcp_python = (Probe-Exists 'C:\MAGASIN_MCP\.venv\Scripts\python.exe')
  mcp_gateway_code = (Probe-Exists 'C:\MAGASIN_MCP\dispatch_gateway.py')
  mcp_gateway_sqlite = (Probe-Exists 'C:\MAGASIN_MCP\state\jobs.sqlite3')
  coordinator_owner_lifecycle_file = (Probe-Exists 'D:\MAGASIN_ROBOTS\robots\coordinator\state\owner-lifecycle.json')
  saydi_c_root = (Probe-Exists 'C:\SAYDI')
  saydi_d_root = (Probe-Exists 'D:\SAYDI')
  mcp_transport_connected = 'UNVERIFIED'
  owner_lifecycle_authenticated = $false
  worker_ownership_verified = $false
  saydi_audio_sha_verified = $false
  approved_to_start = $false
  approved_to_dispatch = $false
  production_modified = $false
  worker_started = $false
  owner_stop_changed = $false
  task_completed = $false
}
Write-Output ('MAGASIN_H4_READONLY_RECEIPT_V1=' + ($receipt | ConvertTo-Json -Compress -Depth 5))
