param(
  [Parameter(Mandatory=$true)]
  [ValidatePattern('^[a-fA-F0-9]{40}$')]
  [string]$ExpectedMainSha
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

# SC-013 only: install read-only Owner Coordinator control files and restart
# the LOCAL CONTROL CENTER VIEW. No Coordinator/Supervisor/Chrome/specialist
# start, no Scheduler changes, no business task dispatch or ChatGPT outbound.
if([Environment]::MachineName -ne 'DESKTOP-H4A16IL'){throw 'WRONG_TARGET_MACHINE'}
if($env:GITHUB_EVENT_NAME -ne 'push'){throw 'OWNER_REVIEWED_MARKER_PUSH_REQUIRED'}
$ws=[string]$env:GITHUB_WORKSPACE
if([string]::IsNullOrWhiteSpace($ws) -or !(Test-Path (Join-Path $ws '.git'))){
  throw 'TRUSTED_GITHUB_CHECKOUT_REQUIRED'
}
$sha=(& git -C $ws rev-parse HEAD).Trim().ToLowerInvariant()
if($LASTEXITCODE -ne 0 -or $sha -ne $ExpectedMainSha.ToLowerInvariant()){
  throw 'EXACT_CHECKOUT_MISMATCH'
}
$remote=(& git -C $ws ls-remote origin refs/heads/main)
if($LASTEXITCODE -ne 0 -or !$remote){throw 'LIVE_MAIN_UNAVAILABLE'}
if((($remote -split '\s+')[0]).ToLowerInvariant() -ne $sha){throw 'MAIN_MOVED_ABORT'}
$sot=Get-Content (Join-Path $ws 'SOURCE_OF_TRUTH.md') -Raw -Encoding UTF8
if(!$sot.Contains('### SC-013 Owner Control Center gated local APPLY (2026-10-09)')){
  throw 'SOT_DEPLOY_AUTHORITY_MISSING'
}
$marker=Join-Path $ws '.github\sc013-owner-control-apply-request.json'
if(!(Test-Path -LiteralPath $marker -PathType Leaf)){throw 'OWNER_MARKER_MISSING'}
$approved=Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
if($approved.schema -ne 'MAGASIN_SC013_OWNER_CONTROL_APPLY_V1' -or
   $approved.target -ne 'DESKTOP-H4A16IL' -or
   $approved.mode -ne 'INSTALL_OWNER_READONLY_UI' -or
   $approved.owner_approved -ne $true -or
   $approved.business_execution_enabled -ne $false -or
   $approved.start_robots -ne $false -or
   $approved.source_commit -notmatch '^[a-f0-9]{40}$'){
  throw 'APPLY_SCOPE_NOT_APPROVED'
}
& git -C $ws merge-base --is-ancestor $approved.source_commit $sha
if($LASTEXITCODE -ne 0){throw 'APPROVED_SOURCE_NOT_MAIN_ANCESTOR'}
$base='D:\MAGASIN_ROBOTS'
$control=Join-Path $base 'control-center'
$coordinator=Join-Path $base 'robots\coordinator'
$supervisor='C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor'
$state=Join-Path $coordinator 'state\coordinator-status.json'
$flags=Join-Path $coordinator 'config\owner_enabled.json'
$liveServer=Join-Path $control 'server.py'
$liveWeb=Join-Path $control 'web\app.js'
$liveOwner=Join-Path $coordinator 'owner_lifecycle.py'
$liveCoord=Join-Path $coordinator 'coordinator.py'
$launch=Join-Path $control 'START_CONTROL.ps1'
$expectedCoordHash='fe4cfc261a06fdb42a6a1053697344d6990ef47f747cc073eb056ae9f62f93dd'
$expectedServerHash='7d9539a051d63b78dfea87a6cb1b95c7a718c8259196e8dc0bbf1b0534e8c1eb'
$expectedWebHash='2ffe63256f8b37d734aacda63c1d740254f699f01cc1610a752475e2c7a2ab07'
$stage=Join-Path $base ('deploy\sc013-owner-control\'+$sha)
$lockfile=Join-Path $base 'deploy\sc013-owner-control-apply.lock'
$ownerState=Join-Path $coordinator 'state\owner-lifecycle.json'
$ownerLock=Join-Path $coordinator 'state\owner-lifecycle.lock'
$manifest=Join-Path $stage 'install-result.json'
function Hash([string]$file){return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
function AssertMachineSafety {
  if((Test-Path (Join-Path $supervisor 'STOP')) -or
     (Test-Path (Join-Path $supervisor 'AUTOSTART_DISABLED'))){throw 'SUPERVISOR_OWNER_STOP_ACTIVE'}
  if(Test-Path $ownerState){throw 'OWNER_CONTROL_ALREADY_INITIALIZED'}
  if(Test-Path $ownerLock){throw 'UNEXPLAINED_OWNER_LIFECYCLE_LOCK'}
  $s=Get-Content -LiteralPath $state -Raw -Encoding UTF8|ConvertFrom-Json
  $f=Get-Content -LiteralPath $flags -Raw -Encoding UTF8|ConvertFrom-Json
  if($s.mode -ne 'OFF_OWNER_MANUAL' -or $s.execution_enabled -ne $false){
    throw 'COORDINATOR_NOT_OWNER_OFF'
  }
  foreach($name in @('supervisor','saydi','sapo')){
    if($f.$name -ne $false -or $s.owner_enabled.$name -ne $false){
      throw 'SPECIALIST_OWNER_FLAG_NOT_OFF'
    }
  }
  if((Hash $liveCoord) -ne $expectedCoordHash){throw 'COORDINATOR_SOURCE_CHANGED'}
  if((Get-PSDrive D).Free -lt 500MB){throw 'D_RESOURCE_GATE'}
  $os=Get-CimInstance Win32_OperatingSystem
  if(($os.FreePhysicalMemory / 1048576) -lt 0.75){throw 'LOW_RAM_HEADROOM'}
  $task=Get-ScheduledTask -TaskName 'MAGASIN SC013 Local 30min' -ErrorAction Stop
  if($task.State -eq 'Running'){throw 'LOCAL_TICK_ACTIVE'}
}
if(!(Test-Path -LiteralPath $launch -PathType Leaf) -or
   !(Test-Path -LiteralPath $liveServer -PathType Leaf) -or
   !(Test-Path -LiteralPath $liveWeb -PathType Leaf) -or
   !(Test-Path -LiteralPath $liveCoord -PathType Leaf)){
  throw 'INSTALLED_CONTROL_IDENTITY_MISSING'
}
foreach($dir in @($control,$coordinator,(Join-Path $control 'web'))){
  if(((Get-Item -LiteralPath $dir).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
    throw 'REPARSE_DIRECTORY_UNQUALIFIED'
  }
}
if(Test-Path -LiteralPath $liveOwner){throw 'OWNER_MODULE_ALREADY_INSTALLED'}
if(Test-Path -LiteralPath $stage){throw 'DUPLICATE_STAGE_REQUIRES_REVIEW'}
if((Hash $liveServer) -ne $expectedServerHash -or (Hash $liveWeb) -ne $expectedWebHash){
  throw 'CONTROL_CENTER_HASH_DRIFT'
}
AssertMachineSafety
$bindings=@(
  @{source='src/coordinator/owner_lifecycle.py';name='owner_lifecycle.py';dest=$liveOwner},
  @{source='src/control-center/server.py';name='server.py';dest=$liveServer},
  @{source='src/control-center/web/app.js';name='app.js';dest=$liveWeb}
)
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'candidate') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'backup') | Out-Null
Copy-Item -LiteralPath $liveServer -Destination (Join-Path $stage 'backup\server.py')
Copy-Item -LiteralPath $liveWeb -Destination (Join-Path $stage 'backup\app.js')
if((Hash (Join-Path $stage 'backup\server.py')) -ne $expectedServerHash -or
   (Hash (Join-Path $stage 'backup\app.js')) -ne $expectedWebHash){
  throw 'BACKUP_HASH_MISMATCH'
}
$expected=@{}
foreach($binding in $bindings){
  $src=Join-Path $ws $binding.source
  $dst=Join-Path $stage ('candidate\'+$binding.name)
  if(!(Test-Path -LiteralPath $src -PathType Leaf)){throw 'SOURCE_CANDIDATE_MISSING'}
  Copy-Item -LiteralPath $src -Destination $dst
  $hash=Hash $src
  if((Hash $dst) -ne $hash){throw 'CANDIDATE_HASH_MISMATCH'}
  $expected[$binding.name]=$hash
}
$py='C:\MAGASIN_MCP\.venv\Scripts\python.exe'
$node=(Get-Command node -ErrorAction Stop).Source
if(!(Test-Path -LiteralPath $py)){throw 'PYTHON_RUNTIME_MISSING'}
foreach($name in @('server.py','owner_lifecycle.py')){
  & $py -c "import ast,pathlib,sys;ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf8'))" (Join-Path $stage ('candidate\'+$name))
  if($LASTEXITCODE -ne 0){throw 'PYTHON_AST_SYNTAX_INVALID'}
}
& $node --check (Join-Path $stage 'candidate\app.js')
if($LASTEXITCODE -ne 0){throw 'CONTROL_JS_SYNTAX_INVALID'}
$port=@(Get-NetTCPConnection -LocalPort 8781 -State Listen -ErrorAction Stop)
if($port.Count -ne 1 -or $port[0].LocalAddress -ne '127.0.0.1'){
  throw 'CONTROL_PORT_IDENTITY_AMBIGUOUS'
}
$oldPid=[int]$port[0].OwningProcess
$p=Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid" -ErrorAction Stop
if(!$p -or !$p.CommandLine -or $p.CommandLine -notlike '*D:\MAGASIN_ROBOTS\control-center\server.py*'){
  throw 'CONTROL_SERVER_PROCESS_UNVERIFIED'
}
$req=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8781/healthz' -TimeoutSec 2
if($req.StatusCode -ne 200 -or $req.Content -ne 'ok'){throw 'OLD_CONTROL_NOT_HEALTHY'}
$lock=$null;$ownsLock=$false;$changed=$false;$stopped=$false
try {
  $lock=[IO.File]::Open($lockfile,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $ownsLock=$true
  AssertMachineSafety
  if((Hash $liveServer) -ne $expectedServerHash -or (Hash $liveWeb) -ne $expectedWebHash){
    throw 'SOURCE_CHANGED_DURING_STAGE'
  }
  Stop-Process -Id $oldPid -ErrorAction Stop
  $stopped=$true
  for($i=0;$i -lt 30;$i++){
    if(!(Get-NetTCPConnection -LocalPort 8781 -State Listen -ErrorAction SilentlyContinue)){break}
    Start-Sleep -Milliseconds 150
  }
  if(Get-NetTCPConnection -LocalPort 8781 -State Listen -ErrorAction SilentlyContinue){
    throw 'CONTROL_PORT_NOT_RELEASED'
  }
  foreach($binding in $bindings){
    $dst=$binding.dest
    if($binding.name -eq 'owner_lifecycle.py' -and (Test-Path -LiteralPath $dst)){
      throw 'OWNER_MODULE_CREATED_BY_OTHER_PROCESS'
    }
    $tmp=($dst+'.sc013-'+$sha+'.tmp')
    if(Test-Path -LiteralPath $tmp){throw 'UNREVIEWED_TEMP_FILE'}
    Copy-Item -LiteralPath (Join-Path $stage ('candidate\'+$binding.name)) -Destination $tmp
    if((Hash $tmp) -ne $expected[$binding.name]){throw 'TEMP_HASH_MISMATCH'}
    Move-Item -LiteralPath $tmp -Destination $dst -Force
    $changed=$true
    if((Hash $dst) -ne $expected[$binding.name]){throw 'INSTALLED_HASH_MISMATCH'}
  }
  AssertMachineSafety
  # Canonical, previously installed Control Center launcher only.
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $launch -StartOnly
  if($LASTEXITCODE -ne 0){throw 'CONTROL_RESTART_FAILED'}
  $ready=$false
  for($i=0;$i -lt 20;$i++){
    try{
      $health=Invoke-WebRequest -Uri 'http://127.0.0.1:8781/healthz' -TimeoutSec 2 -UseBasicParsing
      if($health.StatusCode -eq 200 -and $health.Content -eq 'ok'){$ready=$true;break}
    }catch{}
    Start-Sleep -Milliseconds 250
  }
  if(!$ready){throw 'NEW_CONTROL_HEALTH_FAILED'}
  $detail=Invoke-RestMethod -Uri 'http://127.0.0.1:8781/api/robot/coordinator' -TimeoutSec 4
  if($detail.id -ne 'coordinator' -or $detail.control.mode -ne 'OWNER_STOPPED' -or
     $detail.control.business_dispatch_enabled -ne $false -or
     $detail.control.stop_allowed -ne $true){
    throw 'OWNER_CONTROL_READBACK_FAILED'
  }
  $newPort=@(Get-NetTCPConnection -LocalPort 8781 -State Listen)
  if($newPort.Count -ne 1 -or $newPort[0].LocalAddress -ne '127.0.0.1' -or
     $newPort[0].OwningProcess -eq $oldPid){throw 'CONTROL_RESTART_PROCESS_NOT_VERIFIED'}
  foreach($binding in $bindings){
    if((Hash $binding.dest) -ne $expected[$binding.name]){throw 'POST_RESTART_HASH_DRIFT'}
  }
  $receipt=[ordered]@{
    schema='MAGASIN_SC013_OWNER_CONTROL_APPLY_RESULT_V1'
    status='INSTALLED_OWNER_MONITOR_CONTROL_OFF'
    exact_main_sha=$sha
    checked_at=[datetimeoffset]::UtcNow.ToString('o')
    original_server_sha256=$expectedServerHash
    original_ui_sha256=$expectedWebHash
    installed_files=@($bindings|ForEach-Object {@{name=$_.name;sha256=$expected[$_.name]}})
    control_port='127.0.0.1:8781'
    restarted_only_control_center=$true
    owner_mode='OWNER_STOPPED'
    execution_enabled=$false
    business_dispatch_enabled=$false
    specialist_started=$false
    supervisor_started_or_stopped=$false
    windows_scheduler_modified=$false
    chatgpt_outbound=$false
  }
  $receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stage 'install-result.json') -Encoding UTF8
  Write-Host 'OWNER_READONLY_CONTROL_APPLY_PASS=True'
  Write-Host ('INSTALL_RECEIPT='+(Join-Path $stage 'install-result.json'))
  Write-Host 'BUSINESS_EXECUTION_QUALIFIED=False'
}
catch {
  # Roll back only these known files if their current hash is expected
  # (or already the original). Keep stage+failure evidence for Owner review.
  $rollbackSafe=$true
  try{
    $currentServer=if(Test-Path $liveServer){Hash $liveServer}else{''}
    $currentWeb=if(Test-Path $liveWeb){Hash $liveWeb}else{''}
    if($currentServer -in @($expectedServerHash,$expected['server.py'])){
      Copy-Item -LiteralPath (Join-Path $stage 'backup\server.py') -Destination $liveServer -Force
    }else{$rollbackSafe=$false}
    if($currentWeb -in @($expectedWebHash,$expected['app.js'])){
      Copy-Item -LiteralPath (Join-Path $stage 'backup\app.js') -Destination $liveWeb -Force
    }else{$rollbackSafe=$false}
    if((Test-Path $liveOwner) -and (Hash $liveOwner) -eq $expected['owner_lifecycle.py']){
      Remove-Item -LiteralPath $liveOwner -Force
    }elseif(Test-Path $liveOwner){$rollbackSafe=$false}
    if((Hash $liveServer) -ne $expectedServerHash -or (Hash $liveWeb) -ne $expectedWebHash){
      $rollbackSafe=$false
    }
    if($stopped -and !(Get-NetTCPConnection -LocalPort 8781 -State Listen -ErrorAction SilentlyContinue)){
      & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $launch -StartOnly
    }
  }catch{$rollbackSafe=$false}
  $failure=@{schema='MAGASIN_SC013_OWNER_CONTROL_APPLY_FAILURE_V1';
    exact_main_sha=$sha;rollback_safe=$rollbackSafe;business_dispatch_enabled=$false;
    chatgpt_outbound=$false;result='APPLY_FAILED_REVIEW_REQUIRED'}
  $failure|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $stage 'failure.json') -Encoding UTF8
  Write-Host ('OWNER_CONTROL_APPLY_ROLLBACK_SAFE='+$rollbackSafe)
  throw
}
finally{
  if($lock){$lock.Dispose()}
  if($ownsLock -and (Test-Path -LiteralPath $lockfile)){
    Remove-Item -LiteralPath $lockfile -Force -ErrorAction SilentlyContinue
  }
}
