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
