# Shared H4 Runner is only a delivery channel, never Supervisor authority.
# CLI-only V6 bootstrap on D; runs trusted Python stdlib only, NEVER SAYDI models.
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$SaydiSha,
    [Parameter(Mandatory)]
    [ValidatePattern('^SAYDI002-VN-001-[a-z0-9-]{8,45}$')]
    [string]$RequestId
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$expectedHost = 'DESKTOP-H4A16IL'
# Python 3.12 embeddable ZIP is SHA256-pinned to the PSF-published SBOM.
# Never invoke Python, install through Registry, run pip/setup-python or
# activate SAYDI under the shared Supervisor Runner identity.

function Assert-PlainDirectory([string]$Path) {
    $entry = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $entry.PSIsContainer) { throw 'REQUIRED_DIRECTORY_MISSING' }
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'REPARSE_DIRECTORY_DENIED'
    }
}

if ([Environment]::MachineName -ne $expectedHost) { throw 'WRONG_H4_HOST' }
if ($env:GITHUB_REPOSITORY -ne 'magasincoffee/magasin-supervisor') {
    throw 'WRONG_TRANSPORT_REPOSITORY'
}
if ($env:GITHUB_REF -ne 'refs/heads/main' -or $env:GITHUB_EVENT_NAME -ne 'push' -or $env:GITHUB_RUN_ATTEMPT -ne '1') {
    throw 'UNTRUSTED_TRIGGER'
}
if ($env:GITHUB_ACTOR -ne 'magasincoffee' -or
    $env:GITHUB_TRIGGERING_ACTOR -ne 'magasincoffee' -or
    $env:GITHUB_ACTOR_ID -ne '191064507') {
    throw 'UNTRUSTED_OWNER_IDENTITY'
}
if ($env:SAYDI_MAIN_SHA -ne $SaydiSha -or $env:SAYDI_REQUEST_ID -ne $RequestId) {
    throw 'REQUEST_METADATA_MISMATCH'
}

# No Python interpreter, native library, bundled package or SAYDI module
# is executed by the shared Supervisor Runner identity. The only Python
# runtime installed is a digest-pinned official Windows embeddable archive.
# Runtime activation belongs to an independently authenticated SAYDI process.

$c = Get-PSDrive -Name C -ErrorAction Stop
$d = Get-PSDrive -Name D -ErrorAction Stop
if ($c.Free -lt 2GB -or $d.Free -lt 10GB) {
    throw 'RESOURCE_DISK_CAPACITY_HOLD'
}

$source = Join-Path $env:GITHUB_WORKSPACE 'saydi-source'
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw 'SAYDI_CHECKOUT_MISSING'
}
Assert-PlainDirectory $source
$git = (Get-Command git.exe -ErrorAction Stop).Source
$checkoutSha = (& $git -C $source rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $checkoutSha -ne $SaydiSha) {
    throw 'SAYDI_SOURCE_SHA_MISMATCH'
}
$mainRef = & $git ls-remote https://github.com/magasincoffee/magasin-media-robot.git refs/heads/main
if ($LASTEXITCODE -ne 0 -or -not $mainRef -or -not ($mainRef -match '^([0-9a-f]{40})\s')) {
    throw 'SAYDI_MAIN_VERIFICATION_UNAVAILABLE'
}
if ($Matches[1] -ne $SaydiSha) { throw 'SAYDI_MAIN_MOVED_HOLD' }

$core = Join-Path $source '02_SAYDI_CORE'
$sot = Join-Path $source '00_PROJECT\SOURCE_OF_TRUTH.md'
Assert-PlainDirectory (Join-Path $source '00_PROJECT')
if (-not (Test-Path -LiteralPath $sot -PathType Leaf)) { throw 'SAYDI_CANONICAL_SOT_MISSING' }
$sotEntry = Get-Item -LiteralPath $sot -Force -ErrorAction Stop
if ($sotEntry.PSIsContainer -or (($sotEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw 'SAYDI_SOT_REPARSE_DENIED'
}
if (-not (Test-Path -LiteralPath (Join-Path $core 'pyproject.toml') -PathType Leaf)) {
    throw 'SAYDI_CORE_MISSING'
}
Assert-PlainDirectory $core
foreach ($entry in @(Get-ChildItem -LiteralPath $core -Force -Recurse -ErrorAction Stop)) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'SAYDI_SOURCE_REPARSE_DENIED'
    }
}
Assert-PlainDirectory 'D:\'
$base = 'D:\SAYDI_V6'
$destination = Join-Path $base 'releases'
if (-not (Test-Path -LiteralPath $base -PathType Container)) {
    New-Item -ItemType Directory -Path $base -ErrorAction Stop | Out-Null
}
Assert-PlainDirectory $base
if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
    New-Item -ItemType Directory -Path $destination -ErrorAction Stop | Out-Null
}
Assert-PlainDirectory $destination
# One release leaf per authenticated one-shot request. If a crash occurs
# after promotion but before receipt, a new request ID can retry safely
# without deleting any previously staged or installed content.
$shaNamespace = Join-Path $destination $SaydiSha
if (-not (Test-Path -LiteralPath $shaNamespace -PathType Container)) {
    New-Item -ItemType Directory -Path $shaNamespace -ErrorAction Stop | Out-Null
}
Assert-PlainDirectory $shaNamespace
$release = Join-Path $shaNamespace $RequestId
if (Test-Path -LiteralPath $release) { throw 'RELEASE_EXISTS_NO_OVERWRITE' }
$stageRoot = Join-Path $base 'install-staging'
if (-not (Test-Path -LiteralPath $stageRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $stageRoot -ErrorAction Stop | Out-Null
}
Assert-PlainDirectory $stageRoot
$stage = Join-Path $stageRoot $RequestId
if (Test-Path -LiteralPath $stage) { throw 'STAGING_REQUEST_ALREADY_USED' }
New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
$installedCore = Join-Path $stage '02_SAYDI_CORE'
Copy-Item -LiteralPath $core -Destination $installedCore -Recurse -ErrorAction Stop
Copy-Item -LiteralPath $sot -Destination (Join-Path $stage 'SOURCE_OF_TRUTH.snapshot.md') -ErrorAction Stop
$originalHash = (Get-FileHash -LiteralPath (Join-Path $core 'pyproject.toml') -Algorithm SHA256).Hash
$installedHash = (Get-FileHash -LiteralPath (Join-Path $installedCore 'pyproject.toml') -Algorithm SHA256).Hash
if ($originalHash -ne $installedHash) { throw 'INSTALLED_CORE_HASH_MISMATCH' }

# Validate every copied file against the exact main checkout; no Python or
# SAYDI code runs under the shared Supervisor service identity.
$originalFiles = @(Get-ChildItem -LiteralPath $core -Force -File -Recurse -ErrorAction Stop)
$copiedFiles = @(Get-ChildItem -LiteralPath $installedCore -Force -File -Recurse -ErrorAction Stop)
# Authenticate each staged file against its pinned canonical Git blob ID.
# No configurable clean filters or candidate interpreters are executed.
$expectedFiles = @(& $git --no-replace-objects -C $source ls-tree -r --name-only $SaydiSha -- '02_SAYDI_CORE')
if ($LASTEXITCODE -ne 0 -or $expectedFiles.Count -lt 1 -or
    $originalFiles.Count -ne $expectedFiles.Count -or
    $copiedFiles.Count -ne $expectedFiles.Count) {
    throw 'V6_GIT_TREE_FILE_COUNT_MISMATCH'
}
foreach ($file in $originalFiles) {
    $relative = $file.FullName.Substring($core.Length).TrimStart('\')
    $target = Join-Path $installedCore $relative
    $entry = Get-Item -LiteralPath $target -Force -ErrorAction Stop
    if ($entry.PSIsContainer -or
        (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'V6_STAGED_FILE_UNSAFE'
    }
    $srcHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
    if ($srcHash -ne $dstHash) { throw 'V6_STAGED_CONTENT_HASH_MISMATCH' }
    $gitPath = '02_SAYDI_CORE/' + $relative.Replace('\', '/')
    if ($expectedFiles -cnotcontains $gitPath) { throw 'V6_UNTRACKED_SOURCE_FILE_DENIED' }
    $expectedObject = (& $git --no-replace-objects -C $source rev-parse --verify ($SaydiSha + ':' + $gitPath)).Trim()
    if ($LASTEXITCODE -ne 0 -or $expectedObject -notmatch '^[0-9a-f]{40}$') {
        throw 'V6_GIT_BLOB_LOOKUP_FAILED'
    }
    $observedObject = (& $git -C $source hash-object --no-filters -- $target).Trim()
    if ($LASTEXITCODE -ne 0 -or $observedObject -cne $expectedObject) {
        throw ('V6_STAGED_GIT_BLOB_MISMATCH:' + $gitPath)
    }
}
$stagedSotHash = (Get-FileHash -LiteralPath (Join-Path $stage 'SOURCE_OF_TRUTH.snapshot.md') -Algorithm SHA256).Hash
$originalSotHash = (Get-FileHash -LiteralPath $sot -Algorithm SHA256).Hash
if ($stagedSotHash -ne $originalSotHash) { throw 'V6_STAGED_SOT_HASH_MISMATCH' }
$expectedSotObject = (& $git --no-replace-objects -C $source rev-parse --verify ($SaydiSha + ':00_PROJECT/SOURCE_OF_TRUTH.md')).Trim()
if ($LASTEXITCODE -ne 0 -or $expectedSotObject -notmatch '^[0-9a-f]{40}$') {
    throw 'V6_SOT_GIT_OBJECT_LOOKUP_FAILED'
}
$observedSotObject = (& $git -C $source hash-object --no-filters -- (Join-Path $stage 'SOURCE_OF_TRUTH.snapshot.md')).Trim()
if ($LASTEXITCODE -ne 0 -or $observedSotObject -cne $expectedSotObject) {
    throw 'V6_STAGED_SOT_GIT_BLOB_MISMATCH'
}


# Archive digest comes from the PSF-authored official 3.12.10 SPDX SBOM,
# not from the download channel. HTTPS is necessary but not sufficient.
$pythonArchiveUrl = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip'
$pythonArchiveSha256 = '4ACBED6DD1C744B0376E3B1CF57CE906F9DC9E95E68824584C8099A63025A3C3'
$pythonArchiveLength = 11133606
$archivePath = Join-Path $stage 'python-3.12.10-embed-amd64.zip'
if (Test-Path -LiteralPath $archivePath) { throw 'PYTHON_ARCHIVE_EXISTS_NO_OVERWRITE' }
Invoke-WebRequest -Uri $pythonArchiveUrl -OutFile $archivePath -UseBasicParsing -ErrorAction Stop
$archiveFile = Get-Item -LiteralPath $archivePath -Force -ErrorAction Stop
if ($archiveFile.PSIsContainer -or
    (($archiveFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
    $archiveFile.Length -ne $pythonArchiveLength) {
    throw 'V6_PYTHON_ARCHIVE_LENGTH_INVALID'
}
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -cne $pythonArchiveSha256) {
    throw 'V6_PYTHON_ARCHIVE_HASH_MISMATCH'
}
$runtime = Join-Path $stage 'runtime'
if (Test-Path -LiteralPath $runtime) { throw 'V6_RUNTIME_EXISTS_NO_OVERWRITE' }
New-Item -ItemType Directory -Path $runtime -ErrorAction Stop | Out-Null
Assert-PlainDirectory $runtime
# The official embeddable ZIP contains flat file names only. Deny ZIP-slip,
# duplicate/case-fold collisions and arbitrary directories before extracting.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    $names = @{}
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName
        if ($name -cnotmatch '^[A-Za-z0-9_.-]+$' -or $name -in @('.', '..') -or
            $name.IndexOf('..', [StringComparison]::Ordinal) -ge 0 -or
            $names.ContainsKey($name.ToLowerInvariant())) {
            throw 'V6_PYTHON_ARCHIVE_ENTRY_UNSAFE'
        }
        $names[$name.ToLowerInvariant()] = $true
    }
    foreach ($required in @('python.exe', 'python312.dll', 'python3.dll',
                             'python312.zip', 'python312._pth')) {
        if (-not $names.ContainsKey($required)) { throw 'V6_PYTHON_ARCHIVE_INCOMPLETE' }
    }
    foreach ($entry in $zip.Entries) {
        $target = Join-Path $runtime $entry.FullName
        if (Test-Path -LiteralPath $target) { throw 'V6_RUNTIME_FILE_EXISTS_NO_OVERWRITE' }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target)
    }
}
finally { $zip.Dispose() }

# The embedded runtime uses a closed path file with site disabled by default.
# Register SAYDI source with a relative path so moving the release is safe.
$pathFile = Join-Path $runtime 'python312._pth'
if (-not (Test-Path -LiteralPath $pathFile -PathType Leaf)) { throw 'V6_EMBEDDED_PTH_MISSING' }
$originalPathFile = Get-Content -LiteralPath $pathFile -Raw -ErrorAction Stop
if ($originalPathFile -notmatch '(?m)^python312\.zip\s*$' -or
    $originalPathFile -notmatch '(?m)^\.\s*$' -or
    $originalPathFile -match '(?m)^\s*import\s+site') {
    throw 'V6_EMBEDDED_PATH_FILE_UNSAFE'
}
$pathData = "python312.zip`r`n.`r`n..\02_SAYDI_CORE\src`r`n"
[IO.File]::WriteAllText($pathFile, $pathData, [Text.Encoding]::ASCII)
if ((Get-Content -LiteralPath $pathFile -Raw -Encoding ASCII) -cne $pathData) {
    throw 'V6_EMBEDDED_PATH_WRITE_FAILED'
}

# Install only a launcher file; DO NOT invoke the embedded interpreter here.
# Real activation is a separate SAYDI-local authenticated START operation.
$launcher = Join-Path $stage 'saydi-audiobook.cmd'
if (Test-Path -LiteralPath $launcher) { throw 'V6_LAUNCHER_ALREADY_EXISTS' }
$launcherData = @'
@echo off
setlocal DisableDelayedExpansion
"%~dp0runtime\python.exe" -I -S -m saydi_audiobook %*
'@
[IO.File]::WriteAllText($launcher, ($launcherData + [Environment]::NewLine), [Text.Encoding]::ASCII)
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'V6_LAUNCHER_MISSING' }

# Promotion of verified bytes; zero executable SAYDI/Python operations.
[System.IO.Directory]::Move($stage, $release)

$receipt = [ordered]@{
    schema = 'SAYDI_V6_H4_CLI_INSTALL_RECEIPT_V1'
    status = 'CLI_FILES_INSTALLED_ON_D_SAYDI_NOT_EXECUTED'
    target_host = $expectedHost
    request_id = $RequestId
    source_repository = 'magasincoffee/magasin-media-robot'
    source_sha = $SaydiSha
    destination = 'D_DRIVE_VERSIONED_RELEASE_CLI_ONLY'
    copied_file_count = $originalFiles.Count
    canonical_git_tree_verified = $true
    copied_tree_sha256_verified = $true
    core_pyproject_sha256 = $installedHash
    canonical_sot_sha256 = $originalSotHash
    portable_runtime_archive_sha256 = $pythonArchiveSha256
    portable_runtime_archive_verified = $true
    python_qualified = $false
    python_runtime_executed = $false
    cli_files_installed = $true
    cli_executed = $false
    module_import_attempted = $false
    model_started = $false
    saydi_start_authenticated = $false
    supervisor_control_modified = $false
    previous_versions_modified = $false
}
$receipt | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $release 'cli-install-receipt.json') -Encoding UTF8 -NoNewline
$receipt | ConvertTo-Json -Compress
