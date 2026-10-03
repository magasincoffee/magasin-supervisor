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
$stagingDir = Join-Path $target 'LOCAL_STAGING'
$bridgePath = Join-Path $stagingDir 'supabase-production-readonly.js'
$pidFile = Join-Path $previewRoot 'SCHED-UI-017-server.pid'
$logFile = Join-Path $previewRoot 'SCHED-UI-017-server.log'
$serverScript = Join-Path $previewRoot 'SCHED-UI-017-server.ps1'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

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

New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null

# Download the real Supabase browser client, then append a local read-only guard.
$cdn = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
Invoke-WebRequest -UseBasicParsing -Uri $cdn -OutFile $bridgePath -TimeoutSec 30

$guard = @'
;
(function(global){
  'use strict';
  const lib=global.supabase;
  const originalCreate=lib&&typeof lib.createClient==='function'?lib.createClient.bind(lib):null;
  if(!originalCreate)throw new Error('LOCAL_REVIEW_SUPABASE_LIBRARY_MISSING');

  const blockedRpc=/^(create|save|delete|replace|review|publish|submit|respond|approve|reject|update|set|assign|revoke|activate|deactivate|mark)_/i;
  const blockedQuery=new Set(['insert','upsert','update','delete']);
  const blockedAuth=new Set(['signUp','resetPasswordForEmail','updateUser']);
  const roError=()=>({message:'LOCAL_REVIEW_READ_ONLY',code:'LOCAL_REVIEW_READ_ONLY'});

  function wrapBuilder(builder){
    if(!builder||typeof builder!=='object')return builder;
    return new Proxy(builder,{
      get(target,prop){
        if(blockedQuery.has(String(prop))){
          return async()=>({data:null,error:roError()});
        }
        const value=Reflect.get(target,prop,target);
        if(typeof value!=='function')return value;
        return (...args)=>{
          const out=value.apply(target,args);
          if(out&&typeof out==='object'&&!(out instanceof Promise))return wrapBuilder(out);
          return out;
        };
      }
    });
  }

  function wrapAuth(auth){
    return new Proxy(auth,{
      get(target,prop){
        if(blockedAuth.has(String(prop))){
          return async()=>({data:{user:null,session:null},error:roError()});
        }
        const value=Reflect.get(target,prop,target);
        return typeof value==='function'?value.bind(target):value;
      }
    });
  }

  lib.createClient=(...args)=>{
    const client=originalCreate(...args);
    return new Proxy(client,{
      get(target,prop){
        if(prop==='auth')return wrapAuth(target.auth);
        if(prop==='rpc'){
          return async(name,params,options)=>{
            if(blockedRpc.test(String(name||'')))return {data:null,error:roError()};
            return target.rpc(name,params,options);
          };
        }
        if(prop==='from')return table=>wrapBuilder(target.from(table));
        const value=Reflect.get(target,prop,target);
        return typeof value==='function'?value.bind(target):value;
      }
    });
  };

  try{localStorage.removeItem('magasin.local.staging.session.v1')}catch(_){}

  function banner(){
    if(document.getElementById('localProductionReadOnlyBanner'))return;
    const b=document.createElement('div');
    b.id='localProductionReadOnlyBanner';
    b.textContent='LOCAL REVIEW · TÀI KHOẢN + DỮ LIỆU THẬT · CHỈ ĐỌC';
    b.style.cssText='position:fixed;right:10px;top:8px;z-index:2147483647;background:#174c65;color:#fff;padding:7px 11px;border-radius:999px;font:700 11px/1.2 system-ui;box-shadow:0 3px 12px #0003;pointer-events:none';
    (document.documentElement||document.body).appendChild(b);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',banner,{once:true});else banner();

  global.__MAGASIN_LOCAL_REAL_READONLY__=true;
})(globalThis);
'@
[System.IO.File]::AppendAllText($bridgePath, $guard, $utf8NoBom)

$needle = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
$replacement = '/LOCAL_STAGING/supabase-production-readonly.js?v=real-readonly-1'
$patchedCount = 0
Get-ChildItem -LiteralPath $target -Recurse -File | Where-Object {
  $_.FullName -notmatch '\\.git\\' -and $_.FullName -notlike "$stagingDir*" -and @('.html','.js') -contains $_.Extension.ToLowerInvariant()
} | ForEach-Object {
  $raw = [System.IO.File]::ReadAllText($_.FullName, $utf8NoBom)
  if ($raw.Contains($needle)) {
    [System.IO.File]::WriteAllText($_.FullName, $raw.Replace($needle,$replacement), $utf8NoBom)
    $patchedCount++
  }
}
Write-Host "LOCAL_STAGING_SUPABASE_REPLACEMENTS=$patchedCount"
if ($patchedCount -lt 5) {
  throw "Expected multiple Supabase CDN replacements, got $patchedCount"
}

# Verify that the candidate's Vietnamese text survived the local patch byte-for-byte in UTF-8 terms.
$authHtmlPath = Join-Path $target '03_PLATFORM\01_AUTH\index.html'
$authHtmlCheck = [System.IO.File]::ReadAllText($authHtmlPath, $utf8NoBom)
if ($authHtmlCheck -notmatch 'Đăng nhập' -or $authHtmlCheck -match 'Ä|Ã') {
  throw 'UTF8 verification failed after local staging patch.'
}
Write-Host "LOCAL_STAGING_UTF8=PASS"

$readme = @(
  'SCHED-UI-017 LOCAL REVIEW · REAL AUTH / REAL DATA / READ-ONLY'
  "Candidate: $actual"
  'Login uses the real MAGASIN Supabase account.'
  'Reads use production data allowed by that account role.'
  'Application data mutations are blocked locally before they reach Supabase.'
  'Auth sign-in/sign-out are allowed; signup/password reset/password update are blocked in this review build.'
  ''
  "Login: http://127.0.0.1:$Port/03_PLATFORM/01_AUTH/?realreview=1"
) -join [Environment]::NewLine
[System.IO.File]::WriteAllText((Join-Path $stagingDir 'README.txt'), $readme, $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $env:USERPROFILE 'Desktop\SCHED-UI-017-REAL-READONLY.txt'), $readme, $utf8NoBom)

$base = "http://127.0.0.1:$Port"
$loginUrl = "$base/03_PLATFORM/01_AUTH/?realreview=1"

$serverAlive = $false
try {
  $probe = Invoke-WebRequest -UseBasicParsing -Uri "$base/LOCAL_STAGING/supabase-production-readonly.js?probe=1" -TimeoutSec 5
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
  [System.IO.File]::WriteAllText($serverScript, $serverBody, $utf8NoBom)

  $commandLine = 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $serverScript + '"'
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
  if ($created.ReturnValue -ne 0 -or -not $created.ProcessId) {
    throw "Unable to create local review process. ReturnValue=$($created.ReturnValue)"
  }
  Set-Content -LiteralPath $pidFile -Value $created.ProcessId -Encoding ASCII
  Start-Sleep -Seconds 3
}

$bridgeProbe = Invoke-WebRequest -UseBasicParsing -Uri "$base/LOCAL_STAGING/supabase-production-readonly.js?probe=2" -TimeoutSec 10
if ($bridgeProbe.StatusCode -ne 200 -or $bridgeProbe.Content -notmatch 'LOCAL_REVIEW_READ_ONLY') {
  throw 'Real read-only Supabase bridge is not being served.'
}
$authProbe = Invoke-WebRequest -UseBasicParsing -Uri "$loginUrl&probe=2" -TimeoutSec 10
if ($authProbe.StatusCode -ne 200 -or $authProbe.Content -notmatch 'auth-runtime-v2.js') {
  throw 'Local real-auth login page is not being served.'
}

Write-Host "LOCAL_STAGING_READY=True"
Write-Host "LOCAL_STAGING_MODE=REAL_AUTH_REAL_DATA_READ_ONLY"
Write-Host "LOCAL_STAGING_LOGIN=$loginUrl"
Write-Host "LOCAL_STAGING_UTF8=PASS"
Write-Host "LOCAL_STAGING_PRODUCTION_DATA_MUTATION=BLOCKED"

Start-Process $loginUrl
