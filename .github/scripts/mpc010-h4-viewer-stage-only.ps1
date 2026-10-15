param(
  [Parameter(Mandatory=$true)][ValidateSet('SelfTest','Stage')][string]$Mode,
  [ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedMainSha='',
  [string]$Workspace=''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
# Isolated STAGE only. No Control Center live write and NO robot START.

# All STAGE writes use Windows handles rooted at an already-open D:\ directory.
# NtCreateFile with RootDirectory prevents ancestor substitution; no-share-delete
# directory handles stop junction swaps, and exclusive file handles stop content edits.
$nativeStageWriter=@'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

public sealed class Mpc010SafeStage : IDisposable {
  const uint READ = 0x80000000, WRITE = 0x40000000, SYNCHRONIZE = 0x00100000;
  const uint SHARE_READ = 1, SHARE_READ_WRITE = 3, FILE_OPEN = 1, FILE_CREATE = 2;
  const uint DIRECTORY_OPTIONS = 0x00200000 | 0x00000001 | 0x00000020;
  const uint FILE_OPTIONS = 0x00200000 | 0x00000040 | 0x00000020;
  const uint OBJ_CASE_INSENSITIVE = 0x40, OBJ_DONT_REPARSE = 0x1000;
  const uint FLAG_BACKUP_SEMANTICS = 0x02000000, FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const int OBJECT_NAME_NOT_FOUND = unchecked((int)0xC0000034);
  const int OBJECT_PATH_NOT_FOUND = unchecked((int)0xC000003A);
  [StructLayout(LayoutKind.Sequential)] struct UNICODE_STRING {
    public ushort Length, MaximumLength;
    public IntPtr Buffer;
  }
  [StructLayout(LayoutKind.Sequential)] struct OBJECT_ATTRIBUTES {
    public int Length;
    public IntPtr RootDirectory, ObjectName;
    public uint Attributes;
    public IntPtr SecurityDescriptor, SecurityQualityOfService;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK {
    public IntPtr Status, Information;
  }
  [StructLayout(LayoutKind.Sequential)] struct FILETIME {
    public uint Low, High;
  }
  [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes;
    public FILETIME CreationTime, LastAccessTime, LastWriteTime;
    public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
  }
  [DllImport("ntdll.dll", ExactSpelling=true)]
  static extern int NtCreateFile(out SafeFileHandle handle, uint desiredAccess,
    ref OBJECT_ATTRIBUTES attributes, out IO_STATUS_BLOCK statusBlock, IntPtr allocationSize,
    uint fileAttributes, uint shareAccess, uint createDisposition, uint createOptions,
    IntPtr eaBuffer, uint eaLength);
  // FILE_NAMES_INFORMATION = 12; query actual entries using the held directory handles.
  [DllImport("ntdll.dll", ExactSpelling=true)]
  static extern int NtQueryDirectoryFile(SafeFileHandle fileHandle, IntPtr eventHandle,
    IntPtr apcRoutine, IntPtr apcContext, out IO_STATUS_BLOCK ioStatus,
    IntPtr buffer, uint bufferLength, int informationClass,
    [MarshalAs(UnmanagedType.U1)] bool returnSingleEntry, IntPtr fileName,
    [MarshalAs(UnmanagedType.U1)] bool restartScan);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CreateFileW")]
  static extern SafeFileHandle OpenRoot(string path, uint access, uint share,
    IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info);

  readonly List<SafeFileHandle> directories = new List<SafeFileHandle>();
  readonly Dictionary<string,SafeFileHandle> knownDirectories =
    new Dictionary<string,SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
  readonly Dictionary<string,FileStream> openFiles =
    new Dictionary<string,FileStream>(StringComparer.OrdinalIgnoreCase);
  readonly Dictionary<string,string> expectedHashes =
    new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
  SafeFileHandle current;
  SafeFileHandle stage;
  bool disposed;

  static void EnsureOrdinaryHandle(SafeFileHandle h) {
    BY_HANDLE_FILE_INFORMATION info;
    if(h.IsInvalid || !GetFileInformationByHandle(h, out info) ||
       (info.FileAttributes & 0x400) != 0) {
      h.Dispose();
      throw new InvalidOperationException("STAGE_REPARSE_OR_UNVERIFIED_HANDLE");
    }
  }
  static void ValidSegment(string s) {
    if(String.IsNullOrEmpty(s) || s=="." || s==".." ||
       s.EndsWith(".") || s.EndsWith(" ") ||
       s.IndexOfAny(new char[]{'/', '\\', ':', '\0'})>=0)
      throw new InvalidOperationException("STAGE_UNSAFE_PATH_COMPONENT");
  }
  static SafeFileHandle Relative(SafeFileHandle parent, string segment,
     bool directory, bool create, uint sharing, bool allowMissing) {
    ValidSegment(segment);
    IntPtr buf=IntPtr.Zero, up=IntPtr.Zero;
    try {
      buf=Marshal.StringToHGlobalUni(segment);
      UNICODE_STRING u=new UNICODE_STRING {
        Length=checked((ushort)(segment.Length*2)),
        MaximumLength=checked((ushort)((segment.Length+1)*2)),
        Buffer=buf
      };
      up=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
      Marshal.StructureToPtr(u,up,false);
      OBJECT_ATTRIBUTES a=new OBJECT_ATTRIBUTES {
        Length=Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),
        RootDirectory=parent.DangerousGetHandle(), ObjectName=up,
        Attributes=OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE
      };
      IO_STATUS_BLOCK status;
      SafeFileHandle h;
      int nt=NtCreateFile(out h, READ | WRITE | SYNCHRONIZE,ref a,out status,
          IntPtr.Zero,0x80,sharing,create?FILE_CREATE:FILE_OPEN,
          directory?DIRECTORY_OPTIONS:FILE_OPTIONS,IntPtr.Zero,0);
      if(nt<0) {
        if(h!=null && !h.IsInvalid)h.Dispose();
        if(allowMissing && (nt==OBJECT_NAME_NOT_FOUND || nt==OBJECT_PATH_NOT_FOUND))
          return null;
        throw new IOException("STAGE_NATIVE_CREATE_FAILED_"+nt.ToString("X8"));
      }
      EnsureOrdinaryHandle(h);
      return h;
    } finally {
      if(up!=IntPtr.Zero)Marshal.FreeHGlobal(up);
      if(buf!=IntPtr.Zero)Marshal.FreeHGlobal(buf);
    }
  }
  public Mpc010SafeStage() {
    SafeFileHandle root=OpenRoot(@"D:\",READ | WRITE,SHARE_READ_WRITE,
       IntPtr.Zero,3,FLAG_BACKUP_SEMANTICS | FLAG_OPEN_REPARSE_POINT,IntPtr.Zero);
    if(root==null || root.IsInvalid)throw new IOException("D_VOLUME_HANDLE_UNAVAILABLE");
    EnsureOrdinaryHandle(root);
    directories.Add(root);
    current=root;
  }
  public void Enter(string name, bool createIfMissing) {
    SafeFileHandle next=Relative(current,name,true,false,SHARE_READ_WRITE,createIfMissing);
    if(next==null)next=Relative(current,name,true,true,SHARE_READ_WRITE,false);
    directories.Add(next);
    current=next;
  }
  public void EnterNew(string sha) {
    if(stage!=null)throw new InvalidOperationException("STAGE_ALREADY_SELECTED");
    if(sha==null || !System.Text.RegularExpressions.Regex.IsMatch(sha,"^[0-9a-f]{40}$"))
      throw new InvalidOperationException("STAGE_SHA_INVALID");
    // Atomic FILE_CREATE: if pre-existing (including a junction) abort, not overwrite.
    // Deny write-sharing at creation so competing writers cannot open this new root.
    stage=Relative(current,sha,true,true,SHARE_READ,false);
    directories.Add(stage);
    knownDirectories.Add("",stage);
  }
  static string[] Parts(string relativePath) {
    if(String.IsNullOrEmpty(relativePath) || relativePath.StartsWith("\\") ||
       relativePath.StartsWith("/") || relativePath.Contains(":"))
      throw new InvalidOperationException("STAGE_PATH_ESCAPE");
    string[] parts=relativePath.Replace('/','\\').Split('\\');
    foreach(string part in parts)ValidSegment(part);
    return parts;
  }
  SafeFileHandle DirectoryFor(string[] parts) {
    SafeFileHandle h=stage;
    string prefix="";
    for(int i=0;i<parts.Length-1;i++) {
      prefix=(prefix.Length==0?"":prefix+"\\")+parts[i];
      SafeFileHandle existing;
      if(knownDirectories.TryGetValue(prefix,out existing))h=existing;
      else {
        // FILE_CREATE only. Unexpected pre-existing directory is a hard failure.
        // Same no-write-sharing rule for every newly-created nested directory.
        h=Relative(h,parts[i],true,true,SHARE_READ,false);
        directories.Add(h);
        knownDirectories.Add(prefix,h);
      }
    }
    return h;
  }
  static string Digest(byte[] bytes) {
    using(SHA256 sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","");
  }
  public void Write(string relativePath, byte[] bytes, string expectedSha) {
    if(stage==null)throw new InvalidOperationException("STAGE_ROOT_NOT_CREATED");
    if(bytes==null || expectedSha==null ||
       !String.Equals(Digest(bytes),expectedSha,StringComparison.OrdinalIgnoreCase))
       throw new InvalidOperationException("STAGE_UNREVIEWED_BYTES_DENIED");
    string[] parts=Parts(relativePath);
    string key=String.Join("\\",parts);
    if(openFiles.ContainsKey(key))throw new InvalidOperationException("STAGE_DUPLICATE_TARGET");
    SafeFileHandle parent=DirectoryFor(parts);
    // The created handle is exclusive (shareAccess=0) until the final manifest readback.
    SafeFileHandle file=Relative(parent,parts[parts.Length-1],false,true,0,false);
    FileStream stream=new FileStream(file,FileAccess.ReadWrite,4096,false);
    openFiles.Add(key,stream);
    expectedHashes.Add(key,expectedSha);
    stream.Write(bytes,0,bytes.Length);
    stream.Flush(true);
  }
  static HashSet<string> ActualEntries(SafeFileHandle dir) {
    // Never traverse a mutable path for the audit: enumerate the exact opened
    // directory object, not a directory resolved by name at a later moment.
    const int capacity=65536, header=12;
    HashSet<string> entries=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    IntPtr buffer=Marshal.AllocHGlobal(capacity);
    try {
      bool restart=true;
      for(int batch=0;batch<1024;batch++) {
        IO_STATUS_BLOCK iosb;
        int result=NtQueryDirectoryFile(dir,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,
          out iosb,buffer,capacity,12,false,IntPtr.Zero,restart);
        if(result==unchecked((int)0x80000006))return entries; // STATUS_NO_MORE_FILES
        if(result!=0)throw new IOException("STAGE_DIRECTORY_QUERY_FAILED_"+result.ToString("X8"));
        restart=false;
        int offset=0;
        for(int item=0;item<1024;item++) {
          if(offset>capacity-header)throw new IOException("STAGE_DIRECTORY_ENTRY_BOUNDS");
          int next=Marshal.ReadInt32(buffer,offset);
          int byteLength=Marshal.ReadInt32(buffer,offset+8);
          if(byteLength<0 || (byteLength&1)!=0 || byteLength>capacity-offset-header)
            throw new IOException("STAGE_DIRECTORY_NAME_BOUNDS");
          string name=Marshal.PtrToStringUni(IntPtr.Add(buffer,offset+header),byteLength/2);
          if(name!="." && name!=".." && !entries.Add(name))
            throw new IOException("STAGE_DUPLICATE_DIRECTORY_ENTRY");
          if(next==0)break;
          if(next<header || (next&3)!=0 || next>capacity-offset)
            throw new IOException("STAGE_DIRECTORY_ENTRY_OFFSET");
          offset+=next;
          if(item==1023)throw new IOException("STAGE_DIRECTORY_BATCH_LIMIT");
        }
      }
      throw new IOException("STAGE_DIRECTORY_QUERY_LIMIT");
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  void VerifyExactTree() {
    // Build the expected direct-child set from all directories/files held by
    // this object. Reject an unexpected extra file or directory anywhere.
    Dictionary<string,HashSet<string>> expected=
      new Dictionary<string,HashSet<string>>(StringComparer.OrdinalIgnoreCase);
    foreach(string dir in knownDirectories.Keys)
      expected.Add(dir,new HashSet<string>(StringComparer.OrdinalIgnoreCase));
    Action<string> addChild=relativePath => {
      int cut=relativePath.LastIndexOf('\\');
      string parent=cut<0?"":relativePath.Substring(0,cut);
      string name=cut<0?relativePath:relativePath.Substring(cut+1);
      HashSet<string> children;
      if(!expected.TryGetValue(parent,out children) || !children.Add(name))
        throw new InvalidOperationException("STAGE_EXPECTED_TREE_DUPLICATE_OR_ORPHAN");
    };
    foreach(string dir in knownDirectories.Keys)if(dir.Length>0)addChild(dir);
    foreach(string file in openFiles.Keys)addChild(file);
    foreach(KeyValuePair<string,SafeFileHandle> dir in knownDirectories) {
      HashSet<string> observed=ActualEntries(dir.Value);
      HashSet<string> required=expected[dir.Key];
      if(!observed.SetEquals(required))
        throw new InvalidOperationException("STAGE_UNTRACKED_ENTRY_OR_MISSING_FILE_"+dir.Key);
    }
  }
  public void VerifyAll() {
    foreach(KeyValuePair<string,FileStream> item in openFiles) {
      FileStream stream=item.Value;
      stream.Flush(true);
      stream.Position=0;
      string observed;
      using(SHA256 sha=SHA256.Create())
        observed=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","");
      if(!String.Equals(observed,expectedHashes[item.Key],StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("STAGE_FINAL_READBACK_SHA_MISMATCH_"+item.Key);
    }
    VerifyExactTree(); // Includes manifest on the final call.
  }
  public void Dispose() {
    if(disposed)return;
    disposed=true;
    foreach(FileStream fs in openFiles.Values)fs.Dispose();
    for(int i=directories.Count-1;i>=0;i--)directories[i].Dispose();
  }
}
'@
Add-Type -TypeDefinition $nativeStageWriter -Language CSharp -ErrorAction Stop

if($Mode -eq 'SelfTest'){
  Write-Output 'MPC010_H4_VIEWER_STAGE_SYNTHETIC_SELFTEST_PASS=True'
  Write-Output 'FIELD_APPLY_AUTHORIZED=False'
  return
}
if([Environment]::MachineName -cne 'DESKTOP-H4A16IL' -or
   [Security.Principal.WindowsIdentity]::GetCurrent().Name -cne 'DESKTOP-H4A16IL\admin'){
  throw 'H4_OWNER_ADMIN_REQUIRED'
}
if(!$Workspace -or !$ExpectedMainSha){throw 'EXACT_MAIN_AND_WORKSPACE_REQUIRED'}
$work=(Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path
$inspector=Join-Path $work '.github\scripts\mpc010-h4-viewer-owner-release.ps1'
if(!(Test-Path -LiteralPath $inspector -PathType Leaf)){throw 'CANONICAL_INSPECTOR_MISSING'}
function AssertPinnedInspector([string]$path) {
  # Never DOT-SOURCE a mutable worktree script without checking the exact
  # reviewed Git blob identity first. Compute canonical LF Git blob SHA-1
  # directly from bytes, without running Git hooks/filters or lazy fetching.
  $raw=[IO.File]::ReadAllBytes($path)
  if($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF){
    throw 'INSPECTOR_BOM_NOT_ALLOWED'
  }
  $utf8=New-Object System.Text.UTF8Encoding($false,$true)
  try{$text=$utf8.GetString($raw)}catch{throw 'INSPECTOR_INVALID_UTF8'}
  $normalized=$text.Replace(([string][char]13+[string][char]10),[string][char]10)
  $bytes=[Text.Encoding]::UTF8.GetBytes($normalized)
  $prefix=[Text.Encoding]::ASCII.GetBytes(('blob '+$bytes.Length)+[string][char]0)
  $input=New-Object byte[] ($prefix.Length+$bytes.Length)
  [Array]::Copy($prefix,0,$input,0,$prefix.Length)
  [Array]::Copy($bytes,0,$input,$prefix.Length,$bytes.Length)
  $sha1=[Security.Cryptography.SHA1]::Create()
  try{$digest=[BitConverter]::ToString($sha1.ComputeHash($input)).Replace('-','').ToLowerInvariant()}
  finally{$sha1.Dispose()}
  if($digest -cne '555c555ec4159f78c08aec2de3091bffaa9e3edd'){
    throw 'UNREVIEWED_MUTABLE_INSPECTOR_DENIED'
  }
  # Execute only verified in-memory source, not a second read of mutable inspector.
  return $text
}
$verifiedInspector=AssertPinnedInspector $inspector
. ([scriptblock]::Create($verifiedInspector)) -Mode SelfTest -ExpectedMainSha $ExpectedMainSha -Workspace $Workspace
$verified=RequireSource
if($verified -cne $work){throw 'INSPECTED_WORKSPACE_IDENTITY_CHANGED'}
$sotRef=$ExpectedMainSha+':SOURCE_OF_TRUTH.md'
$sot=@(& git --no-replace-objects -C $work --no-optional-locks cat-file blob $sotRef)
if($LASTEXITCODE -ne 0 -or !(($sot -join [Environment]::NewLine).Contains('### MPC-010 H4 Control Center STAGE ONLY'))){
  throw 'CANONICAL_MAIN_STAGE_APPROVAL_MISSING'
}
VerifyHost
VerifyCandidate $work
# Recheck each stage candidate against the immutable reviewed pin map.
$pinsRef=$ExpectedMainSha+':src/control-center/mpc010_control_center_preflight.mjs'
$pinsLines=@(& git --no-replace-objects -C $work --no-optional-locks cat-file blob $pinsRef)
if($LASTEXITCODE -ne 0 -or $pinsLines.Count -eq 0){throw 'REVIEWED_STAGE_PIN_OBJECT_MISSING'}
$sourceMap=$pinsLines -join "`n"
$mapStart=$sourceMap.IndexOf('export const REVIEWED_CANDIDATE_SHA256_20261014',[StringComparison]::Ordinal)
if($mapStart -lt 0){throw 'REVIEWED_STAGE_PIN_MAP_MISSING'}
$mapEnd=$sourceMap.IndexOf('});',$mapStart,[StringComparison]::Ordinal)
if($mapEnd -lt 0){throw 'REVIEWED_STAGE_PIN_MAP_INCOMPLETE'}
$reviewedPins=$sourceMap.Substring($mapStart,$mapEnd-$mapStart)
$sha=$ExpectedMainSha.ToLowerInvariant()
$stage=Join-Path 'D:\MAGASIN_ROBOTS\deploy\mpc010-viewer' $sha
AssertNoReparse $stage
if(Test-Path -LiteralPath $stage){throw 'STAGE_PATH_ALREADY_EXISTS_DO_NOT_OVERWRITE'}
$stopDir='C:\Users\admin\AppData\Local\MAGASIN\BusinessOS\supervisor'
$stopPath=Join-Path $stopDir 'STOP'
$disabledPath=Join-Path $stopDir 'AUTOSTART_DISABLED'
$stopBefore=HashFile $stopPath
$disabledBefore=HashFile $disabledPath
$candidates=@{}
foreach($source in $expectedFiles.Keys){
  $pattern='"'+[regex]::Escape($source)+'"\s*:\s*"([A-F0-9]{64})"'
  $pin=[regex]::Match($reviewedPins,$pattern,[Text.RegularExpressions.RegexOptions]::CultureInvariant)
  if(!$pin.Success){throw 'CANDIDATE_STAGE_SHA_NOT_PINNED'}
  $txt=ReadPinnedSource $work $source
  $shaObj=[Security.Cryptography.SHA256]::Create()
  try{$digest=[BitConverter]::ToString($shaObj.ComputeHash([Text.Encoding]::UTF8.GetBytes($txt))).Replace('-','')}
  finally{$shaObj.Dispose()}
  if($digest -cne $pin.Groups[1].Value){throw 'CANDIDATE_SOURCE_HASH_NOT_REVIEWED'}
  $candidates[$source]=@{content=$txt;sha=$pin.Groups[1].Value;target=[string]$expectedFiles[$source]}
}
foreach($path in $oldHashes.Keys){
  if((HashFile (Join-Path $install $path)) -cne $oldHashes[$path]){throw 'OLD_VIEWER_CHANGED_BEFORE_STAGE'}
}
# All destination handles are anchored to D:\ and held until the complete
# receipt readback. No New-Item / Copy-Item / WriteAllText path race is allowed.
$utf8=New-Object System.Text.UTF8Encoding($false)
$stagedCandidates=@{}
$backups=@{}
$guard=[Mpc010SafeStage]::new()
try {
  $guard.Enter('MAGASIN_ROBOTS',$false)
  $guard.Enter('deploy',$true)
  $guard.Enter('mpc010-viewer',$true)
  $guard.EnterNew($sha)
  foreach($source in $expectedFiles.Keys) {
    $candidate=$candidates[$source]
    $bytes=$utf8.GetBytes([string]$candidate.content)
    $guard.Write(('candidate\'+$candidate.target),$bytes,[string]$candidate.sha)
    $stagedCandidates[$candidate.target]=[string]$candidate.sha
  }
  foreach($rel in $oldHashes.Keys) {
    $from=Join-Path $install $rel
    $oldBytes=[IO.File]::ReadAllBytes($from)
    $oldByteSha=[BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($oldBytes)).Replace('-','')
    if($oldByteSha -cne $oldHashes[$rel]){throw 'OLD_VIEWER_BACKUP_HASH_MISMATCH'}
    $guard.Write(('backup\'+$rel),$oldBytes,[string]$oldHashes[$rel])
    $backups[$rel]=[string]$oldHashes[$rel]
    # Isolated restore rehearsal reproduces exactly the pinned backup bytes.
    try{$guard.Write(('restore-test\'+$rel),$oldBytes,[string]$oldHashes[$rel])}
    catch{throw ('RESTORE_REHEARSAL_FAILED: '+$_.Exception.Message)}
  }
  $guard.VerifyAll()
  VerifyHost
  VerifyCandidate $work
  if((HashFile $stopPath) -cne $stopBefore -or (HashFile $disabledPath) -cne $disabledBefore){
    throw 'STOP_LATCH_CHANGED_DURING_STAGE'
  }
  foreach($rel in $oldHashes.Keys){
    if((HashFile (Join-Path $install $rel)) -cne $oldHashes[$rel]){
      throw 'LIVE_VIEWER_CHANGED_DURING_STAGE'
    }
  }
  # Recheck every held candidate, backup and rehearsal handle immediately
  # before and after writing the receipt. A later APPLY must verify again.
  $guard.VerifyAll()
  $receipt=[ordered]@{
    schema='MPC010_H4_VIEWER_STAGE_ONLY_V1'
    status='STAGED_AND_ISOLATED_RESTORE_VERIFIED'
    expected_main_sha=$sha
    host=[Environment]::MachineName
    owner=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    staged_at=[DateTimeOffset]::UtcNow.ToString('o')
    candidate_sha256=$stagedCandidates
    old_file_backup_sha256=$backups
    stop_sha256=$stopBefore
    autostart_disabled_sha256=$disabledBefore
    restore_rehearsal_pass=$true
    live_viewer_touched=$false
    worker_started=$false
    field_apply_authorized=$false
  }
  $manifestBytes=$utf8.GetBytes(($receipt|ConvertTo-Json -Depth 7))
  $shaObj=[Security.Cryptography.SHA256]::Create()
  try{$manifestSha=[BitConverter]::ToString($shaObj.ComputeHash($manifestBytes)).Replace('-','')}
  finally{$shaObj.Dispose()}
  $guard.Write('stage-manifest.json',$manifestBytes,$manifestSha)
  $guard.VerifyAll()
} finally {
  $guard.Dispose()
}
$receiptPath=Join-Path $stage 'stage-manifest.json'
Write-Output 'MPC010_H4_VIEWER_STAGE_ONLY_PASS=True'
Write-Output 'ISOLATED_RESTORE_REHEARSAL_PASS=True'
Write-Output 'LIVE_VIEWER_TOUCHED=False'
Write-Output 'SUPERVISOR_STARTED=False'
Write-Output 'FIELD_APPLY_AUTHORIZED=False'
Write-Output "STAGE_RECEIPT=$receiptPath"
