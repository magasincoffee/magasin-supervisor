param(
  [Parameter(Mandatory=$true)]
  [string]$TargetComputer,
  [Parameter(Mandatory=$true)]
  [string]$ExpectedMainSha
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Host 'TARGET_MATCH=False'
  Write-Host 'TARGET_MUTATION_SKIPPED=True'
  exit 1
}
Write-Host 'TARGET_MATCH=True'
Write-Host "EXPECTED_MAIN_SHA=$ExpectedMainSha"
if (-not [string]::IsNullOrWhiteSpace([string]$env:GITHUB_SHA)) {
  if ([string]$env:GITHUB_SHA -ne $ExpectedMainSha) {
    throw "Checked-out SHA does not match explicit deploy authority."
  }
}

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$root = Set-SupervisorStateRootBinding -Root $root
$runtime = Join-Path $root 'runtime'
$stateFile = Join-Path $root 'single-conversation-state.json'
$controlFile = Join-Path $root 'single-conversation-control.json'
$installScript = Join-Path $env:GITHUB_WORKSPACE 'windows\install-supervisor.ps1'

if (-not (Test-Path $installScript -PathType Leaf)) {
  throw "Canonical installer is missing: $installScript"
}
if (-not (Test-Path $controlFile -PathType Leaf)) {
  throw "SINGLE_CONVERSATION_V1 control record is missing; refusing production deploy."
}

$control = Get-Content $controlFile -Raw -Encoding UTF8 | ConvertFrom-Json
if (
  [string]$control.schema_version -ne 'single-conversation-control.v1' -or
  [string]$control.mode -ne 'SINGLE_CONVERSATION_V1' -or
  [string]::IsNullOrWhiteSpace([string]$control.source_of_truth_url)
) {
  throw 'Production deploy refused: canonical SINGLE_CONVERSATION_V1 control record is invalid.'
}
Write-Host 'DEPLOY_RUNTIME_MODE=SINGLE_CONVERSATION_V1'

$stateHashBefore = $null
if (Test-Path $stateFile -PathType Leaf) {
  $stateHashBefore = (Get-FileHash $stateFile -Algorithm SHA256).Hash
  Write-Host "STATE_HASH_BEFORE=$stateHashBefore"
}

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installScript -SourceRoot $env:GITHUB_WORKSPACE
if ($LASTEXITCODE -ne 0) {
  throw "Canonical runtime install failed with exit code $LASTEXITCODE."
}
Write-Host 'CANONICAL_RUNTIME_REPLACED=True'

$sourceCli = Join-Path $env:GITHUB_WORKSPACE 'src\runtime\single-conversation-cli.mjs'
$installedCli = Join-Path $runtime 'src\runtime\single-conversation-cli.mjs'
foreach ($p in @($sourceCli,$installedCli)) {
  if (-not (Test-Path $p -PathType Leaf)) { throw "Required runtime file is missing: $p" }
}
$sourceHash = (Get-FileHash $sourceCli -Algorithm SHA256).Hash
$installedHash = (Get-FileHash $installedCli -Algorithm SHA256).Hash
if ($sourceHash -ne $installedHash) {
  throw 'Installed SINGLE_CONVERSATION_V1 runtime does not match exact deployed source.'
}
Write-Host "SINGLE_CONVERSATION_CLI_SHA256=$installedHash"

if ($null -ne $stateHashBefore) {
  if (-not (Test-Path $stateFile -PathType Leaf)) {
    throw 'Durable single-conversation state disappeared during deploy.'
  }
  $stateHashAfter = (Get-FileHash $stateFile -Algorithm SHA256).Hash
  if ($stateHashAfter -ne $stateHashBefore) {
    throw 'Durable single-conversation state changed during code deployment.'
  }
  Write-Host 'DURABLE_STATE_PRESERVED=True'
} else {
  Write-Host 'DURABLE_STATE_PRESERVED=NO_PRIOR_STATE'
}

Write-Host 'LOCAL_WATCHDOG_INSTALLED_RUNNING=True'
Write-Host 'LATEST_VERSION_UPDATE=PASS'
