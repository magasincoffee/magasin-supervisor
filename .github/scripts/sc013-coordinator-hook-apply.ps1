param(
  [Parameter(Mandatory=$true)]
  [ValidatePattern('^[a-fA-F0-9]{40}$')]
  [string]$ExpectedMainSha
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

# One Owner-reviewed Coordinator.py update only. NO new scheduled task,
# worker restart, Gateway write, specialist enable, ChatGPT outbound or
# business execution. Refuse ambiguous local source and fail closed.
if([Environment]::MachineName -ne 'DESKTOP-H4A16IL'){throw 'WRONG_TARGET_MACHINE'}
if($env:GITHUB_EVENT_NAME -ne 'push'){throw 'EXPLICIT_APPROVED_MARKER_PUSH_REQUIRED'}
$workspace=[string]$env:GITHUB_WORKSPACE
if([string]::IsNullOrWhiteSpace($workspace) -or !(Test-Path (Join-Path $workspace '.git'))){
  throw 'GITHUB_CHECKOUT_REQUIRED'
}
$sha=(& git -C $workspace rev-parse HEAD).Trim().ToLowerInvariant()
if($LASTEXITCODE -ne 0 -or $sha -ne $ExpectedMainSha.ToLowerInvariant()){
  throw 'CHECKOUT_SHA_MISMATCH'
}
$head=(& git -C $workspace ls-remote origin refs/heads/main)
if($LASTEXITCODE -ne 0 -or !$head){throw 'MAIN_AUTHORITY_NOT_VERIFIED'}
if((($head -split '\s+')[0]).ToLowerInvariant() -ne $sha){
  throw 'MAIN_SHA_CHANGED_REDISPATCH_REQUIRED'
}
$sot=Get-Content -LiteralPath (Join-Path $workspace 'SOURCE_OF_TRUTH.md') -Raw -Encoding UTF8
if(!$sot.Contains('### SC-013 read-only Coordinator cycle integration (Owner 2026-10-09)')){
  throw 'SOT_HOOK_GATE_NOT_FOUND'
}
$marker=Join-Path $workspace '.github\sc013-coordinator-hook-apply-request.json'
if(!(Test-Path -LiteralPath $marker -PathType Leaf)){throw 'APPROVAL_MARKER_MISSING'}
$approval=Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
if($approval.schema -ne 'MAGASIN_SC013_COORDINATOR_CYCLE_HOOK_APPLY_V1' -or
   $approval.mode -ne 'APPLY_READ_ONLY_HOOK_ONLY' -or
   $approval.target -ne 'DESKTOP-H4A16IL' -or
   $approval.owner_approved -ne $true -or
   $approval.business_execution_enabled -ne $false -or
   $approval.start_robots -ne $false -or
   $approval.source_commit -notmatch '^[a-f0-9]{40}$' -or
   $approval.expected_old_sha256 -notmatch '^[a-f0-9]{64}$'){
  throw 'OWNER_APPROVAL_SCOPE_INVALID'
}
& git -C $workspace merge-base --is-ancestor $approval.source_commit $sha
if($LASTEXITCODE -ne 0){throw 'SOURCE_NOT_APPROVED_ANCESTOR'}

$root='D:\MAGASIN_ROBOTS\robots\coordinator'
$live=Join-Path $root 'coordinator.py'
$source=Join-Path $workspace 'src\coordinator\coordinator.py'
$report=Join-Path $root 'state\coordinator-status.json'
$stopRoot='C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor'
$lockfile=Join-Path 'D:\MAGASIN_ROBOTS\deploy' 'sc013-coordinator-hook-deploy.lock'
$stage=Join-Path 'D:\MAGASIN_ROBOTS\deploy\sc013-coordinator-hook' $sha
$receipt=Join-Path $stage 'installation.json'
$backup=Join-Path $stage 'backup\coordinator.py'
$candidate=Join-Path $stage 'candidate\coordinator.py'
$installedBridge=@('sot-adapter.mjs','sot-preflight-cli.mjs','sot-preflight-python-bridge.py')
$expectedHashes=@{
  'sot-adapter.mjs'='4fd963a6fa5d2f965d6bc8e5230a94dbab368d015e3c9868bb97a191550881fe'
  'sot-preflight-cli.mjs'='081a5469d9ebe25309e99add701af44881565b37744f6df351ff9a98b1f305e7'
  'sot-preflight-python-bridge.py'='16474c9157a1900c9180b07f06bed88adf86eef1bcf39edf209c450e7b5757e6'
}
function Hash([string]$file){
  return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
}
function AssertGuard {
  if([Environment]::MachineName -ne 'DESKTOP-H4A16IL'){throw 'WRONG_TARGET_MACHINE'}
  if((Test-Path (Join-Path $stopRoot 'STOP')) -or
     (Test-Path (Join-Path $stopRoot 'AUTOSTART_DISABLED'))){
    throw 'OWNER_STOP_OR_DISABLE_ACTIVE'
  }
  $state=Get-Content -LiteralPath $report -Raw -Encoding UTF8 | ConvertFrom-Json
  if($state.mode -ne 'OFF_OWNER_MANUAL' -or $state.execution_enabled -ne $false){
    throw 'COORDINATOR_NOT_OWNER_OFF'
  }
  foreach($name in @('supervisor','saydi','sapo')){
    if($state.owner_enabled.$name -ne $false){throw 'SPECIALIST_NOT_OWNER_OFF'}
  }
  foreach($file in $installedBridge){
    $existing=Join-Path $root $file
    if(!(Test-Path -LiteralPath $existing -PathType Leaf) -or
       (Hash $existing) -ne $expectedHashes[$file]){
      throw 'INSTALLED_READONLY_BRIDGE_DRIFT'
    }
  }
  $task=Get-ScheduledTask -TaskName 'MAGASIN SC013 Local 30min' -ErrorAction Stop
  if($task.State -eq 'Running'){throw 'SCHEDULER_TICK_RUNNING'}
  $active=@(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe' OR Name='node.exe'" -ErrorAction Stop |
    Where-Object {$_.CommandLine -and $_.CommandLine -match '(?i)(coordinator\.py|sot-preflight-python-bridge|sot-preflight-cli)'})
  if($active.Count -gt 0){throw 'COORDINATOR_OR_PREFLIGHT_PROCESS_ACTIVE'}
}
if(!(Test-Path $source -PathType Leaf) -or !(Test-Path $live -PathType Leaf) -or
   !(Test-Path $report -PathType Leaf)){throw 'REQUIRED_SOURCE_OR_LIVE_MISSING'}
if(((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
  throw 'LOCAL_DIRECTORY_REPARSE_NOT_QUALIFIED'
}
if((Get-PSDrive D).Free -lt 500MB){throw 'D_RESOURCE_GATE_LOW'}
if((Hash $live) -ne $approval.expected_old_sha256){throw 'LIVE_COORDINATOR_SHA_DRIFT'}
AssertGuard
if(Test-Path $stage){throw 'DEPLOY_STAGE_ALREADY_EXISTS'}
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'backup') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'candidate') | Out-Null
Copy-Item -LiteralPath $live -Destination $backup
Copy-Item -LiteralPath $source -Destination $candidate
$wantedHash=Hash $source
if((Hash $backup) -ne $approval.expected_old_sha256 -or (Hash $candidate) -ne $wantedHash){
  throw 'STAGED_BACKUP_OR_SOURCE_HASH_FAILED'
}
$python='C:\MAGASIN_MCP\.venv\Scripts\python.exe'
if(!(Test-Path $python -PathType Leaf)){throw 'PINNED_LOCAL_PYTHON_MISSING'}
# AST-only syntax parser; never execute candidate before reviewed replace.
& $python -c "import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))" $candidate
if($LASTEXITCODE -ne 0){throw 'PYTHON_AST_SYNTAX_FAILED'}
$stageManifest=[ordered]@{
  schema='MAGASIN_SC013_COORDINATOR_HOOK_STAGE_V1'
  target='DESKTOP-H4A16IL'
  exact_main_sha=$sha
  expected_old_sha256=[string]$approval.expected_old_sha256
  candidate_sha256=$wantedHash
  staged_at=[datetimeoffset]::UtcNow.ToString('o')
  backup_verified=$true
  mode='STAGED_OFFLINE_REPLACEMENT'
}
$stageManifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'manifest.json') -Encoding UTF8

# Strict create-new OS handle as an exclusive lock; never run in parallel.
$lock=$null
try {
  $lock=[IO.File]::Open($lockfile,[IO.FileMode]::CreateNew,
                         [IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  AssertGuard
  if((Hash $live) -ne $approval.expected_old_sha256){throw 'LIVE_CHANGED_AFTER_STAGE'}
  $temp="$live.sc013-$sha.tmp"
  if(Test-Path -LiteralPath $temp){throw 'OLD_DEPLOY_TEMP_EXISTS'}
  Copy-Item -LiteralPath $candidate -Destination $temp
  if((Hash $temp) -ne $wantedHash){throw 'TEMP_HASH_MISMATCH'}
  # Atomic replacement within same volume; backup remains on D: for rollback.
  Move-Item -LiteralPath $temp -Destination $live -Force
  if((Hash $live) -ne $wantedHash){throw 'INSTALL_HASH_MISMATCH'}
  # This code is only a read-only preflight hook: its visible state stays OFF.
  AssertGuard
  $receiptData=[ordered]@{
    schema='MAGASIN_SC013_COORDINATOR_HOOK_APPLY_V1'
    result='INSTALLED_READONLY_HOOK_NOT_EXECUTOR'
    exact_main_sha=$sha
    target='DESKTOP-H4A16IL'
    installed_at=[datetimeoffset]::UtcNow.ToString('o')
    old_sha256=[string]$approval.expected_old_sha256
    installed_sha256=$wantedHash
    coordinator_owner_off=$true
    execution_enabled=$false
    specialist_started=$false
    windows_scheduler_modified=$false
    chatgpt_outbound=$false
    business_completed=$false
  }
  $receiptData | ConvertTo-Json | Set-Content -LiteralPath ($receipt+'.tmp') -Encoding UTF8
  Move-Item -LiteralPath ($receipt+'.tmp') -Destination $receipt
  Write-Host 'SC013_COORDINATOR_HOOK_APPLY_PASS=True'
  Write-Host ('COORDINATOR_HOOK_HASH='+$wantedHash)
  Write-Host ('COORDINATOR_HOOK_RECEIPT='+$receipt)
  Write-Host 'NO_SUPERVISOR_START=True'
  Write-Host 'NO_CHATGPT_OUTBOUND=True'
}
catch {
  # Rollback exactly the just-written source when its hash is recognized.
  $safe=$false
  try {
    if((Test-Path $live) -and
       ((Hash $live) -eq $wantedHash -or (Hash $live) -eq $approval.expected_old_sha256) -and
       (Hash $backup) -eq $approval.expected_old_sha256){
      Copy-Item -LiteralPath $backup -Destination $live -Force
      $safe=((Hash $live) -eq $approval.expected_old_sha256)
    }
  } catch {$safe=$false}
  $failure=[ordered]@{
    schema='MAGASIN_SC013_COORDINATOR_HOOK_APPLY_FAILURE_V1'
    exact_main_sha=$sha
    rollback_verified=$safe
    result='FAILED_ROLLBACK_ATTEMPTED'
    execution_enabled=$false
    chatgpt_outbound=$false
  }
  $failure|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $stage 'failure.json') -Encoding UTF8
  Write-Host ('COORDINATOR_HOOK_ROLLBACK_VERIFIED='+$safe)
  throw
}
finally {
  if($lock){$lock.Dispose()}
  # Lock cleanup on this same run only. A stale lock needs explicit inspection.
  if(Test-Path -LiteralPath $lockfile){Remove-Item -LiteralPath $lockfile -Force -ErrorAction SilentlyContinue}
}
