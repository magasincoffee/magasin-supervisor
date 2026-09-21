Set-StrictMode -Version 2.0

function Get-SupervisorStateRoot {
    param(
        [string]$ExplicitRoot = [string]$env:SUPERVISOR_STATE_ROOT,
        [ValidateSet('legacy-preserve','platform-default')]
        [string]$Compatibility = 'legacy-preserve'
    )

    if (-not [string]::IsNullOrWhiteSpace($ExplicitRoot)) {
        return [System.IO.Path]::GetFullPath($ExplicitRoot)
    }

    $base = [string]$env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($base)) {
        $base = [string]$env:USERPROFILE
    }
    if ([string]::IsNullOrWhiteSpace($base)) {
        throw 'LOCALAPPDATA or USERPROFILE is required to resolve Supervisor state root.'
    }

    if ($Compatibility -eq 'legacy-preserve') {
        return (Join-Path $base 'MAGASIN\BusinessOS\supervisor')
    }

    return (Join-Path $base 'MAGASIN\Supervisor')
}
