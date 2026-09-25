$ErrorActionPreference = "Stop"
try {
  . "$env:GITHUB_WORKSPACE\windows\state-root.ps1"

  function Read-JsonSafe([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    try { return Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
  }
  function Get-Optional($Object, [string]$Name, $Default=$null) {
    if ($null -eq $Object) { return $Default }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $Default }
    return $p.Value
  }
  function Digest([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return "" }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text.Trim())
      return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-","").ToLowerInvariant()
    } finally { $sha.Dispose() }
  }

  $candidateRoots = New-Object System.Collections.Generic.List[string]
  try { $candidateRoots.Add((Get-SupervisorStateRoot -Compatibility "legacy-preserve")) } catch {}

  foreach ($proc in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $cmd = [string]$proc.CommandLine
    if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
    foreach ($pattern in @(
      '([A-Za-z]:\\[^"]*?\\MAGASIN\\BusinessOS\\supervisor)\\runtime\\windows\\run-supervisor\.ps1',
      '([A-Za-z]:\\[^"]*?\\MAGASIN\\BusinessOS\\supervisor)\\browser_profile'
    )) {
      $m = [regex]::Match($cmd,$pattern,[System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
      if ($m.Success) { $candidateRoots.Add([string]$m.Groups[1].Value) }
    }
  }

  $validRoots = @($candidateRoots |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    ForEach-Object { try { [System.IO.Path]::GetFullPath($_) } catch { $null } } |
    Where-Object { $_ -and (Test-Path (Join-Path $_ "lanes.json")) -and (Test-Path (Join-Path $_ "lane-registry.json")) } |
    Select-Object -Unique)

  Write-Host "P2_PREFLIGHT_VALID_ROOT_COUNT=$($validRoots.Count)"
  if ($validRoots.Count -ne 1) {
    Write-Host "P2_PREFLIGHT_STATE_VALID=False"
    Write-Host "P2_PREFLIGHT_ERROR_CODE=STATE_ROOT_AMBIGUOUS_OR_MISSING"
    exit 0
  }

  $root = [string]$validRoots[0]
  $configFile = Join-Path $root "lanes.json"
  $registryFile = Join-Path $root "lane-registry.json"
  $stopFile = Join-Path $root "STOP"
  $autostartDisabled = Join-Path $root "AUTOSTART_DISABLED"

  $config = Read-JsonSafe $configFile
  $registry = Read-JsonSafe $registryFile
  if (-not $config -or -not $registry) {
    Write-Host "P2_PREFLIGHT_STATE_VALID=False"
    Write-Host "P2_PREFLIGHT_ERROR_CODE=STATE_MISSING_OR_INVALID"
    exit 0
  }

  $ownerStop = [bool]((Test-Path $stopFile) -or (Test-Path $autostartDisabled))
  Write-Host "P2_PREFLIGHT_STATE_VALID=True"
  Write-Host "P2_PREFLIGHT_OWNER_STOP=$ownerStop"

  $eligible = @()
  foreach ($cfg in @($config.lanes)) {
    $id = [string]$cfg.lane_id
    $lanesObject = Get-Optional $registry "lanes"
    $reg = Get-Optional $lanesObject $id
    if (-not $reg) { continue }

    $brainCfg = [string](Get-Optional $cfg "brain_url" "")
    $brainReg = [string](Get-Optional $reg "brain_url" "")
    $brainRev = [int](Get-Optional $cfg "brain_url_revision" 0)
    $brainApplied = [int](Get-Optional $reg "applied_brain_url_revision" 0)
    $adopted = Get-Optional $reg "brain_directive_adopted"
    $adoptedAction = [string](Get-Optional $adopted "action" "")
    $adoptedTask = [string](Get-Optional $adopted "task_id" "")
    $adoptedDirective = [string](Get-Optional $adopted "directive_digest" "")
    $adoptedInstruction = [string](Get-Optional $adopted "instruction_digest" "")
    $task = [string](Get-Optional $reg "task_id" "")
    $durableDirective = [string](Get-Optional $reg "last_brain_directive_digest" "")
    $durableInstruction = [string](Get-Optional $reg "instruction_digest" "")
    $work = [string](Get-Optional $reg "work_url" "")
    $workMode = [string](Get-Optional $reg "applied_work_mode" "")
    $roll = Get-Optional $reg "work_rollover"
    $rollStage = [string](Get-Optional $roll "stage" "")

    $brainExact = (-not [string]::IsNullOrWhiteSpace($brainCfg)) -and
      ((Digest $brainCfg) -eq (Digest $brainReg)) -and
      ($brainRev -eq $brainApplied)

    Write-Host "P2_PREFLIGHT_$($id)_ENABLED=$([bool](Get-Optional $cfg "enabled" $false))"
    Write-Host "P2_PREFLIGHT_$($id)_BRAIN_PRESENT=$(-not [string]::IsNullOrWhiteSpace($brainCfg))"
    Write-Host "P2_PREFLIGHT_$($id)_BRAIN_EXACT=$brainExact"
    Write-Host "P2_PREFLIGHT_$($id)_BRAIN_REV=$brainRev"
    Write-Host "P2_PREFLIGHT_$($id)_ADOPTED_ACTION=$adoptedAction"
    Write-Host "P2_PREFLIGHT_$($id)_ADOPTED_TASK=$adoptedTask"
    Write-Host "P2_PREFLIGHT_$($id)_ADOPTED_IDENTITY_COMPLETE=$([bool]($adoptedDirective -and $adoptedInstruction))"
    Write-Host "P2_PREFLIGHT_$($id)_DURABLE_IDENTITY_COMPLETE=$([bool]($durableDirective -and $durableInstruction))"
    Write-Host "P2_PREFLIGHT_$($id)_REGISTRY_TASK=$task"
    Write-Host "P2_PREFLIGHT_$($id)_WORK_PRESENT=$(-not [string]::IsNullOrWhiteSpace($work))"
    Write-Host "P2_PREFLIGHT_$($id)_WORK_MODE=$workMode"
    Write-Host "P2_PREFLIGHT_$($id)_AWAITING=$([bool](Get-Optional $reg "awaiting_work" $false))"
    Write-Host "P2_PREFLIGHT_$($id)_DISPATCH_INFLIGHT=$([bool](Get-Optional $reg "dispatch_inflight" $null))"
    Write-Host "P2_PREFLIGHT_$($id)_RELAY_INFLIGHT=$([bool](Get-Optional $reg "relay_inflight" $null))"
    Write-Host "P2_PREFLIGHT_$($id)_ROLLOVER_STAGE=$rollStage"

    if (
      -not $ownerStop -and
      $brainExact -and
      -not [string]::IsNullOrWhiteSpace($task) -and
      -not [string]::IsNullOrWhiteSpace($durableDirective) -and
      -not [string]::IsNullOrWhiteSpace($durableInstruction)
    ) {
      $eligible += $id
    }
  }
  Write-Host "P2_PREFLIGHT_ELIGIBLE_COUNT=$($eligible.Count)"
  if ($eligible.Count -gt 0) { Write-Host "P2_PREFLIGHT_ELIGIBLE_LANES=$($eligible -join ',')" }
  Write-Host "P2_PREFLIGHT_READ_ONLY=True"
  exit 0
} catch {
  Write-Host "P2_PREFLIGHT_STATE_VALID=False"
  Write-Host "P2_PREFLIGHT_ERROR_CODE=SAFE_PREFLIGHT_EXCEPTION"
  exit 0
}
