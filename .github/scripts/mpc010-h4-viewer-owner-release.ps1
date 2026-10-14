param(
  [Parameter(Mandatory=$true)][ValidateSet('SelfTest','Inspect','Stage','Apply','Rollback')][string]$Mode,
  [ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedMainSha='',
  [string]$Workspace='',
  [string]$OwnerApproval=''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0

# H4 Control Center VIEWER ONLY. NEVER Supervisor/Coordinator business START.
# There is deliberately no Apply permission simply because this script is merged.
$gateText='MPC-010 H4 VIEWER FIELD RELEASE APPROVAL GATE'
$hostName='DESKTOP-H4A16IL'
$admin='DESKTOP-H4A16IL\admin'
$install='D:\MAGASIN_ROBOTS\control-center'
$stopRoot='C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor'
$stageRoot='D:\MAGASIN_ROBOTS\deploy\mpc010-viewer'
$repoUrl='https://github.com/magasincoffee/magasin-supervisor.git'
$expectedFiles=[ordered]@{
  'src/control-center/server.py'='server.py'
  'src/control-center/owner_request_drafts.py'='owner_request_drafts.py'
  'src/control-center/project_tree_catalogue.py'='project_tree_catalogue.py'
  'src/control-center/supervisor_project_activation.py'='supervisor_project_activation.py'
  'src/control-center/web/app.js'='web\app.js'
  'src/control-center/web/index.html'='web\index.html'
  'src/control-center/web/styles.css'='web\styles.css'
  'src/control-center/web/project_tree_view.mjs'='web\project_tree_view.mjs'
  'src/control-center/web/project_detail_view.mjs'='web\project_detail_view.mjs'
  'src/control-center/web/project_request_view.mjs'='web\project_request_view.mjs'
  'src/control-center/web/project_supervisor_telemetry.mjs'='web\project_supervisor_telemetry.mjs'
  'docs/project-control/MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md'='docs\project-control\MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md'
}
$oldHashes=@{
  'server.py'='3ED5333493E3F4A3884BF78083C20FDD6C53B01AF77428E075E3A987F50165FB'
  'web\app.js'='1CF3119D30276B6A2237E0E060FAD9450E537EF85A09D3DB8FA32EF936B35BAA'
  'web\index.html'='C982C99AB98C2AA03E23D0520CC15016652E027038AD1EC31BE31152C0E0484A'
  'web\styles.css'='0968EFA7E7747ACCCFB47E214754CE0F74444E794EE9532DE29F3FEA19514C68'
}
$preserved=@{
  'D:\MAGASIN_ROBOTS\control-center\observability.py'='7B4E2BBC830E8136D5256D223EF59E2B3CCAA9F0D77596F0F3CCDD6DE68AE469'
  'D:\MAGASIN_ROBOTS\control-center\cutover_preflight.py'='1A2F9D5D91E983F1CF88456BEB14F40934BE19B81250F69071C6CFA1DEF1AF98'
  'D:\MAGASIN_ROBOTS\control-center\specialist_readiness.py'='CBEA44CF78C84C1F06F0F2F972A4E1474D9A789C947B4A03BC74E7FA7FD20AC5'
  'D:\MAGASIN_ROBOTS\control-center\supervisor_project_links.py'='AE352EAB4B6E5FE892BFE9FD1301120313B45C03ED605B9DBEEC403CC4367ACF'
  'D:\MAGASIN_ROBOTS\robots\coordinator\owner_lifecycle.py'='545E83DC723C545C521DD56EDD7F53559F6A3CCBB1FC25F5C0386A161534B952'
  'D:\MAGASIN_ROBOTS\robots\supervisor\control_adapter.py'='90F92C32C266C6A3571347169C802C8300FFBBD6F0EC0BDD70143E2F2C68B1E5'
}
function HashFile([string]$p){
  if(!(Test-Path -LiteralPath $p -PathType Leaf)){throw 'REQUIRED_FILE_NOT_FOUND'}
  return (Get-FileHash -LiteralPath $p -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant()
}
function AssertNoReparse([string]$p) {
  $current=$p
  while($current -and (Test-Path -LiteralPath $current)) {
    $item=Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'REPARSE_COMPONENT_DENIED'}
    $current=Split-Path -Path $current -Parent
  }
}
function RequireSource {
  if(!$Workspace -or !$ExpectedMainSha){throw 'PINNED_WORKSPACE_REQUIRED'}
  $work=(Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path
  AssertNoReparse $work
  if(!(Test-Path (Join-Path $work '.git'))){throw 'CANONICAL_GIT_CHECKOUT_REQUIRED'}
  $origin=(& git -C $work remote get-url origin)
  if($LASTEXITCODE -ne 0 -or [string]$origin -cne $repoUrl){throw 'WRONG_GIT_ORIGIN'}
  $head=(& git -C $work rev-parse HEAD)
  if($LASTEXITCODE -ne 0 -or $head.Trim().ToLowerInvariant() -cne $ExpectedMainSha.ToLowerInvariant()){throw 'WRONG_HEAD'}
  $remote=(& git -C $work ls-remote origin refs/heads/main)
  if($LASTEXITCODE -ne 0 -or !$remote -or (($remote -split '\s+')[0].ToLowerInvariant() -cne $ExpectedMainSha.ToLowerInvariant())){throw 'REMOTE_MAIN_CHANGED'}
  $sot=Join-Path $work 'SOURCE_OF_TRUTH.md'
  if(!(Test-Path $sot) -or !([IO.File]::ReadAllText($sot).Contains($gateText))){throw 'REVIEWED_ROOT_SOT_GATE_MISSING'}
  $pins=Join-Path $work 'src\control-center\mpc010_control_center_preflight.mjs'
  $content=[IO.File]::ReadAllText($pins)
  foreach($k in $expectedFiles.Keys){
    if(!$content.Contains("'"+$k+"'") -and !$content.Contains('"'+$k+'"')){throw 'CANDIDATE_NOT_ALLOWLISTED'}
  }
  return $work
}
function ReadPinnedSource([string]$work,[string]$rel){
  $path=Join-Path $work ($rel.Replace('/','\'))
  AssertNoReparse $path
  $txt=[IO.File]::ReadAllText($path,[Text.Encoding]::UTF8)
  if($txt.Contains([char]0)){throw 'NUL_IN_CANDIDATE'}
  return $txt.Replace(([string][char]13+[string][char]10),[string][char]10)
}
function VerifyCandidate([string]$work) {
  $pinsPath=Join-Path $work 'src\control-center\mpc010_control_center_preflight.mjs'
  $source=[IO.File]::ReadAllText($pinsPath,[Text.Encoding]::UTF8)
  $begin=$source.IndexOf('export const REVIEWED_CANDIDATE_SHA256_20261014',[StringComparison]::Ordinal)
  if($begin -lt 0){throw 'SOURCE_HASH_MAP_MISSING'}
  $end=$source.IndexOf('});',$begin,[StringComparison]::Ordinal)
  if($end -lt 0){throw 'SOURCE_HASH_MAP_INCOMPLETE'}
  $map=$source.Substring($begin,$end-$begin)
  foreach($rel in $expectedFiles.Keys){
    $pattern='"'+[regex]::Escape($rel)+'"\s*:\s*"([A-F0-9]{64})"'
    $match=[regex]::Match($map,$pattern,[Text.RegularExpressions.RegexOptions]::CultureInvariant)
    if(!$match.Success){throw 'CANDIDATE_SHA_NOT_PINNED'}
    $text=ReadPinnedSource $work $rel
    $bytes=[Text.Encoding]::UTF8.GetBytes($text)
    $sha=[Security.Cryptography.SHA256]::Create()
    try{ $hash=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','') }
    finally{ $sha.Dispose() }
    if($hash -cne $match.Groups[1].Value){throw 'CANDIDATE_CONTENT_HASH_DRIFT'}
  }
}
function VerifyHost {
  if([Environment]::MachineName -cne $hostName){throw 'WRONG_HOST'}
  $actual=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  if($actual -cne $admin){throw 'OWNER_ADMIN_REQUIRED'}
  foreach($p in @($install,$stopRoot,$stageRoot)){AssertNoReparse $p}
  if(!(Test-Path -LiteralPath (Join-Path $stopRoot 'STOP') -PathType Leaf) -or
     !(Test-Path -LiteralPath (Join-Path $stopRoot 'AUTOSTART_DISABLED') -PathType Leaf)){throw 'STOP_LATCH_MISSING'}
  if((Get-PSDrive D -ErrorAction Stop).Free -lt 2GB){throw 'BACKUP_DISK_INSUFFICIENT'}
  foreach($key in $oldHashes.Keys) {
    $p=Join-Path $install $key
    AssertNoReparse $p
    if((HashFile $p) -cne $oldHashes[$key]){throw 'EXISTING_VIEWER_SHA_DRIFT'}
  }
  foreach($key in $preserved.Keys){
    AssertNoReparse $key
    if((HashFile $key) -cne $preserved[$key]){throw 'PRESERVED_PYTHON_SHA_DRIFT'}
  }
  foreach($file in @('web\project_tree_view.mjs','web\project_detail_view.mjs','web\project_request_view.mjs',
                     'web\project_supervisor_telemetry.mjs','project_tree_catalogue.py',
                     'owner_request_drafts.py','supervisor_project_activation.py',
                     'docs\project-control\MPC_OWNER_ARCHITECTURE_AND_TASKS_2026-10-11.md')){
     if(Test-Path -LiteralPath (Join-Path $install $file)){throw 'UNEXPECTED_PREEXISTING_TARGET'}
  }
  $workers=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop |
     Where-Object {($_.CommandLine -match 'run-supervisor[.]ps1|single-conversation-cli[.]mjs') -and $_.CommandLine})
  if($workers.Count -gt 0){throw 'BUSINESS_WORKER_PRESENT'}
  $listeners=@(Get-NetTCPConnection -LocalPort 8781 -State Listen -ErrorAction SilentlyContinue)
  if($listeners.Count -gt 1 -or ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -cne '127.0.0.1')){
    throw 'UNEXPECTED_LOCAL_VIEWER_LISTENER'
  }
  if($listeners.Count -eq 1) {
    $pidFound=[int]$listeners[0].OwningProcess
    $proc=Get-CimInstance Win32_Process -Filter ("ProcessId="+$pidFound) -ErrorAction Stop
    if(!$proc -or !$proc.CommandLine -or ($proc.CommandLine.IndexOf((Join-Path $install 'server.py'),[StringComparison]::OrdinalIgnoreCase) -lt 0)){
      throw 'VIEWER_PROCESS_IDENTITY_UNVERIFIED'
    }
  }
}
function SafeSelfTest {
  if($expectedFiles.Count -ne 12 -or $preserved.Count -ne 6 -or $oldHashes.Count -ne 4){
    throw 'SOURCE_ALLOWLIST_MALFORMED'
  }
  foreach($key in $expectedFiles.Keys){
    $v=$expectedFiles[$key]
    if($key -match '\.\.' -or $v -match '\.\.' -or $v.StartsWith('\') -or $v.Contains(':')){throw 'PATH_ESCAPE'}
  }
  Write-Output 'MPC010_H4_VIEWER_SYNTHETIC_SELFTEST_PASS=True'
  Write-Output 'FIELD_APPLY_AUTHORIZED=False'
}
if($Mode -eq 'SelfTest'){ SafeSelfTest; return }
# Field modes remain UNAUTHORIZED until reviewed implementation of backup/apply/
# rollback and a separate SOT gate, even after source PR merge.
if($Mode -in @('Stage','Apply','Rollback')) {
  throw 'MPC010_FIELD_RELEASE_NOT_YET_IMPLEMENTED_OR_AUTHORIZED'
}
if($Mode -ne 'Inspect'){throw 'UNKNOWN_MODE'}
# Inspect is the ONLY currently executable field path; it has no writes.
$work=RequireSource
VerifyHost
VerifyCandidate $work
Write-Output 'MPC010_H4_VIEWER_READONLY_INSPECT_PASS=True'
Write-Output 'FIELD_APPLY_AUTHORIZED=False'
