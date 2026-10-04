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


test("SC-013 observers treat a verified WAIT_OWNER gate as a valid terminal state", async () => {
  const live = await fs.readFile(
    new URL("../.github/scripts/supervisor-sc013-live-production.ps1", import.meta.url),
    "utf8"
  );
  const watchdog = await fs.readFile(
    new URL("../.github/scripts/sc013-runtime-watchdog.ps1", import.meta.url),
    "utf8"
  );

  assert.match(live, /SC013_LIVE_OWNER_GATE_REACHED=True/);
  assert.match(live, /OWNER_INPUT_REQUIRED/);
  assert.match(live, /phase -eq 'WAIT_OWNER'/);
  assert.match(live, /outbound -eq 'VERIFIED'/);

  assert.match(watchdog, /SC013_WATCHDOG_OWNER_GATE_REACHED=True/);
  assert.match(watchdog, /SC013_WATCHDOG_STATUS=OWNER_INPUT_REQUIRED/);
  assert.match(watchdog, /phase -eq 'WAIT_OWNER'/);
  assert.match(watchdog, /outbound -eq 'VERIFIED'/);
});

test("SC-013 live observer accepts exactly one generation advance for lost read-only discovery recovery", async () => {
  const live = await fs.readFile(
    new URL("../.github/scripts/supervisor-sc013-live-production.ps1", import.meta.url),
    "utf8"
  );

  assert.match(live, /SC013_LIVE_BASELINE_KIND=/);
  assert.match(live, /SOURCE_OF_TRUTH_TASK_DISCOVERY/);
  assert.match(live, /SOURCE_OF_TRUTH_NEXT_WORK/);
  assert.match(live, /baselineReadOnlyDiscovery/);
  assert.match(live, /generation -eq \(\$baselineGeneration \+ 1\)/);
  assert.match(live, /SC013_LIVE_GENERATION_ADVANCED_EXACTLY_ONCE=True/);
});
