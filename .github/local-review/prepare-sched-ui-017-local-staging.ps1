param(
  [string]$TargetComputer = 'DESKTOP-4K7IM13',
  [string]$CandidateSha = '1f6f6cf0646aba66e9f73fab123f87a182cb17c1',
  [int]$Port = 8772
)

$ErrorActionPreference = 'Stop'
Write-Host "LOCAL_STAGING_MACHINE=$env:COMPUTERNAME"

if ($env:COMPUTERNAME -ne $TargetComputer) {
  Write-Host "LOCAL_STAGING_TARGET_MATCH=False"
  Start-Sleep -Seconds 45
  exit 0
}
Write-Host "LOCAL_STAGING_TARGET_MATCH=True"

$target = Join-Path $env:USERPROFILE 'MAGASIN_PREVIEW\SCHED-UI-017'
$previewRoot = Split-Path $target -Parent
$mockSource = Join-Path $PSScriptRoot 'supabase-local-mock.js'
$mockTargetDir = Join-Path $target 'LOCAL_STAGING'
$mockTarget = Join-Path $mockTargetDir 'supabase-local-mock.js'
$pidFile = Join-Path $previewRoot 'SCHED-UI-017-server.pid'
$logFile = Join-Path $previewRoot 'SCHED-UI-017-server.log'
$serverScript = Join-Path $previewRoot 'SCHED-UI-017-server.ps1'

if (!(Test-Path $target)) {
  New-Item -ItemType Directory -Force -Path $previewRoot | Out-Null
  git clone https://github.com/magasincoffee/magasincoffee.github.io.git $target
}

Push-Location $target
git fetch origin sched-ui-001-recurring-editor --quiet
git checkout --detach $CandidateSha
git reset --hard $CandidateSha
git clean -fd
$actual = (git rev-parse HEAD).Trim()
Pop-Location
if ($actual -ne $CandidateSha) {
  throw "Candidate mismatch. expected=$CandidateSha actual=$actual"
}
Write-Host "LOCAL_STAGING_CANDIDATE_SHA=$actual"

New-Item -ItemType Directory -Force -Path $mockTargetDir | Out-Null
Copy-Item -LiteralPath $mockSource -Destination $mockTarget -Force

$needle = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
$replacement = '/LOCAL_STAGING/supabase-local-mock.js'
$patchedCount = 0
Get-ChildItem -LiteralPath $target -Recurse -File | Where-Object {
  $_.FullName -notmatch '\\.git\\' -and $_.FullName -ne $mockTarget -and @('.html','.js') -contains $_.Extension.ToLowerInvariant()
} | ForEach-Object {
  $raw = Get-Content -LiteralPath $_.FullName -Raw
  if ($raw.Contains($needle)) {
    $next = $raw.Replace($needle,$replacement)
    Set-Content -LiteralPath $_.FullName -Value $next -Encoding UTF8
    $patchedCount++
  }
}
Write-Host "LOCAL_STAGING_SUPABASE_REPLACEMENTS=$patchedCount"
if ($patchedCount -lt 5) {
  throw "Expected multiple Supabase CDN replacements, got $patchedCount"
}

$authPath = Join-Path $target '03_PLATFORM\01_AUTH\auth-runtime-v2.js'
$auth = Get-Content -LiteralPath $authPath -Raw
$oldRoute = @'
    if (role === 'OWNER') location.replace('/owner/');
    else if (role === 'ACCOUNTANT') location.replace('/nhap-hang/');
    else if (role === 'STORE_MANAGER') location.replace('/manager/');
    else if (['STAFF', 'EMPLOYEE'].includes(role)) location.replace('/employee/');
'@
$newRoute = @'
    if (role === 'OWNER') location.replace('/owner/scheduling/');
    else if (role === 'ACCOUNTANT') location.replace('/nhap-hang/');
    else if (role === 'STORE_MANAGER') location.replace('/manager/scheduling/');
    else if (['STAFF', 'EMPLOYEE'].includes(role)) location.replace('/employee/schedule/');
'@
$oldRoute = $oldRoute.TrimStart([char]13,[char]10)
$newRoute = $newRoute.TrimStart([char]13,[char]10)
if (!$auth.Contains($oldRoute)) {
  throw 'Local staging auth route anchor not found.'
}
$auth = $auth.Replace($oldRoute,$newRoute)
Set-Content -LiteralPath $authPath -Value $auth -Encoding UTF8

$readme = @(
  'SCHED-UI-017 LOCAL STAGING'
  "Candidate: $actual"
  'Backend: local browser mock only; production Supabase is not contacted by patched application pages.'
  ''
  'Accounts:'
  'OWNER    username: owner     password: Magasin123!'
  'MANAGER  username: manager   password: Magasin123!'
  'EMPLOYEE username: employee  password: Magasin123!'
  ''
  "Login: http://127.0.0.1:$Port/03_PLATFORM/01_AUTH/?localstaging=2"
) -join [Environment]::NewLine
Set-Content -LiteralPath (Join-Path $target 'LOCAL_STAGING\README.txt') -Value $readme -Encoding UTF8
Set-Content -LiteralPath (Join-Path $env:USERPROFILE 'Desktop\SCHED-UI-017-LOCAL-STAGING.txt') -Value $readme -Encoding UTF8

$base = "http://127.0.0.1:$Port"
$loginUrl = "$base/03_PLATFORM/01_AUTH/?localstaging=2"

$serverAlive = $false
try {
  $probe = Invoke-WebRequest -UseBasicParsing -Uri "$base/LOCAL_STAGING/supabase-local-mock.js?probe=2" -TimeoutSec 5
  $serverAlive = $probe.StatusCode -eq 200
} catch {
  $serverAlive = $false
}

if (!$serverAlive) {
  $pythonExe = $null
  $pythonArgs = @()
  if (Get-Command py.exe -ErrorAction SilentlyContinue) {
    $pythonExe = (Get-Command py.exe).Source
    $pythonArgs = @('-3','-m','http.server',"$Port",'--bind','127.0.0.1')
  } elseif (Get-Command python.exe -ErrorAction SilentlyContinue) {
    $pythonExe = (Get-Command python.exe).Source
    $pythonArgs = @('-m','http.server',"$Port",'--bind','127.0.0.1')
  } else {
    throw 'Python not found on local runner.'
  }

  if (Test-Path $pidFile) {
    $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($oldPid -match '^\d+$') {
      cmd.exe /d /c "taskkill /PID $oldPid /T /F >NUL 2>&1" | Out-Null
    }
  }

  $escapedTarget = $target.Replace("'","''")
  $escapedPython = $pythonExe.Replace("'","''")
  $escapedLog = $logFile.Replace("'","''")
  $argText = ($pythonArgs -join ' ')
  $serverBody = @(
    '$ErrorActionPreference = ''Stop'''
    "Set-Location -LiteralPath '$escapedTarget'"
    "& '$escapedPython' $argText *> '$escapedLog'"
  ) -join [Environment]::NewLine
  Set-Content -LiteralPath $serverScript -Value $serverBody -Encoding UTF8

  $commandLine = 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $serverScript + '"'
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
  if ($created.ReturnValue -ne 0 -or -not $created.ProcessId) {
    throw "Unable to create local staging process. ReturnValue=$($created.ReturnValue)"
  }
  Set-Content -LiteralPath $pidFile -Value $created.ProcessId -Encoding ASCII
  Start-Sleep -Seconds 3
}

$mockProbe = Invoke-WebRequest -UseBasicParsing -Uri "$base/LOCAL_STAGING/supabase-local-mock.js?probe=3" -TimeoutSec 10
if ($mockProbe.StatusCode -ne 200 -or $mockProbe.Content -notmatch 'magasin.local.staging.session.v1') {
  throw 'Local staging mock is not being served.'
}
$authProbe = Invoke-WebRequest -UseBasicParsing -Uri "$loginUrl&probe=3" -TimeoutSec 10
if ($authProbe.StatusCode -ne 200 -or $authProbe.Content -notmatch 'auth-runtime-v2.js') {
  throw 'Local staging auth page is not being served.'
}

Write-Host "LOCAL_STAGING_READY=True"
Write-Host "LOCAL_STAGING_LOGIN=$loginUrl"
Write-Host "LOCAL_STAGING_ACCOUNTS=owner,manager,employee"
Write-Host "LOCAL_STAGING_PRODUCTION_MUTATION=NONE"

Start-Process $loginUrl
