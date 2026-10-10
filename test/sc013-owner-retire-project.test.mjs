import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const path=fileURLToPath(new URL("../.github/scripts/sc013-h4-retire-project-binding.ps1",import.meta.url));
const script=await fs.readFile(path,"utf8");
const sot=await fs.readFile(fileURLToPath(new URL("../SOURCE_OF_TRUTH.md",import.meta.url)),"utf8");

test("SC-013 retire is Owner-confirmed, H4 identity-bound and records unknown old delivery",()=>{
 for(const expected of [
 "RETIRE_XSTORE_019J_FROM_SUPERVISOR_ONLY","LOCAL_OWNER_ADMIN_REQUIRED",
 "CANONICAL_SOT_RETIRE_GATE_MISSING","MAIN_MOVED","EXACT_MAIN_MISMATCH",
 "OWNER_STOP_LATCH_MISSING","SUPERVISOR_MUST_BE_STOPPED",
 "NOT_THE_APPROVED_OBSOLETE_PROJECT_STATE","COLD_ARCHIVE",
 "UNKNOWN_OUTCOME_NOT_VERIFIED","ENQUEUED","TASK_STATUS_CHECK",
 "SC013_XSTORE019J_UNLINKED=True","NO_ACTIVE_PROJECT=True",
 "ENQUEUED_OLD_TRANSACTION_COLD_ARCHIVED_NOT_REPLAYED=True",
 "STOP_AUTOSTART_DISABLED_PRESERVED=True"
 ])assert.ok(script.includes(expected),"missing guard: "+expected);
 assert.match(script,/oldCtlHash='[a-f0-9]{64}'/);
 assert.match(script,/oldStateHash='[a-f0-9]{64}'/);
 assert.match(script,/source_of_truth_url=\$null/);
 assert.match(script,/project_id='UNASSIGNED'/);
 assert.match(script,/status='OWNER_UNLINKED_WAIT_NEW_SOT'/);
 assert.match(script,/new_project_selected=\$false/);
 assert.match(script,/old_outbound_replayed=\$false/);
 assert.match(sot,/SC-013 explicit Owner retirement of XSTORE-019J Supervisor binding/);
});

test("SC-013 retired original ledger is copied to cold D: before production mutation",()=>{
 const stageStart=script.indexOf("if($Mode -eq 'Stage'){");
 const copyOriginal=script.indexOf("Copy-Item $state $oldState");
 const verify=script.indexOf("ARCHIVE_ORIGINAL_HASH_MISMATCH");
 const journal=script.indexOf("status='RETIRE_STARTED'");
 const firstAtomic=script.indexOf("[IO.File]::Replace($tmpCtl,$control,$bakCtl,$true)");
 assert.ok(stageStart>=0 && copyOriginal>stageStart && verify>copyOriginal);
 assert.ok(journal>verify && firstAtomic>journal);
 assert.match(script,/sc013-project-retirement/);
 assert.match(script,/SetAccessRuleProtection\(\$true,\$false\)/);
 assert.match(script,/Hash \$oldState/);
 assert.match(script,/Hash \$oldCtl/);
 assert.match(script,/\[IO.File\]::Replace\(\$tmpState,\$state,\$bakState,\$true\)/);
 assert.match(script,/Restore \$control \$oldCtl \$oldCtlHash/);
 assert.match(script,/Restore \$state \$oldState \$oldStateHash/);
});

test("SC-013 retirement never replays historical command or mutates external XSTORE project",()=>{
 for(const forbidden of [
  /Start-Process\b/,/Stop-Process\b/,
  /Remove-Item[^\n]*\$stop\b/,/Remove-Item[^\n]*\$disabled\b/,
  /Set-ExecutionPolicy\b/,/icacls(?:\.exe)?\b/i,
  /sendComposerInstruction/,/reconcileExactOnceOutbound/,
  /magasincoffee\.github\.io[^\n]*(?:git\s+push|Invoke-RestMethod)/,
  /New-ScheduledTask\b/,
  /Clear-Content[^\n]*\$state\b/
 ])assert.doesNotMatch(script,forbidden);
 assert.match(script,/old_delivery='UNKNOWN_IN_COLD_ARCHIVE'/);
 assert.match(script,/old_outbound_replayed=\$false/);
 assert.match(script,/new_project_selected=\$false/);
});

test("SC-013 project-retirement script is valid PowerShell AST on Windows",{
 skip:process.platform!=="win32"
},()=>{
 const q="'"+path.replace(/'/g,"''")+"'";
 const cmd="$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseFile("+q+
  ",[ref]$t,[ref]$e)|Out-Null;if($null -ne $e -and @($e).Count -gt 0){$e|ForEach-Object{Write-Error $_};exit 1};exit 0";
 const p=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",cmd],
  {encoding:"utf8",timeout:18000});
 assert.equal(p.status,0,p.stderr);
});
