# Shared H4 Runner is only a delivery channel, never Supervisor authority.
# Source-only SAYDI V6 STAGE on D; never starts Python, VieNeu, Whisper or worker.
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
# No Python binary is selected or executed in this version. Prior Codex
# review identified uncontrolled code-execution risks in shared PATH Python.
# The authenticated Runner is only a transport for immutable SOURCE files.

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
$expectedFiles = @(& $git -C $source ls-tree -r --name-only $SaydiSha -- '02_SAYDI_CORE')
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
    $expectedObject = (& $git -C $source rev-parse --verify ($SaydiSha + ':' + $gitPath)).Trim()
    if ($LASTEXITCODE -ne 0 -or $expectedObject -notmatch '^[0-9a-f]{40}$') {
        throw 'V6_GIT_BLOB_LOOKUP_FAILED'
    }
    $observedObject = (& $git -C $source hash-object --no-filters -- $target).Trim()
    if ($LASTEXITCODE -ne 0 -or $observedObject -cne $expectedObject) {
        throw 'V6_STAGED_GIT_BLOB_MISMATCH'
    }
}
$stagedSotHash = (Get-FileHash -LiteralPath (Join-Path $stage 'SOURCE_OF_TRUTH.snapshot.md') -Algorithm SHA256).Hash
$originalSotHash = (Get-FileHash -LiteralPath $sot -Algorithm SHA256).Hash
if ($stagedSotHash -ne $originalSotHash) { throw 'V6_STAGED_SOT_HASH_MISMATCH' }
$expectedSotObject = (& $git -C $source rev-parse --verify ($SaydiSha + ':00_PROJECT/SOURCE_OF_TRUTH.md')).Trim()
if ($LASTEXITCODE -ne 0 -or $expectedSotObject -notmatch '^[0-9a-f]{40}$') {
    throw 'V6_SOT_GIT_OBJECT_LOOKUP_FAILED'
}
$observedSotObject = (& $git -C $source hash-object --no-filters -- (Join-Path $stage 'SOURCE_OF_TRUTH.snapshot.md')).Trim()
if ($LASTEXITCODE -ne 0 -or $observedSotObject -cne $expectedSotObject) {
    throw 'V6_STAGED_SOT_GIT_BLOB_MISMATCH'
}


$receipt = [ordered]@{
    schema = 'SAYDI_V6_H4_SOURCE_STAGE_RECEIPT_V1'
    status = 'SOURCE_ONLY_STAGED_ON_D_NO_PYTHON'
    target_host = $expectedHost
    request_id = $RequestId
    source_repository = 'magasincoffee/magasin-media-robot'
    source_sha = $SaydiSha
    destination = 'D_DRIVE_VERSIONED_RELEASE_SOURCE_ONLY'
    core_pyproject_sha256 = $installedHash
    canonical_sot_sha256 = $originalSotHash
    copied_file_count = $originalFiles.Count
    copied_tree_sha256_verified = $true
    canonical_git_tree_verified = $true
    python_qualified = $false
    cli_installed = $false
    cli_executed = $false
    model_started = $false
    saydi_start_authenticated = $false
    supervisor_control_modified = $false
    previous_versions_modified = $false
}
# A completed source-only receipt must be inside the final atomic release.
$receipt | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $stage 'source-stage-receipt.json') -Encoding UTF8 -NoNewline
[System.IO.Directory]::Move($stage, $release)
$receipt | ConvertTo-Json -Compress