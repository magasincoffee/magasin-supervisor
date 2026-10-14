import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const workflow = await readFile(new URL("../.github/workflows/magasin-local-dispatch-receipts.yml", import.meta.url), "utf8");
const reporter = await readFile(new URL("../.github/scripts/magasin-dispatch-reporter.py", import.meta.url), "utf8");

test("H4 dispatch receipt rejects wrong machine before checkout", () => {
  assert.ok(workflow.indexOf("name: Guard actual H4 host before checkout") < workflow.indexOf("uses: actions/checkout@v4"));
  assert.match(workflow, /if \/I not "%COMPUTERNAME%"=="DESKTOP-H4A16IL"/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /github\.event\.issue\.user\.login == 'magasincoffee'/);
  assert.match(workflow, /github\.event\.issue\.user\.id == 191064507/);
});

test("H4 workflow uses CMD and a fixed Python argv, never PowerShell wrapper", () => {
  assert.doesNotMatch(workflow, /shell:\s*powershell/i);
  assert.equal((workflow.match(/shell:\s*cmd/g) || []).length, 3);
  assert.match(workflow, /magasin-dispatch-reporter\.py" --issue-from-env/);
  assert.match(workflow, /sc013-local-30m-tick\.py" --backup-if-stale/);
  assert.doesNotMatch(workflow, /ExecutionPolicy|netsh|taskkill|Stop-Process|Start-Process/);
});

test("manual Issue input is validated inside Python, not injected into CMD", () => {
  assert.match(workflow, /DISPATCH_ISSUE:/);
  assert.doesNotMatch(workflow, /--issue %DISPATCH_ISSUE%|--issue "%DISPATCH_ISSUE%"/);
  assert.match(reporter, /validated_issue_number_from_environment/);
  assert.match(reporter, /re\.fullmatch\(r"\[1-9\]\[0-9\]\{0,8\}"/);
});
