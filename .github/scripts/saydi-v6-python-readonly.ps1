# SAYDI H4 read-only Python metadata discovery.
# No candidate interpreter invocation, no downloads, writes, ACL or STOP changes.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if([Environment]::MachineName -ne 'DESKTOP-H4A16IL'){throw 'WRONG_H4_HOST'}
if($env:GITHUB_REPOSITORY -ne 'magasincoffee/magasin-supervisor' -or
   $env:GITHUB_EVENT_NAME -ne 'push' -or $env:GITHUB_REF -ne 'refs/heads/main' -or
   $env:GITHUB_ACTOR -ne 'magasincoffee' -or
   $env:GITHUB_TRIGGERING_ACTOR -ne 'magasincoffee' -or
   $env:GITHUB_RUN_ATTEMPT -ne '1'){throw 'WRONG_PROBE_PROVENANCE'}

$candidates=[System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$cacheHits=[System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
function Add-ReadablePython([string]$Location,[bool]$IsCache){
 if([string]::IsNullOrWhiteSpace($Location)){return}
 try{
  $full=[IO.Path]::GetFullPath($Location)
  if($full -match '^[A-Za-z]:\\Users\\' -or $full -match '\\WindowsApps\\'){return}
  if([IO.Path]::GetFileName($full) -ine 'python.exe'){return}
  $item=Get-Item -LiteralPath $full -Force -ErrorAction Stop
  if($item.PSIsContainer -or
    (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){return}
  if($IsCache){[void]$script:cacheHits.Add($full)}
  else{[void]$script:candidates.Add($full)}
 }catch{ return }
}
# Read-only OS command discovery; do not print resolved paths to public CI.
foreach($cmd in @(Get-Command python.exe -All -CommandType Application -ErrorAction SilentlyContinue)){
 if($cmd.Source){Add-ReadablePython $cmd.Source $false}
}
# Check shared SYSTEM Python registration; never browse any user profile.
foreach($keyRoot in @('HKLM:\SOFTWARE\Python\PythonCore',
                      'HKLM:\SOFTWARE\WOW6432Node\Python\PythonCore')){
 foreach($version in @(Get-ChildItem -LiteralPath $keyRoot -ErrorAction SilentlyContinue | Select-Object -First 20)){
  try{
   $info=Get-ItemProperty -LiteralPath (Join-Path $version.PSPath 'InstallPath') -ErrorAction Stop
   if($info.ExecutablePath){Add-ReadablePython $info.ExecutablePath $false}
  }catch{continue}
 }
}
# Existing pre-provisioned Runner toolcache only; do not install anything.
if($env:RUNNER_TOOL_CACHE){
 try{
  $root=[IO.Path]::GetFullPath($env:RUNNER_TOOL_CACHE)
  if($root -notmatch '^[A-Za-z]:\\Users\\'){
   $pythonRoot=Join-Path $root 'Python'
   foreach($ver in @(Get-ChildItem -LiteralPath $pythonRoot -Directory -ErrorAction SilentlyContinue | Select-Object -First 20)){
    Add-ReadablePython (Join-Path $ver.FullName 'x64\python.exe') $true
   }
  }
 }catch{}
}
Write-Output 'H4_PYTHON_PROBE_HOST_OK=True'
Write-Output ('SHARED_PYTHON_METADATA_COUNT='+$candidates.Count)
Write-Output ('TOOLCACHE_PYTHON_METADATA_COUNT='+$cacheHits.Count)
try{
 $d=Get-PSDrive -Name D -ErrorAction Stop
 Write-Output ('D_DRIVE_FREE_GIB='+[math]::Round($d.Free/1GB,1))
}catch{Write-Output 'D_DRIVE_UNAVAILABLE=True'}
Write-Output 'CANDIDATE_PYTHON_EXECUTED=False'
Write-Output 'NO_FILE_OR_ACL_CHANGES=True'
Write-Output 'SUPERVISOR_STOP_UNCHANGED=True'
