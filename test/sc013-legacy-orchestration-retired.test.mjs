import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const retiredWorkflowPaths = [
  "../.github/workflows/live-brain-submit-diagnostic-20260926.yml",
  "../.github/workflows/repair-lane1-brain-target-20260926.yml",
  "../.github/workflows/supervisor-mbv1-001-live-baseline.yml",
  "../.github/workflows/supervisor-mbv1-008-live-qualification.yml",
  "../.github/workflows/supervisor-mbv1-008-production-cutover.yml",
  "../.github/workflows/supervisor-pe001-live-qualification.yml",
  "../.github/workflows/supervisor-pe007-live-qualification.yml",
  "../.github/workflows/supervisor-pe007-production-cutover.yml"
];

test("SC-013 retired legacy orchestration workflows stay out of active GitHub Actions", async () => {
  for (const relative of retiredWorkflowPaths) {
    const url = new URL(relative, import.meta.url);
    await assert.rejects(
      fs.access(url),
      (error) => error?.code === "ENOENT",
      relative
    );
  }
});
