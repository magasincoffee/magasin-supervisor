param(
  [Parameter(Mandatory=$true)]
  [string]$TargetComputer,
  [int]$Attempt = 1,
  [int]$NonTargetHoldSeconds = 90
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

Write-Host "SC011_PROD_ATTEMPT=$Attempt"
Write-Host "SC011_PROD_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host "SC011_PROD_TARGET_MATCH=False"
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host "SC011_PROD_TARGET_MATCH=True"

. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$runtime=Join-Path $root 'runtime'
$control=Join-Path $root 'single-conversation-control.json'
$statePath=Join-Path $root 'single-conversation-state.json'
$start=Join-Path $runtime 'windows\start-supervisor.ps1'

if(-not (Test-Path $control)){throw 'Production single-conversation control is missing.'}
if(-not (Test-Path $start)){throw 'Installed production START script is missing.'}

$c=Get-Content $control -Raw -Encoding UTF8 | ConvertFrom-Json
if([string]$c.schema_version -ne 'single-conversation-control.v1'){throw 'Unexpected production control schema.'}
if([string]$c.mode -ne 'SINGLE_CONVERSATION_V1'){throw 'Production control is not SINGLE_CONVERSATION_V1.'}
if([string]::IsNullOrWhiteSpace([string]$c.source_of_truth_url)){throw 'Production Source of Truth URL is empty.'}

Write-Host "SC011_PROD_MODE=$([string]$c.mode)"
Write-Host "SC011_PROD_SOURCE_OF_TRUTH=$([string]$c.source_of_truth_url)"

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $start -Hidden
if($LASTEXITCODE -ne 0){throw "Explicit production START failed with exit $LASTEXITCODE."}
Write-Host 'SC011_PROD_OWNER_START_INVOKED=True'

$ready=$false
for($i=0;$i -lt 90;$i++){
  Start-Sleep -Seconds 1
  $wrapper=@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object{$_.CommandLine -and $_.CommandLine -like '*run-supervisor.ps1*' -and $_.CommandLine -like "*$root*"})
  $node=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object{$_.CommandLine -and $_.CommandLine -like '*single-conversation-cli.mjs*'})
  if($wrapper.Count -eq 1 -and $node.Count -eq 1 -and (Test-Path $statePath)){
    $s=Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if([string]$s.automation.status -eq 'RUNNING'){
      $ready=$true
      Write-Host "SC011_PROD_WRAPPER_COUNT=$($wrapper.Count)"
      Write-Host "SC011_PROD_NODE_COUNT=$($node.Count)"
      Write-Host "SC011_PROD_GENERATION=$([int]$s.conversation.generation)"
      Write-Host "SC011_PROD_CONVERSATION_STATUS=$([string]$s.conversation.status)"
      Write-Host "SC011_PROD_AUTOMATION_STATUS=$([string]$s.automation.status)"
      Write-Host "SC011_PROD_AUTOMATION_PHASE=$([string]$s.automation.phase)"
      Write-Host "SC011_PROD_OUTBOUND_STATE=$([string]$s.outbound.state)"
      break
    }
  }
}
if(-not $ready){throw 'Production robot did not reach RUNNING state within 90 seconds.'}
Write-Host 'SC011_PROD_START=PASS'
