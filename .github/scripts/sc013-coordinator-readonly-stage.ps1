param(
  [Parameter(Mandatory=$true)]
  [ValidatePattern('^[a-fA-F0-9]{40}$')]
  [string]$ExpectedMainSha
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# SC-013 Coordinator preflight STAGE ONLY. Writes to a separate D: candidate
# directory, NEVER to the installed runtime, Gateway, STOP or Supervisor.
if ([Environment]::MachineName -ne 'DESKTOP-H4A16IL') {
  Write-Host 'TARGET_MUTATION_SKIPPED=True'
  throw 'WRONG_TARGET_MACHINE'
}
if ($env:GITHUB_EVENT_NAME -notin @('push', 'workflow_dispatch')) {
  throw 'EXPLICIT_STAGE_EVENT_REQUIRED'
}
$workspace = [string]$env:GITHUB_WORKSPACE
if ([string]::IsNullOrWhiteSpace($workspace) -or !(Test-Path (Join-Path $workspace '.git'))) {
  throw 'TRUSTED_GITHUB_CHECKOUT_REQUIRED'
}
$expected = $ExpectedMainSha.ToLowerInvariant()
$actual = (& git -C $workspace rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $actual -ne $expected) {throw 'CHECKOUT_NOT_EXACT_SHA'}
$head = & git -C $workspace ls-remote origin refs/heads/main
if ($LASTEXITCODE -ne 0 -or !$head) {throw 'LIVE_MAIN_NOT_VERIFIED'}
$main = (($head -split '\s+')[0]).ToLowerInvariant()
if ($main -ne $expected) {throw 'MAIN_MOVED_ABORT_STAGE'}

$marker = Join-Path $workspace '.github\sc013-coordinator-stage-request.json'
if ($env:GITHUB_EVENT_NAME -eq 'push') {
  if (!(Test-Path -LiteralPath $marker)) {throw 'STAGE_MARKER_MISSING'}
  $request = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($request.schema -ne 'MAGASIN_SC013_COORDINATOR_STAGE_V1' -or
      $request.mode -ne 'STAGE_READ_ONLY' -or
      $request.target -ne 'DESKTOP-H4A16IL' -or
      $request.owner_approved -ne $true -or
      $request.business_execution_enabled -ne $false) {
    throw 'STAGE_MARKER_INVALID'
  }
  # The marker commit itself is the exact SHA; a request cannot pin stale main.
  if ($request.source_commit -notmatch '^[a-f0-9]{40}$') {throw 'SOURCE_COMMIT_INVALID'}
  & git -C $workspace merge-base --is-ancestor $request.source_commit $actual
  if ($LASTEXITCODE -ne 0) {throw 'SOURCE_COMMIT_NOT_ANCESTOR'}
}

$sot = Join-Path $workspace 'SOURCE_OF_TRUTH.md'
if (!(Test-Path -LiteralPath $sot)) {throw 'CANONICAL_SOT_NOT_IN_CHECKOUT'}
$authority = Get-Content -LiteralPath $sot -Raw -Encoding UTF8
if (!$authority.Contains('### SC-013 Coordinator isolated read-only staging (Owner 2026-10-09)')) {
  throw 'SOT_STAGE_AUTHORITY_NOT_PRESENT'
}
$coordinator = 'D:\MAGASIN_ROBOTS\robots\coordinator'
$installed = Join-Path $coordinator 'coordinator.py'
if (!(Test-Path -LiteralPath $installed)) {throw 'INSTALLED_COORDINATOR_NOT_FOUND'}
$base = 'D:\MAGASIN_ROBOTS\deploy\sc013-coordinator-readonly'
if ((Get-PSDrive -Name D).Free -lt 500MB) {throw 'D_STAGING_SPACE_LOW'}
$target = Join-Path $base $actual
if (Test-Path -LiteralPath $target) {throw 'STAGE_ALREADY_EXISTS_INSPECT_FIRST'}
$files = @(
  'src/coordinator/sot-adapter.mjs',
  'src/coordinator/sot-preflight-cli.mjs',
  'src/coordinator/sot-preflight-python-bridge.py'
)
$staged = @()
New-Item -ItemType Directory -Force -Path $target | Out-Null
foreach ($relative in $files) {
  $source = Join-Path $workspace $relative
  $destination = Join-Path $target ([IO.Path]::GetFileName($relative))
  if (!(Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "APPROVED_SOURCE_MISSING:$relative"
  }
  Copy-Item -LiteralPath $source -Destination $destination
  $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
  $stagedHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($sourceHash -ne $stagedHash) {throw "STAGED_HASH_MISMATCH:$relative"}
  $staged += [ordered]@{path=$relative; sha256=$sourceHash}
}
$nodeCommand = Get-Command node -ErrorAction Stop
foreach ($file in @('sot-adapter.mjs','sot-preflight-cli.mjs')) {
  & $nodeCommand.Source --check (Join-Path $target $file)
  if ($LASTEXITCODE -ne 0) {throw "NODE_SYNTAX_CHECK_FAILED:$file"}
}
# ast.parse is compile-only: it does not import, load the Gateway or execute code.
$pythonCommand = 'C:\MAGASIN_MCP\.venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $pythonCommand)) {throw 'LOCAL_PYTHON_NOT_FOUND'}
& $pythonCommand -c "import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))" (Join-Path $target 'sot-preflight-python-bridge.py')
if ($LASTEXITCODE -ne 0) {throw 'PYTHON_SYNTAX_CHECK_FAILED'}

$stopRoot='C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor'
$stopSeen = (Test-Path -LiteralPath (Join-Path $stopRoot 'STOP')) -or
            (Test-Path -LiteralPath (Join-Path $stopRoot 'AUTOSTART_DISABLED'))
$manifest = [ordered]@{
  schema='MAGASIN_SC013_COORDINATOR_STAGE_RESULT_V1'
  mode='STAGED_READ_ONLY_NOT_INSTALLED'
  target='DESKTOP-H4A16IL'
  exact_main_sha=$actual
  checked_at=(Get-Date).ToUniversalTime().ToString('o')
  source_files=$staged
  owner_stop_latch_seen=[bool]$stopSeen
  installation_performed=$false
  coordinator_python_modified=$false
  supervisor_started_or_stopped=$false
  github_gateway_modified=$false
  chatgpt_outbound=$false
  business_execution_qualified=$false
}
$manifestFile = Join-Path $target 'manifest.json'
$tmp = Join-Path $target 'manifest.tmp'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $tmp -Encoding UTF8
Move-Item -LiteralPath $tmp -Destination $manifestFile
Write-Host 'COORDINATOR_STAGE_PASS=True'
Write-Host 'STAGE_NO_RUNTIME_MUTATION=True'
Write-Host 'STAGE_NO_CHATGPT_OUTBOUND=True'
Write-Host 'COORDINATOR_BUSINESS_EXECUTION_QUALIFIED=False'
Write-Host ('STAGE_COMMIT=' + $actual)
Write-Host ('STAGE_MANIFEST=' + $manifestFile)
