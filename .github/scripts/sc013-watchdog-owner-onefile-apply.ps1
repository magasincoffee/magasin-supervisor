param(
  [Parameter(Mandatory=$true)][ValidateSet('Apply','Recover')][string]$Mode,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedMainSha,
  [Parameter(Mandatory=$true)][ValidateSet('SC013_WATCHDOG_ONLY_H4_OWNER_APPROVED_20261014')][string]$OwnerApproval
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
# Never start/restart any worker or watchdog process. Only the one authorized
# live Watchdog file can be edited; all evidence/journals are on protected D:.
$ExpectedHost = 'DESKTOP-H4A16IL'
$ExpectedOwner = 'DESKTOP-H4A16IL\admin'
$ExpectedOwnerSid = 'S-1-5-21-604228481-1555572614-3695427994-1001'
$CanonicalRoot = 'C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor'
$ExpectedOld = 'f5d3e369448cf17436e157e42065d00239a00e905ae7437fdabbd84f812dea3f'
$ExpectedNew = '336343f013e530e693e15f9bb6a8464a1dfd6fe3b3b2ee7e03dbc617c900aa13'
$ExpectedBlob = 'bf02fd4d7276dc73e352a7ef19f3410c51abf14f'
$RepoUrl = 'https://github.com/magasincoffee/magasin-supervisor.git'

function Hash-Bytes([byte[]]$bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function FileHash([string]$path) {
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}
function Assert-Plain([string]$path) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'NONCANONICAL_FILE'
  }
}
function Assert-NoReparseDirs {
  # Match approved H4 path, including all ancestors, not an environment-only root.
  foreach ($path in @('C:\','C:\Users','C:\Users\admin','C:\Users\admin\AppData',
    'C:\Users\admin\AppData\Local','C:\Users\admin\AppData\Local\MAGASIN',
    'C:\Users\admin\AppData\Local\MAGASIN\BusinessOS',$CanonicalRoot,
    (Join-Path $CanonicalRoot 'runtime'),(Join-Path $CanonicalRoot 'runtime\windows'),
    'D:\','D:\MAGASIN_ROBOTS','D:\MAGASIN_ROBOTS\deploy',
    'D:\MAGASIN_ROBOTS\deploy\sc013-watchdog-owner-20261014',$stage)) {
    $dir = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (-not $dir.PSIsContainer -or ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'RUNTIME_OR_STAGE_ANCESTOR_REDIRECTED'
    }
  }
}
function Assert-Stop {
  foreach ($flag in @('STOP','AUTOSTART_DISABLED')) {
    $p = Join-Path $CanonicalRoot $flag
    Assert-Plain $p
  }
}
function Assert-LiveMain {
  $oldPrompt = [Environment]::GetEnvironmentVariable('GIT_TERMINAL_PROMPT','Process')
  try {
    [Environment]::SetEnvironmentVariable('GIT_TERMINAL_PROMPT','0','Process')
    $lines = @(& git -c credential.interactive=never ls-remote $RepoUrl refs/heads/main 2>$null)
    if ($LASTEXITCODE -ne 0 -or $lines.Count -ne 1) { throw 'LIVE_MAIN_UNAVAILABLE' }
    $parts = [string]$lines[0] -split '\s+'
    if ($parts.Count -ne 2 -or $parts[1] -cne 'refs/heads/main' -or
        $parts[0] -cne $ExpectedMainSha) { throw 'LIVE_MAIN_NOT_PINNED' }
  } finally {
    [Environment]::SetEnvironmentVariable('GIT_TERMINAL_PROMPT',$oldPrompt,'Process')
  }
}
function Read-LockedFile([IO.FileStream]$stream) {
  if ($stream.Length -gt 1048576 -or $stream.Length -lt 1) { throw 'WATCHDOG_FILE_SIZE_UNQUALIFIED' }
  $stream.Position = 0
  $buf = New-Object byte[] ([int]$stream.Length)
  $offset = 0
  while ($offset -lt $buf.Length) {
    $count = $stream.Read($buf,$offset,$buf.Length-$offset)
    if ($count -le 0) { throw 'LOCKED_READ_INCOMPLETE' }
    $offset += $count
  }
  return ,$buf
}
function Write-LockedFile([IO.FileStream]$stream,[byte[]]$bytes) {
  $stream.Position = 0
  $stream.Write($bytes,0,$bytes.Length)
  $stream.SetLength($bytes.Length)
  $stream.Flush($true)
}
function Write-DurableReceipt([string]$file,[hashtable]$data) {
  # Exclusive CreateNew + disk flush; journal must exist before the first live write.
  $json = $data | ConvertTo-Json -Compress -Depth 5
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $handle = [IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $handle.Write($bytes,0,$bytes.Length);$handle.Flush($true) }
  finally { $handle.Dispose() }
}

if ([Environment]::MachineName -cne $ExpectedHost) { throw 'WRONG_HOST' }
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'OWNER_ADMIN_TOKEN_REQUIRED'
}
if ($id.Name -cne $ExpectedOwner -or $id.User.Value -cne $ExpectedOwnerSid) {
  throw 'OWNER_IDENTITY_MISMATCH'
}
$root = [Environment]::GetEnvironmentVariable('SUPERVISOR_STATE_ROOT','User')
if ([string]::IsNullOrWhiteSpace($root) -or
    [IO.Path]::GetFullPath($root).TrimEnd('\') -cne $CanonicalRoot) {
  throw 'CANONICAL_SUPERVISOR_ROOT_MISMATCH'
}
$live = Join-Path $CanonicalRoot 'runtime\windows\local-watchdog.ps1'
$stage = Join-Path 'D:\MAGASIN_ROBOTS\deploy\sc013-watchdog-owner-20261014' $ExpectedMainSha
$candidate = Join-Path $stage 'candidate-local-watchdog.ps1'
$backup = Join-Path $stage 'backup-local-watchdog.ps1'
$manifest = Join-Path $stage 'manifest.json'
$transaction = Join-Path $stage 'watchdog-apply-transaction.json'
$receipt = Join-Path $stage 'watchdog-apply-result.json'
$lockPath = Join-Path $stage 'owner-apply.lock'
Assert-NoReparseDirs
Assert-Stop
foreach ($file in @($live,$candidate,$backup,$manifest)) { Assert-Plain $file }
$stageAcl = Get-Acl -LiteralPath $stage
if (-not $stageAcl.AreAccessRulesProtected -or
    $stageAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $ExpectedOwnerSid) {
  throw 'STAGE_OWNER_OR_ACL_MISMATCH'
}
$allowed = @($ExpectedOwnerSid,'S-1-5-18','S-1-5-32-544')
foreach ($ace in $stageAcl.Access) {
  $sid = $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if ($sid -notin $allowed -or
      $ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
    throw 'STAGE_ACL_HAS_UNAPPROVED_ENTRY'
  }
}
$record = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
if ($record.schema -cne 'SC013_WATCHDOG_H4_OWNER_STAGED_V1' -or
    $record.main_sha -cne $ExpectedMainSha -or
    $record.host -cne $ExpectedHost -or
    $record.owner_sid -cne $ExpectedOwnerSid -or
    $record.source_blob -cne $ExpectedBlob -or
    $record.candidate_sha256 -cne $ExpectedNew -or
    $record.live_sha256_expected -cne $ExpectedOld -or
    $record.backup_sha256 -cne $ExpectedOld -or
    $record.field_applied -ne $false) { throw 'STAGED_MANIFEST_MISMATCH' }
$sourceBytes = [IO.File]::ReadAllBytes($candidate)
$backupBytes = [IO.File]::ReadAllBytes($backup)
if ((Hash-Bytes $sourceBytes) -cne $ExpectedNew -or
    (Hash-Bytes $backupBytes) -cne $ExpectedOld) { throw 'STAGE_DIGEST_DRIFT' }
$tokens = $null;$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  $candidate,[ref]$tokens,[ref]$parseErrors
) | Out-Null
if (@($parseErrors).Count -ne 0) { throw 'WATCHDOG_PARSE_FAILED' }
Assert-LiveMain
$stageLock = $null
$liveHandle = $null
$journalCreated = $false
$success = $false
try {
  # Only cooperative apply agents are serialized by this durable D: lock.
  # The live file itself is guarded against any non-cooperative writer via
  # FileShare.None and verification through THE SAME open handle.
  $stageLock = [IO.File]::Open($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  Assert-NoReparseDirs
  Assert-Stop
  Assert-LiveMain
  if ($Mode -eq 'Apply') {
    if (Test-Path -LiteralPath $transaction) { throw 'INTERRUPTED_TRANSACTION_REQUIRES_RECOVER' }
    if (Test-Path -LiteralPath $receipt) { throw 'INSTALL_ALREADY_RECORDED' }
  } else {
    if (-not (Test-Path -LiteralPath $transaction -PathType Leaf) -or
        (Test-Path -LiteralPath $receipt)) { throw 'NO_INTERRUPTED_TRANSACTION' }
    $pending = Get-Content -LiteralPath $transaction -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pending.schema -cne 'SC013_WATCHDOG_EXCLUSIVE_FILE_TRANSACTION_V1' -or
        $pending.expected_main_sha -cne $ExpectedMainSha -or
        $pending.owner_sid -cne $ExpectedOwnerSid -or
        $pending.old_sha256 -cne $ExpectedOld -or
        $pending.new_sha256 -cne $ExpectedNew -or
        $pending.phase -cne 'APPLY_STARTED') { throw 'UNQUALIFIED_RECOVERY_JOURNAL' }
  }
  $liveHandle = [IO.File]::Open($live,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $bytesBefore = Read-LockedFile $liveHandle
  $digestBefore = Hash-Bytes $bytesBefore
  if ($Mode -eq 'Apply' -and $digestBefore -cne $ExpectedOld) {
    throw 'EXCLUSIVE_LIVE_HASH_CHANGED'
  }
  if ($Mode -eq 'Recover' -and $digestBefore -cne $ExpectedOld -and
      $digestBefore -cne $ExpectedNew) {
    # A partial interrupted write is permitted only under the approved
    # journal and the exclusive file lock; recover to the pinned old backup.
    if ($liveHandle.Length -gt 1048576) { throw 'RECOVERY_FILE_TOO_LARGE' }
  }
  Assert-Stop
  Assert-LiveMain
  if ($Mode -eq 'Apply') {
    Write-DurableReceipt $transaction @{
      schema='SC013_WATCHDOG_EXCLUSIVE_FILE_TRANSACTION_V1'
      phase='APPLY_STARTED';expected_main_sha=$ExpectedMainSha
      owner_sid=$ExpectedOwnerSid;old_sha256=$ExpectedOld;new_sha256=$ExpectedNew
      created_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    }
    $journalCreated = $true
    # No check/write race: the live file cannot be written by another normal
    # Windows file opener while FileShare.None is held.
    Write-LockedFile $liveHandle $sourceBytes
    if ((Hash-Bytes (Read-LockedFile $liveHandle)) -cne $ExpectedNew) {
      throw 'POSTWRITE_DIGEST_MISMATCH'
    }
  } else {
    if ($digestBefore -cne $ExpectedOld) {
      Write-LockedFile $liveHandle $backupBytes
    }
    if ((Hash-Bytes (Read-LockedFile $liveHandle)) -cne $ExpectedOld) {
      throw 'RECOVERY_DIGEST_MISMATCH'
    }
  }
  Assert-Stop
  Assert-LiveMain
  Write-DurableReceipt $receipt @{
    schema='SC013_WATCHDOG_EXCLUSIVE_FILE_RESULT_V1';mode=$Mode
    expected_main_sha=$ExpectedMainSha;owner_sid=$ExpectedOwnerSid
    live_sha256=if ($Mode -eq 'Apply') { $ExpectedNew } else { $ExpectedOld }
    verified_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    watchdog_runtime_reloaded=$false;stop_preserved=$true
  }
  $success = $true
  if ($Mode -eq 'Apply') {
    Write-Output ('SC013_WATCHDOG_SOURCE_INSTALLED_SHA256='+$ExpectedNew)
    Write-Output 'WATCHDOG_RUNTIME_RELOAD_NOT_PROVEN=True'
  } else {
    Write-Output ('SC013_WATCHDOG_SOURCE_RECOVERED_SHA256='+$ExpectedOld)
  }
  Write-Output 'OWNER_STOP_PRESERVED=True'
  Write-Output 'SUPERVISOR_RESTARTED=False'
  Write-Output 'WATCHDOG_RESTARTED=False'
} catch {
  # The durable APPLY_STARTED receipt must remain for explicit bounded Recover
  # if a crash/write/error occurs. Never mislabel a partial write as INSTALLED.
  throw
} finally {
  if ($null -ne $liveHandle) { $liveHandle.Dispose() }
  if ($null -ne $stageLock) {
    $stageLock.Dispose()
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  }
}
