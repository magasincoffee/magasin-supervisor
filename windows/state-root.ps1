Set-StrictMode -Version 2.0

function Get-PersistedSupervisorStateRoot {
    try {
        $userValue = [string][Environment]::GetEnvironmentVariable(
            'SUPERVISOR_STATE_ROOT',
            [EnvironmentVariableTarget]::User
        )
        if (-not [string]::IsNullOrWhiteSpace($userValue)) {
            return [System.IO.Path]::GetFullPath($userValue)
        }
    } catch {}

    try {
        $machineValue = [string][Environment]::GetEnvironmentVariable(
            'SUPERVISOR_STATE_ROOT',
            [EnvironmentVariableTarget]::Machine
        )
        if (-not [string]::IsNullOrWhiteSpace($machineValue)) {
            return [System.IO.Path]::GetFullPath($machineValue)
        }
    } catch {}

    return $null
}

function Get-SupervisorStateRoot {
    param(
        [string]$ExplicitRoot = [string]$env:SUPERVISOR_STATE_ROOT,
        [ValidateSet('legacy-preserve','platform-default')]
        [string]$Compatibility = 'legacy-preserve'
    )

    if (-not [string]::IsNullOrWhiteSpace($ExplicitRoot)) {
        return [System.IO.Path]::GetFullPath($ExplicitRoot)
    }

    $persistedRoot = Get-PersistedSupervisorStateRoot
    if (-not [string]::IsNullOrWhiteSpace([string]$persistedRoot)) {
        return $persistedRoot
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

function Set-SupervisorStateRootBinding {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Root
    )

    $fullRoot = [System.IO.Path]::GetFullPath($Root)
    [Environment]::SetEnvironmentVariable(
        'SUPERVISOR_STATE_ROOT',
        $fullRoot,
        [EnvironmentVariableTarget]::User
    )
    $env:SUPERVISOR_STATE_ROOT = $fullRoot
    return $fullRoot
}
