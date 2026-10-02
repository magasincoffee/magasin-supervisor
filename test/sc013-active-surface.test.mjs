import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowDir = path.join(root, ".github", "workflows");

const allowedWorkflows = new Set([
  "sc013-runtime-watchdog.yml",
  "supervisor-autostart-install.yml",
  "supervisor-control-panel-desktop-4k7im13.yml",
  "supervisor-integrity.yml",
  "supervisor-lifecycle-acceptance.yml",
  "supervisor-sc013-live-production.yml",
  "supervisor-tests.yml"
]);

const selfHostedAllowed = new Set([
  "sc013-runtime-watchdog.yml",
  "supervisor-control-panel-desktop-4k7im13.yml",
  "supervisor-sc013-live-production.yml"
]);

test("SC-013 exposes one canonical production control surface", async () => {
  const files = (await fs.readdir(workflowDir))
    .filter((name) => name.endsWith(".yml"))
    .sort();

  assert.deepEqual(files, [...allowedWorkflows].sort());
});

test("only deploy, live observer/runtime, and watchdog may use self-hosted runner", async () => {
  for (const name of allowedWorkflows) {
    const source = await fs.readFile(path.join(workflowDir, name), "utf8");
    const usesSelfHosted = /runs-on:\s*(?:\[[^\]]*self-hosted[^\]]*\]|self-hosted)/i.test(source);

    if (selfHostedAllowed.has(name)) {
      assert.equal(usesSelfHosted, true, name + " must retain the explicit production target");
    } else {
      assert.equal(usesSelfHosted, false, name + " must remain hosted-only");
    }
  }
});

test("ordinary source changes cannot deploy or start production", async () => {
  const deploy = await fs.readFile(
    path.join(workflowDir, "supervisor-control-panel-desktop-4k7im13.yml"),
    "utf8"
  );
  const live = await fs.readFile(
    path.join(workflowDir, "supervisor-sc013-live-production.yml"),
    "utf8"
  );

  assert.match(deploy, /\.github\/production-deploy-request\.json/);
  assert.doesNotMatch(deploy, /- src\/\*\*/);
  assert.doesNotMatch(deploy, /- windows\/\*\*/);

  assert.match(live, /\.github\/sc013-live-observation-request\.json/);
  assert.doesNotMatch(live, /- src\/\*\*/);
  assert.doesNotMatch(live, /- windows\/\*\*/);
});


test("production wrapper, lifecycle, deploy and panel contain no legacy runtime selector", async () => {
  const paths = [
    "windows/run-supervisor.ps1",
    "windows/lifecycle-truth.ps1",
    "windows/control-panel.ps1",
    ".github/scripts/update-latest-clean-old.ps1"
  ];

  for (const rel of paths) {
    const source = await fs.readFile(path.join(root, rel), "utf8");
    assert.doesNotMatch(source, /THREE_LANE_V1/);
    assert.doesNotMatch(source, /PLANNER_EXECUTOR_V1/);
    assert.doesNotMatch(source, /BRAIN_WORKER_V1/);
    assert.doesNotMatch(source, /three-lane-cli\.mjs/);
    assert.doesNotMatch(source, /planner-executor(?:-bridge)?-cli\.mjs/);
    assert.doesNotMatch(source, /brain-worker-cli\.mjs/);
  }
});

test("active GitHub scripts are exactly deploy, live observer and watchdog", async () => {
  const scriptDir = path.join(root, ".github", "scripts");
  const files = (await fs.readdir(scriptDir)).sort();
  assert.deepEqual(files, [
    "sc013-runtime-watchdog.ps1",
    "supervisor-sc013-live-production.ps1",
    "update-latest-clean-old.ps1"
  ]);
});


test("canonical runtime and Windows source inventories stay minimal", async () => {
  const runtimeFiles = (await fs.readdir(path.join(root, "src", "runtime"))).sort();
  assert.deepEqual(runtimeFiles, [
    "atomic-json-write.mjs",
    "local-watchdog-probe-cli.mjs",
    "recovery.mjs",
    "single-conversation-bootstrap.mjs",
    "single-conversation-cli.mjs",
    "single-conversation-loop.mjs",
    "single-conversation-rollover.mjs",
    "single-conversation-state.mjs",
    "single-conversation-transaction.mjs"
  ]);

  const uiFiles = (await fs.readdir(path.join(root, "src", "ui"))).sort();
  assert.deepEqual(uiFiles, [
    "actions.mjs",
    "classifier.mjs",
    "latest-turn.mjs",
    "playwright-adapter.mjs",
    "snapshot.mjs",
    "submit-flight-recorder.mjs"
  ]);

  const windowsFiles = (await fs.readdir(path.join(root, "windows"))).sort();
  assert.deepEqual(windowsFiles, [
    "autostart-bootstrap.ps1",
    "control-panel.ps1",
    "install-autostart.ps1",
    "install-supervisor.ps1",
    "lifecycle-truth.ps1",
    "local-watchdog.ps1",
    "run-supervisor.ps1",
    "start-local-watchdog.ps1",
    "start-supervisor.ps1",
    "state-root.ps1",
    "stop-supervisor.ps1"
  ]);
});
