param(
    [ValidateSet('DIRECT_DOM_V1','CHATGPT_BRIDGE_V1')]
    [string]$Primary,
    [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'state-root.ps1')
. (Join-Path $PSScriptRoot 'chatgpt-bridge-runtime.ps1')

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Get-SupervisorStateRoot -Compatibility 'legacy-preserve'
}
$Root = [System.IO.Path]::GetFullPath($Root)
New-Item -ItemType Directory -Force -Path $Root | Out-Null

if ($Primary -eq 'CHATGPT_BRIDGE_V1') {
    [void](Assert-ChatGptBridgePinnedInstall -Root $Root)
}

$config = [ordered]@{
    schema_version = 'planner-executor-transport.v1'
    primary = $Primary
    fallback = 'DIRECT_DOM_V1'
    bridge_upstream_repository = 'https://github.com/OLmatter/chatgpt-bridge'
    bridge_upstream_commit = $script:ChatGptBridgePinnedCommit
    changed_at = [DateTimeOffset]::UtcNow.ToString('o')
}

$path = Join-Path $Root 'planner-executor-transport.json'
$tmp = $path + '.tmp'
$json = $config | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText(
    $tmp,
    $json + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false))
)
Move-Item -Path $tmp -Destination $path -Force

Write-Host "PLANNER_EXECUTOR_TRANSPORT_PRIMARY=$Primary"
Write-Host "PLANNER_EXECUTOR_TRANSPORT_PATH=$path"
Write-Host "PLANNER_EXECUTOR_BRIDGE_PIN=$($script:ChatGptBridgePinnedCommit)"
