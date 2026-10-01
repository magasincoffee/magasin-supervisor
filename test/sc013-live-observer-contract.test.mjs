import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const workflowUrl = new URL(
  "../.github/workflows/supervisor-sc013-live-production.yml",
  import.meta.url
);

test("SC-013 live first-failure observer is explicit, pre-armed, and single-attempt", async () => {
  const workflow = await fs.readFile(workflowUrl, "utf8");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /\.github\/sc013-live-observation-request\.json/);
  assert.match(workflow, /cancel-in-progress: true/);

  assert.match(workflow, /^  attempt:\s*$/m);
  assert.doesNotMatch(workflow, /attempt-1:/);
  assert.doesNotMatch(workflow, /attempt-2:/);
  assert.doesNotMatch(workflow, /qualification-authority:/);
  assert.doesNotMatch(workflow, /matrix:/);

  assert.match(workflow, /-OwnerStartWaitSeconds 900/);
  assert.match(workflow, /-BlockedGraceSeconds 150/);
  assert.match(workflow, /-MaxObserveSeconds 3600/);
  assert.match(workflow, /supervisor-sc013-live-production\.ps1/);
});
