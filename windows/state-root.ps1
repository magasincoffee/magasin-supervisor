Set-StrictMode -Version 2.0

function Get-SupervisorStateRoot {
    if ($env:SUPERVISOR_STATE_ROOT) {
        $candidate = [Environment]::ExpandEnvironmentVariables([string]$env:SUPERVISOR_STATE_ROOT)
        if (-not [IO.Path]::IsPathRooted($candidate)) {
            throw 'SUPERVISOR_STATE_ROOT must be an absolute path.'
        }
        return $candidate
    }

    if (-not $env:LOCALAPPDATA) {
        throw 'LOCALAPPDATA is required for legacy Supervisor state-root compatibility.'
    }

    # MIG-003 compatibility strategy: preserve the existing production location
    # until MIG-005 explicitly authorizes a cutover. This helper never moves,
    # renames, resets, or creates state by itself.
    return (Join-Path $env:LOCALAPPDATA 'MAGASIN\BusinessOS\supervisor')
}

function Get-SupervisorStateRootSource {
    if ($env:SUPERVISOR_STATE_ROOT) { return 'EXPLICIT_ENV' }
    return 'LEGACY_COMPATIBILITY_FALLBACK'
}
