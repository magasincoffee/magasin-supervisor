$ErrorActionPreference = "Stop"

. "$env:GITHUB_WORKSPACE\windows\state-root.ps1"

function Test-DirectP2Context {
  try {
    $root = Get-SupervisorStateRoot -Compatibility "legacy-preserve"
    $lanes = Join-Path $root "lanes.json"
    $registry = Join-Path $root "lane-registry.json"
    $start = Join-Path $root "runtime\windows\start-supervisor.ps1"
    if (-not (Test-Path -LiteralPath $lanes -PathType Leaf -ErrorAction Stop)) { return $false }
    if (-not (Test-Path -LiteralPath $registry -PathType Leaf -ErrorAction Stop)) { return $false }
    if (-not (Test-Path -LiteralPath $start -PathType Leaf -ErrorAction Stop)) { return $false }
    $null = Get-Content -LiteralPath $lanes -Raw -Encoding UTF8 -ErrorAction Stop
    $null = Get-Content -LiteralPath $registry -Raw -Encoding UTF8 -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

$harness = Join-Path $env:GITHUB_WORKSPACE ".github\scripts\supervisor-p2-live-isolated.ps1"

if (Test-DirectP2Context) {
  Write-Host "LIVE_P2_LAUNCH_CONTEXT=DIRECT_RUNNER_USER"
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $harness
  exit $LASTEXITCODE
}

$interactiveUser = [string](Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).UserName
if ([string]::IsNullOrWhiteSpace($interactiveUser)) {
  Write-Host "LIVE_P2_LAUNCH_CONTEXT=NO_INTERACTIVE_USER"
  throw "P2_LIVE_INTERACTIVE_USER_REQUIRED"
}

Write-Host "LIVE_P2_LAUNCH_CONTEXT=INTERACTIVE_TOKEN_REQUIRED"
Write-Host "LIVE_P2_INTERACTIVE_USER_PRESENT=True"

$taskName = "MAGASIN-P2-LIVE-" + ([guid]::NewGuid().ToString("N"))
$sharedRoot = Join-Path $env:SystemRoot ("Temp\magasin-p2-live-" + ([guid]::NewGuid().ToString("N")))
$wrapper = Join-Path $sharedRoot "run-p2-live.ps1"
$outFile = Join-Path $sharedRoot "p2-live.out.log"
$exitFile = Join-Path $sharedRoot "p2-live.exit.txt"
$interactiveTemp = Join-Path $sharedRoot "runner-temp"

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
try {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $wrapper + '"')
  $principal = New-ScheduledTaskPrincipal -UserId $interactiveUser -LogonType Interactive -RunLevel Limited
  try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force -ErrorAction Stop | Out-Null
    $registered = $true
  } catch {
    Write-Host "LIVE_P2_INTERACTIVE_TASK_REGISTRATION=False"
    throw "P2_LIVE_INTERACTIVE_TASK_REGISTRATION_DENIED"
  }
  Write-Host "LIVE_P2_INTERACTIVE_TASK_REGISTRATION=True"

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
  if ($code -ne 0) { throw "P2_LIVE_INTERACTIVE_ACCEPTANCE_FAILED" }
  Write-Host "LIVE_P2_LAUNCH_CONTEXT=INTERACTIVE_USER"
} finally {
  if ($registered) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $sharedRoot -Recurse -Force -ErrorAction SilentlyContinue
}
