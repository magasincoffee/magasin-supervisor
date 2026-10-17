param(
  [Parameter(Mandatory=$true)][ValidateSet('Build','Verify')][string]$Mode,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$ExpectedMainSha
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$want=$ExpectedMainSha.ToLowerInvariant()
$repo='https://github.com/magasincoffee/magasin-supervisor.git'
$privateRoot='D:\MAGASIN_ROBOTS\supervisor-reinstall-backup-20261017\h4-package-stage'
$allow=@('src/','windows/','package.json','README.md','SOURCE_OF_TRUTH.md')
function Assert-ExactMain {
  $r=@(& git ls-remote $repo refs/heads/main)
  if ($LASTEXITCODE -ne 0 -or $r.Count -ne 1) { throw 'MAIN_AUTHORITY_UNAVAILABLE' }
  $actual=([string]($r[0] -split '\s+')[0]).ToLowerInvariant()
  if ($actual -ne $want) { throw 'MAIN_MOVED_OR_UNAPPROVED_SHA' }
}
function Verify-Zip([string]$zip) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $names=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $count=0
  $archive=[IO.Compression.ZipFile]::OpenRead($zip)
  try {
    foreach($entry in $archive.Entries) {
      $name=[string]$entry.FullName
      if ($name -match '(^/|(^|/)\.\.?/|\\|:)' -or
        -not ($name -match '^(src/|windows/|package\.json$|README\.md$|SOURCE_OF_TRUTH\.md$)') -or
        $entry.Length -gt 200MB) { throw 'UNSAFE_ARCHIVE_ENTRY' }
      $parts=$name.TrimEnd('/') -split '/'
      foreach($part in $parts) {
        if ($part -match '[. ]$|[\x00-\x1F<>|"?*]' -or
            $part -in @('CON','PRN','AUX','NUL','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9','LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9') -or
            $part.Length -eq 0) { throw 'WINDOWS_UNSAFE_ARCHIVE_COMPONENT' }
      }
      # Reject aliases case-insensitively; slash-terminated directory entries have their own identity.
      $key=($parts -join '\').ToLowerInvariant()
      if (-not $names.Add($key)) { throw 'WINDOWS_ARCHIVE_NAME_COLLISION' }
      $count++
    }
  } finally { $archive.Dispose() }
  if ($count -lt 100) { throw 'PACKAGE_TOO_SMALL' }
  return $count
}
function Assert-PrivateStageRoot {
  $parent=Split-Path $privateRoot -Parent
  $inbox=Join-Path $privateRoot 'inbox'
  foreach($path in @('D:\MAGASIN_ROBOTS',$parent,$privateRoot,$inbox)) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw 'PRIVATE_STAGE_ROOT_MISSING' }
    $item=Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'STAGE_REPARSE_REJECTED' }
  }
  $parentAcl=Get-Acl -LiteralPath $parent
  $acl=Get-Acl -LiteralPath $privateRoot
  $inboxAcl=Get-Acl -LiteralPath $inbox
  if (-not $acl.AreAccessRulesProtected -or -not $inboxAcl.AreAccessRulesProtected -or -not $parentAcl.AreAccessRulesProtected) {throw 'STAGE_ACL_INHERITED'}
  $accepted=@('NT AUTHORITY\SYSTEM','NT AUTHORITY\NETWORK SERVICE','BUILTIN\Administrators','DESKTOP-H4A16IL\admin')
  $bad=@($acl.Access | Where-Object {
    $_.AccessControlType -ne 'Allow' -or
    $_.IdentityReference.ToString() -notin $accepted
  })
  if($bad.Count -gt 0){throw 'UNEXPECTED_STAGE_ACL_PRINCIPAL'}
  $hasRunner=@($acl.Access | Where-Object { $_.IdentityReference.ToString() -eq 'NT AUTHORITY\NETWORK SERVICE' -and $_.AccessControlType -eq 'Allow' })
  if($hasRunner.Count -ne 1){throw 'RUNNER_STAGE_ACL_MISSING'}
  $parentUnexpected=@($parentAcl.Access|Where-Object {
    $_.AccessControlType -ne 'Allow' -or
    $_.IdentityReference.ToString() -notin @('NT AUTHORITY\SYSTEM','BUILTIN\Administrators','DESKTOP-H4A16IL\admin')
  })
  if($parentUnexpected.Count -gt 0){throw 'BACKUP_PARENT_ACL_UNSAFE'}
  $badInbox=@($inboxAcl.Access|Where-Object{$_.AccessControlType -ne 'Allow' -or $_.IdentityReference.ToString() -notin $accepted})
  if($badInbox.Count -gt 0){throw 'INBOX_ACL_UNSAFE'}
  foreach($entry in @($acl.Access|Where-Object{$_.IdentityReference.ToString() -eq 'NT AUTHORITY\NETWORK SERVICE'})) {
    if(($entry.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Delete) -or
       ($entry.FileSystemRights -band [Security.AccessControl.FileSystemRights]::WriteData) -or
       ($entry.FileSystemRights -band [Security.AccessControl.FileSystemRights]::AppendData)) {throw 'STAGE_ROOT_RUNNER_TOO_BROAD'}
  }
  $writers=@($inboxAcl.Access|Where-Object{$_.IdentityReference.ToString() -eq 'NT AUTHORITY\NETWORK SERVICE' -and $_.AccessControlType -eq 'Allow'})
  if($writers.Count -ne 1 -or -not ($writers[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::WriteData)) {throw 'INBOX_WRITE_GRANT_MISSING'}
  if(($writers[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::Delete) -or
     ($writers[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles) -or
     ($writers[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::AppendData)) {throw 'INBOX_RUNNER_MAY_RENAME_OR_CREATE_DIR'}
}

Assert-ExactMain
if ($Mode -eq 'Build') {
  if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'BUILDER_MUST_BE_HOSTED' }
  $workspace=[string]$env:GITHUB_WORKSPACE
  if (-not $workspace -or -not (Test-Path -LiteralPath (Join-Path $workspace '.git'))) {throw 'BUILDER_CHECKOUT_REQUIRED'}
  $head=(& git -C $workspace rev-parse HEAD).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $head -ne $want) {throw 'CHECKOUT_SHA_MISMATCH'}
  $dir=Join-Path ([string]$env:RUNNER_TEMP) 'h4-package'
  if (-not (Test-Path $dir)) {New-Item -Path $dir -ItemType Directory -ErrorAction Stop |Out-Null}
  $zip=Join-Path $dir 'supervisor-source.zip'
  if(Test-Path $zip){throw 'PACKAGE_ALREADY_EXISTS'}
  & git -C $workspace -c core.fsmonitor=false archive --format=zip "--output=$zip" HEAD -- src windows package.json README.md SOURCE_OF_TRUTH.md
  if ($LASTEXITCODE -ne 0) {throw 'GIT_ARCHIVE_FAILED'}
  $count=Verify-Zip $zip
  $hash=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  $receipt=[ordered]@{
    schema='MAGASIN_H4_SUPERVISOR_PACKAGE_STAGE_V2'
    exact_main_sha=$want
    source_archive='supervisor-source.zip'
    archive_sha256=$hash
    archive_entries=$count
    build_runner='github-hosted'
    production_runtime_modified=$false
    staging_files_written=$true
    installed=$false
    supervisor_started=$false
    created_utc=[DateTimeOffset]::UtcNow.ToString('o')
  }
  $receipt |ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $dir 'manifest.json') -Encoding UTF8
  Write-Output 'HOSTED_PACKAGE_BUILD_PASS=True'
  Write-Output ('PACKAGE_SHA256='+$hash)
  exit 0
}

if ([Environment]::MachineName -ne 'DESKTOP-H4A16IL') {throw 'WRONG_H4_MACHINE'}
if ($env:RUNNER_ENVIRONMENT -ne 'self-hosted' -or $env:GITHUB_ACTIONS -ne 'true') {throw 'SELF_HOSTED_RUNNER_REQUIRED'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($identity -ne 'NT AUTHORITY\NETWORK SERVICE') {throw 'UNEXPECTED_RUNNER_IDENTITY'}
Assert-PrivateStageRoot
$stage=Join-Path $privateRoot 'inbox'
if (-not (Test-Path -LiteralPath $stage -PathType Container)) {throw 'PACKAGE_NOT_DOWNLOADED'}
if ((Get-Item -LiteralPath $stage -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'INBOX_REPARSE_REJECTED'}
$zip=Join-Path $stage 'supervisor-source.zip'
$manifest=Join-Path $stage 'manifest.json'
if (-not (Test-Path $zip -PathType Leaf) -or -not (Test-Path $manifest -PathType Leaf)) {throw 'PACKAGE_OR_MANIFEST_MISSING'}
$record=Get-Content -LiteralPath $manifest -Raw -Encoding UTF8|ConvertFrom-Json
if ([string]$record.schema -ne 'MAGASIN_H4_SUPERVISOR_PACKAGE_STAGE_V2' -or
    [string]$record.exact_main_sha -ne $want -or
    [string]$record.build_runner -ne 'github-hosted' -or
    [bool]$record.installed -or [bool]$record.supervisor_started) {throw 'PACKAGE_MANIFEST_NOT_QUALIFIED'}
$count=Verify-Zip $zip
$hash=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($count -ne [int]$record.archive_entries -or $hash -ne [string]$record.archive_sha256) {
  throw 'PACKAGE_READBACK_MISMATCH'
}
Write-Output 'H4_PACKAGE_STAGE_PASS=True'
Write-Output ('EXACT_MAIN_SHA='+$want)
Write-Output ('PACKAGE_SHA256='+$hash)
Write-Output ('PACKAGE_PATH='+$stage)
Write-Output 'NO_PRODUCTION_INSTALL=True'
