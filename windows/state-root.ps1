param(
  [hashtable]$Environment = $null
)

$ErrorActionPreference = 'Stop'

if ($null -eq $Environment) {
  $Environment = @{
    MAGASIN_SUPERVISOR_STATE_ROOT = $env:MAGASIN_SUPERVISOR_STATE_ROOT
    LOCALAPPDATA = $env:LOCALAPPDATA
    HOME = $env:HOME
  }
}

$configured = [string]$Environment['MAGASIN_SUPERVISOR_STATE_ROOT']
if (-not [string]::IsNullOrWhiteSpace($configured)) {
  [System.IO.Path]::GetFullPath($configured)
  exit 0
}

$base = [string]$Environment['LOCALAPPDATA']
if ([string]::IsNullOrWhiteSpace($base)) {
  $base = [string]$Environment['HOME']
}
if ([string]::IsNullOrWhiteSpace($base)) {
  $base = (Get-Location).Path
}

# Compatibility read/write path only. MIG-003 performs no move, rename, reset, or copy.
Join-Path $base 'MAGASIN\BusinessOS\supervisor'
