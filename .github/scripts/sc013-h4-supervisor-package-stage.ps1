param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$ExpectedMainSha
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

# STAGING ONLY. This script never installs/starts Supervisor or changes C: state.
if ([Environment]::MachineName -ne 'DESKTOP-H4A16IL') { throw 'WRONG_H4_MACHINE' }
if ($env:GITHUB_ACTIONS -ne 'true' -or [string]::IsNullOrWhiteSpace($env:GITHUB_WORKSPACE)) {
  throw 'GITHUB_RUNNER_CONTEXT_REQUIRED'
}
$workspace=[string]$env:GITHUB_WORKSPACE
if (-not (Test-Path -LiteralPath (Join-Path $workspace '.git'))) { throw 'CHECKOUT_REQUIRED' }
$env:GIT_NO_REPLACE_OBJECTS='1'
$want=$ExpectedMainSha.ToLowerInvariant()
$actual=(& git -C $workspace -c core.fsmonitor=false rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $actual -ne $want) { throw 'CHECKOUT_SHA_MISMATCH' }
$main=(& git -C $workspace -c core.fsmonitor=false ls-remote origin refs/heads/main)
if ($LASTEXITCODE -ne 0 -or -not $main) { throw 'MAIN_AUTHORITY_UNAVAILABLE' }
$remoteSha=([string]($main -split '\s+')[0]).ToLowerInvariant()
if ($remoteSha -ne $want) { throw 'MAIN_MOVED_OR_UNAPPROVED_SHA' }

# Use an existing runner-writeable state subtree on D:, never the installed C: runtime.
$parent='D:\MAGASIN_ROBOTS\control-center\state'
$base=Join-Path $parent 'supervisor-packages'
$stage=Join-Path $base $want
foreach ($ancestor in @('D:\MAGASIN_ROBOTS','D:\MAGASIN_ROBOTS\control-center',$parent,$base,$stage)) {
  if (Test-Path -LiteralPath $ancestor) {
    $item=Get-Item -LiteralPath $ancestor -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'STAGE_PATH_NOT_PLAIN_DIRECTORY'
    }
  }
}
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'STAGE_PARENT_MISSING' }
if (Test-Path -LiteralPath $stage) { throw 'STAGE_ALREADY_EXISTS_DO_NOT_OVERWRITE' }
New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
$zip=Join-Path $stage 'supervisor-source.zip'
$manifest=Join-Path $stage 'manifest.json'
$partial=Join-Path $stage 'supervisor-source.zip.partial'
try {
  foreach ($required in @('src','windows','package.json','README.md','SOURCE_OF_TRUTH.md')) {
    if (-not (Test-Path -LiteralPath (Join-Path $workspace $required))) { throw 'SOURCE_MISSING' }
  }
  & git -C $workspace -c core.fsmonitor=false archive --format=zip "--output=$partial" HEAD -- src windows package.json README.md SOURCE_OF_TRUTH.md
  if ($LASTEXITCODE -ne 0) { throw 'GIT_ARCHIVE_FAILED' }
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive=[IO.Compression.ZipFile]::OpenRead($partial)
  $count=0
  try {
    foreach ($entry in $archive.Entries) {
      $name=[string]$entry.FullName
      if ($name -match '(^/|(^|/)\.\.?/|\\|:)' -or
          -not ($name -match '^(src/|windows/|package\.json$|README\.md$|SOURCE_OF_TRUTH\.md$)') -or
          $entry.Length -gt 200MB) { throw 'UNSAFE_ARCHIVE_ENTRY' }
      $count++
    }
  } finally { $archive.Dispose() }
  if ($count -lt 100) { throw 'PACKAGE_TOO_SMALL' }
  Move-Item -LiteralPath $partial -Destination $zip -ErrorAction Stop
  $digest=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  $proof=[ordered]@{
    schema='MAGASIN_H4_SUPERVISOR_PACKAGE_STAGE_V1'
    target='DESKTOP-H4A16IL'
    exact_main_sha=$want
    archive_sha256=$digest
    archive_entries=$count
    installed=$false
    supervisor_started=$false
    control_or_state_modified=$false
    source_archive='supervisor-source.zip'
    staged_utc=[DateTimeOffset]::UtcNow.ToString('o')
  }
  $proof | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifest -Encoding UTF8
  if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) {
    throw 'PACKAGE_READBACK_MISMATCH'
  }
  Write-Output ('H4_PACKAGE_STAGE_PASS=True')
  Write-Output ('EXACT_MAIN_SHA='+$want)
  Write-Output ('PACKAGE_SHA256='+$digest)
  Write-Output ('MANIFEST_PATH='+$manifest)
  Write-Output ('NO_PRODUCTION_INSTALL=True')
} catch {
  # Failed stage stays quarantined as evidence; never overwrite another stage.
  Write-Output ('H4_PACKAGE_STAGE_FAILED='+[string]$_.Exception.Message)
  throw
} finally {
  if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue }
}
