Set-StrictMode -Version 2.0

function Get-SupervisorPlatformStateRoot {
    $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:HOME) { $env:HOME } else { (Get-Location).Path }
    return (Join-Path $base 'MAGASIN\Supervisor')
}

function Get-SupervisorLegacyStateRoot {
    $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:HOME) { $env:HOME } else { (Get-Location).Path }
    return (Join-Path $base 'MAGASIN\BusinessOS\supervisor')
}

function Get-SupervisorStateRoot {
    if ($env:MAGASIN_SUPERVISOR_STATE_ROOT) {
        return [string]$env:MAGASIN_SUPERVISOR_STATE_ROOT
    }
    $legacy = Get-SupervisorLegacyStateRoot
    if (Test-Path $legacy) {
        return $legacy
    }
    return (Get-SupervisorPlatformStateRoot)
}
