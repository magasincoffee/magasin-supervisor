$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
# Hosted Windows ONLY. Evaluate isolated functions, never invoke the full H4
# installer, production path, GitHub remote or any Supervisor/SQLite process.
$script=Join-Path $PSScriptRoot '..\.github\scripts\sc013-watchdog-owner-onefile-apply.ps1'
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($script,[ref]$tokens,[ref]$errors)
if (@($errors).Count -ne 0) { throw 'OWNER_INSTALL_POWERSHELL_PARSE_FAILED' }
foreach ($name in @('Hash-Bytes','Read-LockedFile','Write-LockedFile','Write-DurableReceipt','Assert-PlausiblePartialWrite','Assert-LiveFileHandle','Restore-AfterFailedApply','Assert-RequiredMainCiResponse','Assert-PlausibleReversePartialWrite','Assert-QualifiedRecoveryWrite')) {
  $matches=@($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }.GetNewClosure(),$true))
  if ($matches.Count -ne 1) { throw ('ISOLATED_HELPER_MISSING_'+$name) }
  . ([scriptblock]::Create($matches[0].Extent.Text))
}
# Extract only the reviewed guarded Add-Type block from the PS AST, and run
# it twice within ONE Windows PowerShell process. Never invoke H4 installer top-level.
$source = Get-Content -LiteralPath $script -Raw -Encoding UTF8
$native = [regex]::Match($source, "(?s)if \(-not \(\[System\.Management\.Automation\.PSTypeName\]'SC013WatchdogFileIdentity'\)\.Type\) \{\s*Add-Type -TypeDefinition @'\r?\n.*?\r?\n'@ -ErrorAction Stop\s*\}")
if (-not $native.Success) { throw 'GUARDED_NATIVE_HANDLE_HELPER_NOT_FOUND' }
$guard = [scriptblock]::Create($native.Value)
& $guard
& $guard
if (-not ([System.Management.Automation.PSTypeName]'SC013WatchdogFileIdentity').Type) {
  throw 'SAME_SESSION_NATIVE_IDENTITY_TYPE_REUSE_FAILED'
}

$tempRoot=Join-Path $env:RUNNER_TEMP ('sc013-watchdog-onefile-fixture-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot -ErrorAction Stop|Out-Null
try {
  $target=Join-Path $tempRoot 'fake-watchdog.txt'
  $journal=Join-Path $tempRoot 'fake-transaction.json'
  $old=[Text.Encoding]::UTF8.GetBytes('old source - fixture only')
  $next=[Text.Encoding]::UTF8.GetBytes('replacement - fixture only')
  [IO.File]::WriteAllBytes($target,$old)
  $stream=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try {
    $before=Hash-Bytes (Read-LockedFile $stream)
    if ($before -cne (Hash-Bytes $old)) { throw 'EXCLUSIVE_READ_WRONG_SOURCE' }
    # A competing opener MUST fail, with no possible check/write race.
    $blocked=$false
    try {
      $other=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
      $other.Dispose()
    } catch [System.IO.IOException] { $blocked=$true }
    if (-not $blocked) { throw 'CONCURRENT_WRITER_WAS_ALLOWED' }
    Write-DurableReceipt $journal @{
      schema='SC013_WATCHDOG_EXCLUSIVE_FILE_TRANSACTION_V1';phase='APPLY_STARTED'
    }
    if (!(Test-Path -LiteralPath $journal -PathType Leaf)) { throw 'JOURNAL_NOT_WRITTEN' }
    Write-LockedFile $stream $next
    if ((Hash-Bytes (Read-LockedFile $stream)) -cne (Hash-Bytes $next)) {
      throw 'EXCLUSIVE_WRITE_DIGEST_WRONG'
    }
  } finally { $stream.Dispose() }
  # Simulate a killed process after write, journal still APPLY_STARTED:
  # a fresh exclusive handle must be able to restore from backed-up bytes.
  $recover=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try {
    if ((Hash-Bytes (Read-LockedFile $recover)) -cne (Hash-Bytes $next)) {
      throw 'INTERRUPTED_NEW_HASH_MISSING'
    }
    Write-LockedFile $recover $old
    if ((Hash-Bytes (Read-LockedFile $recover)) -cne (Hash-Bytes $old)) {
      throw 'RECOVERY_BACKUP_DIGEST_MISSING'
    }
  } finally { $recover.Dispose() }
  # Prove actual opened handle identity, not merely a checked pathname.
  $live = $target
  $check = [IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try {
    Assert-LiveFileHandle $check
    $live = Join-Path $tempRoot 'another-file.txt'
    $rejected = $false
    try { Assert-LiveFileHandle $check } catch { $rejected = $true }
    if (-not $rejected) { throw 'DIFFERENT_HANDLE_TARGET_ACCEPTED' }
  } finally { $check.Dispose() }
  $live = $target
  # Windows hard links share the same content/identity; they must be excluded.
  $hardlink = Join-Path $tempRoot 'extra-hardlink.txt'
  $out = & cmd.exe /d /c ('mklink /H "' + $hardlink + '" "' + $target + '"') 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'HARDLINK_FIXTURE_SETUP_FAILED' }
  $h = [IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try {
    $rejectLink = $false
    try { Assert-LiveFileHandle $h } catch { $rejectLink = $true }
    if (-not $rejectLink) { throw 'HARDLINKED_HANDLE_ACCEPTED' }
  } finally { $h.Dispose() }
  # Verified partial state is candidate prefix + original suffix only.
  $oldBytes = [Text.Encoding]::UTF8.GetBytes('abcdef01234567890')
  $newBytes = [Text.Encoding]::UTF8.GetBytes('QRSTUVZ9876543210LONG')
  $partial = [byte[]]$oldBytes.Clone()
  [Array]::Copy($newBytes,0,$partial,0,6)
  Assert-PlausiblePartialWrite $partial $oldBytes $newBytes
  $partial[9]=[byte][char]'!'
  $held=$false
  try { Assert-PlausiblePartialWrite $partial $oldBytes $newBytes } catch { $held=$true }
  if (-not $held) { throw 'UNKNOWN_RECOVERY_BYTES_ACCEPTED' }

  # Crash halfway through the reverse auto-rollback:
  # OLD prefix + CANDIDATE suffix is attributable to this journal and MUST
  # be recoverable. Never admit foreign changes or a zero old-byte prefix.
  $oldReverse=[Text.Encoding]::UTF8.GetBytes('abcdef01234567890')
  $newReverse=[Text.Encoding]::UTF8.GetBytes('QRSTUVZ9876543210LONG')
  $midReverse=[byte[]]$newReverse.Clone()
  [Array]::Copy($oldReverse,0,$midReverse,0,6)
  Assert-PlausibleReversePartialWrite $midReverse $oldReverse $newReverse
  Assert-QualifiedRecoveryWrite $midReverse $oldReverse $newReverse
  $midReverse[9]=[byte][char]'!'
  $held=$false
  try { Assert-QualifiedRecoveryWrite $midReverse $oldReverse $newReverse } catch { $held=$true }
  if(-not $held){throw 'FOREIGN_PARTIAL_REVERSE_BYTES_ACCEPTED'}
  $candidateOnly=[byte[]]$newReverse.Clone()
  $candidateOnly[0]=[byte][char]'!'
  $held=$false
  try { Assert-QualifiedRecoveryWrite $candidateOnly $oldReverse $newReverse } catch { $held=$true }
  if(-not $held){throw 'ZERO_OLD_PREFIX_REVERSE_ACCEPTED'}

  # Reproduces a truncated reverse write at the original file length.
  $cutReverse=New-Object byte[] $oldReverse.Length
  [Array]::Copy($newReverse,0,$cutReverse,0,$cutReverse.Length)
  [Array]::Copy($oldReverse,0,$cutReverse,0,4)
  Assert-QualifiedRecoveryWrite $cutReverse $oldReverse $newReverse
  $cutReverse[11]=[byte][char]'!'
  $held=$false
  try { Assert-QualifiedRecoveryWrite $cutReverse $oldReverse $newReverse } catch { $held=$true }
  if(-not $held){throw 'FOREIGN_TRUNCATED_REVERSE_BYTES_ACCEPTED'}

  # Synthetic-only GitHub API response, no actual network or H4 credentials.
  $ExpectedMainSha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  $specs=@(
    @{workflow_id=363535704;path='.github/workflows/supervisor-tests.yml'},
    @{workflow_id=363535705;path='.github/workflows/supervisor-integrity.yml'},
    @{workflow_id=363536127;path='.github/workflows/supervisor-lifecycle-acceptance.yml'},
    @{workflow_id=363536125;path='.github/workflows/supervisor-autostart-install.yml'}
  )
  $runs=@()
  foreach($row in $specs){
    $runs+=([pscustomobject]@{
      workflow_id=$row.workflow_id;path=$row.path
      repository=[pscustomobject]@{full_name='magasincoffee/magasin-supervisor'}
      head_sha=$ExpectedMainSha;head_branch='main';event='push'
      status='completed';conclusion='success';id=(38560000000+$row.workflow_id)
      run_attempt=1
    })
  }
  $receipt=[pscustomobject]@{total_count=4;workflow_runs=$runs}
  Assert-RequiredMainCiResponse $receipt $ExpectedMainSha
  $oldConclusion=$runs[0].conclusion
  $runs[0].conclusion='failure'
  $held=$false
  try { Assert-RequiredMainCiResponse $receipt $ExpectedMainSha } catch { $held=$true }
  if(-not $held){throw 'FAILED_MAIN_CI_WAS_ACCEPTED'}
  $runs[0].conclusion=$oldConclusion
  $runs[1].head_sha='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  $held=$false
  try { Assert-RequiredMainCiResponse $receipt $ExpectedMainSha } catch { $held=$true }
  if(-not $held){throw 'MISMATCH_MAIN_CI_SHA_WAS_ACCEPTED'}
  $runs[1].head_sha=$ExpectedMainSha
  $receipt.total_count=5
  $held=$false
  try { Assert-RequiredMainCiResponse $receipt $ExpectedMainSha } catch { $held=$true }
  if(-not $held){throw 'PAGINATED_MAIN_CI_WAS_ACCEPTED'}
  $receipt.total_count=4

  # A synthetic aborted post-write assertion must restore original bytes
  # while the same exclusive file handle is held.
  $ExpectedOld=Hash-Bytes $old
  $ExpectedNew=Hash-Bytes $next
  $inflight=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try {
    Write-LockedFile $inflight $next
    Restore-AfterFailedApply $inflight $old $next
    if((Hash-Bytes (Read-LockedFile $inflight)) -cne $ExpectedOld) {
      throw 'AUTO_ROLLBACK_NOT_VERIFIED'
    }
    Write-LockedFile $inflight $next
    $foreign=[Text.Encoding]::UTF8.GetBytes('UNRELATED FOREIGN DATA')
    Write-LockedFile $inflight $foreign
    $held=$false
    try { Restore-AfterFailedApply $inflight $old $next } catch { $held=$true }
    if(-not $held){throw 'AUTO_ROLLBACK_OVERWROTE_FOREIGN_BYTES'}
  } finally {
    $inflight.Dispose()
  }

  Write-Host 'SC013_ONEFILE_EXCLUSIVE_FIXTURE_PASS=True'
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
