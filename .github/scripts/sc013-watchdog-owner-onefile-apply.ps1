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
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) {
      throw 'OWNER_STOP_LATCH_MISSING'
    }
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
function Assert-ApprovedMainBlob {
  # A remote main ref SHA is NOT evidence of the contents of its file tree.
  # Resolve exact canonical Watchdog blob inside a disposable D: bare Git repo.
  $proofDir = Join-Path $stage ('.git-main-attest-'+[guid]::NewGuid().ToString('N'))
  $previousPrompt = [Environment]::GetEnvironmentVariable('GIT_TERMINAL_PROMPT','Process')
  try {
    [Environment]::SetEnvironmentVariable('GIT_TERMINAL_PROMPT','0','Process')
    & git init --bare --quiet $proofDir 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'GIT_MAIN_PROOF_INIT_FAILED' }
    & git -c credential.interactive=never "--git-dir=$proofDir" fetch --quiet --depth=1 --no-tags $RepoUrl refs/heads/main 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'GIT_MAIN_PROOF_FETCH_FAILED' }
    $commits = @(& git "--git-dir=$proofDir" rev-parse 'FETCH_HEAD^{commit}' 2>$null)
    if ($LASTEXITCODE -ne 0 -or $commits.Count -ne 1 -or
        [string]$commits[0] -cne $ExpectedMainSha) {
      throw 'GIT_MAIN_PROOF_COMMIT_MISMATCH'
    }
    $tree = @(& git "--git-dir=$proofDir" ls-tree FETCH_HEAD -- windows/local-watchdog.ps1 2>$null)
    if ($LASTEXITCODE -ne 0 -or $tree.Count -ne 1) {
      throw 'GIT_MAIN_PROOF_WATCHDOG_PATH_MISSING'
    }
    $entry = [string]$tree[0]
    $matched = [regex]::Match($entry,'^100644 blob ([0-9a-f]{40})\s+windows/local-watchdog\.ps1$')
    if (-not $matched.Success -or $matched.Groups[1].Value -cne $ExpectedBlob) {
      throw 'GIT_MAIN_PROOF_WATCHDOG_BLOB_MISMATCH'
    }
  } finally {
    [Environment]::SetEnvironmentVariable('GIT_TERMINAL_PROMPT',$previousPrompt,'Process')
    if (Test-Path -LiteralPath $proofDir) {
      Remove-Item -LiteralPath $proofDir -Recurse -Force -ErrorAction Stop
    }
  }
}

function Assert-RequiredMainCiResponse($response,[string]$sha) {
  # GitHub's HTTPS/TLS authenticated Actions run state is the release receipt.
  # Require all four exact push-to-main workflow identities for THIS commit.
  if ($null -eq $response -or $null -eq $response.workflow_runs -or
      $response.total_count -ne @($response.workflow_runs).Count) {
    throw 'MAIN_CI_RECEIPT_INCOMPLETE'
  }
  $expected = @{
    '363535704'='.github/workflows/supervisor-tests.yml'
    '363535705'='.github/workflows/supervisor-integrity.yml'
    '363536127'='.github/workflows/supervisor-lifecycle-acceptance.yml'
    '363536125'='.github/workflows/supervisor-autostart-install.yml'
  }
  $seen = @{}
  foreach ($run in @($response.workflow_runs)) {
    if ($null -eq $run.workflow_id) { continue }
    $id = [string]$run.workflow_id
    if (-not $expected.ContainsKey($id)) { continue }
    if ($seen.ContainsKey($id)) { throw 'MAIN_CI_DUPLICATE_WORKFLOW' }
    $seen[$id] = $true
    if ($run.path -cne $expected[$id] -or
        $run.repository.full_name -cne 'magasincoffee/magasin-supervisor' -or
        $run.head_sha -cne $sha -or $run.head_branch -cne 'main' -or
        $run.event -cne 'push' -or $run.status -cne 'completed' -or
        $run.conclusion -cne 'success' -or
        [int64]$run.id -le 0 -or [int]$run.run_attempt -lt 1) {
      throw 'MAIN_CI_NOT_GREEN_EXACT_COMMIT'
    }
  }
  if ($seen.Count -ne $expected.Count) { throw 'MAIN_CI_REQUIRED_WORKFLOW_MISSING' }
}
function Assert-RequiredMainCi {
  # The H4 preflight confirmed the public GitHub Actions API is reachable.
  # Unavailable/untrusted network, pagination or any non-GREEN => HOLD.
  $uri='https://api.github.com/repos/magasincoffee/magasin-supervisor/actions/runs?head_sha='+$ExpectedMainSha+'&per_page=100'
  $headers=@{
    'Accept'='application/vnd.github+json'
    'User-Agent'='MAGASIN-SC013-Watchdog-Owner-Release'
  }
  $response=Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -TimeoutSec 15 -ErrorAction Stop
  Assert-RequiredMainCiResponse $response $ExpectedMainSha
}

function Read-LockedFile([IO.FileStream]$stream) {
  if ($stream.Length -gt 1048576) { throw 'WATCHDOG_FILE_SIZE_UNQUALIFIED' }
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
function Assert-PlausiblePartialWrite([byte[]]$observed,[byte[]]$before,[byte[]]$after) {
  # Exclusive Write() can only leave candidate prefix and old suffix.
  # Unrelated bytes are never overwritten during journal recovery.
  if ($observed.Length -lt $before.Length -or
      $observed.Length -gt $after.Length) { throw 'RECOVERY_HOLD_EXTERNAL_EDIT' }
  if ($observed.Length -gt $before.Length) {
    for ($i=0;$i -lt $observed.Length;$i++) {
      if ($observed[$i] -ne $after[$i]) { throw 'RECOVERY_HOLD_EXTERNAL_EDIT' }
    }
  } else {
    $newPrefix = 0
    while ($newPrefix -lt $observed.Length -and
           $observed[$newPrefix] -eq $after[$newPrefix]) { $newPrefix++ }
    $oldSuffixStart = $observed.Length
    while ($oldSuffixStart -gt 0 -and
           $observed[$oldSuffixStart-1] -eq $before[$oldSuffixStart-1]) {
      $oldSuffixStart--
    }
    if ($oldSuffixStart -gt $newPrefix) { throw 'RECOVERY_HOLD_EXTERNAL_EDIT' }
  }
}
function Write-DurableReceipt([string]$file,[hashtable]$data) {
  # Flush a complete staging receipt to disk, then publish via atomic
  # same-directory rename; a crashed partial .pending file cannot block Recover.
  if (Test-Path -LiteralPath $file) { throw 'RECEIPT_ALREADY_EXISTS' }
  $json = $data | ConvertTo-Json -Compress -Depth 5
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $temporary = $file + '.pending.' + [guid]::NewGuid().ToString('N')
  $handle = $null
  try {
    $handle = [IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $handle.Write($bytes,0,$bytes.Length)
    $handle.Flush($true)
    $handle.Dispose()
    $handle = $null
    if (Test-Path -LiteralPath $file) { throw 'RECEIPT_ALREADY_EXISTS' }
    [IO.File]::Move($temporary,$file)
  } finally {
    if ($null -ne $handle) { $handle.Dispose() }
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
  }
}

function Assert-LiveFileHandle([IO.FileStream]$stream) {
  # Inspect the opened HANDLE, not only a pathname checked before the open.
  # Reject substituted symbolic links / junctions and hardlinked live files.
  $info = New-Object SC013WatchdogFileIdentity+BY_HANDLE_FILE_INFORMATION
  if (-not [SC013WatchdogFileIdentity]::GetFileInformationByHandle(
      $stream.SafeFileHandle,[ref]$info)) {
    throw 'WATCHDOG_HANDLE_IDENTITY_UNAVAILABLE'
  }
  if ($info.NumberOfLinks -ne 1 -or
      ($info.FileAttributes -band 0x400) -ne 0) {
    throw 'WATCHDOG_HANDLE_REPARSE_OR_HARDLINK'
  }
  $buffer = New-Object System.Text.StringBuilder 1024
  $n = [SC013WatchdogFileIdentity]::GetFinalPathNameByHandle(
    $stream.SafeFileHandle,$buffer,[uint32]$buffer.Capacity,[uint32]0
  )
  if ($n -eq 0 -or $n -ge [uint32]$buffer.Capacity) {
    throw 'WATCHDOG_HANDLE_CANONICAL_PATH_UNAVAILABLE'
  }
  $actual = $buffer.ToString()
  $expected = '\\?\' + $live
  if (-not [string]::Equals($actual,$expected,
      [StringComparison]::OrdinalIgnoreCase)) {
    throw 'WATCHDOG_HANDLE_TARGET_MISMATCH'
  }
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
# Windows hosted parser and fixture validate this narrow OS handle identity helper.
# Add-Type cannot start Supervisor or modify files; any API failure HOLDS apply.
if (-not ([System.Management.Automation.PSTypeName]'SC013WatchdogFileIdentity').Type) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
public static class SC013WatchdogFileIdentity {
  [StructLayout(LayoutKind.Sequential)]
  public struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetFileInformationByHandle(
    SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION information);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern uint GetFinalPathNameByHandle(
    SafeFileHandle handle, StringBuilder path, uint capacity, uint flags);
}
'@ -ErrorAction Stop
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
if ($Mode -eq 'Apply') {
  Assert-LiveMain
  Assert-ApprovedMainBlob
  Assert-RequiredMainCi
}
$stageLock = $null
$liveHandle = $null
try {
  # Only cooperative apply agents are serialized by this durable D: lock.
  # The live file itself is guarded against any non-cooperative writer via
  # FileShare.None and verification through THE SAME open handle.
  $stageLock = [IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  Assert-NoReparseDirs
  Assert-Stop
  if ($Mode -eq 'Apply') {
    Assert-LiveMain
    Assert-RequiredMainCi
  }
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
  Assert-LiveFileHandle $liveHandle
  $bytesBefore = Read-LockedFile $liveHandle
  $digestBefore = Hash-Bytes $bytesBefore
  if ($Mode -eq 'Apply' -and $digestBefore -cne $ExpectedOld) {
    throw 'EXCLUSIVE_LIVE_HASH_CHANGED'
  }
  if ($Mode -eq 'Recover' -and $digestBefore -cne $ExpectedOld -and
      $digestBefore -cne $ExpectedNew) {
    Assert-PlausiblePartialWrite $bytesBefore $backupBytes $sourceBytes
  }
  Assert-Stop
  if ($Mode -eq 'Apply') {
    Assert-LiveMain
    Assert-RequiredMainCi
  }
  if ($Mode -eq 'Apply') {
    Write-DurableReceipt $transaction @{
      schema='SC013_WATCHDOG_EXCLUSIVE_FILE_TRANSACTION_V1'
      phase='APPLY_STARTED';expected_main_sha=$ExpectedMainSha
      owner_sid=$ExpectedOwnerSid;old_sha256=$ExpectedOld;new_sha256=$ExpectedNew
      created_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    }
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
  if ($Mode -eq 'Apply') {
    Assert-LiveMain
    Assert-RequiredMainCi
  }
  Write-DurableReceipt $receipt @{
    schema='SC013_WATCHDOG_EXCLUSIVE_FILE_RESULT_V1';mode=$Mode
    expected_main_sha=$ExpectedMainSha;owner_sid=$ExpectedOwnerSid
    live_sha256=if ($Mode -eq 'Apply') { $ExpectedNew } else { $ExpectedOld }
    verified_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    watchdog_runtime_reloaded=$false;stop_preserved=$true
  }
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
    # Preserve reusable lock file; exclusivity belongs to its open OS handle.
  }
}
