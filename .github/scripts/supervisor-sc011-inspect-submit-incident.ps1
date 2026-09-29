param([Parameter(Mandatory=$true)][string]$TargetComputer,[int]$NonTargetHoldSeconds=90)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
Write-Host "SC011_INCIDENT_MACHINE=$env:COMPUTERNAME"
if($env:COMPUTERNAME -ne $TargetComputer){
  Write-Host 'SC011_INCIDENT_TARGET_MATCH=False'
  Start-Sleep -Seconds ([Math]::Max(0,[Math]::Min(180,$NonTargetHoldSeconds)))
  exit 0
}
Write-Host 'SC011_INCIDENT_TARGET_MATCH=True'
. (Join-Path $env:GITHUB_WORKSPACE 'windows\state-root.ps1')
$root=Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
$diag=Join-Path $root 'diagnostics\submit'
Write-Host "SC011_INCIDENT_ROOT=$diag"
if(-not (Test-Path $diag -PathType Container)){
  Write-Host 'SC011_INCIDENT_DIAGNOSTICS_PRESENT=False'
  exit 0
}
Write-Host 'SC011_INCIDENT_DIAGNOSTICS_PRESENT=True'
$latest=Join-Path $diag 'latest.json'
if(Test-Path $latest -PathType Leaf){
  $obj=Get-Content $latest -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host "SC011_INCIDENT_LATEST_SUCCESS=$([bool]$obj.success)"
  Write-Host "SC011_INCIDENT_LATEST_DIR=$([string]$obj.diagnostic_dir)"
  if($obj.result){
    Write-Host "SC011_INCIDENT_RESULT_EXECUTED=$([bool]$obj.result.executed)"
    Write-Host "SC011_INCIDENT_REJECTION=$([string]$obj.result.rejection_class)"
    Write-Host "SC011_INCIDENT_INPUT_METHOD=$([string]$obj.result.input_method)"
    Write-Host "SC011_INCIDENT_SEND_METHOD=$([string]$obj.result.send_method)"
    Write-Host "SC011_INCIDENT_SEND_SELECTOR=$([string]$obj.result.send_selector)"
    Write-Host "SC011_INCIDENT_SEND_SCOPE=$([string]$obj.result.send_scope)"
    Write-Host "SC011_INCIDENT_PRIMARY_EVIDENCE=$([string]$obj.result.primary_submit_evidence)"
    Write-Host "SC011_INCIDENT_SUBMIT_EVIDENCE=$([string]$obj.result.submit_evidence)"
    Write-Host "SC011_INCIDENT_USER_TURN_EVIDENCE=$([string]$obj.result.user_turn_evidence)"
    Write-Host "SC011_INCIDENT_REASON=$([string]$obj.result.reason)"
  }
  if($obj.error){
    Write-Host "SC011_INCIDENT_ERROR_NAME=$([string]$obj.error.name)"
    Write-Host "SC011_INCIDENT_ERROR_MESSAGE=$([string]$obj.error.message)"
  }
  $dir=[string]$obj.diagnostic_dir
  if($dir -and (Test-Path $dir -PathType Container)){
    $files=Get-ChildItem $dir -Filter '*.json' -File | Sort-Object Name
    foreach($f in $files){
      if($f.Name -eq 'meta.json' -or $f.Name -eq 'summary.json'){continue}
      try{
        $s=Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        Write-Host ("SC011_INCIDENT_STAGE file={0} stage={1} url={2} focus={3} composer_present={4} composer_enabled={5} composer_len={6} composer_digest={7} user_turn_count={8} target_testid={9} target_aria={10} target_visible={11} target_disabled={12} center_testid={13} center_aria={14}" -f $f.Name,[string]$s.stage,[string]$s.url,[bool]$s.hasFocus,[bool]($null-ne $s.composer),[bool]$s.composer.enabled,[int]$s.composerTextLength,[string]$s.composerTextDigest,[int]$s.userTurnCount,[string]$s.target.testid,[string]$s.target.aria,[bool]$s.target.visible,[bool]$s.target.disabled,[string]$s.elementAtTargetCenter.testid,[string]$s.elementAtTargetCenter.aria)
      }catch{
        Write-Host "SC011_INCIDENT_STAGE_READ_ERROR=$($f.Name)"
      }
    }
  }
}
$incidents=Join-Path $diag 'incidents.ndjson'
if(Test-Path $incidents -PathType Leaf){
  $tail=Get-Content $incidents -Tail 5 -Encoding UTF8
  $i=0
  foreach($line in $tail){
    $i++
    try{
      $x=$line | ConvertFrom-Json
      Write-Host ("SC011_INCIDENT_HISTORY index={0} finished={1} success={2} rejection={3} send_method={4} submit={5} user_turn={6} reason={7} error={8}" -f $i,[string]$x.finished_at,[bool]$x.success,[string]$x.result.rejection_class,[string]$x.result.send_method,[string]$x.result.submit_evidence,[string]$x.result.user_turn_evidence,[string]$x.result.reason,[string]$x.error.message)
    }catch{}
  }
}
