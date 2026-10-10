import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../.github/scripts/sc013-project-hold-stage.ps1", import.meta.url));
const workflowPath = fileURLToPath(new URL("../.github/workflows/sc013-project-hold-stage.yml", import.meta.url));
const markerPath = fileURLToPath(new URL("../.github/sc013-project-hold-stage-request.json", import.meta.url));
const script = await fs.readFile(scriptPath, "utf8");
const workflow = await fs.readFile(workflowPath, "utf8");
const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));

test("SC013 isolated H4 stage is exact-main, owner STOP and immutable source gated", () => {
  for(const requireGate of [
    "WRONG_TARGET_MACHINE","CHECKOUT_SHA_MISMATCH","MAIN_MOVED_RESTAGE_REQUIRED",
    "STAGE_MARKER_CONTRACT_REJECTED","OWNER_STOP_GATES_NOT_ASSERTED",
    "NEW_HELPER_ALREADY_INSTALLED","LIVE_WRAPPER_SHA_CHANGED",
    "WRAPPER_MUST_BE_STOPPED_FOR_STAGE","POWERSHELL_SYNTAX_INVALID",
    "POST_STAGE_PRODUCTION_READBACK_CHANGED","STAGE_ALREADY_EXISTS_REVIEW_BEFORE_RETRY"
  ]) assert.ok(script.includes(requireGate), "missing safety gate: "+requireGate);

  assert.match(script,/Get-FileHash -LiteralPath \$p -Algorithm SHA256/);
  assert.match(script,/Get-CimInstance Win32_Process/);
  assert.match(script,/Get-Content -LiteralPath \$statePath/);
  assert.match(script,/Get-Content -LiteralPath \$controlPath/);
  assert.match(script,/project-fault-containment\.ps1/);
  assert.match(script,/run-supervisor\.ps1/);
  assert.match(script,/expectedOldWrapper='[a-f0-9]{64}'/);
  assert.match(script,/NO_PRODUCTION_MUTATION=True/);
  assert.match(script,/NO_WORKER_START=True/);
  assert.match(script,/NO_OUTBOUND_SEND=True/);
  assert.match(script,/STAGED_ONLY_NOT_INSTALLED/);
});

test("SC013 stage script writes only D: candidate, backup and manifest, never runtime source",()=>{
  assert.match(script,/Join-Path 'D:\\MAGASIN_ROBOTS\\deploy\\sc013-project-hold' \$sha/);
  assert.match(script,/Copy-Item -LiteralPath \$targetWrapper -Destination \$backupWrapper/);
  assert.match(script,/Copy-Item -LiteralPath \$sourceWrapper -Destination \$stagedWrapper/);
  assert.match(script,/Copy-Item -LiteralPath \$sourceHelper -Destination \$stagedHelper/);
  assert.doesNotMatch(script,/Copy-Item.*-Destination \$targetWrapper/);
  assert.doesNotMatch(script,/Copy-Item.*-Destination \$targetHelper/);
  for(const forbidden of [/Stop-Process\b/,/Start-Process\b/,/Remove-Item.*(?:STOP|AUTOSTART_DISABLED)/,/Invoke-RestMethod.*\/api\/supervisor\/control/,/sendComposerInstruction/,/Invoke-SupervisorProjectHold/]){
    assert.doesNotMatch(script,forbidden);
  }
  assert.doesNotMatch(script,/ValidateSet\('Stage','Apply'\)|\b-Mode\s+Apply\b|Mode\s*=\s*'Apply'/);
});

test("SC013 workflow is stage-only and does not inherit general Apply authority",()=>{
  assert.match(workflow,/SC-013 H4 Project Hold STAGE ONLY/);
  assert.match(workflow,/paths:\s*\n\s*- '\.github\/sc013-project-hold-stage-request\.json'/);
  assert.match(workflow,/group: sc013-h4a16il-safe-deploy/);
  assert.match(workflow,/DESKTOP-H4A16IL/);
  assert.match(workflow,/shell: cmd/);
  assert.match(workflow,/for \/f "delims=" %%H in \('hostname'\)/);
  assert.match(workflow,/ExecutionPolicy Bypass -File/);
  assert.doesNotMatch(workflow,/shell: powershell/);
  assert.doesNotMatch(workflow,/Set-ExecutionPolicy|Registry::|REG ADD/i);
  assert.match(workflow,/ExpectedMainSha/);
  assert.match(workflow,/runs-on: \[self-hosted, Windows, X64\]/);
  assert.doesNotMatch(workflow,/options:.*Apply/);
  assert.doesNotMatch(workflow,/-Mode Apply/);
  assert.doesNotMatch(workflow,/start-supervisor|run-supervisor\.ps1.*-Execute/i);
});

test("SC013 marker permits candidate staging only",()=>{
  assert.equal(marker.schema,"MAGASIN_SC013_PROJECT_HOLD_STAGE_V1");
  assert.equal(marker.mode,"STAGE_ONLY");
  assert.equal(marker.owner_intent,"REVIEWED_SOURCE_STAGE_ONLY");
  assert.equal(marker.target,"DESKTOP-H4A16IL");
  assert.equal(marker.apply,false);
  assert.equal(marker.start_robot,false);
});

test("SC013 stage script PowerShell AST has no errors on Windows",{
  skip:process.platform!=="win32"
},()=>{
  const ps="powershell.exe";
  const scriptCommand="$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('"+
    scriptPath.replace(/'/g,"''")+"',[ref]$t,[ref]$e)|Out-Null; if($null -ne $e -and @($e).Count -gt 0){$e|ForEach-Object{Write-Error $_};exit 1};exit 0";
  const r=spawnSync(ps,["-NoProfile","-NonInteractive","-Command",scriptCommand],{encoding:"utf8",timeout:18000});
  assert.equal(r.status,0,r.stderr);
});
