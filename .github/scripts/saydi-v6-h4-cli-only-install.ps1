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
# Python must originate from the official setup-python Runner toolcache, not PATH or admin profile.
# No SAYDI module is imported or executed under the Supervisor Runner identity.

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

$trustedPython = $env:SAYDI_BOOTSTRAP_PYTHON
if ([string]::IsNullOrWhiteSpace($trustedPython) -or [string]::IsNullOrWhiteSpace($env:RUNNER_TOOL_CACHE)) {
    throw 'RUNNER_PYTHON_TOOLCACHE_MISSING'
}
$trustedPython = [IO.Path]::GetFullPath($trustedPython)
$cache = [IO.Path]::GetFullPath($env:RUNNER_TOOL_CACHE).TrimEnd('\') + '\'
if (-not $trustedPython.StartsWith($cache, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($trustedPython) -cne 'python.exe') { throw 'RUNNER_PYTHON_OUTSIDE_TOOLCACHE' }
$pyEntry = Get-Item -LiteralPath $trustedPython -Force -ErrorAction Stop
if ($pyEntry.PSIsContainer -or (($pyEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw 'RUNNER_PYTHON_REPARSE_DENIED'
}
$version = (& $trustedPython -I -c 'import sys;print(str(sys.version_info.major)+"."+str(sys.version_info.minor))')
if ($LASTEXITCODE -ne 0 -or $version.Trim() -ne '3.12') { throw 'RUNNER_PYTHON_VERSION_INVALID' }

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


# Move verified source into final versioned release BEFORE creating venv:
# Windows venv absolute paths are not reliably relocatable.
[System.IO.Directory]::Move($stage, $release)
$venv = Join-Path $release '.venv'
if (Test-Path -LiteralPath $venv) { throw 'V6_VENV_ALREADY_EXISTS' }
& $trustedPython -m venv $venv
if ($LASTEXITCODE -ne 0) { throw 'V6_VENV_CREATION_FAILED' }
$venvPython = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) { throw 'V6_PYTHON_MISSING' }
$probe = 'import sys;assert sys.prefix != sys.base_prefix;print("V6_ISOLATED_PYTHON_READY=True")'
& $venvPython -I -c $probe
if ($LASTEXITCODE -ne 0) { throw 'V6_VENV_SELF_CHECK_FAILED' }

# Parse source as static syntax; never import SAYDI, VieNeu, Whisper or its CLI.
$astProbe = 'import ast,pathlib,sys; r=pathlib.Path(sys.argv[1]); fs=list(r.rglob("*.py")); assert fs; [ast.parse(p.read_text(encoding="utf-8-sig"),filename=str(p)) for p in fs]; print("V6_PYTHON_FILES_PARSED="+str(len(fs)))'
& $trustedPython -I -c $astProbe $installedCore
if ($LASTEXITCODE -ne 0) { throw 'V6_STATIC_SOURCE_PARSE_FAILED' }

# Persistent source-module registration without pip, internet or module execution.
$sitePackages = Join-Path $venv 'Lib\site-packages'
Assert-PlainDirectory $sitePackages
$finalSource = Join-Path (Join-Path $release '02_SAYDI_CORE') 'src'
Assert-PlainDirectory $finalSource
$pth = Join-Path $sitePackages 'saydi_v6_source.pth'
if (Test-Path -LiteralPath $pth) { throw 'V6_MODULE_REGISTRATION_EXISTS' }
[IO.File]::WriteAllText($pth, $finalSource + [Environment]::NewLine, [Text.Encoding]::ASCII)
if ((Get-Content -LiteralPath $pth -Raw -Encoding ASCII).Trim() -cne $finalSource) {
    throw 'V6_MODULE_REGISTRATION_FAILED'
}

# Install a fixed local CLI wrapper. This file is NOT invoked by the Runner.
$launcher = Join-Path $venv 'Scripts\saydi-audiobook.cmd'
if (Test-Path -LiteralPath $launcher) { throw 'V6_LAUNCHER_ALREADY_EXISTS' }
$launcherData = @'
@echo off
setlocal DisableDelayedExpansion
"%~dp0python.exe" -m saydi_audiobook %*
'@
[IO.File]::WriteAllText($launcher, ($launcherData + [Environment]::NewLine), [Text.Encoding]::ASCII)
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'V6_LAUNCHER_MISSING' }

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
    python_qualified = $true
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
