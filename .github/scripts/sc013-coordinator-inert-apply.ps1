param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')]
  [string]$ExpectedMainSha
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

# Owner-approved SC-013 Coordinator APPLY: three inert source files only.
# NEVER modify coordinator.py, scripts for the 30m timer, Supervisor,
# Gateway, STOP, Windows services, scheduled tasks or robot lifecycle.
if([Environment]::MachineName -ne 'DESKTOP-H4A16IL'){throw 'WRONG_TARGET_MACHINE'}
if($env:GITHUB_EVENT_NAME -ne 'push'){throw 'OWNER_REVIEWED_APPLY_MARKER_PUSH_REQUIRED'}
$workspace=[string]$env:GITHUB_WORKSPACE
if([string]::IsNullOrWhiteSpace($workspace) -or !(Test-Path (Join-Path $workspace '.git'))){
  throw 'TRUSTED_CHECKOUT_REQUIRED'
}
$sha=(& git -C $workspace rev-parse HEAD).Trim().ToLowerInvariant()
if($LASTEXITCODE -ne 0 -or $sha -ne $ExpectedMainSha.ToLowerInvariant()){
  throw 'APPLY_CHECKOUT_SHA_MISMATCH'
}
$head=(& git -C $workspace ls-remote origin refs/heads/main)
if($LASTEXITCODE -ne 0 -or !$head){throw 'MAIN_AUTHORITY_UNAVAILABLE'}
if((($head -split '\s+')[0]).ToLowerInvariant() -ne $sha){
  throw 'MAIN_CHANGED_ABORT_APPLY'
}
$marker=Join-Path $workspace '.github\sc013-coordinator-apply-request.json'
if(!(Test-Path -LiteralPath $marker -PathType Leaf)){throw 'APPLY_MARKER_MISSING'}
$approval=Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
if($approval.schema -ne 'MAGASIN_SC013_COORDINATOR_APPLY_V1' -or
   $approval.mode -ne 'INSTALL_INERT_READ_ONLY_FILES' -or
   $approval.target -ne 'DESKTOP-H4A16IL' -or
   $approval.owner_approved -ne $true -or
   $approval.business_execution_enabled -ne $false -or
   $approval.start_robots -ne $false -or
   $approval.source_commit -notmatch '^[a-f0-9]{40}$'){
  throw 'OWNER_APPLY_SCOPE_NOT_AUTHORIZED'
}
& git -C $workspace merge-base --is-ancestor $approval.source_commit $sha
if($LASTEXITCODE -ne 0){throw 'APPROVED_SOURCE_NOT_MAIN_ANCESTOR'}
$sot=Get-Content -LiteralPath (Join-Path $workspace 'SOURCE_OF_TRUTH.md') -Raw -Encoding UTF8
if(!$sot.Contains('### SC-013 inert Coordinator bridge local APPLY (Owner approved 2026-10-09)')){
  throw 'CANONICAL_SOT_APPLY_AUTHORITY_MISSING'
}

$stage=Join-Path 'D:\MAGASIN_ROBOTS\deploy\sc013-coordinator-readonly' $sha
$manifestFile=Join-Path $stage 'manifest.json'
if(!(Test-Path -LiteralPath $manifestFile)){throw 'FRESH_STAGE_MANIFEST_MISSING'}
$manifest=Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
if($manifest.schema -ne 'MAGASIN_SC013_COORDINATOR_STAGE_RESULT_V1' -or
   $manifest.mode -ne 'STAGED_READ_ONLY_NOT_INSTALLED' -or
   $manifest.target -ne 'DESKTOP-H4A16IL' -or
   $manifest.exact_main_sha -ne $sha -or
   @($manifest.source_files).Count -ne 3 -or
   $manifest.installation_performed -ne $false -or
   $manifest.business_execution_qualified -ne $false){
  throw 'STAGE_MANIFEST_UNQUALIFIED'
}
$stamp=[datetimeoffset]::Parse([string]$manifest.checked_at)
$age=([datetimeoffset]::UtcNow-$stamp).TotalMinutes
if($age -lt -1 -or $age -gt 20){throw 'STAGE_MANIFEST_NOT_FRESH'}

$root='D:\MAGASIN_ROBOTS\robots\coordinator'
if(((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
  throw 'COORDINATOR_PATH_REPARSE_UNQUALIFIED'
}
if(((Get-Item -LiteralPath $stage).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
  throw 'STAGE_PATH_REPARSE_UNQUALIFIED'
}
$control=Join-Path $root 'coordinator.py'
$statusFile=Join-Path $root 'state\coordinator-status.json'
if(!(Test-Path -LiteralPath $control) -or !(Test-Path -LiteralPath $statusFile)){
  throw 'LIVE_COORDINATOR_IDENTITY_MISSING'
}
$stopRoot='C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor'
function AssertOwnerInactive {
  if((Test-Path -LiteralPath (Join-Path $stopRoot 'STOP')) -or
     (Test-Path -LiteralPath (Join-Path $stopRoot 'AUTOSTART_DISABLED'))){
    throw 'OWNER_STOP_OR_DISABLE_ACTIVE'
  }
  $state=Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if($state.mode -ne 'OFF_OWNER_MANUAL' -or $state.execution_enabled -ne $false){
    throw 'COORDINATOR_NOT_OFF'
  }
  foreach($name in @('supervisor','saydi','sapo')){
    if($state.owner_enabled.$name -ne $false){
      throw 'SPECIALIST_OWNER_ENABLE_NOT_FALSE'
    }
  }
}
AssertOwnerInactive
$active=@(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe' OR Name='node.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -and $_.CommandLine -match '(?i)coordinator\.py|sot-preflight-(?:cli|python-bridge)' })
if($active.Count -gt 0){throw 'COORDINATOR_PREFLIGHT_PROCESS_ACTIVE'}

$names=@('sot-adapter.mjs','sot-preflight-cli.mjs','sot-preflight-python-bridge.py')
$paths=@('src/coordinator/sot-adapter.mjs','src/coordinator/sot-preflight-cli.mjs',
         'src/coordinator/sot-preflight-python-bridge.py')
function Hash([string]$path){
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
$expected=@{}
for($i=0; $i -lt $names.Count; $i++){
  $entry=@($manifest.source_files) | Where-Object { $_.path -ceq $paths[$i] }
  if(@($entry).Count -ne 1){throw 'STAGE_PATH_NOT_UNIQUE'}
  $source=Join-Path $workspace $paths[$i]
  $candidate=Join-Path $stage $names[$i]
  $destination=Join-Path $root $names[$i]
  if(!(Test-Path -LiteralPath $source -PathType Leaf) -or
     !(Test-Path -LiteralPath $candidate -PathType Leaf)){
    throw 'SOURCE_OR_STAGE_FILE_MISSING'
  }
  if(Test-Path -LiteralPath $destination){throw 'EXISTING_LOCAL_FILE_REQUIRES_REVIEW'}
  $hash=[string]$entry[0].sha256
  if($hash -notmatch '^[a-f0-9]{64}$' -or (Hash $source) -ne $hash -or
     (Hash $candidate) -ne $hash){throw 'STAGED_SOURCE_HASH_MISMATCH'}
  $expected[$names[$i]]=$hash
}
$node=(Get-Command node -ErrorAction Stop).Source
& $node --check (Join-Path $stage 'sot-adapter.mjs')
if($LASTEXITCODE -ne 0){throw 'ADAPTER_SYNTAX_FAILED'}
& $node --check (Join-Path $stage 'sot-preflight-cli.mjs')
if($LASTEXITCODE -ne 0){throw 'CLI_SYNTAX_FAILED'}
$python='C:\MAGASIN_MCP\.venv\Scripts\python.exe'
if(!(Test-Path -LiteralPath $python)){throw 'PYTHON_NOT_FOUND'}
& $python -c "import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))" (Join-Path $stage 'sot-preflight-python-bridge.py')
if($LASTEXITCODE -ne 0){throw 'BRIDGE_SYNTAX_FAILED'}
if((Get-PSDrive D).Free -lt 500MB){throw 'D_RESOURCE_GATE_FAILED'}

# All live changes are ADD-ONLY; do not overwrite or alter coordinator.py.
# Preserve a read-only hash of its actual bytes for before/after verification.
$controlHash=Hash $control
$backupDir=Join-Path $stage 'backup'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Copy-Item -LiteralPath $control -Destination (Join-Path $backupDir 'coordinator.py') -Force
if((Hash (Join-Path $backupDir 'coordinator.py')) -ne $controlHash){
  throw 'COORDINATOR_BACKUP_HASH_MISMATCH'
}
$created=New-Object 'System.Collections.Generic.List[string]'
$temporary=New-Object 'System.Collections.Generic.List[string]'
$receipt=Join-Path $stage 'installation.json'
if(Test-Path -LiteralPath $receipt){throw 'INSTALL_RECEIPT_ALREADY_EXISTS'}
try {
  AssertOwnerInactive
  for($i=0;$i -lt $names.Count;$i++){
    AssertOwnerInactive
    $name=$names[$i]
    $destination=Join-Path $root $name
    if(Test-Path -LiteralPath $destination){throw 'TARGET_CHANGED_DURING_APPLY'}
    $temp=Join-Path $root ($name+'.sc013-'+$sha+'.tmp')
    if(Test-Path -LiteralPath $temp){throw 'LEFTOVER_TEMP_REQUIRES_REVIEW'}
    $temporary.Add($temp)
    Copy-Item -LiteralPath (Join-Path $stage $name) -Destination $temp
    if((Hash $temp) -ne $expected[$name]){Remove-Item -LiteralPath $temp -Force; throw 'TEMP_SOURCE_HASH_MISMATCH'}
    Move-Item -LiteralPath $temp -Destination $destination
    $created.Add($destination)
    if((Hash $destination) -ne $expected[$name]){throw 'INSTALLED_HASH_MISMATCH'}
  }
  AssertOwnerInactive
  if((Hash $control) -ne $controlHash){throw 'COORDINATOR_PY_CHANGED'}
  $items=@()
  foreach($name in $names){
    $dest=Join-Path $root $name
    $items+=@{name=$name;sha256=(Hash $dest)}
  }
  $output=[ordered]@{
    schema='MAGASIN_SC013_COORDINATOR_APPLY_RESULT_V1'
    result='INSTALLED_INERT_FILES_NOT_INTEGRATED'
    target='DESKTOP-H4A16IL'
    exact_main_sha=$sha
    installed_at=([datetimeoffset]::UtcNow.ToString('o'))
    installed_files=$items
    coordinator_py_hash_unchanged=$true
    coordinator_off=$true
    business_execution_qualified=$false
    dispatched=$false
    worker_started_or_stopped=$false
    windows_scheduler_modified=$false
    chatgpt_outbound=$false
    gateway_modified=$false
  }
  $output | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath ($receipt+'.tmp') -Encoding UTF8
  Move-Item -LiteralPath ($receipt+'.tmp') -Destination $receipt
  Write-Host 'INERT_COORDINATOR_APPLY_PASS=True'
  Write-Host 'BUSINESS_EXECUTION_QUALIFIED=False'
  Write-Host 'CHATGPT_OUTBOUND=False'
  Write-Host ('INSTALL_MANIFEST='+$receipt)
} catch {
  # Roll back ONLY unchanged files just created by this attempt; never touch
  # unknown/preexisting local source or STOP. Keep D: staging + backup.
  $rollbackOk=$true
  foreach($dest in $created){
    $name=[IO.Path]::GetFileName($dest)
    if((Test-Path -LiteralPath $dest) -and (Hash $dest) -eq $expected[$name]){
      Remove-Item -LiteralPath $dest -Force
    } else {
      $rollbackOk=$false
    }
  }
  foreach($temp in $temporary){
    if(Test-Path -LiteralPath $temp){Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue}
    if(Test-Path -LiteralPath $temp){$rollbackOk=$false}
  }
  if((Hash $control) -ne $controlHash){$rollbackOk=$false}
  $failure=[ordered]@{
    schema='MAGASIN_SC013_COORDINATOR_APPLY_FAILURE_V1'
    exact_main_sha=$sha
    result='FAILED_ROLLBACK_ATTEMPTED'
    failure_code=([string]$_.Exception.Message -replace '[^A-Za-z0-9_]', '_').Substring(0,[math]::Min(90,([string]$_.Exception.Message).Length))
    rollback_safe=$rollbackOk
    business_execution_qualified=$false
    chatgpt_outbound=$false
  }
  $failure | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'installation-failure.json') -Encoding UTF8
  Write-Host ('INSTALL_ROLLBACK_SAFE='+$rollbackOk)
  throw
}
