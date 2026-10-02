import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const allowed = new Set([
  "supervisor-control-panel-desktop-4k7im13.yml",
  "supervisor-integrity.yml",
  "supervisor-sc013-live-production.yml",
  "supervisor-tests.yml"
]);

test("SC-013 GitHub Actions contains only the four canonical workflows", async () => {
  const dir = new URL("../.github/workflows/", import.meta.url);
  const names = (await fs.readdir(dir)).sort();

  assert.deepEqual(names, [...allowed].sort());
});

test("SC-013 legacy orchestration scripts are physically absent", async () => {
  const retired = [
    "../src/runtime/three-lane-cli.mjs",
    "../src/runtime/planner-executor-cli.mjs",
    "../src/runtime/brain-worker-cli.mjs",
    "../src/runtime/supervisor-loop-cli.mjs",
    "../windows/chatgpt-bridge-runtime.ps1",
    "../windows/set-planner-executor-transport.ps1"
  ];

  for (const relative of retired) {
    await assert.rejects(
      fs.access(new URL(relative, import.meta.url)),
      (error) => error?.code === "ENOENT",
      relative
    );
  }
});
