# SAYDI H4 read-only shared Python inventory; never launches Python.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ([Environment]::MachineName -ne 'DESKTOP-H4A16IL') { throw 'WRONG_H4_HOST' }
if ($env:GITHUB_REPOSITORY -ne 'magasincoffee/magasin-supervisor') { throw 'WRONG_REPO' }
Write-Output 'H4_PYTHON_PROBE_HOST_OK=True'
Write-Output ('H4_PYTHON_PROBE_SERVICE_USER=' + [Environment]::UserName)
$candidates=@(
 'C:\Program Files\Python312\python.exe',
 'C:\Program Files\Python311\python.exe',
 'C:\Python312\python.exe',
 'D:\Python312\python.exe',
 'D:\SAYDI_V6\python\python.exe'
)
foreach($n in 0..($candidates.Count-1)) {
 try {
   $entry=Get-Item -LiteralPath $candidates[$n] -ErrorAction Stop
   $safe=(!$entry.PSIsContainer -and (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0))
   Write-Output ('PYTHON_SHARED_'+$n+'=' + $(if($safe){'READABLE'}else{'UNSAFE'}))
 } catch {
   Write-Output ('PYTHON_SHARED_'+$n+'=UNAVAILABLE')
 }
}
$root='D:\SAYDI_V6'
try {
 $entry=Get-Item -LiteralPath $root -ErrorAction Stop
 $safe=($entry.PSIsContainer -and (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0))
 Write-Output ('V6_D_ROOT=' + $(if($safe){'READABLE'}else{'UNSAFE'}))
} catch { Write-Output 'V6_D_ROOT=ABSENT_OR_DENIED' }
Write-Output 'PYTHON_EXECUTION_NOT_ATTEMPTED=True'
Write-Output 'NO_FILE_OR_ACL_CHANGES=True'
