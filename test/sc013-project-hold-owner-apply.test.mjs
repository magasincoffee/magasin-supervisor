import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const file=fileURLToPath(new URL("../.github/scripts/sc013-project-hold-owner-apply.ps1",import.meta.url));
const body=await fs.readFile(file,"utf8");
const sot=await fs.readFile(fileURLToPath(new URL("../SOURCE_OF_TRUTH.md",import.meta.url)),"utf8");
const onWindows=process.platform==="win32";

test("SC013 Owner-attended APPLY must use exact main and STOP-preserving gates",()=>{
 const must=["SC013_SOURCE_ONLY_APPLY_APPROVED","OWNER_ADMIN_IDENTITY_REQUIRED","WRONG_MACHINE",
  "MAIN_SHA_MOVED_RESTART_STAGE","CURRENT_MAIN_SOT_APPLY_GATE_MISSING","REVIEWED_SOURCE_CONTRACT_MISSING",
  "POWERSHELL_SOURCE_SYNTAX_ERROR","OWNER_STOP_NOT_ASSERTED","AMBIGUOUS_OUTBOUND_STATE_CHANGED",
  "LIVE_SUPERVISOR_PROCESS_NOT_STOPPED","STAGE_EXISTS_DO_NOT_OVERWRITE",
  "STAGE_OR_PRODUCTION_CHANGED","APPLY_STARTED","SOURCE_INSTALLED_STOP_PRESERVED",
  "NO_PRODUCTION_MUTATION=True","SUPERVISOR_NOT_STARTED=True","ENQUEUED_NOT_REPLAYED=True"];
 for(const a of must) assert.ok(body.includes(a),"missing gate "+a);
 assert.match(body,/C:\\Users\\admin\\AppData\\Local\\MAGASIN\\BusinessOS\\supervisor/);
 assert.match(body,/D:\\MAGASIN_ROBOTS\\deploy\\sc013-project-hold-owner-apply/);
 assert.match(body,/oldWrapperSha='[a-f0-9]{64}'/);
 assert.match(body,/if\(Test-Path \$liveHelper\)/);
 assert.match(body,/\[IO.File\]::Replace\(\$tmpWrapper,\$liveWrapper,\$localBackup,\$true\)/);
 assert.match(body,/\[IO.File\]::Replace\(\$rollbackTmp,\$liveWrapper,\$null,\$true\)/);
 assert.match(body,/UNKNOWN_HELPER_REFUSE_DELETE/);
 assert.match(sot,/SC-013 H4 Owner-admin source APPLY for staged project fault containment/);
});

test("SC013 source-only APPLY cannot start any worker or modify owner STOP and transaction state",()=>{
 for(const pattern of [
  /Stop-Process\b/,/Start-Process\b/,/New-ScheduledTask\b/,
  /Remove-Item[^\n]*(?:\$stopPath|\$disabledPath)/,
  /Set-ExecutionPolicy/,/icacls\.exe\b/i,/takeown\.exe\b/i,/Set-Acl\b/,
  /writeSingleConversationState/,/sendComposerInstruction/,
  /Set-Content[^\n]*\$statePath/,/Set-Content[^\n]*\$controlPath/
 ])assert.doesNotMatch(body,pattern);
 assert.match(body,/CheckProductionSafety/);
 assert.match(body,/Copy-Item -LiteralPath \$liveWrapper -Destination \$backupWrapper/);
 assert.match(body,/Hash \$statePath/);
 assert.match(body,/Hash \$disabledPath/);
});

test("SC013 Windows PowerShell installer AST parses",{
 skip:!onWindows
},()=>{
 const quoted="'"+file.replace(/'/g,"''")+"'";
 const cmd="$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseFile("+quoted+
  ",[ref]$t,[ref]$e)|Out-Null;if($null -ne $e -and @($e).Count -gt 0){$e|ForEach-Object{Write-Error $_};exit 1};exit 0";
 const r=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",cmd],{encoding:"utf8",timeout:18000});
 assert.equal(r.status,0,r.stderr);
});

test("SC013 atomic replace and rollback preserve original bytes on disposable fixture",{
 skip:!onWindows
},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"sc013-atomic-fixture-"));
 const old=path.join(dir,"old.ps1");
 const fresh=path.join(dir,"fresh.ps1");
 const backup=path.join(dir,"backup.ps1");
 const restore=path.join(dir,"restore.ps1");
 const q=(s)=>"'"+s.replace(/'/g,"''")+"'";
 try{
  await fs.writeFile(old,"# ORIGINAL SC013 SOURCE\n");
  await fs.writeFile(fresh,"# QUALIFIED SC013 PATCH\n");
  const cmd=[
   "[IO.File]::Replace("+q(fresh)+","+q(old)+","+q(backup)+",$true)",
   "$copy=Get-Content -LiteralPath "+q(old)+" -Raw",
   "if($copy -notmatch 'QUALIFIED'){throw 'NOT_REPLACED'}",
   "Copy-Item -LiteralPath "+q(backup)+" -Destination "+q(restore),
   "[IO.File]::Replace("+q(restore)+","+q(old)+",$null,$true)",
   "if((Get-Content -LiteralPath "+q(old)+" -Raw) -notmatch 'ORIGINAL'){throw 'NOT_ROLLED_BACK'}",
   "Write-Output 'ATOMIC_REPLACE_ROLLBACK_PASS=True'"
  ].join(";");
  const r=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",cmd],{encoding:"utf8",timeout:18000});
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/ATOMIC_REPLACE_ROLLBACK_PASS=True/);
  assert.equal(await fs.readFile(old,"utf8"),"# ORIGINAL SC013 SOURCE\n");
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
