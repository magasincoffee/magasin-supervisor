import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repoFile=(relative)=>fileURLToPath(new URL("../"+relative,import.meta.url));
const stage=await fs.readFile(repoFile(".github/scripts/sc013-project-hold-stage.ps1"),"utf8");
const workflow=await fs.readFile(repoFile(".github/workflows/sc013-project-hold-stage.yml"),"utf8");
const sot=await fs.readFile(repoFile("SOURCE_OF_TRUTH.md"),"utf8");
const request=JSON.parse(await fs.readFile(repoFile(".github/sc013-project-hold-stage-request.json"),"utf8"));

test("SC013 Owner minimal ACL stage grants no runtime write or hidden authority",()=>{
 assert.match(sot,/Owner-approved minimal Windows stage access/);
 assert.match(sot,/NETWORK SERVICE/);
 assert.match(sot,/ReadAttributes/);
 assert.match(sot,/single-conversation-state\.json/);
 assert.match(sot,/AUTOSTART_DISABLED/);
 assert.match(sot,/do NOT elevate to SYSTEM\/admin/i);
 assert.match(sot,/original ACL SDDL/);
 assert.match(stage,/expectedOldWrapper='[0-9a-f]{64}'/);
 assert.match(stage,/if\(!\(Test-Path \$stopPath -PathType Leaf\)/);
 assert.match(stage,/if\(\(Hash \$targetWrapper\) -cne \$expectedOldWrapper\)/);
 assert.match(stage,/if\(Test-Path \$targetHelper\)/);
 assert.match(stage,/STAGED_ONLY_NOT_INSTALLED/);
 assert.match(stage,/NO_PRODUCTION_MUTATION=True/);
 for(const unsafe of [/icacls(?:\.exe)?\b/i,/Set-Acl\b/i,/takeown(?:\.exe)?\b/i,/Remove-Item.*STOP/,/Stop-Process\b/i,/Start-Process\b/i]){
  assert.doesNotMatch(stage,unsafe);
  assert.doesNotMatch(workflow,unsafe);
 }
 assert.match(workflow,/shell: cmd/);
 assert.match(workflow,/ExpectedMainSha/);
 assert.doesNotMatch(workflow,/shell: powershell/);
 assert.equal(request.mode,"STAGE_ONLY");
 assert.equal(request.apply,false);
 assert.equal(request.start_robot,false);
 assert.equal(request.stage_attempt,3);
 assert.equal(request.previous_failed_run_id,38038954381);
});

test("SC013 source staging does not read Chrome credentials or alter transaction state",()=>{
 const blockedPatterns=[
  /Copy-Item[^\n]*-Destination[^\n]*\$targetWrapper/,
  /Copy-Item[^\n]*-Destination[^\n]*\$targetHelper/,
  /writeSingleConversationState/,
  /START_ROBOT=True/,
  /-Mode\s+Apply\b/,
  /supervisor\.pid[^\n]*Set-Content/
 ];
 for(const p of blockedPatterns)assert.doesNotMatch(stage,p);
 assert.match(stage,/Get-FileHash/);
 assert.match(stage,/backupWrapper/);
 assert.match(stage,/owner_stop_modified=\$false/);
 assert.match(stage,/outbound_modified=\$false/);
 assert.match(stage,/observed_outbound_state='ENQUEUED'/);
});
