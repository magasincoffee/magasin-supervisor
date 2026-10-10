param(
  [Parameter(Mandatory=$true)][ValidateSet('Stage','Apply')][string]$Mode,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$ExpectedMainSha,
  [Parameter(Mandatory=$true)][string]$Workspace,
  [string]$OwnerApproval=''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
# SC-013 source-only CLI maintenance. The pending exact-once transaction,
# physical STOP, browser, Chrome, Guardian and all project state stay untouched.
if([Environment]::MachineName -cne 'DESKTOP-H4A16IL'){throw 'WRONG_MACHINE'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
if($identity -cne 'DESKTOP-H4A16IL\admin'){throw 'OWNER_ADMIN_REQUIRED'}
if($Mode -eq 'Apply' -and $OwnerApproval -cne 'SC013_CLI_SOURCE_ONLY_APPROVED'){
  throw 'EXPLICIT_OWNER_CLI_SOURCE_APPROVAL_REQUIRED'
}
if($Mode -eq 'Stage' -and $OwnerApproval){throw 'STAGE_MUST_NOT_CARRY_APPLY'}
$repoUrl='https://github.com/magasincoffee/magasin-supervisor.git'
$work=(Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path
if(!(Test-Path (Join-Path $work '.git'))){throw 'GIT_CHECKOUT_REQUIRED'}
$origin=(& git -C $work remote get-url origin)
if($LASTEXITCODE -ne 0 -or [string]$origin -cne $repoUrl){throw 'WRONG_REPOSITORY'}
$sha=(& git -C $work rev-parse HEAD).Trim().ToLowerInvariant()
if($LASTEXITCODE -ne 0 -or $sha -cne $ExpectedMainSha.ToLowerInvariant()){
  throw 'CHECKOUT_SHA_MISMATCH'
}
$remote=(& git -C $work ls-remote origin refs/heads/main)
if($LASTEXITCODE -ne 0 -or !$remote -or
   ([string]$remote -split '\s+')[0].ToLowerInvariant() -cne $sha){
  throw 'REMOTE_MAIN_MISMATCH'
}
$sot=Join-Path $work 'SOURCE_OF_TRUTH.md'
$script=Join-Path $work '.github\scripts\sc013-h4-cli-owner-source-only.ps1'
$sourceRoot=Join-Path $work 'src'
$sourceCli=Join-Path $sourceRoot 'runtime\single-conversation-cli.mjs'
$root='C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor'
$liveRoot=Join-Path $root 'runtime\src'
$liveCli=Join-Path $liveRoot 'runtime\single-conversation-cli.mjs'
$control=Join-Path $root 'single-conversation-control.json'
$state=Join-Path $root 'single-conversation-state.json'
$stop=Join-Path $root 'STOP'
$off=Join-Path $root 'AUTOSTART_DISABLED'
$stage=Join-Path 'D:\MAGASIN_ROBOTS\deploy\sc013-cli-source-only' $sha
$manifest=Join-Path $stage 'manifest.json'
$receipt=Join-Path $stage 'installation.json'
$candidate=Join-Path $stage 'candidate\single-conversation-cli.mjs'
$backup=Join-Path $stage 'backup\single-conversation-cli.mjs'
$oldSha='755d406d225d17337c546725a5304058d6e39cba81c87d006785e3109558a2ff'
$expectedMissing=@('coordinator\sot-adapter.mjs','coordinator\sot-preflight-cli.mjs')
$expectedEol=@('runtime\external-run-local-observer.mjs','ui\actions.mjs','ui\latest-turn.mjs')
function Hash([string]$p) {
  if(!(Test-Path -LiteralPath $p -PathType Leaf)){throw "FILE_MISSING:$p"}
  return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
}
function NotReparse([string]$p){
  $it=Get-Item -LiteralPath $p -Force -ErrorAction Stop
  if(($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
    throw 'REPARSE_PATH_REJECTED'
  }
}
function Normalize([string]$p){
  $t=[IO.File]::ReadAllText($p,[Text.Encoding]::UTF8)
  $normalized=$t.Replace(([string][char]13+[string][char]10),([string][char]10))
  return $normalized.TrimEnd([char[]]@([char]13,[char]10))
}
function AssertProtected {
  if(!(Test-Path $stop -PathType Leaf) -or !(Test-Path $off -PathType Leaf)){
    throw 'OWNER_STOP_MUST_REMAIN_ACTIVE'
  }
  $st=Get-Content $state -Raw -Encoding UTF8|ConvertFrom-Json
  $ctrl=Get-Content $control -Raw -Encoding UTF8|ConvertFrom-Json
  if([string]$ctrl.mode -cne 'SINGLE_CONVERSATION_V1' -or
     [string]::IsNullOrWhiteSpace([string]$ctrl.source_of_truth_url)){
    throw 'CANONICAL_CONTROL_MISSING'
  }
  if([string]$st.automation.status -cne 'BLOCKED' -or
     [string]$st.automation.reason -cne 'AMBIGUOUS_ENQUEUED_OUTCOME' -or
     [string]$st.outbound.state -cne 'ENQUEUED' -or
     [string]$st.outbound.kind -cne 'TASK_STATUS_CHECK' -or
     [string]$st.outbound.task_id -cne 'XSTORE-019J' -or
     [string]$st.outbound.message_id -cne 'f3b69f53-d2b0-4a91-8ab7-5403807254df'){
    throw 'PENDING_EXACT_ONCE_INCIDENT_CHANGED'
  }
  $workers=@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'"|
    Where-Object{$_.ProcessId -ne $PID -and $_.CommandLine -and
      $_.CommandLine -like '*run-supervisor.ps1*' -and $_.CommandLine -like '*MAGASIN*'})
  $node=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|
    Where-Object{$_.CommandLine -and $_.CommandLine -match 'single-conversation-cli\.mjs'})
  if($workers.Count -gt 0 -or $node.Count -gt 0){throw 'SUPERVISOR_WORKER_NOT_OFF'}
  if((Get-PSDrive C).Free -lt 0.75GB -or (Get-PSDrive D).Free -lt 2GB){
    throw 'SOURCE_INSTALL_DISK_UNSAFE'
  }
}
foreach($p in @($work,$sot,$script,$sourceRoot,$sourceCli,$root,$liveRoot,$liveCli,$state,$control,$stop,$off)){
  NotReparse $p
}
if(!(Get-Content $sot -Raw -Encoding UTF8).Contains('SC-013 source-only H4 CLI recovery deployment gate')){
  throw 'CURRENT_MAIN_SOT_CLI_GATE_NOT_PRESENT'
}
if(!(Get-Content $sourceCli -Raw -Encoding UTF8).Contains('classifyEnqueuedCheckForRecoveryReview')){
  throw 'EXPECTED_REVIEW_ONLY_CLI_PATCH_MISSING'
}
if((Hash $liveCli) -cne $oldSha){throw 'LIVE_CLI_SOURCE_CHANGED'}
AssertProtected
if($Mode -eq 'Stage'){
  $sources=@(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Filter '*.mjs')
  if($sources.Count -lt 70){throw 'INCOMPLETE_SOURCE_TREE'}
  $missing=@();$format=@();$changed=@()
  foreach($f in $sources){
    $rel=$f.FullName.Substring($sourceRoot.Length+1)
    $live=Join-Path $liveRoot $rel
    if(!(Test-Path $live)){ $missing+=,$rel;continue}
    if((Hash $f.FullName) -cne (Hash $live)){
      if((Normalize $f.FullName) -ceq (Normalize $live)){$format+=,$rel}
      else{$changed+=,$rel}
    }
  }
  $missing=@($missing|Sort-Object)
  $format=@($format|Sort-Object)
  $changed=@($changed|Sort-Object)
  $expectedMissing=@($expectedMissing|Sort-Object)
  $expectedEol=@($expectedEol|Sort-Object)
  if(($missing -join '|') -cne ($expectedMissing -join '|') -or
     ($format -join '|') -cne ($expectedEol -join '|') -or
     $changed.Count -ne 1 -or $changed[0] -cne 'runtime\single-conversation-cli.mjs'){
    throw "UNREVIEWED_MODULE_DRIFT:missing=$($missing.Count),eol=$($format.Count),source=$($changed -join ',')"
  }
  if(Test-Path $stage){throw 'STAGE_ALREADY_PRESENT'}
  New-Item -ItemType Directory -Path (Join-Path $stage 'candidate') -ErrorAction Stop -Force|Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stage 'backup') -ErrorAction Stop -Force|Out-Null
  Copy-Item -LiteralPath $sourceCli -Destination $candidate -ErrorAction Stop
  Copy-Item -LiteralPath $liveCli -Destination $backup -ErrorAction Stop
  $expectedNew=Hash $sourceCli
  if((Hash $candidate) -cne $expectedNew -or (Hash $backup) -cne $oldSha){
    throw 'STAGE_COPY_HASH_MISMATCH'
  }
  & node --check $candidate
  if($LASTEXITCODE -ne 0){throw 'STAGE_CLI_NODE_SYNTAX_FAILED'}
  $record=[ordered]@{
    schema='SC013_CLI_SOURCE_ONLY_STAGE_V1'
    exact_main_sha=$sha
    status='STAGED_NOT_INSTALLED'
    host=[Environment]::MachineName
    owner_identity=$identity
    created_at=[DateTimeOffset]::UtcNow.ToString('o')
    old_cli_sha256=$oldSha
    new_cli_sha256=$expectedNew
    state_sha256=Hash $state
    control_sha256=Hash $control
    stop_sha256=Hash $stop
    disabled_sha256=Hash $off
    script_sha256=Hash $script
    module_count=$sources.Count
    excluded_coordinator_modules=$expectedMissing
    format_only_modules=$expectedEol
    source_change_only='runtime\single-conversation-cli.mjs'
    never_started_robot=$true
    never_replayed_outbound=$true
  }
  $record|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $manifest -Encoding UTF8 -ErrorAction Stop
  if((Hash $liveCli) -cne $oldSha){throw 'STAGE_MODIFIED_INSTALLED_SOURCE'}
  Write-Host 'SC013_CLI_STAGE_VERIFIED=True'
  Write-Host "STAGE_MANIFEST=$manifest"
  Write-Host 'SUPERVISOR_NOT_STARTED=True'
  exit 0
}
if(!(Test-Path $manifest -PathType Leaf) -or (Test-Path $receipt)){
  throw 'FRESH_STAGE_REQUIRED'
}
foreach($p in @($stage,$candidate,$backup,$manifest)){NotReparse $p}
$m=Get-Content $manifest -Raw -Encoding UTF8|ConvertFrom-Json
if($m.schema -cne 'SC013_CLI_SOURCE_ONLY_STAGE_V1' -or
   $m.status -cne 'STAGED_NOT_INSTALLED' -or
   $m.exact_main_sha -cne $sha -or
   $m.owner_identity -cne $identity -or
   !$m.never_started_robot -or !$m.never_replayed_outbound -or
   $m.source_change_only -cne 'runtime\single-conversation-cli.mjs'){
  throw 'STAGE_NOT_QUALIFIED'
}
if((Hash $liveCli) -cne $oldSha -or (Hash $backup) -cne $oldSha -or
   (Hash $candidate) -cne [string]$m.new_cli_sha256 -or
   (Hash $sourceCli) -cne [string]$m.new_cli_sha256 -or
   (Hash $state) -cne [string]$m.state_sha256 -or
   (Hash $control) -cne [string]$m.control_sha256 -or
   (Hash $stop) -cne [string]$m.stop_sha256 -or
   (Hash $off) -cne [string]$m.disabled_sha256 -or
   (Hash $script) -cne [string]$m.script_sha256){
  throw 'STAGE_OR_LIVE_STATE_CHANGED'
}
AssertProtected
$journal=[ordered]@{
  schema='SC013_CLI_SOURCE_ONLY_INSTALL_V1'
  exact_main_sha=$sha
  status='APPLY_STARTED'
  owner_identity=$identity
  started_at=[DateTimeOffset]::UtcNow.ToString('o')
  old_sha256=$oldSha
  new_sha256=[string]$m.new_cli_sha256
  never_started_robot=$true
  never_replayed_outbound=$true
}
$journal|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $receipt -Encoding UTF8
$tmp=Join-Path (Split-Path $liveCli -Parent) ("single-conversation-cli.mjs.sc013-$sha.tmp")
$localBackup=Join-Path (Split-Path $liveCli -Parent) ("single-conversation-cli.mjs.sc013-$sha.bak")
$replaced=$false
try {
  if((Test-Path $tmp) -or (Test-Path $localBackup)){throw 'AMBIGUOUS_TEMPORARY_INSTALL_STATE'}
  Copy-Item -LiteralPath $candidate -Destination $tmp -ErrorAction Stop
  if((Hash $tmp) -cne $m.new_cli_sha256){throw 'TEMP_CLI_HASH_MISMATCH'}
  AssertProtected
  [IO.File]::Replace($tmp,$liveCli,$localBackup,$true)
  $replaced=$true
  if((Hash $liveCli) -cne $m.new_cli_sha256 -or
     (Hash $localBackup) -cne $oldSha){throw 'INSTALLED_SOURCE_HASH_MISMATCH'}
  AssertProtected
  if((Hash $state) -cne $m.state_sha256 -or
     (Hash $control) -cne $m.control_sha256 -or
     (Hash $stop) -cne $m.stop_sha256 -or
     (Hash $off) -cne $m.disabled_sha256){
    throw 'POST_INSTALL_STATE_OR_OWNER_STOP_CHANGED'
  }
  $journal.status='CLI_SOURCE_INSTALLED_STOP_PRESERVED'
  $journal.completed_at=[DateTimeOffset]::UtcNow.ToString('o')
  $journal.installed_sha256=Hash $liveCli
  $journal|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $receipt -Encoding UTF8
  Remove-Item -LiteralPath $localBackup -Force -ErrorAction Stop
  Write-Host 'SC013_CLI_SOURCE_INSTALLED_STOP_PRESERVED=True'
  Write-Host "INSTALL_RECEIPT=$receipt"
  Write-Host 'SUPERVISOR_NOT_STARTED=True'
  Write-Host 'ENQUEUED_NOT_REPLAYED=True'
}catch{
  $err=$_.Exception.Message
  $rollback='NOT_NEEDED'
  try{
    if($replaced -and (Hash $backup) -ceq $oldSha){
      $rb=Join-Path (Split-Path $liveCli -Parent) ("single-conversation-cli.mjs.sc013-$sha.rollback.tmp")
      Copy-Item -LiteralPath $backup -Destination $rb -ErrorAction Stop
      [IO.File]::Replace($rb,$liveCli,$null,$true)
      if((Hash $liveCli) -cne $oldSha){throw 'ROLLBACK_HASH_INVALID'}
      $rollback='VERIFIED_OLD_CLI_RESTORED'
    }
  }catch{$rollback="MANUAL_RECOVERY_REQUIRED:$($_.Exception.Message)"}
  $journal.status='APPLY_FAILED'
  $journal.error_code=$err
  $journal.rollback=$rollback
  $journal|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $receipt -Encoding UTF8
  throw "SC013_CLI_APPLY_FAILED:$err;ROLLBACK=$rollback"
}finally{
  if(Test-Path $tmp){Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue}
}
