import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const ps = fs.readFileSync(new URL("../.github/scripts/sc013-h4-supervisor-package-stage.ps1", import.meta.url),"utf8");
const yaml = fs.readFileSync(new URL("../.github/workflows/sc013-h4a16il-safe-deploy.yml", import.meta.url),"utf8");

test("package flow targets only H4 and checks identity before checkout",()=>{
  assert.match(yaml,/package-on-h4:[\s\S]*?runs-on: \[self-hosted, Windows, X64\]/);
  const segment=yaml.slice(yaml.indexOf("  package-on-h4:"));
  assert.ok(segment.indexOf("Reject wrong host BEFORE checkout") < segment.indexOf("actions\/checkout@v4"));
  assert.match(segment,/DESKTOP-H4A16IL/);
  assert.match(ps,/\[Environment\]::MachineName -ne 'DESKTOP-H4A16IL'/);
  assert.match(ps,/GITHUB_RUNNER_CONTEXT_REQUIRED/);
});
test("package requires exact current main SHA and closed file allowlist",()=>{
  for(const token of ["CHECKOUT_SHA_MISMATCH","MAIN_AUTHORITY_UNAVAILABLE","MAIN_MOVED_OR_UNAPPROVED_SHA","GIT_NO_REPLACE_OBJECTS","git -C $workspace","--format=zip","HEAD -- src windows package.json README.md SOURCE_OF_TRUTH.md","UNSAFE_ARCHIVE_ENTRY","PACKAGE_READBACK_MISMATCH"]) assert.ok(ps.includes(token),token);
  assert.match(yaml,/persist-credentials: false/);
  assert.match(ps,/archive_sha256/);
});
test("package stage is never runtime install, worker start, or Owner latch removal",()=>{
  for(const token of ["Start-Process","Stop-Process","Clear-LifecycleOwnerStopLatches","AUTOSTART_DISABLED","single-conversation-state.json","install-supervisor.ps1","Remove-Item $root","Invoke-Expression","Set-Acl","icacls"]) {
    assert.equal(ps.includes(token),false,token);
  }
  assert.match(ps,/NO_PRODUCTION_INSTALL=True/);
  assert.match(ps,/supervisor_started=\$false/);
  assert.match(ps,/control_or_state_modified=\$false/);
});
test("runner package and existing patch apply are isolated triggers",()=>{
  const stage=yaml.split("  stage-or-apply:")[1].split("  package-contract:")[0];
  const pack=yaml.split("  package-on-h4:")[1];
  assert.match(stage,/inputs.mode != 'Package'/);
  assert.match(stage,/sc013-h4a16il-stage-request.json/);
  assert.doesNotMatch(stage,/sc013-h4-supervisor-package-request.json/);
  assert.match(pack,/inputs.mode == 'Package'/);
  assert.match(pack,/sc013-h4-supervisor-package-request.json/);
  assert.doesNotMatch(pack,/sc013-h4a16il-stage-request.json/);
  assert.match(yaml,/if-no-files-found: error/);
  assert.match(yaml,/retention-days: 14/);
});
test("runner writes package only under pinned D stage with symlink protection",()=>{
  assert.ok(ps.includes("D:\\MAGASIN_ROBOTS\\control-center\\state"));
  assert.match(ps,/ReparsePoint/);
  assert.match(ps,/STAGE_ALREADY_EXISTS_DO_NOT_OVERWRITE/);
  assert.doesNotMatch(ps,/New-Item[^\n]*C:/);
});
