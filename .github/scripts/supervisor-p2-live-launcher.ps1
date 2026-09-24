$ErrorActionPreference = "Stop"

. "$env:GITHUB_WORKSPACE\windows\state-root.ps1"

function Test-DirectP2Context {
  try {
    $root = Get-SupervisorStateRoot -Compatibility "legacy-preserve"
    foreach ($leaf in @(
      (Join-Path $root "lanes.json"),
      (Join-Path $root "lane-registry.json"),
      (Join-Path $root "runtime\windows\start-supervisor.ps1")
    )) {
      if (-not (Test-Path -LiteralPath $leaf -PathType Leaf -ErrorAction Stop)) { return $false }
      $stream = [System.IO.File]::Open($leaf,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite)
      $stream.Dispose()
    }
    return $true
  } catch { return $false }
}

function Invoke-RunnerIsolatedFallback {
  Write-Host "LIVE_P2_LAUNCH_CONTEXT=RUNNER_ISOLATED_FALLBACK"
  $fallback = Join-Path $env:GITHUB_WORKSPACE ".github\scripts\supervisor-p2-live-runner-isolated.ps1"
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $fallback
  if ($LASTEXITCODE -ne 0) { throw "P2_LIVE_RUNNER_ISOLATED_FALLBACK_FAILED" }
  exit 0
}

$harness = Join-Path $env:GITHUB_WORKSPACE ".github\scripts\supervisor-p2-live-isolated.ps1"

if (Test-DirectP2Context) {
  Write-Host "LIVE_P2_LAUNCH_CONTEXT=DIRECT_RUNNER_USER"
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $harness
  exit $LASTEXITCODE
}

$interactiveUser = [string](Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).UserName
if ([string]::IsNullOrWhiteSpace($interactiveUser)) {
  Write-Host "LIVE_P2_INTERACTIVE_USER_PRESENT=False"
  Invoke-RunnerIsolatedFallback
}

Write-Host "LIVE_P2_LAUNCH_CONTEXT=INTERACTIVE_TOKEN_REQUIRED"
Write-Host "LIVE_P2_INTERACTIVE_USER_PRESENT=True"

$taskName = "MAGASIN-P2-LIVE-" + ([guid]::NewGuid().ToString("N"))
$sharedRoot = Join-Path $env:RUNNER_TEMP ("magasin-p2-interactive-" + ([guid]::NewGuid().ToString("N")))
$wrapper = Join-Path $sharedRoot "run-p2-live.ps1"
$outFile = Join-Path $sharedRoot "p2-live.out.log"
$exitFile = Join-Path $sharedRoot "p2-live.exit.txt"
$interactiveTemp = Join-Path $sharedRoot "interactive-temp"
New-Item -ItemType Directory -Force -Path $interactiveTemp | Out-Null

function Quote-PsLiteral([string]$Value) {
  return "'" + ($Value -replace "'","''") + "'"
}

$wrapperLines = @(
  '$ErrorActionPreference = "Continue"',
  ('$env:GITHUB_WORKSPACE = ' + (Quote-PsLiteral $env:GITHUB_WORKSPACE)),
  ('$env:RUNNER_TEMP = ' + (Quote-PsLiteral $interactiveTemp)),
  ('$out = ' + (Quote-PsLiteral $outFile)),
  ('$exitFile = ' + (Quote-PsLiteral $exitFile)),
  ('$harness = ' + (Quote-PsLiteral $harness)),
  '$code = 1',
  'try {',
  '  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $harness *>> $out',
  '  $code = $LASTEXITCODE',
  '} catch {',
  '  ("P2_INTERACTIVE_LAUNCH_EXCEPTION=" + $_.Exception.GetType().Name) | Add-Content -LiteralPath $out -Encoding UTF8',
  '  $code = 1',
  '}',
  'Set-Content -LiteralPath $exitFile -Value ([string]$code) -Encoding ascii',
  'exit $code'
)
Set-Content -LiteralPath $wrapper -Value $wrapperLines -Encoding UTF8

$registered = $false
$registrationDenied = $false
try {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $wrapper + '"')
  $principal = New-ScheduledTaskPrincipal -UserId $interactiveUser -LogonType Interactive -RunLevel Limited
  try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force -ErrorAction Stop | Out-Null
    $registered = $true
    Write-Host "LIVE_P2_INTERACTIVE_TASK_REGISTRATION=True"
  } catch {
    $registrationDenied = $true
    Write-Host "LIVE_P2_INTERACTIVE_TASK_REGISTRATION=False"
  }

  if (-not $registered) {
    Write-Host "LIVE_P2_INTERACTIVE_CONTEXT_UNAVAILABLE=True"
  } else {
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Write-Host "LIVE_P2_INTERACTIVE_TASK_STARTED=True"

    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(14)
    while ([DateTimeOffset]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $exitFile)) {
      Start-Sleep -Seconds 2
    }
    if (-not (Test-Path -LiteralPath $exitFile)) {
      throw "P2_LIVE_INTERACTIVE_TASK_TIMEOUT"
    }

    if (Test-Path -LiteralPath $outFile) {
      Get-Content -LiteralPath $outFile -Encoding UTF8 | ForEach-Object { Write-Host $_ }
    }
    $codeText = (Get-Content -LiteralPath $exitFile -Raw -Encoding ascii).Trim()
    $code = 1
    if (-not [int]::TryParse($codeText,[ref]$code)) { $code = 1 }
    Write-Host "LIVE_P2_INTERACTIVE_TASK_EXIT_CODE=$code"
    if ($code -eq 0) {
      Write-Host "LIVE_P2_LAUNCH_CONTEXT=INTERACTIVE_USER"
      exit 0
    }
    Write-Host "LIVE_P2_INTERACTIVE_ACCEPTANCE_FAILED=True"
  }
} finally {
  if ($registered) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  try { Remove-Item -LiteralPath $sharedRoot -Recurse -Force -ErrorAction Stop } catch {}
}

Invoke-RunnerIsolatedFallback
