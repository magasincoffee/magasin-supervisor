import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const workflowUrl = new URL(
  "../.github/workflows/supervisor-control-panel-desktop-4k7im13.yml",
  import.meta.url
);
const sotUrl = new URL("../SOURCE_OF_TRUTH.md", import.meta.url);

test("SC-013 production deploy requires explicit release authority", async () => {
  const workflow = await fs.readFile(workflowUrl, "utf8");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /\.github\/production-deploy-request\.json/);

  // Ordinary implementation/CI changes must never touch the installed Robot.
  assert.doesNotMatch(workflow, /- src\/\*\*/);
  assert.doesNotMatch(workflow, /- windows\/\*\*/);
  assert.doesNotMatch(workflow, /- package\.json/);
  assert.doesNotMatch(
    workflow,
    /- \.github\/scripts\/update-latest-clean-old\.ps1/
  );

  // One explicit request must not fan out into duplicate target mutations.
  assert.doesNotMatch(workflow, /matrix:/);
  assert.doesNotMatch(workflow, /slot:\s*\[1,\s*2\]/);
  assert.match(workflow, /TARGET_MUTATION_SKIPPED=True/);
  assert.match(workflow, /exit \/b 1/);

  // GitHub may have multiple online self-hosted runners. The production deploy
  // must first bind a custom label to the exact runner name, then pin the only
  // self-hosted mutation job to that label. Generic self-hosted routing alone
  // is not production-safe.
  assert.match(workflow, /TARGET_RUNNER_NAME: DESKTOP-4K7IM13/);
  assert.match(workflow, /TARGET_RUNNER_LABEL: magasin-target-desktop-4k7im13/);
  assert.match(workflow, /actions:\s*write/);
  assert.match(workflow, /actions\/runners/);
  assert.match(workflow, /TARGET_RUNNER_LABEL_BOUND=True/);
  assert.match(
    workflow,
    /runs-on:[\s\S]*self-hosted[\s\S]*magasin-target-desktop-4k7im13/
  );
  assert.doesNotMatch(workflow, /deploy-panel:[\s\S]{0,200}runs-on:\s*self-hosted\s*$/m);

  // Deployment may intentionally close Chrome; diagnostic is a separate,
  // read-only lifecycle operation after runtime is started again.
  assert.doesNotMatch(
    workflow,
    /supervisor-sc013-rebind-diagnostic\.ps1/
  );
});

test("SC-013 Source of Truth locks CI/deploy separation", async () => {
  const sot = await fs.readFile(sotUrl, "utf8");

  assert.match(
    sot,
    /ordinary source, test, documentation, or Windows launcher merges MUST be CI-only/
  );
  assert.match(
    sot,
    /production deployment to `DESKTOP-4K7IM13` MUST require explicit release authority/
  );
  assert.match(
    sot,
    /deployment and read-only diagnosis are separate lifecycle operations/
  );
});
