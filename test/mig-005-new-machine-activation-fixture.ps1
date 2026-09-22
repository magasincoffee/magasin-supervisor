$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repoRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repoRoot 'windows\mig-005-new-machine-activate.ps1'
$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$tempRoot = Join-Path $tempBase ('mig005-new-machine-fixture-' + [guid]::NewGuid().ToString('N'))
$oldLocalAppData = $env:LOCALAPPDATA
$oldProcessStateRoot = [string]$env:SUPERVISOR_STATE_ROOT
$oldUserStateRoot = [Environment]::GetEnvironmentVariable('SUPERVISOR_STATE_ROOT','User')

function Invoke-ExpectedFailure([string[]]$CommandArgs) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & powershell.exe @CommandArgs 2>&1
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{
        output = ($output | Out-String)
        code = $code
    }
}

try {
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    $env:LOCALAPPDATA = Join-Path $tempRoot 'LocalAppData'
    $env:SUPERVISOR_STATE_ROOT = $null

    $payload = Join-Path $tempRoot 'payload'
    New-Item -ItemType Directory -Force -Path $payload | Out-Null
    Set-Content -Path (Join-Path $payload 'fixture.txt') -Value 'fixture' -Encoding ascii
    $zip = Join-Path $tempRoot 'fixture.zip'
    Compress-Archive -Path (Join-Path $payload '*') -DestinationPath $zip -CompressionLevel Optimal

    $sha = (& git -C $repoRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[a-f0-9]{40}$') {
        throw 'Unable to resolve exact fixture candidate SHA.'
    }
    $zipHash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    $platformRoot = Join-Path $env:LOCALAPPDATA 'MAGASIN\Supervisor'
    if (Test-Path $platformRoot) { throw 'Fixture platform root unexpectedly exists before validation.' }

    $output = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $wrapper -Mode Validate -PackageZip $zip -ExpectedPackageSha256 $zipHash -CandidateSha $sha 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Validate mode failed: $($output | Out-String)" }
    $joined = $output | Out-String
    if ($joined -notmatch 'MIG_005_NEW_MACHINE_VALIDATE_ONLY=PASS') { throw 'Validate marker missing.' }
    if ($joined -notmatch 'MIG_005_SELECTED_STATE_ROOT_PLATFORM_DEFAULT=True') { throw 'Platform-default marker missing.' }
    if (Test-Path $platformRoot) { throw 'Validate mode mutated the platform state root.' }
    if ([Environment]::GetEnvironmentVariable('SUPERVISOR_STATE_ROOT','User') -ne $oldUserStateRoot) {
        throw 'Validate mode changed CurrentUser SUPERVISOR_STATE_ROOT.'
    }

    $wrongHash = '0' * 64
    if ($wrongHash -eq $zipHash) { $wrongHash = 'f' * 64 }
    $failureArgs = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$wrapper,'-Mode','Validate','-PackageZip',$zip,'-ExpectedPackageSha256',$wrongHash,'-CandidateSha',$sha)
    $failure = Invoke-ExpectedFailure -CommandArgs $failureArgs
    if ($failure.code -eq 0) { throw 'Package hash mismatch unexpectedly succeeded.' }
    if ($failure.output -notmatch 'package SHA256 mismatch') { throw 'Expected package hash mismatch was not reported.' }
    if (Test-Path $platformRoot) { throw 'Hash mismatch mutated the platform state root.' }
    if ([Environment]::GetEnvironmentVariable('SUPERVISOR_STATE_ROOT','User') -ne $oldUserStateRoot) {
        throw 'Hash mismatch changed CurrentUser SUPERVISOR_STATE_ROOT.'
    }

    Write-Host 'MIG_005_NEW_MACHINE_VALIDATE_FIXTURE=PASS'
    Write-Host 'MIG_005_PLATFORM_DEFAULT_EXPLICIT_ROOT=True'
    Write-Host 'MIG_005_PACKAGE_HASH_FAIL_BEFORE_MUTATION=True'
    Write-Host 'MIG_005_PERSISTENT_ENV_UNCHANGED_IN_VALIDATE=True'
    Write-Host 'RBT009_TIER_B_480M=NOT_RUN'
}
finally {
    $env:LOCALAPPDATA = $oldLocalAppData
    $env:SUPERVISOR_STATE_ROOT = $oldProcessStateRoot
    Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
