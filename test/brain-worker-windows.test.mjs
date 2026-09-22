import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("Windows wrapper selects THREE_LANE_V1 from source of truth", async () => {
  const source = await fs.readFile(
    new URL("../windows/run-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /THREE_LANE_V1/);
  assert.match(source, /three-lane-cli\.mjs/);
  assert.match(source, /BRAIN_WORKER_V1/);
  assert.match(source, /brain-worker-cli\.mjs/);
  assert.match(source, /supervisor-loop-cli\.mjs/);
});

test("wrapper preserves Three-Lane mode across transient source-of-truth fetch failures", async () => {
  const source = await fs.readFile(
    new URL("../windows/run-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /lane-status\.json/);
  assert.match(source, /lanes\.json/);
  assert.match(source, /\$runtimeMode = 'THREE_LANE_V1'/);
  assert.match(source, /retrying without mode downgrade/);
});

test("installer kills old Three-Lane node runtime during upgrade without clearing Owner STOP", async () => {
  const source = await fs.readFile(
    new URL("../windows/install-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /three-lane-cli/);
  assert.match(source, /brain-worker-cli/);
  assert.match(source, /supervisor-loop-cli/);
  assert.match(source, /OWNER_STOP_PRESERVED_DURING_INSTALL=True/);
  assert.doesNotMatch(source, /Remove-Item \$stopFile -Force/);
});

test("auto-upgrade validates THREE_LANE_V1 and lifecycle truth", async () => {
  const source = await fs.readFile(
    new URL("../.github/workflows/supervisor-autostart-install.yml", import.meta.url),
    "utf8"
  );

  assert.match(source, /THREE_LANE_V1/);
  assert.match(source, /lane_count/);
  assert.match(source, /Brain autodiscovery must be disabled/);
  assert.match(source, /PROJECT_ADAPTER_LOCAL_CHECK=True/);
  assert.match(source, /Get-LifecycleOwnerStopState/);
  assert.match(source, /Get-EnabledLaneCount/);
  assert.match(source, /Get-LifecycleProcessTruth/);
  assert.match(source, /TARGET_URLS_UNCHANGED=True/);
});

test("auto-upgrade derives Three-Lane runtime version and requires three local lanes", async () => {
  const source = await fs.readFile(
    new URL("../.github/workflows/supervisor-autostart-install.yml", import.meta.url),
    "utf8"
  );

  assert.match(source, /Get-SupervisorRuntimeVersion/);
  assert.match(source, /SUPERVISOR_RUNTIME_VERSION_MATCH=True/);
  assert.match(source, /POST_JOB_RUNTIME_VERSION_MATCH=True/);
  assert.doesNotMatch(source, /2026-09-19\.51/);
  assert.match(source, /three-lane-cli\.mjs/);
  assert.match(source, /lane-status\.json/);
  assert.match(source, /lanes\.json/);
  assert.match(source, /THREE_LANE_COUNT=3/);
  assert.match(source, /BRAIN_AUTODISCOVERY_ACTIVE=False/);
  assert.match(source, /WORK_URL_OWNER_REQUIRED=False/);
  assert.match(source, /WORK_URL_OWNER_EDITABLE=True/);
  assert.match(source, /BRAIN_URL_OWNER_EDITABLE=True/);
  assert.match(source, /BRAIN_URL_PERSISTED=True/);
  assert.match(source, /BRAIN_URL_HOT_SWAP=True/);
});

test("post-job survival verifies lifecycle truth without mutating lane enable state", async () => {
  const source = await fs.readFile(
    new URL("../.github/workflows/supervisor-autostart-install.yml", import.meta.url),
    "utf8"
  );

  assert.match(source, /verify-survival:/);
  assert.match(source, /POST_JOB_SUPERVISOR_ALIVE=True/);
  assert.match(source, /POST_JOB_THREE_LANE_ALIVE=True/);
  assert.match(source, /POST_JOB_ROBOT_CHROME_ALIVE=True/);
  assert.match(source, /POST_JOB_ROBOT_CDP_HEALTHY=True/);
  assert.match(source, /POST_JOB_LANE_COUNT=3/);
  assert.match(source, /CONTROL_PANEL_OPENED=True/);
  assert.match(source, /LIFECYCLE_SURVIVAL=True/);
  assert.doesNotMatch(source, /LIVE_LANE1_RESUMED_BY_SHELL/);
  assert.doesNotMatch(source, /lane1Config\.enabled = \$true/);
});

test("Control Panel explicit AUTO Work request advances only Work target revision", async () => {
  const source = await fs.readFile(
    new URL("../windows/control-panel.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /function Save-WorkTarget/);
  assert.match(source, /\[bool\]\$ForceRevision = \$false/);
  assert.match(source, /Save-WorkTarget \$id '' \$true \$true/);
  assert.match(source, /work_url_revision = \[int\]\$lane\.work_url_revision \+ 1/);
  assert.doesNotMatch(source, /Save-Lane \$id[^\n]*''[^\n]*\$true/);
});

test("Control Panel keeps Brain target Owner-editable without autodiscovery", async () => {
  const source = await fs.readFile(
    new URL("../windows/control-panel.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /Save-BrainTarget/);
  assert.match(source, /brain_url_revision/);
  assert.doesNotMatch(source, /findBrainBy|listRecentConversationUrls/);
});

test("production state maintenance resets Work state by revision without changing target URLs", async () => {
  const source = await fs.readFile(
    new URL("../.github/workflows/supervisor-state-maintenance.yml", import.meta.url),
    "utf8"
  );

  assert.match(source, /reset-work-state/);
  assert.match(source, /work_state_reset_revision/);
  assert.match(source, /applied_work_state_reset_revision/);
  assert.match(source, /TARGET_URLS_UNCHANGED=True/);
  assert.match(source, /Brain URL changed during state reset/);
  assert.match(source, /Work URL changed during state reset/);
  assert.match(source, /WORK_STATE_RESET_REVISION_APPLIED=True/);
  assert.match(source, /Get-SupervisorRuntimeVersion -Path \$sourceRuntime/);
  assert.match(source, /Get-SupervisorRuntimeVersion -Path \$installedRuntimeSource/);
  assert.match(source, /Installed runtime version does not match checked-out production source/);
  assert.doesNotMatch(source, /2026-09-19\.51/);
  assert.doesNotMatch(source, /brain_url\s*=/);
  assert.doesNotMatch(source, /work_url\s*=/);
});
