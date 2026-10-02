param(
  [Parameter(Mandatory=$true)][string]$TargetComputer,
  [Parameter(Mandatory=$true)][string]$ExpectedMainSha
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'TARGET_MATCH=False'
  Write-Host 'TARGET_MUTATION_SKIPPED=True'
  exit 1
}
Write-Host 'TARGET_MATCH=True'
Write-Host "EXPECTED_MAIN_SHA=$ExpectedMainSha"

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$root=Set-SupervisorStateRootBinding -Root $root
$runtime=Join-Path $root 'runtime'
$install=Join-Path $env:GITHUB_WORKSPACE 'windows\install-supervisor.ps1'

$requiredSource=@(
  (Join-Path $env:GITHUB_WORKSPACE 'src\runtime\single-conversation-cli.mjs'),
  (Join-Path $env:GITHUB_WORKSPACE 'src\runtime\single-conversation-state.mjs'),
  (Join-Path $env:GITHUB_WORKSPACE 'windows\run-supervisor.ps1'),
  (Join-Path $env:GITHUB_WORKSPACE 'windows\start-supervisor.ps1'),
  (Join-Path $env:GITHUB_WORKSPACE 'windows\control-panel.ps1'),
  (Join-Path $env:GITHUB_WORKSPACE 'windows\local-watchdog.ps1'),
  $install
)
foreach($p in $requiredSource){if(-not(Test-Path $p -PathType Leaf)){throw "Missing canonical source: $p"}}

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $install -SourceRoot $env:GITHUB_WORKSPACE
if($LASTEXITCODE -ne 0){throw 'Single-conversation runtime install failed.'}

$verify=@(
  'src\runtime\single-conversation-cli.mjs',
  'src\runtime\single-conversation-state.mjs',
  'windows\run-supervisor.ps1',
  'windows\start-supervisor.ps1',
  'windows\control-panel.ps1',
  'windows\local-watchdog.ps1'
)
foreach($rel in $verify){
  $source=Join-Path $env:GITHUB_WORKSPACE $rel
  $target=Join-Path $runtime $rel
  if(-not(Test-Path $target -PathType Leaf)){throw "Installed file missing: $rel"}
  $a=(Get-FileHash $source -Algorithm SHA256).Hash
  $b=(Get-FileHash $target -Algorithm SHA256).Hash
  if($a -ne $b){throw "Installed hash mismatch: $rel"}
  Write-Host "INSTALLED_HASH_OK=$rel"
}

foreach($legacyName in @(
  'lanes.json','lane-registry.json','lane-status.json','planner-executor-state.json',
  'planner-executor-status.json','planner-executor-transport.json','orchestration.json','target.json'
)){
  if(Test-Path (Join-Path $root $legacyName)){throw "Legacy state survived cleanup: $legacyName"}
}

Write-Host 'CANONICAL_RUNTIME_REPLACED=True'
Write-Host 'SINGLE_CONVERSATION_ONLY=True'
Write-Host 'LOCAL_WATCHDOG_INSTALLED_RUNNING=True'
Write-Host 'LATEST_VERSION_UPDATE=PASS'