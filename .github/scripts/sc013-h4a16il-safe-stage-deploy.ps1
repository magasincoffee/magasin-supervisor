param(
  [Parameter(Mandatory=$true)][ValidateSet('Stage','Apply')][string]$Mode,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$ExpectedMainSha
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

# Only the Owner-authorized Supervisor workstation. No 4K production path.
if([Environment]::MachineName -ne 'DESKTOP-H4A16IL'){
  Write-Host 'TARGET_MUTATION_SKIPPED=True'
  throw 'WRONG_TARGET_MACHINE'
}
$workspace=[string]$env:GITHUB_WORKSPACE
if([string]::IsNullOrWhiteSpace($workspace) -or -not (Test-Path (Join-Path $workspace '.git'))){
  throw 'GITHUB_CHECKOUT_REQUIRED'
}
$sha=(git -C $workspace rev-parse HEAD).Trim().ToLowerInvariant()
$expected=$ExpectedMainSha.ToLowerInvariant()
if($sha -ne $expected){throw 'CHECKOUT_SHA_MISMATCH'}
$head=(git -C $workspace ls-remote origin refs/heads/main)
if($LASTEXITCODE -ne 0 -or -not $head){throw 'MAIN_AUTHORITY_NOT_VERIFIED'}
$remoteSha=($head -split '\s+')[0].ToLowerInvariant()
if($remoteSha -ne $expected){throw 'MAIN_SHA_CHANGED_REDISPATCH_REQUIRED'}
Write-Host "TARGET_MATCH=True"
Write-Host "EXACT_MAIN_SHA=$sha"

$runtime='C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor\runtime'
$root='C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor'
$staging=Join-Path 'D:\MAGASIN_ROBOTS\deploy\sc013-h4a16il' $sha
$manifest=Join-Path $staging 'manifest.json'
$sourceRoot=Join-Path $workspace 'src'
$liveSrc=Join-Path $runtime 'src'
$cliRelative='runtime\single-conversation-cli.mjs'
if(!(Test-Path (Join-Path $root 'single-conversation-control.json')) -or
   !(Test-Path (Join-Path $root 'single-conversation-state.json')) -or
   !(Test-Path $sourceRoot) -or !(Test-Path $liveSrc)){
  throw 'CANONICAL_RUNTIME_OR_STATE_MISSING'
}
$control=Get-Content (Join-Path $root 'single-conversation-control.json') -Raw | ConvertFrom-Json
if([string]$control.mode -ne 'SINGLE_CONVERSATION_V1' -or
   [string]::IsNullOrWhiteSpace([string]$control.source_of_truth_url)){
  throw 'SOT_AUTHORITY_UNVERIFIED'
}
$state=Get-Content (Join-Path $root 'single-conversation-state.json') -Raw | ConvertFrom-Json
function Hash([string]$Path){
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function NormalizeLineEndings([string]$Path){
  # Whitelist presentation-only differences: CRLF versus LF, and terminal
  # CR/LF bytes. Do NOT trim spaces, alter Unicode or normalize JS semantics.
  $value=[System.IO.File]::ReadAllText($Path,[System.Text.Encoding]::UTF8)
  return $value.Replace("`r`n","`n").TrimEnd([char[]]@([char]13,[char]10))
}
function RunningWrapper {
  $matches=@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop |
    Where-Object {$_.CommandLine -and $_.CommandLine -like '*run-supervisor.ps1*' -and
                   $_.CommandLine -like '*MAGASIN*'})
  return $matches.Count -gt 0
}

if($Mode -eq 'Stage'){
  $source=@(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Filter '*.mjs')
  if($source.Count -lt 70){throw 'SOURCE_MODULE_SET_INCOMPLETE'}
  $diff=@()
  $formatOnly=@()
  foreach($f in $source){
    $relative=$f.FullName.Substring($sourceRoot.Length+1)
    $live=Join-Path $liveSrc $relative
    if(!(Test-Path $live)){throw "LOCAL_MODULE_MISSING:$relative"}
    $wanted=Hash $f.FullName
    $current=Hash $live
    if($wanted -ne $current){
      if((NormalizeLineEndings $f.FullName) -ceq (NormalizeLineEndings $live)){
        $formatOnly+=@{path=$relative;old_sha256=$current;new_sha256=$wanted}
      } else {
        $diff+=@{path=$relative;old_sha256=$current;new_sha256=$wanted}
      }
    }
  }
  Write-Host ('FORMAT_ONLY_MODULES='+($formatOnly.path -join ','))
  # Refuse to replace arbitrary divergent local work. Only the already-reviewed
  # and tested CLI hydration patch can be staged in this maintenance window.
  if($diff.Count -ne 1 -or $diff[0].path -ne $cliRelative){
    Write-Host ('DIFFERING_MODULES='+($diff.path -join ','))
    throw 'LOCAL_SOURCE_DRIFT_REQUIRES_REVIEW'
  }
  if((Get-PSDrive D).Free -lt 2GB){throw 'D_BACKUP_SPACE_INSUFFICIENT'}
  New-Item -ItemType Directory -Force -Path (Join-Path $staging 'candidate')|Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $staging 'backup')|Out-Null
  $candidate=Join-Path $staging 'candidate\single-conversation-cli.mjs'
  $backup=Join-Path $staging 'backup\single-conversation-cli.mjs'
  Copy-Item -LiteralPath (Join-Path $sourceRoot $cliRelative) -Destination $candidate -Force
  Copy-Item -LiteralPath (Join-Path $liveSrc $cliRelative) -Destination $backup -Force
  if((Hash $candidate) -ne $diff[0].new_sha256 -or
     (Hash $backup) -ne $diff[0].old_sha256){throw 'STAGE_COPY_HASH_MISMATCH'}
  & node --check $candidate
  if($LASTEXITCODE -ne 0){throw 'STAGED_NODE_SYNTAX_FAILED'}
  $record=[ordered]@{
    schema='MAGASIN_H4A16IL_DEPLOY_STAGE_V1'
    expected_main_sha=$sha
    target='DESKTOP-H4A16IL'
    created_at=(Get-Date -Format o)
    source_module_count=$source.Count
    format_only_modules=$formatOnly
    mode='STAGED_ONLY'
    changed_path=$cliRelative
    old_sha256=$diff[0].old_sha256
    new_sha256=$diff[0].new_sha256
    outbound_state=([string]$state.outbound.state)
    install_verified=$false
    no_robot_restart=$true
  }
  $record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifest -Encoding UTF8
  Write-Host 'STAGE_VALIDATED=True'
  Write-Host 'STAGE_NO_PRODUCTION_MUTATION=True'
  Write-Host "STAGE_MANIFEST=$manifest"
  exit 0
}

# Apply is a separate explicit workflow_dispatch; an ordinary source merge,
# stage request, scheduled tick or non-target job can never enter this branch.
if($env:GITHUB_EVENT_NAME -ne 'workflow_dispatch'){throw 'APPLY_EXPLICIT_DISPATCH_REQUIRED'}
if(!(Test-Path $manifest)){throw 'STAGING_MANIFEST_MISSING'}
$record=Get-Content $manifest -Raw | ConvertFrom-Json
if($record.schema -ne 'MAGASIN_H4A16IL_DEPLOY_STAGE_V1' -or
   $record.expected_main_sha -ne $sha -or
   $record.target -ne 'DESKTOP-H4A16IL' -or
   $record.changed_path -ne $cliRelative -or $record.install_verified){
  throw 'STAGED_MANIFEST_NOT_QUALIFIED'
}
# Re-validate every format-only local source at APPLY; semantic changes
# after the stage invalidate its authorization.
foreach($entry in @($record.format_only_modules)){
  $existing=Join-Path $liveSrc ([string]$entry.path)
  $canonical=Join-Path $sourceRoot ([string]$entry.path)
  if(!(Test-Path $existing) -or !(Test-Path $canonical) -or
     (Hash $existing) -ne [string]$entry.old_sha256 -or
     (Hash $canonical) -ne [string]$entry.new_sha256 -or
     (NormalizeLineEndings $existing) -cne (NormalizeLineEndings $canonical)){
    throw 'FORMAT_ONLY_SOURCE_CHANGED_AFTER_STAGE'
  }
}
$live=Join-Path $liveSrc $cliRelative
$candidate=Join-Path $staging 'candidate\single-conversation-cli.mjs'
$backup=Join-Path $staging 'backup\single-conversation-cli.mjs'
if((Hash $candidate) -ne $record.new_sha256 -or
   (Hash $backup) -ne $record.old_sha256 -or
   (Hash $live) -ne $record.old_sha256){throw 'LOCAL_RUNTIME_CHANGED_AFTER_STAGE'}
if(Test-Path (Join-Path $root 'STOP')){throw 'OWNER_STOP_LATCH_ACTIVE'}
if(Test-Path (Join-Path $root 'AUTOSTART_DISABLED')){throw 'OWNER_DISABLE_LATCH_ACTIVE'}
if(RunningWrapper){throw 'WRAPPER_MUST_BE_STOPPED_FOR_DEPLOY'}
if([string]$state.outbound.state -in @('PREPARED','ENQUEUED','DELIVERED','RESPONSE_RUNNING','UNKNOWN')){
  throw 'AMBIGUOUS_OUTBOUND_MUST_BE_RECONCILED_FIRST'
}
$ramFree=(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB
$cFree=(Get-PSDrive C).Free / 1GB
if($ramFree -lt 0.9 -or $cFree -lt 1.0){throw 'RESOURCE_GATES_NOT_GREEN'}
$tmp="$live.sc013-$sha.tmp"
try{
  Copy-Item -LiteralPath $candidate -Destination $tmp -Force
  if((Hash $tmp) -ne $record.new_sha256){throw 'TEMP_FILE_HASH_MISMATCH'}
  Move-Item -LiteralPath $tmp -Destination $live -Force
  if((Hash $live) -ne $record.new_sha256){throw 'INSTALL_HASH_MISMATCH'}
  $record.mode='APPLIED_SOURCE_ONLY'
  $record.install_verified=$true
  $record.applied_at=(Get-Date -Format o)
  $record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifest -Encoding UTF8
  Write-Host 'SOURCE_APPLY_VERIFIED=True'
  Write-Host 'NO_SUPERVISOR_START=True'
  Write-Host 'NO_CHROME_RESTART=True'
} catch {
  # Never erase the D: rollback source. An interrupted replacement
  # is restored only when the backup is verified.
  if((Hash $backup) -eq $record.old_sha256){
    Copy-Item -LiteralPath $backup -Destination $live -Force
    Write-Host ('ROLLBACK_VERIFIED='+((Hash $live) -eq $record.old_sha256))
  }
  throw
} finally {
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}
