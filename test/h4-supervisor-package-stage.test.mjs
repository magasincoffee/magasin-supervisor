import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const ps=fs.readFileSync(new URL("../.github/scripts/sc013-h4-supervisor-package-stage.ps1",import.meta.url),"utf8");
const yaml=fs.readFileSync(new URL("../.github/workflows/sc013-h4a16il-safe-deploy.yml",import.meta.url),"utf8");
const jobs=yaml.split("\n  package-contract:")[0];
const hosted=yaml.split("\n  package-build:")[1]?.split("\n  package-on-h4:")[0]??"";
const h4=yaml.split("\n  package-on-h4:")[1]??"";

test("legacy H4 Stage and Apply retain their exact standalone marker and dispatch contract",()=>{
  assert.match(yaml,/- '.github\/sc013-h4a16il-stage-request.json'/);
  assert.doesNotMatch(yaml,/- '.github\/sc013-h4-supervisor-package-request.json'/);
  assert.match(jobs,/stage-or-apply:[\s\S]*github.event_name == 'push'/);
  assert.match(jobs,/inputs.mode != 'Package'/);
  assert.match(jobs,/sc013-h4a16il-safe-stage-deploy.ps1/);
});
test("Package only fires for explicit workflow_dispatch and hosted build precedes H4",()=>{
  assert.match(hosted,/github.event_name == 'workflow_dispatch' && inputs.mode == 'Package'/);
  assert.match(hosted,/runs-on: windows-latest/);
  assert.match(h4,/github.event_name == 'workflow_dispatch' && inputs.mode == 'Package'/);
  assert.match(h4,/needs: package-build/);
  assert.doesNotMatch(yaml,/'sc013-h4-supervisor-package-request.json'/);
});
test("H4 job verifies hostname and NETWORK SERVICE before downloading, no checkout on H4",()=>{
  const prefix=h4.split("Download trusted same-workflow artifact")[0];
  assert.match(prefix,/DESKTOP-H4A16IL/);
  assert.match(prefix,/S-1-5-20/);
  assert.doesNotMatch(h4,/actions\/checkout@/);
  assert.match(h4,/actions\/download-artifact@v4/);
  assert.match(h4,/D:\\MAGASIN_ROBOTS\\supervisor-reinstall-backup-20261017\\h4-package-stage/);
  assert.match(h4,/NO_C_RUNTIME_MUTATION=True/);
  assert.match(h4,/NO_SUPERVISOR_START=True/);
});
test("Build proves GitHub-hosted runner, checkout SHA, current main, exact allowlist",()=>{
  for(const token of ["BUILDER_MUST_BE_HOSTED","CHECKOUT_SHA_MISMATCH","MAIN_MOVED_OR_UNAPPROVED_SHA","GIT_ARCHIVE_FAILED","HEAD -- src windows package.json README.md SOURCE_OF_TRUTH.md","PACKAGE_TOO_SMALL","RUNNER_TEMP"]) assert.ok(ps.includes(token),token);
  assert.match(hosted,/persist-credentials: false/);
  assert.match(ps,/archive_sha256/);
  assert.match(ps,/MAGASIN_H4_SUPERVISOR_PACKAGE_STAGE_V2/);
});
test("Verify validates private ACL and runner identity without enabling projects",()=>{
  for(const token of ["Assert-PrivateStageRoot","STAGE_ACL_INHERITED","UNEXPECTED_STAGE_ACL_PRINCIPAL","BACKUP_PARENT_ACL_UNSAFE","SHA_STAGE_REPARSE_REJECTED","PACKAGE_READBACK_MISMATCH","SELF_HOSTED_RUNNER_REQUIRED","UNEXPECTED_RUNNER_IDENTITY","NT AUTHORITY\\NETWORK SERVICE"])assert.ok(ps.includes(token),token);
  for(const token of ["Start-Process","Stop-Process","Clear-LifecycleOwnerStopLatches","single-conversation-state.json","install-supervisor.ps1","Invoke-Expression","Set-Acl","icacls.exe"])assert.equal(ps.includes(token),false,token);
  assert.match(ps,/production_runtime_modified=\$false/);
  assert.match(ps,/staging_files_written=\$true/);
});
test("Archive safety checks Windows alias collision, traversal, reparse and digest",()=>{
  for(const token of ["HashSet[string]","OrdinalIgnoreCase","WINDOWS_ARCHIVE_NAME_COLLISION","WINDOWS_UNSAFE_ARCHIVE_COMPONENT","UNSAFE_ARCHIVE_ENTRY","ReparsePoint","archive_entries"])assert.ok(ps.includes(token),token);
  assert.match(yaml,/if-no-files-found: error/);
  assert.match(yaml,/retention-days: 14/);
});
