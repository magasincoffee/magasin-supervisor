import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(rel) {
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

test("P4 process truth requires fresh lane-status in addition to wrapper/node/chrome/cdp", async () => {
  const life = await read("../windows/lifecycle-truth.ps1");

  assert.match(life, /function Get-LifecycleLaneStatusFreshness/);
  assert.match(life, /StaleAfterSeconds = 120/);
  assert.match(life, /STATUS_MISSING/);
  assert.match(life, /STATUS_UNREADABLE/);
  assert.match(life, /STATUS_TIMESTAMP_INVALID/);
  assert.match(life, /STATUS_STALE/);
  assert.match(life, /status_age_seconds/);
  assert.match(life, /Get-LifecycleThreeLaneProcess\(\[string\]\$Root/);
  assert.match(life, /\$runtimeRoot = Join-Path \$Root 'runtime'/);
  assert.match(life, /status_stale = \$statusStale/);
  assert.match(life, /node_down = \$nodeDown/);
  assert.match(
    life,
    /healthy = \[bool\]\([\s\S]*?\$wrapper[\s\S]*?\$threeLane[\s\S]*?\$chrome[\s\S]*?\$cdpHealthy[\s\S]*?-not \$freshness\.stale/
  );
});

test("P4 wrapper monitors Three-Lane status freshness and relaunches only Node", async () => {
  const wrapper = await read("../windows/run-supervisor.ps1");
  const start = wrapper.indexOf("function Invoke-MonitoredThreeLaneNode");
  const end = wrapper.indexOf("\nif ((Test-Path $stop)", start);
  assert.ok(start >= 0 && end > start);

  const monitor = wrapper.slice(start, end);
  assert.match(monitor, /Start-Process -FilePath 'node\.exe'/);
  assert.match(monitor, /Get-LifecycleLaneStatusFreshness/);
  assert.match(monitor, /SUPERVISOR_P4_STATUS_STALE_DETECTED=True/);
  assert.match(monitor, /THREE_LANE_STATUS_STALE_RESTART/);
  assert.match(monitor, /Stop-Process -Id \$nodeProcess\.Id/);
  assert.doesNotMatch(monitor, /Stop-DedicatedChrome/);
  assert.doesNotMatch(monitor, /lanes\.json|lane-registry\.json|brain_url|work_url/);

  assert.match(wrapper, /status_stale_restart/);
  assert.match(wrapper, /SUPERVISOR_MUTEX_NAME/);
  assert.match(wrapper, /THREE_LANE_STATUS_STALE_RELAUNCH/);
});

test("P4 recovery truth distinguishes NODE_DOWN and STATUS_STALE", async () => {
  const life = await read("../windows/lifecycle-truth.ps1");
  assert.match(
    life,
    /if \(\$processTruth\.node_down\)[\s\S]*?state = 'NODE_DOWN'[\s\S]*?start_requested = \$false/
  );
  assert.match(
    life,
    /if \(\$processTruth\.status_stale\)[\s\S]*?state = 'STATUS_STALE'[\s\S]*?start_requested = \$false/
  );
});

test("P4 Control Panel refuses stale scheduler and lane snapshots", async () => {
  const panel = await read("../windows/control-panel.ps1");
  const helper = await read("../windows/control-panel-observability.ps1");

  assert.match(panel, /'NODE_DOWN'/);
  assert.match(panel, /'STATUS_STALE'/);
  assert.match(panel, /STATUS AGE/);
  assert.match(panel, /\$statusSnapshotUsable = \[bool\]\(/);
  assert.match(panel, /-not \$processTruth\.status_stale/);
  assert.match(
    panel,
    /\$schedulerSnapshot = if \(\$statusSnapshotUsable\)[\s\S]*?else \{[\s\S]*?\$null/
  );
  assert.match(panel, /if \(\$statusSnapshotUsable -and \$status -and \$status\.lanes\)/);
  assert.match(panel, /NODE_DOWN — wrapper vẫn sống nhưng Three-Lane Node đã mất/);
  assert.match(panel, /STATUS_STALE — lane-status đã quá hạn/);

  assert.match(helper, /if \(\$ProcessState -eq 'NODE_DOWN'\) \{ return 'NODE_DOWN' \}/);
  assert.match(helper, /if \(\$ProcessState -eq 'STATUS_STALE'\) \{ return 'STATUS_STALE' \}/);
});

test("P4 observability probe exposes runtime freshness without target mutation", async () => {
  const panel = await read("../windows/control-panel.ps1");

  assert.match(panel, /node_down = \[bool\]\$processTruthProbe\.node_down/);
  assert.match(panel, /status_stale = \[bool\]\$processTruthProbe\.status_stale/);
  assert.match(panel, /status_age_seconds = \$processTruthProbe\.status_age_seconds/);
  assert.match(panel, /runtime_state = \[string\]\$processTruthProbe\.runtime_state/);
  assert.match(
    panel,
    /\$schedulerProbe = if \([\s\S]*?\$processTruthProbe\.three_lane_alive[\s\S]*?-not \$processTruthProbe\.status_stale[\s\S]*?\$null/
  );

  const probeStart = panel.indexOf("if ($ObservabilityProbe)");
  const probeEnd = panel.indexOf("function Write-JsonAtomic", probeStart);
  const probe = panel.slice(probeStart, probeEnd);
  assert.doesNotMatch(probe, /Write-JsonAtomic|Save-Lane|Save-WorkTarget|brain_url_revision|work_url_revision\s*=/);
});
