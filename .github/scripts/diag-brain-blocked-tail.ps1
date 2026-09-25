param([Parameter(Mandatory=$true)][string]$TargetComputer)
$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ne $TargetComputer){Write-Host 'TARGET_MATCH=False';exit 0}
Write-Host 'TARGET_MATCH=True'
. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$log=Join-Path $root 'supervisor.log'
if(Test-Path $log){
  Get-Content $log -Tail 300 -ErrorAction SilentlyContinue | ForEach-Object {
    if($_ -match 'LANE_BRAIN_STALE_DIRECTIVE_SKIPPED|LANE_BRAIN_SEND_RECONCILE_BLOCKED|LANE_BRAIN_SEND_PENDING_CONFIRMATION|LANE_BRAIN_SEND_NOT_CONFIRMED_RETRY|LANE_BRAIN_REQUEST_SENT|LANE_BRAIN_DIRECTIVE_ADOPTED|LANE_BRAIN_DIRECTIVE_RECOVERED'){
      Write-Host $_
    }
  }
}
