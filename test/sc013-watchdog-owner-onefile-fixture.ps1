$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
# Hosted Windows ONLY. Evaluate isolated functions, never invoke the full H4
# installer, production path, GitHub remote or any Supervisor/SQLite process.
$script=Join-Path $PSScriptRoot '..\.github\scripts\sc013-watchdog-owner-onefile-apply.ps1'
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($script,[ref]$tokens,[ref]$errors)
if (@($errors).Count -ne 0) { throw 'OWNER_INSTALL_POWERSHELL_PARSE_FAILED' }
foreach ($name in @('Hash-Bytes','Read-LockedFile','Write-LockedFile','Write-DurableReceipt')) {
  $matches=@($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }.GetNewClosure(),$true))
  if ($matches.Count -ne 1) { throw ('ISOLATED_HELPER_MISSING_'+$name) }
  . ([scriptblock]::Create($matches[0].Extent.Text))
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
  Write-Host 'SC013_ONEFILE_EXCLUSIVE_FIXTURE_PASS=True'
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
