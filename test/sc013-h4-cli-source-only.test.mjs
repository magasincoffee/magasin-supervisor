import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(new URL("../.github/scripts/sc013-h4-cli-owner-source-only.ps1", import.meta.url));
const sotFile = fileURLToPath(new URL("../SOURCE_OF_TRUTH.md", import.meta.url));
const script = await fs.readFile(scriptFile, "utf8");
const sot = await fs.readFile(sotFile, "utf8");

test("SC-013 H4 source-only CLI maintenance preserves STOP and historical ENQUEUED", () => {
 for (const evidence of [
  "SC013_CLI_SOURCE_ONLY_APPROVED","OWNER_ADMIN_REQUIRED","REMOTE_MAIN_MISMATCH",
  "OWNER_STOP_MUST_REMAIN_ACTIVE","PENDING_EXACT_ONCE_INCIDENT_CHANGED",
  "SUPERVISOR_WORKER_NOT_OFF","CURRENT_MAIN_SOT_CLI_GATE_NOT_PRESENT",
  "UNREVIEWED_MODULE_DRIFT","LIVE_CLI_SOURCE_CHANGED",
  "classifyEnqueuedCheckForRecoveryReview","SC013_CLI_STAGE_VERIFIED=True",
  "FRESH_STAGE_REQUIRED","STAGE_OR_LIVE_STATE_CHANGED",
  "APPLY_STARTED","CLI_SOURCE_INSTALLED_STOP_PRESERVED","ROLLBACK_HASH_INVALID",
  "SUPERVISOR_NOT_STARTED=True","ENQUEUED_NOT_REPLAYED=True"
 ])assert.ok(script.includes(evidence), "Missing safety contract: "+evidence);
 assert.match(script,/oldSha='[a-f0-9]{64}'/);
 assert.match(script,/source_change_only='runtime\\single-conversation-cli\.mjs'/);
 assert.match(script,/status='STAGED_NOT_INSTALLED'/);
 assert.match(script,/\[IO.File\]::Replace\(\$tmp,\$liveCli,\$localBackup,\$true\)/);
 assert.match(script,/\[IO.File\]::Replace\(\$rb,\$liveCli,\$null,\$true\)/);
 assert.match(script,/if\(\(Test-Path \$tmp\) -or \(Test-Path \$localBackup\)\)/);
 assert.match(sot,/SC-013 source-only H4 CLI recovery deployment gate/);
});

test("SC-013 drift allowlist must exclude only Coordinator-only modules, no unreviewed files",()=>{
 assert.match(script,/coordinator\\sot-adapter\.mjs/);
 assert.match(script,/coordinator\\sot-preflight-cli\.mjs/);
 assert.match(script,/runtime\\external-run-local-observer\.mjs/);
 assert.match(script,/ui\\actions\.mjs/);
 assert.match(script,/ui\\latest-turn\.mjs/);
 assert.match(script,/Sort-Object/);
 assert.match(script,/Get-ChildItem -LiteralPath \$sourceRoot -Recurse -File -Filter '\*\.mjs'/);
 assert.match(script,/Copy-Item -LiteralPath \$liveCli -Destination \$backup/);
 assert.match(script,/Get-FileHash -LiteralPath \$p -Algorithm SHA256/);
 assert.match(script,/& node --check \$candidate/);
});

test("SC-013 CLI source-only installer never starts or alters any worker, browser, owner flag or transaction",()=>{
 for(const disallowed of [
  /Start-Process\b/,/Stop-Process\b/,/New-ScheduledTask\b/,
  /Set-ExecutionPolicy\b/,/Set-Acl\b/,/icacls\.exe\b/i,
  /Set-Content[^\n]*\$state\b/,/Set-Content[^\n]*\$control\b/,
  /Remove-Item[^\n]*\$stop\b/,/Remove-Item[^\n]*\$off\b/,
  /sendComposerInstruction/,/reconcileExactOnceOutbound/,
  /Copy-Item[^\n]*-Destination\s+\$state\b/
 ])assert.doesNotMatch(script,disallowed);
 assert.equal(script.includes("AUTO_REARM"),false);
 assert.equal(script.includes("CLEAR_ENQUEUED"),false);
});

test("SC-013 CLI source-only PowerShell script parses on Windows",{
 skip:process.platform !== "win32"
},()=>{
 const q="'"+scriptFile.replace(/'/g,"''")+"'";
 const cmd="$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseFile("+q+
  ",[ref]$t,[ref]$e)|Out-Null;if($null -ne $e -and @($e).Count -gt 0){$e|ForEach-Object{Write-Error $_};exit 1};exit 0";
 const p=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",cmd],{encoding:"utf8",timeout:20000});
 assert.equal(p.status,0,p.stderr);
});
