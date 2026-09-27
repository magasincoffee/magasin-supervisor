import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("PE-007 live qualification proves bounded reject correction and terminal done", async () => {
  const source = await fs.readFile(
    new URL("../.github/scripts/supervisor-pe007-live-qualification.mjs", import.meta.url),
    "utf8"
  );

  assert.match(source, /PE-007 LIVE QUALIFICATION ONLY/);
  assert.match(source, /ChatGPT Work mode/);
  assert.match(source, /expectedActions: \["reject"\]/);
  assert.match(source, /PLANNER_REJECT_CORRECTION/);
  assert.match(source, /expectedActions: \["done"\]/);
  assert.match(source, /PLANNER_DONE/);
  assert.match(source, /cycleSendCount !== 4/);
  assert.match(source, /matching_user_turn_required: true/);
  assert.match(source, /production_state_mutated: false/);
  assert.match(source, /production_targets_mutated: false/);
  assert.doesNotMatch(source, /lane-registry\.json/);
  assert.doesNotMatch(source, /lanes\.json/);
  assert.doesNotMatch(source, /brain_url/);
  assert.doesNotMatch(source, /work_url/);
});

test("PE-007 workflow is isolated, target guarded, and does not cut over production", async () => {
  const workflow = await fs.readFile(
    new URL("../.github/workflows/supervisor-pe007-live-qualification.yml", import.meta.url),
    "utf8"
  );
  const wrapper = await fs.readFile(
    new URL("../.github/scripts/supervisor-pe007-live-qualification.ps1", import.meta.url),
    "utf8"
  );

  assert.match(workflow, /runs-on: self-hosted/);
  assert.match(workflow, /DESKTOP-4K7IM13/);
  assert.match(workflow, /supervisor-pe007-live-qualification\.ps1/);
  assert.doesNotMatch(workflow, /start-supervisor\.ps1/);
  assert.doesNotMatch(workflow, /repair-supervisor\.ps1/);
  assert.doesNotMatch(workflow, /stop-supervisor\.ps1/);

  assert.match(wrapper, /PE007_QUAL_TARGET_MATCH=False/);
  assert.match(wrapper, /Get-LifecycleRobotChrome/);
  assert.match(wrapper, /SUPERVISOR_PE007_CDP_URL/);
  assert.match(wrapper, /PE007_QUAL_STATE_ROOT_BINDING_MUTATED=False/);
  assert.doesNotMatch(wrapper, /Set-SupervisorStateRootBinding/);
});

test("PE-007 Node qualifier passes syntax check", () => {
  const scriptPath = fileURLToPath(
    new URL("../.github/scripts/supervisor-pe007-live-qualification.mjs", import.meta.url)
  );
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ["--check", scriptPath], { stdio: "pipe" });
  });
});
