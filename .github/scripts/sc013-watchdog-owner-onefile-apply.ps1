param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedMainSha,
  [Parameter(Mandatory=$true)][ValidateSet('SC013_WATCHDOG_ONLY_H4_OWNER_APPROVED_20261014')][string]$OwnerApproval
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
# One approved file, on the Owner's authorized H4 Admin session only.
# Does NOT restart or touch any daemon/service, STOP latches, SQLite or Gateway.
$ExpectedOld = 'f5d3e369448cf17436e157e42065d00239a00e905ae7437fdabbd84f812dea3f'
$ExpectedNew = '336343f013e530e693e15f9bb6a8464a1dfd6fe3b3b2ee7e03dbc617c900aa13'
$ExpectedBlob = 'bf02fd4d7276dc73e352a7ef19f3410c51abf14f'
if ([Environment]::MachineName -cne 'DESKTOP-H4A16IL') { throw 'WRONG_HOST' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'OWNER_ADMIN_TOKEN_REQUIRED'
}
$root = [Environment]::GetEnvironmentVariable('SUPERVISOR_STATE_ROOT','User')
if ([string]::IsNullOrWhiteSpace($root)) { throw 'CANONICAL_ROOT_MISSING' }
$root = [IO.Path]::GetFullPath($root)
$stop = Join-Path $root 'STOP'
$disabled = Join-Path $root 'AUTOSTART_DISABLED'
$live = Join-Path $root 'runtime\windows\local-watchdog.ps1'
$stage = Join-Path 'D:\MAGASIN_ROBOTS\deploy\sc013-watchdog-owner-20261014' $ExpectedMainSha
$candidate = Join-Path $stage 'candidate-local-watchdog.ps1'
$backup = Join-Path $stage 'backup-local-watchdog.ps1'
$manifest = Join-Path $stage 'manifest.json'
$lockPath = Join-Path $stage 'owner-apply.lock'
function Sha256([string]$path) {
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}
function Assert-Latches {
  if (-not (Test-Path -LiteralPath $stop -PathType Leaf) -or
      -not (Test-Path -LiteralPath $disabled -PathType Leaf)) {
    throw 'OWNER_STOP_LATCH_MISSING'
  }
}
function Assert-PlainFile([string]$path) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'FILE_IDENTITY_UNQUALIFIED'
  }
}
function Assert-Candidate {
  Assert-PlainFile $candidate
  Assert-PlainFile $backup
  Assert-PlainFile $live
  if ((Sha256 $candidate) -cne $ExpectedNew) { throw 'CANDIDATE_HASH_DRIFT' }
  if ((Sha256 $backup) -cne $ExpectedOld) { throw 'BACKUP_HASH_DRIFT' }
  if ((Sha256 $live) -cne $ExpectedOld) { throw 'LIVE_HASH_DRIFT' }
}
Assert-Latches
if (-not (Test-Path -LiteralPath $stage -PathType Container)) { throw 'REVIEWED_STAGE_MISSING' }
if ((Get-Item -LiteralPath $stage).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'STAGE_REPARSE'
}
$acl = Get-Acl -LiteralPath $stage
if (-not $acl.AreAccessRulesProtected) { throw 'STAGE_ACL_UNPROTECTED' }
$allowed = @($identity.User.Value,'S-1-5-18','S-1-5-32-544')
foreach ($ace in $acl.Access) {
  $sid = $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if ($sid -notin $allowed -or
      $ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
    throw 'UNQUALIFIED_STAGE_ACL'
  }
}
$record = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
if ($record.schema -cne 'SC013_WATCHDOG_H4_OWNER_STAGED_V1' -or
    $record.main_sha -cne $ExpectedMainSha -or
    $record.host -cne 'DESKTOP-H4A16IL' -or
    $record.source_blob -cne $ExpectedBlob -or
    $record.candidate_sha256 -cne $ExpectedNew -or
    $record.live_sha256_expected -cne $ExpectedOld -or
    $record.backup_sha256 -cne $ExpectedOld -or
    $record.field_applied -ne $false) {
  throw 'STAGING_MANIFEST_MISMATCH'
}
Assert-Candidate
# Parse the whole candidate without invoking its watchdog runtime loop.
$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  $candidate,[ref]$tokens,[ref]$parseErrors
) | Out-Null
if (@($parseErrors).Count -ne 0) { throw 'WATCHDOG_SOURCE_PARSE_FAILED' }
$lock = $null
$temp = $null
$replaceAttempted = $false
$replaced = $false
try {
  $lock = [IO.File]::Open($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  Assert-Latches
  Assert-Candidate
  $oldAcl = Get-Acl -LiteralPath $live
  $temp = Join-Path (Split-Path -Parent $live) ('local-watchdog.sc013-'+$ExpectedMainSha+'.tmp')
  if (Test-Path -LiteralPath $temp) { throw 'TEMP_PATH_ALREADY_EXISTS' }
  Copy-Item -LiteralPath $candidate -Destination $temp -ErrorAction Stop
  Set-Acl -LiteralPath $temp -AclObject $oldAcl -ErrorAction Stop
  if ((Sha256 $temp) -cne $ExpectedNew) { throw 'TEMP_FILE_HASH_MISMATCH' }
  Assert-Latches
  if ((Sha256 $live) -cne $ExpectedOld) { throw 'LIVE_CHANGED_BEFORE_REPLACE' }
  # This is the ONLY production file replacement.
  $replaceAttempted = $true
  Move-Item -LiteralPath $temp -Destination $live -Force -ErrorAction Stop
  $replaced = $true
  if ((Sha256 $live) -cne $ExpectedNew) { throw 'INSTALLED_DIGEST_MISMATCH' }
  Assert-Latches
  Write-Output ('SC013_WATCHDOG_SOURCE_INSTALLED_SHA256='+$ExpectedNew)
  Write-Output 'SUPERVISOR_RESTARTED=False'
  Write-Output 'WATCHDOG_RESTARTED=False'
  Write-Output 'WATCHDOG_RUNTIME_RELOAD_NOT_PROVEN=True'
  Write-Output 'OWNER_STOP_PRESERVED=True'
} catch {
  $originalError = $_
  if ($replaceAttempted) {
    # A Windows rename can replace the destination yet report failure.
    # Inspect the actual live digest regardless of whether Move-Item returned.
    if (-not (Test-Path -LiteralPath $live -PathType Leaf)) {
      throw 'ROLLBACK_HOLD_LIVE_FILE_MISSING'
    }
    $afterFailure = Sha256 $live
    if ($afterFailure -cne $ExpectedOld -and $afterFailure -cne $ExpectedNew) {
      throw 'ROLLBACK_HOLD_CONCURRENT_WRITER'
    }
    if ($afterFailure -ceq $ExpectedNew) {
      if ((Sha256 $backup) -cne $ExpectedOld) { throw 'ROLLBACK_BACKUP_DRIFT' }
      $rollbackTemp = Join-Path (Split-Path -Parent $live) ('local-watchdog.sc013-rollback-'+$ExpectedMainSha+'.tmp')
      if (Test-Path -LiteralPath $rollbackTemp) { throw 'ROLLBACK_TEMP_ALREADY_EXISTS' }
      Copy-Item -LiteralPath $backup -Destination $rollbackTemp -ErrorAction Stop
      Set-Acl -LiteralPath $rollbackTemp -AclObject $oldAcl -ErrorAction Stop
      if ((Sha256 $rollbackTemp) -cne $ExpectedOld) { throw 'ROLLBACK_TEMP_DIGEST_FAILED' }
      if ((Sha256 $live) -cne $ExpectedNew) { throw 'ROLLBACK_HOLD_CONCURRENT_WRITER' }
      Move-Item -LiteralPath $rollbackTemp -Destination $live -Force -ErrorAction Stop
      if ((Sha256 $live) -cne $ExpectedOld) { throw 'ROLLBACK_INTEGRITY_FAILED' }
      Write-Output 'WATCHDOG_ROLLBACK_VERIFIED=True'
    }
  }
  throw $originalError
} finally {
  if ($null -ne $temp -and (Test-Path -LiteralPath $temp)) {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $lock) {
    $lock.Dispose()
  }
}
