param(
  [Parameter(Mandatory=$true)][ValidateSet('Stage','Detach')][string]$Mode,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$ExpectedMainSha,
  [Parameter(Mandatory=$true)][string]$Workspace,
  [string]$OwnerConfirm=''
)
$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
# Project retirement is NOT evidence of message delivery and NOT project deletion.
if([Environment]::MachineName -cne 'DESKTOP-H4A16IL'){throw 'WRONG_MACHINE'}
$id=[Security.Principal.WindowsIdentity]::GetCurrent().Name
if($id -cne 'DESKTOP-H4A16IL\admin'){throw 'OWNER_ADMIN_REQUIRED'}
if($Mode -eq 'Detach' -and $OwnerConfirm -cne 'RETIRE_XSTORE_019J_FROM_SUPERVISOR_ONLY'){
 throw 'EXPLICIT_OWNER_RETIRE_CONFIRMATION_REQUIRED'
}
if($Mode -eq 'Stage' -and $OwnerConfirm){throw 'NO_STAGE_CONFIRMATION_ARGUMENT'}
$repo='https://github.com/magasincoffee/magasin-supervisor.git'
$work=(Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path
if(!(Test-Path (Join-Path $work '.git'))){throw 'REPOSITORY_CHECKOUT_MISSING'}
$origin=(& git -C $work remote get-url origin)
if($LASTEXITCODE -ne 0 -or $origin -cne $repo){throw 'REPOSITORY_ORIGIN_INVALID'}
$sha=(& git -C $work rev-parse HEAD).Trim().ToLowerInvariant()
if($LASTEXITCODE -ne 0 -or $sha -cne $ExpectedMainSha.ToLowerInvariant()){throw 'EXACT_MAIN_MISMATCH'}
$upstream=(& git -C $work ls-remote origin refs/heads/main)
if($LASTEXITCODE -ne 0 -or !$upstream -or
   ([string]$upstream -split '\s+')[0].ToLowerInvariant() -cne $sha){throw 'MAIN_MOVED'}
$sot=Join-Path $work 'SOURCE_OF_TRUTH.md'
$script=Join-Path $work '.github\scripts\sc013-h4-retire-project-binding.ps1'
if(!(Get-Content -LiteralPath $sot -Raw -Encoding UTF8).Contains(
  'SC-013 explicit Owner retirement of XSTORE-019J Supervisor binding')){
 throw 'CANONICAL_SOT_RETIRE_GATE_MISSING'
}
$root='C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor'
$control=Join-Path $root 'single-conversation-control.json'
$state=Join-Path $root 'single-conversation-state.json'
$stop=Join-Path $root 'STOP'
$disabled=Join-Path $root 'AUTOSTART_DISABLED'
$marker=Join-Path $root 'project-unlinked-status.json'
$stage=Join-Path 'D:\MAGASIN_ROBOTS\deploy\sc013-project-retirement' $sha
$backupDir=Join-Path $stage 'cold-original'
$candidateDir=Join-Path $stage 'candidate-unlinked'
$oldCtl=Join-Path $backupDir 'single-conversation-control.json'
$oldState=Join-Path $backupDir 'single-conversation-state.json'
$newCtl=Join-Path $candidateDir 'single-conversation-control.json'
$newState=Join-Path $candidateDir 'single-conversation-state.json'
$manifest=Join-Path $stage 'manifest.json'
$receipt=Join-Path $stage 'retire-result.json'
$oldCtlHash='d9d035adbb86f070a0a88be05b79286557374108faf8b21d62a34c67e82a5b17'
$oldStateHash='3f4f97f4e22113fd937a1194fd8369aac9687c6e15b1ce564cc6ff73b0c89a87'
$oldSot='https://github.com/magasincoffee/magasincoffee.github.io/blob/main/01_DOCS/MAGASIN/05_SYSTEM/WORKFORCE_CROSS_STORE_SCHEDULING_TEMP_SOURCE_OF_TRUTH.md'
$oldMessage='f3b69f53-d2b0-4a91-8ab7-5403807254df'
function Hash([string]$p){
 if(!(Test-Path -LiteralPath $p -PathType Leaf)){throw "MISSING:$p"}
 return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
}
function NotReparse([string]$p){
 $i=Get-Item -LiteralPath $p -Force -ErrorAction Stop
 if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'REPARSE_PATH'}
}
function SafeStopped {
 if(!(Test-Path $stop -PathType Leaf) -or !(Test-Path $disabled -PathType Leaf)){
   throw 'OWNER_STOP_LATCH_MISSING'
 }
 $w=@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'"|
   Where-Object{$_.ProcessId -ne $PID -and $_.CommandLine -and
   $_.CommandLine -like '*run-supervisor.ps1*' -and $_.CommandLine -like '*MAGASIN*'})
 $n=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|
   Where-Object{$_.CommandLine -and $_.CommandLine -match 'single-conversation-cli\.mjs'})
 if($w.Count -ne 0 -or $n.Count -ne 0){throw 'SUPERVISOR_MUST_BE_STOPPED'}
 if((Get-PSDrive D).Free -lt 2GB){throw 'D_SPACE_UNSAFE'}
}
function ExactOldBinding {
 if((Hash $control) -cne $oldCtlHash -or (Hash $state) -cne $oldStateHash){
   throw 'OLD_BINDING_BYTES_CHANGED'
 }
 $c=Get-Content $control -Raw -Encoding UTF8|ConvertFrom-Json
 $s=Get-Content $state -Raw -Encoding UTF8|ConvertFrom-Json
 if($c.schema_version -cne 'single-conversation-control.v1' -or
    $c.mode -cne 'SINGLE_CONVERSATION_V1' -or $c.source_of_truth_url -cne $oldSot -or
    $s.source_of_truth.url -cne $oldSot -or
    $s.automation.status -cne 'BLOCKED' -or
    $s.automation.reason -cne 'AMBIGUOUS_ENQUEUED_OUTCOME' -or
    $s.outbound.state -cne 'ENQUEUED' -or $s.outbound.kind -cne 'TASK_STATUS_CHECK' -or
    $s.outbound.task_id -cne 'XSTORE-019J' -or
    $s.outbound.message_id -cne $oldMessage){
   throw 'NOT_THE_APPROVED_OBSOLETE_PROJECT_STATE'
 }
}
function Restore([string]$target,[string]$source,[string]$expected,[string]$tag){
 if((Hash $source) -cne $expected){throw 'COLD_ARCHIVE_CORRUPT'}
 $temp=Join-Path $root ("sc013-$tag-rollback.tmp")
 if(Test-Path $temp){throw 'ROLLBACK_TEMP_PREEXISTS'}
 Copy-Item -LiteralPath $source -Destination $temp -ErrorAction Stop
 if(Test-Path $target){[IO.File]::Replace($temp,$target,$null,$true)}
 else{Move-Item -LiteralPath $temp -Destination $target -ErrorAction Stop}
 if((Hash $target) -cne $expected){throw 'ROLLBACK_READBACK_FAILED'}
}
foreach($p in @($work,$sot,$script,$root,$control,$state,$stop,$disabled)){NotReparse $p}
SafeStopped
if($Mode -eq 'Stage'){
 ExactOldBinding
 if((Test-Path $stage) -or (Test-Path $marker)){throw 'ALREADY_STAGED_OR_UNLINKED'}
 New-Item -ItemType Directory -Path $backupDir -Force -ErrorAction Stop|Out-Null
 New-Item -ItemType Directory -Path $candidateDir -Force -ErrorAction Stop|Out-Null
 $acl=Get-Acl $stage
 $acl.SetAccessRuleProtection($true,$false)
 $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
 foreach($principal in @('DESKTOP-H4A16IL\admin','NT AUTHORITY\SYSTEM','BUILTIN\Administrators')){
  $rule=New-Object Security.AccessControl.FileSystemAccessRule(
   $principal,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,
   [Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $null=$acl.AddAccessRule($rule)
 }
 Set-Acl -LiteralPath $stage -AclObject $acl -ErrorAction Stop
 if(!(Get-Acl $stage).AreAccessRulesProtected){throw 'ARCHIVE_ACL_UNPROTECTED'}
 Copy-Item $control $oldCtl -ErrorAction Stop
 Copy-Item $state $oldState -ErrorAction Stop
 if((Hash $oldCtl) -cne $oldCtlHash -or (Hash $oldState) -cne $oldStateHash){
  throw 'ARCHIVE_ORIGINAL_HASH_MISMATCH'
 }
 $at=[DateTimeOffset]::UtcNow.ToString('o')
 $controlStub=[ordered]@{
   schema_version='single-conversation-control.v1';mode='SINGLE_CONVERSATION_V1'
   project_id='UNASSIGNED';source_of_truth_url=$null;updated_at=$at
   owner_selection='NONE_OWNER_UNLINKED';execution_authorized=$false
 }
 $stateStub=[ordered]@{
   schema_version='single-conversation-state.v1';mode='SINGLE_CONVERSATION_V1'
   project_id='UNASSIGNED';session_id=$null
   source_of_truth=@{url=$null;sync_status='NEVER'}
   conversation=@{status='RETIRED';generation=0;runtime_id=$null;page_id=$null}
   outbound=@{state='NONE';message_id=$null;task_id=$null;kind=$null;retry_count=0}
   external_work=@{}
   automation=@{status='STOPPED';reason='OWNER_PROJECT_UNLINKED';phase='STOPPED';updated_at=$at}
   unlinked_only=$true;execution_authorized=$false;updated_at=$at
 }
 $controlStub|ConvertTo-Json -Depth 5|Set-Content $newCtl -Encoding UTF8
 $stateStub|ConvertTo-Json -Depth 6|Set-Content $newState -Encoding UTF8
 if((Get-Content $newCtl -Raw) -match 'XSTORE-019J|WORKFORCE_CROSS_STORE' -or
    (Get-Content $newState -Raw) -match 'XSTORE-019J|WORKFORCE_CROSS_STORE'){
   throw 'CANDIDATE_STILL_BOUND_TO_XSTORE'
 }
 $m=[ordered]@{
   schema='SC013_XSTORE019J_RETIRE_STAGE_V1';status='STAGED_COLD_ARCHIVE_ONLY'
   exact_main_sha=$sha;owner_identity=$id;created_at=$at
   old_control_sha256=$oldCtlHash;old_state_sha256=$oldStateHash
   new_control_sha256=Hash $newCtl;new_state_sha256=Hash $newState
   stop_sha256=Hash $stop;disabled_sha256=Hash $disabled
   installer_sha256=Hash $script
   old_delivery='UNKNOWN_OUTCOME_NOT_VERIFIED';old_message_replay_allowed=$false
   new_project_selected=$false;worker_started=$false
 }
 $m|ConvertTo-Json -Depth 6|Set-Content $manifest -Encoding UTF8
 ExactOldBinding
 Write-Host 'SC013_COLD_ARCHIVE_VERIFIED=True'
 Write-Host "STAGE_MANIFEST=$manifest"
 Write-Host 'ACTIVE_BINDING_NOT_MODIFIED=True'
 exit 0
}
if(!(Test-Path $manifest -PathType Leaf) -or (Test-Path $receipt) -or (Test-Path $marker)){
 throw 'RETIRE_STAGE_OR_RECEIPT_INVALID'
}
foreach($p in @($stage,$manifest,$oldCtl,$oldState,$newCtl,$newState)){NotReparse $p}
$m=Get-Content $manifest -Raw -Encoding UTF8|ConvertFrom-Json
if($m.schema -cne 'SC013_XSTORE019J_RETIRE_STAGE_V1' -or
   $m.status -cne 'STAGED_COLD_ARCHIVE_ONLY' -or $m.exact_main_sha -cne $sha -or
   $m.owner_identity -cne $id -or $m.old_message_replay_allowed -ne $false){
 throw 'STAGED_EVIDENCE_NOT_QUALIFIED'
}
if((Hash $oldCtl) -cne $oldCtlHash -or (Hash $oldState) -cne $oldStateHash -or
   (Hash $newCtl) -cne $m.new_control_sha256 -or
   (Hash $newState) -cne $m.new_state_sha256 -or
   (Hash $stop) -cne $m.stop_sha256 -or (Hash $disabled) -cne $m.disabled_sha256 -or
   (Hash $script) -cne $m.installer_sha256){throw 'STAGE_OR_OWNER_LATCH_CHANGED'}
ExactOldBinding
$receiptData=[ordered]@{
 schema='SC013_OWNER_RETIRE_XSTORE019J_V1';status='RETIRE_STARTED'
 exact_main_sha=$sha;at=[DateTimeOffset]::UtcNow.ToString('o')
 old_delivery='UNKNOWN_OUTCOME';old_outbound_replayed=$false
 new_project_selected=$false;worker_started=$false
}
$receiptData|ConvertTo-Json -Depth 5|Set-Content $receipt -Encoding UTF8
$tmpCtl=Join-Path $root 'single-conversation-control.sc013-retire.tmp'
$tmpState=Join-Path $root 'single-conversation-state.sc013-retire.tmp'
$bakCtl=Join-Path $root 'single-conversation-control.sc013-retire.bak'
$bakState=Join-Path $root 'single-conversation-state.sc013-retire.bak'
$ctlChanged=$false;$stateChanged=$false
try{
 foreach($p in @($tmpCtl,$tmpState,$bakCtl,$bakState)){
  if(Test-Path $p){throw 'TEMP_OR_BACKUP_ALREADY_EXISTS'}
 }
 Copy-Item $newCtl $tmpCtl -ErrorAction Stop
 Copy-Item $newState $tmpState -ErrorAction Stop
 if((Hash $tmpCtl) -cne $m.new_control_sha256 -or
    (Hash $tmpState) -cne $m.new_state_sha256){throw 'TEMP_STUB_HASH_INVALID'}
 SafeStopped
 [IO.File]::Replace($tmpCtl,$control,$bakCtl,$true)
 $ctlChanged=$true
 [IO.File]::Replace($tmpState,$state,$bakState,$true)
 $stateChanged=$true
 if((Hash $control) -cne $m.new_control_sha256 -or
    (Hash $state) -cne $m.new_state_sha256 -or
    (Hash $bakCtl) -cne $oldCtlHash -or (Hash $bakState) -cne $oldStateHash){
  throw 'ACTIVE_DETACH_OR_BACKUP_HASH_FAILED'
 }
 SafeStopped
 if((Hash $stop) -cne $m.stop_sha256 -or
    (Hash $disabled) -cne $m.disabled_sha256){throw 'STOP_LATCH_CONTENT_CHANGED'}
 $status=[ordered]@{
   schema='SC013_SUPERVISOR_UNLINKED_V1';status='OWNER_UNLINKED_WAIT_NEW_SOT'
   active_project=$null;active_sot=$null;start_allowed=$false
   business_execution_authorized=$false;new_project_selected=$false
   old_delivery='UNKNOWN_IN_COLD_ARCHIVE';pending_old_message_replay_allowed=$false
   archive=$stage;old_control_sha256=$oldCtlHash;old_state_sha256=$oldStateHash
   completed_at=[DateTimeOffset]::UtcNow.ToString('o')
 }
 $status|ConvertTo-Json -Depth 5|Set-Content $marker -Encoding UTF8
 $receiptData.status='OWNER_UNLINKED_NO_ACTIVE_PROJECT'
 $receiptData.active_control_sha256=Hash $control
 $receiptData.active_state_sha256=Hash $state
 $receiptData.stop_preserved=$true;$receiptData.old_outbound_replayed=$false
 $receiptData|ConvertTo-Json -Depth 6|Set-Content $receipt -Encoding UTF8
 Remove-Item $bakCtl,$bakState -Force -ErrorAction Stop
 Write-Host 'SC013_XSTORE019J_UNLINKED=True'
 Write-Host 'NO_ACTIVE_PROJECT=True'
 Write-Host 'ENQUEUED_OLD_TRANSACTION_COLD_ARCHIVED_NOT_REPLAYED=True'
 Write-Host 'STOP_AUTOSTART_DISABLED_PRESERVED=True'
 Write-Host "RETIRE_RECEIPT=$receipt"
}catch{
 $errorDetail=$_.Exception.Message
 $rollback='NOT_NEEDED'
 try{
  if($ctlChanged){Restore $control $oldCtl $oldCtlHash 'control'}
  if($stateChanged){Restore $state $oldState $oldStateHash 'state'}
  if(Test-Path $marker){Remove-Item $marker -Force -ErrorAction Stop}
  $rollback='VERIFIED_ORIGINALS_RESTORED'
 }catch{$rollback="MANUAL_RECOVERY_REQUIRED:$($_.Exception.Message)"}
 $receiptData.status='RETIRE_FAILED';$receiptData.failure=$errorDetail
 $receiptData.rollback=$rollback
 $receiptData|ConvertTo-Json -Depth 6|Set-Content $receipt -Encoding UTF8
 throw "RETIRE_FAILED:$errorDetail;ROLLBACK=$rollback"
}finally{
 foreach($p in @($tmpCtl,$tmpState)){
  if(Test-Path $p){Remove-Item $p -Force -ErrorAction SilentlyContinue}
 }
}
