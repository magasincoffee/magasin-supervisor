# Shared H4 Runner is only a delivery channel, never Supervisor authority.
# Source-only SAYDI V6 CLI install on D. DOES NOT START VieNeu, Whisper or worker.
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
$trustedPython = 'C:\Users\admin\AppData\Local\Programs\Python\Python312\python.exe'

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
if (-not (Test-Path -LiteralPath $sot -PathType Leaf)) { throw 'SAYDI_CANONICAL_SOT_MISSING' }
if (-not (Test-Path -LiteralPath (Join-Path $core 'pyproject.toml') -PathType Leaf)) {
    throw 'SAYDI_CORE_MISSING'
}
Assert-PlainDirectory $core
foreach ($entry in @(Get-ChildItem -LiteralPath $core -Force -Recurse -ErrorAction Stop)) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'SAYDI_SOURCE_REPARSE_DENIED'
    }
}
if (-not (Test-Path -LiteralPath $trustedPython -PathType Leaf)) {
    throw 'TRUSTED_PYTHON_MISSING'
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
$release = Join-Path $destination $SaydiSha
if (Test-Path -LiteralPath $release) { throw 'RELEASE_EXISTS_NO_OVERWRITE' }

New-Item -ItemType Directory -Path $release -ErrorAction Stop | Out-Null
$installedCore = Join-Path $release '02_SAYDI_CORE'
Copy-Item -LiteralPath $core -Destination $installedCore -Recurse -ErrorAction Stop
Copy-Item -LiteralPath $sot -Destination (Join-Path $release 'SOURCE_OF_TRUTH.snapshot.md') -ErrorAction Stop
$originalHash = (Get-FileHash -LiteralPath (Join-Path $core 'pyproject.toml') -Algorithm SHA256).Hash
$installedHash = (Get-FileHash -LiteralPath (Join-Path $installedCore 'pyproject.toml') -Algorithm SHA256).Hash
if ($originalHash -ne $installedHash) { throw 'INSTALLED_CORE_HASH_MISMATCH' }

# Reuse installed Python, but create a new virtual environment on D.
# Do not import/install VieNeu; no audio generation or service start.
$venv = Join-Path $release '.venv'
& $trustedPython -m venv $venv
if ($LASTEXITCODE -ne 0) { throw 'V6_VENV_CREATION_FAILED' }
$python = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw 'V6_ENVIRONMENT_NOT_CREATED'
}
$previousPythonPath = $env:PYTHONPATH
try {
    $env:PYTHONPATH = Join-Path $installedCore 'src'
    & $python -m saydi_audiobook --help | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'V6_CLI_IMPORT_FAILED' }
} finally {
    $env:PYTHONPATH = $previousPythonPath
}

$receipt = [ordered]@{
    schema = 'SAYDI_V6_H4_INSTALL_RECEIPT_V1'
    status = 'CLI_INSTALLED_ON_D_NO_AUDIO'
    target_host = $expectedHost
    request_id = $RequestId
    source_repository = 'magasincoffee/magasin-media-robot'
    source_sha = $SaydiSha
    destination = 'D_DRIVE_VERSIONED_RELEASE'
    core_pyproject_sha256 = $installedHash
    cli_smoke_passed = $true
    model_started = $false
    saydi_start_authenticated = $false
    supervisor_control_modified = $false
    previous_versions_modified = $false
}
$receipt | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $release 'install-receipt.json') -Encoding UTF8 -NoNewline
$receipt | ConvertTo-Json -Compress