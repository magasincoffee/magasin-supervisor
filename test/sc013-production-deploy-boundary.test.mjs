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

  // Multiple self-hosted runners may be online. Repository GITHUB_TOKEN cannot
  // manage runner labels, so routing is bounded and fail-closed: a non-target
  // runner dispatches one successor attempt carrying the same authorized SHA,
  // performs no production mutation, and stops. Concurrency keeps attempts
  // sequential and the machine-name guard remains authoritative.
  assert.match(workflow, /deploy_sha:/);
  assert.match(workflow, /routing_attempt:/);
  assert.match(workflow, /MAX_ROUTING_ATTEMPTS:\s*'12'/);
  assert.match(workflow, /TARGET_RETRY_DISPATCHED=True/);
  assert.match(workflow, /TARGET_ROUTING_EXHAUSTED=True/);
  assert.match(workflow, /TARGET_MUTATION_SKIPPED=True/);
  assert.match(workflow, /DEPLOY_WORKFLOW_FILE/);
  assert.match(workflow, /actions\/workflows/);
  assert.match(workflow, /dispatches/);
  assert.match(workflow, /timeout \/t !DELAY_SECONDS! \/nobreak/);
  assert.match(workflow, /shell:\s*cmd/);
  assert.match(workflow, /powershell\.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command/);
  assert.doesNotMatch(workflow, /name: Route to exact production target[\s\S]{0,120}shell:\s*powershell/);
  assert.match(workflow, /runs-on:\s*self-hosted/);
  assert.doesNotMatch(workflow, /pin-target-runner/);
  assert.doesNotMatch(workflow, /actions\/runners/);

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
